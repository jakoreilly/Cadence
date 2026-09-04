import { isDone } from './quality.js';
import type { IssueSnapshot, SprintSnapshot, TeamSnapshot } from './types.js';
import { completedInSprint, issuesBySprint, median, sprintWindow, sprintsInOrder } from './derive.js';

// ---------------------------------------------------------------------------
// Flow and people: where the work is sitting right now, and who has been on
// the team over time.
//
// Two questions that a velocity chart cannot answer and that a manager asks
// constantly:
//
//   "Where is it all stuck?"  - work in progress, per board column, using the
//   board's OWN columns rather than the three coarse status categories. This
//   site's board 701 has six columns and five of them collapse into "In
//   Progress"; a queue building up in `waiting test` is invisible until the
//   columns are used.
//
//   "Is this the same team it was six months ago?" - composition over time. A
//   velocity that halved because three people left is not a performance
//   problem, and a p50 calibrated across a team change is not a forecast. This
//   is the single most common way a delivery number gets misread by someone
//   senior, and the tool had nothing to say about it.
//
// Pure functions of the snapshot. No AI, no network.
// ---------------------------------------------------------------------------

// --- work in progress ---------------------------------------------------------

export interface ColumnLoad {
  name: string;
  issues: number;
  points: number;
  /** Issues here with no update for `staleDays` or more. A queue is only a
   *  problem when things sit in it. */
  stale: number;
  /** Median days since last update, for the items in this column. */
  medianIdleDays: number | null;
  keys: string[];
  /** True for columns whose statuses are all in the Done category - drawn
   *  differently, because a big Done column is the good outcome. */
  done: boolean;
}

export interface WipSummary {
  columns: ColumnLoad[];
  /** True when the board's column configuration could be joined to the issues.
   *  False means the snapshot predates `statusId` collection, and the columns
   *  fall back to raw status names - which is still far better than the three
   *  categories, but the ORDER is then alphabetical rather than the board's. */
  usingBoardColumns: boolean;
  /** In-progress items per person, worst first. */
  perPerson: Array<{ name: string; inProgress: number; points: number; keys: string[] }>;
  /** People carrying more than `wipLimit` items at once. */
  overloaded: string[];
  totalInProgress: number;
  /** The idle threshold `ColumnLoad.stale` was actually counted against, and the
   *  `wipLimit` `overloaded` was counted against.
   *
   *  Carried on the summary because the renderer has to STATE them, and it was
   *  printing constants instead: the chart legend said "No change for 10+ days"
   *  and the column tooltip "no update for 10 or more days" while `--stale-days`
   *  is a flag the report already honours when computing the number. A figure
   *  whose label names a different threshold from the one it used is the exact
   *  failure this codebase's trustworthiness labelling exists to prevent. */
  staleDays: number;
  wipLimit: number;
}

const DAY = 86_400_000;

export interface WipOptions {
  now: Date;
  staleDays: number;
  /** Items in progress at once, per person, above which the report says so.
   *  Three is not a law of nature; it is the point past which context switching
   *  is visible in this codebase's own carryover figures, and it is stated as a
   *  threshold rather than presented as a score. */
  wipLimit?: number;
}

/** Which board column a single issue currently sits in, joined the same way
 *  `wipSummary` joins the whole board: BY STATUS ID against the board's own
 *  column configuration, falling back to the raw status name when either the
 *  configuration or the issue's `statusId` is missing.
 *
 *  Extracted so a caller resolving one issue at a time - `history.ts`'s
 *  column-dwell walk, which needs the SAME issue's column on several different
 *  collected days - joins it identically to the WIP snapshot. Two different
 *  resolutions of the same board would make the two panels disagree about
 *  which queue an issue is even in. */
/** The board's column configuration and the two issue fields the join needs -
 *  nothing else. Narrowed rather than typed on TeamSnapshot/IssueSnapshot so the
 *  history layer can resolve columns on a PROJECTED snapshot (see
 *  historyProjection in history.ts) through this exact function instead of a
 *  second copy of the join. A full snapshot satisfies both structurally. */
export interface ColumnConfig {
  columns: Array<{ name: string; statusIds: string[] }>;
}
export interface ColumnPlaceable {
  status: string;
  statusId?: string;
}

export function columnNameFor(team: ColumnConfig, issue: ColumnPlaceable): string {
  return columnResolver(team)(issue);
}

/** `columnNameFor` for a whole board, with the status-id lookup built once.
 *
 *  The single-issue form walks `team.columns` and does a nested
 *  `statusIds.includes` on every call. `history.ts`'s column-dwell walk resolves
 *  the SAME issue on every collected day, so on board 704 that is (open issues x
 *  days) passes over the column config to answer a question one map answers in
 *  constant time. Cached per TeamSnapshot object: a snapshot is immutable once
 *  read (see snapshot.ts) and `readSnapshot` hands out the same parsed object
 *  for a given day, so every day in a series resolves against its own map. */
