import { interventionIdentity, type Intervention, type InterventionSeverity } from './interventions.js';

// ---------------------------------------------------------------------------
// What changed between the two most recent collected days.
//
// The report is a picture of today. Every panel in it answers "what is true
// now", and a reader who opens it every morning has no way to tell the six
// findings that have been standing for a fortnight from the one that appeared
// overnight - which is precisely the one that is still cheap to act on.
//
// The alerting path already answers this question, and answers it well: it
// diffs today's derived feed against the previous collected day's, each
// computed against its OWN capture time (see notify/feed.ts). But it answers it
// in order to decide what to SEND, behind an allowlist of kinds, a severity
// floor and a per-run cap, and it writes the answer to a Slack channel that -
// on this profile, deliberately - is switched off. So the answer exists and
// never reaches the page.
//
// This module is that same comparison with none of the sending decisions
// attached: no allowlist, no floor, no cap, no state file. The report has room
// for a legend, which is the only reason the alert path needs an allowlist at
// all.
//
// Same rules as everywhere else: a pure function of two days, no I/O, and it
// computes no figure that is not already in an intervention the derive layer
// produced.
// ---------------------------------------------------------------------------

export type ChangeKind =
  /** Absent from the previous collected day: it became true since. */
  | 'new'
  /** Present on both days, at a higher severity today. */
  | 'escalated'
  /** Present on both days, at a lower severity today. */
  | 'eased'
  /** Present on the previous day and gone today. */
  | 'cleared';

export interface FeedChange {
  kind: ChangeKind;
  identity: string;
  team: string;
  /** The finding itself.
   *
   *  For `cleared` this is the PREVIOUS day's intervention, because there is no
   *  such finding today - that is what cleared means. Its wording, its ticket
   *  keys and its figures therefore describe yesterday, and the panel says so
   *  rather than presenting a stale sentence as current. */
  intervention: Intervention;
  /** What this finding's severity was on the previous day, where it existed. */
  previousSeverity?: InterventionSeverity;
}

export interface ChangeSummary {
  /** The collected date this summary is FOR. */
  to: string;
  capturedTo: string;
  /** The collected date it was compared against, or null on the first collected
   *  day - reported as such, never silently treated as "everything is new". */
  from: string | null;
  capturedFrom: string | null;
  /** Wall-clock hours between the two CAPTURES, not the difference between the
   *  two dates.
   *
   *  GOTCHA, the same one TeamHistory.observedHours carries and for a sharper
   *  reason here: this panel's whole claim is "these things changed overnight".
   *  The first two real snapshots on this estate were 8.7 hours apart and every
   *  one of those hours was overnight, so "nothing changed" was the correct
   *  answer to a question nobody meant to ask. The interval has to travel with
   *  the verdict. */
  observedHours: number | null;
  changes: FeedChange[];
  /** Findings present on both days at the same severity. Counted, never listed:
   *  they are the rest of the report. */
  unchanged: number;
  /** Every finding on the board today, whatever became of it. The denominator
   *  for "3 of 41 changed". */
  totalToday: number;
}

/** One collected day's findings, as this comparison consumes them.
 *
 *  A narrow shape rather than notify/feed.ts's `Feed` on purpose: the report
 *  must not have to import the alerting layer to describe its own page, and the
 *  comparison genuinely needs three fields. A real `Feed`, flattened across its
 *  teams, satisfies this structurally. */
export interface InterventionDay {
  date: string;
  capturedAt: string;
  interventions: Intervention[];
}

const SEVERITY_RANK: Record<InterventionSeverity, number> = { 'act-now': 3, 'this-week': 2, watch: 1 };

/** Bad news first, and within it the loudest first.
 *
 *  `new` and `escalated` are interleaved rather than grouped, because a finding
 *  that appeared overnight at `act-now` and one that climbed to `act-now`
 *  overnight are the same size of problem and separating them by kind would put
 *  a new `watch` above an escalated `act-now`. Good news - eased and cleared -
 *  sorts below all of it: it is worth showing and it is not worth leading with. */
const KIND_RANK: Record<ChangeKind, number> = { escalated: 0, new: 0, eased: 1, cleared: 1 };

/** What changed between two collected days.
 *
 *  Both sides must be built the SAME WAY - in particular with the same per-kind
 *  cap - or this reports noise. notify/feed.ts records the measured version of
 *  that mistake: comparing against a capped feed made an item look new the
 *  moment something above it dropped out, and WEB-360, twenty-two days idle and
 *  unchanged for weeks, surfaced as "new since the last snapshot". The caller
 *  owns that, because the caller builds both days.
 *
 *  With `previous` null - the first collected day - every finding today is
 *  reported as unchanged rather than as new. A tool that has never seen
 *  yesterday cannot tell the difference between a finding that appeared
 *  overnight and one that has been standing for a month, and saying "41 new
 *  findings" on day one would be a claim it cannot support. */
export function diffInterventions(today: InterventionDay, previous: InterventionDay | null): ChangeSummary {
  const totalToday = today.interventions.length;

  const observedHours =
    previous !== null
      ? (() => {
          const a = Date.parse(previous.capturedAt);
          const b = Date.parse(today.capturedAt);
          return Number.isFinite(a) && Number.isFinite(b) ? Math.round(((b - a) / 3_600_000) * 10) / 10 : null;
        })()
      : null;

  const base: ChangeSummary = {
    to: today.date,
    capturedTo: today.capturedAt,
    from: previous?.date ?? null,
    capturedFrom: previous?.capturedAt ?? null,
    observedHours,
    changes: [],
    unchanged: totalToday,
    totalToday,
  };

  if (previous === null) return base;

  // Severity is kept, not just presence: "present yesterday" and "present
  // yesterday at the same severity" are different facts, and only the second
  // one means nothing changed.
  const before = new Map<string, Intervention>();
  for (const i of previous.interventions) before.set(interventionIdentity(i), i);

  const changes: FeedChange[] = [];
  const seenToday = new Set<string>();
  let unchanged = 0;

  for (const i of today.interventions) {
    const identity = interventionIdentity(i);
    seenToday.add(identity);
    const was = before.get(identity);
    if (!was) {
      changes.push({ kind: 'new', identity, team: i.team, intervention: i });
    } else if (SEVERITY_RANK[i.severity] > SEVERITY_RANK[was.severity]) {
      changes.push({ kind: 'escalated', identity, team: i.team, intervention: i, previousSeverity: was.severity });
    } else if (SEVERITY_RANK[i.severity] < SEVERITY_RANK[was.severity]) {
      changes.push({ kind: 'eased', identity, team: i.team, intervention: i, previousSeverity: was.severity });
    } else {
      unchanged++;
    }
  }

  for (const [identity, was] of before) {
    if (seenToday.has(identity)) continue;
    changes.push({ kind: 'cleared', identity, team: was.team, intervention: was, previousSeverity: was.severity });
  }

  changes.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      SEVERITY_RANK[b.intervention.severity] - SEVERITY_RANK[a.intervention.severity] ||
      b.intervention.weight - a.intervention.weight ||
      a.identity.localeCompare(b.identity),
  );

  return { ...base, changes, unchanged };
}

/** How many of each kind, for a headline that does not require counting an array. */
export function countChanges(s: ChangeSummary): Record<ChangeKind, number> {
  const out: Record<ChangeKind, number> = { new: 0, escalated: 0, eased: 0, cleared: 0 };
  for (const c of s.changes) out[c.kind]++;
  return out;
}
