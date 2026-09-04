import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockerGraph,
  flaggedRegister,
  isBugType,
  mixBy,
  mixByMulti,
  mostDiscussed,
  roster,
  subtaskStructure,
  taxonomy,
} from '../src/taxonomy.js';
import type {
  EpicSnapshot,
  IssueSnapshot,
  MergeRequestSnapshot,
  ReviewSignals,
  SprintSnapshot,
  TeamSnapshot,
} from '../src/types.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1', id: '1', issueType: 'Story', status: 'In Development',
    statusCategory: 'In Progress', created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-31T00:00:00.000Z', storyPoints: 3, storyPointsField: 'customfield_10006',
    flagged: false, labels: [], components: [], sprintIds: [10], links: [], inBacklog: false,
    assignee: { accountId: 'a', displayName: 'Dev One' }, ...over,
  };
}

const ACTIVE: SprintSnapshot = {
  id: 10, name: 'Sprint 10', state: 'active',
  startDate: '2026-08-25T00:00:00.000Z', endDate: '2026-09-08T00:00:00.000Z',
};

function team(issues: IssueSnapshot[], over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return { key: 't', boardId: 1, columns: [], sprints: [ACTIVE], issues, errors: [], ...over };
}

// --- the mixes ----------------------------------------------------------------

test('mixBy counts a categorical field and orders it most common first', () => {
  const rows = mixBy(
    [issue({ issueType: 'Story' }), issue({ issueType: 'Bug' }), issue({ issueType: 'Story' })],
    (i) => i.issueType,
  );
  assert.deepEqual(rows.map((r) => [r.name, r.issues]), [['Story', 2], ['Bug', 1]]);
  assert.equal(rows[0]!.share, 2 / 3);
});

test('mixBy buckets a missing value as (none) rather than dropping the issue', () => {
  // Dropping it would make the shares sum to less than 100% with no explanation
  // on the page, which reads as a rendering bug rather than as missing data.
  const rows = mixBy([issue({ priority: 'Medium' }), issue({ priority: undefined })], (i) => i.priority);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['(none)', 'Medium']);
  assert.equal(rows.reduce((a, r) => a + r.issues, 0), 2);
});

test('mixByMulti counts an issue once per distinct label, not once per occurrence', () => {
  const rows = mixByMulti([issue({ labels: ['Tolling', 'Tolling', 'technical'] })], (i) => i.labels);
  assert.deepEqual(rows.map((r) => [r.name, r.issues]).sort(), [['Tolling', 1], ['technical', 1]]);
});

test('isBugType recognises this site\'s renamed bug types, not just "Bug"', () => {
  // Confirmed live: board 701 carries BOTH "Bug" (5 issues) and
  // "Defect (Standalone)" (7). Matching only "Bug" halves the real count.
  assert.equal(isBugType('Bug'), true);
  assert.equal(isBugType('Defect (Standalone)'), true);
  assert.equal(isBugType('Incident'), true);
  assert.equal(isBugType('Story'), false);
  assert.equal(isBugType('Task'), false);
});

test('taxonomy scopes to the active sprint and reports estimate coverage with it', () => {
  const t = team([
    issue({ key: 'A', issueType: 'Bug' }),
    issue({ key: 'B', issueType: 'Story', storyPoints: null }),
    issue({ key: 'C', issueType: 'Story', sprintIds: [9] }), // a closed sprint - out of scope
    issue({ key: 'D', issueType: 'Story', inBacklog: true, sprintIds: [] }),
  ]);
  const tx = taxonomy(t, 'active', NOW);
  assert.equal(tx.issues, 2);
  assert.equal(tx.unestimated, 1);
  assert.equal(tx.bugShare, 1 / 2);
  assert.deepEqual(taxonomy(t, 'backlog', NOW).issues, 1);
});

test('taxonomy the "recent" scope is anchored to resolutionDate, not updated', () => {
  // `updated` moves on a bulk edit; resolutionDate does not. The trend layer
  // uses the same anchor, so the two halves of the report cannot disagree.
  const t = team([
    issue({ key: 'OLD', statusCategory: 'Done', resolutionDate: '2026-01-01T00:00:00.000Z', updated: NOW.toISOString() }),
    issue({ key: 'NEW', statusCategory: 'Done', resolutionDate: '2026-08-28T00:00:00.000Z' }),
  ]);
  assert.deepEqual(taxonomy(t, 'recent', NOW, 30).types.length, 1);
  assert.equal(taxonomy(t, 'recent', NOW, 30).issues, 1);
});

// --- subtasks -----------------------------------------------------------------

const EPIC: EpicSnapshot = { id: 1, key: 'WEB-100', name: 'Storefront rollout', done: false };

