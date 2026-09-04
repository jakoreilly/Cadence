import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { listSnapshotDates, snapshotDate, snapshotDir } from './snapshot.js';

// ---------------------------------------------------------------------------
// Retention for data/, which is deliberately NOT gitignored - the snapshot
// history is the asset - and grows by roughly a collected day forever: about
// 27 MB/day across four boards on this estate, ~10 GB/year. Nothing here
// deletes a day. The whole reason daily collection exists is that a day
// cannot be backfilled once it is gone, so retention here means SHRINKING an
// old day, never removing it.
//
// Compressed IN PLACE - `jira.json` becomes `jira.json.gz` inside the SAME
// dated directory - rather than moved to a separate archive tree. Moving a
// day out of data/<profile>/<date>/ would make it invisible to
// listSnapshotDates, and `trends`'s forecast window and `history`'s series
// both deliberately look back months; a "retention" feature that silently
// shortened their own history out from under them would be exactly the kind
// of quiet behaviour change this codebase's other conventions exist to
// prevent. `readSnapshot` in snapshot.ts transparently falls back to the .gz
// form, so every command that reads history keeps working unchanged - this
// file only ever makes an already-collected day smaller on disk.
// ---------------------------------------------------------------------------

const SNAPSHOT_NAMES = ['jira', 'gitlab', 'context'] as const;

/** Which collected dates are old enough to compress, in the order
 *  `listSnapshotDates` already returns them (oldest first).
 *
 *  Pure: the cutoff is a plain YYYY-MM-DD string the caller computes from its
 *  own clock, so the decision is testable without a filesystem or a Date. */
export function datesToArchive(dates: readonly string[], cutoffDate: string): string[] {
  return dates.filter((d) => d < cutoffDate);
}

/** Gzips one snapshot file in place, atomically.
 *
 *  Returns null when there is nothing to do - no plain `.json` at this path,
 *  because it was never collected for this source or because an earlier run
 *  already archived it - so the caller can tell "compressed" from "nothing
 *  there" without a separate existence check of its own.
 *
 *  Same atomicity shape as writeJsonAtomic: the compressed form is written to
 *  a temp name and renamed over the real one BEFORE the source is removed, so
 *  an interruption between the steps never leaves neither form on disk - the
 *  worst case is both existing at once, which readSnapshot's plain-first
 *  lookup already resolves safely. */
export function compressSnapshotFile(path: string): { originalBytes: number; compressedBytes: number } | null {
  if (!existsSync(path)) return null;
  const original = readFileSync(path);
  const gz = gzipSync(original);
  const gzPath = `${path}.gz`;
  const tmp = `${gzPath}.tmp`;
  writeFileSync(tmp, gz);
  renameSync(tmp, gzPath);
  unlinkSync(path);
  return { originalBytes: original.length, compressedBytes: gz.length };
}

export interface ArchiveAction {
  date: string;
  name: (typeof SNAPSHOT_NAMES)[number];
  originalBytes: number;
  /** Undefined for a --dry-run action: nothing was actually compressed, so
   *  there is no compressed size yet to report. */
  compressedBytes?: number;
}

export interface ArchiveResult {
  cutoffDate: string;
  /** Every date old enough to qualify, whether or not there was anything left
   *  to compress in it. */
  dates: string[];
  actions: ArchiveAction[];
  /** Qualifying dates where every source was already compressed, or never
   *  collected - named so a second run reads as "nothing new to do" rather
   *  than as having silently done nothing. */
  alreadyArchived: string[];
}

/** Compresses every collected source older than `olderThanDays` for one
 *  profile. `--dry-run` reports what it would do - including the ORIGINAL
 *  size of each file, so the reader can see roughly what this would save -
 *  without touching disk. */
export function archiveProfile(
  dataDir: string,
  profileName: string,
  opts: { olderThanDays: number; now: Date; dryRun?: boolean },
): ArchiveResult {
  const cutoffDate = snapshotDate(new Date(opts.now.getTime() - opts.olderThanDays * 86_400_000));
  const dates = datesToArchive(listSnapshotDates(dataDir, profileName), cutoffDate);
  const actions: ArchiveAction[] = [];
  const alreadyArchived: string[] = [];

  for (const date of dates) {
    const dir = snapshotDir(dataDir, profileName, date);
    let didSomething = false;
    for (const name of SNAPSHOT_NAMES) {
      const path = join(dir, `${name}.json`);
      if (!existsSync(path)) continue;
      didSomething = true;
      if (opts.dryRun) {
        // statSync, never readFileSync: a dry run exists to touch nothing, and
        // reading the file to measure it reads roughly 27 MB per source per day.
        // Over a year of retained history that is ~10 GB off disk to print
        // numbers the directory entry already holds.
        actions.push({ date, name, originalBytes: statSync(path).size });
        continue;
      }
      const result = compressSnapshotFile(path);
      if (result) actions.push({ date, name, ...result });
    }
    if (!didSomething) alreadyArchived.push(date);
  }

  return { cutoffDate, dates, actions, alreadyArchived };
}

export function formatArchiveResult(result: ArchiveResult, dryRun: boolean): string[] {
  const out: string[] = [];
  out.push(`dates older than ${result.cutoffDate}: ${result.dates.length}`);
  if (result.actions.length === 0) {
    out.push(dryRun ? '  nothing to compress.' : '  nothing was compressed.');
  } else {
    const totalOriginal = result.actions.reduce((a, x) => a + x.originalBytes, 0);
    const totalCompressed = result.actions.reduce((a, x) => a + (x.compressedBytes ?? 0), 0);
    for (const a of result.actions) {
      out.push(
        `  ${a.date} ${a.name}.json  ${(a.originalBytes / 1024).toFixed(0)} KB` +
          (a.compressedBytes !== undefined ? ` -> ${(a.compressedBytes / 1024).toFixed(0)} KB` : ' (would compress)'),
      );
    }
    out.push(
      dryRun
        ? `  ${(totalOriginal / 1024 / 1024).toFixed(1)} MB across ${result.actions.length} file(s) would be compressed.`
        : `  ${(totalOriginal / 1024 / 1024).toFixed(1)} MB -> ${(totalCompressed / 1024 / 1024).toFixed(1)} MB across ${result.actions.length} file(s).`,
    );
  }
  if (result.alreadyArchived.length > 0) {
    out.push(`  ${result.alreadyArchived.length} date(s) already fully archived: ${result.alreadyArchived.join(', ')}`);
  }
  return out;
}
