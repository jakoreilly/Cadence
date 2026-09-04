import type { IssueSnapshot, JiraSnapshot, SprintSnapshot, TeamSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// The derive layer: pure functions from snapshots to metrics. No network, no
// AI, no model ever computes a number here.
//
// IMPORTANT CAVEAT on everything in this file that is derived from a SINGLE
// snapshot: sprint history is RECONSTRUCTED from the current state of each
// issue, not recorded as it happened. That means:
//
//   - An issue deleted, or moved to another board, since a sprint closed is
//     invisible, so old sprints can under-report.
//   - "Committed" is really "is in the sprint now". An issue added mid-sprint
//     is indistinguishable from one committed on day one.
//
// Exact commitment and scope churn need two snapshots taken while the sprint
// was open, which daily collection accumulates from here on. Anything that
// depends on that is marked `approximate` in the output so it is never read as
// exact.
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile, the same definition Excel's PERCENTILE and
 *  numpy's default use, so numbers reconcile with a spreadsheet. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (rank - lo);
}

export function median(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** Chronological sprint order.
 *
 *  startDate first, id as the tie-break: a sprint that was created but never
 *  started has no startDate at all, and sorting those to the end by id keeps
 *  the sequence stable instead of throwing them to the front. */
export function sprintsInOrder(sprints: SprintSnapshot[]): SprintSnapshot[] {
  return [...sprints].sort((a, b) => {
    const as = a.startDate ?? '';
    const bs = b.startDate ?? '';
    if (as && bs && as !== bs) return as.localeCompare(bs);
    if (as && !bs) return -1;
    if (!as && bs) return 1;
    return a.id - b.id;
  });
}

/** The window a sprint's work counts against. completeDate is when the sprint
 *  was actually closed, which is frequently NOT endDate - teams close late.
 *  Using endDate alone attributes work done in the overrun to nothing. */
export function sprintWindow(sprint: SprintSnapshot): { start: string; end: string } | null {
  const start = sprint.startDate;
  const end = sprint.completeDate ?? sprint.endDate;
  if (!start || !end) return null;
  return { start, end };
}

export function completedInSprint(issue: IssueSnapshot, window: { start: string; end: string }): boolean {
  if (!issue.resolutionDate) return false;
  // String comparison is safe here: both sides are ISO 8601 with an explicit
  // offset, and Date.parse round-trips them identically. Compared as numbers to
  // avoid any offset-format mismatch between "+01:00" and "Z".
  const r = Date.parse(issue.resolutionDate);
  const s = Date.parse(window.start);
  const e = Date.parse(window.end);
  if (!Number.isFinite(r) || !Number.isFinite(s) || !Number.isFinite(e)) return false;
  return r >= s && r <= e;
}

/** Created -> resolved, in days.
 *
 *  This is LEAD time, not cycle time, and the distinction matters: it includes
 *  however long the issue sat in the backlog before anyone touched it. On board
 *  701 that pushes the p90 past 500 days for sprints that pulled in old backlog
 *  items - a real fact about the backlog, but not a statement about how fast the
 *  team works.
 *
 *  True cycle time needs the moment work STARTED, which a single snapshot does
 *  not carry: `statusCategoryChangedAt` only records the most recent category
 *  change. It becomes available either from the issue changelog
 *  (expand=changelog, heavy) or from consecutive daily snapshots, which is the
 *  cheaper route and accumulates from now on. */
export function leadTimeDays(issue: IssueSnapshot): number | null {
  if (!issue.resolutionDate) return null;
  const created = Date.parse(issue.created);
  const resolved = Date.parse(issue.resolutionDate);
  if (!Number.isFinite(created) || !Number.isFinite(resolved)) return null;
  const days = (resolved - created) / 86_400_000;
  return days >= 0 ? days : null;
}

export interface SprintMetrics {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  /** Days between the planned end date and when the sprint was actually closed,
   *  or null if either date is missing.
   *
   *  Deliberately a NUMBER, not a boolean. Every one of board 701's 89 closed
   *  sprints has completeDate after endDate, because a team closes a sprint
   *  manually at standup rather than at the instant it expires - so a boolean
   *  reports 100% "late" and carries no information. Only a slip of more than a
   *  day or so means anything. */
  daysLate: number | null;
  goal?: string;
  /** "Is in this sprint now", which for a CLOSED sprint is badly overstated:
   *  an issue that has been in 16 sprints counts as committed in all 16. Board
   *  701 shows sprints with 123 "committed" that completed 11. Treat this as
   *  unusable for closed sprints until consecutive snapshots exist; the
   *  completed* figures below are anchored to resolutionDate inside the sprint
   *  window and ARE sound. */
  committedIssues: number;
  committedPoints: number;
  completedIssues: number;
  completedPoints: number;
  /** Committed issues with no estimate in either point field. Points-based
   *  figures for this sprint are understated by however much these were worth. */
  unestimatedCommitted: number;
  /** Issues in this sprint that also appear in a later one. Inherits the
   *  overstatement of committedIssues - same caveat. */
  carriedOut: number;
  leadTimeDaysP50: number | null;
  leadTimeDaysP90: number | null;
  /** Completed issue counts by issue type - the feature/bug/debt split. */
  completedByType: Record<string, number>;
}

/** Issues indexed by the sprints they appear in.
 *
 *  One pass over the board instead of one pass PER SPRINT. The naive form -
 *  `team.issues.filter((i) => i.sprintIds.includes(sprint.id))` inside the
 *  per-sprint loop - is quadratic in a way that bites on exactly the boards
 *  this tool exists for: board 701 has 89 closed sprints and board 704 carries
 *  8,556 issues, so the filter form walks three quarters of a million issues
 *  (each with an inner `includes` over up to 16 sprint ids) to produce what a
 *  single grouping pass already has. `sprintMetrics` runs per team on every
 *  `trends`, `report` and `alert` invocation, and `alert` builds two feeds.
 *
 *  Generic in the issue shape because `sprintIds` is all it reads, and the
 *  history layer works on a narrower projection of an issue than IssueSnapshot
 *  (see historyProjection in history.ts) while needing exactly this index. */
export function issuesBySprint<T extends { sprintIds: number[] }>(issues: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const issue of issues) {
    for (const id of issue.sprintIds) {
      const list = out.get(id);
      if (list) list.push(issue);
      else out.set(id, [issue]);
    }
  }
  return out;
}

