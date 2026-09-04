import { isDone } from './quality.js';
// The blocker-phrase list lives in ONE place - interventions.ts owns it - so the
// attention table and the intervention feed can never disagree about whether a
// ticket sounds blocked in its comments.
import { blockerInComments } from './interventions.js';
import { humanAuthored, hadHumanReview } from './review.js';
import { percentile } from './derive.js';
import type { TeamTrends } from './derive.js';
import type { IssueSnapshot, MergeRequestSnapshot, SprintSnapshot, TeamSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// The insights layer: "where do I step in, and where do I step back".
//
// Everything here is a pure function of a snapshot. No AI, no network, no
// model computes a number - same rule as derive.ts and review.ts.
//
// ONE DELIBERATE OMISSION, and it is the most important design decision in
// this file: there is NO per-person productivity ranking, and story points are
// never divided by a person. Not because the data is missing - assignee is on
// every issue - but because the number would not survive being questioned:
//
//   - Estimation culture differs wildly by board. Board 705 leaves 97% of its
//     active sprint unestimated and board 702's p50 is 51 points against board
//     701's 28. "Points delivered" compares estimating habits, not people.
//   - Points measure the ESTIMATE, not the difficulty, the value, or the mess
//     that had to be cleaned up on the way.
//   - The person who spends a day unblocking two colleagues scores zero.
//
// What IS here instead is per-person PRACTICE: who merges their own work with
// nobody looking at it, and who reviews other people's. Both are facts about
// habits that training can change, both are stated as counts with their
// denominators, and neither ranks anyone as better or worse at their job.
// See docs/decisions.md.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function daysSince(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / DAY : null;
}

// --- 1. Work that needs help -------------------------------------------------

export type AttentionReason =
  | 'blocked'
  | 'blocked-by'
  | 'commented-blocked'
  | 'overdue'
  | 'carried'
  | 'stale'
  | 'unestimated'
  | 'unassigned';

export interface AttentionItem {
  key: string;
  /** The ticket TITLE. Schema 4; undefined on an older snapshot, where the UI
   *  falls back to the key. Without it every row in this table is an opaque
   *  identifier and the reader has to open Jira to learn what any of it is. */
  summary?: string;
  /** Bounded description excerpt, for the hover card. */
  description?: string;
  summaryType: string;
  status: string;
  /** Epic this sits under, so a reader can see that four "unrelated" blocked
   *  tickets are all one initiative. */
  epicKey?: string;
  epicName?: string;
  /** Open items this one is blocked by. */
  blockedBy?: string[];
  /** Days past the due date, when there is one and it has passed. */
  overdueDays?: number;
  /** The most recent comment, for the hover card and the blocker scan. */
  latestComment?: { author?: string; created: string; body: string };
  /** Comments in the thread, where the collector read them. */
  commentCount?: number;
  assignee?: string;
  /** Sprints this issue has appeared in. */
  sprintCount: number;
  ageDays: number | null;
  /** Days since anything changed on it. */
  idleDays: number | null;
  storyPoints: number | null;
  reasons: AttentionReason[];
  /** Higher is more urgent. Ordering only - never shown as a score, because a
   *  made-up number presented to management invites a debate about the number
   *  instead of about the work. */
  weight: number;
}

export interface AttentionOptions {
  now: Date;
  staleDays: number;
}


/** Open work in the active sprint that a manager could actually do something
 *  about, worst first.
 *
 *  Deliberately ITEM-shaped, not person-shaped. Every row is a ticket with a
 *  reason attached; the assignee is shown so the manager knows who to talk to,
 *  which is a different thing from measuring that person. */