test('subtaskStructure excludes epic parents so real subtask structure is visible', () => {
  // GOTCHA: parentKey is set for epic children too on this site. Counting them
  // makes an epic look like "a parent with 40 subtasks" and buries everything.
  const t = team(
    [
      issue({ key: 'A', parentKey: 'WEB-100' }), // child of an EPIC - not a subtask
      issue({ key: 'B', parentKey: 'WEB-5' }),
      issue({ key: 'WEB-5', issueType: 'Task' }),
      issue({ key: 'WEB-100', issueType: 'Epic' }),
    ],
    { epics: [EPIC] },
  );
  const s = subtaskStructure(t);
  assert.equal(s.parentsWithChildren, 1);
  assert.equal(s.parents[0]!.key, 'WEB-5');
  assert.equal(s.children, 1);
});

test('subtaskStructure flags a parent whose children are all done but is still open', () => {
  const t = team([
    issue({ key: 'P', issueType: 'Task', statusCategory: 'In Progress' }),
    issue({ key: 'C1', parentKey: 'P', statusCategory: 'Done' }),
    issue({ key: 'C2', parentKey: 'P', statusCategory: 'Done' }),
  ]);
  const s = subtaskStructure(t);
  assert.equal(s.stalledParents, 1);
  assert.equal(s.parents[0]!.stalledParent, true);
  assert.equal(s.parents[0]!.childrenDone, 2);
});

test('subtaskStructure records a child whose parent is on another board as an orphan', () => {
  const t = team([issue({ key: 'C', parentKey: 'OTHER-9' })]);
  const s = subtaskStructure(t);
  assert.deepEqual(s.orphanChildren.map((o) => o.parentKey), ['OTHER-9']);
  assert.equal(s.parentsWithChildren, 0);
});

// --- discussion ---------------------------------------------------------------

test('mostDiscussed excludes issues whose comment count was never collected', () => {
  // Undefined means NOT COLLECTED. Sorting it as zero would rank un-collected
  // work as "nobody is talking about this", which is a different claim.
  const t = team([
    issue({ key: 'KNOWN', commentCount: 4 }),
    issue({ key: 'UNCOLLECTED' }),
    issue({ key: 'ZERO', commentCount: 0 }),
  ]);
  assert.deepEqual(mostDiscussed(t, NOW).map((d) => d.key), ['KNOWN']);
});

test('mostDiscussed carries the latest comment verbatim, with its truncation flag', () => {
  // GOTCHA: the fixture is NEWEST FIRST because that is what the collector
  // actually writes - recentComments takes the last N and reverses them, and
  // every multi-comment issue in the collected snapshots is in that order. This
  // fixture was previously oldest-first, which no snapshot ever looks like, and
  // it pinned mostDiscussed reading the OLDEST of the three kept comments and
  // labelling it `latestComment`. See the ordering test in collect.test.ts.
  const t = team([
    issue({
      key: 'A', commentCount: 2,
      comments: [
        { id: '2', created: '2026-08-29T00:00:00.000Z', body: 'blocked on the platform team', truncated: true,
          author: { accountId: 'z', displayName: 'Ana' } },
        { id: '1', created: '2026-08-20T00:00:00.000Z', body: 'first', truncated: false },
      ],
    }),
  ]);
  const top = mostDiscussed(t, NOW)[0]!;
  assert.equal(top.latestComment?.body, 'blocked on the platform team');
  assert.equal(top.latestComment?.author, 'Ana');
  assert.equal(top.latestComment?.truncated, true);
});

// --- flags --------------------------------------------------------------------

test('flaggedRegister counts flagged work that sits outside the plan separately', () => {
  const t = team([
    issue({ key: 'INSPRINT', flagged: true }),
    issue({ key: 'BACKLOG', flagged: true, inBacklog: true, sprintIds: [] }),
    issue({ key: 'STRANDED', flagged: true, inBacklog: false, sprintIds: [] }),
    issue({ key: 'DONE', flagged: true, statusCategory: 'Done' }),
  ]);
  const f = flaggedRegister(t, NOW);
  assert.equal(f.total, 3); // the done one is not open trouble
  assert.equal(f.inActiveSprint, 1);
  assert.equal(f.strandedFlags, 1);
});

test('flaggedRegister orders by how many sprints the flag has survived', () => {
  const t = team([
    issue({ key: 'NEW', flagged: true, sprintIds: [10] }),
    issue({ key: 'OLD', flagged: true, sprintIds: [1, 2, 3, 10] }),
  ]);
  assert.deepEqual(flaggedRegister(t, NOW).items.map((i) => i.key), ['OLD', 'NEW']);
});

// --- blockers -----------------------------------------------------------------

test('blockerGraph ranks the ticket that gates the most other work first', () => {
  const t = team([
    issue({ key: 'A', blockedBy: ['GATE'] }),
    issue({ key: 'B', blockedBy: ['GATE'] }),
    issue({ key: 'C', blockedBy: ['MINOR'] }),
    issue({ key: 'GATE', statusCategory: 'In Progress' }),
    issue({ key: 'MINOR', statusCategory: 'In Progress' }),
  ]);
  const g = blockerGraph(t);
  assert.equal(g[0]!.blocker, 'GATE');
  assert.equal(g[0]!.blocked.length, 2);
});

