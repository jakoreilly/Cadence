import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSprintChurn,
  burndown,
  columnDwellNow,
  cumulativeFlow,
  cycleTimes,
  dwellIsReportable,
  formatHistory,
  historyProjection,
  seriesByTeam,
  sprintDelta,
  summariseChurn,
  summariseColumnDwell,
  summariseCycleTimes,
  teamHistory,
  type DatedTeam,
} from '../src/history.js';
import type { IssueSnapshot, JiraSnapshot, SprintSnapshot, TeamSnapshot } from '../src/types.js';

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1', id: '1', issueType: 'Story', status: 'In Development',
    statusCategory: 'To Do', created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-20T00:00:00.000Z', storyPoints: 3, storyPointsField: 'customfield_10006',
    flagged: false, labels: [], components: [], sprintIds: [10], links: [], inBacklog: false,
    assignee: { accountId: 'a', displayName: 'Dev One' }, ...over,
  };
}

const ACTIVE: SprintSnapshot = {
  id: 10, name: 'Sprint 10', state: 'active',
  startDate: '2026-08-24T00:00:00.000Z', endDate: '2026-09-07T00:00:00.000Z',
};

function team(issues: IssueSnapshot[], sprints: SprintSnapshot[] = [ACTIVE]): TeamSnapshot {
  return { key: 't', boardId: 1, columns: [], sprints, issues, errors: [] };
}

function day(date: string, issues: IssueSnapshot[], sprints: SprintSnapshot[] = [ACTIVE]): DatedTeam {
  return { date, capturedAt: `${date}T07:00:00.000Z`, team: team(issues, sprints) };
}

// --- sprintDelta ---------------------------------------------------------------

test('sprintDelta reports scope that entered and left between two observations', () => {
  const a = day('2026-08-25', [issue({ key: 'A' }), issue({ key: 'B', storyPoints: 8 })]);
  const b = day('2026-08-26', [issue({ key: 'A' }), issue({ key: 'C', storyPoints: 5 })]);

  const d = sprintDelta(a, b, 10)!;
  assert.deepEqual(d.added.map((x) => x.key), ['C']);
  assert.deepEqual(d.removed.map((x) => x.key), ['B']);
  assert.equal(d.addedPoints, 5);
  assert.equal(d.removedPoints, 8);
  assert.equal(d.netPoints, -3);
});

test('sprintDelta counts re-estimation as churn even though nothing moved', () => {
  // A 3 that becomes an 8 changed the commitment by 5 points without a single
  // ticket entering or leaving. Membership-only churn misses it entirely.
  const a = day('2026-08-25', [issue({ key: 'A', storyPoints: 3 })]);
  const b = day('2026-08-26', [issue({ key: 'A', storyPoints: 8 })]);

  const d = sprintDelta(a, b, 10)!;
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.reestimated, [{ key: 'A', from: 3, to: 8 }]);
  assert.equal(d.reestimatedPoints, 5);
  assert.equal(d.netPoints, 5);
});

test('sprintDelta treats an issue gaining an estimate as churn, not as nothing', () => {
  const a = day('2026-08-25', [issue({ key: 'A', storyPoints: null })]);
  const b = day('2026-08-26', [issue({ key: 'A', storyPoints: 5 })]);
  assert.equal(sprintDelta(a, b, 10)!.reestimatedPoints, 5);
});

test('sprintDelta records work that finished between the two days', () => {
  const a = day('2026-08-25', [issue({ key: 'A', statusCategory: 'In Progress' })]);
  const b = day('2026-08-26', [issue({ key: 'A', statusCategory: 'Done' })]);
  assert.deepEqual(sprintDelta(a, b, 10)!.resolved.map((x) => x.key), ['A']);
});

test('sprintDelta returns null for a sprint neither snapshot has heard of', () => {
  const a = day('2026-08-25', [issue()]);
  assert.equal(sprintDelta(a, a, 999), null);
});

// --- activeSprintChurn ---------------------------------------------------------

test('a sprint opening is not counted as scope added', () => {
  // GOTCHA under test: on the day a sprint starts, every issue in it is "new"
  // relative to the day before. That is the sprint being planned, not scope
  // creep, and reporting it would make every sprint start look like a disaster.
  const before = day('2026-08-23', [issue({ key: 'A', sprintIds: [] })], []);
  const after = day('2026-08-24', [issue({ key: 'A', sprintIds: [10] })]);
  assert.deepEqual(activeSprintChurn([before, after]), []);
});