export function attentionItems(team: TeamSnapshot, opts: AttentionOptions): AttentionItem[] {
  const active = team.sprints.filter((s) => s.state === 'active');
  const activeIds = new Set(active.map((s) => s.id));
  const open = team.issues.filter((i) => i.sprintIds.some((id) => activeIds.has(id)) && !isDone(i));

  // Hoisted: rebuilding this inside the loop is O(issues x open) and board 704
  // carries 8,556 issues.
  const openKeys = new Set(team.issues.filter((x) => !isDone(x)).map((x) => x.key));

  const items: AttentionItem[] = [];
  for (const i of open) {
    const reasons: AttentionReason[] = [];
    const idle = daysSince(i.updated, opts.now);
    const blockedByOpen = (i.blockedBy ?? []).filter((k) => openKeys.has(k));
    const signal = i.flagged ? null : blockerInComments(i.comments);
    const overdue = i.dueDate ? -(daysSince(i.dueDate, opts.now) ?? 0) : null;
    const overdueDays = overdue !== null && overdue < 0 ? -overdue : null;

    if (i.flagged) reasons.push('blocked');
    if (blockedByOpen.length > 0) reasons.push('blocked-by');
    if (signal) reasons.push('commented-blocked');
    if (overdueDays !== null) reasons.push('overdue');
    if (i.sprintIds.length >= 3) reasons.push('carried');
    if (i.statusCategory === 'In Progress' && idle !== null && idle >= opts.staleDays) reasons.push('stale');
    if (i.storyPoints === null) reasons.push('unestimated');
    if (!i.assignee) reasons.push('unassigned');
    if (reasons.length === 0) continue;

    // Weighting: an explicit block is the strongest signal because somebody
    // already said so out loud. Carryover scales with how many sprints it has
    // survived - the item in 16 sprints is a different problem from the one in
    // its third.
    let weight = 0;
    if (reasons.includes('blocked')) weight += 100;
    // A link-graph block and a blocker written in a comment are both "somebody
    // is stopped" without anybody having remembered to set the flag, so they
    // sit just under an explicit flag rather than down with the hygiene
    // reasons. An overdue date is scaled by how far past it is: one day late is
    // a nudge, three weeks late is a conversation somebody outside the team is
    // already having.
    if (reasons.includes('blocked-by')) weight += 70;
    if (reasons.includes('commented-blocked')) weight += 60;
    if (reasons.includes('overdue')) weight += Math.min(90, 10 + (overdueDays ?? 0) * 3);
    if (reasons.includes('carried')) weight += 10 * i.sprintIds.length;
    if (reasons.includes('stale')) weight += Math.min(60, idle ?? 0);
    if (reasons.includes('unassigned')) weight += 15;
    if (reasons.includes('unestimated')) weight += 5;

    const latest = i.comments && i.comments.length > 0 ? i.comments[0]! : undefined;
    items.push({
      key: i.key,
      summary: i.summary,
      description: i.description,
      summaryType: i.issueType,
      status: i.status,
      epicKey: i.epicKey,
      epicName: i.epicName,
      blockedBy: blockedByOpen.length > 0 ? blockedByOpen : undefined,
      overdueDays: overdueDays ?? undefined,
      latestComment: latest
        ? { author: latest.author?.displayName, created: latest.created, body: latest.body }
        : undefined,
      commentCount: i.commentCount,
      assignee: i.assignee?.displayName,
      sprintCount: i.sprintIds.length,
      ageDays: daysSince(i.created, opts.now),
      idleDays: idle,
      storyPoints: i.storyPoints,
      reasons,
      weight,
    });
  }

  return items.sort((a, b) => b.weight - a.weight || b.sprintCount - a.sprintCount || a.key.localeCompare(b.key));
}

// --- 2. Review practice, per person -----------------------------------------

export interface PersonPractice {
  name: string;
  /** Merge requests this person opened, in the window. */
  authored: number;
  /** ...that merged with no human comment and no human approval. The training
   *  signal: work that went in with nobody else looking at it. */
  mergedUnreviewed: number;
  /** ...that merged at all, and whose review detail was readable. Denominator
   *  for mergedUnreviewed. */
  mergedKnown: number;
  /** Distinct merge requests by OTHER people this person commented on or
   *  approved. The counterpart signal - who is already doing the right thing. */
  reviewsGiven: number;
}

export interface PracticeSummary {
  people: PersonPractice[];
  /** True when a merge request recorded human comments but no commenter
   *  identities - a pre-schema-3 snapshot, or one collected with
   *  individualAttribution off. reviewsGiven is then unknown, NOT zero.
   *
   *  A team where nobody commented on anything is NOT unknown: it is a team with
   *  zero reviews, which is the finding. */
  reviewerIdentitiesUnknown: boolean;
}

