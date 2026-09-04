import { columnResolver } from './flow.js';
import type { ChangelogEntry } from './types.js';

// ---------------------------------------------------------------------------
// Reading history out of the changelog store.
//
// Everything here is keyed on status IDS, never on status names. That is not
// fastidiousness: status names on this site are heavily customised - "Product
// Owner Review" sits in the To Do category - so a metric keyed on the name is
// simply wrong, and the board's own column configuration carries statusIds.
// See docs/decisions.md and columnResolver in flow.ts.
//
// A name is used in exactly one place, `resolveStatusId`, as a fallback for
// entries where Jira did not supply the id - and every such use is COUNTED and
// reported, because a fallback nobody can see the rate of is an assumption
// dressed as a measurement.
// ---------------------------------------------------------------------------

/** Maps a status display name to its id, for the fallback path only.
 *
 *  Safe on this estate and verified rather than assumed: measured on
 *  2026-09-03, zero status names mapped to more than one statusId on any of the
 *  four boards. `ambiguous` reports the ones that do, so a board where it stops
 *  being true says so instead of silently picking one.
 *
 *  Built from the issues present in a snapshot rather than from the board
 *  column config, because a status can exist on issues without being on any
 *  column ('(not on the board)' is a real state here). */
export function statusNameIndex(
  issues: ReadonlyArray<{ status: string; statusId?: string }>,
): { byName: Map<string, string>; ambiguous: string[] } {
  const seen = new Map<string, Set<string>>();
  for (const i of issues) {
    if (!i.statusId) continue;
    const set = seen.get(i.status) ?? new Set<string>();
    set.add(i.statusId);
    seen.set(i.status, set);
  }
  const byName = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const [name, ids] of seen) {
    if (ids.size === 1) byName.set(name, [...ids][0]!);
    else ambiguous.push(name);
  }
  return { byName, ambiguous: ambiguous.sort() };
}

/** How often the name fallback was needed. Carried onto every result that used
 *  it, so a caller can label the figure rather than trust it silently. */
export interface ResolutionStats {
  /** Transitions resolved from Jira's own id. */
  byId: number;
  /** Transitions resolved by matching the display NAME. */
  byName: number;
  /** Transitions that could not be resolved at all and were DROPPED. */
  unresolved: number;
  /** Status names that map to more than one id on this board. */
  ambiguousNames: string[];
}

export function emptyResolutionStats(): ResolutionStats {
  return { byId: 0, byName: 0, unresolved: 0, ambiguousNames: [] };
}

/** One observed status transition, with both sides as ids. */
export interface StatusTransition {
  issueKey: string;
  at: string;
  fromStatusId: string | null;
  toStatusId: string;
}

/** Pulls every resolvable status transition out of the store, oldest first.
 *
 *  Mutates `stats` rather than returning a second value, so a caller
 *  accumulating across several boards gets one set of totals without adding
 *  them up itself. */