test('activeSprintChurn compares every consecutive pair once the sprint exists', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A' }), issue({ key: 'B' })]);
  const d3 = day('2026-08-26', [issue({ key: 'A' }), issue({ key: 'B' }), issue({ key: 'C' })]);

  const deltas = activeSprintChurn([d1, d2, d3]);
  assert.equal(deltas.length, 2);
  assert.deepEqual(deltas.map((d) => d.added.map((a) => a.key)), [['B'], ['C']]);
});

test('activeSprintChurn is empty with no active sprint', () => {
  const closed: SprintSnapshot = { ...ACTIVE, state: 'closed' };
  assert.deepEqual(activeSprintChurn([day('2026-08-25', [issue()], [closed])]), []);
});

// --- summariseChurn ------------------------------------------------------------

test('summariseChurn totals both directions and reports a rate against the opening', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', storyPoints: 10 })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', storyPoints: 10 }), issue({ key: 'B', storyPoints: 5 })]);

  const s = summariseChurn(activeSprintChurn([d1, d2]), 10)!;
  assert.equal(s.addedPoints, 5);
  assert.equal(s.removedPoints, 0);
  assert.equal(s.netPoints, 5);
  assert.equal(s.churnRate, 0.5);
  assert.deepEqual(s.lateAdditions.map((x) => x.key), ['B']);
});

test('an issue added and then pulled out again is not a surviving late addition', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A' }), issue({ key: 'B' })]);
  const d3 = day('2026-08-26', [issue({ key: 'A' })]);

  const s = summariseChurn(activeSprintChurn([d1, d2, d3]), 3)!;
  assert.deepEqual(s.lateAdditions, []);
  // ...but it still cost the team the churn, in both directions.
  assert.equal(s.addedPoints, 3);
  assert.equal(s.removedPoints, 3);
  assert.equal(s.netPoints, 0);
});

test('summariseChurn reports an unmeasurable rate as null, never as zero', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', storyPoints: null })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', storyPoints: null }), issue({ key: 'B', storyPoints: null })]);
  assert.equal(summariseChurn(activeSprintChurn([d1, d2]), 0)!.churnRate, null);
});

// --- burndown ------------------------------------------------------------------

test('burndown reports what was actually remaining on each collected day', () => {
  const d1 = day('2026-08-25', [issue({ key: 'A', storyPoints: 5 }), issue({ key: 'B', storyPoints: 3 })]);
  const d2 = day('2026-08-26', [
    issue({ key: 'A', storyPoints: 5, statusCategory: 'Done' }),
    issue({ key: 'B', storyPoints: 3 }),
  ]);

  const points = burndown([d1, d2], 10, ACTIVE);
  assert.deepEqual(points.map((p) => p.remainingPoints), [8, 3]);
  assert.deepEqual(points.map((p) => p.committedPoints), [8, 8]);
  assert.deepEqual(points.map((p) => p.remainingIssues), [2, 1]);
});

test('the ideal line follows the CURRENT commitment, so taking on scope steps it up', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', storyPoints: 10 })]);
  const d2 = day('2026-08-31', [issue({ key: 'A', storyPoints: 10 }), issue({ key: 'B', storyPoints: 10 })]);

  const [p1, p2] = burndown([d1, d2], 10, ACTIVE);
  // Day one is the morning the sprint opened - 7 hours into 14 days - so the
  // ideal has barely moved off the full 10.
  assert.ok(Math.abs(p1!.idealRemaining! - 10) < 0.5);
  // Halfway through a 14-day sprint carrying 20 points, the ideal is 10 - which
  // is ABOVE where it would have been had the scope not grown. That step is the
  // honest picture of what was asked for.
  assert.equal(Math.round(p2!.idealRemaining!), 10);
});

test('burndown skips days where the sprint did not exist at all', () => {
  const before = day('2026-08-23', [issue({ key: 'A', sprintIds: [] })], []);
  const after = day('2026-08-24', [issue({ key: 'A' })]);
  assert.deepEqual(burndown([before, after], 10, ACTIVE).map((p) => p.date), ['2026-08-24']);
});

// --- cycleTimes ----------------------------------------------------------------

test('cycle time runs from the first day work was OBSERVED in progress', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', statusCategory: 'To Do' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', statusCategory: 'In Progress' })]);
  const d3 = day('2026-08-28', [
    issue({ key: 'A', statusCategory: 'Done', resolutionDate: '2026-08-28T00:00:00.000Z' }),
  ]);

  const { items } = cycleTimes([d1, d2, d3]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.startedOn, '2026-08-25');
  assert.equal(items[0]!.cycleDays, 3);
  assert.equal(items[0]!.startCensored, false);
});

