import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completedInSprint,
  forecast,
  leadTimeDays,
  median,
  percentile,
  sprintMetrics,
  sprintsInOrder,
  sprintWindow,
  teamTrends,
} from '../src/derive.js';
import type { IssueSnapshot, SprintSnapshot, TeamSnapshot } from '../src/types.js';

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1',
    id: '1',
    issueType: 'Story',
    status: 'Resolved',
    statusCategory: 'Done',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-10T00:00:00.000Z',
    storyPoints: 3,
    storyPointsField: 'customfield_10006',
    flagged: false,
    labels: [],
    components: [],
    sprintIds: [1],
    links: [],
    inBacklog: false,
    ...over,
  };
}

function sprint(id: number, over: Partial<SprintSnapshot> = {}): SprintSnapshot {
  return {
    id,
    name: `s${id}`,
    state: 'closed',
    startDate: `2026-0${id}-01T00:00:00.000Z`,
    endDate: `2026-0${id}-14T00:00:00.000Z`,
    completeDate: `2026-0${id}-14T12:00:00.000Z`,
    ...over,
  };
}

function team(sprints: SprintSnapshot[], issues: IssueSnapshot[]): TeamSnapshot {
  return { key: 't', boardId: 1, columns: [], sprints, issues, errors: [] };
}

// --- percentile -------------------------------------------------------------

test('percentile interpolates linearly, matching Excel PERCENTILE', () => {
  const xs = [1, 2, 3, 4];
  assert.equal(percentile(xs, 0), 1);
  assert.equal(percentile(xs, 1), 4);
  assert.equal(percentile(xs, 0.5), 2.5);
  // rank = 3 * 0.1 = 0.3, so 1 + (2-1)*0.3
  assert.equal(percentile(xs, 0.1)?.toFixed(4), '1.3000');
});

test('percentile handles empty and single-element input', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
});

test('median does not mutate its input', () => {
  const xs = [3, 1, 2];
  assert.equal(median(xs), 2);
  assert.deepEqual(xs, [3, 1, 2]);
});

// --- sprint ordering and windows --------------------------------------------

test('sprintsInOrder sorts by startDate, not by id', () => {
  // A sprint created later (higher id) can be scheduled earlier.
  const a = sprint(9, { startDate: '2026-01-01T00:00:00.000Z' });
  const b = sprint(2, { startDate: '2026-05-01T00:00:00.000Z' });
  assert.deepEqual(sprintsInOrder([b, a]).map((s) => s.id), [9, 2]);
});

test('sprintsInOrder puts never-started sprints last, ordered by id', () => {
  const started = sprint(5);
  const future1 = { id: 20, name: 'f1', state: 'future' };
  const future2 = { id: 10, name: 'f2', state: 'future' };
  assert.deepEqual(sprintsInOrder([future1, started, future2]).map((s) => s.id), [5, 10, 20]);
});

test('sprintWindow prefers completeDate over endDate', () => {
  // Teams close a sprint after it expires; work done in the overrun must count.
  const w = sprintWindow(sprint(1, { endDate: '2026-01-14T00:00:00.000Z', completeDate: '2026-01-17T00:00:00.000Z' }));
  assert.equal(w?.end, '2026-01-17T00:00:00.000Z');
  assert.equal(sprintWindow({ id: 1, name: 'x', state: 'future' }), null);
});

test('completedInSprint compares instants, not offset strings', () => {
  const w = { start: '2026-01-01T00:00:00.000Z', end: '2026-01-14T00:00:00.000Z' };
  // A "+01:00" timestamp inside the window must match despite the differing
  // textual offset - this is why the comparison parses instead of comparing text.
  assert.equal(completedInSprint(issue({ resolutionDate: '2026-01-10T09:00:00.000+01:00' }), w), true);
  assert.equal(completedInSprint(issue({ resolutionDate: '2026-02-01T00:00:00.000Z' }), w), false);
  assert.equal(completedInSprint(issue({ resolutionDate: undefined }), w), false);
});

test('leadTimeDays rejects a resolution before creation', () => {
  assert.equal(leadTimeDays(issue({ created: '2026-01-10T00:00:00.000Z', resolutionDate: '2026-01-01T00:00:00.000Z' })), null);
  assert.equal(leadTimeDays(issue({ created: '2026-01-01T00:00:00.000Z', resolutionDate: '2026-01-11T00:00:00.000Z' })), 10);
  assert.equal(leadTimeDays(issue({ resolutionDate: undefined })), null);
});

// --- sprint metrics ---------------------------------------------------------

test('completed counts only work resolved inside the sprint window', () => {
  const s1 = sprint(1);
  const t = team([s1], [
    issue({ key: 'A', sprintIds: [1], resolutionDate: '2026-01-05T00:00:00.000Z', storyPoints: 5 }),
    // In the sprint, but resolved long after it closed - belongs to a later sprint.
    issue({ key: 'B', sprintIds: [1], resolutionDate: '2026-06-05T00:00:00.000Z', storyPoints: 8 }),
    // In the sprint, never resolved.
    issue({ key: 'C', sprintIds: [1], resolutionDate: undefined, storyPoints: 2 }),
  ]);
  const m = sprintMetrics(t)[0]!;
  assert.equal(m.completedIssues, 1);
  assert.equal(m.completedPoints, 5);
  assert.equal(m.committedIssues, 3);
  assert.equal(m.committedPoints, 15);
});

