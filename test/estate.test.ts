import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estateEpics, NO_EPIC, type EpicRollup, type EpicRollupResult } from '../src/epics.js';
import { estatePeople } from '../src/people.js';
import { latencyHistogram } from '../src/review.js';
import { sparkline } from '../src/report/format.js';
import type { RosterMember, RosterSummary } from '../src/taxonomy.js';
import type { MergeRequestSnapshot, ReviewSignals } from '../src/types.js';

// ---------------------------------------------------------------------------
// The estate-wide rollups: one person across every board they hold work on,
// and one epic across every board that carries it.
//
// Every test here guards a rule that is easy to break by accident and whose
// breakage is INVISIBLE - a doubled count, a summed point total, a bar longer
// than the epic it describes. Those are the failures that keep looking
// plausible, which is the only kind worth writing a test for on a report
// nobody can diff against a source of truth.
// ---------------------------------------------------------------------------

// --- review latency histogram -------------------------------------------------

test('latencyHistogram places each value in the bucket whose lower bound it meets', () => {
  const b = latencyHistogram([0, 0.9, 1, 3.9, 4, 7.9, 8, 23.9, 24, 47.9, 48, 119.9, 120, 5000]);
  assert.deepEqual(
    b.map((x) => [x.label, x.count]),
    [
      ['<1h', 2],
      ['1–4h', 2],
      ['4–8h', 2],
      ['8–24h', 2],
      ['1–2d', 2],
      ['2–5d', 2],
      ['5d+', 2],
    ],
  );
});

test('latencyHistogram leaves the final bucket open-ended and every other one bounded', () => {
  const b = latencyHistogram([]);
  assert.equal(b[b.length - 1]!.toHours, null);
  assert.ok(b.slice(0, -1).every((x) => typeof x.toHours === 'number'));
  // Each bucket's upper bound is the next one's lower bound, so nothing can
  // fall between two buckets and be silently dropped from the chart.
  for (let i = 0; i < b.length - 1; i++) assert.equal(b[i]!.toHours, b[i + 1]!.fromHours);
});

test('latencyHistogram discards a negative interval rather than bucketing it', () => {
  // hoursBetween already returns null for a negative interval - an approval
  // recorded after the merge - and those merge requests are counted separately
  // as approvedAfterMerge. A negative reaching here would land in the first
  // bucket and read as an instant review.
  const b = latencyHistogram([-5, 2]);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 1);
});

// --- the sparkline ----------------------------------------------------------

test('sparkline refuses to draw a trend from fewer than two observations', () => {
  // One point is not a trend, and a single dot on an axis-less mark reads as a
  // flat line - which is the picture of a team that never changed.
  assert.match(sparkline([]), /spark-none/);
  assert.match(sparkline([7]), /spark-none/);
  assert.match(sparkline([7, 9]), /<svg/);
});

test('sparkline breaks the line at a null instead of drawing through it', () => {
  // A missing sprint is not a sprint that delivered nothing - the same rule the
  // rest of the report follows. Two segments, not one polyline across the gap.
  const svg = sparkline([5, 6, null, 9, 11]);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2);
});

test('sparkline draws an observation stranded between two nulls rather than dropping it', () => {
  // A run of one point cannot be a polyline. Discarding it would erase an
  // observation that happened, which is the same failure as drawing a null as
  // zero, only quieter.
  const svg = sparkline([null, 6, null, 9, 11]);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 1);
  // The stranded point plus the last-value dot.
  assert.equal((svg.match(/<circle/g) ?? []).length, 2);
});

test('sparkline centres a flat series rather than pinning it to an edge', () => {
  const svg = sparkline([4, 4, 4], { height: 20 });
  const ys = [...svg.matchAll(/,(\d+\.\d)/g)].map((m) => Number(m[1]));
  assert.ok(ys.every((y) => y === 10));
});

test('sparkline escapes its title, which comes from data', () => {
  assert.doesNotMatch(sparkline([1, 2], { title: '<img onerror=x>' }), /<img/);
});

// --- people across boards -----------------------------------------------------

