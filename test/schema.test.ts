import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_HISTORY, assessSchema, formatSchemaWarning } from '../src/schema.js';
import { freshnessBanner } from '../src/report/freshness.js';
import { SCHEMA_VERSION, type ConfluenceSnapshot, type GitLabSnapshot, type JiraSnapshot, type IssueSnapshot } from '../src/types.js';

// Value shapes copied from the real 2026-08-26 snapshot rather than invented:
// board 701, WEB keys, the sprint states and the status vocabulary this site
// actually uses.

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1180',
    id: '48211',
    issueType: 'Story',
    summary: 'Panther services - retail onboarding-hub',
    status: 'In Development',
    statusCategory: 'In Progress',
    created: '2026-05-01T09:00:00.000Z',
    updated: '2026-08-25T11:12:00.000Z',
    storyPoints: 3,
    storyPointsField: 'customfield_10006',
    flagged: false,
    labels: [],
    components: [],
    sprintIds: [5462],
    links: [],
    inBacklog: false,
    ...over,
  };
}

function jiraSnapshot(over: Partial<JiraSnapshot> = {}, issues: IssueSnapshot[] = [issue()]): JiraSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'jira',
    site: 'acme.atlassian.net',
    capturedAt: '2026-08-26T21:20:39.978Z',
    individualAttribution: true,
    fieldMap: { discoveredAt: '2026-08-26T14:19:19.642Z', sprint: 'customfield_10001', storyPoints: ['customfield_10006'] },
    teams: [
      {
        key: 'panther',
        boardId: 701,
        boardName: 'WEB Scrum',
        boardType: 'scrum',
        columns: [],
        sprints: [{ id: 5462, name: 'Panther services 55', state: 'active' }],
        issues,
        epics: [],
        errors: [],
      },
    ],
    ...over,
  };
}

function gitlabSnapshot(over: Partial<GitLabSnapshot> = {}): GitLabSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'gitlab',
    capturedAt: '2026-08-26T21:20:39.978Z',
    windowDays: 30,
    individualAttribution: true,
    teams: [
      {
        key: 'panther',
        groups: ['web-storefront'],
        mergeRequests: [
          {
            id: 88123,
            iid: 41,
            projectId: 621,
            title: 'WEB-1180 onboarding-hub',
            state: 'merged',
            draft: false,
            createdAt: '2026-08-20T08:00:00.000Z',
            updatedAt: '2026-08-21T08:00:00.000Z',
            sourceBranch: 'feature/WEB-1180',
            targetBranch: 'main',
            assignees: [],
            reviewers: [],
            issueKeys: ['WEB-1180'],
            webUrl: 'https://gitlab.example.com/web-storefront/app/-/merge_requests/41',
            review: {
              authorIsAutomation: false,
              firstHumanCommentAt: '2026-08-20T14:00:00.000Z',
              humanCommentCount: 2,
              automatedCommentCount: 1,
              humanCommenters: [{ accountId: 'gl-311', displayName: 'Andre Lima' }],
              authorCommentCount: 0,
              humanApprovalCount: 0,
              automatedApprovalCount: 1,
              humanApprovals: [],
              automatedApprovals: [{ accountId: 'gl-9', displayName: "I'm a Bot" }],
              reviewerCount: 0,
            },
          },
        ],
        errors: [],
      },
    ],
    ...over,
  };
}

// --- the history table has to keep up with the constant -----------------------

// GOTCHA, and this test is the whole reason the table is trustworthy: nothing
// makes somebody bumping SCHEMA_VERSION in types.ts look in schema.ts. Without
// this, the first bump after today ships a banner that says "missing:" and then
// lists nothing, which is worse than no banner - it tells the reader the data is
// stale and refuses to say in what way. Do not delete this to make a bump pass.
test('SCHEMA_HISTORY describes every version up to SCHEMA_VERSION', () => {
  const versions = SCHEMA_HISTORY.map((h) => h.version);
  assert.equal(Math.max(...versions), SCHEMA_VERSION, 'the newest described version must be SCHEMA_VERSION');
  for (let v = 2; v <= SCHEMA_VERSION; v++) {
    assert.ok(versions.includes(v), `schema ${v} is not described in SCHEMA_HISTORY`);
  }
  for (const h of SCHEMA_HISTORY) {
    assert.ok(h.adds.length > 0, `schema ${h.version} is described with no fields`);
  }
});

// --- the version check --------------------------------------------------------

test('a current snapshot is not reported as stale', () => {
  const a = assessSchema({
    jira: jiraSnapshot({}, [issue({ comments: [], commentCount: 0 })]),
    gitlab: gitlabSnapshot(),
    context: null,
  });
  assert.equal(a.stale, false);
  assert.equal(a.headline, null);
  assert.deepEqual(formatSchemaWarning(a), []);
  assert.equal(freshnessBanner(a), '');
});

