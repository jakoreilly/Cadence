import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';
import { buildFieldMap, type JiraField } from '../src/jira/discover.js';
import { normaliseMergeRequest, parseIssueKeys } from '../src/gitlab/collect.js';
import { clearSnapshotCache, listSnapshotDates, readSnapshot, snapshotDate, writeJsonAtomic, writeSnapshot } from '../src/snapshot.js';

function profile(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-test-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

// --- config -----------------------------------------------------------------

test('loadConfig defaults individualAttribution to false', () => {
  const c = loadConfig(profile({ site: 's', teams: [{ key: 'a', boardId: 1 }] }));
  // Opt-in, so a profile written without thinking about it collects no
  // per-person data.
  assert.equal(c.individualAttribution, false);
  assert.equal(c.teams[0]?.enabled, true);
  assert.deepEqual(c.teams[0]?.gitlabGroups, []);
  assert.equal(c.gitlabWindowDays, 30);
});

test('loadConfig rejects a duplicate team key', () => {
  const dir = profile({ site: 's', teams: [{ key: 'a', boardId: 1 }, { key: 'a', boardId: 2 }] });
  assert.throws(() => loadConfig(dir), ConfigError);
});

test('loadConfig rejects a non-integer board id', () => {
  assert.throws(() => loadConfig(profile({ site: 's', teams: [{ key: 'a', boardId: '701' }] })), ConfigError);
});

test('loadConfig honours an explicit enabled:false only', () => {
  const c = loadConfig(profile({ site: 's', teams: [{ key: 'a', boardId: 1, enabled: false }] }));
  assert.equal(c.teams[0]?.enabled, false);
});

// --- field discovery --------------------------------------------------------

const FIELDS: JiraField[] = [
  { id: 'customfield_10001', name: 'Sprint', custom: true, schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  { id: 'customfield_10000', name: 'Rank', custom: true, schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
  { id: 'customfield_10002', name: 'Epic Link', custom: true, schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
  { id: 'customfield_10006', name: 'Story Points', custom: true, schema: { type: 'number' } },
  { id: 'customfield_11000', name: 'Story point estimate', custom: true, schema: { type: 'number' } },
  { id: 'customfield_11071', name: 'QA Estimate', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10400', name: 'Flagged', custom: true, schema: { type: 'array' } },
  { id: 'customfield_10500', name: 'Team', custom: true, schema: { type: 'any' } },
  { id: 'summary', name: 'Summary', custom: false },
];

test('buildFieldMap finds BOTH story-point fields and no unrelated number field', () => {
  const map = buildFieldMap(FIELDS, '2026-08-26T00:00:00.000Z');
  assert.deepEqual(map.storyPoints, ['customfield_10006', 'customfield_11000']);
  assert.equal(map.sprint, 'customfield_10001');
  assert.equal(map.rank, 'customfield_10000');
  assert.equal(map.epicLink, 'customfield_10002');
  assert.equal(map.flagged, 'customfield_10400');
  assert.equal(map.team, 'customfield_10500');
});

test('buildFieldMap identifies Sprint by schema, not by display name', () => {
  const renamed = FIELDS.map((f) => (f.id === 'customfield_10001' ? { ...f, name: 'Iteration' } : f));
  assert.equal(buildFieldMap(renamed, 'x').sprint, 'customfield_10001');
});

test('buildFieldMap fails loudly when no Sprint field is visible', () => {
  const without = FIELDS.filter((f) => f.id !== 'customfield_10001');
  assert.throws(() => buildFieldMap(without, 'x'), /No Sprint field/);
});

// --- gitlab -----------------------------------------------------------------

test('parseIssueKeys finds keys in the title and the branch', () => {
  assert.deepEqual(parseIssueKeys('WEB-1387 fix trace ids', 'feature/LOG-7553-thing'), ['LOG-7553', 'WEB-1387']);
});

test('parseIssueKeys requires a boundary before the key', () => {
  // Mid-token matches must not be picked up at all.
  assert.deepEqual(parseIssueKeys('deploy sha1RET-5 rollback', ''), []);
  assert.deepEqual(parseIssueKeys('', 'bugfix/WEB-1'), ['WEB-1']);
});

test('parseIssueKeys needs known project keys to reject a version string', () => {
  // "V2-3" is syntactically a valid Jira key, so the unfiltered parse keeps it.
  // Only the known-project-key filter can tell it apart from a real reference.
  assert.deepEqual(parseIssueKeys('bump to V2-3', ''), ['V2-3']);
  assert.deepEqual(parseIssueKeys('bump to V2-3', '', new Set(['WEB', 'LOG'])), []);
  assert.deepEqual(parseIssueKeys('WEB-1387 and V2-3', '', new Set(['WEB'])), ['WEB-1387']);
});

test('parseIssueKeys dedupes a key that appears in both title and branch', () => {
  assert.deepEqual(parseIssueKeys('WEB-1387 fix', 'WEB-1387-fix'), ['WEB-1387']);
});

test('normaliseMergeRequest reads draft from either field name', () => {
  const base = { id: 1, iid: 2, project_id: 3, title: 't', state: 'opened', created_at: 'a', updated_at: 'b', source_branch: 's', target_branch: 'main' };
  assert.equal(normaliseMergeRequest({ ...base, draft: true }, true).draft, true);
  // Older self-managed GitLab only sends work_in_progress.
  assert.equal(normaliseMergeRequest({ ...base, work_in_progress: true }, true).draft, true);
  assert.equal(normaliseMergeRequest(base, true).draft, false);
});

test('normaliseMergeRequest drops people when attribution is off', () => {
  const raw = {
    id: 1, iid: 2, project_id: 3, title: 't', state: 'opened', created_at: 'a', updated_at: 'b',
    source_branch: 's', target_branch: 'main',
    author: { id: 7, name: 'Dev One' },
    assignees: [{ id: 8, name: 'Dev Two' }],
    reviewers: [{ id: 9, name: 'Dev Three' }],
  };
  const mr = normaliseMergeRequest(raw, false);
  assert.equal(mr.author, undefined);
  assert.deepEqual(mr.assignees, []);
  assert.deepEqual(mr.reviewers, []);
  assert.ok(!JSON.stringify(mr).includes('Dev'));
});

// --- snapshots --------------------------------------------------------------

test('snapshotDate is UTC, not local', () => {
  // 00:30 Dublin summer time is still the previous UTC day; using local time
  // here would write two snapshot folders for one logical day.
  assert.equal(snapshotDate(new Date('2026-08-26T23:30:00.000Z')), '2026-08-26');
  assert.equal(snapshotDate(new Date('2026-08-27T00:30:00.000Z')), '2026-08-27');
});

test('listSnapshotDates returns only date directories, sorted', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'to-data-'));
  for (const d of ['2026-08-27', '2026-08-25', 'latest', 'notes.txt']) {
    mkdirSync(join(dataDir, 'p', d), { recursive: true });
  }
  assert.deepEqual(listSnapshotDates(dataDir, 'p'), ['2026-08-25', '2026-08-27']);
  assert.deepEqual(listSnapshotDates(dataDir, 'missing'), []);
});

test('readSnapshot does not re-read a path it has already parsed', () => {
  clearSnapshotCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'to-cache-'));
  const dir = join(dataDir, 'p', '2026-08-27');
  writeSnapshot(dir, 'jira', { v: 1 });

  const first = readSnapshot<{ v: number }>(dataDir, 'p', '2026-08-27', 'jira');
  assert.deepEqual(first, { v: 1 });

  // Overwritten on disk WITHOUT going through this process's writeSnapshot -
  // readSnapshot must still return the cached parse, because every real
  // caller in this codebase reads a path before it is ever written in the
  // same run, never after (see the note on the cache in snapshot.ts).
  writeFileSync(join(dir, 'jira.json'), JSON.stringify({ v: 2 }), 'utf8');
  assert.deepEqual(readSnapshot<{ v: number }>(dataDir, 'p', '2026-08-27', 'jira'), { v: 1 });

  clearSnapshotCache();
  assert.deepEqual(readSnapshot<{ v: number }>(dataDir, 'p', '2026-08-27', 'jira'), { v: 2 });
});

test('readSnapshot never caches a miss, so a later write is still seen', () => {
  clearSnapshotCache();
  const dataDir = mkdtempSync(join(tmpdir(), 'to-cache-miss-'));
  assert.equal(readSnapshot(dataDir, 'p', '2026-08-27', 'jira'), null);
  writeSnapshot(join(dataDir, 'p', '2026-08-27'), 'jira', { v: 1 });
  assert.deepEqual(readSnapshot<{ v: number }>(dataDir, 'p', '2026-08-27', 'jira'), { v: 1 });
});

test('writeJsonAtomic leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'to-atomic-'));
  const path = join(dir, 'x.json');
  writeJsonAtomic(path, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { a: 1 });
  assert.equal(existsSync(`${path}.tmp`), false);
});