function member(over: Partial<RosterMember> = {}): RosterMember {
  return {
    name: 'Dev One',
    openAssigned: 3,
    openInActiveSprint: 2,
    openPoints: 8,
    flaggedAssigned: 0,
    resolvedRecently: 1,
    reportedRecently: 0,
    mergeRequestsAuthored: 0,
    mergeRequestsMerged: 0,
    reviewsGiven: 0,
    jiraOnly: false,
    gitlabOnly: false,
    projects: [],
    ...over,
  };
}

function roster(members: RosterMember[], over: Partial<RosterSummary> = {}): RosterSummary {
  return {
    members,
    activeContributors: members.filter((m) => m.openInActiveSprint > 0).length,
    unassignedOpenInActiveSprint: 0,
    recentDays: 30,
    ...over,
  };
}

const signals = (over: Partial<ReviewSignals> = {}): ReviewSignals => ({
  authorIsAutomation: false,
  humanCommentCount: 0,
  automatedCommentCount: 0,
  humanCommenters: [],
  authorCommentCount: 0,
  humanApprovalCount: 0,
  automatedApprovalCount: 0,
  humanApprovals: [],
  automatedApprovals: [],
  reviewerCount: 0,
  ...over,
});

function mr(over: Partial<MergeRequestSnapshot> = {}): MergeRequestSnapshot {
  return {
    id: 1,
    iid: 1,
    projectId: 1,
    projectPath: 'group/repo',
    title: 'a change',
    state: 'merged',
    draft: false,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-21T09:00:00.000Z',
    mergedAt: '2026-08-21T09:00:00.000Z',
    sourceBranch: 'f',
    targetBranch: 'main',
    author: { accountId: 'd1', displayName: 'Dev One' },
    assignees: [],
    reviewers: [],
    issueKeys: [],
    webUrl: 'https://git.example/group/repo/-/merge_requests/1',
    review: signals(),
    ...over,
  };
}

test('estatePeople sums one person across boards and counts the boards separately', () => {
  const p = estatePeople({
    teams: [
      { key: 'tran', roster: roster([member({ openAssigned: 3, openInActiveSprint: 2 })]) },
      { key: 'fs', roster: roster([member({ openAssigned: 4, openInActiveSprint: 1 })]) },
    ],
    mergeRequests: [],
    recentDays: 30,
  });
  const row = p.people[0]!;
  assert.equal(row.name, 'Dev One');
  assert.equal(row.openAssigned, 7);
  assert.equal(row.openInActiveSprint, 3);
  assert.equal(row.activeBoardCount, 2);
  assert.deepEqual(row.boards.map((b) => b.team).sort(), ['fs', 'tran']);
  assert.equal(p.crossTeamActiveCount, 1);
  assert.equal(p.boardsCovered, 2);
});

test('estatePeople never produces a cross-board points total', () => {
  // THE rule this module exists under: a point on one board is not a point on
  // another, so points stay inside a board's own row. A future change that adds
  // a convenient "openPoints" to the person would produce a figure that looks
  // like load, is not, and would be quoted immediately.
  const p = estatePeople({
    teams: [
      { key: 'tran', roster: roster([member({ openPoints: 8 })]) },
      { key: 'fs', roster: roster([member({ openPoints: 40 })]) },
    ],
    mergeRequests: [],
    recentDays: 30,
  });
  const row = p.people[0]! as unknown as Record<string, unknown>;
  assert.equal(row.openPoints, undefined, 'no cross-board points field may exist on a person');
  assert.deepEqual(
    p.people[0]!.boards.map((b) => b.openPoints).sort((a, b) => a - b),
    [8, 40],
    'points stay per board, on that board’s own scale',
  );
});

test('estatePeople matches Jira and GitLab identities case- and whitespace-insensitively', () => {
  const p = estatePeople({
    teams: [{ key: 'tran', roster: roster([member({ name: '  Dev One ' })]) }],
    mergeRequests: [mr({ author: { accountId: 'd1', displayName: 'dev one' } })],
    recentDays: 30,
  });
  assert.equal(p.people.length, 1);
  assert.equal(p.people[0]!.mergeRequestsAuthored, 1);
  assert.equal(p.people[0]!.jiraOnly, false);
  assert.equal(p.people[0]!.gitlabOnly, false);
});

