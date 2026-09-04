import { isDone } from './quality.js';
import type { IssueSnapshot, MergeRequestSnapshot, TeamSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// The "what IS this board" layer.
//
// Every other analytic in this tool answers a delivery question - is it landing,
// is it reviewed, is it drifting. This one answers the question a person asks
// BEFORE any of those make sense: what kind of work is on this board, who does
// it, and which specific tickets are the loud ones.
//
// Three rules, all learned from the panels that came before:
//
//   1. Counts are split by SCOPE (active sprint / backlog / recently done) and
//      never presented as one total. A board with 8,556 issues has a decade of
//      closed work on it; "62% bugs" over that pile says nothing about what the
//      team is doing this fortnight, and it is the number a reader will quote.
//   2. Nothing here is a productivity measure. The roster says what a person
//      TOUCHES, never how much they produce, and it is labelled that way at
//      every call site - see decisions.md and the header of insights.ts. The
//      per-person data exists so a manager can find who to ASK about a ticket,
//      which is the actual daily need.
//   3. issueType, priority, labels and components are free text on this site.
//      They are counted as they come and never mapped onto an assumed taxonomy:
//      a site that calls its bugs "Defect" must not report zero bugs.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

export type Scope = 'active' | 'backlog' | 'recent' | 'all';

/** Is this issue in one of the board's active sprints? */
function inActiveSprint(issue: IssueSnapshot, activeIds: Set<number>): boolean {
  return issue.sprintIds.some((id) => activeIds.has(id));
}

function activeSprintIds(team: TeamSnapshot): Set<number> {
  return new Set(team.sprints.filter((s) => s.state === 'active').map((s) => s.id));
}

/** Issues resolved within the last `days`. The "recent" scope.
 *
 *  Anchored to resolutionDate, which is the one date on a Jira issue that is not
 *  restated by later board activity - the same basis the SOUND trend metrics
 *  use. `updated` would look equivalent and is not: a bulk edit moves it. */
function resolvedWithin(team: TeamSnapshot, now: Date, days: number): IssueSnapshot[] {
  return team.issues.filter((i) => {
    if (!i.resolutionDate) return false;
    const t = Date.parse(i.resolutionDate);
    return Number.isFinite(t) && (now.getTime() - t) / DAY <= days;
  });
}

export function issuesInScope(team: TeamSnapshot, scope: Scope, now: Date, recentDays: number): IssueSnapshot[] {
  if (scope === 'all') return team.issues;
  if (scope === 'recent') return resolvedWithin(team, now, recentDays);
  if (scope === 'backlog') return team.issues.filter((i) => i.inBacklog && !isDone(i));
  const ids = activeSprintIds(team);
  return team.issues.filter((i) => inActiveSprint(i, ids));
}

// --- categorical mixes --------------------------------------------------------

export interface MixEntry {
  name: string;
  issues: number;
  points: number;
  /** Issues in this bucket that are not done. Zero on the `recent` scope by
   *  construction, which is why the UI hides the column there. */
  open: number;
  /** Share of the scope's issue count, 0-1. */
  share: number;
}

/** Count a categorical field, most common first.
 *
 *  GOTCHA: `points` is summed over issues that HAVE an estimate, and the caller
 *  is expected to show the unestimated count beside it. On this site 97% of one
 *  board's active work is unestimated (GOTCHA 19), so a points column with no
 *  coverage figure beside it reads as "bugs are cheap here" when it really means
 *  "nobody estimates bugs here". */
export function mixBy(issues: IssueSnapshot[], pick: (i: IssueSnapshot) => string | undefined): MixEntry[] {
  const buckets = new Map<string, { issues: number; points: number; open: number }>();
  for (const i of issues) {
    const raw = pick(i);
    const name = raw === undefined || raw === '' ? '(none)' : raw;
    const b = buckets.get(name) ?? { issues: 0, points: 0, open: 0 };
    b.issues += 1;
    b.points += i.storyPoints ?? 0;
    if (!isDone(i)) b.open += 1;
    buckets.set(name, b);
  }
  const total = issues.length || 1;
  return [...buckets.entries()]
    .map(([name, b]) => ({ name, ...b, share: b.issues / total }))
    .sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name));
}

