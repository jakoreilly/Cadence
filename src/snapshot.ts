import { mkdirSync, writeFileSync, renameSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

/** The collection date, in UTC, as the YYYY-MM-DD directory name.
 *
 *  UTC and not local time on purpose: a scheduled run that straddles a DST
 *  change or moves between machines in different zones would otherwise write
 *  two snapshots for one day, or none, and the gap is invisible until a trend
 *  chart has a hole in it. */
export function snapshotDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function snapshotDir(dataDir: string, profileName: string, date: string): string {
  return join(dataDir, profileName, date);
}

/** Writes JSON via a temp file plus rename so an interrupted run can never
 *  leave a half-written snapshot that later parses as valid-but-truncated. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export class SnapshotExistsError extends Error {}

/** Writes one named snapshot into a dated directory.
 *
 *  GOTCHA: "written once, never rewritten" was convention only - this function
 *  overwrote an existing jira.json for the same UTC day without complaint, which
 *  is the one thing docs/decisions.md says must never happen: the history IS the
 *  product and a day cannot be backfilled once it is restated. A re-run of a
 *  scheduled collection after an afternoon of board activity would quietly
 *  replace the morning's record of that day. The guard lives here rather than in
 *  the CLI so no future caller can route around it. */
export function writeSnapshot(dir: string, name: string, value: unknown, opts: { force?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  // A day archive.ts has compressed still counts as existing: it is the same
  // recorded day, just smaller on disk, and writing a fresh plain .json next
  // to it would leave two representations of the day disagreeing about
  // nothing in particular but confusing readSnapshot's plain-first lookup.
  if (!opts.force && (existsSync(path) || existsSync(`${path}.gz`))) {
    throw new SnapshotExistsError(
      `${path} already exists. Snapshots are immutable - a day that has been collected cannot be ` +
        `restated without losing what it recorded. Re-run with --force if that is genuinely what you want.`,
    );
  }
  writeJsonAtomic(path, value);
  return path;
}

/** Every collected date for a profile, oldest first. This is the index the
 *  derive layer will walk to build trends, so it must never include the
 *  in-progress .tmp files or stray non-date directories. */
export function listSnapshotDates(dataDir: string, profileName: string): string[] {
  const root = join(dataDir, profileName);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

// Snapshots are immutable by design - writeSnapshot refuses to overwrite one
// without --force, and the callers that DO pass --force always read a path
// before they ever write it in the same run, never after (see collect in
// cli.ts). So caching a parsed file for the lifetime of this PROCESS is safe:
// nothing in this codebase re-reads a path expecting to see a write that
// happened later in the same run.
//
// This matters because `alert` reads every collected day's jira.json TWICE -
// once building today's feed, once building the previous day's - and the
// previous day's date range is a strict subset of today's. At 27 MB a day and
// 60 collected days, that was ~120 full JSON.parse passes for one run; with
// the cache it is ~60, because the second feed's whole read loop is a cache
// hit. `readSnapshot`'s callers already treat the result as read-only (see
// mergeCollectedTeams, which never mutates what it merges), so returning the
// same parsed object twice is safe.
const cache = new Map<string, unknown>();

/** Only POSITIVE reads are cached - a miss always re-checks the filesystem.
 *  `collect` checks for an already-written jira.json before its own write
 *  happens on the SAME date; caching that "not there yet" answer would be
 *  correct for every real call order today, but the cost of re-checking
 *  `existsSync` is negligible next to a 27 MB `JSON.parse`, so there is no
 *  reason to take on the risk for a saving that is not where the cost is.
 *
 *  Falls back to a `.gz` form transparently - archive.ts compresses old days
 *  IN PLACE rather than moving them anywhere, precisely so that every reader
 *  of history, this one included, keeps working unchanged against an archived
 *  day. */
export interface ReadSnapshotOptions {
  /** Keep the parsed value for the rest of the process. Default true.
   *
   *  Pass false when the caller is about to REDUCE what it read and does not
   *  want the original retained - the history layer reads every collected day and
   *  keeps ten fields per issue (see historyProjection), so caching the whole
   *  ~30 MB parse would defeat the projection entirely and is the difference
   *  between ~2 MB and ~56 MB of permanent heap per collected day. An uncached
   *  read is also not RECORDED, so a later cached read of the same path still
   *  populates the cache normally. */
  cache?: boolean;
}

export function readSnapshot<T>(
  dataDir: string,
  profileName: string,
  date: string,
  name: string,
  opts: ReadSnapshotOptions = {},
): T | null {
  const path = join(snapshotDir(dataDir, profileName, date), `${name}.json`);
  const keep = opts.cache !== false;
  const cached = cache.get(path);
  // A cache HIT is served even to an uncached read: the object is already
  // retained, so declining to return it would buy nothing and cost a re-parse.
  if (cached !== undefined) return cached as T;
  if (existsSync(path)) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as T;
    if (keep) cache.set(path, value);
    return value;
  }
  const gzPath = `${path}.gz`;
  if (existsSync(gzPath)) {
    const value = JSON.parse(gunzipSync(readFileSync(gzPath)).toString('utf8')) as T;
    if (keep) cache.set(path, value);
    return value;
  }
  return null;
}

/** Drops every cached read. Exists for tests that write, then overwrite, the
 *  same path within one process and need `readSnapshot` to see the second
 *  write - real callers never do this (see the note above `cache`). */
export function clearSnapshotCache(): void {
  cache.clear();
}