test('blockerGraph sorts a finished blocker last but still reports it', () => {
  // A closed blocker with open dependants usually means nobody told them.
  const t = team([
    issue({ key: 'A', blockedBy: ['DONE'] }),
    issue({ key: 'B', blockedBy: ['OPEN'] }),
    issue({ key: 'DONE', statusCategory: 'Done' }),
    issue({ key: 'OPEN', statusCategory: 'In Progress' }),
  ]);
  const g = blockerGraph(t);
  assert.deepEqual(g.map((e) => e.blocker), ['OPEN', 'DONE']);
  assert.equal(g[1]!.blockerDone, true);
});

test('blockerGraph ignores dependencies recorded on work that is already done', () => {
  const t = team([
    issue({ key: 'A', statusCategory: 'Done', blockedBy: ['GATE'] }),
    issue({ key: 'GATE', statusCategory: 'In Progress' }),
  ]);
  assert.deepEqual(blockerGraph(t), []);
});

// --- roster -------------------------------------------------------------------

function mr(over: Partial<MergeRequestSnapshot> = {}): MergeRequestSnapshot {
  return {
    id: 1, iid: 1, projectId: 1, projectPath: 'grp/app', title: 'x', state: 'merged', draft: false,
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
    mergedAt: '2026-08-21T00:00:00.000Z', sourceBranch: 'f', targetBranch: 'main',
    author: { accountId: '1', displayName: 'Dev One' }, assignees: [], reviewers: [],
    issueKeys: [], webUrl: 'https://git/x/-/merge_requests/1', ...over,
  };
}

const signals = (over: Partial<ReviewSignals> = {}): ReviewSignals => ({
  authorIsAutomation: false, humanCommentCount: 0, automatedCommentCount: 0,
  humanCommenters: [], authorCommentCount: 0, humanApprovalCount: 0,
  automatedApprovalCount: 0, humanApprovals: [], automatedApprovals: [], reviewerCount: 0, ...over,
});

test('roster joins a person\'s Jira load to their GitLab activity by display name', () => {
  const t = team([issue({ key: 'A', assignee: { accountId: 'a', displayName: 'Dev One' } })]);
  const r = roster(t, [mr()], { now: NOW });
  const one = r.members.find((m) => m.name === 'Dev One')!;
  assert.equal(one.openInActiveSprint, 1);
  assert.equal(one.mergeRequestsAuthored, 1);
  assert.equal(one.jiraOnly, false);
  assert.deepEqual(one.projects, ['grp/app']);
});

test('roster keeps a Jira-only and a GitLab-only person as separate, labelled rows', () => {
  // The two systems share no id on this instance, so a differently-spelled name
  // is reported honestly as two rows rather than fuzzily merged - which would
  // silently combine two real people who share a surname.
  const t = team([issue({ assignee: { accountId: 'a', displayName: 'Declan Moore' } })]);
  const r = roster(t, [mr({ author: { accountId: '9', displayName: 'd.moore' } })], { now: NOW });
  assert.equal(r.members.find((m) => m.name === 'Declan Moore')!.jiraOnly, true);
  assert.equal(r.members.find((m) => m.name === 'd.moore')!.gitlabOnly, true);
});

test('roster excludes configured automation accounts from authorship and review', () => {
  // GOTCHA 20: matched on the DISPLAY name, which is all the snapshot keeps for
  // a commenter. Letting the bot through puts a robot in the table as somebody
  // to have a training conversation with.
  const isAutomation = (p: { displayName: string }) => p.displayName.toLowerCase() === "i'm a bot";
  const t = team([issue()]);
  const r = roster(
    t,
    [
      mr({ author: { accountId: '2', displayName: "I'm a Bot" } }),
      mr({ author: { accountId: '1', displayName: 'Dev One' }, review: signals({ humanCommenters: [{ accountId: '2', displayName: "I'm a Bot" }] }) }),
    ],
    { now: NOW, isAutomation },
  );
  assert.equal(r.members.some((m) => m.name === "I'm a Bot"), false);
  assert.equal(r.members.find((m) => m.name === 'Dev One')!.mergeRequestsAuthored, 1);
});

test('roster credits a review to the commenter, counted once per merge request', () => {
  const t = team([issue()]);
  const reviewer = { accountId: '7', displayName: 'Nora Vance' };
  const r = roster(t, [mr({ review: signals({ humanCommenters: [reviewer] }) })], { now: NOW });
  assert.equal(r.members.find((m) => m.name === 'Nora Vance')!.reviewsGiven, 1);
});

test('roster counts open sprint work that nobody is assigned', () => {
  const t = team([
    issue({ key: 'A', assignee: undefined }),
    issue({ key: 'B', assignee: undefined, statusCategory: 'Done' }),
    issue({ key: 'C' }),
  ]);
  assert.equal(roster(t, [], { now: NOW }).unassignedOpenInActiveSprint, 1);
});
