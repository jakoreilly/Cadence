// Synthetic two-day fixture for the report pipeline.
//
// `data/` is empty in this checkout and there is no Jira/GitLab credential, so
// no acceptance step can run against real data. This builds the day that
// exercises the paths the plan's later phases add: three boards so the estate
// rollups have something to roll up, board columns on two of them and none on
// the third, an epic on two boards, a person on two boards, four-plus unassigned
// issues, resolved work for the cycle-time scatter, merge requests with and
// without human review for the latency histogram, and a day-two delta (one flag
// cleared, one raised, one extra unassigned) so the since-collection panel is
// non-empty once Phase 8 wires it.
//
//   node scripts/build-fixture.mjs
//
// Writes data/fixture/{2026-09-01,2026-09-02}/ and data/fixture-github/2026-09-02/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_VERSION = 4;

const D1 = '2026-09-01';
const D2 = '2026-09-02';
const CAP1 = `${D1}T09:00:00.000Z`;
const CAP2 = `${D2}T09:00:00.000Z`;

const P = (displayName, accountId) => ({ accountId, displayName });
const DEV1 = P('Dev One', 'u-1'); // on WEB and LOG - the cross-board person
const DEV2 = P('Dev Two', 'u-2');
const DEV3 = P('Dev Three', 'u-3');
const DEV4 = P('Dev Four', 'u-4');
const DEV5 = P('Dev Five', 'u-5');
const DEV6 = P('Dev Six', 'u-6');
const DEV7 = P('Dev Seven', 'u-7');
const BOT = P('Release Bot', 'u-bot');

const COLUMNS = [
  { name: 'To Do', statusIds: ['1'] },
  { name: 'In Progress', statusIds: ['3'] },
  { name: 'In Review', statusIds: ['4'] },
  { name: 'Done', statusIds: ['5'] },
];

const STATUS = {
  1: { status: 'To Do', statusCategory: 'To Do' },
  3: { status: 'In Development', statusCategory: 'In Progress' },
  4: { status: 'In Review', statusCategory: 'In Progress' },
  5: { status: 'Done', statusCategory: 'Done' },
};

function issue(key, over = {}) {
  const sid = String(over.statusId ?? 1);
  const s = STATUS[sid];
  return {
    key,
    id: key.replace(/\D/g, ''),
    issueType: 'Story',
    summary: `${key} — synthetic fixture issue`,
    status: s.status,
    statusId: sid,
    statusCategory: s.statusCategory,
    created: '2026-08-15T00:00:00.000Z',
    updated: `${D1}T08:00:00.000Z`,
    storyPoints: over.storyPoints ?? 3,
    storyPointsField: 'customfield_10006',
    flagged: false,
    labels: [],
    components: [],
    sprintIds: over.sprintIds ?? [],
    links: [],
    inBacklog: false,
    assignee: over.assignee,
    description: `Synthetic description for ${key}. Present so the schema check does not flag the fixture as collected without issue detail.`,
    descriptionTruncated: false,
    comments: [],
    commentCount: 0,
    ...stripKnown(over),
  };
}

// keys handled explicitly above, so they must not be spread twice
function stripKnown(o) {
  const { statusId, storyPoints, sprintIds, assignee, ...rest } = o;
  return rest;
}

const SPRINT = (id, name, state = 'active') => ({
  id,
  name,
  state,
  startDate: '2026-08-25T00:00:00.000Z',
  endDate: '2026-09-08T00:00:00.000Z',
  ...(state === 'closed'
    ? { startDate: '2026-08-11T00:00:00.000Z', endDate: '2026-08-24T00:00:00.000Z', completeDate: '2026-08-24T18:00:00.000Z' }
    : {}),
});

const EPIC_PLAT = { id: 9001, key: 'PLAT-1', name: 'Platform hardening', done: false };
const EPIC_ONB = { id: 9002, key: 'ONB-EP-1', name: 'Self-serve onboarding-hub', done: false };

// --- WEB board (701) - has columns -----------------------------------------

