import { isDone } from './quality.js';
import { issuesBySprint, percentile } from './derive.js';
import { columnResolver } from './flow.js';
import type { SprintSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// The history layer: metrics that need TWO OR MORE snapshots, and that a single
// snapshot provably cannot give.
//
// This is the fix for the UNUSABLE label in derive.ts. Everything reconstructed
// from one snapshot answers "what does the board look like now" and then dresses
// it up as history: an issue that has passed through 16 sprints counts as
// committed in all 16, so board 701 shows sprints with 123 committed against 11
// completed. No amount of care with a single file repairs that, because the
// information was never in it.
//
// Two consecutive snapshots DO carry it. The difference between Monday's sprint
// membership and Tuesday's is scope churn, observed, not inferred. The day an
// issue first appears in an In Progress category is work-start, which is what
// separates cycle time from lead time. Remaining points per day is a real
// burndown.
//
// THE ONE HONEST LIMIT, stated wherever these numbers are shown: nothing here
// can see before the first snapshot. An issue already in progress on day one has
// no observed start, so its cycle time is unknown - NOT zero, and never silently
// clamped to the observation window, which would make every long-running item
// look fast. `observedFrom` is carried on every result for exactly this reason.
//
// Same rules as everywhere else: pure functions, no network, no AI, and no model
// computes a number.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// WHAT THIS LAYER ACTUALLY READS, and why that is a type rather than a comment.
//
// Every metric in this file is a difference between two days, so it needs EVERY
// collected day in memory at once - and a day's jira.json is ~30 MB on this
// estate. Parsed whole, that is ~56 MB of heap per day held for the life of the
// process (readSnapshot caches, deliberately - see snapshot.ts), against Node's
// ~4 GB default ceiling. Measured: 392 MB for the seven days collected so far,
// which extrapolates to ~1.6 GB at 30 days, ~4.9 GB at 90 - and `archive`'s own
// default assumes days older than 90 are still readable. So `history`, `report`
// and `alert` were on course to die of memory somewhere around day 72, on a tool
// whose entire premise is that the history cannot be backfilled once lost.
//
// The fix is that this layer reads TEN of IssueSnapshot's thirty-six fields. It
// never touches a description, a comment thread, a link graph, labels,
// components, the reporter or the creator - which is the great bulk of the
// bytes. So the shapes below declare exactly what is needed, `historyProjection`
// reduces a parsed snapshot to them, and the caller drops the full one.
//
// Declared as narrow INTERFACES rather than by projecting into IssueSnapshot on
// purpose. A projection that filled `labels: []` and `comments: undefined` would
// be a snapshot that lies: this codebase draws a hard line between "collected
// and empty" and "not collected" (see applyIssueDetail), and a shape that cannot
// express the difference must not claim to be the shape that can. TypeScript is
// structural, so a real JiraSnapshot satisfies these directly and every existing
// caller and test is unaffected.
// ---------------------------------------------------------------------------

/** The fields of an issue that the history metrics read. */
export interface HistoryIssue {
  key: string;
  issueType: string;
  status: string;
  statusId?: string;
  statusCategory: string;
  created: string;
  resolutionDate?: string;
  storyPoints: number | null;
  sprintIds: number[];
  assignee?: { displayName: string };
}

export interface HistoryTeam {
  key: string;
  sprints: SprintSnapshot[];
  columns: Array<{ name: string; statusIds: string[] }>;
  issues: HistoryIssue[];
}

export interface HistorySnapshot {
  capturedAt: string;
  teams: HistoryTeam[];
}

/** Reduces a parsed snapshot to what this file reads, so the caller can release
 *  the ~30 MB original. Copies rather than aliases the issue objects: aliasing
 *  would keep every parsed issue - and therefore its description and comment
 *  strings - reachable, which is the entire cost being avoided. */
export function historyProjection(snapshot: HistorySnapshot): HistorySnapshot {
  return {
    capturedAt: snapshot.capturedAt,
    teams: snapshot.teams.map((team) => ({
      key: team.key,
      sprints: team.sprints.map((s) => ({
        id: s.id, name: s.name, state: s.state, goal: s.goal,
        startDate: s.startDate, endDate: s.endDate, completeDate: s.completeDate,
      })),
      columns: team.columns.map((c) => ({ name: c.name, statusIds: [...c.statusIds] })),
      issues: team.issues.map((i) => ({
        key: i.key,
        issueType: i.issueType,
        status: i.status,
        statusId: i.statusId,
        statusCategory: i.statusCategory,
        created: i.created,
        resolutionDate: i.resolutionDate,
        storyPoints: i.storyPoints,
        // Copied, not aliased: a shared array pins the parent snapshot's array
        // buffer and defeats the point of projecting at all.
        sprintIds: [...i.sprintIds],
        // Only the display name is used - by toChange and cycleTimes - and it is
        // absent entirely when the profile collects without individual
        // attribution, exactly as on the full snapshot.
        assignee: i.assignee ? { displayName: i.assignee.displayName } : undefined,
      })),
    })),
  };
}

/** One day's snapshot of one team, as the history functions consume it. */
export interface DatedTeam {
  date: string;
  capturedAt: string;
  team: HistoryTeam;
}

/** Pairs each configured team with its snapshot on every collected date.
 *
 *  A team missing from a day's snapshot is SKIPPED for that day rather than
 *  treated as an empty board: `collect --team X` writes a snapshot containing
 *  one team, and reading the others as "zero issues" on that date would invent a
 *  catastrophic churn event on the following day. */
export function seriesByTeam(snapshots: Array<{ date: string; snapshot: HistorySnapshot }>): Map<string, DatedTeam[]> {
  const out = new Map<string, DatedTeam[]>();
  for (const { date, snapshot } of [...snapshots].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const team of snapshot.teams) {
      const list = out.get(team.key) ?? [];
      list.push({ date, capturedAt: snapshot.capturedAt, team });
      out.set(team.key, list);
    }
  }
  return out;
}