/** Who merges their own work unreviewed, and who reviews other people's.
 *
 *  Both sides are reported together on purpose. "Merged without review" alone
 *  reads as a list of offenders; beside "reviews given" it reads as what it
 *  actually is - a picture of who has picked up the team's review habit and who
 *  has not been shown it yet.
 *
 *  Bot-authored merge requests are excluded throughout, for the reason in
 *  review.ts: they are dependency bumps nobody was ever meant to read. */
export function practiceByPerson(mrs: MergeRequestSnapshot[]): PracticeSummary {
  const human = humanAuthored(mrs);
  const by = new Map<string, PersonPractice>();
  const get = (name: string): PersonPractice => {
    let p = by.get(name);
    if (!p) {
      p = { name, authored: 0, mergedUnreviewed: 0, mergedKnown: 0, reviewsGiven: 0 };
      by.set(name, p);
    }
    return p;
  };

  // GOTCHA: "unknown" here means the identities are MISSING FROM THE DATA, and
  // that is not the same as nobody having reviewed anything. A schema-3 snapshot
  // of a team that merges everything unreviewed legitimately has zero commenters
  // - and that team is exactly the one this table exists to surface. Reporting
  // it as "?" hides the finding and tells the reader to re-run `collect`, which
  // would change nothing. The two cases ARE distinguishable: a merge request
  // that recorded human COMMENTS but carries no commenter identities is a
  // schema-2 snapshot (or one collected with individualAttribution off); a merge
  // request with no human comments at all is simply unreviewed.
  let identitiesMissing = false;

  for (const mr of human) {
    const authorName = mr.author?.displayName;
    if (authorName) {
      const p = get(authorName);
      p.authored++;
      // Once, not twice. `hadHumanReview` is a three-state answer and calling it
      // again to distinguish false from null re-derives the same thing.
      const reviewed = hadHumanReview(mr);
      if (mr.state === 'merged' && reviewed !== null) {
        p.mergedKnown++;
        if (reviewed === false) p.mergedUnreviewed++;
      }
    }

    // Credit for reviewing: commenters and approvers, deduped per merge
    // request so one person is not counted twice for commenting AND approving
    // the same change.
    const commenters = mr.review?.humanCommenters ?? [];
    if ((mr.review?.humanCommentCount ?? 0) > 0 && commenters.length === 0) identitiesMissing = true;

    const reviewers = new Set<string>();
    for (const c of commenters) {
      if (c.displayName && c.displayName !== authorName) reviewers.add(c.displayName);
    }
    for (const a of mr.review?.humanApprovals ?? []) {
      if (a.displayName && a.displayName !== authorName) reviewers.add(a.displayName);
    }
    for (const name of reviewers) get(name).reviewsGiven++;
  }

  const people = [...by.values()].sort(
    (a, b) => b.authored - a.authored || b.reviewsGiven - a.reviewsGiven || a.name.localeCompare(b.name),
  );
  return { people, reviewerIdentitiesUnknown: identitiesMissing };
}

// --- 3. Will the active sprint land? ----------------------------------------

export type OutlookVerdict = 'on-track' | 'at-risk' | 'will-not-land' | 'unknown';

export interface SprintOutlook {
  verdict: OutlookVerdict;
  sprintName: string;
  endDate?: string;
  /** Which active sprint the `endDate` came from, when there is more than one.
   *  Undefined for a single active sprint, where `sprintName` already says it. */
  endDateSprintName?: string;
  daysRemaining: number | null;
  daysElapsed: number | null;
  /** Fraction of the sprint's calendar that has passed, 0..1. */
  elapsedFraction: number | null;
  committedPoints: number;
  donePoints: number;
  remainingPoints: number;
  /** Points per day this team has historically delivered, from its own p50 over
   *  the forecast window and the median sprint length. */
  historicalPointsPerDay: number | null;
  /** What the remaining work needs, points per day, to land on time. */
  requiredPointsPerDay: number | null;
  /** requiredPointsPerDay / historicalPointsPerDay. Above 1 means the sprint
   *  needs the team to go faster than it ever normally does. */
  paceRatio: number | null;
  /** Set when estimate coverage is too thin for any of this to mean anything. */
  unreliableReason?: string;
}

