import { percentile } from './derive.js';
import type { GitLabSnapshot, MergeRequestSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Review metrics: the only LEADING indicator in this tool.
//
// Everything derived from the Jira snapshot describes a sprint that has already
// happened. Review latency describes work in flight - a merge request sitting
// unreviewed today is a delivery problem this week, not next quarter.
//
// Unlike the sprint metrics in derive.ts, these are NOT reconstructed. A note's
// created_at and a merge request's merged_at are immutable historical facts that
// were true when they were written and cannot be restated by later board
// activity. That is why the trustworthiness labelling here differs from
// trends: the core latency figures are SOUND from a single snapshot.
//
// THE DENOMINATOR IS THE WHOLE ARGUMENT. See humanAuthored below.
// ---------------------------------------------------------------------------

const HOURS = 3_600_000;

function hoursBetween(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const h = (b - a) / HOURS;
  return h >= 0 ? h : null;
}

/** Merge requests a person actually opened.
 *
 *  GOTCHA, and the single most important line in this file. Measured live on
 *  gitlab.example.com over a 30-day window: 460 merge requests merged, 248 of
 *  them with no human review - 54%. That number is worthless, because 221 of
 *  those 248 were OPENED BY THE AUTOMATED ACCOUNT: dependency bumps and
 *  mechanical analyser fixes that no one ever intended a person to read.
 *
 *  Over merge requests a person opened, the same measurement is 27 of 225 - 12%.
 *  12% is a statement about the team's review discipline. 54% is a statement
 *  about how much of the pipeline is robots, dressed up as one about the team,
 *  and it is exactly the sort of figure that collapses the first time senior
 *  management asks what is in it.
 *
 *  So: every rate below is over human-authored merge requests. The automated
 *  ones are counted and reported separately, never mixed in. */
export function humanAuthored(mrs: MergeRequestSnapshot[]): MergeRequestSnapshot[] {
  return mrs.filter((m) => m.review?.authorIsAutomation !== true);
}

/** Did a person - not the automated reviewer, not the author - engage with this
 *  merge request at all?
 *
 *  A comment OR an approval counts. Approval alone is a thin review, but it is
 *  a person taking responsibility, and treating it as nothing would overstate
 *  the problem. Assigned reviewers deliberately do NOT count: assignment is an
 *  intention, not an act.
 *
 *  Returns null for UNKNOWN - a snapshot collected without review detail, or a
 *  merge request whose notes could not be read. Never conflate that with false:
 *  counting unknowns as unreviewed inflates precisely the headline number. */
export function hadHumanReview(mr: MergeRequestSnapshot): boolean | null {
  const r = mr.review;
  if (!r) return null;
  // Counts, not the Person arrays: those are empty by design when
  // individualAttribution is off, and reading them here would make a privacy
  // setting silently report that nothing is ever reviewed.
  if (r.error && r.humanCommentCount === 0 && r.humanApprovalCount === 0) return null;
  return r.humanCommentCount > 0 || r.humanApprovalCount > 0;
}

/** An approval timestamp only where the approval STILL STANDS.
 *
 *  GOTCHA: the two halves come from different places and they disagree.
 *  `humanApprovalCount` is counted from the approvals endpoint, which reports
 *  approvals that are live NOW; `firstHumanApprovalAt` is read off the system
 *  notes, which keep "approved this merge request" forever - a push that resets
 *  approvals, or an approval a person removed, leaves the note behind. Confirmed
 *  live on the 2026-08-28 snapshot: payments-core/csp/android/mobile-app!76 carries an
 *  approval note from 2026-08-06 and zero current human approvals and zero human
 *  comments, so the same merge request was listed as awaiting its first human
 *  review AND contributed a 24.6-hour observation to `fs`'s human-review latency.
 *  A figure that argues with itself on the same page does not survive being
 *  questioned, which is the whole standard here - so the count, which is what
 *  every other rate keys on, decides. */
export function standingHumanApprovalAt(mr: MergeRequestSnapshot): string | undefined {
  const r = mr.review;
  if (!r || r.humanApprovalCount <= 0) return undefined;
  return r.firstHumanApprovalAt;
}

/** When a person first engaged, whichever came first - comment or approval. */
export function firstHumanTouchAt(mr: MergeRequestSnapshot): string | undefined {
  const r = mr.review;
  if (!r) return undefined;
  const candidates = [r.firstHumanCommentAt, standingHumanApprovalAt(mr)].filter((v): v is string => Boolean(v));
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}

export interface ReviewMetrics {
  team: string;
  groups: string[];

  /** Everything in the window, automation included. Context only - no rate uses
   *  this as a denominator. */
  totalMergeRequests: number;
  /** Opened by a configured bot account. Reported so the gap between this and
   *  totalMergeRequests is visible rather than silently discarded. */
  automationAuthored: number;

  // Everything below is over HUMAN-AUTHORED merge requests only.
  humanAuthoredTotal: number;
  merged: number;
  open: number;
  closedUnmerged: number;
  draft: number;

  /** Human-authored merge requests whose review detail was collected and read.
   *  A snapshot taken with --no-review-detail reports 0 here, and every rate
   *  below then reads as "unknown" rather than as a confident zero. */
  reviewDetailKnown: number;

  humanReviewed: number;
  automatedReviewed: number;
  mergedKnown: number;
  /** Merged with no human comment and no human approval. The headline. */
  mergedWithoutHumanReview: number;
  /** Merged with no reviewer assigned either - no human involvement of any kind
   *  beyond the author. */
  mergedWithNoHumanInvolvement: number;

  /** Hours from opening to the first human comment or approval, over the merge
   *  requests that GOT one. Answers "when a person reviews, how quickly" - not
   *  "how quickly is work reviewed". Quote it with its basis. */
  hoursToFirstHumanReviewP50: number | null;
  hoursToFirstHumanReviewP90: number | null;
  hoursToFirstHumanReviewBasis: number;

  hoursToFirstAutomatedReviewP50: number | null;
  hoursToFirstAutomatedReviewBasis: number;

  hoursOpenToMergeP50: number | null;
  hoursOpenToMergeP90: number | null;
  hoursOpenToMergeBasis: number;

  /** Hours from the first HUMAN approval to the merge, over merged merge
   *  requests that got one.
   *
   *  A different question from review latency, and the one that separates two
   *  very different problems that look identical in the headline rate: work that
   *  waits for a reviewer, and work that a reviewer has already signed off but
   *  that then sits unmerged. The first is a review-capacity problem; the second
   *  is a process or permissions problem, and no amount of reviewer training
   *  fixes it. */
  hoursApprovalToMergeP50: number | null;
  hoursApprovalToMergeP90: number | null;
  hoursApprovalToMergeBasis: number;

  /** Merged merge requests whose only human approval landed AFTER the merge.
   *
   *  Not a rounding error and not a clock-skew artefact: it is somebody
   *  approving a change that is already in, which records as review having
   *  happened while the merge itself was unreviewed. Counted separately so it
   *  cannot quietly improve the headline. */
  approvedAfterMerge: number;

  /** Open now, opened by a person, not draft, with no human review yet. The
   *  actionable list - everything else here is history. */
  awaitingFirstHumanReview: Array<{ title: string; webUrl: string; openHours: number; projectPath?: string }>;

  /** The distribution behind hoursToFirstHumanReviewP50/P90, bucketed here
   *  rather than in the browser.
   *
   *  Why it exists: a median of 4 hours is the same number whether a team
   *  reviews everything within a working day or reviews half of it in twenty
   *  minutes and the other half in a fortnight, and those are opposite
   *  findings. The percentiles cannot separate them and a shape can.
   *
   *  Bucketed SERVER-SIDE on purpose. Nothing on the page may compute a figure
   *  the CLI did not (see report/index.ts), and the raw per-merge-request
   *  timestamps a browser would need to bucket are not in the report input and
   *  would grow the file to carry. Counts only, then. */
  latencyBuckets: LatencyBucket[];
  /** Human-authored merge requests whose review detail was read and that got NO
   *  human review at all. It is not a bucket - there is no latency to place -
   *  and it is by far the most important bar on the chart, so it travels
   *  separately and is drawn separately rather than being folded into the last
   *  bucket where it would read as "reviewed, eventually". */
  neverHumanReviewed: number;

  /** Merge requests carrying a Jira key matching a collected project.
   *
   *  Whether this works is a property of the GROUP, not of the instance: 19 of
   *  79 in web-storefront, 0 of 332 in logistics-hub. A low number here is
   *  a finding about branch-naming discipline, not a bug. */
  withIssueKey: number;
}

/** One bar of the review-latency distribution. */
export interface LatencyBucket {
  /** Ready to print on an axis. */
  label: string;
  /** Inclusive lower bound in hours. */
  fromHours: number;
  /** Exclusive upper bound, null on the open-ended final bucket. */
  toHours: number | null;
  count: number;
}

/** The bucket edges, in hours.
 *
 *  Not uniform, and deliberately: review latency is log-distributed
 *  everywhere - the interesting distinctions are "within the hour" vs "same
 *  day" vs "next day" vs "the following week", and uniform 24-hour buckets put
 *  every one of those in the first bar. The boundaries are working-time
 *  landmarks rather than round numbers, because "it waited over a weekend" is
 *  a thing a manager can act on and "it waited 71 hours" is not.
 *
 *  Each edge is the INCLUSIVE lower bound of its bucket; the last is
 *  open-ended. */
const LATENCY_EDGES: Array<{ from: number; label: string }> = [
  { from: 0, label: '<1h' },
  { from: 1, label: '1–4h' },
  { from: 4, label: '4–8h' },
  { from: 8, label: '8–24h' },
  { from: 24, label: '1–2d' },
  { from: 48, label: '2–5d' },
  { from: 120, label: '5d+' },
];

/** Place a sorted list of hour values into LATENCY_EDGES.
 *
 *  Exported for the test suite and for anything else that wants the same
 *  boundaries: two definitions of "same day" is one too many. */
export function latencyHistogram(hours: number[]): LatencyBucket[] {
  const buckets: LatencyBucket[] = LATENCY_EDGES.map((e, i) => ({
    label: e.label,
    fromHours: e.from,
    toHours: LATENCY_EDGES[i + 1]?.from ?? null,
    count: 0,
  }));
  for (const h of hours) {
    if (!Number.isFinite(h) || h < 0) continue;
    // Walked from the top so the open-ended final bucket needs no special case.
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (h >= buckets[i]!.fromHours) {
        buckets[i]!.count++;
        break;
      }
    }
  }
  return buckets;
}