test('work already in progress on day one is censored, not counted as starting then', () => {
  // Its real start is somewhere before collection began. Treating day one as the
  // start would make the longest-running work in the team look like the fastest.
  const d1 = day('2026-08-24', [issue({ key: 'A', statusCategory: 'In Progress' })]);
  const d2 = day('2026-08-26', [
    issue({ key: 'A', statusCategory: 'Done', resolutionDate: '2026-08-26T00:00:00.000Z' }),
  ]);

  const result = cycleTimes([d1, d2]);
  assert.equal(result.items[0]!.startCensored, true);
  const summary = summariseCycleTimes(result);
  assert.equal(summary.basis, 0);
  assert.equal(summary.censored, 1);
  assert.equal(summary.p50, null);
});

test('work never observed in progress yields no cycle time rather than a zero', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', statusCategory: 'To Do' })]);
  const d2 = day('2026-08-25', [
    issue({ key: 'A', statusCategory: 'Done', resolutionDate: '2026-08-25T00:00:00.000Z' }),
  ]);
  assert.deepEqual(cycleTimes([d1, d2]).items, []);
});

test('cycle time separates the working stretch from backlog dwell', () => {
  // The whole point of this metric: an item created in January and resolved in
  // August is a 200-day LEAD time and a 3-day CYCLE time, and only one of those
  // is a statement about how the team works.
  const d1 = day('2026-08-24', [issue({ key: 'A', statusCategory: 'To Do', created: '2026-01-01T00:00:00.000Z' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', statusCategory: 'In Progress', created: '2026-01-01T00:00:00.000Z' })]);
  const d3 = day('2026-08-28', [
    issue({
      key: 'A', statusCategory: 'Done', created: '2026-01-01T00:00:00.000Z',
      resolutionDate: '2026-08-28T00:00:00.000Z',
    }),
  ]);

  const summary = summariseCycleTimes(cycleTimes([d1, d2, d3]));
  assert.equal(summary.p50, 3);
  assert.ok(summary.medianBacklogDwellDays! > 200);
});

// --- seriesByTeam --------------------------------------------------------------

function snapshot(date: string, teams: TeamSnapshot[]): { date: string; snapshot: JiraSnapshot } {
  return {
    date,
    snapshot: {
      schemaVersion: 3, source: 'jira', site: 's', capturedAt: `${date}T07:00:00.000Z`,
      individualAttribution: true, fieldMap: { discoveredAt: '', sprint: 'customfield_10001', storyPoints: [] },
      teams,
    },
  };
}

test('seriesByTeam orders days oldest first regardless of input order', () => {
  const a = { ...team([issue()]), key: 'alpha' };
  const series = seriesByTeam([snapshot('2026-08-26', [a]), snapshot('2026-08-24', [a])]);
  assert.deepEqual(series.get('alpha')!.map((d) => d.date), ['2026-08-24', '2026-08-26']);
});

test('a team absent from one day is skipped, never read as an empty board', () => {
  // `collect --team X` writes a snapshot holding one team. Reading the others as
  // zero issues would invent a total wipe of the sprint on that date and a total
  // re-add on the next - the loudest false finding this layer could produce.
  const a = { ...team([issue()]), key: 'alpha' };
  const b = { ...team([issue()]), key: 'beta' };
  const series = seriesByTeam([snapshot('2026-08-24', [a, b]), snapshot('2026-08-25', [a])]);
  assert.deepEqual(series.get('beta')!.map((d) => d.date), ['2026-08-24']);
  assert.equal(series.get('alpha')!.length, 2);
});

// --- the projection ------------------------------------------------------------
//
// `history`, `report` and `alert` hold EVERY collected day at once, and a day's
// jira.json is ~30 MB. Parsed whole that is ~56 MB of heap per day retained for
// the process lifetime, which put those commands on course to exhaust Node's
// default ~4 GB ceiling somewhere past day 70. historyProjection keeps the ten
// fields this layer reads and drops the rest, taking it to ~12.5 MB per day.
//
// The entire justification for that is that the OUTPUT is unchanged, so that is
// what is asserted - on a fixture carrying every field the projection drops, and
// covering churn, burndown, cycle time and column dwell in one go.

test('the projection yields byte-identical history to the full snapshot', () => {
  const heavy = (over: Partial<IssueSnapshot>): IssueSnapshot =>
    issue({
      // Every field the projection deliberately does NOT carry. If any metric
      // ever starts reading one of these, this assertion is what fails.
      summary: 'a title', description: 'a long description', descriptionTruncated: true,
      priority: 'High', resolution: 'Done', statusCategoryChangedAt: '2026-08-27T00:00:00.000Z',
      dueDate: '2026-08-30', reporter: { accountId: 'r', displayName: 'Reporter' },
      creator: { accountId: 'c', displayName: 'Creator' }, epicKey: 'WEB-100',
      epicName: 'Storefront rollout', parentKey: 'WEB-9', rank: '0|i000:', flagged: true,
      labels: ['debt', 'release-4'], components: ['api'], timeSpentSeconds: 3600,
      links: [{ type: 'is blocked by', direction: 'inward', key: 'WEB-77' }],
      blockedBy: ['WEB-77'], comments: [{ id: '1', created: '2026-08-28T00:00:00.000Z', body: 'blocked', truncated: false }],
      commentCount: 4, inBacklog: false,
      ...over,
    });

  const columns = [
    { name: 'To Do', statusIds: ['1'] },
    { name: 'In Development', statusIds: ['3'] },
    { name: 'Done', statusIds: ['5'] },
  ];
  const mk = (date: string, issues: IssueSnapshot[]): TeamSnapshot => ({
    key: 't', boardId: 1, columns, sprints: [ACTIVE], issues, errors: [],
  });

  // A starts To Do so its move into progress is OBSERVED on day two rather than
  // censored - that is what puts a real figure in cycle.basis, and a censored A
  // would make the vacuous-pass guard below pass for the wrong reason.
  const d1 = mk('2026-08-25', [
    heavy({ key: 'A', statusId: '1', statusCategory: 'To Do', storyPoints: 3 }),
    heavy({ key: 'B', statusId: '3', statusCategory: 'In Progress', storyPoints: 5 }),
  ]);
  const d2 = mk('2026-08-26', [
    heavy({ key: 'A', statusId: '3', statusCategory: 'In Progress', storyPoints: 8 }), // re-estimated
    heavy({ key: 'C', statusId: '3', statusCategory: 'In Progress', storyPoints: 2 }), // added, B removed
  ]);
  const d3 = mk('2026-08-27', [
    heavy({ key: 'A', statusId: '5', statusCategory: 'Done', storyPoints: 8, resolutionDate: '2026-08-27T10:00:00.000Z' }),
    heavy({ key: 'C', statusId: '3', statusCategory: 'In Progress', storyPoints: 2 }),
  ]);

  const days = [
    snapshot('2026-08-25', [d1]),
    snapshot('2026-08-26', [d2]),
    snapshot('2026-08-27', [d3]),
  ];

  const fromFull = teamHistory(seriesByTeam(days).get('t')!);
  const fromProjection = teamHistory(
    seriesByTeam(days.map((d) => ({ date: d.date, snapshot: historyProjection(d.snapshot) }))).get('t')!,
  );

  assert.deepEqual(fromProjection, fromFull);
  // Vacuous-pass guard: the fixture must actually exercise the metrics.
  assert.ok(fromFull.churn, 'fixture should produce a churn summary');
  assert.equal(fromFull.churn!.observations, 2);
  assert.equal(fromFull.burndown.length, 3);
  assert.equal(fromFull.cycle.basis, 1, 'A started and finished inside the window');
  assert.ok(fromFull.columnDwell.length > 0, 'fixture should produce column dwell');
});

test('the projection does not alias the snapshot it read', () => {
  // The whole point is that the original parse becomes garbage. Sharing the
  // issue objects or their sprintId arrays keeps it reachable and saves nothing.
  const original = snapshot('2026-08-25', [team([issue({ key: 'A', sprintIds: [10] })])]).snapshot;
  const projected = historyProjection(original);
  assert.notEqual(projected.teams[0], original.teams[0]);
  assert.notEqual(projected.teams[0]!.issues[0], original.teams[0]!.issues[0]);
  assert.notEqual(projected.teams[0]!.issues[0]!.sprintIds, original.teams[0]!.issues[0]!.sprintIds);
  assert.deepEqual(projected.teams[0]!.issues[0]!.sprintIds, [10]);
});

// --- teamHistory / formatting --------------------------------------------------

test('one snapshot reports nothing measured, not zero churn', () => {
  const h = teamHistory([day('2026-08-25', [issue()])]);
  assert.equal(h.days, 1);
  assert.equal(h.churn, null);
  assert.match(formatHistory([h]), /Only one snapshot/);
  assert.doesNotMatch(formatHistory([h]), /SCOPE CHURN {2}Sprint 10/);
});

test('teamHistory measures the busiest active sprint when a board has several', () => {
  // Board 705 runs six concurrent active sprints. The churn conversation is
  // about the one carrying the work, not whichever sorts first.
  const small: SprintSnapshot = { ...ACTIVE, id: 20, name: 'Small' };
  const sprints = [ACTIVE, small];
  const d1 = day('2026-08-24', [issue({ key: 'BIG', storyPoints: 50 }), issue({ key: 'SM', sprintIds: [20], storyPoints: 1 })], sprints);
  const d2 = day('2026-08-25', [
    issue({ key: 'BIG', storyPoints: 50 }),
    issue({ key: 'SM', sprintIds: [20], storyPoints: 1 }),
    issue({ key: 'NEW', storyPoints: 8 }),
  ], sprints);

  const h = teamHistory([d1, d2]);
  assert.equal(h.churn!.sprintName, 'Sprint 10');
  assert.equal(h.churn!.addedPoints, 8);
});

test('formatHistory shows the churn totals and the surviving late additions', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', storyPoints: 10 })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', storyPoints: 10 }), issue({ key: 'LATE', storyPoints: 5 })]);
  const text = formatHistory([teamHistory([d1, d2])]);
  assert.match(text, /SCOPE CHURN/);
  assert.match(text, /added\s+1 issues\s+5 pts/);
  assert.match(text, /LATE/);
  assert.match(text, /SOUND/);
  // Captures a day apart, so no caution.
  assert.match(text, /24h apart/);
  assert.ok(!/CAUTION/.test(text));
});