/** Multi-valued fields (labels, components) need their own counter: an issue
 *  with three labels belongs in three buckets, so the shares deliberately do
 *  not sum to 1 and `issues` is "issues carrying this label", not a partition. */
export function mixByMulti(issues: IssueSnapshot[], pick: (i: IssueSnapshot) => string[]): MixEntry[] {
  const buckets = new Map<string, { issues: number; points: number; open: number }>();
  for (const i of issues) {
    for (const name of new Set(pick(i))) {
      const b = buckets.get(name) ?? { issues: 0, points: 0, open: 0 };
      b.issues += 1;
      b.points += i.storyPoints ?? 0;
      if (!isDone(i)) b.open += 1;
      buckets.set(name, b);
    }
  }
  const total = issues.length || 1;
  return [...buckets.entries()]
    .map(([name, b]) => ({ name, ...b, share: b.issues / total }))
    .sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name));
}

export interface TaxonomySummary {
  scope: Scope;
  issues: number;
  points: number;
  unestimated: number;
  types: MixEntry[];
  priorities: MixEntry[];
  labels: MixEntry[];
  components: MixEntry[];
  /** Bug share of the scope by issue count, 0-1, or null when the board uses no
   *  recognisable bug type. Reported separately because it is the one ratio in
   *  here that a manager will be asked about by name. */
  bugShare: number | null;
}

/** Issue types that mean "something is broken", matched case-insensitively as
 *  substrings. Deliberately a LIST, not a single name: this site is company
 *  managed with site-wide types, but "Bug", "Defect" and "Production Bug" all
 *  occur across Jira instances and a tool that hardcodes "Bug" silently reports
 *  a zero bug rate on the ones that do not. */
const BUG_TYPE_HINTS = ['bug', 'defect', 'incident', 'problem'];

export function isBugType(issueType: string): boolean {
  const t = issueType.toLowerCase();
  return BUG_TYPE_HINTS.some((h) => t.includes(h));
}

export function taxonomy(team: TeamSnapshot, scope: Scope, now: Date, recentDays = 30): TaxonomySummary {
  const issues = issuesInScope(team, scope, now, recentDays);
  const types = mixBy(issues, (i) => i.issueType);
  const bugIssues = issues.filter((i) => isBugType(i.issueType)).length;
  return {
    scope,
    issues: issues.length,
    points: issues.reduce((a, i) => a + (i.storyPoints ?? 0), 0),
    unestimated: issues.filter((i) => i.storyPoints === null).length,
    types,
    priorities: mixBy(issues, (i) => i.priority),
    labels: mixByMulti(issues, (i) => i.labels),
    components: mixByMulti(issues, (i) => i.components),
    bugShare: issues.length === 0 ? null : bugIssues / issues.length,
  };
}

// --- subtask structure --------------------------------------------------------

export interface ParentBreakdown {
  key: string;
  summary?: string;
  issueType: string;
  status: string;
  statusCategory: string;
  assignee?: string;
  children: number;
  childrenDone: number;
  childKeys: string[];
  /** True when every child is done and the parent is not. This is the specific
   *  shape worth acting on: the work is finished and the ticket is still open,
   *  so either somebody forgot to close it or there is unwritten work left. */
  stalledParent: boolean;
}

export interface SubtaskStructure {
  /** Parents that have at least one child, worst-first by open children. */
  parents: ParentBreakdown[];
  /** Issues whose parentKey names a ticket that is not on this board. Not an
   *  error - cross-board parents are legitimate - but it is why a subtask can
   *  look orphaned in every other panel. */
  orphanChildren: Array<{ key: string; parentKey: string; summary?: string }>;
  parentsWithChildren: number;
  stalledParents: number;
  /** Issues in scope that are children of something. */
  children: number;
}