// --- 1. Scope churn, observed rather than inferred ---------------------------

export interface ScopeChange {
  key: string;
  issueType: string;
  storyPoints: number | null;
  assignee?: string;
}

export interface EstimateChange {
  key: string;
  from: number | null;
  to: number | null;
}

export interface SprintDelta {
  sprintId: number;
  sprintName: string;
  fromDate: string;
  toDate: string;
  /** In the sprint on toDate but not on fromDate. */
  added: ScopeChange[];
  /** In the sprint on fromDate but not on toDate - pulled out, or the issue was
   *  deleted or moved to another board, which are indistinguishable from here
   *  and are both scope leaving the sprint. */
  removed: ScopeChange[];
  /** Still in the sprint on both days, but re-estimated. Re-estimation is scope
   *  churn too: a 3 that becomes an 8 changed the commitment by 5 points without
   *  a single ticket moving, and a burndown that only counts membership misses
   *  it entirely. */
  reestimated: EstimateChange[];
  addedPoints: number;
  removedPoints: number;
  reestimatedPoints: number;
  /** Everything above as one signed number of points. */
  netPoints: number;
  /** Issues resolved between the two observations. */
  resolved: ScopeChange[];
}

const toChange = (i: HistoryIssue): ScopeChange => ({
  key: i.key,
  issueType: i.issueType,
  storyPoints: i.storyPoints,
  assignee: i.assignee?.displayName,
});

const pointsOf = (xs: Array<{ storyPoints: number | null }>) => xs.reduce((a, x) => a + (x.storyPoints ?? 0), 0);

/** What changed about one sprint between two observations.
 *
 *  This is the metric the whole daily-collection decision was made for. It is
 *  SOUND in a way nothing in derive.ts is: both sides were recorded when they
 *  were true, and no later board activity can restate either. */