export function reviewMetrics(
  team: { key: string; groups: string[]; mergeRequests: MergeRequestSnapshot[] },
  capturedAt: string,
): ReviewMetrics {
  const all = team.mergeRequests;
  const mrs = humanAuthored(all);

  const known = mrs.filter((m) => hadHumanReview(m) !== null);
  const merged = mrs.filter((m) => m.state === 'merged');
  const mergedKnown = merged.filter((m) => hadHumanReview(m) !== null);

  const firstHumanHours = known
    .map((m) => hoursBetween(m.createdAt, firstHumanTouchAt(m)))
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);

  const firstBotHours = known
    .map((m) => hoursBetween(m.createdAt, m.review?.firstAutomatedCommentAt))
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);

  const mergeHours = merged
    .map((m) => hoursBetween(m.createdAt, m.mergedAt))
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);

  // GOTCHA: hoursBetween returns null for a NEGATIVE interval, so an approval
  // recorded after the merge drops out of the percentile basis rather than
  // pulling the median down with a negative number. That is correct for the
  // latency figure and wrong to leave silent, so the same merge requests are
  // counted explicitly below.
  // Same rule as firstHumanTouchAt: an approval note whose approval no longer
  // stands is not sign-off, so it cannot supply an approval-to-merge lag either.
  const approvedMerged = merged.filter((m) => Boolean(standingHumanApprovalAt(m)) && Boolean(m.mergedAt));
  const approvalToMergeHours = approvedMerged
    .map((m) => hoursBetween(standingHumanApprovalAt(m), m.mergedAt))
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);
  const approvedAfterMerge = approvedMerged.filter((m) => {
    const approved = Date.parse(standingHumanApprovalAt(m)!);
    const mergedAt = Date.parse(m.mergedAt!);
    return Number.isFinite(approved) && Number.isFinite(mergedAt) && approved > mergedAt;
  }).length;

  const open = mrs.filter((m) => m.state === 'opened');
  const awaiting = open
    .filter((m) => hadHumanReview(m) === false && !m.draft)
    .map((m) => ({
      title: m.title,
      webUrl: m.webUrl,
      projectPath: m.projectPath,
      openHours: hoursBetween(m.createdAt, capturedAt) ?? 0,
    }))
    .sort((a, b) => b.openHours - a.openHours);

  return {
    team: team.key,
    groups: team.groups,
    totalMergeRequests: all.length,
    automationAuthored: all.length - mrs.length,
    humanAuthoredTotal: mrs.length,
    merged: merged.length,
    open: open.length,
    closedUnmerged: mrs.filter((m) => m.state === 'closed').length,
    draft: mrs.filter((m) => m.draft).length,
    reviewDetailKnown: known.length,
    humanReviewed: known.filter((m) => hadHumanReview(m) === true).length,
    automatedReviewed: known.filter(
      (m) => (m.review?.automatedCommentCount ?? 0) > 0 || (m.review?.automatedApprovalCount ?? 0) > 0,
    ).length,
    mergedKnown: mergedKnown.length,
    mergedWithoutHumanReview: mergedKnown.filter((m) => hadHumanReview(m) === false).length,
    mergedWithNoHumanInvolvement: mergedKnown.filter(
      (m) => hadHumanReview(m) === false && (m.review?.reviewerCount ?? 0) === 0,
    ).length,
    hoursToFirstHumanReviewP50: percentile(firstHumanHours, 0.5),
    hoursToFirstHumanReviewP90: percentile(firstHumanHours, 0.9),
    hoursToFirstHumanReviewBasis: firstHumanHours.length,
    hoursToFirstAutomatedReviewP50: percentile(firstBotHours, 0.5),
    hoursToFirstAutomatedReviewBasis: firstBotHours.length,
    hoursOpenToMergeP50: percentile(mergeHours, 0.5),
    hoursOpenToMergeP90: percentile(mergeHours, 0.9),
    hoursOpenToMergeBasis: mergeHours.length,
    hoursApprovalToMergeP50: percentile(approvalToMergeHours, 0.5),
    hoursApprovalToMergeP90: percentile(approvalToMergeHours, 0.9),
    hoursApprovalToMergeBasis: approvalToMergeHours.length,
    approvedAfterMerge,
    awaitingFirstHumanReview: awaiting,
    latencyBuckets: latencyHistogram(firstHumanHours),
    // Over `known` rather than `mergedKnown`: the headline unreviewed rate is
    // deliberately about MERGED work, because unreviewed-and-merged is the
    // thing that already happened. This bar sits beside a latency distribution
    // built from every merge request whose detail was read, so its denominator
    // has to be that same set or the chart is two populations in one frame.
    neverHumanReviewed: known.filter((m) => hadHumanReview(m) === false).length,
    withIssueKey: mrs.filter((m) => m.issueKeys.length > 0).length,
  };
}

