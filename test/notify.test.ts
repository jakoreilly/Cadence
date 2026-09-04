import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interventions, type Intervention } from '../src/interventions.js';
import { buildFeed } from '../src/notify/feed.js';
import type { Feed, TeamFeed } from '../src/notify/feed.js';
import {
  ALERTABLE_KINDS,
  alertIdentity,
  alertMessage,
  classify,
  headline,
  nextState,
  type Alert,
} from '../src/notify/digest.js';
import { emptyState, type AlertState } from '../src/notify/state.js';
import { chunkForSlack } from '../src/notify/slack.js';
import { buildRowHtml, LOG_HEADER_ROW, mergeRowsSortedBySeverityDesc } from '../src/notify/confluence.js';
import { deriveTrends } from '../src/derive.js';
import { wipSummary } from '../src/flow.js';
import { sprintOutlook } from '../src/insights.js';
import type { ReviewMetrics } from '../src/review.js';
import { SCHEMA_VERSION, type IssueSnapshot, type JiraSnapshot, type SprintSnapshot, type TeamSnapshot } from '../src/types.js';

// Value shapes are taken from the real site: LOG/WEB keys, the status names
// board 702 and 701 actually use ("In Development", "Waiting Test"), and the
// two-story-point-field reality (points land in storyPoints either way).

const ACTIVE: SprintSnapshot = {
  id: 7001,
  name: 'Core Sprint - 2026 S17',
  state: 'active',
  startDate: '2026-08-17T08:00:00.000Z',
  endDate: '2026-08-31T08:00:00.000Z',
  goal: 'Zone service tariffs',
};

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'LOG-7000',
    id: '100000',
    issueType: 'Story',
    summary: 'Create Tariff Exceptions endpoint on ZoneService',
    status: 'In Development',
    statusCategory: 'In Progress',
    created: '2026-07-01T09:00:00.000Z',
    updated: '2026-08-20T09:00:00.000Z',
    // Assigned by default: an unowned ticket is a finding of its own
    // (`unassigned`), and leaving the fixture unassigned made every test that
    // used three or more of them carry an extra intervention nobody asked for.
    assignee: { accountId: '5f1a', displayName: 'Colm Behan' },
    storyPoints: 5,
    storyPointsField: 'customfield_10006',
    flagged: false,
    labels: [],
    components: [],
    sprintIds: [ACTIVE.id],
    links: [],
    inBacklog: false,
    ...over,
  };
}

function team(issues: IssueSnapshot[], over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    key: 'tran',
    boardId: 702,
    boardName: 'Logistics Scrum Board',
    columns: [],
    sprints: [ACTIVE],
    issues,
    errors: [],
    ...over,
  };
}

function snapshot(teams: TeamSnapshot[], capturedAt: string): JiraSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'jira',
    site: 'acme.atlassian.net',
    capturedAt,
    individualAttribution: true,
    fieldMap: { discoveredAt: capturedAt, sprint: 'customfield_10001', storyPoints: ['customfield_10006'] },
    teams,
  };
}

/** A feed built straight from a team snapshot, at a stated clock. */
function feedOf(t: TeamSnapshot, capturedAt: string, over: Partial<TeamFeed> = {}): Feed {
  const jira = snapshot([t], capturedAt);
  const now = new Date(capturedAt);
  const trends = deriveTrends(jira, 12)[0]!;
  return {
    date: capturedAt.slice(0, 10),
    capturedAt,
    site: jira.site,
    schema: { expected: SCHEMA_VERSION, files: [], gaps: [], stale: false, headline: null, remedy: null },
    teams: [
      {
        team: t.key,
        boardId: t.boardId,
        boardName: t.boardName,
        caveats: {},
        interventions: interventions({
          team: t,
          trends,
          outlook: sprintOutlook(t, trends, now),
          wip: wipSummary(t, { now, staleDays: 10 }),
          now,
          staleDays: 10,
          perKindLimit: 50,
        }),
        ...over,
      },
    ],
  };
}

function review(over: Partial<ReviewMetrics> = {}): ReviewMetrics {
  return {
    team: 'tran', groups: ['logistics-hub'],
    totalMergeRequests: 100, automationAuthored: 0, humanAuthoredTotal: 100,
    merged: 80, open: 20, closedUnmerged: 0, draft: 0,
    reviewDetailKnown: 100, humanReviewed: 60, automatedReviewed: 90,
    mergedKnown: 80, mergedWithoutHumanReview: 5, mergedWithNoHumanInvolvement: 5,
    hoursToFirstHumanReviewP50: 10, hoursToFirstHumanReviewP90: 40, hoursToFirstHumanReviewBasis: 60,
    hoursToFirstAutomatedReviewP50: 0.5, hoursToFirstAutomatedReviewBasis: 90,
    hoursOpenToMergeP50: 16, hoursOpenToMergeP90: 90, hoursOpenToMergeBasis: 80,
    hoursApprovalToMergeP50: 5, hoursApprovalToMergeP90: 20, hoursApprovalToMergeBasis: 70,
    approvedAfterMerge: 0,
    awaitingFirstHumanReview: [],
    latencyBuckets: [], neverHumanReviewed: 0,
    withIssueKey: 26,
    ...over,
  };
}