const MIN_ESTIMATE_COVERAGE = 2 / 3;

/** Is the active sprint going to land, on this team's own historical pace?
 *
 *  GOTCHA: this compares REMAINING points against the team's own p50 velocity
 *  spread over the sprint's calendar, not against a target. It reports
 *  "unknown" rather than a verdict whenever the sprint is mostly unestimated -
 *  board 705 has 149 of 154 active issues with no estimate, and a confident
 *  "on track" derived from the five that do have one would be worse than
 *  saying nothing. Same rule as loadVerdict in report.ts. */
export function sprintOutlook(team: TeamSnapshot, trends: TeamTrends, now: Date): SprintOutlook | null {
  const active = team.sprints.filter((s) => s.state === 'active');
  if (active.length === 0) return null;

  // With several concurrent active sprints the team is one unit of delivery, so
  // they are assessed together and the end date is the earliest one - that is
  // the first promise that comes due.
  const activeIds = new Set(active.map((s) => s.id));
  const inSprint = team.issues.filter((i) => i.sprintIds.some((id) => activeIds.has(id)));
  const ends = active.map((s) => s.endDate).filter((d): d is string => Boolean(d)).sort();
  const starts = active.map((s) => s.startDate).filter((d): d is string => Boolean(d)).sort();
  const endDate = ends[0];
  const startDate = starts[0];
  // GOTCHA: with concurrent active sprints the earliest end date belongs to ONE
  // of them, and the panel prints it beside the aggregate name "6 concurrent
  // sprints" - so a reader concludes all six are overdue when one is. Board 705
  // is exactly this shape: sprint 5942 "Vulnerabilities" ended 2026-08-17 while
  // the other five end 2026-08-31. Taking the earliest is still the right basis
  // for a verdict (it is the first promise that comes due), so the fix is to
  // carry WHICH sprint supplied it rather than to change the choice.
  const endDateSprintName = endDate && active.length > 1 ? active.find((s) => s.endDate === endDate)?.name : undefined;

  const committedPoints = inSprint.reduce((a, i) => a + (i.storyPoints ?? 0), 0);
  const donePoints = inSprint.filter(isDone).reduce((a, i) => a + (i.storyPoints ?? 0), 0);
  const remainingPoints = committedPoints - donePoints;

  const daysRemaining = endDate ? -(daysSince(endDate, now) ?? 0) : null;
  const daysElapsed = startDate ? daysSince(startDate, now) : null;
  const totalDays =
    startDate && endDate ? (Date.parse(endDate) - Date.parse(startDate)) / DAY : null;
  const elapsedFraction =
    daysElapsed !== null && totalDays !== null && totalDays > 0
      ? Math.max(0, Math.min(1, daysElapsed / totalDays))
      : null;

  const sprintName = active.length === 1 ? active[0]!.name : `${active.length} concurrent sprints`;

  const unestimated = inSprint.filter((i) => i.storyPoints === null).length;
  const coverage = inSprint.length > 0 ? (inSprint.length - unestimated) / inSprint.length : 0;

  const base: SprintOutlook = {
    verdict: 'unknown',
    sprintName,
    endDate,
    endDateSprintName,
    daysRemaining,
    daysElapsed,
    elapsedFraction,
    committedPoints,
    donePoints,
    remainingPoints,
    historicalPointsPerDay: null,
    requiredPointsPerDay: null,
    paceRatio: null,
  };

  if (coverage < MIN_ESTIMATE_COVERAGE) {
    return {
      ...base,
      unreliableReason: `${Math.round((1 - coverage) * 100)}% of this sprint carries no estimate, so remaining points are not a measure of remaining work.`,
    };
  }

  const p50 = trends.pointsForecast.p50;
  const sprintLength = medianSprintLengthDays(team.sprints) ?? totalDays;
  if (p50 === null || !sprintLength || sprintLength <= 0 || daysRemaining === null) return base;

  const historicalPointsPerDay = p50 / sprintLength;
  if (remainingPoints <= 0) {
    return { ...base, historicalPointsPerDay, requiredPointsPerDay: 0, paceRatio: 0, verdict: 'on-track' };
  }
  // A sprint already past its end date needs the rest delivered immediately;
  // dividing by a negative or zero day count would produce a nonsense pace.
  const effectiveDays = Math.max(daysRemaining, 0.5);
  const requiredPointsPerDay = remainingPoints / effectiveDays;
  const paceRatio = historicalPointsPerDay > 0 ? requiredPointsPerDay / historicalPointsPerDay : null;

  let verdict: OutlookVerdict = 'unknown';
  if (paceRatio !== null) {
    // 1.0 = exactly this team's normal pace. Landing needs normal pace or
    // better, so anything meaningfully above 1 is at risk and well above it is
    // not going to happen.
    if (paceRatio <= 1) verdict = 'on-track';
    else if (paceRatio <= 1.75) verdict = 'at-risk';
    else verdict = 'will-not-land';
  }

  return { ...base, historicalPointsPerDay, requiredPointsPerDay, paceRatio, verdict };
}

