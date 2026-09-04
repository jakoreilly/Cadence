import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionItems,
  medianSprintLengthDays,
  practiceByPerson,
  slowestResolved,
  sprintOutlook,
  teamHealth,
} from '../src/insights.js';
import type { TeamTrends } from '../src/derive.js';
import type { IssueSnapshot, MergeRequestSnapshot, ReviewSignals, SprintSnapshot, TeamSnapshot } from '../src/types.js';

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

function team(issues: IssueSnapshot[], sprints: SprintSnapshot[] = [ACTIVE]): TeamSnapshot {
  return { key: 't', boardId: 1, columns: [], sprints, issues, errors: [] };
}

const OPTS = { now: NOW, staleDays: 10 };

// --- attentionItems -----------------------------------------------------------

test('attentionItems reports only open work in the active sprint', () => {
  const t = team([
    issue({ key: 'A', flagged: true }),
    issue({ key: 'B', statusCategory: 'Done', flagged: true }), // done - excluded
    issue({ key: 'C', sprintIds: [99], flagged: true }), // not in the active sprint
    issue({ key: 'D' }), // healthy - no reason to list it
  ]);
  assert.deepEqual(attentionItems(t, OPTS).map((i) => i.key), ['A']);
});

test('attentionItems ranks an explicit block above long carryover above staleness', () => {
  const t = team([
    issue({ key: 'STALE', updated: '2026-08-01T00:00:00.000Z' }),
    issue({ key: 'CARRIED', sprintIds: [1, 2, 3, 4, 10] }),
    issue({ key: 'BLOCKED', flagged: true }),
  ]);
  assert.deepEqual(attentionItems(t, OPTS).map((i) => i.key), ['BLOCKED', 'CARRIED', 'STALE']);
});

test('attentionItems only calls work stale when it is actually In Progress', () => {
  // An untouched item sitting in To Do is a backlog question, not a blockage.
  const todo = issue({ key: 'T', statusCategory: 'To Do', updated: '2026-07-01T00:00:00.000Z', storyPoints: 5 });
  assert.deepEqual(attentionItems(team([todo]), OPTS).map((i) => i.key), []);
  const wip = issue({ key: 'W', statusCategory: 'In Progress', updated: '2026-07-01T00:00:00.000Z' });
  assert.ok(attentionItems(team([wip]), OPTS)[0]!.reasons.includes('stale'));
});

test('attentionItems collects every reason that applies to one ticket', () => {
  const t = team([
    issue({ key: 'X', flagged: true, sprintIds: [1, 2, 3, 10], storyPoints: null, assignee: undefined, updated: '2026-07-01T00:00:00.000Z' }),
  ]);
  const it = attentionItems(t, OPTS)[0]!;
  assert.deepEqual([...it.reasons].sort(), ['blocked', 'carried', 'stale', 'unassigned', 'unestimated']);
});

// --- practiceByPerson ---------------------------------------------------------

function signals(over: Partial<ReviewSignals> = {}): ReviewSignals {
  return {
    authorIsAutomation: false, humanCommentCount: 0, automatedCommentCount: 0, authorCommentCount: 0,
    humanCommenters: [], humanApprovalCount: 0, automatedApprovalCount: 0, humanApprovals: [],
    automatedApprovals: [], reviewerCount: 0, ...over,
  };
}

function mr(over: Partial<MergeRequestSnapshot> = {}): MergeRequestSnapshot {
  return {
    id: 1, iid: 1, projectId: 1, title: 't', state: 'merged', draft: false,
    createdAt: '2026-08-25T09:00:00.000Z', updatedAt: '2026-08-26T09:00:00.000Z',
    mergedAt: '2026-08-26T09:00:00.000Z', sourceBranch: 'b', targetBranch: 'main',
    assignees: [], reviewers: [], issueKeys: [], webUrl: '',
    author: { accountId: '1', displayName: 'Alice' }, review: signals(), ...over,
  };
}

test('practiceByPerson counts a self-merged, unreviewed MR against its author', () => {
  const p = practiceByPerson([mr({ id: 1 }), mr({ id: 2, review: signals({ humanCommentCount: 1 }) })]);
  const alice = p.people.find((x) => x.name === 'Alice')!;
  assert.equal(alice.authored, 2);
  assert.equal(alice.mergedKnown, 2);
  assert.equal(alice.mergedUnreviewed, 1);
});