export function deriveReview(snapshot: GitLabSnapshot): ReviewMetrics[] {
  return snapshot.teams.map((t) => reviewMetrics(t, snapshot.capturedAt));
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

const h1 = (v: number | null) =>
  v === null ? '    -' : v < 10 ? v.toFixed(1).padStart(5) : Math.round(v).toString().padStart(5);
const pct = (n: number, d: number) => (d === 0 ? '   -' : `${Math.round((n / d) * 100)}%`.padStart(4));

const TRUSTWORTHINESS = [
  '  TRUSTWORTHINESS',
  '    SOUND      Every figure above. A comment timestamp and a merge timestamp are facts recorded when',
  '               they happened, so unlike the sprint metrics in "trends" nothing here is reconstructed',
  '               from current state and nothing is restated by later activity.',
  '    DENOMINATOR  Every rate is over merge requests a PERSON opened. Bot-authored ones - dependency',
  '               bumps, mechanical analyser fixes - are excluded and counted separately, because they',
  '               were never meant to be read by a person and including them roughly quadruples the',
  '               apparent unreviewed rate while saying nothing about the team.',
  '    CAVEAT     "when a person did review" is computed only over the merge requests that GOT a human',
  '               review, so it is a survivorship sample - quote it with its basis, never alone. The',
  '               unreviewed share is the number that matters, and it is the line above it.',
  '    CAVEAT     The window selects on UPDATED, not opened, so a merge request opened long ago and',
  '               touched yesterday is included with its full age.',
  '    UNUSABLE   Jira correlation. Branch and title text on this instance carries no issue keys, so',
  '               per-issue and per-sprint attribution is not available - these numbers are scoped to',
  '               the configured GitLab GROUPS, not to a Jira board.',
];

export function formatReview(metrics: ReviewMetrics[], listLimit: number): string {
  const out: string[] = [];
  for (const m of metrics) {
    out.push('');
    out.push(`${m.team}   groups: ${m.groups.join(', ') || '(none)'}`);
    out.push('');
    out.push(
      `  ${m.totalMergeRequests} merge requests in the window, of which ${m.automationAuthored} were opened by ` +
        `automation and are excluded below.`,
    );
    out.push(
      `  ${m.humanAuthoredTotal} opened by a person - ` +
        `${m.merged} merged, ${m.open} open, ${m.closedUnmerged} closed unmerged, ${m.draft} draft`,
    );

    if (m.reviewDetailKnown === 0) {
      out.push('');
      out.push('  No review detail in this snapshot. Re-collect without --no-review-detail.');
      continue;
    }
    if (m.reviewDetailKnown < m.humanAuthoredTotal) {
      out.push(
        `  review detail readable for ${m.reviewDetailKnown} of ${m.humanAuthoredTotal}; ` +
          `the rest count as UNKNOWN, not as unreviewed`,
      );
    }

    out.push('');
    out.push('  HUMAN REVIEW  (of merge requests a person opened)');
    out.push(
      `    reviewed by a person          ${String(m.humanReviewed).padStart(4)} of ${m.reviewDetailKnown}   ${pct(m.humanReviewed, m.reviewDetailKnown)}`,
    );
    out.push(
      `    merged with NO human review   ${String(m.mergedWithoutHumanReview).padStart(4)} of ${m.mergedKnown}   ${pct(m.mergedWithoutHumanReview, m.mergedKnown)}`,
    );
    out.push(
      `      and no reviewer assigned    ${String(m.mergedWithNoHumanInvolvement).padStart(4)} of ${m.mergedKnown}   ${pct(m.mergedWithNoHumanInvolvement, m.mergedKnown)}`,
    );

    out.push('');
    out.push('  LATENCY, hours');
    out.push(
      `    open -> first HUMAN review   p50 ${h1(m.hoursToFirstHumanReviewP50)}   p90 ${h1(m.hoursToFirstHumanReviewP90)}   ` +
        `basis ${m.hoursToFirstHumanReviewBasis} that got one`,
    );
    out.push(
      `    open -> first AUTOMATED note p50 ${h1(m.hoursToFirstAutomatedReviewP50)}               ` +
        `basis ${m.hoursToFirstAutomatedReviewBasis}`,
    );
    out.push(
      `    open -> merged               p50 ${h1(m.hoursOpenToMergeP50)}   p90 ${h1(m.hoursOpenToMergeP90)}   ` +
        `basis ${m.hoursOpenToMergeBasis} merged`,
    );
    if (m.hoursApprovalToMergeBasis > 0) {
      out.push(
        `    human approval -> merged     p50 ${h1(m.hoursApprovalToMergeP50)}   p90 ${h1(m.hoursApprovalToMergeP90)}   ` +
          `basis ${m.hoursApprovalToMergeBasis} approved`,
      );
    }
    if (m.approvedAfterMerge > 0) {
      out.push(
        `    ${m.approvedAfterMerge} merge request(s) were approved by a person AFTER they had already merged - that`,
        '    records as review having happened on a change that went in unreviewed',
      );
    }
    if (
      m.hoursToFirstHumanReviewP50 !== null &&
      m.hoursOpenToMergeP50 !== null &&
      m.hoursToFirstHumanReviewP50 > m.hoursOpenToMergeP50
    ) {
      out.push(
        '    the typical merge request merges FASTER than the typical human review arrives - review is',
        '    not on the critical path for most changes here',
      );
    }

    if (m.awaitingFirstHumanReview.length > 0) {
      out.push('');
      out.push(`  OPEN NOW, opened by a person, no human review yet (${m.awaitingFirstHumanReview.length}, oldest first)`);
      for (const mr of m.awaitingFirstHumanReview.slice(0, listLimit)) {
        const days = (mr.openHours / 24).toFixed(1);
        out.push(`    ${days.padStart(6)}d  ${(mr.projectPath ?? '').slice(-38).padEnd(38)}  ${mr.title.slice(0, 52)}`);
      }
      if (m.awaitingFirstHumanReview.length > listLimit) {
        out.push(`    ... and ${m.awaitingFirstHumanReview.length - listLimit} more`);
      }
    }

    out.push('');
    out.push(
      `  JIRA CORRELATION   ${m.withIssueKey} of ${m.humanAuthoredTotal} carry a Jira key matching a collected project`,
    );

    out.push('');
    out.push(...TRUSTWORTHINESS);
  }
  return out.join('\n');
}