/** Median length of the team's closed sprints, in days. Uses the actual
 *  completeDate, so a team that habitually runs long is measured on what it
 *  really does rather than on the nominal two weeks. */
export function medianSprintLengthDays(sprints: SprintSnapshot[]): number | null {
  const lengths = sprints
    .filter((s) => s.state === 'closed' && s.startDate && (s.completeDate ?? s.endDate))
    .map((s) => (Date.parse(s.completeDate ?? s.endDate!) - Date.parse(s.startDate!)) / DAY)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  return percentile(lengths, 0.5);
}

// --- 4. Team health, for "where can I step back" ----------------------------

export type HealthTone = 'good' | 'watch' | 'poor' | 'unknown';

export interface HealthSignal {
  label: string;
  tone: HealthTone;
  value: string;
  /** Why this reading, in one line the manager can repeat in a meeting. */
  detail: string;
}

export interface TeamHealth {
  signals: HealthSignal[];
  /** Count of 'poor' signals - the sort key for "who needs me most". */
  poorCount: number;
  watchCount: number;
  /** Overall, derived from the signals rather than from a weighted score, so it
   *  can always be explained by pointing at a row. */
  headline: HealthTone;
}

export interface HealthInput {
  /** Share of merged human-authored MRs with no human review, 0..1. */
  unreviewedRate: number | null;
  /** Share of open active-sprint issues carried 3+ sprints, 0..1. */
  carryoverRate: number | null;
  /** Share of active-sprint issues with no estimate, 0..1. */
  unestimatedRate: number | null;
  /** p90-p10 over p50 on completed points. */
  relativeSpread: number | null;
  outlook: SprintOutlook | null;
}

/** A small, explainable scorecard. Deliberately NOT a single 0-100 number: a
 *  composite score invites an argument about the weighting instead of about the
 *  work, and cannot be acted on. Every signal names its own threshold. */