test('estatePeople counts a merge request once even when the same group is handed over twice', () => {
  // Two boards mapped to one GitLab group is a legal configuration, and summing
  // per-board rosters would double every authored count QUIETLY - the figure
  // stays plausible, which is the worst way for a number to be wrong.
  const p = estatePeople({
    teams: [{ key: 'tran', roster: roster([member()]) }],
    mergeRequests: [mr({ id: 99 }), mr({ id: 99 })],
    recentDays: 30,
  });
  assert.equal(p.mergeRequestsConsidered, 1);
  assert.equal(p.people[0]!.mergeRequestsAuthored, 1);
});

test('estatePeople excludes bot-authored merge requests from a person’s repositories', () => {
  const p = estatePeople({
    teams: [],
    mergeRequests: [
      mr({ id: 1, author: { accountId: 'bot', displayName: "I'm a Bot" }, review: signals({ authorIsAutomation: true }) }),
    ],
    recentDays: 30,
  });
  assert.equal(p.people.length, 0, 'a bot is not a person on the roster');
});

test('estatePeople flags somebody who appears in only one of the two systems', () => {
  const p = estatePeople({
    teams: [{ key: 'tran', roster: roster([member({ name: 'Product Person' })]) }],
    mergeRequests: [mr({ author: { accountId: 'ext', displayName: 'Outside Dev' } })],
    recentDays: 30,
  });
  const byName = new Map(p.people.map((x) => [x.name, x]));
  assert.equal(byName.get('Product Person')!.jiraOnly, true);
  assert.equal(byName.get('Outside Dev')!.gitlabOnly, true);
});

test('estatePeople reports reviewsGiven as unknown rather than zero when identities are missing', () => {
  const p = estatePeople({
    teams: [{ key: 'tran', roster: roster([member()]) }],
    mergeRequests: [],
    recentDays: 30,
    reviewerIdentitiesUnknown: true,
  });
  assert.equal(p.reviewerIdentitiesUnknown, true);
});

test('estatePeople orders by cross-board spread before load', () => {
  const p = estatePeople({
    teams: [
      { key: 'tran', roster: roster([member({ name: 'Spread', openInActiveSprint: 1 }), member({ name: 'Loaded', openInActiveSprint: 40 })]) },
      { key: 'fs', roster: roster([member({ name: 'Spread', openInActiveSprint: 1 })]) },
    ],
    mergeRequests: [],
    recentDays: 30,
  });
  // The person on two boards leads even though somebody else holds forty times
  // as much on one - that is the question this view exists to answer, and
  // sorting by load would bury them.
  assert.equal(p.people[0]!.name, 'Spread');
});

test('estatePeople carries the estate-wide unassigned count', () => {
  const p = estatePeople({
    teams: [
      { key: 'tran', roster: roster([member()], { unassignedOpenInActiveSprint: 5 }) },
      { key: 'fs', roster: roster([member()], { unassignedOpenInActiveSprint: 2 }) },
    ],
    mergeRequests: [],
    recentDays: 30,
  });
  // These items are on nobody's row, which is exactly why the total has to be
  // stated beside the table rather than left to be inferred from its absence.
  assert.equal(p.unassignedOpenInActiveSprint, 7);
});

// --- epics across boards ------------------------------------------------------

function rollup(over: Partial<EpicRollup> = {}): EpicRollup {
  return {
    key: 'WEB-1',
    name: 'Loyalty rewards',
    nameKnown: true,
    epicDone: false,
    active: { issues: 4, points: 10, doneIssues: 1, donePoints: 2 },
    backlog: { issues: 3, points: 5, doneIssues: 0, donePoints: 0 },
    total: { issues: 10, points: 20, doneIssues: 4, donePoints: 8 },
    blocked: 1,
    carried: 2,
    people: ['Dev One'],
    oldestOpenDays: 100,
    progress: 0.4,
    ...over,
  };
}

const result = (rollups: EpicRollup[], namesCollected = true): EpicRollupResult => ({ rollups, namesCollected });