test('carriedOut uses chronological position, not id order', () => {
  // Sprint id 9 runs FIRST, id 2 runs second. An issue in both was carried out
  // of 9 into 2 - an id comparison would conclude the opposite.
  const first = sprint(9, { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-14T00:00:00.000Z', completeDate: '2026-01-14T00:00:00.000Z' });
  const second = sprint(2, { startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-02-14T00:00:00.000Z', completeDate: '2026-02-14T00:00:00.000Z' });
  const t = team([second, first], [issue({ sprintIds: [2, 9], resolutionDate: undefined })]);
  const [m1, m2] = sprintMetrics(t);
  assert.equal(m1?.id, 9);
  assert.equal(m1?.carriedOut, 1);
  assert.equal(m2?.id, 2);
  assert.equal(m2?.carriedOut, 0);
});

test('daysLate is a signed number, not a boolean', () => {
  // Closing 12 hours after the end date is 0.5 days, not "late" in any
  // meaningful sense - which is exactly why this is not a boolean.
  const m = sprintMetrics(team([sprint(1)], []))[0]!;
  assert.equal(m.daysLate, 0.5);
  // Closed early.
  const early = sprintMetrics(
    team([sprint(1, { endDate: '2026-01-14T00:00:00.000Z', completeDate: '2026-01-13T00:00:00.000Z' })], []),
  )[0]!;
  assert.equal(early.daysLate, -1);
  // No completeDate at all.
  const open = sprintMetrics(team([{ id: 1, name: 'a', state: 'active', startDate: 'x', endDate: 'y' }], []))[0]!;
  assert.equal(open.daysLate, null);
});

test('unestimatedCommitted counts issues with no points in either field', () => {
  const t = team([sprint(1)], [
    issue({ key: 'A', sprintIds: [1], storyPoints: null, storyPointsField: null }),
    issue({ key: 'B', sprintIds: [1], storyPoints: 0, storyPointsField: 'customfield_10006' }),
  ]);
  // A zero-point spike is estimated, so only A counts.
  assert.equal(sprintMetrics(t)[0]!.unestimatedCommitted, 1);
});

test('completedByType gives the feature/bug split', () => {
  const t = team([sprint(1)], [
    issue({ key: 'A', issueType: 'Story', sprintIds: [1], resolutionDate: '2026-01-05T00:00:00.000Z' }),
    issue({ key: 'B', issueType: 'Bug', sprintIds: [1], resolutionDate: '2026-01-06T00:00:00.000Z' }),
    issue({ key: 'C', issueType: 'Bug', sprintIds: [1], resolutionDate: '2026-01-07T00:00:00.000Z' }),
  ]);
  assert.deepEqual(sprintMetrics(t)[0]!.completedByType, { Story: 1, Bug: 2 });
});

// --- forecast ---------------------------------------------------------------

const closedWith = (points: number[]) =>
  points.map((p, i) => ({
    id: i + 1,
    name: `s${i}`,
    state: 'closed',
    daysLate: null,
    committedIssues: 1,
    committedPoints: p,
    completedIssues: p > 0 ? 1 : 0,
    completedPoints: p,
    unestimatedCommitted: 0,
    carriedOut: 0,
    leadTimeDaysP50: null,
    leadTimeDaysP90: null,
    completedByType: {},
  }));

test('forecast ignores the active sprint', () => {
  const metrics = [...closedWith([10, 20, 30]), { ...closedWith([999])[0]!, state: 'active' }];
  const f = forecast(metrics, 12, (m) => m.completedPoints);
  // A partial active sprint would drag the band; basis stays at the 3 closed ones.
  assert.equal(f.basis, 3);
  assert.equal(f.p50, 20);
});

test('forecast drops zero-output sprints from the basis', () => {
  const f = forecast(closedWith([0, 0, 10, 20, 30]), 12, (m) => m.completedPoints);
  assert.equal(f.basis, 3);
  assert.equal(f.p50, 20);
});

test('forecast honours the window, taking the most recent sprints', () => {
  const f = forecast(closedWith([1, 1, 1, 100, 200, 300]), 3, (m) => m.completedPoints);
  assert.equal(f.basis, 3);
  assert.equal(f.p50, 200);
});

test('forecast reports relative spread and copes with no data', () => {
  const f = forecast(closedWith([10, 20, 30]), 12, (m) => m.completedPoints);
  assert.equal(f.p10?.toFixed(1), '12.0');
  assert.equal(f.p90?.toFixed(1), '28.0');
  assert.equal(f.relativeSpread?.toFixed(2), '0.80');

  const empty = forecast([], 12, (m) => m.completedPoints);
  assert.deepEqual(
    { basis: empty.basis, p50: empty.p50, spread: empty.relativeSpread },
    { basis: 0, p50: null, spread: null },
  );
});

test('teamTrends is flagged approximate and exposes both forecasts', () => {
  const t = team([sprint(1), sprint(2)], [
    issue({ key: 'A', sprintIds: [1], resolutionDate: '2026-01-05T00:00:00.000Z', storyPoints: 5 }),
    issue({ key: 'B', sprintIds: [2], resolutionDate: '2026-02-05T00:00:00.000Z', storyPoints: 8 }),
  ]);
  const trends = teamTrends(t, 12);
  // The flag is what tells a UI never to present these as observed history.
  assert.equal(trends.approximate, true);
  assert.equal(trends.pointsForecast.basis, 2);
  assert.equal(trends.issuesForecast.basis, 2);
  assert.equal(trends.pointsForecast.p50, 6.5);
});