test('practiceByPerson credits reviewers and never credits self-review', () => {
  const p = practiceByPerson([
    mr({
      id: 1,
      review: signals({
        humanCommentCount: 3,
        // Bob commented; Alice commented on her OWN merge request.
        humanCommenters: [{ accountId: '2', displayName: 'Bob' }, { accountId: '1', displayName: 'Alice' }],
      }),
    }),
  ]);
  assert.equal(p.people.find((x) => x.name === 'Bob')!.reviewsGiven, 1);
  assert.equal(p.people.find((x) => x.name === 'Alice')!.reviewsGiven, 0);
});

test('practiceByPerson counts one review per merge request, not per comment', () => {
  // A reviewer who both comments AND approves the same MR reviewed one MR.
  const p = practiceByPerson([
    mr({
      review: signals({
        humanCommentCount: 8,
        humanCommenters: [{ accountId: '2', displayName: 'Bob' }],
        humanApprovalCount: 1,
        humanApprovals: [{ accountId: '2', displayName: 'Bob' }],
      }),
    }),
  ]);
  assert.equal(p.people.find((x) => x.name === 'Bob')!.reviewsGiven, 1);
});

test('practiceByPerson excludes bot-authored merge requests entirely', () => {
  const p = practiceByPerson([
    mr({ id: 1, author: { accountId: '9', displayName: 'SonarQube' }, review: signals({ authorIsAutomation: true }) }),
    mr({ id: 2 }),
  ]);
  assert.equal(p.people.find((x) => x.name === 'SonarQube'), undefined);
  assert.equal(p.people.find((x) => x.name === 'Alice')!.authored, 1);
});

test('practiceByPerson flags a pre-schema-3 snapshot as unknown, not as zero reviews', () => {
  // Version 2 recorded comment COUNTS but not commenter identities. Reporting
  // "0 reviews given" for everyone would be a lie about the whole team.
  const old = practiceByPerson([mr({ review: signals({ humanCommentCount: 4 }) })]);
  assert.equal(old.reviewerIdentitiesUnknown, true);
  const fresh = practiceByPerson([
    mr({ review: signals({ humanCommentCount: 1, humanCommenters: [{ accountId: '2', displayName: 'Bob' }] }) }),
  ]);
  assert.equal(fresh.reviewerIdentitiesUnknown, false);
});

test('practiceByPerson leaves unknown-review MRs out of the denominator', () => {
  // review: undefined means the detail was never collected - not that nobody
  // looked at it.
  const p = practiceByPerson([mr({ review: undefined })]);
  const alice = p.people.find((x) => x.name === 'Alice')!;
  assert.equal(alice.authored, 1);
  assert.equal(alice.mergedKnown, 0);
  assert.equal(alice.mergedUnreviewed, 0);
});

// --- sprintOutlook ------------------------------------------------------------

const closedSprint = (id: number, start: string, end: string): SprintSnapshot => ({
  id, name: `s${id}`, state: 'closed', startDate: start, endDate: end, completeDate: end,
});

function trends(p50: number | null): TeamTrends {
  return {
    team: 't', boardId: 1, approximate: true, sprints: [],
    pointsForecast: { basis: 12, p10: 10, p50, p90: 100, relativeSpread: 3 },
    issuesForecast: { basis: 12, p10: 1, p50: 5, p90: 10, relativeSpread: 1 },
    carryoverRateMedian: 0.2,
  };
}

const HISTORY = [
  closedSprint(1, '2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z'),
  closedSprint(2, '2026-07-15T00:00:00.000Z', '2026-07-29T00:00:00.000Z'),
];

test('sprintOutlook says on-track when the remaining pace is at or under normal', () => {
  // 14-day sprints, p50 70 => 5 pts/day normal. 7 days left, 10 pts remaining
  // => 1.4 pts/day required. Comfortably on track.
  const t = team([issue({ key: 'A', storyPoints: 10 })], [ACTIVE, ...HISTORY]);
  const o = sprintOutlook(t, trends(70), new Date('2026-09-01T00:00:00.000Z'))!;
  assert.equal(o.verdict, 'on-track');
  assert.equal(o.remainingPoints, 10);
});

test('sprintOutlook says will-not-land when the required pace far exceeds normal', () => {
  const t = team([issue({ key: 'A', storyPoints: 200 })], [ACTIVE, ...HISTORY]);
  const o = sprintOutlook(t, trends(70), new Date('2026-09-01T00:00:00.000Z'))!;
  assert.equal(o.verdict, 'will-not-land');
  assert.ok(o.paceRatio! > 1.75);
});