export function sprintMetrics(team: TeamSnapshot): SprintMetrics[] {
  const ordered = sprintsInOrder(team.sprints);
  const positionById = new Map<number, number>();
  ordered.forEach((s, i) => positionById.set(s.id, i));
  const bySprint = issuesBySprint(team.issues);

  return ordered.map((sprint, index) => {
    const window = sprintWindow(sprint);
    const committed = bySprint.get(sprint.id) ?? [];
    const completed = window ? committed.filter((i) => completedInSprint(i, window)) : [];

    const leadTimes = completed
      .map(leadTimeDays)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);

    const completedByType: Record<string, number> = {};
    for (const i of completed) completedByType[i.issueType] = (completedByType[i.issueType] ?? 0) + 1;

    // Carried out of this sprint: the issue is also in a sprint that comes
    // LATER in chronological order. Comparing positions rather than ids matters
    // because sprint ids are creation order, and a sprint created earlier can
    // be scheduled later.
    const carriedOut = committed.filter((i) =>
      i.sprintIds.some((sid) => {
        const pos = positionById.get(sid);
        return pos !== undefined && pos > index;
      }),
    ).length;

    const sum = (xs: IssueSnapshot[]) => xs.reduce((acc, i) => acc + (i.storyPoints ?? 0), 0);

    return {
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      completeDate: sprint.completeDate,
      daysLate:
        sprint.completeDate && sprint.endDate
          ? (Date.parse(sprint.completeDate) - Date.parse(sprint.endDate)) / 86_400_000
          : null,
      goal: sprint.goal,
      committedIssues: committed.length,
      committedPoints: sum(committed),
      completedIssues: completed.length,
      completedPoints: sum(completed),
      unestimatedCommitted: committed.filter((i) => i.storyPoints === null).length,
      carriedOut,
      leadTimeDaysP50: percentile(leadTimes, 0.5),
      leadTimeDaysP90: percentile(leadTimes, 0.9),
      completedByType,
    };
  });
}

export interface Forecast {
  /** Sprints the forecast is calibrated on, most recent last. */
  basis: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** p90 - p10 over p50. High relative spread means the median is a poor
   *  planning number regardless of how good it looks. */
  relativeSpread: number | null;
}

/** Empirical forecast: the team's own recent history, not a target.
 *
 *  Only CLOSED sprints are used - an active sprint's completed total is
 *  partial by definition and would drag the whole band down. */
export function forecast(metrics: SprintMetrics[], window: number, pick: (m: SprintMetrics) => number): Forecast {
  const closed = metrics.filter((m) => m.state === 'closed');
  // Zero-output sprints are dropped: on a long-lived board they are almost
  // always sprints that were created and abandoned, or predate the team's use
  // of estimates, and including them makes the p10 meaningless.
  const values = closed
    .slice(-window)
    .map(pick)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const p10 = percentile(values, 0.1);
  const p50 = percentile(values, 0.5);
  const p90 = percentile(values, 0.9);
  return {
    basis: values.length,
    p10,
    p50,
    p90,
    relativeSpread: p50 && p10 !== null && p90 !== null && p50 > 0 ? (p90 - p10) / p50 : null,
  };
}

export interface TeamTrends {
  team: string;
  boardId: number;
  boardName?: string;
  /** Set when this team's numbers are reconstructed from one snapshot rather
   *  than observed across several. */
  approximate: boolean;
  sprints: SprintMetrics[];
  pointsForecast: Forecast;
  issuesForecast: Forecast;
  /** Median share of a sprint's committed issues that were carried out of it,
   *  across the forecast window. */
  carryoverRateMedian: number | null;
}

