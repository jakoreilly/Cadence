import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { clearHistoryProjectionCache, loadProjectedDay, loadProjectedDays } from '../src/loadHistory.js';
import { clearSnapshotCache } from '../src/snapshot.js';
import { SCHEMA_VERSION, type IssueSnapshot, type JiraSnapshot } from '../src/types.js';

// The loader sits between the snapshot files and the history metrics, and it is
// the module that decides how much of a ~30 MB day stays in memory. Both of the
// obvious implementations were wrong in a different direction - see the header of
// src/loadHistory.ts - so the behaviour worth pinning is: parsed once, projected,
// bounded, and a day without a jira.json skipped rather than read as empty.

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1', id: '1', issueType: 'Story', status: 'In Development',
    statusCategory: 'In Progress', created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-20T00:00:00.000Z', storyPoints: 3, storyPointsField: 'customfield_10006',
    flagged: false, labels: [], components: [], sprintIds: [10], links: [], inBacklog: false,
    ...over,
  };
}

function snapshotFor(date: string, issues: IssueSnapshot[]): JiraSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION, source: 'jira', site: 's',
    capturedAt: `${date}T07:00:00.000Z`, individualAttribution: true,
    fieldMap: { discoveredAt: '', sprint: 'customfield_10001', storyPoints: [] },
    teams: [{
      key: 't', boardId: 1, columns: [{ name: 'Dev', statusIds: ['3'] }],
      sprints: [{ id: 10, name: 'Sprint 10', state: 'active', startDate: '2026-08-24T00:00:00.000Z', endDate: '2026-09-07T00:00:00.000Z' }],
      issues, errors: [],
    }],
  };
}

/** A profile directory with the given days written as real snapshot files. */
function fixture(days: Record<string, IssueSnapshot[] | null>, gzipDates: string[] = []): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'to-hist-'));
  mkdirSync(join(dataDir, 'p'), { recursive: true });
  for (const [date, issues] of Object.entries(days)) {
    const dir = join(dataDir, 'p', date);
    mkdirSync(dir, { recursive: true });
    // null means the day exists but has no jira.json - what `collect
    // --gitlab-only` and a failed Jira run both leave behind.
    if (issues === null) {
      writeFileSync(join(dir, 'gitlab.json'), '{}', 'utf8');
      continue;
    }
    const body = JSON.stringify(snapshotFor(date, issues));
    if (gzipDates.includes(date)) writeFileSync(join(dir, 'jira.json.gz'), gzipSync(Buffer.from(body, 'utf8')));
    else writeFileSync(join(dir, 'jira.json'), body, 'utf8');
  }
  clearSnapshotCache();
  clearHistoryProjectionCache();
  return dataDir;
}

test('every collected day is loaded, oldest first', () => {
  const dataDir = fixture({
    '2026-08-26': [issue({ key: 'A' })],
    '2026-08-28': [issue({ key: 'A' })],
    '2026-08-27': [issue({ key: 'A' })],
  });
  const days = loadProjectedDays(dataDir, 'p');
  assert.deepEqual(days.map((d) => d.date), ['2026-08-26', '2026-08-27', '2026-08-28']);
});

test('a day with no jira.json is skipped, never read as an empty board', () => {
  // Reading it as zero issues would invent a total wipe of the sprint on that
  // date and a total re-add on the next - the loudest false finding available.
  const dataDir = fixture({
    '2026-08-26': [issue({ key: 'A' })],
    '2026-08-27': null,
    '2026-08-28': [issue({ key: 'A' })],
  });
  const days = loadProjectedDays(dataDir, 'p');
  assert.deepEqual(days.map((d) => d.date), ['2026-08-26', '2026-08-28']);
});

test('upToDate bounds the series inclusively', () => {
  // Yesterday's alert feed must be built from what was knowable yesterday, or a
  // churn figure that exists only because of today's snapshot appears in both
  // feeds and is never news.
  const dataDir = fixture({
    '2026-08-26': [issue({ key: 'A' })],
    '2026-08-27': [issue({ key: 'A' })],
    '2026-08-28': [issue({ key: 'A' })],
  });
  assert.deepEqual(
    loadProjectedDays(dataDir, 'p', '2026-08-27').map((d) => d.date),
    ['2026-08-26', '2026-08-27'],
  );
});

test('what comes back is the PROJECTION, not the full snapshot', () => {
  // The heavy fields are the whole reason this module exists: retaining them
  // costs ~56 MB of heap per collected day against ~12.5 MB projected.
  const dataDir = fixture({
    '2026-08-26': [issue({ key: 'A', description: 'a long description', labels: ['debt'], summary: 'a title' })],
  });
  const day = loadProjectedDay(dataDir, 'p', '2026-08-26')!;
  const only = day.teams[0]!.issues[0]! as unknown as Record<string, unknown>;
  assert.equal(only.key, 'A');
  assert.equal(only.statusCategory, 'In Progress');
  assert.equal('description' in only, false);
  assert.equal('labels' in only, false);
  assert.equal('summary' in only, false);
  // ...and what the metrics DO read survives.
  assert.deepEqual(only.sprintIds, [10]);
  assert.equal(day.capturedAt, '2026-08-26T07:00:00.000Z');
});

test('a day is parsed at most once, however many times it is asked for', () => {
  // `alert` builds two feeds over almost the same date range, so this loop runs
  // twice per run. Without the cache that was 15 large parses for seven days.
  const dataDir = fixture({
    '2026-08-26': [issue({ key: 'A' })],
    '2026-08-27': [issue({ key: 'A' })],
  });
  const original = JSON.parse;
  let parses = 0;
  try {
    (JSON as { parse: typeof JSON.parse }).parse = function (...args: Parameters<typeof JSON.parse>) {
      parses++;
      return original.apply(JSON, args);
    };
    loadProjectedDays(dataDir, 'p');
    const afterFirst = parses;
    loadProjectedDays(dataDir, 'p');
    loadProjectedDay(dataDir, 'p', '2026-08-26');
    assert.equal(parses, afterFirst, 'the second and third reads must be cache hits');
  } finally {
    (JSON as { parse: typeof JSON.parse }).parse = original;
  }
});

test('the same projection object is handed back rather than rebuilt', () => {
  const dataDir = fixture({ '2026-08-26': [issue({ key: 'A' })] });
  const a = loadProjectedDay(dataDir, 'p', '2026-08-26');
  const b = loadProjectedDay(dataDir, 'p', '2026-08-26');
  assert.equal(a, b);
});

test('an archived day is loaded transparently from its .gz form', () => {
  // archive.ts compresses old days IN PLACE precisely so every reader of
  // history keeps working unchanged against them.
  const dataDir = fixture(
    { '2026-08-26': [issue({ key: 'A' })], '2026-08-27': [issue({ key: 'B' })] },
    ['2026-08-26'],
  );
  const days = loadProjectedDays(dataDir, 'p');
  assert.deepEqual(days.map((d) => d.date), ['2026-08-26', '2026-08-27']);
  assert.equal(days[0]!.snapshot.teams[0]!.issues[0]!.key, 'A');
});

test('a missing profile yields no days rather than throwing', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'to-hist-empty-'));
  clearHistoryProjectionCache();
  assert.deepEqual(loadProjectedDays(dataDir, 'nope'), []);
  assert.equal(loadProjectedDay(dataDir, 'nope', '2026-08-26'), null);
});