test('an older snapshot names the fields it cannot carry, and what to run', () => {
  // Schema 2 is the real shape in data/acme/.archive: the seventh session
  // found the report rendering against exactly this and printing "not
  // collected" 109 times while looking complete.
  const a = assessSchema({
    jira: jiraSnapshot({ schemaVersion: 2 }, [issue({ summary: undefined })]),
    gitlab: gitlabSnapshot({ schemaVersion: 2 }),
    context: null,
  });
  assert.equal(a.stale, true);
  assert.match(a.headline!, /BEHIND/);
  assert.equal(a.remedy, 'collect --force');

  const jira = a.files.find((f) => f.file === 'jira')!;
  assert.equal(jira.behind, true);
  assert.equal(jira.found, 2);
  // The fields, not the number. "schema 2 < 4" is not actionable.
  assert.ok(jira.missing.some((m) => /comment threads/.test(m)));
  assert.ok(jira.missing.some((m) => /epic names/.test(m)));
  assert.ok(jira.missing.some((m) => /titles/.test(m)));

  const gitlab = a.files.find((f) => f.file === 'gitlab')!;
  assert.ok(gitlab.missing.some((m) => /reviewed other people/.test(m)));

  const lines = formatSchemaWarning(a, 'profiles/acme').join('\n');
  assert.match(lines, /WARNING/);
  assert.match(lines, /collect --force --profile profiles\/acme/);

  const html = freshnessBanner(a);
  assert.match(html, /stale-data/);
  assert.match(html, /comment threads/);
  assert.match(html, /collect --force/);
  // Loud, and not hidden behind a summary the reader has to open.
  assert.ok(!/^<details/.test(html.trim()));
});

// --- the coverage check -------------------------------------------------------

// GOTCHA: this is the half a version-only check cannot see, and the half that
// actually cost the two sessions. A snapshot collected with --no-issue-detail
// is stamped at the CURRENT version and carries none of that version's content,
// so the stamp says healthy while 109 panels say "not collected".
test('a current-version snapshot collected without detail is still reported', () => {
  const a = assessSchema({
    jira: jiraSnapshot({}, [issue({ comments: undefined, commentCount: undefined })]),
    gitlab: gitlabSnapshot(),
    context: null,
  });
  assert.equal(a.stale, true);
  assert.ok(a.files.every((f) => !f.behind), 'nothing is behind - the stamp is current');
  const gap = a.gaps.find((g) => /descriptions and comment threads/.test(g.what))!;
  assert.ok(gap, 'the missing detail pass must be reported as a coverage gap');
  assert.equal(gap.present, 0);
  assert.equal(gap.total, 1);
  assert.match(gap.cause, /--no-issue-detail/);
  assert.match(a.headline!, /WITHOUT some of its content/);
});

// GOTCHA 24, as a freshness check rather than as a ranking: comments are
// collected for ACTIVE-SPRINT work only. Scoping this check to every issue on
// the board would fire on every snapshot ever collected - 20,701 issues against
// 725 with detail - and a warning that always fires is a warning nobody reads.
test('the detail check is scoped to active-sprint work, not the whole board', () => {
  const a = assessSchema({
    jira: jiraSnapshot({}, [
      issue({ key: 'WEB-1180', comments: [], commentCount: 0 }),
      // Closed work, in no active sprint. Never gets a detail pass, and must
      // not make the snapshot look under-collected.
      issue({
        key: 'WEB-204',
        sprintIds: [4001],
        status: 'Resolved',
        statusCategory: 'Done',
        resolutionDate: '2025-02-02T10:00:00.000Z',
        comments: undefined,
        commentCount: undefined,
      }),
    ]),
    gitlab: gitlabSnapshot(),
    context: null,
  });
  assert.equal(a.gaps.filter((g) => /comment threads/.test(g.what)).length, 0);
  assert.equal(a.stale, false);
});

test('a missing review-detail pass is named with the flag that skips it', () => {
  const gl = gitlabSnapshot();
  gl.teams[0]!.mergeRequests[0]!.review = undefined;
  const a = assessSchema({ jira: jiraSnapshot({}, [issue({ comments: [] })]), gitlab: gl, context: null });
  const gap = a.gaps.find((g) => /review signals/.test(g.what))!;
  assert.ok(gap);
  assert.match(gap.cause, /--no-review-detail/);
});

test('an absent snapshot file is not reported as behind', () => {
  // No gitlab.json is a legitimate state - `collect --no-gitlab`, or a run that
  // has written its Jira half and is still crawling GitLab, which is what the
  // 07:00 scheduled job looks like for its first several minutes. Reporting it
  // as "behind" would cry wolf every morning.
  const a = assessSchema({ jira: jiraSnapshot({}, [issue({ comments: [] })]), gitlab: null, context: null });
  const gitlab = a.files.find((f) => f.file === 'gitlab')!;
  assert.equal(gitlab.present, false);
  assert.equal(gitlab.behind, false);
  assert.equal(a.stale, false);
});

test('an empty context snapshot says to run discover-spaces', () => {
  const context: ConfluenceSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    source: 'confluence',
    capturedAt: '2026-08-26T21:20:39.978Z',
    site: 'acme.atlassian.net',
    teams: [{ key: 'panther', spaces: [], pages: [], errors: [] }],
  };
  const a = assessSchema({ jira: jiraSnapshot({}, [issue({ comments: [] })]), gitlab: gitlabSnapshot(), context });
  assert.ok(a.gaps.some((g) => /discover-spaces/.test(g.cause)));
});