export function teamTrends(team: TeamSnapshot, window: number): TeamTrends {
  const metrics = sprintMetrics(team);
  const closed = metrics.filter((m) => m.state === 'closed').slice(-window);
  const rates = closed.filter((m) => m.committedIssues > 0).map((m) => m.carriedOut / m.committedIssues);

  return {
    team: team.key,
    boardId: team.boardId,
    boardName: team.boardName,
    approximate: true,
    sprints: metrics,
    pointsForecast: forecast(metrics, window, (m) => m.completedPoints),
    issuesForecast: forecast(metrics, window, (m) => m.completedIssues),
    carryoverRateMedian: median(rates),
  };
}

/** Closed sprints the forecast looks back over, and the same window the
 *  changelog scope uses. About six months at a two-week cadence.
 *
 *  Shared rather than repeated as a literal because a changelog window narrower
 *  than the forecast window would put two panels on one page disagreeing about
 *  how much history exists. */
export const DEFAULT_SPRINT_WINDOW = 12;

export function deriveTrends(snapshot: JiraSnapshot, window: number): TeamTrends[] {
  return snapshot.teams.map((t) => teamTrends(t, window));
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

const n1 = (v: number | null) => (v === null ? '   -' : v.toFixed(1).padStart(4));


const TRUSTWORTHINESS = [
  '  TRUSTWORTHINESS',
  '    SOUND      "done" and "pts". Anchored to each issue resolutionDate falling inside that sprint',
  '               window, so they are independent of current board state. The forecast uses only these.',
  '    WEAK       "lead50/lead90" are CREATED -> resolved, so they include backlog dwell time. That is',
  '               lead time, not cycle time. Cycle time needs work-start, which arrives once there are',
  '               consecutive daily snapshots.',
  '    UNUSABLE   "cmtd" and "carry" for CLOSED sprints. They count every issue in that sprint NOW, so an',
  '               issue that has passed through 16 sprints counts as committed in all 16 - hence sprints',
  '               showing 123 committed against 11 completed. Real commitment and scope churn need a',
  '               snapshot taken while the sprint was open; daily collection produces those from now on.',
  '               For the ACTIVE sprint both figures are accurate today.',
  '    Issues deleted or moved off the board since a sprint closed are invisible throughout.',
];

export function formatTrends(trends: TeamTrends[], recent: number): string {
  const out: string[] = [];
  for (const t of trends) {
    out.push('');
    out.push(`${t.team}  ${t.boardName ?? ''} (#${t.boardId})`);

    const closed = t.sprints.filter((s) => s.state === 'closed');
    const shown = closed.slice(-recent);
    out.push('');
    out.push(`  last ${shown.length} closed sprints of ${closed.length}   (* = reconstructed, see note)`);
    out.push('  sprint                          done   pts  lead50  lead90   late*  cmtd*  carry*');
    for (const s of shown) {
      out.push(
        `  ${s.name.slice(0, 30).padEnd(30)} ${String(s.completedIssues).padStart(4)} ` +
          `${String(s.completedPoints).padStart(5)}  ${n1(s.leadTimeDaysP50)}   ${n1(s.leadTimeDaysP90)}  ` +
          `${n1(s.daysLate)}  ${String(s.committedIssues).padStart(5)}  ${String(s.carriedOut).padStart(6)}`,
      );
    }

    const pf = t.pointsForecast;
    const inf = t.issuesForecast;
    out.push('');
    out.push(`  empirical forecast, from this team own last ${Math.max(pf.basis, inf.basis)} productive closed sprints:`);
    out.push(`    points completed   p10 ${n1(pf.p10)}   p50 ${n1(pf.p50)}   p90 ${n1(pf.p90)}   basis ${pf.basis} sprints`);
    out.push(`    issues completed   p10 ${n1(inf.p10)}   p50 ${n1(inf.p50)}   p90 ${n1(inf.p90)}   basis ${inf.basis} sprints`);
    if (pf.relativeSpread !== null) {
      const pct = Math.round(pf.relativeSpread * 100);
      out.push(
        `    spread             ${pct}% of the median` +
          (pf.relativeSpread > 1 ? '  <- wider than the median itself; plan on the p10, not the p50' : ''),
      );
    }
    if (t.carryoverRateMedian !== null) {
      out.push(`    carryover rate     ${Math.round(t.carryoverRateMedian * 100)}% of committed issues (median, unusable - see note)`);
    }

    const active = t.sprints.find((s) => s.state === 'active');
    if (active) {
      out.push('');
      out.push(`  active: ${active.name}`);
      out.push(
        `    ${active.committedIssues} issues in the sprint (${active.committedPoints} pts), ` +
          `${active.unestimatedCommitted} unestimated, ${active.completedIssues} resolved so far`,
      );
      if (pf.p90 !== null && active.committedPoints > pf.p90) {
        out.push(
          `    ${active.committedPoints} pts is above the p90 of ${pf.p90.toFixed(1)} - a total this team has not ` +
            `delivered in the last ${pf.basis} sprints`,
        );
      }
    }

    out.push('');
    out.push(...TRUSTWORTHINESS);
  }
  return out.join('\n');
}