/** interventions() called directly, with the same trends/outlook/wip plumbing
 *  feedOf builds, but exposing `review` - feedOf's own feed builder does not
 *  wire up review at all, and the review-triggered interventions need it. */
function interventionsOf(t: TeamSnapshot, capturedAt: string, r?: ReviewMetrics) {
  const jira = snapshot([t], capturedAt);
  const now = new Date(capturedAt);
  const trends = deriveTrends(jira, 12)[0]!;
  return interventions({
    team: t,
    trends,
    outlook: sprintOutlook(t, trends, now),
    review: r,
    wip: wipSummary(t, { now, staleDays: 10 }),
    now,
    staleDays: 10,
    perKindLimit: 50,
  });
}

// --- review-stalled ----------------------------------------------------------

test('a merge request open for days with no human review becomes an intervention', () => {
  const r = review({
    awaitingFirstHumanReview: [
      { title: 'PayGateway supporting changes', webUrl: 'https://gitlab.example.com/payments-core/x/-/merge_requests/1', projectPath: 'payments-core/x', openHours: 200 },
    ],
  });
  const found = interventionsOf(team([issue()]), '2026-08-27T06:00:00.000Z', r).find((i) => i.kind === 'review-stalled');
  assert.equal(found?.severity, 'act-now');
  assert.ok(found?.what.includes('merge_requests/1'));
});

test('a merge request open only briefly does not become an intervention', () => {
  const r = review({
    awaitingFirstHumanReview: [
      { title: 'small fix', webUrl: 'https://gitlab.example.com/payments-core/x/-/merge_requests/2', projectPath: 'payments-core/x', openHours: 5 },
    ],
  });
  const found = interventionsOf(team([issue()]), '2026-08-27T06:00:00.000Z', r).find((i) => i.kind === 'review-stalled');
  assert.equal(found, undefined);
});

test('two stalled merge requests for the same team get distinct alert identities', () => {
  const r = review({
    awaitingFirstHumanReview: [
      { title: 'first', webUrl: 'https://gitlab.example.com/payments-core/x/-/merge_requests/1', projectPath: 'payments-core/x', openHours: 200 },
      { title: 'second', webUrl: 'https://gitlab.example.com/payments-core/x/-/merge_requests/2', projectPath: 'payments-core/x', openHours: 90 },
    ],
  });
  const stalled = interventionsOf(team([issue()]), '2026-08-27T06:00:00.000Z', r).filter((i) => i.kind === 'review-stalled');
  assert.equal(stalled.length, 2);
  // Without identityKey these collapse: both have issueKeys: [], so the
  // issueKeys-derived identity is identical for every merge request in a team.
  assert.notEqual(alertIdentity(stalled[0]!), alertIdentity(stalled[1]!));
});

test('review-stalled is on the alert allowlist', () => {
  assert.ok(ALERTABLE_KINDS.has('review-stalled'));
});

function stateWith(records: Array<Partial<AlertState['records'][number]> & { identity: string }>): AlertState {
  return {
    ...emptyState('acme'),
    seededAt: '2026-08-26',
    records: records.map((r) => ({
      team: 'tran',
      kind: 'flagged',
      severity: 'this-week' as const,
      title: 'a finding',
      firstSeenDate: '2026-08-26',
      lastSentDate: '2026-08-26',
      sends: 1,
      seeded: false,
      ...r,
    })),
  };
}

// --- identity ----------------------------------------------------------------

test('alertIdentity is stable when unrelated findings move around it', () => {
  const flagged = issue({ key: 'LOG-6405', flagged: true, updated: '2026-08-01T09:00:00.000Z' });
  const other = issue({ key: 'LOG-7172', flagged: true, updated: '2026-08-02T09:00:00.000Z' });

  const withBoth = feedOf(team([flagged, other]), '2026-08-27T06:00:00.000Z').teams[0]!.interventions;
  const withOne = feedOf(team([flagged]), '2026-08-27T06:00:00.000Z').teams[0]!.interventions;

  const a = withBoth.find((i) => i.issueKeys[0] === 'LOG-6405')!;
  const b = withOne.find((i) => i.issueKeys[0] === 'LOG-6405')!;

  // The positional id is exactly what must not be used as an identity: dropping
  // a sibling finding renumbers it.
  assert.notEqual(withBoth.length, withOne.length);
  assert.equal(alertIdentity(a), alertIdentity(b));
  assert.equal(alertIdentity(a), 'tran|flagged|LOG-6405');
});