export function statusTransitions(
  entries: readonly ChangelogEntry[],
  index: { byName: Map<string, string>; ambiguous: string[] },
  stats: ResolutionStats,
): StatusTransition[] {
  stats.ambiguousNames = index.ambiguous;
  const out: StatusTransition[] = [];
  for (const entry of entries) {
    for (const item of entry.items) {
      if (item.field !== 'status') continue;
      const to = resolveStatusId(item.toId, item.toName, index, stats);
      if (to === null) continue;
      out.push({
        issueKey: entry.issueKey,
        at: entry.created,
        // The FROM side is best-effort and never counted in stats: no metric
        // here reads it, and an unresolvable `from` must not discard a
        // perfectly good `to`.
        fromStatusId: item.fromId ?? (item.fromName ? index.byName.get(item.fromName) ?? null : null),
        toStatusId: to,
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.issueKey.localeCompare(b.issueKey));
}

/** Id first, name second, give up third - and say which happened. */
export function resolveStatusId(
  id: string | null,
  name: string | null,
  index: { byName: Map<string, string> },
  stats: ResolutionStats,
): string | null {
  if (id !== null) {
    stats.byId++;
    return id;
  }
  if (name !== null) {
    const hit = index.byName.get(name);
    if (hit !== undefined) {
      stats.byName++;
      return hit;
    }
  }
  stats.unresolved++;
  return null;
}

/** The first moment each issue was observed in a column the board treats as
 *  work-in-progress - the real work-start.
 *
 *  This is what history.ts's `cycleTimes` reconstructs by walking consecutive
 *  snapshots and can only bound from below. Here it is a recorded fact with a
 *  timestamp, available for work that started years before collection began.
 *
 *  WIP is decided by the BOARD'S OWN COLUMNS, via columnResolver, not by the
 *  status category. That is the same rule wipSummary follows, and it matters:
 *  collapsing to categories buckets `Waiting development`, `In Development`,
 *  `In Review`, `waiting test` and `Test` into one queue called "In Progress".
 *
 *  Returns a Map rather than a list because every caller wants a lookup. */
export function firstWorkStart(
  transitions: readonly StatusTransition[],
  team: { columns: Array<{ name: string; statusIds: string[] }> },
  isWipColumn: (columnName: string) => boolean,
): Map<string, string> {
  const resolve = columnResolver(team);
  const out = new Map<string, string>();
  // Transitions arrive oldest-first from statusTransitions, so the first hit
  // per issue IS the earliest and no comparison is needed. Asserted in the
  // tests rather than assumed, because it is a cross-function contract.
  for (const t of transitions) {
    if (out.has(t.issueKey)) continue;
    const column = resolve({ status: '', statusId: t.toStatusId });
    if (!isWipColumn(column)) continue;
    out.set(t.issueKey, t.at);
  }
  return out;
}

/** Sprint ids an issue belonged to at a given instant, reconstructed backwards
 *  from its CURRENT membership through its Sprint-field changelog.
 *
 *  Backwards, not forwards, and that is the whole trick: the changelog is a
 *  list of deltas with no starting state, so replaying it forwards requires
 *  knowing membership before the first recorded change - which is exactly what
 *  is not recorded. Current membership IS known (issue.sprintIds), so the walk
 *  runs from now to then, undoing each change.
 *
 *  Undoing a Sprint change means replacing the post-state with the pre-state
 *  wholesale: Jira records the Sprint field as a complete value on both sides
 *  ("6145,5462" -> "6145"), not as an add/remove, so a set difference would be
 *  guesswork where an assignment is exact.
 *
 *  Returns null when the issue has NO Sprint changelog at all AND the instant
 *  is before the issue was created - i.e. when nothing can be said. Never
 *  returns an empty set to mean "unknown": an issue genuinely in no sprint is
 * an empty set, and the two must not read alike. */
export function sprintMembershipAt(
  issue: { key: string; created: string; sprintIds: number[] },
  entries: readonly ChangelogEntry[],
  atIso: string,
): Set<number> | null {
  if (atIso < issue.created) return null;

  let members = new Set<number>(issue.sprintIds);
  // Newest first: each step undoes one change, walking the state backwards.
  const sprintChanges = entries
    .filter((e) => e.issueKey === issue.key && e.items.some((i) => i.fieldName === 'Sprint' || i.field.startsWith('customfield_')))
    .sort((a, b) => b.created.localeCompare(a.created));

  for (const entry of sprintChanges) {
    // Only changes AFTER the instant of interest need undoing. The list is
    // newest-first, so the first one at or before `atIso` ends the walk.
    if (entry.created <= atIso) break;
    for (const item of entry.items) {
      if (item.fieldName !== 'Sprint') continue;
      members = parseSprintIdList(item.fromId);
    }
  }
  return members;
}

/** "6145,5462" -> {6145, 5462}. Empty or null -> the empty set.
 *
 *  GOTCHA: a null `fromId` means the issue was in NO sprint before the change -
 *  it came from the backlog - which is an empty set, not unknown. The caller
 *  distinguishes unknown by getting null from sprintMembershipAt itself. */
export function parseSprintIdList(raw: string | null): Set<number> {
  const out = new Set<number>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n)) out.add(n);
  }
  return out;
}