// GOTCHA, and it is the first thing the real two-day history showed: the header
// dates are FOLDER NAMES, and consecutive folder names do not mean a day of
// activity. The first two real snapshots here were 2026-08-26 (re-collected at
// 21:20 after a schema bump) and 2026-08-27 (the 06:00 scheduled run) - 8.7
// hours apart, every one of them overnight, with 3 of 20,701 issues touched.
// Every churn figure was legitimately zero, and read as "a quiet sprint day" it
// would have been completely wrong. The hours travel with the figure.
test('an overnight interval says so, so a zero is not read as a quiet day', () => {
  const d1: DatedTeam = { date: '2026-08-26', capturedAt: '2026-08-26T21:20:39.978Z', team: team([issue({ key: 'A' })]) };
  const d2: DatedTeam = { date: '2026-08-27', capturedAt: '2026-08-27T06:00:06.918Z', team: team([issue({ key: 'A' })]) };
  const h = teamHistory([d1, d2]);
  assert.equal(h.observedHours, 8.7);

  const text = formatHistory([h]);
  assert.match(text, /8\.7h apart/);
  assert.match(text, /CAUTION/);
  assert.match(text, /not a full/);
  assert.match(text, /nothing changed in those hours/);
});

test('a single snapshot reports no interval rather than zero hours', () => {
  const h = teamHistory([day('2026-08-27', [issue()])]);
  assert.equal(h.observedHours, null, 'zero hours would read as two simultaneous captures');
});