export function sprintDelta(
  from: DatedTeam,
  to: DatedTeam,
  sprintId: number,
  /** Pre-built sprint indexes for the two days, when the caller already has
   *  them. `activeSprintChurn` compares every consecutive pair against every
   *  active sprint, so without this each day's board is re-scanned once per
   *  sprint per pair - board 705's six active sprints over a week of snapshots
   *  is ~700k issue visits to answer a question one grouping pass per day
   *  answers. Optional so the function stays callable, and testable, on its
   *  own. */
  index?: { from: Map<number, HistoryIssue[]>; to: Map<number, HistoryIssue[]> },
): SprintDelta | null {
  const sprint = to.team.sprints.find((s) => s.id === sprintId) ?? from.team.sprints.find((s) => s.id === sprintId);
  if (!sprint) return null;

  const fromIndex = index?.from ?? issuesBySprint(from.team.issues);
  const toIndex = index?.to ?? issuesBySprint(to.team.issues);
  const before = new Map((fromIndex.get(sprintId) ?? []).map((i) => [i.key, i]));
  const after = new Map((toIndex.get(sprintId) ?? []).map((i) => [i.key, i]));

  const added: ScopeChange[] = [];
  const removed: ScopeChange[] = [];
  const reestimated: EstimateChange[] = [];
  const resolved: ScopeChange[] = [];

  for (const [key, issue] of after) {
    const was = before.get(key);
    if (!was) {
      added.push(toChange(issue));
      continue;
    }
    if (was.storyPoints !== issue.storyPoints) {
      reestimated.push({ key, from: was.storyPoints, to: issue.storyPoints });
    }
    if (!isDone(was) && isDone(issue)) resolved.push(toChange(issue));
  }
  for (const [key, issue] of before) {
    if (!after.has(key)) removed.push(toChange(issue));
  }

  const addedPoints = pointsOf(added);
  const removedPoints = pointsOf(removed);
  const reestimatedPoints = reestimated.reduce((a, c) => a + ((c.to ?? 0) - (c.from ?? 0)), 0);

  return {
    sprintId,
    sprintName: sprint.name,
    fromDate: from.date,
    toDate: to.date,
    added: added.sort((a, b) => a.key.localeCompare(b.key)),
    removed: removed.sort((a, b) => a.key.localeCompare(b.key)),
    reestimated: reestimated.sort((a, b) => a.key.localeCompare(b.key)),
    addedPoints,
    removedPoints,
    reestimatedPoints,
    netPoints: addedPoints - removedPoints + reestimatedPoints,
    resolved: resolved.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Churn across every consecutive pair in the series, for the sprint that is
 *  active on the LAST observation. Earlier days where that sprint did not exist
 *  yet contribute nothing rather than reporting the whole sprint as "added". */
export function activeSprintChurn(series: DatedTeam[]): SprintDelta[] {
  const last = series[series.length - 1];
  if (!last) return [];
  const active = last.team.sprints.filter((s) => s.state === 'active');
  if (active.length === 0) return [];

  // One index per DAY, shared across every sprint and every pair that day takes
  // part in. Each day appears in at most two pairs, so this is one grouping pass
  // per snapshot instead of one board scan per (sprint x pair x side).
  const indexes = series.map((day) => issuesBySprint(day.team.issues));

  const deltas: SprintDelta[] = [];
  for (const sprint of active) {
    for (let i = 1; i < series.length; i++) {
      const from = series[i - 1]!;
      const to = series[i]!;
      // A sprint that had not started on `from` would report its entire contents
      // as scope added, which is true but useless - it is the sprint opening,
      // not churn. Only pairs where the sprint already existed are compared.
      const existedBefore = from.team.sprints.some((s) => s.id === sprint.id);
      if (!existedBefore) continue;
      const d = sprintDelta(from, to, sprint.id, { from: indexes[i - 1]!, to: indexes[i]! });
      if (d) deltas.push(d);
    }
  }
  return deltas;
}

export interface ChurnSummary {
  sprintId: number;
  sprintName: string;
  observedFrom: string;
  observedTo: string;
  /** Consecutive-day comparisons this is built from. One day of collection
   *  yields zero, and every figure below is then meaningless - the report shows
   *  the count rather than a confident zero. */
  observations: number;
  addedPoints: number;
  removedPoints: number;
  reestimatedPoints: number;
  netPoints: number;
  addedIssues: number;
  removedIssues: number;
  /** Total churn as a share of the sprint's committed points at the first
   *  observation. Null when that opening total was zero or unestimated. */
  churnRate: number | null;
  /** Every issue that entered the sprint after the first observation. THE list
   *  for a scope conversation - these were not in the plan. */
  lateAdditions: ScopeChange[];
}

export function summariseChurn(deltas: SprintDelta[], openingPoints: number | null): ChurnSummary | null {
  const first = deltas[0];
  const last = deltas[deltas.length - 1];
  if (!first || !last) return null;

  const seen = new Map<string, ScopeChange>();
  for (const d of deltas) for (const a of d.added) seen.set(a.key, a);
  // An issue added and then pulled out again is not a late addition that
  // survived - it is churn in both directions, already counted in the points.
  for (const d of deltas) for (const r of d.removed) seen.delete(r.key);

  const addedPoints = deltas.reduce((a, d) => a + d.addedPoints, 0);
  const removedPoints = deltas.reduce((a, d) => a + d.removedPoints, 0);
  const reestimatedPoints = deltas.reduce((a, d) => a + d.reestimatedPoints, 0);
  const churn = addedPoints + removedPoints + Math.abs(reestimatedPoints);

  return {
    sprintId: first.sprintId,
    sprintName: first.sprintName,
    observedFrom: first.fromDate,
    observedTo: last.toDate,
    observations: deltas.length,
    addedPoints,
    removedPoints,
    reestimatedPoints,
    netPoints: addedPoints - removedPoints + reestimatedPoints,
    addedIssues: deltas.reduce((a, d) => a + d.added.length, 0),
    removedIssues: deltas.reduce((a, d) => a + d.removed.length, 0),
    churnRate: openingPoints && openingPoints > 0 ? churn / openingPoints : null,
    lateAdditions: [...seen.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// --- 2. Burndown, from what was actually remaining each day ------------------

export interface BurndownPoint {
  date: string;
  committedPoints: number;
  donePoints: number;
  remainingPoints: number;
  committedIssues: number;
  remainingIssues: number;
  /** The ideal line: committed at this date, straight down to zero at endDate.
   *  Recomputed per day against the CURRENT commitment rather than drawn once
   *  from the opening total, so a sprint that took on scope shows the ideal line
   *  step UP - which is the honest picture of what was asked for. */
  idealRemaining: number | null;
}

/** Remaining points per collected day for one sprint.
 *
 *  Unlike everything in derive.ts this is not reconstructed: each point is what
 *  the board actually held on that date, recorded that day. */
export function burndown(series: DatedTeam[], sprintId: number, sprint?: SprintSnapshot): BurndownPoint[] {
  const points: BurndownPoint[] = [];
  const start = sprint?.startDate ? Date.parse(sprint.startDate) : NaN;
  const end = sprint?.endDate ? Date.parse(sprint.endDate) : NaN;

  for (const day of series) {
    const inSprint = day.team.issues.filter((i) => i.sprintIds.includes(sprintId));
    if (inSprint.length === 0 && !day.team.sprints.some((s) => s.id === sprintId)) continue;

    const committedPoints = pointsOf(inSprint);
    const donePoints = pointsOf(inSprint.filter(isDone));
    const at = Date.parse(day.capturedAt);

    let idealRemaining: number | null = null;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(at)) {
      const elapsed = Math.max(0, Math.min(1, (at - start) / (end - start)));
      idealRemaining = committedPoints * (1 - elapsed);
    }

    points.push({
      date: day.date,
      committedPoints,
      donePoints,
      remainingPoints: committedPoints - donePoints,
      committedIssues: inSprint.length,
      remainingIssues: inSprint.filter((i) => !isDone(i)).length,
      idealRemaining,
    });
  }
  return points;
}

// --- 3. True cycle time, from observed work-start ----------------------------

export interface CycleTime {
  key: string;
  issueType: string;
  assignee?: string;
  /** First date the issue was OBSERVED in an In Progress category. */
  startedOn: string;
  resolvedOn: string;
  cycleDays: number;
  /** created -> resolved, for comparison. The gap between the two is backlog
   *  dwell, and it is usually most of the lead time. */
  leadDays: number | null;
  /** True when the issue was ALREADY in progress at the first observation, so
   *  the real start is before anything was collected and cycleDays is a LOWER
   *  BOUND. Never silently dropped and never silently included as if exact. */
  startCensored: boolean;
}

const IN_PROGRESS = 'In Progress';

/** Cycle time from consecutive snapshots: first observed In Progress to
 *  resolution.
 *
 *  This is the metric leadTimeDays in derive.ts is labelled WEAK for lacking.
 *  Lead time on board 701 pushes p90 past 500 days because it counts backlog
 *  dwell; cycle time counts only the stretch someone was actually working.
 *
 *  GOTCHA: an issue in progress on the FIRST snapshot has no observed start. Its
 *  real start is somewhere before the collection began, so its cycle time can
 *  only be a lower bound - reporting it as if it began on day one would make the
 *  longest-running work in the team look like the fastest. Those rows are marked
 *  `startCensored` and are excluded from the percentiles by default. */
export function cycleTimes(series: DatedTeam[]): { items: CycleTime[]; observedFrom: string | null } {
  const first = series[0];
  if (!first) return { items: [], observedFrom: null };

  const startedOn = new Map<string, string>();
  const censored = new Set<string>();

  for (const [index, day] of series.entries()) {
    for (const issue of day.team.issues) {
      if (issue.statusCategory !== IN_PROGRESS) continue;
      if (startedOn.has(issue.key)) continue;
      startedOn.set(issue.key, day.date);
      if (index === 0) censored.add(issue.key);
    }
  }

  const last = series[series.length - 1]!;
  const items: CycleTime[] = [];
  for (const issue of last.team.issues) {
    if (!issue.resolutionDate) continue;
    const started = startedOn.get(issue.key);
    if (!started) continue;
    const resolvedAt = Date.parse(issue.resolutionDate);
    // Midnight UTC of the observation date is the earliest instant consistent
    // with "seen in progress on this date", so the resulting cycle time is the
    // longest the evidence supports rather than a flattering one.
    const startedAt = Date.parse(`${started}T00:00:00.000Z`);
    if (!Number.isFinite(resolvedAt) || !Number.isFinite(startedAt)) continue;
    const cycleDays = (resolvedAt - startedAt) / DAY;
    if (cycleDays < 0) continue;

    const created = Date.parse(issue.created);
    items.push({
      key: issue.key,
      issueType: issue.issueType,
      assignee: issue.assignee?.displayName,
      startedOn: started,
      resolvedOn: issue.resolutionDate.slice(0, 10),
      cycleDays,
      leadDays: Number.isFinite(created) ? (resolvedAt - created) / DAY : null,
      startCensored: censored.has(issue.key),
    });
  }

  return {
    items: items.sort((a, b) => b.cycleDays - a.cycleDays),
    observedFrom: first.date,
  };
}

/** One resolved item, reduced to what a distribution needs.
 *
 *  The percentiles in `CycleSummary` are two numbers and they hide the shape
 *  that produced them: a p90 of forty days over a team whose work normally
 *  takes three is TWO stuck tickets, and that is a different conversation from
 *  a team where everything takes forty. So the individual observations travel
 *  as well - bounded, and stripped to five fields rather than carrying the
 *  whole CycleTime, because this list exists to be plotted and a 4 MB report is
 *  already the size it is.
 *
 *  Censored rows are KEPT here and flagged, unlike in the percentiles, because
 *  a scatter can draw them differently (hollow) and "this one started before we
 *  were looking" is legible in a mark in a way it is not in a percentile. */
export interface CyclePoint {
  key: string;
  issueType: string;
  resolvedOn: string;
  cycleDays: number;
  /** Start unobserved - the value is a LOWER bound. Same convention as
   *  `CycleTime.startCensored`. */
  censored: boolean;
}

/** Most a single team contributes to the plot. Four boards at this cap is 1,200
 *  marks, which is a few tens of KB of JSON and more points than a 288px-high
 *  chart can separate anyway. */
const CYCLE_POINT_CAP = 300;

export interface CycleSummary {
  p50: number | null;
  p90: number | null;
  /** Uncensored observations the percentiles are computed from. */
  basis: number;
  /** Observations excluded because work began before collection started. */
  censored: number;
  observedFrom: string | null;
  /** Median backlog dwell - lead time minus cycle time - over the same items.
   *  This is the number that explains a 500-day lead time on a 3-day change. */
  medianBacklogDwellDays: number | null;
}

export function summariseCycleTimes(result: { items: CycleTime[]; observedFrom: string | null }): CycleSummary {
  const usable = result.items.filter((i) => !i.startCensored);
  const days = usable.map((i) => i.cycleDays).sort((a, b) => a - b);
  const dwell = usable
    .filter((i) => i.leadDays !== null)
    .map((i) => i.leadDays! - i.cycleDays)
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);

  return {
    p50: percentile(days, 0.5),
    p90: percentile(days, 0.9),
    basis: usable.length,
    censored: result.items.length - usable.length,
    observedFrom: result.observedFrom,
    medianBacklogDwellDays: percentile(dwell, 0.5),
  };
}

// --- 3b. Column dwell, from observed column membership -----------------------

export interface ColumnDwell {
  key: string;
  issueType: string;
  assignee?: string;
  column: string;
  /** First collected day the issue was seen sitting in ITS CURRENT column,
   *  consecutively through to the last observation. */
  sinceDate: string;
  dwellDays: number;
  /** True when the issue was already in this column at the FIRST observation,
   *  so its real entry into the column predates collection and `dwellDays` is
   *  a LOWER BOUND - same convention as CycleTime.startCensored. */
  censored: boolean;
}

/** How long every currently-open active-sprint issue has sat in its CURRENT
 *  board column, walked from what was actually observed rather than
 *  approximated from `updated` the way flow.ts's `medianIdleDays` is.
 *
 *  That approximation is the gap this closes: `updated` moves on ANY field
 *  change - a comment, a re-estimate, a relabel - not only a column move, so a
 *  ticket that has sat in `waiting test` for a fortnight reads as freshly
 *  touched the moment somebody comments on it. Column membership recorded on
 *  each collected day carries no such confusion: it is what the board actually
 *  showed that day, the same evidentiary standing as everything else in this
 *  file.
 *
 *  GOTCHA, same shape as cycleTimes: an issue already sitting in its current
 *  column at the FIRST observation has no observed entry into it, so how long
 *  it was there before collection began is unknown, not zero - `censored`,
 *  same convention as `CycleTime.startCensored`. */
export function columnDwellNow(series: DatedTeam[]): { items: ColumnDwell[]; observedFrom: string | null } {
  const first = series[0];
  if (!first) return { items: [], observedFrom: null };
  const last = series[series.length - 1]!;

  const activeIds = new Set(last.team.sprints.filter((s) => s.state === 'active').map((s) => s.id));
  const openNow = last.team.issues.filter((i) => i.sprintIds.some((id) => activeIds.has(id)) && !isDone(i));
  if (openNow.length === 0) return { items: [], observedFrom: first.date };

  // Precomputed once per day rather than re-searched per issue: board 704
  // carries 8,556 issues, and a per-issue linear scan of every day's full
  // issue list would be O(open issues x days x board issues).
  const byDay = series.map((day) => new Map(day.team.issues.map((i) => [i.key, i])));
  // Same reasoning as `byDay`: the column join is resolved through a per-board
  // status-id map built once, rather than re-walking the column configuration
  // for every issue on every day.
  const columnOf = series.map((day) => columnResolver(day.team));
  const currentColumnOf = columnResolver(last.team);

  const items: ColumnDwell[] = [];
  for (const issue of openNow) {
    const currentColumn = currentColumnOf(issue);
    let sinceDate = last.date;
    let censored = false;
    for (let idx = series.length - 2; idx >= 0; idx--) {
      const day = series[idx]!;
      const issueThen = byDay[idx]!.get(issue.key);
      if (!issueThen || columnOf[idx]!(issueThen) !== currentColumn) break;
      sinceDate = day.date;
      if (idx === 0) censored = true;
    }

    // Midnight UTC of the observed date is the earliest instant consistent
    // with "seen in this column on this date" - same convention cycleTimes
    // uses, so the two dwell figures on a page are computed the same way.
    const sinceAt = Date.parse(`${sinceDate}T00:00:00.000Z`);
    const nowAt = Date.parse(last.capturedAt);
    if (!Number.isFinite(sinceAt) || !Number.isFinite(nowAt)) continue;

    items.push({
      key: issue.key,
      issueType: issue.issueType,
      assignee: issue.assignee?.displayName,
      column: currentColumn,
      sinceDate,
      dwellDays: (nowAt - sinceAt) / DAY,
      censored,
    });
  }

  return { items: items.sort((a, b) => b.dwellDays - a.dwellDays), observedFrom: first.date };
}

export interface ColumnDwellSummary {
  column: string;
  /** Issues sitting in this column right now. */
  count: number;
  medianDwellDays: number | null;
  p90DwellDays: number | null;
  /** Uncensored observations the two figures above are computed from.
   *
   *  Carried for the same reason `CycleSummary.basis` is, and the live data made
   *  it necessary rather than tidy: on the 2026-09-01 snapshot board 701's
   *  `waiting test` column held 47 open issues of which 46 were already there on
   *  the first collected day. `percentile` over the remaining ONE returns that
   *  one issue's dwell, so the column reported a median of 3 days - a confident
   *  figure with a basis of one, sitting next to a count of 47. A median is not
   *  a median at that size, and this is the field that lets every consumer say
   *  so instead of printing it. See MIN_DWELL_BASIS. */
  basis: number;
  /** Of `count`, how many are excluded from the two figures above because
   *  their entry into the column predates the first observation. */
  censored: number;
  /** The longest-sitting issues in this column, worst first and bounded.
   *
   *  A per-column median is a fact about a queue and gives a reader nothing to
   *  DO: "waiting test has a median dwell of 9 days" cannot be acted on until
   *  somebody knows which tickets those are. Every other panel in this report
   *  pairs its figure with the tickets behind it and a route into Jira, and this
   *  is what lets the column-ageing panel do the same. Censored rows are
   *  included - they are the OLDEST things in the queue by definition, so
   *  hiding them would leave the worst cases out of the only list that names
   *  anything - and each carries its own flag so the lower-bound ones are
   *  visibly distinct. */
  oldest: ColumnDwell[];
}

/** Uncensored observations below which a per-column median is not reported as a
 *  measurement.
 *
 *  Three, and it is a stated threshold rather than a score. Two numbers have a
 *  midpoint but not a median, and one has neither - and the live shape is worse
 *  than the edge case suggests: five of the twelve columns across this estate's
 *  four boards had a basis of exactly ONE on the first snapshot that could
 *  produce this panel, because collection had only been running for six days
 *  and almost everything open had entered its column before day one. Reporting
 *  those as medians would have put four confident single-observation figures on
 *  a page whose entire premise is that its numbers survive being questioned.
 *
 *  Everything below the bar keeps its COUNT and its censored tally - the queue is
 *  real and its depth is measured - and loses only the two percentiles. Same
 *  rule as loadVerdict withholding "within band" on a thinly estimated sprint,
 *  and as sprintOutlook refusing a verdict below MIN_ESTIMATE_COVERAGE. */
export const MIN_DWELL_BASIS = 3;

/** Whether a column's dwell percentiles rest on enough observations to quote.
 *
 *  Exported so the CLI text, the HTML panel, the chart and the briefing digest
 *  all draw the line in the same place. Four copies of "is this trustworthy" is
 *  four chances for two of them to disagree on the same page. */
export function dwellIsReportable(c: ColumnDwellSummary): boolean {
  return c.medianDwellDays !== null && c.basis >= MIN_DWELL_BASIS;
}

/** Per-column ageing, worst (longest median dwell) first. */
export function summariseColumnDwell(items: ColumnDwell[], perColumnLimit = 5): ColumnDwellSummary[] {
  const byColumn = new Map<string, ColumnDwell[]>();
  for (const i of items) {
    const list = byColumn.get(i.column) ?? [];
    list.push(i);
    byColumn.set(i.column, list);
  }
  return [...byColumn.entries()]
    .map(([column, list]) => {
      const usable = list.filter((i) => !i.censored).map((i) => i.dwellDays).sort((a, b) => a - b);
      return {
        column,
        count: list.length,
        medianDwellDays: percentile(usable, 0.5),
        p90DwellDays: percentile(usable, 0.9),
        basis: usable.length,
        censored: list.length - usable.length,
        // Sorted HERE rather than relying on the caller having done it.
        //
        // GOTCHA: `columnDwellNow` does return its items worst-first, so for the
        // only caller in this codebase a bare `slice` looked correct - and this
        // function is exported and takes an arbitrary list. Given unsorted input
        // the slice returns whichever entries happen to come first, which for a
        // column holding more than `perColumnLimit` issues silently discards the
        // genuinely longest-sitting ones and then labels the survivors "Longest
        // sitting" in the report. A guarantee the doc comment makes has to be a
        // guarantee the function keeps.
        oldest: [...list].sort((a, b) => b.dwellDays - a.dwellDays).slice(0, perColumnLimit),
      };
    })
    // Reportable columns first, worst median leading; everything whose median is
    // withheld follows, deepest first.
    //
    // GOTCHA: sorting on the raw median put the LEAST trustworthy row at the top.
    // A column with one observed entry still has a non-null median - it is that
    // one ticket's dwell - and on the live snapshot board 701's `waiting test`
    // (47 open, basis 1) therefore led the table while displaying no figures at
    // all, above a column with a real median over seven observations. The row a
    // reader looks at first has to be the row that can be quoted.
    .sort((a, b) => {
      const ra = dwellIsReportable(a);
      const rb = dwellIsReportable(b);
      if (ra !== rb) return ra ? -1 : 1;
      if (ra) return (b.medianDwellDays ?? -1) - (a.medianDwellDays ?? -1);
      // Nothing measurable either side: depth is the only real fact left, and it
      // is the one that says which unmeasured queue matters most.
      return b.count - a.count || a.column.localeCompare(b.column);
    });
}

// --- 3c. Cumulative flow, from observed column membership --------------------

/** One collected day's distribution of a sprint's issues across the board. */
export interface FlowDay {
  date: string;
  capturedAt: string;
  /** Issue counts per column, in the same order and length as `columns`. */
  counts: number[];
  /** The sprint's whole issue count on that day. Equal to the sum of `counts`,
   *  carried so a reader of the JSON does not have to add up a row to get the
   *  figure the top of the band represents. */
  total: number;
}

export interface CumulativeFlow {
  sprintId: number;
  sprintName: string;
  /** The board's own columns, in BOARD order - the order the team reads left to
   *  right on their own board, which is the only order in which a flow diagram
   *  means anything. */
  columns: string[];
  days: FlowDay[];
  /** The first collected day this sprint was observed on. */
  observedFrom: string | null;
  /** True when the sprint was already running at the FIRST collected day, so the
   *  left edge of the diagram is where COLLECTION began rather than where the
   *  sprint began. Same convention as `CycleTime.startCensored` and
   *  `ColumnDwell.censored`: the shape before that edge is unknown, not flat. */
  censoredStart: boolean;
}

/** How a sprint's work was distributed across the board's columns on every
 *  collected day - the input to a cumulative flow diagram.
 *
 *  This is the panel-shaped answer to a question the rest of the history layer
 *  answers only one queue at a time. `summariseColumnDwell` says how long work
 *  is sitting in each column RIGHT NOW, and `burndown` says how much is left in
 *  total; neither shows a queue GROWING. A band that widens day over day is work
 *  arriving in a stage faster than it leaves, which is the thing a manager can
 *  act on before it becomes a missed sprint - and it is invisible in both of the
 *  existing views.
 *
 *  Counts ISSUES rather than points, deliberately. Points are the estimate and
 *  are missing on most of the work on several boards here (one board in a
 *  four-board estate left 97% of its active sprint unestimated), so a
 *  points-based flow diagram would draw the estimated minority and silently omit
 *  the rest - a band that shrinks because nobody estimated the new work reads
 *  exactly like a band that shrank because the work was done. An issue count is
 *  exact on every board.
 *
 *  Returns null when the board has no column configuration at all: there is
 *  nothing to distribute the work ACROSS, and inventing buckets out of raw
 *  status names would be the status-name logic this codebase refuses everywhere
 *  else. `no-board-columns` is already a quality finding for exactly this. */
export function cumulativeFlow(series: DatedTeam[], sprintId: number): CumulativeFlow | null {
  const last = series[series.length - 1];
  if (!last) return null;

  const sprint = last.team.sprints.find((s) => s.id === sprintId);
  if (!sprint) return null;

  // The LAST day's column configuration is the canonical one: it is the board
  // as it stands, which is the board the reader is looking at. A column added
  // or renamed mid-sprint would otherwise give two different axes on one chart.
  const columns = last.team.columns.map((c) => c.name);
  if (columns.length === 0) return null;

  // An issue whose status is not mapped to any column resolves to
  // '(not on the board)' - a real state on these boards, not an error - and it
  // has to be counted somewhere or the bands would not sum to the sprint. It is
  // appended rather than mixed into a real column, and dropped below if it
  // stayed empty, so a healthy board never sees the bucket at all.
  const OFF_BOARD = '(not on the board)';
  const axis = columns.includes(OFF_BOARD) ? [...columns] : [...columns, OFF_BOARD];
  const indexOf = new Map(axis.map((c, i) => [c, i]));

  const days: FlowDay[] = [];
  for (const day of series) {
    const inSprint = day.team.issues.filter((i) => i.sprintIds.includes(sprintId));
    // Same guard as `burndown`: a day on which this sprint did not exist is not
    // a day on which it was empty, so it is skipped rather than plotted as zero.
    if (inSprint.length === 0 && !day.team.sprints.some((s) => s.id === sprintId)) continue;

    const resolve = columnResolver(day.team);
    const counts = new Array<number>(axis.length).fill(0);
    for (const issue of inSprint) {
      // An issue sitting in a column that day which no longer exists on the
      // board today has nowhere on the axis to go, and is counted as off-board
      // rather than dropped - the total across the bands must equal the sprint.
      const idx = indexOf.get(resolve(issue)) ?? indexOf.get(OFF_BOARD)!;
      counts[idx]!++;
    }
    days.push({ date: day.date, capturedAt: day.capturedAt, counts, total: inSprint.length });
  }

  if (days.length === 0) return null;

  // Drop the off-board bucket when nothing ever landed in it.
  const offIdx = indexOf.get(OFF_BOARD)!;
  const everOff = days.some((d) => d.counts[offIdx]! > 0);
  const finalAxis = everOff ? axis : axis.filter((_, i) => i !== offIdx);
  const finalDays = everOff
    ? days
    : days.map((d) => ({ ...d, counts: d.counts.filter((_, i) => i !== offIdx) }));

  return {
    sprintId,
    sprintName: sprint.name,
    columns: finalAxis,
    days: finalDays,
    observedFrom: finalDays[0]!.date,
    // The sprint was already being observed on the very first collected day, so
    // whatever shape it had before that is not in this series.
    censoredStart: finalDays[0]!.date === series[0]!.date,
  };
}

// --- 4. Everything one team's history yields ---------------------------------

export interface TeamHistory {
  team: string;
  /** Collected dates this team appears in. Two is the minimum for anything here
   *  to mean anything; one yields a result with every field empty and
   *  `days: 1`, which the UI reports as "not yet" rather than as zero churn. */
  days: number;
  observedFrom: string | null;
  observedTo: string | null;
  /** Wall-clock hours between the first and last CAPTURE, not the difference
   *  between the two dates.
   *
   *  GOTCHA: the dates are the folder names and every metric here is a
   *  difference between two of them, so a reader naturally reads "0 points
   *  added" over two consecutive days as a quiet working day. Measured live on
   *  the first two real snapshots, it was not: the 26th was re-collected at
   *  21:20 and the 27th ran at 06:00, so the interval was 8.7 hours of which
   *  every single one was overnight, and 3 of 20,701 issues were touched. Zero
   *  churn was the CORRECT answer to a question nobody meant to ask. The hours
   *  have to travel with the figure. */
  observedHours: number | null;
  churn: ChurnSummary | null;
  burndown: BurndownPoint[];
  cycle: CycleSummary;
  slowestCycle: CycleTime[];
  /** Every resolved item's cycle time, most recently resolved first, bounded at
   *  CYCLE_POINT_CAP. This is the input to the cycle-time distribution plot;
   *  `cycle` is the same data as two percentiles. */
  cyclePoints: CyclePoint[];
  /** How many observations were dropped by the cap, so the panel can say so
   *  rather than quietly plotting a subset that reads as everything. */
  cyclePointsOmitted: number;
  /** Per-column ageing for what is open in the active sprint right now, worst
   *  first. Empty when there is no active sprint to measure - not a claim that
   *  nothing is ageing. */
  columnDwell: ColumnDwellSummary[];
  /** The active sprint's distribution across the board's columns on every
   *  collected day. Optional for the same reason the schema-4 report fields
   *  are: a caller built against the older shape still compiles, and a null is
   *  "not computed or not computable here", never "the board was empty". */
  flow?: CumulativeFlow | null;
}

export function teamHistory(series: DatedTeam[], opts: { slowestLimit?: number } = {}): TeamHistory {
  const first = series[0];
  const last = series[series.length - 1];
  const cycle = cycleTimes(series);
  const dwell = columnDwellNow(series);

  let churn: ChurnSummary | null = null;
  let burn: BurndownPoint[] = [];
  let flow: CumulativeFlow | null = null;

  if (last) {
    const active = last.team.sprints.filter((s) => s.state === 'active');
    // Several concurrent active sprints is a real shape here - board 705 has six
    // - so the churn summary covers the one with the most committed points,
    // which is the one a scope conversation would be about.
    //
    // GOTCHA: the committed total is computed ONCE PER SPRINT and then sorted,
    // rather than inside the comparator. Calling `issues.filter(...)` from a
    // comparator re-scans the whole board for BOTH operands on every
    // comparison - roughly thirty 8,556-issue scans to pick one of board 705's
    // six sprints - and the number it computes is the same every time.
    const lastBySprint = issuesBySprint(last.team.issues);
    const primary = active
      .map((sprint) => ({ sprint, points: pointsOf(lastBySprint.get(sprint.id) ?? []) }))
      .sort((a, b) => b.points - a.points)[0]?.sprint;

    if (primary) {
      const deltas = activeSprintChurn(series).filter((d) => d.sprintId === primary.id);
      const opening = series.find((d) => d.team.sprints.some((s) => s.id === primary.id));
      const openingPoints = opening
        ? pointsOf(issuesBySprint(opening.team.issues).get(primary.id) ?? [])
        : null;
      churn = summariseChurn(deltas, openingPoints);
      burn = burndown(series, primary.id, primary);
      // The SAME sprint the churn and the burndown describe. Three panels about
      // three different sprints on one team tab is how a reader ends up
      // comparing a burndown against a flow diagram of something else.
      flow = cumulativeFlow(series, primary.id);
    }
  }

  return {
    team: last?.team.key ?? first?.team.key ?? '',
    days: series.length,
    observedFrom: first?.date ?? null,
    observedTo: last?.date ?? null,
    observedHours:
      first && last && first !== last
        ? Math.round(((Date.parse(last.capturedAt) - Date.parse(first.capturedAt)) / 3_600_000) * 10) / 10
        : null,
    churn,
    burndown: burn,
    cycle: summariseCycleTimes(cycle),
    slowestCycle: cycle.items.filter((i) => !i.startCensored).slice(0, opts.slowestLimit ?? 10),
    // Ordered by RESOLUTION DATE rather than by cycle length, because the cap
    // has to cut the oldest observations rather than the fastest ones: sorting
    // by cycleDays (the order `cycle.items` arrives in) and taking the first
    // 300 would keep every slow ticket and discard every quick one, which is a
    // distribution plot of the tail drawn as if it were the whole.
    cyclePoints: [...cycle.items]
      .sort((a, b) => (a.resolvedOn < b.resolvedOn ? 1 : a.resolvedOn > b.resolvedOn ? -1 : 0))
      .slice(0, CYCLE_POINT_CAP)
      .map((i) => ({
        key: i.key,
        issueType: i.issueType,
        resolvedOn: i.resolvedOn,
        cycleDays: Math.round(i.cycleDays * 100) / 100,
        censored: i.startCensored,
      })),
    cyclePointsOmitted: Math.max(0, cycle.items.length - CYCLE_POINT_CAP),
    columnDwell: summariseColumnDwell(dwell.items),
    flow,
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

const n1 = (v: number | null) => (v === null ? '   -' : v.toFixed(1).padStart(4));

const TRUSTWORTHINESS = [
  '  TRUSTWORTHINESS',
  '    SOUND      Everything here. Each figure is the difference between two records, each written on the',
  '               day it was true, so unlike the sprint metrics in "trends" nothing is reconstructed from',
  '               current board state and no later activity can restate it. This is what the daily',
  '               collection was for.',
  '    BOUNDED    Nothing can see before the first snapshot. Work already in progress - or already sitting',
  '               in its current column - on day one has no observed start, so its cycle time or its',
  '               column dwell is a lower bound - those rows are counted separately as "censored" and kept',
  '               out of the percentiles rather than flattering them. A column left with fewer than three',
  '               observed entries reports no median at all rather than a confident figure drawn from one:',
  '               its "open" count is still exact, and only the percentiles are withheld.',
  '    NOT CHURN  A sprint that did not exist on the earlier day is skipped, not reported as scope added:',
  '               a sprint opening is not scope creep.',
];

export function formatHistory(histories: TeamHistory[]): string {
  const out: string[] = [];
  for (const h of histories) {
    out.push('');
    out.push(
      `${h.team}   observed ${h.observedFrom ?? '?'} -> ${h.observedTo ?? '?'} (${h.days} snapshot${h.days === 1 ? '' : 's'}` +
        (h.observedHours !== null ? `, ${h.observedHours}h apart` : '') +
        ')',
    );

    if (h.days < 2) {
      out.push('');
      out.push('  Only one snapshot for this team. Every metric in this command is a DIFFERENCE between two');
      out.push('  days, so there is nothing to report yet - not zero churn, nothing measured. Collect again');
      out.push('  tomorrow and this fills in.');
      continue;
    }

    // A span materially under a day has not contained a working day, so a zero
    // in it is not a quiet sprint. 20 hours is the line: the scheduled job runs
    // daily, so a normal interval is ~24h and anything much below that means
    // the two captures were not a day apart.
    if (h.observedHours !== null && h.observedHours < 20) {
      out.push('');
      out.push(`  CAUTION  These two snapshots are only ${h.observedHours} hours apart, so this is not a full`);
      out.push('           working day of activity. A zero below means "nothing changed in those hours",');
      out.push('           not "nothing changed in the sprint". Collect on consecutive mornings for a');
      out.push('           day-to-day reading.');
    }

    out.push('');
    if (h.churn) {
      const c = h.churn;
      out.push(`  SCOPE CHURN  ${c.sprintName}   ${c.observations} day-to-day comparison(s)`);
      out.push(`    added        ${String(c.addedIssues).padStart(4)} issues  ${String(c.addedPoints).padStart(5)} pts`);
      out.push(`    removed      ${String(c.removedIssues).padStart(4)} issues  ${String(c.removedPoints).padStart(5)} pts`);
      out.push(`    re-estimated ${' '.repeat(11)}${(c.reestimatedPoints >= 0 ? '+' : '') + c.reestimatedPoints} pts`);
      out.push(`    net change   ${' '.repeat(11)}${(c.netPoints >= 0 ? '+' : '') + c.netPoints} pts` +
        (c.churnRate !== null ? `   (${Math.round(c.churnRate * 100)}% of the sprint's opening total, counting both directions)` : ''));
      if (c.lateAdditions.length > 0) {
        out.push(`    added after the sprint opened and still in it (${c.lateAdditions.length}):`);
        for (const a of c.lateAdditions.slice(0, 10)) {
          out.push(`      ${a.key.padEnd(12)} ${String(a.storyPoints ?? '-').padStart(3)} pts  ${a.issueType}`);
        }
        if (c.lateAdditions.length > 10) out.push(`      ... and ${c.lateAdditions.length - 10} more`);
      }
    } else {
      out.push('  SCOPE CHURN  no active sprint to measure.');
    }

    out.push('');
    out.push('  BURNDOWN, remaining points by collected day');
    for (const p of h.burndown) {
      const ideal = p.idealRemaining === null ? '' : `   ideal ${p.idealRemaining.toFixed(0).padStart(4)}`;
      out.push(
        `    ${p.date}  ${String(p.remainingPoints).padStart(5)} pts remaining of ${String(p.committedPoints).padStart(4)} committed` +
          `  (${p.remainingIssues} issues open)${ideal}`,
      );
    }

    out.push('');
    const cy = h.cycle;
    out.push('  CYCLE TIME, first observed in progress -> resolved');
    if (cy.basis === 0) {
      out.push(`    nothing has both started and finished inside the observed window yet` +
        (cy.censored > 0 ? `; ${cy.censored} item(s) were already in progress when collection began` : ''));
    } else {
      out.push(`    p50 ${n1(cy.p50)} days   p90 ${n1(cy.p90)} days   basis ${cy.basis} item(s)` +
        (cy.censored > 0 ? `, ${cy.censored} excluded as already-started` : ''));
      if (cy.medianBacklogDwellDays !== null) {
        out.push(`    median backlog dwell before work started: ${cy.medianBacklogDwellDays.toFixed(1)} days`);
        out.push('    That gap is why lead time in "trends" is labelled WEAK - most of it is waiting, not working.');
      }
      for (const s of h.slowestCycle.slice(0, 5)) {
        out.push(`      ${s.key.padEnd(12)} ${s.cycleDays.toFixed(1).padStart(6)}d in progress   ${s.issueType}`);
      }
    }

    out.push('');
    out.push('  COLUMN AGEING, how long is currently sitting in each column');
    if (h.columnDwell.length === 0) {
      out.push('    no active sprint to measure.');
    } else {
      for (const c of h.columnDwell) {
        const figures = dwellIsReportable(c)
          ? `median ${n1(c.medianDwellDays)}d   p90 ${n1(c.p90DwellDays)}d   basis ${c.basis}`
          : `median    -   p90    -   basis ${c.basis} (too few observed entries to quote)`;
        out.push(
          `    ${c.column.slice(0, 28).padEnd(28)} ${String(c.count).padStart(3)} open   ` +
            figures +
            (c.censored > 0 ? `   (${c.censored} already there on day one, excluded)` : ''),
        );
      }
    }

    out.push('');
    out.push(...TRUSTWORTHINESS);
  }
  return out.join('\n');
}
