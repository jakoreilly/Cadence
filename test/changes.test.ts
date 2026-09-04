import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countChanges, diffInterventions, type InterventionDay } from '../src/changes.js';
import { interventionIdentity, type Intervention, type InterventionSeverity } from '../src/interventions.js';

// ---------------------------------------------------------------------------
// The day-over-day comparison behind the report's "what changed" panel.
//
// The failure mode this guards is not a crash, it is a plausible lie: a panel
// that reports a fortnight-old blockage as "appeared overnight" is worse than no
// panel, because a reader who checks one of them and finds it wrong stops
// believing the rest of the page. Every test here is about a finding that did
// NOT change being reported as though it did.
// ---------------------------------------------------------------------------

function ivn(over: Partial<Intervention> = {}): Intervention {
  return {
    id: 'panther-flagged-0',
    team: 'panther',
    severity: 'this-week',
    kind: 'flagged',
    title: 'WEB-1 has been flagged for 4 days',
    what: 'WEB-1 is flagged and has not moved.',
    why: 'Somebody is stopped.',
    action: 'Ask what it is waiting for.',
    issueKeys: ['WEB-1'],
    weight: 40,
    ...over,
  };
}

const day = (date: string, interventions: Intervention[], hour = '07'): InterventionDay => ({
  date,
  capturedAt: `${date}T${hour}:00:00.000Z`,
  interventions,
});

// --- the first collected day -----------------------------------------------------

test('the first collected day reports everything as standing, never as new', () => {
  // A tool that has never seen yesterday cannot tell a finding that appeared
  // overnight from one that has been standing for a month, and "41 new
  // findings" on day one is a claim it cannot support.
  const s = diffInterventions(day('2026-08-26', [ivn(), ivn({ issueKeys: ['WEB-2'] })]), null);
  assert.equal(s.from, null);
  assert.equal(s.changes.length, 0);
  assert.equal(s.unchanged, 2);
  assert.equal(s.totalToday, 2);
  assert.equal(s.observedHours, null);
});

// --- the four kinds of change -----------------------------------------------------

test('a finding absent yesterday and present today is new', () => {
  const s = diffInterventions(
    day('2026-08-27', [ivn(), ivn({ issueKeys: ['WEB-9'] })]),
    day('2026-08-26', [ivn()]),
  );
  assert.deepEqual(s.changes.map((c) => c.kind), ['new']);
  assert.deepEqual(s.changes[0]!.intervention.issueKeys, ['WEB-9']);
  assert.equal(s.unchanged, 1);
});

test('the same finding at a higher severity is escalated, not new', () => {
  const s = diffInterventions(
    day('2026-08-27', [ivn({ severity: 'act-now' })]),
    day('2026-08-26', [ivn({ severity: 'watch' })]),
  );
  assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0]!.kind, 'escalated');
  assert.equal(s.changes[0]!.previousSeverity, 'watch');
  assert.equal(s.unchanged, 0);
});

test('the same finding at a lower severity is eased', () => {
  const s = diffInterventions(
    day('2026-08-27', [ivn({ severity: 'watch' })]),
    day('2026-08-26', [ivn({ severity: 'act-now' })]),
  );
  assert.equal(s.changes[0]!.kind, 'eased');
  assert.equal(s.changes[0]!.previousSeverity, 'act-now');
});

test('a finding present yesterday and gone today is cleared, carrying YESTERDAY\'s wording', () => {
  // There is no such finding today, so the card necessarily describes the
  // previous day - and the panel says so rather than presenting a stale
  // sentence as current.
  const yesterday = ivn({ title: 'WEB-1 has been flagged for 4 days' });
  const s = diffInterventions(day('2026-08-27', []), day('2026-08-26', [yesterday]));
  assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0]!.kind, 'cleared');
  assert.equal(s.changes[0]!.intervention.title, 'WEB-1 has been flagged for 4 days');
  assert.equal(s.changes[0]!.previousSeverity, 'this-week');
  assert.equal(s.totalToday, 0);
});

test('a finding present on both days at the same severity is counted, never listed', () => {
  const s = diffInterventions(day('2026-08-27', [ivn()]), day('2026-08-26', [ivn()]));
  assert.equal(s.changes.length, 0);
  assert.equal(s.unchanged, 1);
});

// --- identity, which is where the plausible lies come from -------------------------

