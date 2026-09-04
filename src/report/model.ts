import { activeSprintOf, isDone } from '../quality.js';
import type { SchemaAssessment } from '../schema.js';
import { median } from '../derive.js';
import type { TeamTrends } from '../derive.js';
import type { TeamQuality } from '../quality.js';
import type { ReviewMetrics } from '../review.js';
import type { ConfluencePage, ConfluenceSpace, MergeRequestSnapshot, TeamSnapshot } from '../types.js';
import type { TeamHistory } from '../history.js';
import type { AttentionItem, PracticeSummary, SlowItem, SprintOutlook, TeamHealth } from '../insights.js';
import type { EpicRollupResult, EstateEpicResult } from '../epics.js';
import type { CompositionSeries, WipSummary } from '../flow.js';
import type { Intervention } from '../interventions.js';
import type { PeopleEstate } from '../people.js';
import type { ChangeSummary } from '../changes.js';
import type {
  BlockerEdge,
  DiscussedItem,
  FlaggedRegister,
  RosterSummary,
  SubtaskStructure,
  TaxonomySummary,
} from '../taxonomy.js';

// ---------------------------------------------------------------------------
// The shapes the renderer consumes, and the small derivations that only the
// report needs. Kept out of index.ts so the assembly file is about layout and
// nothing else.
// ---------------------------------------------------------------------------

// --- board prefixes -----------------------------------------------------------

/** Project key mix on a board, most common first.
 *
 *  The board PREFIX cannot come from the board's own `location.projectKey`:
 *  board 703 is located in project OPS but every issue on it is LOG-keyed. So
 *  it is counted from the issues actually on the board. */