// --- column dwell --------------------------------------------------------------

test('column dwell counts back to the first day the issue sat in its CURRENT status', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const d3: DatedTeam = {
    date: '2026-08-26',
    capturedAt: '2026-08-26T07:00:00.000Z',
    team: team([issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]),
  };
  const { items, observedFrom } = columnDwellNow([d1, d2, d3]);
  assert.equal(observedFrom, '2026-08-24');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.column, 'In Development');
  assert.equal(items[0]!.sinceDate, '2026-08-24');
  // From midnight UTC on the 24th to 07:00 on the 26th is 2 days and 7 hours.
  assert.ok(Math.abs(items[0]!.dwellDays - (2 + 7 / 24)) < 0.001);
  // Present in the same column on EVERY collected day including the first, so
  // its real entry into the column is unknown - it could predate collection.
  assert.equal(items[0]!.censored, true);
});

test('an issue already in its column on day one is censored, not dated from day one', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', status: 'Waiting Test', statusCategory: 'In Progress' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', status: 'Waiting Test', statusCategory: 'In Progress' })]);
  const { items } = columnDwellNow([d1, d2]);
  assert.equal(items[0]!.censored, true);
  assert.equal(items[0]!.sinceDate, '2026-08-24');
});

test('a column change resets dwell to the day of the move', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', status: 'To Do', statusCategory: 'To Do' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const d3: DatedTeam = {
    date: '2026-08-26',
    capturedAt: '2026-08-26T00:00:00.000Z',
    team: team([issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]),
  };
  const { items } = columnDwellNow([d1, d2, d3]);
  assert.equal(items[0]!.column, 'In Development');
  assert.equal(items[0]!.sinceDate, '2026-08-25');
  assert.equal(items[0]!.censored, false);
  assert.equal(items[0]!.dwellDays, 1);
});