test('estateEpics rolls one epic key up across every board that carries it', () => {
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ total: { issues: 6, points: 0, doneIssues: 3, donePoints: 0 } })]) },
    { key: 'fs', epics: result([rollup({ total: { issues: 4, points: 0, doneIssues: 1, donePoints: 0 } })]) },
  ]);
  assert.equal(e.epics.length, 1);
  assert.equal(e.epics[0]!.issues, 10);
  assert.equal(e.epics[0]!.doneIssues, 4);
  assert.equal(e.epics[0]!.crossTeam, true);
  assert.equal(e.crossTeamCount, 1);
  assert.deepEqual(e.epics[0]!.teams.map((t) => t.team).sort(), ['fs', 'tran']);
});

test('estateEpics segments are a partition, so a stacked bar cannot exceed the epic', () => {
  // Stacking active.issues beside doneIssues counts a finished sprint ticket in
  // both and draws a bar longer than the epic it describes - which reads as
  // more work existing than exists.
  const e = estateEpics([{ key: 'tran', epics: result([rollup()]) }]);
  const r = e.epics[0]!;
  assert.equal(r.doneIssues + r.activeOpenIssues + r.backlogOpenIssues + r.openElsewhere, r.issues);
  assert.equal(r.activeOpenIssues, 3);
  assert.equal(r.backlogOpenIssues, 3);
});

test('estateEpics never lets openElsewhere go negative on an inconsistent snapshot', () => {
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ total: { issues: 1, points: 0, doneIssues: 1, donePoints: 0 } })]) },
  ]);
  assert.ok(e.epics[0]!.openElsewhere >= 0);
});

test('estateEpics excludes the no-epic bucket', () => {
  // Per board it is a real and often dominant finding. Rolled up across four
  // boards it is one meaningless row summing four unrelated piles of unfiled
  // work, and it would sort to the top of every ordering on the page.
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ key: NO_EPIC, name: NO_EPIC }), rollup()]) },
  ]);
  assert.deepEqual(e.epics.map((x) => x.key), ['WEB-1']);
});

test('estateEpics keeps a real name found on one board over a key fallback on another', () => {
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ name: 'WEB-1', nameKnown: false })], false) },
    { key: 'fs', epics: result([rollup({ name: 'Loyalty rewards', nameKnown: true })]) },
  ]);
  assert.equal(e.epics[0]!.name, 'Loyalty rewards');
  assert.equal(e.epics[0]!.nameKnown, true);
  // ...and still says the estate as a whole is missing some names, so the panel
  // does not imply every epic on it is really called by its key.
  assert.equal(e.namesCollected, false);
});

test('estateEpics puts cross-board epics first', () => {
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ key: 'BIG-1', active: { issues: 99, points: 0, doneIssues: 0, donePoints: 0 } }), rollup({ key: 'SPLIT-1' })]) },
    { key: 'fs', epics: result([rollup({ key: 'SPLIT-1' })]) },
  ]);
  // The cross-board row is the one no single board view can show correctly,
  // which is the entire reason to open this panel rather than a team tab.
  assert.equal(e.epics[0]!.key, 'SPLIT-1');
});

test('estateEpics takes the OLDEST open item across boards, not the last one seen', () => {
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ oldestOpenDays: 30 })]) },
    { key: 'fs', epics: result([rollup({ oldestOpenDays: 700 })]) },
  ]);
  assert.equal(e.epics[0]!.oldestOpenDays, 700);
});

test('estateEpics dedupes people across boards', () => {
  const e = estateEpics([
    { key: 'tran', epics: result([rollup({ people: ['Dev One', 'Dev Two'] })]) },
    { key: 'fs', epics: result([rollup({ people: ['Dev Two', 'Dev Three'] })]) },
  ]);
  assert.deepEqual(e.epics[0]!.people, ['Dev One', 'Dev Three', 'Dev Two']);
});

test('estateEpics ignores a team whose epics were not computed', () => {
  const e = estateEpics([{ key: 'tran', epics: result([rollup()]) }, { key: 'fs' }]);
  assert.equal(e.boardsCovered, 1);
  assert.equal(e.epics[0]!.crossTeam, false);
});