/** Parent/child structure over the issues on the board.
 *
 *  GOTCHA: `parentKey` is set for BOTH classic subtasks and next-gen child
 *  issues, and on this site it is also set on issues whose parent is an EPIC.
 *  So an epic would otherwise appear here as a "parent with 40 subtasks" and
 *  swamp the real subtask structure. Epic parents are excluded by checking the
 *  parent against the board's own epic list, which is the only authoritative
 *  source for what is an epic - the issue type name is not (a site can rename
 *  it). Snapshots with no epic list fall back to the type name. */
export function subtaskStructure(team: TeamSnapshot, limit = 15): SubtaskStructure {
  const byKey = new Map(team.issues.map((i) => [i.key, i]));
  const epicKeys = new Set((team.epics ?? []).map((e) => e.key));
  const isEpic = (key: string): boolean => {
    if (epicKeys.has(key)) return true;
    const issue = byKey.get(key);
    return issue !== undefined && issue.issueType.toLowerCase().includes('epic');
  };

  const childrenOf = new Map<string, IssueSnapshot[]>();
  const orphanChildren: SubtaskStructure['orphanChildren'] = [];
  let children = 0;

  for (const i of team.issues) {
    if (!i.parentKey) continue;
    if (isEpic(i.parentKey)) continue;
    children += 1;
    if (!byKey.has(i.parentKey)) {
      orphanChildren.push({ key: i.key, parentKey: i.parentKey, summary: i.summary });
      continue;
    }
    const list = childrenOf.get(i.parentKey);
    if (list) list.push(i);
    else childrenOf.set(i.parentKey, [i]);
  }

  const parents: ParentBreakdown[] = [];
  for (const [key, kids] of childrenOf) {
    const parent = byKey.get(key);
    if (!parent) continue;
    const done = kids.filter(isDone).length;
    parents.push({
      key,
      summary: parent.summary,
      issueType: parent.issueType,
      status: parent.status,
      statusCategory: parent.statusCategory,
      assignee: parent.assignee?.displayName,
      children: kids.length,
      childrenDone: done,
      childKeys: kids.map((k) => k.key),
      stalledParent: done === kids.length && !isDone(parent),
    });
  }

  parents.sort((a, b) => {
    // Stalled first - it is the actionable shape - then by open children.
    if (a.stalledParent !== b.stalledParent) return a.stalledParent ? -1 : 1;
    return b.children - b.childrenDone - (a.children - a.childrenDone) || b.children - a.children;
  });

  return {
    parents: parents.slice(0, limit),
    orphanChildren: orphanChildren.slice(0, limit),
    parentsWithChildren: childrenOf.size,
    stalledParents: parents.filter((p) => p.stalledParent).length,
    children,
  };
}

// --- discussion hotspots ------------------------------------------------------

export interface DiscussedItem {
  key: string;
  summary?: string;
  issueType: string;
  status: string;
  statusCategory: string;
  assignee?: string;
  commentCount: number;
  flagged: boolean;
  sprintCount: number;
  ageDays: number | null;
  /** The most recent comment, verbatim and truncated at collection time. A
   *  paraphrase of somebody's comment is a claim about what they meant. */
  latestComment?: { author?: string; created: string; body: string; truncated: boolean };
}

/** The most-discussed OPEN work, comment count first.
 *
 *  Why this is worth a panel: a high comment count is the cheapest available
 *  proxy for "this ticket is contested, confusing or stuck". It costs nothing to
 *  collect - Jira returns the total on every issue - and unlike the Flagged
 *  field it cannot be forgotten, because arguing about a ticket IS the signal.
 *
 *  GOTCHA: `commentCount` is undefined on schema-3 snapshots and on any issue
 *  collected with --no-issue-detail. Undefined must not sort as zero and must
 *  not render as "no discussion" - those issues are excluded outright and the
 *  caller reports the panel as not-collected when nothing survives. */