export function columnResolver(team: ColumnConfig): (issue: ColumnPlaceable) => string {
  const cached = columnMaps.get(team);
  if (cached) return cached;

  const byStatusId = new Map<string, string>();
  for (const col of team.columns) {
    // First column wins, matching the original loop's `return` on first hit - a
    // status listed in two columns is a board misconfiguration, and changing
    // which column claims it would silently move issues between queues.
    for (const id of col.statusIds) if (!byStatusId.has(id)) byStatusId.set(id, col.name);
  }
  const hasColumns = team.columns.length > 0;

  const resolve = (issue: ColumnPlaceable): string => {
    if (issue.statusId) {
      const name = byStatusId.get(issue.statusId);
      if (name !== undefined) return name;
      if (hasColumns) return '(not on the board)';
    }
    return issue.status;
  };
  columnMaps.set(team, resolve);
  return resolve;
}

const columnMaps = new WeakMap<ColumnConfig, (issue: ColumnPlaceable) => string>();

/** Where the active sprint's work is sitting, by board column. */
export function wipSummary(team: TeamSnapshot, opts: WipOptions): WipSummary {
  const activeIds = new Set(team.sprints.filter((s) => s.state === 'active').map((s) => s.id));
  const inSprint = team.issues.filter((i) => i.sprintIds.some((id) => activeIds.has(id)));
  const wipLimit = opts.wipLimit ?? 3;

  // GOTCHA: the board's columns carry STATUS IDS and an issue used to carry only
  // the status NAME, so the join was impossible and this fell back to status
  // categories - which puts `Waiting development`, `In Development`, `In
  // Review`, `waiting test` and `Test` in one bucket and hides every queue on
  // the board. statusId is schema 4; on an older snapshot the fallback below
  // groups by status name instead, and `usingBoardColumns` says which happened.
  const haveIds = team.columns.length > 0 && inSprint.some((i) => i.statusId);
  const columns: ColumnLoad[] = [];

  const build = (name: string, issues: IssueSnapshot[]): ColumnLoad => {
    const idles = issues
      .map((i) => (Number.isFinite(Date.parse(i.updated)) ? (opts.now.getTime() - Date.parse(i.updated)) / DAY : null))
      .filter((d): d is number => d !== null);
    return {
      name,
      issues: issues.length,
      points: issues.reduce((a, i) => a + (i.storyPoints ?? 0), 0),
      stale: idles.filter((d) => d >= opts.staleDays).length,
      medianIdleDays: median(idles),
      keys: issues.map((i) => i.key),
      done: issues.length > 0 && issues.every(isDone),
    };
  };

  if (haveIds) {
    const claimed = new Set<string>();
    for (const col of team.columns) {
      const ids = new Set(col.statusIds);
      const issues = inSprint.filter((i) => i.statusId && ids.has(i.statusId));
      for (const i of issues) claimed.add(i.key);
      columns.push(build(col.name, issues));
    }
    // A status that is on the board but in no column is real - it happens when
    // a workflow gains a status nobody added to the board - and dropping those
    // issues would make the column totals quietly disagree with the sprint
    // total two panels above.
    const unmapped = inSprint.filter((i) => !claimed.has(i.key));
    if (unmapped.length > 0) columns.push(build('(not on the board)', unmapped));
  } else {
    const byStatus = new Map<string, IssueSnapshot[]>();
    for (const i of inSprint) {
      const list = byStatus.get(i.status) ?? [];
      list.push(i);
      byStatus.set(i.status, list);
    }
    for (const [name, issues] of [...byStatus.entries()].sort((a, b) => b[1].length - a[1].length)) {
      columns.push(build(name, issues));
    }
  }

  const perPersonMap = new Map<string, { name: string; inProgress: number; points: number; keys: string[] }>();
  for (const i of inSprint) {
    if (i.statusCategory !== 'In Progress' || isDone(i)) continue;
    const name = i.assignee?.displayName ?? '(unassigned)';
    const e = perPersonMap.get(name) ?? { name, inProgress: 0, points: 0, keys: [] };
    e.inProgress++;
    e.points += i.storyPoints ?? 0;
    e.keys.push(i.key);
    perPersonMap.set(name, e);
  }
  const perPerson = [...perPersonMap.values()].sort((a, b) => b.inProgress - a.inProgress || a.name.localeCompare(b.name));

  return {
    columns,
    usingBoardColumns: haveIds,
    perPerson,
    overloaded: perPerson.filter((p) => p.name !== '(unassigned)' && p.inProgress > wipLimit).map((p) => p.name),
    totalInProgress: perPerson.reduce((a, p) => a + p.inProgress, 0),
    staleDays: opts.staleDays,
    wipLimit,
  };
}