export function projectPrefixes(team: TeamSnapshot): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const i of team.issues) {
    const dash = i.key.lastIndexOf('-');
    if (dash <= 0) continue;
    const pk = i.key.slice(0, dash);
    counts.set(pk, (counts.get(pk) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// --- active sprint load -------------------------------------------------------

export interface ActiveLoad {
  sprintCount: number;
  sprintNames: string[];
  issues: number;
  points: number;
  unestimated: number;
  resolved: number;
}

/** Committed load across EVERY active sprint on the board, deduped by issue.
 *
 *  GOTCHA: a board can have several concurrent active sprints - board 705
 *  ('PAY & CSP') has six. Summing SprintMetrics.committedPoints across them
 *  double-counts any issue in two at once, and reporting only one of the six
 *  (what `sprints.find(state === 'active')` does) hides five sixths of the
 *  committed work. So this walks the raw issues once and dedupes. */
export function activeLoad(team: TeamSnapshot): ActiveLoad {
  const active = team.sprints.filter((s) => s.state === 'active');
  const activeIds = new Set(active.map((s) => s.id));
  const inAny = team.issues.filter((i) => i.sprintIds.some((id) => activeIds.has(id)));
  return {
    sprintCount: active.length,
    sprintNames: active.map((s) => s.name),
    issues: inAny.length,
    points: inAny.reduce((acc, i) => acc + (i.storyPoints ?? 0), 0),
    unestimated: inAny.filter((i) => i.storyPoints === null).length,
    resolved: inAny.filter(isDone).length,
  };
}

export type LoadTone = 'over' | 'within' | 'unknown';
export interface LoadVerdict {
  tone: LoadTone;
  label: string;
}

const MIN_ESTIMATE_COVERAGE = 2 / 3;

/** Is the active sprint's committed load above what this team has delivered?
 *
 *  GOTCHA: "within band" is only meaningful when the sprint is actually
 *  estimated. Measured live on board 705: 149 of 154 active issues carry no
 *  estimate, so its committed total is 27 points - five issues' worth - and a
 *  green "within band" against a p90 of 104.8 would be the single most
 *  misleading cell on the page. Over-p90 IS still reported in the same state,
 *  because a partial count that already exceeds the p90 is a valid LOWER
 *  bound; only the reassuring verdict has to be withheld. */
export function loadVerdict(load: ActiveLoad, p90: number | null): LoadVerdict {
  if (load.sprintCount === 0) return { tone: 'unknown', label: 'no active sprint' };
  if (p90 === null) return { tone: 'unknown', label: 'no forecast' };
  if (load.points > p90) return { tone: 'over', label: 'over p90' };
  const estimated = load.issues - load.unestimated;
  if (load.issues > 0 && estimated / load.issues < MIN_ESTIMATE_COVERAGE) {
    return { tone: 'unknown', label: 'not comparable' };
  }
  return { tone: 'within', label: 'within band' };
}

// --- backlog ------------------------------------------------------------------

export interface BacklogItem {
  key: string;
  summary?: string;
  description?: string;
  issueType: string;
  storyPoints: number | null;
  ageDays: number | null;
  status: string;
  epicKey?: string;
  epicName?: string;
  assignee?: string;
}

export interface BacklogSummary {
  issues: number;
  points: number;
  unestimated: number;
  medianAgeDays: number | null;
  /** Items sitting in the backlog for more than a quarter. Not a defect on its
   *  own - a backlog is allowed to have a tail - but a backlog where MOST items
   *  are this old is a list nobody triages, and it is where "we have no capacity"
   *  conversations usually start. */
  olderThan90Days: number;
  /** The next items in board rank order - what would actually get pulled.
   *
   *  GOTCHA: ordered by `rank`, the LexoRank string, NOT by key or by age. Rank
   *  is the only field that reflects the order the team put them in; sorting by
   *  age instead shows the items nobody wants, which is the opposite of what
   *  gets pulled next. LexoRank is designed to sort correctly as a plain string,
   *  so localeCompare is right here. An issue with no rank sorts last rather
   *  than first, because absent is not "top of the backlog". */
  nextUp: BacklogItem[];
  /** Every backlog key, for the "open all of these in Jira" link. */
  allKeys: string[];
}

export function backlogSummary(team: TeamSnapshot, now: Date, limit = 12): BacklogSummary {
  const items = team.issues.filter((i) => i.inBacklog && !isDone(i));
  const ages = items
    .map((i) => (Date.parse(i.created) ? (now.getTime() - Date.parse(i.created)) / 86_400_000 : null))
    .filter((d): d is number => d !== null && Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);

  const nextUp = [...items]
    .sort((a, b) => {
      if (a.rank && b.rank) return a.rank.localeCompare(b.rank);
      if (a.rank) return -1;
      if (b.rank) return 1;
      return a.key.localeCompare(b.key);
    })
    .slice(0, limit)
    .map((i) => ({
      key: i.key,
      summary: i.summary,
      description: i.description,
      issueType: i.issueType,
      storyPoints: i.storyPoints,
      ageDays: Number.isFinite(Date.parse(i.created)) ? (now.getTime() - Date.parse(i.created)) / 86_400_000 : null,
      status: i.status,
      epicKey: i.epicKey,
      epicName: i.epicName,
      assignee: i.assignee?.displayName,
    }));

  return {
    issues: items.length,
    points: items.reduce((a, i) => a + (i.storyPoints ?? 0), 0),
    unestimated: items.filter((i) => i.storyPoints === null).length,
    medianAgeDays: median(ages),
    olderThan90Days: ages.filter((d) => d > 90).length,
    nextUp,
    allKeys: items.map((i) => i.key),
  };
}

// --- carryover leaderboard ----------------------------------------------------

export interface CarryoverLeader {
  key: string;
  sprintCount: number;
  summary?: string;
}

/** Open issues in the active sprint carried three or more sprints, worst
 *  first. quality.ts's finding carries only a bounded example list, not the
 *  per-issue sprint count needed to say "two of them in 16 sprints". */
export function carryoverLeaders(team: TeamSnapshot, limit = 6): CarryoverLeader[] {
  const sprint = activeSprintOf(team);
  if (!sprint) return [];
  return team.issues
    .filter((i) => i.sprintIds.includes(sprint.id) && !isDone(i))
    .filter((i) => i.sprintIds.length >= 3)
    .sort((a, b) => b.sprintIds.length - a.sprintIds.length)
    .slice(0, limit)
    .map((i) => ({ key: i.key, sprintCount: i.sprintIds.length, summary: i.summary }));
}

// --- inputs -------------------------------------------------------------------

/** Everything the report knows about one team. Every field added since the
 *  first version is OPTIONAL, so a caller built against the old shape still
 *  compiles and the panels that need the new data say "not collected yet". */
export interface ReportTeamInput {
  key: string;
  boardName?: string;
  boardId?: number;
  prefix: string;
  /** All project keys on the board, most common first, for the orientation
   *  panel: a reader who has never seen the board cannot be expected to know
   *  that `fs` means PAY plus some CSP. */
  prefixes?: Array<{ key: string; count: number }>;
  /** The profile's own note on why this board and this GitLab group were chosen.
   *  It is the evidence behind the mapping and it belongs in front of the
   *  reader, not only in a config file. */
  description?: string;
  gitlabGroups?: string[];
  /** Snapshot-to-snapshot metrics, when two or more days exist for this team.
   *  Null on a profile with one collected day - which the UI reports as "not
   *  yet measured", never as zero churn. */
  history?: TeamHistory | null;
  backlog?: BacklogSummary;
  trends: TeamTrends;
  quality: TeamQuality;
  activeLoad: ActiveLoad;
  carryoverLeaders: CarryoverLeader[];
  review?: ReviewMetrics;
  attention: AttentionItem[];
  practice: PracticeSummary;
  outlook: SprintOutlook | null;
  health: TeamHealth;
  slowest: SlowItem[];
  /** Schema-4 panels. Absent means the caller did not compute them. */
  epics?: EpicRollupResult;
  wip?: WipSummary;
  composition?: CompositionSeries;
  interventions?: Intervention[];
  /** The business-and-dev detail layer. Every one is optional for the same
   *  reason the rest are: a caller built against the older shape still
   *  compiles, and the panel reports "not computed" rather than an empty state
   *  that reads as "nothing here". */
  taxonomy?: TaxonomySummary;
  taxonomyBacklog?: TaxonomySummary;
  taxonomyRecent?: TaxonomySummary;
  subtasks?: SubtaskStructure;
  discussed?: DiscussedItem[];
  /** Human-readable note on WHICH issues carried comment detail, because it is
   *  deliberately not all of them - see taxonomy.mostDiscussed. */
  commentScope?: string;
  flagged?: FlaggedRegister;
  blockers?: BlockerEdge[];
  roster?: RosterSummary;
  confluence?: { spaces: ConfluenceSpace[]; pages: ConfluencePage[]; errors: string[] };
  /** Active sprint goals, in the order the sprints are listed. */
  sprintGoals?: Array<{ id: number; name: string; goal?: string; startDate?: string; endDate?: string }>;
  /** A bounded sample of merge requests, for the code-review panel's links. */
  mergeRequests?: MergeRequestSnapshot[];
}

export interface ReportInput {
  site: string;
  generatedAt: string;
  jiraDate: string;
  jiraCapturedAt: string;
  gitlabDate?: string;
  gitlabCapturedAt?: string;
  windowDays?: number;
  teams: ReportTeamInput[];
  /** Recovered from the merge-request URLs in the snapshot - see links.ts. */
  gitlabOrigin?: string;
  /** Embed the full derived model as machine-readable JSON. Default true. */
  embedData?: boolean;
  /** Whether the snapshot this was rendered from can answer what the code now
   *  asks of it. Rendered as a banner above everything else when it cannot -
   *  see report/freshness.ts. Optional so a caller that has not assessed the
   *  snapshot simply gets no banner rather than a false all-clear. */
  schema?: SchemaAssessment;
  /** Which forge produced the merge-request data, from GitLabSnapshot.source.
   *  Carried through to RenderContext.forge so the report's copy names the right
   *  artefact (merge request vs pull request). Defaults to gitlab. */
  forge?: 'gitlab' | 'github';
  /** People rolled up ACROSS boards - the one question the per-team roster
   *  panels structurally cannot answer, because each is computed for one board
   *  and somebody on two of them appears as two rows that are never added
   *  together. Optional like everything else added since the first version: a
   *  caller that did not compute it gets a view that says so. */
  people?: PeopleEstate;
  /** Epics rolled up across boards, so an epic split over two boards reads as
   *  one thing rather than as two rollups each claiming their own progress. */
  estateEpics?: EstateEpicResult;
  /** What changed between this collected day and the previous one. Optional
   *  for the same reason `schema` is: a caller that did not build the previous
   *  day's findings gets a panel that says it was not compared, rather than one
   *  that reports every standing finding as new. */
  changes?: ChangeSummary;
}

/** Teams grouped by board prefix, biggest group first then alphabetical. */
export function groupByPrefix(teams: ReportTeamInput[]): Array<{ prefix: string; teams: ReportTeamInput[] }> {
  const groups = new Map<string, ReportTeamInput[]>();
  for (const t of teams) {
    const list = groups.get(t.prefix);
    if (list) list.push(t);
    else groups.set(t.prefix, [t]);
  }
  return [...groups.entries()]
    .map(([prefix, ts]) => ({ prefix, teams: ts }))
    .sort((a, b) => b.teams.length - a.teams.length || a.prefix.localeCompare(b.prefix));
}
