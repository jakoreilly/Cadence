import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveProfile, compressSnapshotFile, datesToArchive, formatArchiveResult } from '../src/archive.js';
import { clearSnapshotCache, readSnapshot, snapshotDir, writeSnapshot } from '../src/snapshot.js';

// --- datesToArchive ------------------------------------------------------------

test('datesToArchive keeps only dates strictly before the cutoff', () => {
  assert.deepEqual(
    datesToArchive(['2026-05-01', '2026-06-01', '2026-07-01'], '2026-06-15'),
    ['2026-05-01', '2026-06-01'],
  );
});

test('datesToArchive is empty when nothing qualifies yet', () => {
  assert.deepEqual(datesToArchive(['2026-08-26', '2026-08-27'], '2026-05-01'), []);
});

// --- compressSnapshotFile -------------------------------------------------------

test('compressSnapshotFile replaces the plain file with a .gz and reports both sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'to-archive-'));
  const path = join(dir, 'jira.json');
  // Repetitive enough to actually compress - real snapshots are thousands of
  // near-identical issue records, so a tiny hand-written fixture would not be
  // representative of what this exists to shrink.
  const issues = Array.from({ length: 500 }, (_, i) => ({ key: `WEB-${i}`, status: 'In Progress', storyPoints: 3 }));
  writeSnapshot(dir, 'jira', { teams: [{ key: 't', issues }] });

  const result = compressSnapshotFile(path);
  assert.ok(result);
  assert.ok(result!.compressedBytes < result!.originalBytes);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.gz`), true);
  assert.equal(existsSync(`${path}.gz.tmp`), false);
});

test('compressSnapshotFile is a no-op, not an error, when there is nothing to compress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'to-archive-'));
  assert.equal(compressSnapshotFile(join(dir, 'gitlab.json')), null);
});

// --- readSnapshot .gz fallback ---------------------------------------------------

test('readSnapshot transparently reads an archived (compressed) day', () => {
  clearSnapshotCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'to-gz-'));
  const dir = snapshotDir(dataDir, 'p', '2026-05-01');
  writeSnapshot(dir, 'jira', { teams: [{ key: 't' }] });
  compressSnapshotFile(join(dir, 'jira.json'));

  assert.deepEqual(readSnapshot<{ teams: unknown[] }>(dataDir, 'p', '2026-05-01', 'jira'), { teams: [{ key: 't' }] });
});

test('writeSnapshot refuses to overwrite an already-archived day without --force', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'to-gz-guard-'));
  const dir = snapshotDir(dataDir, 'p', '2026-05-01');
  writeSnapshot(dir, 'jira', { teams: [] });
  compressSnapshotFile(join(dir, 'jira.json'));

  assert.throws(() => writeSnapshot(dir, 'jira', { teams: ['new'] }), /already exists/);
});

// --- archiveProfile ---------------------------------------------------------------

test('archiveProfile compresses only qualifying dates, and only sources actually present', () => {
  clearSnapshotCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'to-archive-profile-'));
  writeSnapshot(snapshotDir(dataDir, 'p', '2026-05-01'), 'jira', { teams: [] });
  writeSnapshot(snapshotDir(dataDir, 'p', '2026-08-26'), 'jira', { teams: [] });
  writeSnapshot(snapshotDir(dataDir, 'p', '2026-08-26'), 'gitlab', { teams: [] });

  const result = archiveProfile(dataDir, 'p', { olderThanDays: 30, now: new Date('2026-08-27T06:00:00.000Z') });
  assert.deepEqual(result.dates, ['2026-05-01']);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]!.name, 'jira');
  assert.equal(result.actions[0]!.compressedBytes! > 0, true);
  assert.equal(existsSync(join(snapshotDir(dataDir, 'p', '2026-05-01'), 'jira.json')), false);
  // Recent day untouched, both sources still plain.
  assert.equal(existsSync(join(snapshotDir(dataDir, 'p', '2026-08-26'), 'jira.json')), true);
});

test('archiveProfile --dry-run reports sizes without touching disk', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'to-archive-dry-'));
  writeSnapshot(snapshotDir(dataDir, 'p', '2026-05-01'), 'jira', { teams: [] });

  const result = archiveProfile(dataDir, 'p', { olderThanDays: 30, now: new Date('2026-08-27T06:00:00.000Z'), dryRun: true });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]!.compressedBytes, undefined);
  assert.equal(existsSync(join(snapshotDir(dataDir, 'p', '2026-05-01'), 'jira.json')), true);
  assert.equal(existsSync(join(snapshotDir(dataDir, 'p', '2026-05-01'), 'jira.json.gz')), false);
});

test('a date with nothing left to compress is named, not silently skipped', () => {
  clearSnapshotCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'to-archive-repeat-'));
  writeSnapshot(snapshotDir(dataDir, 'p', '2026-05-01'), 'jira', { teams: [] });

  const opts = { olderThanDays: 30, now: new Date('2026-08-27T06:00:00.000Z') };
  archiveProfile(dataDir, 'p', opts);
  const second = archiveProfile(dataDir, 'p', opts);
  assert.deepEqual(second.alreadyArchived, ['2026-05-01']);
  assert.equal(second.actions.length, 0);
});

test('formatArchiveResult reports nothing-to-do plainly', () => {
  const text = formatArchiveResult({ cutoffDate: '2026-05-01', dates: [], actions: [], alreadyArchived: [] }, false);
  assert.ok(text.some((l) => l.includes('nothing was compressed')));
});
