import { isDone } from './quality.js';
import type { IssueSnapshot, TeamSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Epic rollups: what larger piece of work is each sprint actually advancing,
// and what is queued behind it.
//
// A sprint reported as "73 issues, 198 points" says nothing about whether the
// team is finishing one thing or making 1% progress on eleven. The epic is the
// unit senior management already thinks in, and it is the one this report was
// missing entirely.
//
// Everything here is a pure function of one snapshot. The percentages are
// COUNTS OF ISSUES, never a claim about how much of the epic's value is done -
// see the GOTCHA on `progress`.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** The bucket for work with no epic. Deliberately not filtered out: on several
 *  boards here it is the LARGEST bucket, and hiding it would make the epic
 *  panel a description of a minority of the sprint that reads as a description
 *  of all of it. */
export const NO_EPIC = '(no epic)';

export interface EpicSlice {
  issues: number;
  points: number;
  doneIssues: number;
  donePoints: number;
}

export interface EpicRollup {
  key: string;
  /** The epic's name where the board supplied one, otherwise the key. */
  name: string;
  /** False when the name had to fall back to the key - schema-3 snapshots have
   *  no epic list, and the UI says so rather than implying the epic is called
   *  "WEB-42". */
  nameKnown: boolean;
  /** The epic itself is marked done on the board. */
  epicDone: boolean;
  active: EpicSlice;
  backlog: EpicSlice;
  /** Everything on the board under this epic, sprint work and backlog alike. */
  total: EpicSlice;
  /** Open items under this epic that are flagged or blocked by something open. */
  blocked: number;
  /** Open items under this epic that have been in three or more sprints. */
  carried: number;
  /** Distinct assignees on the epic's OPEN work, so a reader can see whether an
   *  epic is one person's or the whole team's. */
  people: string[];
  /** Age of the oldest OPEN item, in days. An epic whose oldest open item is two
   *  years old is not in progress; it is a label on a pile. */
  oldestOpenDays: number | null;
  /** Share of this epic's issues on the board that are done, 0..1.
   *
   *  GOTCHA: this is a count of ISSUES, not of points and not of value, and it
   *  is over the issues VISIBLE ON THIS BOARD. Work under the same epic sitting
   *  on another board is invisible here, so a rollup can read 100% while the
   *  epic is half finished elsewhere. It is a progress hint, never a completion
   *  claim, and it is labelled as such wherever it is drawn. */
  progress: number | null;
}

const emptySlice = (): EpicSlice => ({ issues: 0, points: 0, doneIssues: 0, donePoints: 0 });

function add(slice: EpicSlice, issue: IssueSnapshot): void {
  slice.issues++;
  slice.points += issue.storyPoints ?? 0;
  if (isDone(issue)) {
    slice.doneIssues++;
    slice.donePoints += issue.storyPoints ?? 0;
  }
}

/** Which epic an issue belongs to.
 *
 *  The Epic Link custom field is the primary source on this site because every
 *  project is company-managed, but `parent` is checked as a fallback: a
 *  team-managed project (or a next-gen import) carries the epic on `parent`
 *  with no Epic Link at all, and reading only the custom field files all of that
 *  work under "(no epic)". The parent is only accepted when it really is an
 *  epic, otherwise a sub-task would be rolled up under its story. */
export function epicKeyOf(issue: IssueSnapshot, epicKeys: Set<string>): string {
  if (issue.epicKey) return issue.epicKey;
  if (issue.parentKey && epicKeys.has(issue.parentKey)) return issue.parentKey;
  return NO_EPIC;
}

export interface EpicRollupResult {
  rollups: EpicRollup[];
  /** False on a snapshot collected before epic names were captured. */
  namesCollected: boolean;
}

export function epicRollups(team: TeamSnapshot, now: Date): EpicRollupResult {
  const epics = team.epics ?? [];
  const byKey = new Map(epics.map((e) => [e.key, e]));

  // Epic-typed issues, indexed once. `get()` below used to recover this with
  // `team.issues.find(...)`, a full board scan for every distinct epic key: a
  // board with 200 epics and 8,556 issues spent 1.7M comparisons rediscovering
  // what one pass already knows. The same map also supplies `epicKeys`, so the
  // board is walked once here rather than twice.
  const epicIssueByKey = new Map<string, IssueSnapshot>();
  const openBlockedBy = new Set<string>();
  for (const i of team.issues) {
    if (i.issueType.toLowerCase() === 'epic') epicIssueByKey.set(i.key, i);
    if (!isDone(i)) openBlockedBy.add(i.key);
  }

  // An epic can also appear as an ordinary issue on the board; both routes are
  // accepted so `parentKey` resolution still works on a schema-3 snapshot.
  const epicKeys = new Set<string>([...byKey.keys(), ...epicIssueByKey.keys()]);

  const activeIds = new Set(team.sprints.filter((s) => s.state === 'active').map((s) => s.id));

  const acc = new Map<string, EpicRollup>();
  const get = (key: string): EpicRollup => {
    let r = acc.get(key);
    if (!r) {
      const e = byKey.get(key);
      const asIssue = epicIssueByKey.get(key);
      r = {
        key,
        name: e?.name ?? asIssue?.summary ?? key,
        nameKnown: Boolean(e?.name ?? asIssue?.summary) || key === NO_EPIC,
        epicDone: e?.done ?? (asIssue ? isDone(asIssue) : false),
        active: emptySlice(),
        backlog: emptySlice(),
        total: emptySlice(),
        blocked: 0,
        carried: 0,
        people: [],
        oldestOpenDays: null,
        progress: null,
      };
      acc.set(key, r);
    }
    return r;
  };

  const peopleByEpic = new Map<string, Set<string>>();

  for (const issue of team.issues) {
    // The epic issue itself is not counted as work under its own epic - it
    // would add a phantom item to every rollup and shift the progress figure.
    if (epicKeys.has(issue.key)) continue;
    const key = epicKeyOf(issue, epicKeys);
    const r = get(key);
    add(r.total, issue);
    if (issue.sprintIds.some((id) => activeIds.has(id))) add(r.active, issue);
    if (issue.inBacklog) add(r.backlog, issue);

    if (!isDone(issue)) {
      const blockedByOpen = (issue.blockedBy ?? []).some((k) => openBlockedBy.has(k));
      if (issue.flagged || blockedByOpen) r.blocked++;
      if (issue.sprintIds.length >= 3) r.carried++;
      const created = Date.parse(issue.created);
      if (Number.isFinite(created)) {
        const age = (now.getTime() - created) / DAY;
        if (r.oldestOpenDays === null || age > r.oldestOpenDays) r.oldestOpenDays = age;
      }
      if (issue.assignee?.displayName) {
        const set = peopleByEpic.get(key) ?? new Set<string>();
        set.add(issue.assignee.displayName);
        peopleByEpic.set(key, set);
      }
    }
  }

  for (const [key, r] of acc) {
    r.people = [...(peopleByEpic.get(key) ?? [])].sort();
    r.progress = r.total.issues > 0 ? r.total.doneIssues / r.total.issues : null;
  }

  // Ordered by what the team is working on RIGHT NOW, then by what is queued.
  // Not by size: the biggest epic on a long-lived board is usually a closed one
  // with 400 issues under it, and putting that first buries the sprint.
  const rollups = [...acc.values()].sort(
    (a, b) =>
      b.active.issues - a.active.issues ||
      b.active.points - a.active.points ||
      b.backlog.issues - a.backlog.issues ||
      a.key.localeCompare(b.key),
  );

  return { rollups, namesCollected: epics.length > 0 };
}

/** Epics the active sprint is advancing. */
export function activeEpics(result: EpicRollupResult): EpicRollup[] {
  return result.rollups.filter((r) => r.active.issues > 0);
}

/** Epics with nothing in the sprint but something queued - the pipeline. */
export function backlogEpics(result: EpicRollupResult): EpicRollup[] {
  return result.rollups
    .filter((r) => r.active.issues === 0 && r.backlog.issues > 0)
    .sort((a, b) => b.backlog.issues - a.backlog.issues || a.key.localeCompare(b.key));
}

/** How spread the sprint is across epics.
 *
 *  A sprint touching nine epics with two issues each is a different management
 *  problem from one finishing two epics, and neither shows up in a points
 *  total. Reported as a plain count with the largest share beside it rather
 *  than as an index, because an index invites an argument about the index. */
export function sprintFocus(result: EpicRollupResult): { epics: number; largestShare: number | null; largestKey?: string } {
  const active = activeEpics(result);
  const total = active.reduce((a, r) => a + r.active.issues, 0);
  if (total === 0) return { epics: 0, largestShare: null };
  const largest = active.reduce((a, r) => (r.active.issues > a.active.issues ? r : a), active[0]!);
  return { epics: active.length, largestShare: largest.active.issues / total, largestKey: largest.key };
}

// ---------------------------------------------------------------------------
// Across the estate: one epic, every board it appears on.
//
// This closes the gap the per-board GOTCHA on `EpicRollup.progress` names and
// then cannot do anything about: an epic's progress is counted over the issues
// VISIBLE ON ONE BOARD, so a rollup reads 100% while half the epic sits on a
// board the reader is not looking at. Rolled up across every collected board
// the same epic key becomes one row with its real spread, and "this epic is
// finished" becomes a claim that can be checked rather than an artefact of
// which tab was open.
//
// It is still not a claim about the whole epic. Work on a board this profile
// does not collect is as invisible here as it was before, and that is stated
// in the panel rather than implied away.
// ---------------------------------------------------------------------------

/** One epic, as it appears across every collected board. */
export interface EstateEpic {
  key: string;
  name: string;
  nameKnown: boolean;
  /** Boards carrying issues under this epic, most work first.
   *
   *  Deliberately a SUMMARY per board rather than the whole EpicRollup. The
   *  full rollup is already in `teams[].epics` of the report payload, and
   *  carrying it a second time here cost 438 KB on a four-board
   *  snapshot - a tenth of the file - to duplicate data the reader already
   *  had. Everything this view needs is the board's name and how much of the
   *  epic sits on it. */
  teams: Array<{ team: string; issues: number; doneIssues: number; activeIssues: number; backlogIssues: number }>;
  /** Summed across boards. ISSUE counts only - points are deliberately absent
   *  from this shape, because a point on one board is not a point on another
   *  and an epic total that adds them is the one number on this page somebody
   *  would quote to a steering committee. */
  issues: number;
  doneIssues: number;
  activeIssues: number;
  backlogIssues: number;
  /** A PARTITION of `issues`, so a stacked bar of the four adds to the whole
   *  and nothing is double-counted.
   *
   *  Why these and not `activeIssues`/`backlogIssues` directly: those two
   *  include their own done items, so stacking them beside `doneIssues` counts
   *  the same finished ticket twice and produces a bar longer than the epic.
   *  The arithmetic is done here rather than in the renderer because the report
   *  layer is not allowed to compute a figure the CLI did not - see the header
   *  of report/index.ts. */
  activeOpenIssues: number;
  backlogOpenIssues: number;
  /** Open, and neither in an active sprint nor on a backlog: closed sprints,
   *  or scopes this board does not surface. Usually small, occasionally the
   *  whole story. */
  openElsewhere: number;
  blocked: number;
  carried: number;
  /** Distinct people on the epic's open work, across boards. */
  people: string[];
  oldestOpenDays: number | null;
  /** Done issues over total issues across boards, 0..1, or null when there is
   *  nothing to divide. Still a count of issues on COLLECTED boards - a
   *  progress hint, never a completion claim. */
  progress: number | null;
  /** True when more than one collected board carries work under this epic. The
   *  finding: nobody's board view shows this epic whole. */
  crossTeam: boolean;
}

export interface EstateEpicResult {
  epics: EstateEpic[];
  /** Epics appearing on more than one board. */
  crossTeamCount: number;
  /** False when any contributing board's snapshot had no epic list, so some
   *  names on this page are keys. */
  namesCollected: boolean;
  boardsCovered: number;
}

/** Roll per-board epic results up by epic key.
 *
 *  The `(no epic)` bucket is EXCLUDED here, unlike in the per-board rollup
 *  where it is deliberately kept. Per board it is a real and often dominant
 *  finding - most of this sprint is unfiled. Rolled up across four boards it
 *  becomes one meaningless row summing four unrelated piles of unfiled work,
 *  and it would sort to the top of every ordering on this page. The per-board
 *  panels still report it. */
export function estateEpics(
  teams: Array<{ key: string; epics?: EpicRollupResult }>,
  limit?: number,
): EstateEpicResult {
  const acc = new Map<string, EstateEpic>();
  let boardsCovered = 0;
  let namesCollected = true;

  for (const t of teams) {
    if (!t.epics) continue;
    boardsCovered++;
    if (!t.epics.namesCollected) namesCollected = false;
    for (const r of t.epics.rollups) {
      if (r.key === NO_EPIC) continue;
      let e = acc.get(r.key);
      if (!e) {
        e = {
          key: r.key,
          name: r.name,
          nameKnown: r.nameKnown,
          teams: [],
          issues: 0,
          doneIssues: 0,
          activeIssues: 0,
          backlogIssues: 0,
          activeOpenIssues: 0,
          backlogOpenIssues: 0,
          openElsewhere: 0,
          blocked: 0,
          carried: 0,
          people: [],
          oldestOpenDays: null,
          progress: null,
          crossTeam: false,
        };
        acc.set(r.key, e);
      }
      // The first board that KNOWS the name supplies it. A board whose snapshot
      // predates epic collection falls back to the key, and letting that
      // overwrite a real name from another board would lose it for no reason.
      if (!e.nameKnown && r.nameKnown) {
        e.name = r.name;
        e.nameKnown = true;
      }
      e.teams.push({
        team: t.key,
        issues: r.total.issues,
        doneIssues: r.total.doneIssues,
        activeIssues: r.active.issues,
        backlogIssues: r.backlog.issues,
      });
      e.issues += r.total.issues;
      e.doneIssues += r.total.doneIssues;
      e.activeIssues += r.active.issues;
      e.backlogIssues += r.backlog.issues;
      e.activeOpenIssues += r.active.issues - r.active.doneIssues;
      e.backlogOpenIssues += r.backlog.issues - r.backlog.doneIssues;
      e.blocked += r.blocked;
      e.carried += r.carried;
      for (const p of r.people) if (!e.people.includes(p)) e.people.push(p);
      if (r.oldestOpenDays !== null) {
        e.oldestOpenDays = e.oldestOpenDays === null ? r.oldestOpenDays : Math.max(e.oldestOpenDays, r.oldestOpenDays);
      }
    }
  }

  const epics = [...acc.values()];
  for (const e of epics) {
    e.progress = e.issues > 0 ? e.doneIssues / e.issues : null;
    // Whatever the other three buckets do not account for. Clamped at zero
    // rather than allowed to go negative: the three sources are independent
    // per-board counts and an inconsistent snapshot must not produce a bar
    // that reads as work in a nonsensical state.
    e.openElsewhere = Math.max(0, e.issues - e.doneIssues - e.activeOpenIssues - e.backlogOpenIssues);
    e.crossTeam = e.teams.length > 1;
    e.people.sort();
    e.teams.sort((a, b) => b.issues - a.issues || a.team.localeCompare(b.team));
  }

  // Cross-team epics first: they are the rows no single board view can show,
  // which is the entire reason to look at this panel rather than a team tab.
  // Then by how much of the estate's current sprint work they carry.
  epics.sort(
    (a, b) =>
      Number(b.crossTeam) - Number(a.crossTeam) ||
      b.activeIssues - a.activeIssues ||
      b.issues - a.issues ||
      a.key.localeCompare(b.key),
  );

  return {
    epics: limit ? epics.slice(0, limit) : epics,
    crossTeamCount: epics.filter((e) => e.crossTeam).length,
    namesCollected,
    boardsCovered,
  };
}