// --- team composition over time ------------------------------------------------

export interface SprintRoster {
  sprintId: number;
  name: string;
  endDate?: string;
  /** People who completed at least one issue inside this sprint's window. */
  people: string[];
  /** People who appear here and did not appear in the previous sprint. */
  joined: string[];
  /** People who appeared in the previous sprint and not in this one. A single
   *  sprint's absence is leave as often as it is a departure - which is why
   *  this is reported as a list to read, never as attrition. */
  left: string[];
  completedIssues: number;
  completedPoints: number;
  /** Completed points divided by the number of people who completed anything.
   *
   *  NOT a productivity measure and never shown per person: it exists so that a
   *  velocity drop can be read against a headcount drop. A team that went from
   *  eight people to five and from 40 points to 28 did not get worse. */
  pointsPerContributor: number | null;
}

export interface CompositionSeries {
  sprints: SprintRoster[];
  /** Everybody seen across the window, with how many of these sprints they
   *  appear in - the "who is actually on this team" list. */
  people: Array<{ name: string; sprints: number; firstSeen?: string; lastSeen?: string; current: boolean }>;
  /** Median distinct contributors per sprint across the window. */
  medianContributors: number | null;
  /** Contributors in the most recent closed sprint, against that median. */
  latestContributors: number | null;
}

/** Who was delivering, sprint by sprint.
 *
 *  WEAK, and labelled so wherever it is drawn. `assignee` is the assignee NOW,
 *  not at the moment the issue was resolved: work reassigned after the fact is
 *  attributed to whoever holds it today, and an issue nobody ever assigned is
 *  invisible here. It is reliable enough to answer "did this team change size
 *  between sprint 40 and sprint 55", which is the question, and not reliable
 *  enough to answer "what did this person do", which is deliberately not asked
 *  anywhere in this codebase - see the header of insights.ts. */
export function compositionBySprint(team: TeamSnapshot, window: number): CompositionSeries {
  const closed = sprintsInOrder(team.sprints).filter((s) => s.state === 'closed').slice(-window);
  const sprints: SprintRoster[] = [];
  let previous: Set<string> = new Set();
  // One grouping pass instead of one full board scan per sprint - same reasoning
  // as sprintMetrics in derive.ts, and this runs over the same 12-sprint window
  // on the same 8,556-issue boards.
  const bySprint = issuesBySprint(team.issues);

  for (const sprint of closed) {
    const w = sprintWindow(sprint as SprintSnapshot);
    const completed = w ? (bySprint.get(sprint.id) ?? []).filter((i) => completedInSprint(i, w)) : [];
    const people = new Set<string>();
    for (const i of completed) if (i.assignee?.displayName) people.add(i.assignee.displayName);
    const list = [...people].sort();
    const points = completed.reduce((a, i) => a + (i.storyPoints ?? 0), 0);

    sprints.push({
      sprintId: sprint.id,
      name: sprint.name,
      endDate: sprint.completeDate ?? sprint.endDate,
      people: list,
      // The first sprint in the window has no predecessor, so everyone in it
      // would read as a joiner - a false "the whole team arrived at once" spike
      // at the left edge of every chart. Nobody joins in sprint one.
      joined: sprints.length === 0 ? [] : list.filter((p) => !previous.has(p)),
      left: sprints.length === 0 ? [] : [...previous].filter((p) => !people.has(p)).sort(),
      completedIssues: completed.length,
      completedPoints: points,
      pointsPerContributor: list.length > 0 ? points / list.length : null,
    });
    previous = people;
  }

  const seen = new Map<string, { name: string; sprints: number; firstSeen?: string; lastSeen?: string; current: boolean }>();
  const latest = sprints[sprints.length - 1];
  for (const s of sprints) {
    for (const p of s.people) {
      const e = seen.get(p) ?? { name: p, sprints: 0, firstSeen: s.name, lastSeen: s.name, current: false };
      e.sprints++;
      e.lastSeen = s.name;
      seen.set(p, e);
    }
  }
  const inLatest = new Set(latest?.people ?? []);
  for (const [name, e] of seen) e.current = inLatest.has(name);

  const counts = sprints.map((s) => s.people.length).filter((n) => n > 0);
  return {
    sprints,
    people: [...seen.values()].sort((a, b) => b.sprints - a.sprints || a.name.localeCompare(b.name)),
    medianContributors: median(counts),
    latestContributors: latest ? latest.people.length : null,
  };
}
