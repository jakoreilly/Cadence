import { sprintsInOrder } from '../derive.js';
import type { ChangelogEntry, ChangelogItem, FieldMap, SprintSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Pure changelog handling: what to ask Jira for, and how to read what comes
// back. Nothing here touches the network or the disk, which is the whole
// reason it is a separate module from changelogStore.ts.
// ---------------------------------------------------------------------------

/** Jira-native field ids whose history this tool reads.
 *
 *  These three are the only ones with fixed ids; everything else worth keeping
 *  is a CUSTOM field whose id differs per site, and is therefore taken from the
 *  discovered FieldMap rather than named here. That is the same rule the rest
 *  of the collector follows - see docs/decisions.md, "Field ids are discovered,
 *  never hardcoded". */
const NATIVE_FIELDS = ['status', 'resolution', 'assignee'] as const;

/** The fields whose changes are kept, for this site.
 *
 *  This is THE cap on store size, and it is the cheap one: the bulk of a Jira
 *  changelog is `Rank` (every drag on the board), `description`, `attachment`,
 *  `labels` and `Link`, none of which any metric here reads. Filtering to these
 *  six removes roughly four fifths of the entries and loses nothing.
 *
 *  Story points is a LIST because this site has two candidate fields and which
 *  one a board uses is discovered, not known - see readStoryPoints. */
export function keptFields(map: FieldMap): ReadonlySet<string> {
  const out = new Set<string>(NATIVE_FIELDS);
  if (map.sprint) out.add(map.sprint);
  if (map.flagged) out.add(map.flagged);
  for (const id of map.storyPoints) out.add(id);
  return out;
}

/** Normalises one raw changelog item. Returns null for a field not being kept.
 *
 *  GOTCHA: match on `fieldId` FIRST and fall back to `field`. Jira sends
 *  `fieldId` for native fields and for custom fields, but omits it on some
 *  older records, where only the display `field` name survives - and a custom
 *  field's display name ("Sprint", "Story Points") is what a site administrator
 *  can rename at any time. Matching the id where it exists means a rename
 *  cannot silently empty the store. */
export function normaliseChangelogItem(raw: unknown, kept: ReadonlySet<string>): ChangelogItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fieldName = typeof o.field === 'string' ? o.field : '';
  const fieldId = typeof o.fieldId === 'string' && o.fieldId.length > 0 ? o.fieldId : fieldName;
  if (!fieldId || !kept.has(fieldId)) return null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    field: fieldId,
    fieldName,
    fromId: str(o.from),
    toId: str(o.to),
    fromName: str(o.fromString),
    toName: str(o.toString),
  };
}

/** Normalises one raw changelog history record.
 *
 *  Returns null when nothing survived the field filter - an entry whose only
 *  change was a Rank drag is not worth a row, and keeping it would defeat the
 *  filter. */
export function normaliseChangelogEntry(
  raw: unknown,
  issueKey: string,
  kept: ReadonlySet<string>,
  keepIndividuals: boolean,
): ChangelogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.id === undefined || o.id === null) return null;
  const created = typeof o.created === 'string' ? o.created : '';
  if (!created) return null;

  const rawItems: unknown[] = Array.isArray(o.items) ? o.items : [];
  const items: ChangelogItem[] = [];
  for (const it of rawItems) {
    const item = normaliseChangelogItem(it, kept);
    if (item) items.push(item);
  }
  if (items.length === 0) return null;

  const entry: ChangelogEntry = { id: String(o.id), issueKey, created, items };

  // Hard constraint 1: with individualAttribution off, the author fields are
  // ABSENT rather than blanked. Mirrors toPerson in jira/collect.ts, which
  // returns undefined rather than a redacted object.
  if (keepIndividuals && o.author && typeof o.author === 'object') {
    const a = o.author as Record<string, unknown>;
    if (typeof a.accountId === 'string') entry.authorAccountId = a.accountId;
    if (typeof a.displayName === 'string') entry.authorName = a.displayName;
  }
  return entry;
}

/** The sprints whose issues are in scope for changelog collection.
 *
 *  Bound to the SAME window the delivery forecast uses, on purpose and as a
 *  single argument rather than a second config knob: `trends` forecasts over the
 *  last N closed sprints (N defaults to 12), and a changelog window narrower
 *  than that would put two panels on one page disagreeing about how much history
 *  exists. See DEFAULT_SPRINT_WINDOW in derive.ts.
 *
 *  Active and future sprints are ALWAYS included regardless of the window -
 *  they are the sprint being managed right now, and board 705 runs six
 *  concurrent active sprints. */
export function changelogSprintIds(sprints: readonly SprintSnapshot[], window: number): Set<number> {
  const ordered = sprintsInOrder([...sprints]);
  const closed = ordered.filter((s) => s.state === 'closed');
  const recentClosed = window >= closed.length ? closed : closed.slice(closed.length - window);
  const live = ordered.filter((s) => s.state === 'active' || s.state === 'future');
  return new Set([...recentClosed, ...live].map((s) => s.id));
}

/** Issues in scope: those in one of the sprints above.
 *
 *  Measured on 2026-09-03 at window 12: 350 / 310 / 909 / 323 issues across the
 *  four boards - 1,892 of 20,769. That ratio is why the window exists. */
export function changelogScope<T extends { key: string; updated: string; sprintIds: number[] }>(
  team: { sprints: SprintSnapshot[]; issues: readonly T[] },
  window: number,
): T[] {
  const ids = changelogSprintIds(team.sprints, window);
  return team.issues.filter((i) => i.sprintIds.some((id) => ids.has(id)));
}

/** Which of the in-scope issues actually need a fetch.
 *
 *  An issue whose `updated` has not moved since its changelog was last read
 *  cannot have gained an entry, so it is skipped. This is what makes a daily
 *  run cheap enough to use the paginated per-issue endpoint at all: the first
 *  run fetches ~1,892 issues, and every run after it fetches the handful that
 *  moved.
 *
 *  Returned in a STABLE order (by key) rather than in board order, so a run
 *  interrupted at issue 400 resumes over the same sequence and the store grows
 *  monotonically instead of in an order that depends on the board's rank field. */
export function issuesNeedingChangelog(
  issues: ReadonlyArray<{ key: string; updated: string }>,
  seen: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const i of issues) {
    const last = seen[i.key];
    if (last === undefined || last < i.updated) out.push(i.key);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Folds newly fetched entries into the ones already held.
 *
 *  Append-only: an entry already present is kept as it is, and the incoming
 *  copy is discarded rather than overwriting it. Dedupe is on Jira's history
 *  `id`, which is unique and stable, so a re-fetch of an issue is free.
 *
 *  Sorted by (created, id) so the file is deterministic and diffable - two runs
 *  that saw the same events produce the same bytes regardless of fetch order,
 *  which matters because `data/` is committed. */
export function mergeChangelogEntries(
  existing: readonly ChangelogEntry[],
  incoming: readonly ChangelogEntry[],
): ChangelogEntry[] {
  const byId = new Map<string, ChangelogEntry>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}