test('sprintOutlook subtracts work already done', () => {
  const t = team(
    [issue({ key: 'A', storyPoints: 10 }), issue({ key: 'B', storyPoints: 40, statusCategory: 'Done' })],
    [ACTIVE, ...HISTORY],
  );
  const o = sprintOutlook(t, trends(70), new Date('2026-09-01T00:00:00.000Z'))!;
  assert.equal(o.committedPoints, 50);
  assert.equal(o.donePoints, 40);
  assert.equal(o.remainingPoints, 10);
});

test('sprintOutlook refuses a verdict when the sprint is mostly unestimated', () => {
  // Board 705's shape. A confident "on track" from the estimated minority
  // would be worse than saying nothing.
  const issues = [
    issue({ key: 'A', storyPoints: 5 }),
    ...Array.from({ length: 9 }, (_, i) => issue({ key: `U${i}`, storyPoints: null, storyPointsField: null })),
  ];
  const o = sprintOutlook(team(issues, [ACTIVE, ...HISTORY]), trends(70), new Date('2026-09-01T00:00:00.000Z'))!;
  assert.equal(o.verdict, 'unknown');
  assert.match(o.unreliableReason!, /90% of this sprint carries no estimate/);
});

test('sprintOutlook treats an overdue sprint without dividing by zero days', () => {
  const t = team([issue({ key: 'A', storyPoints: 10 })], [ACTIVE, ...HISTORY]);
  const o = sprintOutlook(t, trends(70), new Date('2026-09-20T00:00:00.000Z'))!;
  assert.ok(o.daysRemaining! < 0, 'past the end date');
  assert.ok(Number.isFinite(o.requiredPointsPerDay!), 'must not be Infinity');
  assert.equal(o.verdict, 'will-not-land');
});

test('sprintOutlook returns null with no active sprint', () => {
  assert.equal(sprintOutlook(team([], HISTORY), trends(70), NOW), null);
});

test('medianSprintLengthDays measures what the team really does', () => {
  assert.equal(medianSprintLengthDays(HISTORY), 14);
  assert.equal(medianSprintLengthDays([]), null);
});

// --- teamHealth ---------------------------------------------------------------

test('teamHealth turns rates into explainable signals', () => {
  const h = teamHealth({
    unreviewedRate: 0.6, carryoverRate: 0.6, unestimatedRate: 0.05,
    relativeSpread: 3.17, outlook: null,
  });
  assert.equal(h.signals.find((s) => s.label === 'Code review')!.tone, 'poor');
  assert.equal(h.signals.find((s) => s.label === 'Carryover')!.tone, 'poor');
  assert.equal(h.signals.find((s) => s.label === 'Estimation')!.tone, 'good');
  assert.equal(h.signals.find((s) => s.label === 'Predictability')!.tone, 'poor');
  assert.equal(h.headline, 'poor');
});

test('teamHealth reports good only when every measured signal is healthy', () => {
  const h = teamHealth({
    unreviewedRate: 0.1, carryoverRate: 0.1, unestimatedRate: 0.1, relativeSpread: 0.5, outlook: null,
  });
  assert.equal(h.headline, 'good');
  assert.equal(h.poorCount, 0);
});

test('teamHealth never invents a reading from missing data', () => {
  const h = teamHealth({
    unreviewedRate: null, carryoverRate: null, unestimatedRate: null, relativeSpread: null, outlook: null,
  });
  assert.equal(h.headline, 'unknown');
  assert.ok(h.signals.every((s) => s.tone === 'unknown'));
});

// --- slowestResolved ----------------------------------------------------------

test('slowestResolved ranks by lead time within the window', () => {
  const t = team([
    issue({ key: 'OLD', created: '2025-01-01T00:00:00.000Z', resolutionDate: '2026-08-30T00:00:00.000Z' }),
    issue({ key: 'QUICK', created: '2026-08-28T00:00:00.000Z', resolutionDate: '2026-08-30T00:00:00.000Z' }),
    // Resolved long before the window opened.
    issue({ key: 'ANCIENT', created: '2020-01-01T00:00:00.000Z', resolutionDate: '2020-02-01T00:00:00.000Z' }),
  ]);
  const slow = slowestResolved(t, { now: NOW, withinDays: 30, limit: 10 });
  assert.deepEqual(slow.map((s) => s.key), ['OLD', 'QUICK']);
  assert.ok(slow[0]!.leadTimeDays > 600);
});

test('slowestResolved honours its limit and ignores unresolved work', () => {
  const t = team([issue({ key: 'A', resolutionDate: undefined })]);
  assert.deepEqual(slowestResolved(t, { now: NOW, withinDays: 30, limit: 5 }), []);
});