test('the unassigned finding keys its identity on the team, not the ticket list', () => {
  // `unassigned` names every unowned ticket in the sprint, and that list churns
  // daily. One ticket getting an owner while another arrives must not read as
  // the finding clearing and a new one appearing - so its identity is a
  // constant (`identityKey: 'team'`), independent of which tickets are in it.
  const many = (n: number): IssueSnapshot[] =>
    Array.from({ length: n }, (_, i) => issue({ key: `LOG-${7100 + i}`, assignee: undefined }));
  const a = feedOf(team(many(6)), '2026-08-27T06:00:00.000Z').teams[0]!.interventions.find((i) => i.kind === 'unassigned')!;
  const b = feedOf(team(many(5)), '2026-08-27T06:00:00.000Z').teams[0]!.interventions.find((i) => i.kind === 'unassigned')!;
  assert.equal(alertIdentity(a), alertIdentity(b));
  assert.match(alertIdentity(a), /\|unassigned\|team$/);
});

test('the sprint-overdue finding keys its identity on the sprint, not the still-open tickets', () => {
  // A board runs several concurrent sprints; the tickets still open in an
  // overdue one change as work closes, but the finding - that sprint is still
  // open past its end date - does not. Identity is the sprint id.
  const overdue: SprintSnapshot = { id: 5942, name: 'Vulnerabilities', state: 'active', startDate: '2026-08-03T08:00:00.000Z', endDate: '2026-08-17T08:00:00.000Z' };
  const withThree = team(
    [issue({ key: 'PAY-1', sprintIds: [5942] }), issue({ key: 'PAY-2', sprintIds: [5942] }), issue({ key: 'PAY-3', sprintIds: [5942] })],
    { key: 'fs', boardId: 705, sprints: [overdue] },
  );
  const withOne = team([issue({ key: 'PAY-9', sprintIds: [5942] })], { key: 'fs', boardId: 705, sprints: [overdue] });
  const a = feedOf(withThree, '2026-08-27T06:00:00.000Z').teams[0]!.interventions.find((i) => i.kind === 'sprint-overdue')!;
  const b = feedOf(withOne, '2026-08-27T06:00:00.000Z').teams[0]!.interventions.find((i) => i.kind === 'sprint-overdue')!;
  assert.equal(alertIdentity(a), alertIdentity(b));
  assert.match(alertIdentity(a), /\|sprint-overdue\|sprint-5942$/);
});

// --- what gets sent ----------------------------------------------------------

const flaggedTeam = (updated: string): TeamSnapshot =>
  team([issue({ key: 'LOG-6405', flagged: true, updated }), issue({ key: 'LOG-7001' })]);

test('a finding present in both snapshots and already sent is standing, not repeated', () => {
  const today = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const previous = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-26T06:00:00.000Z');
  const plan = classify({
    today,
    previous,
    state: stateWith([{ identity: 'tran|flagged|LOG-6405', severity: 'act-now' }]),
    minSeverity: 'this-week',
    limit: 8,
  });
  assert.equal(plan.send.length, 0);
  assert.equal(plan.standing.length, 1);
});

test('a SEEDED baseline suppresses the next run - the day-one firehose does not move to day two', () => {
  // The regression this pins: the test was `record.sends > 0`, and a seeded
  // record has sends: 0, so every standing finding fired on the second run.
  const today = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const previous = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-26T06:00:00.000Z');
  const seeded = stateWith([
    { identity: 'tran|flagged|LOG-6405', severity: 'act-now', sends: 0, lastSentDate: null, seeded: true },
  ]);
  const plan = classify({ today, previous, state: seeded, minSeverity: 'this-week', limit: 8 });
  assert.equal(plan.send.length, 0);
  assert.equal(plan.standing[0]?.status, 'standing');
});