test('an issue that dropped out of the active sprint by the last day is not measured', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', sprintIds: [] })]);
  assert.deepEqual(columnDwellNow([d1, d2]).items, []);
});

test('column dwell resolves BY STATUS ID against the board columns when they exist', () => {
  const cols: TeamSnapshot['columns'] = [{ name: 'Dev', statusIds: ['3'] }, { name: 'Test', statusIds: ['4'] }];
  const withCols = (issues: IssueSnapshot[]): TeamSnapshot => ({ ...team(issues), columns: cols });
  const d1: DatedTeam = { date: '2026-08-24', capturedAt: '2026-08-24T00:00:00.000Z', team: withCols([issue({ key: 'A', statusId: '3' })]) };
  const d2: DatedTeam = { date: '2026-08-25', capturedAt: '2026-08-25T00:00:00.000Z', team: withCols([issue({ key: 'A', statusId: '4' })]) };
  const { items } = columnDwellNow([d1, d2]);
  // Moved from the Dev column's status to the Test column's status - a new
  // column, so dwell dates from the second day, not the first.
  assert.equal(items[0]!.column, 'Test');
  assert.equal(items[0]!.sinceDate, '2026-08-25');
});

test('summariseColumnDwell groups by column and separates censored from measured', () => {
  const items = [
    { key: 'A', issueType: 'Story', column: 'Dev', sinceDate: '2026-08-20', dwellDays: 4, censored: false },
    { key: 'B', issueType: 'Story', column: 'Dev', sinceDate: '2026-08-18', dwellDays: 6, censored: false },
    { key: 'C', issueType: 'Story', column: 'Dev', sinceDate: '2026-08-10', dwellDays: 14, censored: true },
    { key: 'D', issueType: 'Bug', column: 'Test', sinceDate: '2026-08-23', dwellDays: 1, censored: false },
  ];
  const summary = summariseColumnDwell(items);
  const dev = summary.find((s) => s.column === 'Dev')!;
  assert.equal(dev.count, 3);
  assert.equal(dev.censored, 1);
  assert.equal(dev.basis, 2);
  assert.equal(dev.medianDwellDays, 5); // median of [4, 6], the censored item excluded
  // The longest-sitting issues in the column, worst first, so the panel has
  // something to name rather than only a median. Worst-first is guaranteed by
  // this function, not inherited from the caller's ordering: the fixture above
  // is deliberately in ascending dwell order, and C (14 days) has to lead.
  assert.deepEqual(dev.oldest.map((i) => i.key), ['C', 'B', 'A']);
  // Worst column (by median dwell) first.
  assert.equal(summary[0]!.column, 'Dev');
});

test('the longest-sitting list is capped and keeps the WORST, not the first seen', () => {
  // The failure this guards: with unsorted input a bare slice discards the
  // genuinely longest-sitting tickets and labels whatever survived "Longest
  // sitting" in the report.
  const items = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    key: `WEB-${d}`, issueType: 'Story', column: 'Dev', sinceDate: '2026-08-25', dwellDays: d, censored: false,
  }));
  const [col] = summariseColumnDwell(items, 3);
  assert.deepEqual(col!.oldest.map((i) => i.key), ['WEB-7', 'WEB-6', 'WEB-5']);
  assert.equal(col!.count, 7, 'the full depth is still reported');
});

// --- the basis bar -------------------------------------------------------------
//
// A column with one observed entry still has a non-null "median" - it is that one
// ticket's dwell. On the first real snapshot that could produce this panel, five
// of the twelve columns across the estate's four boards were in exactly that
// state: board 701's `waiting test` held 47 open issues, 46 of them already there
// on day one, and reported a median of 3 days from the single remaining one.

test('a median resting on too few observed entries is withheld, not reported', () => {
  const one = [
    { key: 'A', issueType: 'Story', column: 'waiting test', sinceDate: '2026-08-25', dwellDays: 6, censored: false },
    { key: 'B', issueType: 'Story', column: 'waiting test', sinceDate: '2026-08-24', dwellDays: 9, censored: true },
    { key: 'C', issueType: 'Story', column: 'waiting test', sinceDate: '2026-08-24', dwellDays: 9, censored: true },
  ];
  const [col] = summariseColumnDwell(one);
  // The COUNT is exact - a count needs one snapshot - and so is the censored
  // tally. Only the percentiles are unavailable.
  assert.equal(col!.count, 3);
  assert.equal(col!.censored, 2);
  assert.equal(col!.basis, 1);
  assert.equal(dwellIsReportable(col!), false);
  // The raw percentile is still computed and carried; refusing to QUOTE it is
  // the consumer's job, via dwellIsReportable, so every consumer draws the line
  // in the same place.
  assert.equal(col!.medianDwellDays, 6);
});