export function mostDiscussed(team: TeamSnapshot, now: Date, limit = 10): DiscussedItem[] {
  return team.issues
    .filter((i) => !isDone(i))
    .filter((i) => typeof i.commentCount === 'number' && i.commentCount > 0)
    .sort((a, b) => (b.commentCount ?? 0) - (a.commentCount ?? 0) || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((i) => {
      // Comments arrive NEWEST FIRST from the collector - recentComments in
      // jira/collect.ts takes the last N and reverses them - so the latest is
      // element 0. Taking the LAST element here read the oldest of the three
      // kept comments and labelled it `latestComment`, which on a long-running
      // ticket is the remark from months ago rather than the one that says why
      // it is stuck. Same convention as blockerInComments in interventions.ts
      // and the `latest` in attentionItems.
      const last = i.comments?.[0];
      const created = Date.parse(i.created);
      return {
        key: i.key,
        summary: i.summary,
        issueType: i.issueType,
        status: i.status,
        statusCategory: i.statusCategory,
        assignee: i.assignee?.displayName,
        commentCount: i.commentCount ?? 0,
        flagged: i.flagged,
        sprintCount: i.sprintIds.length,
        ageDays: Number.isFinite(created) ? (now.getTime() - created) / DAY : null,
        latestComment: last
          ? { author: last.author?.displayName, created: last.created, body: last.body, truncated: last.truncated }
          : undefined,
      };
    });
}

// --- the flagged register -----------------------------------------------------

export interface FlaggedItem {
  key: string;
  summary?: string;
  issueType: string;
  status: string;
  statusCategory: string;
  assignee?: string;
  ageDays: number | null;
  sprintCount: number;
  commentCount?: number;
  blockedBy: string[];
  inActiveSprint: boolean;
  inBacklog: boolean;
}

export interface FlaggedRegister {
  items: FlaggedItem[];
  total: number;
  inActiveSprint: number;
  /** Flagged and NOT in any active sprint and not in the backlog - work someone
   *  marked as blocked and then left outside the plan entirely. The easiest
   *  category to lose, which is the reason it is counted on its own. */
  strandedFlags: number;
}

/** Everything the team has flagged, most-carried first.
 *
 *  GOTCHA 3: Flagged is a multi-select custom field, not a boolean, and an empty
 *  array must not read as flagged. That is handled at collection time - by the
 *  time it reaches here `flagged` is a real boolean - and this comment exists so
 *  nobody re-derives it from the raw field here and reintroduces the bug. */
export function flaggedRegister(team: TeamSnapshot, now: Date, limit = 25): FlaggedRegister {
  const activeIds = activeSprintIds(team);
  const flagged = team.issues.filter((i) => i.flagged && !isDone(i));
  const items = flagged
    .map((i) => {
      const created = Date.parse(i.created);
      return {
        key: i.key,
        summary: i.summary,
        issueType: i.issueType,
        status: i.status,
        statusCategory: i.statusCategory,
        assignee: i.assignee?.displayName,
        ageDays: Number.isFinite(created) ? (now.getTime() - created) / DAY : null,
        sprintCount: i.sprintIds.length,
        commentCount: i.commentCount,
        blockedBy: i.blockedBy ?? [],
        inActiveSprint: inActiveSprint(i, activeIds),
        inBacklog: i.inBacklog,
      };
    })
    .sort((a, b) => b.sprintCount - a.sprintCount || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return {
    items: items.slice(0, limit),
    total: items.length,
    inActiveSprint: items.filter((i) => i.inActiveSprint).length,
    strandedFlags: items.filter((i) => !i.inActiveSprint && !i.inBacklog).length,
  };
}

// --- the roster ---------------------------------------------------------------

export interface RosterMember {
  name: string;
  /** Open issues assigned right now, in any scope. */
  openAssigned: number;
  /** Open issues assigned in an ACTIVE sprint - the real current load. */
  openInActiveSprint: number;
  openPoints: number;
  flaggedAssigned: number;
  /** Issues resolved in the recent window that are assigned to them now. WEAK -
   *  assignee is who holds it TODAY, not who resolved it. */
  resolvedRecently: number;
  /** Issues they raised in the recent window. Reported because on several of
   *  these boards the biggest reporters are support and product people who are
   *  not developers at all, and a roster that omits them describes the wrong
   *  team. */
  reportedRecently: number;
  /** Merge requests they authored in the GitLab window. */
  mergeRequestsAuthored: number;
  mergeRequestsMerged: number;
  /** Merge requests they left a review comment on. This is the "gives review"
   *  counterpart, and on this instance it is where human review actually lives -
   *  almost every APPROVAL is the bot (GOTCHA 20/21). */
  reviewsGiven: number;
  /** True when they appear in Jira but never in GitLab in these windows, which
   *  usually means product, QA or support rather than absence. */
  jiraOnly: boolean;
  gitlabOnly: boolean;
  /** Distinct GitLab projects they opened a merge request in - the cheapest
   *  available answer to "what does this person actually work on". */
  projects: string[];
}

export interface RosterSummary {
  members: RosterMember[];
  /** People holding open work in an active sprint. */
  activeContributors: number;
  /** Open, unassigned issues in an active sprint - nobody's name on them. */
  unassignedOpenInActiveSprint: number;
  gitlabWindowDays?: number;
  recentDays: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Who is on this board and what do they touch.
 *
 *  This is a CONTACT SHEET, not a scorecard, and the distinction is load
 *  bearing. It answers "whose ticket is this, and where else do they work" -
 *  the question a manager actually asks twenty times a week. It deliberately
 *  reports no rate, no ranking by output and no per-person velocity, because
 *  the assignee field is who holds the work TODAY (see compositionBySprint) and
 *  building a performance number on that basis would be wrong in a way that is
 *  invisible to the person reading it. decisions.md records that per-person
 *  attribution is on by the user's explicit choice, for exactly this use.
 *
 *  GOTCHA: Jira identities are matched to GitLab identities by DISPLAY NAME,
 *  case-insensitively and trimmed, because the two systems share no id on this
 *  instance - Jira has accountIds, GitLab has usernames, and nothing joins them.
 *  So a person who spells their name differently in the two systems appears
 *  twice, once as jiraOnly and once as gitlabOnly. That is reported honestly as
 *  two rows rather than guessed at with fuzzy matching, which would silently
 *  merge two real people who happen to share a surname. */
export function roster(
  team: TeamSnapshot,
  mrs: MergeRequestSnapshot[],
  opts: { now: Date; recentDays?: number; isAutomation?: (p: { displayName: string }) => boolean; gitlabWindowDays?: number; limit?: number },
): RosterSummary {
  const recentDays = opts.recentDays ?? 30;
  const activeIds = activeSprintIds(team);
  const rows = new Map<string, RosterMember>();

  const row = (name: string): RosterMember => {
    const k = norm(name);
    const found = rows.get(k);
    if (found) return found;
    const fresh: RosterMember = {
      name,
      openAssigned: 0,
      openInActiveSprint: 0,
      openPoints: 0,
      flaggedAssigned: 0,
      resolvedRecently: 0,
      reportedRecently: 0,
      mergeRequestsAuthored: 0,
      mergeRequestsMerged: 0,
      reviewsGiven: 0,
      jiraOnly: false,
      gitlabOnly: false,
      projects: [],
    };
    rows.set(k, fresh);
    return fresh;
  };

  const jiraNames = new Set<string>();
  const recentCut = opts.now.getTime() - recentDays * DAY;

  for (const i of team.issues) {
    const assignee = i.assignee?.displayName;
    if (assignee) {
      jiraNames.add(norm(assignee));
      const r = row(assignee);
      if (!isDone(i)) {
        r.openAssigned += 1;
        r.openPoints += i.storyPoints ?? 0;
        if (i.flagged) r.flaggedAssigned += 1;
        if (inActiveSprint(i, activeIds)) r.openInActiveSprint += 1;
      } else if (i.resolutionDate) {
        const t = Date.parse(i.resolutionDate);
        if (Number.isFinite(t) && t >= recentCut) r.resolvedRecently += 1;
      }
    }
    const reporter = i.reporter?.displayName;
    if (reporter) {
      const t = Date.parse(i.created);
      if (Number.isFinite(t) && t >= recentCut) {
        jiraNames.add(norm(reporter));
        row(reporter).reportedRecently += 1;
      }
    }
  }

  const gitlabNames = new Set<string>();
  const isBot = opts.isAutomation ?? (() => false);
  for (const mr of mrs) {
    const author = mr.author?.displayName;
    if (author && !isBot({ displayName: author })) {
      gitlabNames.add(norm(author));
      const r = row(author);
      r.mergeRequestsAuthored += 1;
      if (mr.mergedAt) r.mergeRequestsMerged += 1;
      if (mr.projectPath && !r.projects.includes(mr.projectPath)) r.projects.push(mr.projectPath);
    }
    // humanCommenters is schema 3+. Undefined means the identities were not
    // collected, NOT that nobody reviewed - so it contributes nothing rather
    // than a zero, and the panel says so.
    for (const c of mr.review?.humanCommenters ?? []) {
      const name = c.displayName;
      if (!name || isBot({ displayName: name })) continue;
      gitlabNames.add(norm(name));
      row(name).reviewsGiven += 1;
    }
  }

  for (const [key, r] of rows) {
    r.jiraOnly = jiraNames.has(key) && !gitlabNames.has(key);
    r.gitlabOnly = !jiraNames.has(key) && gitlabNames.has(key);
    r.projects.sort();
  }

  const members = [...rows.values()].sort(
    (a, b) =>
      b.openInActiveSprint - a.openInActiveSprint ||
      b.openAssigned - a.openAssigned ||
      b.mergeRequestsAuthored - a.mergeRequestsAuthored ||
      a.name.localeCompare(b.name),
  );

  const unassignedOpenInActiveSprint = team.issues.filter(
    (i) => !isDone(i) && !i.assignee && inActiveSprint(i, activeIds),
  ).length;

  return {
    members: opts.limit ? members.slice(0, opts.limit) : members,
    activeContributors: members.filter((m) => m.openInActiveSprint > 0).length,
    unassignedOpenInActiveSprint,
    gitlabWindowDays: opts.gitlabWindowDays,
    recentDays,
  };
}

// --- blocker graph ------------------------------------------------------------

export interface BlockerEdge {
  blocker: string;
  blockerSummary?: string;
  blockerStatus?: string;
  blockerDone: boolean;
  blocked: string[];
}

/** Which open tickets are holding up other tickets, most-blocking first.
 *
 *  The high-value row here is `blockerDone: false` with several `blocked` keys:
 *  one unfinished ticket gating a queue of others is the highest-leverage thing
 *  a manager can unstick, and it is invisible on a board that shows tickets as
 *  a flat list. A blocker that is DONE while its dependants are still open is
 *  also reported, because that usually means nobody told them. */
export function blockerGraph(team: TeamSnapshot, limit = 12): BlockerEdge[] {
  const byKey = new Map(team.issues.map((i) => [i.key, i]));
  const edges = new Map<string, Set<string>>();
  for (const i of team.issues) {
    if (isDone(i)) continue;
    for (const b of i.blockedBy ?? []) {
      const set = edges.get(b) ?? new Set<string>();
      set.add(i.key);
      edges.set(b, set);
    }
  }
  return [...edges.entries()]
    .map(([blocker, blocked]) => {
      const issue = byKey.get(blocker);
      return {
        blocker,
        blockerSummary: issue?.summary,
        blockerStatus: issue?.status,
        blockerDone: issue ? isDone(issue) : false,
        blocked: [...blocked].sort(),
      };
    })
    .sort((a, b) => {
      if (a.blockerDone !== b.blockerDone) return a.blockerDone ? 1 : -1;
      return b.blocked.length - a.blocked.length || a.blocker.localeCompare(b.blocker);
    })
    .slice(0, limit);
}