test('a finding that got worse since it was sent fires again, labelled as escalated', () => {
  // Idle three days is the act-now threshold for a flag, so the same ticket
  // crosses it overnight.
  const today = feedOf(flaggedTeam('2026-08-23T05:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const previous = feedOf(flaggedTeam('2026-08-23T05:00:00.000Z'), '2026-08-24T06:00:00.000Z');
  assert.equal(previous.teams[0]!.interventions.find((i) => i.kind === 'flagged')?.severity, 'this-week');
  assert.equal(today.teams[0]!.interventions.find((i) => i.kind === 'flagged')?.severity, 'act-now');

  const plan = classify({
    today,
    previous,
    state: stateWith([{ identity: 'tran|flagged|LOG-6405', severity: 'this-week' }]),
    minSeverity: 'this-week',
    limit: 8,
  });
  const sent = plan.send.find((a) => a.identity === 'tran|flagged|LOG-6405');
  assert.equal(sent?.status, 'escalated');
  assert.equal(sent?.previousSeverity, 'this-week');
  assert.match(alertMessage(sent!, 'plain'), /escalated from THIS WEEK/);
});

test('present yesterday but never reported is sent once, and is NOT called new', () => {
  const today = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const previous = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-26T06:00:00.000Z');
  const plan = classify({ today, previous, state: emptyState('acme'), minSeverity: 'this-week', limit: 8 });
  const sent = plan.send.find((a) => a.identity === 'tran|flagged|LOG-6405');
  assert.equal(sent?.status, 'unreported');
  // Calling a week-old blocker "new" is how a reader stops trusting every other
  // label in the message.
  assert.match(alertMessage(sent!, 'plain'), /not previously reported/);
});

test('absent from the previous snapshot is new', () => {
  const today = feedOf(flaggedTeam('2026-08-27T05:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const previous = feedOf(team([issue({ key: 'LOG-6405' }), issue({ key: 'LOG-7001' })]), '2026-08-26T06:00:00.000Z');
  const plan = classify({ today, previous, state: emptyState('acme'), minSeverity: 'this-week', limit: 8 });
  assert.equal(plan.send.find((a) => a.identity === 'tran|flagged|LOG-6405')?.status, 'new');
});

test('a first run with no state records a baseline and sends nothing', () => {
  const today = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const plan = classify({ today, previous: null, state: null, minSeverity: 'this-week', limit: 8 });
  assert.equal(plan.seeding, true);
  assert.equal(plan.send.length, 0);
  assert.ok(plan.candidates > 0);
  // The GOTCHA that cost a full re-run: `considered` has to exist independently
  // of what was sent, or the baseline is written empty.
  assert.equal(plan.considered.length, plan.candidates);
  const state = nextState(null, plan, 'acme', plan.considered);
  assert.equal(state.records.length, plan.candidates);
  assert.ok(state.records.every((r) => r.seeded && r.sends === 0));
  assert.match(headline(plan, 'plain'), /baseline recorded/);
});

test('the per-run cap names what it dropped instead of truncating silently', () => {
  const flags = Array.from({ length: 5 }, (_, i) =>
    issue({ key: `LOG-${6400 + i}`, flagged: true, updated: '2026-08-01T09:00:00.000Z' }),
  );
  const today = feedOf(team(flags), '2026-08-27T06:00:00.000Z');
  const plan = classify({ today, previous: null, state: emptyState('acme'), minSeverity: 'this-week', limit: 2 });
  assert.equal(plan.send.length, 2);
  assert.equal(plan.suppressedByLimit.length, 3);
  assert.match(headline(plan, 'plain'), /3 over the per-run cap/);
});

test('a sent finding that is gone today is reported cleared and dropped from the state', () => {
  const today = feedOf(team([issue({ key: 'LOG-6405' })]), '2026-08-27T06:00:00.000Z');
  const state = stateWith([{ identity: 'tran|flagged|LOG-6405', severity: 'act-now', sends: 3 }]);
  const plan = classify({ today, previous: null, state, minSeverity: 'this-week', limit: 8 });
  assert.equal(plan.cleared.length, 1);
  // Dropped rather than remembered for ever: the same blockage recurring in
  // September is news, and a stale record would suppress it.
  const next = nextState(state, plan, 'acme', plan.considered);
  assert.equal(next.records.find((r) => r.identity === 'tran|flagged|LOG-6405'), undefined);
});

// An item can DE-escalate below the floor without going away. It is correctly
// not reported as cleared - it is still standing - and its state record has to
// survive too, or the tool forgets a finding it just declined to call cleared.
// Without this, day three classifies it as "not previously reported" (a false
// statement) and its firstSeenDate and send count are gone.
function feedWithSeverity(severity: Intervention['severity'], capturedAt: string): Feed {
  const t = team([issue({ key: 'LOG-6405' })]);
  return feedOf(t, capturedAt, {
    interventions: [{
      id: 'tran-scope-churn-0',
      team: 'tran',
      severity,
      kind: 'scope-churn',
      title: 'The sprint shrank by 9 points after it started',
      what: 'Across 1 observed day: +0 added, -9 removed, +0 from re-estimation.',
      why: 'Work leaving a sprint mid-flight is sometimes triage and sometimes a quiet retreat.',
      action: 'Check whether the removed items went back to the backlog.',
      issueKeys: ['LOG-6405'],
      weight: 100,
    }],
  });
}

test('a finding that de-escalates below the floor keeps its state history', () => {
  const identity = 'tran|scope-churn|LOG-6405';
  // Yesterday it was act-now and was sent. Today it is only `watch`, which is
  // below the `this-week` floor, but it is still there.
  const today = feedWithSeverity('watch', '2026-08-27T06:00:00.000Z');
  const previous = feedWithSeverity('act-now', '2026-08-26T06:00:00.000Z');
  const state = stateWith([{ identity, kind: 'scope-churn', severity: 'act-now', sends: 3, firstSeenDate: '2026-08-20' }]);

  const plan = classify({ today, previous, state, minSeverity: 'this-week', limit: 8 });

  // Below the floor, so nothing is sent and it is not a candidate...
  assert.equal(plan.send.length, 0);
  assert.equal(plan.considered.length, 0);
  // ...but it is present, so it must NOT be reported as cleared.
  assert.equal(plan.cleared.length, 0, 'still standing, so not cleared');
  assert.ok(plan.presentToday.includes(identity));

  // ...and therefore its record must survive, untouched.
  const next = nextState(state, plan, 'acme', plan.considered);
  const kept = next.records.find((r) => r.identity === identity);
  assert.ok(kept, 'a present-but-de-escalated finding must not be dropped from the state');
  assert.equal(kept!.firstSeenDate, '2026-08-20');
  assert.equal(kept!.sends, 3);
  // The recorded severity is what was SENT, so a later re-crossing of the floor
  // is an escalation against act-now rather than a fresh first sighting.
  assert.equal(kept!.severity, 'act-now');
});

test('a finding that de-escalates and then comes back is escalated, never "unreported"', () => {
  const identity = 'tran|scope-churn|LOG-6405';
  const state = stateWith([{ identity, kind: 'scope-churn', severity: 'this-week', sends: 1, firstSeenDate: '2026-08-20' }]);

  // Day 2: below the floor. State survives.
  const dipped = classify({
    today: feedWithSeverity('watch', '2026-08-27T06:00:00.000Z'),
    previous: feedWithSeverity('this-week', '2026-08-26T06:00:00.000Z'),
    state, minSeverity: 'this-week', limit: 8,
  });
  const afterDip = nextState(state, dipped, 'acme', dipped.considered);

  // Day 3: back, and worse than it was last sent.
  const back = classify({
    today: feedWithSeverity('act-now', '2026-08-28T06:00:00.000Z'),
    previous: feedWithSeverity('watch', '2026-08-27T06:00:00.000Z'),
    state: afterDip, minSeverity: 'this-week', limit: 8,
  });
  const sent = back.send.find((a) => a.identity === identity);
  assert.equal(sent?.status, 'escalated', 'it was reported before, so this is an escalation');
  assert.equal(sent?.previousSeverity, 'this-week');
  assert.notEqual(sent?.status, 'unreported');
});

test('a suppressed finding that escalates while suppressed keeps its SENT severity in the state', () => {
  // Otherwise the escalation is recorded as "already told them" and never fires.
  const today = feedOf(flaggedTeam('2026-08-01T09:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const state = stateWith([{ identity: 'tran|flagged|LOG-6405', severity: 'this-week' }]);
  const plan = classify({ today, previous: null, state, minSeverity: 'this-week', limit: 0 });
  assert.equal(plan.send.length, 0);
  const next = nextState(state, plan, 'acme', plan.considered);
  assert.equal(next.records.find((r) => r.identity === 'tran|flagged|LOG-6405')?.severity, 'this-week');
});

test('--resend says it is a resend rather than claiming the finding is unreported', () => {
  const today = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-27T06:00:00.000Z');
  const previous = feedOf(flaggedTeam('2026-08-20T09:00:00.000Z'), '2026-08-26T06:00:00.000Z');
  const plan = classify({
    today,
    previous,
    // What runAlerts does for --resend: an EMPTY state, not a null one, so this
    // is not mistaken for a baseline run.
    state: emptyState('acme'),
    minSeverity: 'this-week',
    limit: 8,
    resend: true,
  });
  assert.equal(plan.seeding, false);
  const message = alertMessage(plan.send[0]!, 'plain');
  assert.match(message, /re-sent on request/);
  assert.ok(!message.includes('not previously reported'));
  assert.match(headline(plan, 'plain'), /re-sent on request/);
});

// --- the caveats -------------------------------------------------------------

test('a points figure carries its estimate coverage, and a review rate its denominator', () => {
  const t = team([issue({ key: 'LOG-6405', flagged: true, updated: '2026-08-01T09:00:00.000Z' })]);
  const base = feedOf(t, '2026-08-27T06:00:00.000Z');
  const teamFeed = base.teams[0]!;
  const overCommitted: Intervention = {
    id: 'tran-over-committed-0',
    team: 'tran',
    severity: 'act-now',
    kind: 'over-committed',
    title: 'This sprint is carrying 27 points against a best-ever 105',
    what: '27 committed points is above this team\'s own p90 of 104.8.',
    why: 'why',
    action: 'action',
    issueKeys: [],
    weight: 1,
  };
  const reviewGap: Intervention = { ...overCommitted, id: 'x', kind: 'review-gap', title: '60% unreviewed' };
  const withCaveats: Feed = {
    ...base,
    teams: [
      {
        ...teamFeed,
        interventions: [overCommitted, reviewGap],
        caveats: {
          points: '97% of this team\'s active-sprint work carries no estimate (149 of 154 issues).',
          review: 'Review figures are over the 80 merge requests a PERSON opened.',
        },
      },
    ],
  };
  const plan = classify({ today: withCaveats, previous: null, state: emptyState('p'), minSeverity: 'this-week', limit: 8 });
  const points = plan.send.find((a) => a.intervention.kind === 'over-committed')!;
  const review = plan.send.find((a) => a.intervention.kind === 'review-gap')!;
  assert.match(points.caveats.join(' '), /149 of 154/);
  assert.match(review.caveats.join(' '), /a PERSON opened/);
  // And it is IN the message, not merely on the object - the message is what
  // gets forwarded.
  assert.match(alertMessage(points, 'plain'), /Basis: 97%/);
  // A caveat that does not apply is not attached: four notes on every message
  // is boilerplate nobody reads, which fails the same way as having none.
  assert.equal(points.caveats.length, 1);
});

test('the freshness verdict travels on the run, so "no blockers" cannot read as "none recorded"', () => {
  const base = feedOf(team([issue({ flagged: true, updated: '2026-08-01T09:00:00.000Z' })]), '2026-08-27T06:00:00.000Z');
  const stale: Feed = {
    ...base,
    schema: { ...base.schema, stale: true, headline: 'The snapshot on disk is BEHIND this build of the tool.' },
  };
  const plan = classify({ today: stale, previous: null, state: emptyState('p'), minSeverity: 'this-week', limit: 8 });
  assert.match(headline(plan, 'plain'), /WARNING: The snapshot on disk is BEHIND/);
});

test('only allowlisted kinds can reach a channel', () => {
  // An allowlist, so a new intervention kind cannot be alerted until somebody
  // decides its basis survives being quoted with no legend under it.
  assert.equal(ALERTABLE_KINDS.has('comments-not-collected'), false);
  assert.equal(ALERTABLE_KINDS.has('no-goal'), false);
  assert.equal(ALERTABLE_KINDS.has('wip-overload'), false);
  assert.equal(ALERTABLE_KINDS.has('sprint-overdue'), true);

  const goalless = team([issue({})], { sprints: [{ ...ACTIVE, goal: undefined }] });
  const feed = feedOf(goalless, '2026-08-27T06:00:00.000Z');
  assert.ok(feed.teams[0]!.interventions.some((i) => i.kind === 'no-goal'));
  const plan = classify({ today: feed, previous: null, state: emptyState('p'), minSeverity: 'watch', limit: 8 });
  assert.equal(plan.considered.some((a) => a.intervention.kind === 'no-goal'), false);
});

test('the alert path computes no number of its own', () => {
  // Every digit in a rendered alert body has to trace back to text the derive
  // layer produced. If this fails, something in the notify layer started doing
  // arithmetic - which is the one thing it must never do.
  const t = team([
    issue({ key: 'LOG-6405', flagged: true, updated: '2026-08-01T09:00:00.000Z' }),
    issue({ key: 'LOG-7001', assignee: undefined }),
    issue({ key: 'LOG-7002', assignee: undefined }),
    issue({ key: 'LOG-7003', assignee: undefined }),
  ]);
  const feed = feedOf(t, '2026-08-27T06:00:00.000Z');
  const plan = classify({ today: feed, previous: null, state: emptyState('p'), minSeverity: 'watch', limit: 20 });
  assert.ok(plan.send.length > 0);

  for (const a of plan.send) {
    const source = [
      a.intervention.title,
      a.intervention.what,
      a.intervention.why,
      a.intervention.action,
      a.intervention.evidence ?? '',
      ...a.caveats,
      ...a.links.map((l) => `${l.label} ${l.url}`),
    ].join(' ');
    for (const digits of alertMessage(a, 'plain').match(/\d+/g) ?? []) {
      assert.ok(source.includes(digits), `"${digits}" in the message does not appear in the derived text: ${a.intervention.title}`);
    }
  }
});

// --- the feed's clock --------------------------------------------------------

test('each day is measured against its OWN capture time, not the wall clock', () => {
  // GOTCHA being pinned: building yesterday's feed with today's clock re-ages
  // every ticket, so anything that crossed a threshold overnight appears in both
  // feeds and is then suppressed as "not news" - exactly the item that just
  // became true.
  const dir = mkdtempSync(join(tmpdir(), 'to-alert-'));
  // Idle 9.96 days at the earlier capture and 10.96 at the later one, so the
  // ten-day staleness threshold is crossed BETWEEN the two captures. Exactly
  // 10.0 on the earlier day would already be stale (the test is `>=`), which is
  // the boundary this fixture has to sit just inside.
  const idle = issue({ key: 'LOG-7483', updated: '2026-08-16T07:00:00.000Z' });
  for (const [date, capturedAt] of [
    ['2026-08-26', '2026-08-26T06:00:00.000Z'],
    ['2026-08-27', '2026-08-27T06:00:00.000Z'],
  ] as const) {
    mkdirSync(join(dir, 'acme', date), { recursive: true });
    writeFileSync(join(dir, 'acme', date, 'jira.json'), JSON.stringify(snapshot([team([idle])], capturedAt)), 'utf8');
  }

  const opts = { dataDir: dir, profileName: 'acme', staleDays: 10, window: 12 };
  const older = buildFeed({ ...opts, date: '2026-08-26' })!;
  const newer = buildFeed({ ...opts, date: '2026-08-27' })!;

  assert.equal(older.capturedAt, '2026-08-26T06:00:00.000Z');
  // 10 days idle on the 26th, 11 on the 27th: the staleness threshold is crossed
  // between the two, and only the later feed may report it.
  assert.equal(older.teams[0]!.interventions.some((i) => i.kind === 'stale'), false);
  assert.equal(newer.teams[0]!.interventions.some((i) => i.kind === 'stale'), true);

  const plan = classify({ today: newer, previous: older, state: emptyState('acme'), minSeverity: 'this-week', limit: 8 });
  assert.equal(plan.send.find((a) => a.intervention.kind === 'stale')?.status, 'new');
});

test('a day with no jira.json yields no feed rather than an empty board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'to-alert-'));
  mkdirSync(join(dir, 'acme', '2026-08-27'), { recursive: true });
  assert.equal(buildFeed({ dataDir: dir, profileName: 'acme', date: '2026-08-27', staleDays: 10, window: 12 }), null);
});

// --- Slack -------------------------------------------------------------------

test('chunkForSlack splits on line boundaries and never exceeds the budget', () => {
  const text = ['*What:* ' + 'a'.repeat(30), '*Why:* ' + 'b'.repeat(30), '*Do:* ' + 'c'.repeat(30)].join('\n');
  const chunks = chunkForSlack(text, 50);
  assert.ok(chunks.every((c) => c.length <= 50));
  // Lines are not cut mid-way when there is a boundary to use, so the mrkdwn
  // survives the split.
  assert.ok(chunks.every((c) => !c.includes('aaab')));
  assert.equal(chunks.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('chunkForSlack hard-splits a single over-long line', () => {
  // A verbatim comment quote can be one very long line, and chat.postMessage
  // rejects the whole message rather than truncating it.
  const chunks = chunkForSlack('x'.repeat(120), 50);
  assert.deepEqual(chunks.map((c) => c.length), [50, 50, 20]);
});

// --- Confluence --------------------------------------------------------------

const row = (over: Partial<Parameters<typeof buildRowHtml>[0]> = {}) =>
  buildRowHtml({
    date: '2026-08-27',
    team: 'fs',
    severity: 'act-now',
    status: 'new',
    title: 'Sprint “Vulnerabilities” ended 9 days ago and is still open',
    action: 'Close it or set a new end date.',
    basis: '',
    links: [{ label: 'PAY-3765', url: 'https://acme.atlassian.net/browse/PAY-3765' }],
    ...over,
  });

test('a second run against the same snapshot replaces the row rather than appending a copy', () => {
  const page = `<p>intro</p><table><tbody>${LOG_HEADER_ROW}${row()}</tbody></table>`;
  const merged = mergeRowsSortedBySeverityDesc(page, [row({ action: 'Updated wording.' })]);
  assert.equal((merged.match(/Vulnerabilities/g) ?? []).length, 1);
  assert.match(merged, /Updated wording/);
});

test('rows are sorted worst-first across runs and the header stays first', () => {
  const page = `<table><tbody>${LOG_HEADER_ROW}${row({ severity: 'watch', title: 'drifting' })}</tbody></table>`;
  const merged = mergeRowsSortedBySeverityDesc(page, [row({ severity: 'act-now', title: 'stopped' })]);
  const body = merged.slice(merged.indexOf('<tbody>'));
  assert.ok(body.indexOf('<th>') < body.indexOf('stopped'));
  assert.ok(body.indexOf('stopped') < body.indexOf('drifting'));
});

test('a page with no log table gets one instead of an error', () => {
  // The natural first step is an empty page pointed at by the profile, and
  // "your page has no <tbody>" is a poor answer to that.
  const merged = mergeRowsSortedBySeverityDesc('<p>My alert log</p>', [row()]);
  assert.match(merged, /<tbody>/);
  assert.match(merged, /Vulnerabilities/);
  assert.match(merged, /Cadence alert log/);
});

test('a row in an unrecognised shape is kept, never silently dropped', () => {
  const page = `<table><tbody>${LOG_HEADER_ROW}<tr><td>hand-written note</td></tr></tbody></table>`;
  const merged = mergeRowsSortedBySeverityDesc(page, [row()]);
  assert.match(merged, /hand-written note/);
});

// --- the sprint-overdue intervention (open item 16) ---------------------------

test('an active sprint past its own end date becomes an intervention naming that sprint', () => {
  // Board 705's real shape on 2026-08-27: sprint 5942 `Vulnerabilities` ended
  // 2026-08-17 and was still active, while the other five end 2026-08-31.
  const overdue: SprintSnapshot = { id: 5942, name: 'Vulnerabilities', state: 'active', startDate: '2026-08-03T08:00:00.000Z', endDate: '2026-08-17T08:00:00.000Z' };
  const onTime: SprintSnapshot = { id: 7003, name: 'PAY Sprint 12', state: 'active', startDate: '2026-08-17T08:00:00.000Z', endDate: '2026-08-31T08:00:00.000Z' };
  const t = team([issue({ key: 'PAY-3765', sprintIds: [5942] }), issue({ key: 'PAY-4000', sprintIds: [7003] })], {
    key: 'fs',
    boardId: 705,
    sprints: [overdue, onTime],
  });
  const found = feedOf(t, '2026-08-27T06:00:00.000Z').teams[0]!.interventions.filter((i) => i.kind === 'sprint-overdue');
  assert.equal(found.length, 1);
  assert.match(found[0]!.title, /Vulnerabilities/);
  assert.match(found[0]!.what, /2026-08-17/);
  // It must name the sprint, and say the others are not overdue: the outlook
  // panel's aggregate label is what made "9.3 days overdue" read as all six.
  assert.match(found[0]!.what, /1 other sprint on this board is also active, and it is not overdue/);
  assert.equal(found[0]!.severity, 'act-now');
});

test('a sprint that ended yesterday is not an act-now alert', () => {
  // A sprint closing at this morning's ceremony is normal. An alert that fires
  // on every sprint boundary gets muted.
  const justEnded: SprintSnapshot = { ...ACTIVE, id: 7001, endDate: '2026-08-26T08:00:00.000Z' };
  const t = team([issue({ sprintIds: [7001] })], { sprints: [justEnded] });
  const found = feedOf(t, '2026-08-27T06:00:00.000Z').teams[0]!.interventions.find((i) => i.kind === 'sprint-overdue');
  assert.equal(found?.severity, 'this-week');
});

test('sprintOutlook names which concurrent sprint supplied the end date', () => {
  const overdue: SprintSnapshot = { id: 5942, name: 'Vulnerabilities', state: 'active', startDate: '2026-08-03T08:00:00.000Z', endDate: '2026-08-17T08:00:00.000Z' };
  const onTime: SprintSnapshot = { id: 7003, name: 'PAY Sprint 12', state: 'active', startDate: '2026-08-17T08:00:00.000Z', endDate: '2026-08-31T08:00:00.000Z' };
  const t = team([issue({ key: 'PAY-3765', sprintIds: [5942] })], { key: 'fs', boardId: 705, sprints: [overdue, onTime] });
  const jira = snapshot([t], '2026-08-27T06:00:00.000Z');
  const o = sprintOutlook(t, deriveTrends(jira, 12)[0]!, new Date('2026-08-27T06:00:00.000Z'))!;
  assert.equal(o.sprintName, '2 concurrent sprints');
  assert.equal(o.endDateSprintName, 'Vulnerabilities');
});

test('a single active sprint does not repeat its own name as the end-date source', () => {
  const t = team([issue({})]);
  const jira = snapshot([t], '2026-08-27T06:00:00.000Z');
  const o = sprintOutlook(t, deriveTrends(jira, 12)[0]!, new Date('2026-08-27T06:00:00.000Z'))!;
  assert.equal(o.endDateSprintName, undefined);
});

// --- rendering ---------------------------------------------------------------

test('the CLI rendering carries no Slack escaping', () => {
  const t = team([issue({ key: 'LOG-6405', flagged: true, updated: '2026-08-01T09:00:00.000Z' })], {
    boardName: 'PAY & CSP',
  });
  const feed = feedOf(t, '2026-08-27T06:00:00.000Z');
  const plan = classify({ today: feed, previous: null, state: emptyState('p'), minSeverity: 'this-week', limit: 8 });
  const alert = plan.send[0]!;
  const plain = alertMessage(alert, 'plain');
  const slack = alertMessage(alert, 'slack');
  // The board name is the one place an ampersand reliably shows up.
  assert.match(plain, /PAY & CSP/);
  assert.match(slack, /PAY &amp; CSP/);
  assert.ok(!plain.includes('&amp;'));
  assert.ok(!plain.includes('*What:*'));
  assert.match(slack, /\*What:\*/);
});

test('a Slack link is <url|label> and a plain one is label then url', () => {
  const alert: Alert = {
    intervention: {
      id: 'x', team: 'tran', severity: 'act-now', kind: 'flagged', title: 't', what: 'w', why: 'y', action: 'a',
      issueKeys: ['LOG-6405'], weight: 1,
    },
    identity: 'tran|flagged|LOG-6405',
    status: 'new',
    caveats: [],
    links: [{ label: 'LOG-6405', url: 'https://acme.atlassian.net/browse/LOG-6405' }],
  };
  assert.match(alertMessage(alert, 'slack'), /<https:\/\/[^|]+\|LOG-6405>/);
  assert.match(alertMessage(alert, 'plain'), /LOG-6405 https:\/\//);
});
