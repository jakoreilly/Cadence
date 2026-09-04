import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './snapshot.js';
import { mergeChangelogEntries } from './jira/changelog.js';
import { CHANGELOG_STORE_VERSION, type ChangelogEntry, type ChangelogStore } from './types.js';

// ---------------------------------------------------------------------------
// Reading and writing the changelog store.
//
// Deliberately NOT routed through writeSnapshot: that function's whole job is
// to refuse a second write for the same day, because a dated snapshot is a
// record of a day and restating it destroys what it recorded. This file is the
// opposite shape - one accumulating store per board, written on every run - and
// borrowing the snapshot writer would either fight the guard or teach it an
// exception.
//
// It DOES reuse writeJsonAtomic, because the temp-file-plus-rename reason
// applies identically: an interrupted run must not leave a store that parses
// as valid-but-truncated.
// ---------------------------------------------------------------------------

export function changelogPath(dataDir: string, profileName: string, boardId: number): string {
  return join(dataDir, profileName, 'changelog', `${boardId}.json`);
}

/** The store for one board, or an empty one. Never throws on a missing file -
 *  a board that has never been backfilled is a normal state, not an error. */
export function readChangelogStore(
  dataDir: string,
  profileName: string,
  boardId: number,
  teamKey: string,
): ChangelogStore {
  const path = changelogPath(dataDir, profileName, boardId);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ChangelogStore;
    // A store written by older code is READ, not rejected: entries are
    // append-only and every field added since is optional, so an old store is
    // simply a store with less in it. Its version is carried forward as-is
    // until this run's write stamps the current one.
    return parsed;
  }
  return {
    storeVersion: CHANGELOG_STORE_VERSION,
    boardId,
    teamKey,
    updatedAt: '',
    seen: {},
    entries: [],
  };
}

/** Appends to a store and writes it. Returns how many entries were genuinely
 *  new, which is the only figure the CLI should print - "fetched 1,892" says
 *  nothing about whether anything was learned. */
export function appendChangelog(
  dataDir: string,
  profileName: string,
  store: ChangelogStore,
  incoming: readonly ChangelogEntry[],
  seenUpdates: Readonly<Record<string, string>>,
  now: Date,
): { added: number; total: number } {
  const before = store.entries.length;
  const merged = mergeChangelogEntries(store.entries, incoming);
  const next: ChangelogStore = {
    ...store,
    storeVersion: CHANGELOG_STORE_VERSION,
    updatedAt: now.toISOString(),
    // Object spread, so an issue absent from this run keeps whatever it had.
    // A `seen` entry is never removed: it records that the issue's changelog
    // WAS read at that `updated`, and forgetting that would silently re-fetch
    // the whole board on the next run.
    seen: { ...store.seen, ...seenUpdates },
    entries: merged,
  };
  const path = changelogPath(dataDir, profileName, store.boardId);
  mkdirSync(join(dataDir, profileName, 'changelog'), { recursive: true });
  writeJsonAtomic(path, next);
  return { added: merged.length - before, total: merged.length };
}