function webIssues(day2) {
  const a = [
    // four-plus unassigned open issues in the active sprint
    issue('WEB-1', { statusId: 1, sprintIds: [6001] }),
    issue('WEB-2', { statusId: 1, sprintIds: [6001] }),
    issue('WEB-3', { statusId: 1, sprintIds: [6001] }),
    issue('WEB-4', { statusId: 3, sprintIds: [6001] }),
    // Dev One - also carries work on LOG
    issue('WEB-5', {
      statusId: day2 ? 5 : 3,
      sprintIds: [6001],
      assignee: DEV1,
      epicKey: 'PLAT-1',
      epicName: 'Platform hardening',
      flagged: day2, // raised on day two
      ...(day2 ? { resolution: 'Done', resolutionDate: `${D2}T11:00:00.000Z` } : {}),
    }),
    // Stays open on both days: it is what keeps Dev One holding active-sprint
    // work on WEB as well as LOG, so the estate people panel has a genuine
    // cross-board person on the day-two (default) report, not only on day one.
    issue('WEB-6', { statusId: 4, sprintIds: [6001], assignee: DEV1 }),
    issue('WEB-7', { statusId: 3, sprintIds: [6001], assignee: DEV2, flagged: !day2 }), // cleared on day two
    issue('WEB-8', { statusId: 5, sprintIds: [6001], assignee: DEV2, resolution: 'Done', resolutionDate: '2026-08-31T15:00:00.000Z' }),
    issue('WEB-9', { statusId: 5, sprintIds: [6001], assignee: DEV3, resolution: 'Done', resolutionDate: '2026-08-30T12:00:00.000Z' }),
    issue('WEB-10', { statusId: day2 ? 4 : 3, sprintIds: [6001], assignee: DEV3, epicKey: 'PLAT-1', epicName: 'Platform hardening' }),
    issue('WEB-11', { statusId: 3, sprintIds: [6001], assignee: DEV2 }),
    // backlog work under the cross-board epic
    issue('WEB-12', { statusId: 1, epicKey: 'PLAT-1', epicName: 'Platform hardening', inBacklog: true }),
    issue('WEB-13', { statusId: 1, epicKey: 'PLAT-1', epicName: 'Platform hardening', inBacklog: true }),
    // closed-sprint delivery history
    issue('WEB-90', { statusId: 5, sprintIds: [5901], assignee: DEV2, resolution: 'Done', resolutionDate: '2026-08-22T12:00:00.000Z', storyPoints: 5 }),
    issue('WEB-91', { statusId: 5, sprintIds: [5901], assignee: DEV3, resolution: 'Done', resolutionDate: '2026-08-23T12:00:00.000Z', storyPoints: 8 }),
  ];
  if (day2) {
    // one extra unassigned item, and three resolved-this-interval items for the
    // cycle-time scatter (in progress and resolved on day two -> uncensored)
    a.push(issue('WEB-15', { statusId: 1, sprintIds: [6001] }));
    for (const [k, h] of [['WEB-20', 10], ['WEB-21', 13], ['WEB-22', 16]]) {
      a.push(issue(k, { statusId: 3, sprintIds: [6001], assignee: DEV3, resolution: 'Done', resolutionDate: `${D2}T${h}:00:00.000Z` }));
    }
  }
  return a;
}

// --- LOG board (702) - has columns ---------------------------------------

function logIssues(day2) {
  return [
    issue('LOG-1', { statusId: day2 ? 4 : 3, sprintIds: [6002], assignee: DEV1, epicKey: 'PLAT-1', epicName: 'Platform hardening' }), // Dev One again; epic on two boards
    issue('LOG-2', { statusId: 3, sprintIds: [6002], assignee: DEV4, flagged: true }),
    issue('LOG-3', { statusId: 1, sprintIds: [6002], assignee: DEV4 }),
    issue('LOG-4', { statusId: 5, sprintIds: [6002], assignee: DEV5, resolution: 'Done', resolutionDate: '2026-08-31T09:00:00.000Z' }),
    issue('LOG-5', { statusId: 3, sprintIds: [6002], assignee: DEV5 }),
    issue('LOG-6', { statusId: 4, sprintIds: [6002], assignee: DEV1 }),
    issue('LOG-7', { statusId: 1, epicKey: 'PLAT-1', epicName: 'Platform hardening', inBacklog: true }),
    issue('LOG-8', { statusId: 1, sprintIds: [6002] }), // unassigned in active sprint
    issue('LOG-90', { statusId: 5, sprintIds: [5902], assignee: DEV4, resolution: 'Done', resolutionDate: '2026-08-21T12:00:00.000Z', storyPoints: 5 }),
  ];
}