test('a column that can be quoted sorts above a deeper one that cannot', () => {
  // Otherwise the row a reader looks at first is the least trustworthy one: the
  // deep unmeasurable column has the higher raw median and led the table while
  // displaying no figures at all.
  const items = [
    // Deep, but only one observed entry, and its dwell is the highest number here.
    ...Array.from({ length: 9 }, (_, i) => ({
      key: `D${i}`, issueType: 'Story', column: 'waiting test', sinceDate: '2026-08-24', dwellDays: 30, censored: true,
    })),
    { key: 'D9', issueType: 'Story', column: 'waiting test', sinceDate: '2026-08-24', dwellDays: 30, censored: false },
    // Shallower, but three observed entries - a real median.
    { key: 'A', issueType: 'Story', column: 'Dev', sinceDate: '2026-08-25', dwellDays: 4, censored: false },
    { key: 'B', issueType: 'Story', column: 'Dev', sinceDate: '2026-08-25', dwellDays: 5, censored: false },
    { key: 'C', issueType: 'Story', column: 'Dev', sinceDate: '2026-08-25', dwellDays: 6, censored: false },
  ];
  const summary = summariseColumnDwell(items);
  assert.equal(summary[0]!.column, 'Dev', 'the quotable column leads');
  assert.equal(summary[0]!.basis, 3);
  assert.equal(dwellIsReportable(summary[1]!), false);
  assert.equal(summary[1]!.count, 10, 'the unmeasurable column keeps its exact depth');
});

test('unmeasurable columns are ordered by depth, which is the only real fact left', () => {
  const thin = (column: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: `${column}${i}`, issueType: 'Story', column, sinceDate: '2026-08-24', dwellDays: 5, censored: true,
    }));
  const summary = summariseColumnDwell([...thin('shallow', 2), ...thin('deep', 7)]);
  assert.ok(summary.every((c) => !dwellIsReportable(c)));
  assert.deepEqual(summary.map((c) => c.column), ['deep', 'shallow']);
});

test('the CLI withholds the median rather than printing one from a single entry', () => {
  const d1 = day('2026-08-24', [
    issue({ key: 'A', status: 'Waiting Test', statusCategory: 'In Progress' }),
    issue({ key: 'B', status: 'Waiting Test', statusCategory: 'In Progress' }),
  ]);
  const d2 = day('2026-08-25', [
    issue({ key: 'A', status: 'Waiting Test', statusCategory: 'In Progress' }),
    issue({ key: 'B', status: 'Waiting Test', statusCategory: 'In Progress' }),
  ]);
  const text = formatHistory([teamHistory([d1, d2])]);
  assert.match(text, /too few observed entries to quote/);
  // The count survives; only the percentile is gone.
  assert.match(text, /Waiting Test\s+2 open/);
});

test('teamHistory carries column dwell, empty when there is no active sprint', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const h = teamHistory([d1, d2]);
  assert.ok(h.columnDwell.length > 0);
  assert.equal(h.columnDwell[0]!.column, 'In Development');

  const noActive = day('2026-08-24', [issue({ sprintIds: [] })], [{ ...ACTIVE, state: 'closed' }]);
  assert.deepEqual(teamHistory([noActive]).columnDwell, []);
});