test('a finding is the same finding across days even when its wording and figures move', () => {
  // The whole point: "flagged for 4 days" becomes "flagged for 5 days"
  // overnight. Same blockage, same ticket, and reporting it as news every
  // morning is how a panel gets ignored.
  const s = diffInterventions(
    day('2026-08-27', [ivn({ title: 'WEB-1 has been flagged for 5 days', weight: 50 })]),
    day('2026-08-26', [ivn({ title: 'WEB-1 has been flagged for 4 days', weight: 40 })]),
  );
  assert.equal(s.changes.length, 0);
  assert.equal(s.unchanged, 1);
});

test('a per-person finding survives its ticket list churning underneath it', () => {
  // GOTCHA, found by this panel against live data on 2026-09-02: `wip-overload`
  // is about a PERSON and used to key on its issue keys, so one ticket leaving
  // that person's in-progress list and another joining it reported the same
  // person as one finding clearing and another appearing. The key cap in
  // interventionIdentity cannot help - the churn is INSIDE the first three
  // sorted keys, not in the tail - which is why the finding sets identityKey.
  const wip = (keys: string[]): Intervention =>
    ivn({ kind: 'wip-overload', identityKey: 'Dev One', issueKeys: keys, severity: 'watch' });

  const s = diffInterventions(
    day('2026-08-27', [wip(['LOG-6405', 'LOG-7172', 'LOG-7505'])]),
    day('2026-08-26', [wip(['LOG-6405', 'LOG-7172', 'LOG-7373'])]),
  );
  assert.equal(s.changes.length, 0, 'the same person is not two findings');
  assert.equal(s.unchanged, 1);
});

test('two different people overloaded on the same board are two different findings', () => {
  // The other half of the same rule: identityKey must DISTINGUISH as well as
  // stabilise, or every overloaded person on a board collapses onto one card.
  const wip = (person: string): Intervention =>
    ivn({ kind: 'wip-overload', identityKey: person, issueKeys: ['PAY-1'], severity: 'watch' });

  const s = diffInterventions(day('2026-08-27', [wip('Dev Two')]), day('2026-08-26', [wip('Dev Three')]));
  assert.deepEqual(
    s.changes.map((c) => c.kind).sort(),
    ['cleared', 'new'],
  );
});

test('the same kind of finding on two teams never collapses onto one identity', () => {
  const a = ivn({ team: 'panther' });
  const b = ivn({ team: 'tran' });
  assert.notEqual(interventionIdentity(a), interventionIdentity(b));
  const s = diffInterventions(day('2026-08-27', [a, b]), day('2026-08-26', [a]));
  assert.deepEqual(s.changes.map((c) => c.team), ['tran']);
});

// --- the interval the comparison was made over -------------------------------------

test('the wall-clock gap between the two captures travels with the verdict', () => {
  // GOTCHA 31, and it bites hardest here: this panel's whole claim is "these
  // things changed overnight". The first two real snapshots on this estate were
  // 8.7 hours apart and every one of those hours was overnight, so "nothing
  // changed" was the correct answer to a question nobody meant to ask.
  const s = diffInterventions(day('2026-08-27', [ivn()], '06'), day('2026-08-26', [ivn()], '21'));
  assert.equal(s.observedHours, 9);
  assert.equal(s.from, '2026-08-26');
  assert.equal(s.to, '2026-08-27');
});

// --- ordering and counting ---------------------------------------------------------

test('bad news sorts above good news, loudest first, regardless of kind', () => {
  // A finding that appeared overnight at act-now and one that climbed to
  // act-now overnight are the same size of problem, so they interleave by
  // severity rather than grouping by kind.
  const mk = (severity: InterventionSeverity, keys: string[]) => ivn({ severity, issueKeys: keys });
  const s = diffInterventions(
    day('2026-08-27', [mk('watch', ['A']), mk('act-now', ['B']), mk('this-week', ['C'])]),
    day('2026-08-26', [mk('watch', ['C']), mk('watch', ['D'])]),
  );
  const kinds = s.changes.map((c) => `${c.kind}:${c.intervention.severity}`);
  assert.deepEqual(kinds, ['new:act-now', 'escalated:this-week', 'new:watch', 'cleared:watch']);
});

test('countChanges gives the headline without counting an array', () => {
  const s = diffInterventions(
    day('2026-08-27', [ivn({ issueKeys: ['A'] }), ivn({ issueKeys: ['B'], severity: 'act-now' })]),
    day('2026-08-26', [ivn({ issueKeys: ['B'], severity: 'watch' }), ivn({ issueKeys: ['C'] })]),
  );
  assert.deepEqual(countChanges(s), { new: 1, escalated: 1, eased: 0, cleared: 1 });
});