export function teamHealth(input: HealthInput): TeamHealth {
  const signals: HealthSignal[] = [];
  const rate = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

  signals.push(
    band('Code review', input.unreviewedRate, 0.2, 0.4, rate(input.unreviewedRate), {
      good: 'Most merged work gets a second pair of eyes.',
      watch: 'A noticeable share of merged work had nobody else look at it.',
      poor: 'Most merged work went in with no human review - the biggest single training gap here.',
      unknown: 'No GitLab group is mapped to this team, so review practice is unmeasured.',
    }),
  );

  signals.push(
    band('Carryover', input.carryoverRate, 0.25, 0.5, rate(input.carryoverRate), {
      good: 'Work started in a sprint mostly finishes in it.',
      watch: 'A quarter or more of open work has already survived three sprints.',
      poor: 'Half or more of open work has been carried three sprints or more - items are too big or too vague.',
      unknown: 'No active sprint to measure.',
    }),
  );

  signals.push(
    band('Estimation', input.unestimatedRate, 0.2, 0.34, rate(input.unestimatedRate), {
      good: 'The sprint is estimated well enough to forecast.',
      watch: 'Enough of the sprint is unestimated to blur the forecast.',
      poor: 'Most of the sprint carries no estimate, so nothing here can be forecast or compared.',
      unknown: 'No active sprint to measure.',
    }),
  );

  signals.push(
    band('Predictability', input.relativeSpread, 1, 2, input.relativeSpread === null ? '—' : `${Math.round(input.relativeSpread * 100)}%`, {
      good: 'Output sprint to sprint is consistent enough to plan on the median.',
      watch: 'The p10-p90 band is wider than the median - plan on the p10.',
      poor: 'Output swings by more than twice the median. The median is not a planning number for this team.',
      unknown: 'Not enough closed sprints to measure.',
    }),
  );

  const o = input.outlook;
  signals.push({
    label: 'This sprint',
    tone: o === null || o.verdict === 'unknown' ? 'unknown' : o.verdict === 'on-track' ? 'good' : o.verdict === 'at-risk' ? 'watch' : 'poor',
    value:
      o === null
        ? '—'
        : o.verdict === 'unknown'
          ? 'unknown'
          : o.verdict === 'on-track'
            ? 'on track'
            : o.verdict === 'at-risk'
              ? 'at risk'
              : 'will not land',
    detail:
      o === null
        ? 'No active sprint.'
        : o.unreliableReason
          ? o.unreliableReason
          : o.paceRatio === null
            ? 'Not enough history to project.'
            : o.paceRatio <= 1
              ? `Remaining work needs ${o.requiredPointsPerDay?.toFixed(1)} pts/day; this team normally does ${o.historicalPointsPerDay?.toFixed(1)}.`
              : `Remaining work needs ${o.requiredPointsPerDay?.toFixed(1)} pts/day - ${o.paceRatio.toFixed(1)}x this team's normal ${o.historicalPointsPerDay?.toFixed(1)} pts/day.`,
  });

  const poorCount = signals.filter((s) => s.tone === 'poor').length;
  const watchCount = signals.filter((s) => s.tone === 'watch').length;
  const known = signals.filter((s) => s.tone !== 'unknown').length;
  const headline: HealthTone =
    known === 0 ? 'unknown' : poorCount >= 2 ? 'poor' : poorCount === 1 || watchCount >= 2 ? 'watch' : 'good';

  return { signals, poorCount, watchCount, headline };
}

/** Lower is better for every input here, so one helper covers them all. */
function band(
  label: string,
  value: number | null,
  goodBelow: number,
  poorAbove: number,
  display: string,
  detail: { good: string; watch: string; poor: string; unknown: string },
): HealthSignal {
  if (value === null) return { label, tone: 'unknown', value: display, detail: detail.unknown };
  const tone: HealthTone = value < goodBelow ? 'good' : value >= poorAbove ? 'poor' : 'watch';
  return { label, tone, value: display, detail: detail[tone] };
}

// --- 5. Slowest delivered work, for the retrospective ------------------------

export interface SlowItem {
  key: string;
  issueType: string;
  assignee?: string;
  leadTimeDays: number;
  sprintCount: number;
  resolutionDate?: string;
}

/** Longest lead times among work RESOLVED recently.
 *
 *  WEAK, and labelled as such wherever it is shown: lead time here is
 *  created -> resolved, which includes however long the item sat in the backlog
 *  before anyone picked it up. It is a fair question to ask about a backlog and
 *  a bad one to ask about a person, so this is presented as "what took longest
 *  to get through the system", never as a per-person duration. */
export function slowestResolved(team: TeamSnapshot, opts: { now: Date; withinDays: number; limit: number }): SlowItem[] {
  const cutoff = opts.now.getTime() - opts.withinDays * DAY;
  return team.issues
    .filter((i) => i.resolutionDate && Date.parse(i.resolutionDate) >= cutoff)
    .map((i: IssueSnapshot) => {
      const lead = (Date.parse(i.resolutionDate!) - Date.parse(i.created)) / DAY;
      return {
        key: i.key,
        issueType: i.issueType,
        assignee: i.assignee?.displayName,
        leadTimeDays: lead,
        sprintCount: i.sprintIds.length,
        resolutionDate: i.resolutionDate,
      };
    })
    .filter((i) => Number.isFinite(i.leadTimeDays) && i.leadTimeDays >= 0)
    .sort((a, b) => b.leadTimeDays - a.leadTimeDays)
    .slice(0, opts.limit);
}