test('formatHistory prints per-column ageing', () => {
  const d1 = day('2026-08-24', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const d2 = day('2026-08-25', [issue({ key: 'A', status: 'In Development', statusCategory: 'In Progress' })]);
  const text = formatHistory([teamHistory([d1, d2])]);
  assert.match(text, /COLUMN AGEING/);
  assert.match(text, /In Development/);
});

// --- cumulativeFlow / cyclePoints --------------------------------------------
//
// No upstream equivalent - these are Cadence's own. They guard the two rules
// whose breakage is invisible on the rendered chart: bands that stop summing to
// the sprint, and a resolution-date slice that has quietly become a cycle-length
// slice (the tail drawn as if it were the whole).

const FLOW_COLS = [
  { name: 'To Do', statusIds: ['1'] },
  { name: 'In Development', statusIds: ['3'] },
  { name: 'Done', statusIds: ['5'] },
];

const teamWithColumns = (issues: IssueSnapshot[], sprints: SprintSnapshot[] = [ACTIVE]): TeamSnapshot => ({
  key: 't', boardId: 1, columns: FLOW_COLS, sprints, issues, errors: [],
});

const flowDay = (date: string, issues: IssueSnapshot[], sprints: SprintSnapshot[] = [ACTIVE]): DatedTeam => ({
  date, capturedAt: `${date}T07:00:00.000Z`, team: teamWithColumns(issues, sprints),
});

test('cumulativeFlow returns null when the board has no column configuration', () => {
  // `day()` builds a team with `columns: []` - there is nothing to distribute
  // the work across, so the answer is null, not an invented set of buckets.
  const series = [
    day('2026-08-25', [issue({ key: 'A', statusId: '3' })]),
    day('2026-08-26', [issue({ key: 'A', statusId: '3' })]),
  ];
  assert.equal(cumulativeFlow(series, 10), null);
});

test('cumulativeFlow counts every issue in the sprint, so the bands sum to its total', () => {
  const d1 = flowDay('2026-08-25', [
    issue({ key: 'A', statusId: '1' }),
    issue({ key: 'B', statusId: '3' }),
    issue({ key: 'C', statusId: '3' }),
  ]);
  const d2 = flowDay('2026-08-26', [
    issue({ key: 'A', statusId: '3' }),
    issue({ key: 'B', statusId: '5' }),
    issue({ key: 'C', statusId: '3' }),
    issue({ key: 'D', statusId: '1' }),
  ]);
  const flow = cumulativeFlow([d1, d2], 10)!;
  assert.ok(flow);
  assert.equal(flow.days.length, 2);
  for (const fd of flow.days) {
    assert.equal(fd.counts.reduce((a, c) => a + c, 0), fd.total);
  }
  assert.equal(flow.days[0]!.total, 3);
  assert.equal(flow.days[1]!.total, 4);
});

test('cumulativeFlow drops the off-board bucket when nothing ever landed in it', () => {
  const d1 = flowDay('2026-08-25', [issue({ key: 'A', statusId: '1' }), issue({ key: 'B', statusId: '3' })]);
  const d2 = flowDay('2026-08-26', [issue({ key: 'A', statusId: '3' }), issue({ key: 'B', statusId: '5' })]);
  const flow = cumulativeFlow([d1, d2], 10)!;
  assert.ok(!flow.columns.includes('(not on the board)'));
  assert.deepEqual(flow.columns, ['To Do', 'In Development', 'Done']);
  assert.ok(flow.days.every((fd) => fd.counts.length === flow.columns.length));
});

test('cyclePoints keeps the most recently resolved, not the slowest', () => {
  // Two slow tickets that resolved earliest, and 300 quick ones that resolved
  // later. CYCLE_POINT_CAP is 300, so a slice ordered by resolution date drops
  // the slow pair; a slice ordered by cycle length (the order `cycle.items`
  // arrives in) would keep them and drop 2 quick ones instead - the tail drawn
  // as the whole.
  const CAP = 300;
  const slow = ['SLOW-1', 'SLOW-2'].map((key) =>
    issue({ key, statusId: '3', statusCategory: 'In Progress' }),
  );
  const fast = Array.from({ length: CAP }, (_, i) =>
    issue({ key: `FAST-${i}`, statusId: '3', statusCategory: 'In Progress' }),
  );

  const dA = day('2026-08-01', slow); // slow pair first observed in progress
  const dB = day('2026-08-14', [...slow, ...fast]); // quick ones enter here
  const dC = day('2026-08-21', [
    ...slow.map((i) => ({ ...i, statusCategory: 'Done', resolutionDate: '2026-08-15T00:00:00.000Z' })),
    ...fast.map((i) => ({ ...i, statusCategory: 'Done', resolutionDate: '2026-08-20T00:00:00.000Z' })),
  ]);

  // The slow pair really is the slowest - otherwise this proves nothing.
  const slowestTwo = cycleTimes([dA, dB, dC]).items.slice(0, 2).map((i) => i.key).sort();
  assert.deepEqual(slowestTwo, ['SLOW-1', 'SLOW-2']);

  const h = teamHistory([dA, dB, dC]);
  assert.equal(h.cyclePoints.length, CAP);
  assert.equal(h.cyclePointsOmitted, 2);
  assert.ok(h.cyclePoints.every((p) => p.key !== 'SLOW-1' && p.key !== 'SLOW-2'));
});