// --- ONB board (704) - NO columns --------------------------------------

function onbIssues() {
  return [
    issue('ONB-1', { statusId: 3, sprintIds: [6003], assignee: DEV6, epicKey: 'ONB-EP-1', epicName: 'Self-serve onboarding-hub' }),
    issue('ONB-2', { statusId: 1, sprintIds: [6003], assignee: DEV6 }),
    issue('ONB-3', { statusId: 5, sprintIds: [6003], assignee: DEV7, resolution: 'Done', resolutionDate: '2026-08-30T16:00:00.000Z' }),
    issue('ONB-4', { statusId: 3, sprintIds: [6003], assignee: DEV7, flagged: true }),
    issue('ONB-5', { statusId: 1, epicKey: 'ONB-EP-1', epicName: 'Self-serve onboarding-hub', inBacklog: true }),
    issue('ONB-6', { statusId: 1, inBacklog: true }),
  ];
}

function jiraSnapshot(date, capturedAt, day2, source = 'jira', site = 'fixture.atlassian.net') {
  const team = (key, boardId, boardName, columns, sprints, issues, epics) => ({
    key,
    boardId,
    boardName,
    boardType: 'scrum',
    columns,
    sprints,
    issues,
    epics,
    errors: [],
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'jira',
    site,
    capturedAt,
    individualAttribution: true,
    fieldMap: { discoveredAt: `${D1}T00:00:00.000Z`, sprint: 'customfield_10001', storyPoints: ['customfield_10006'], epicLink: 'customfield_10008', flagged: 'customfield_10009' },
    teams: [
      team('web', 701, 'Web Platform Scrum', COLUMNS, [SPRINT(6001, 'WEB Sprint 42'), SPRINT(5901, 'WEB Sprint 41', 'closed')], webIssues(day2), [EPIC_PLAT]),
      team('log', 702, 'Logistics Scrum Board', COLUMNS, [SPRINT(6002, 'LOG Sprint 18'), SPRINT(5902, 'LOG Sprint 17', 'closed')], logIssues(day2), [EPIC_PLAT]),
      team('onb', 704, 'Onboarding Scrum', [], [SPRINT(6003, 'ONB Sprint 7')], onbIssues(), [EPIC_ONB]),
    ],
  };
}

// --- GitLab / GitHub side --------------------------------------------------

function review(over = {}) {
  return {
    authorIsAutomation: false,
    humanCommentCount: 0,
    automatedCommentCount: 1,
    humanCommenters: [],
    authorCommentCount: 0,
    humanApprovalCount: 0,
    automatedApprovalCount: 1,
    humanApprovals: [],
    automatedApprovals: [BOT],
    reviewerCount: 0,
    ...over,
  };
}

let MR_ID = 100;
function mr(over = {}) {
  const id = ++MR_ID;
  const createdAt = over.createdAt ?? `${D1}T08:00:00.000Z`;
  return {
    id,
    iid: id,
    projectId: 10,
    projectPath: over.projectPath ?? 'web-storefront/app',
    title: over.title ?? `Fixture change ${id}`,
    state: over.state ?? 'merged',
    draft: false,
    createdAt,
    updatedAt: over.updatedAt ?? `${D2}T08:00:00.000Z`,
    mergedAt: over.state === 'opened' ? undefined : (over.mergedAt ?? `${D1}T18:00:00.000Z`),
    sourceBranch: over.sourceBranch ?? `feature/${id}`,
    targetBranch: 'main',
    author: over.author ?? DEV1,
    assignees: [],
    reviewers: over.reviewers ?? [],
    issueKeys: over.issueKeys ?? [],
    webUrl: `https://gitlab.example.com/${over.projectPath ?? 'web-storefront/app'}/-/merge_requests/${id}`,
    review: over.review,
  };
}

function gitlabSnapshot(date, capturedAt, day2, source = 'gitlab') {
  const webMrs = [
    // reviewed by a second person, comment ~3h after open
    mr({ author: DEV1, issueKeys: ['WEB-5'], review: review({ firstHumanCommentAt: `${D1}T11:00:00.000Z`, humanCommentCount: 2, humanCommenters: [DEV2], humanApprovalCount: 1, humanApprovals: [DEV2], firstHumanApprovalAt: `${D1}T12:30:00.000Z` }) }),
    // merged with no human review at all
    mr({ author: DEV2, issueKeys: ['WEB-11'], review: review({ firstAutomatedApprovalAt: `${D1}T08:12:00.000Z` }) }),
    // human approval ~30h after open (1-2d bucket)
    mr({ author: DEV3, createdAt: '2026-08-31T06:00:00.000Z', issueKeys: ['WEB-10'], review: review({ firstHumanApprovalAt: `${D1}T12:00:00.000Z`, humanApprovalCount: 1, humanApprovals: [DEV1] }) }),
    // opened by automation - excluded from every rate
    mr({ author: BOT, title: 'Bump deps', review: review({ authorIsAutomation: true }) }),
  ];
  const logMrs = [
    mr({ projectPath: 'logistics-hub/svc', author: DEV4, issueKeys: ['LOG-2'], review: review({ firstHumanCommentAt: `${D1}T09:05:00.000Z`, humanCommentCount: 1, humanCommenters: [DEV5], humanApprovalCount: 1, humanApprovals: [DEV5], firstHumanApprovalAt: `${D1}T10:00:00.000Z` }) }),
    mr({ projectPath: 'logistics-hub/svc', author: DEV5, issueKeys: ['LOG-5'], review: review() }), // no human review
    mr({ projectPath: 'logistics-hub/svc', author: DEV1, state: 'opened', mergedAt: undefined, issueKeys: ['LOG-6'], review: review({ automatedApprovalCount: 0, automatedApprovals: [] }) }),
  ];
  const onbMrs = [
    mr({ projectPath: 'onboarding-hub/web', author: DEV6, issueKeys: ['ONB-1'], review: review({ firstHumanCommentAt: `${D1}T13:00:00.000Z`, humanCommentCount: 3, humanCommenters: [DEV7], humanApprovalCount: 1, humanApprovals: [DEV7], firstHumanApprovalAt: `${D1}T15:00:00.000Z` }) }),
  ];
  if (day2) {
    webMrs.push(mr({ author: DEV3, createdAt: `${D2}T07:00:00.000Z`, issueKeys: ['WEB-20'], review: review({ firstHumanCommentAt: `${D2}T08:00:00.000Z`, humanCommentCount: 1, humanCommenters: [DEV1] }) }));
  }
  const teamBlock = (key, groups, mergeRequests) => ({ key, groups, mergeRequests, errors: [] });
  return {
    schemaVersion: SCHEMA_VERSION,
    source,
    capturedAt,
    windowDays: 30,
    individualAttribution: true,
    teams: [
      teamBlock('web', source === 'github' ? ['acme/web-storefront'] : ['web-storefront'], webMrs),
      teamBlock('log', source === 'github' ? ['acme/logistics-hub'] : ['logistics-hub'], logMrs),
      teamBlock('onb', source === 'github' ? ['acme/onboarding-hub'] : ['onboarding-hub'], onbMrs),
    ],
  };
}

// --- write ---------------------------------------------------------------

function writeDay(profile, date, capturedAt, day2, source = 'gitlab') {
  const dir = join(ROOT, 'data', profile, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jira.json'), JSON.stringify(jiraSnapshot(date, capturedAt, day2), null, 1), 'utf8');
  MR_ID = 100;
  writeFileSync(join(dir, 'gitlab.json'), JSON.stringify(gitlabSnapshot(date, capturedAt, day2, source), null, 1), 'utf8');
  console.log('wrote', join('data', profile, date));
}

writeDay('fixture', D1, CAP1, false);
writeDay('fixture', D2, CAP2, true);
// GitHub variant: day two only, source github, for the noun sweep check
writeDay('fixture-github', D2, CAP2, true, 'github');
console.log('done');
