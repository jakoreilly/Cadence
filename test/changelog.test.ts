import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keptFields,
  normaliseChangelogItem,
  normaliseChangelogEntry,
  changelogSprintIds,
  changelogScope,
  issuesNeedingChangelog,
  mergeChangelogEntries,
} from '../src/jira/changelog.js';
import type { FieldMap, SprintSnapshot, ChangelogEntry } from '../src/types.js';

test('keptFields includes native fields and discovered field ids', () => {
  const map: FieldMap = {
    discoveredAt: '2026-09-03T12:00:00Z',
    sprint: 'customfield_10001',
    storyPoints: ['customfield_10006', 'customfield_11000'],
    flagged: 'customfield_10007',
  };
  const kept = keptFields(map);
  assert(kept.has('status'));
  assert(kept.has('resolution'));
  assert(kept.has('assignee'));
  assert(kept.has('customfield_10001'));
  assert(kept.has('customfield_10006'));
  assert(kept.has('customfield_11000'));
  assert(kept.has('customfield_10007'));
  assert(!kept.has('description'));
  assert(!kept.has('Rank'));
});

test('normaliseChangelogItem filters fields and renames to/from', () => {
  const kept = new Set(['status', 'customfield_10001']);
  // A real status changelog item from Jira
  const raw = {
    field: 'status',
    fieldId: 'status',
    from: '10001',
    fromString: 'To Do',
    to: '10002',
    toString: 'In Progress',
  };
  const item = normaliseChangelogItem(raw, kept);
  assert.deepEqual(item, {
    field: 'status',
    fieldName: 'status',
    fromId: '10001',
    toId: '10002',
    fromName: 'To Do',
    toName: 'In Progress',
  });
});

test('normaliseChangelogItem returns null for filtered-out fields', () => {
  const kept = new Set(['status']);
  const raw = {
    field: 'Rank',
    fieldId: 'Rank',
    from: 'a',
    to: 'b',
  };
  assert.equal(normaliseChangelogItem(raw, kept), null);
});

test('normaliseChangelogItem handles missing fieldId and uses field name', () => {
  const kept = new Set(['Status']);
  // Old Jira records omit fieldId
  const raw = {
    field: 'Status',
    from: '10001',
    to: '10002',
  };
  const item = normaliseChangelogItem(raw, kept);
  assert.equal(item?.field, 'Status');
  assert.equal(item?.fieldName, 'Status');
});

test('normaliseChangelogItem nulls out empty strings', () => {
  const kept = new Set(['status']);
  const raw = {
    field: 'status',
    fieldId: 'status',
    from: '',
    to: '10002',
    fromString: '',
    toString: 'Done',
  };
  const item = normaliseChangelogItem(raw, kept);
  assert.equal(item?.fromId, null);
  assert.equal(item?.toId, '10002');
  assert.equal(item?.fromName, null);
  assert.equal(item?.toName, 'Done');
});

test('normaliseChangelogEntry builds entry with items and filters on kept fields', () => {
  const kept = new Set(['status']);
  const raw = {
    id: 10001,
    created: '2026-08-28T10:30:00.000+0100',
    author: { accountId: 'acc123', displayName: 'Alice' },
    items: [
      { field: 'status', fieldId: 'status', from: '10001', to: '10002' },
      { field: 'Rank', fieldId: 'Rank', from: 'a', to: 'b' }, // filtered
    ],
  };
  const entry = normaliseChangelogEntry(raw, 'PROJ-123', kept, true);
  assert.equal(entry?.id, '10001');
  assert.equal(entry?.issueKey, 'PROJ-123');
  assert.equal(entry?.created, '2026-08-28T10:30:00.000+0100');
  assert.equal(entry?.authorAccountId, 'acc123');
  assert.equal(entry?.authorName, 'Alice');
  assert.equal(entry?.items.length, 1);
  assert.equal(entry?.items[0]?.field, 'status');
});

test('normaliseChangelogEntry returns null when no items survive the filter', () => {
  const kept = new Set(['status']);
  const raw = {
    id: 10001,
    created: '2026-08-28T10:30:00.000+0100',
    author: { accountId: 'acc123', displayName: 'Alice' },
    items: [{ field: 'Rank', fieldId: 'Rank', from: 'a', to: 'b' }], // all filtered
  };
  assert.equal(normaliseChangelogEntry(raw, 'PROJ-123', kept, true), null);
});

test('normaliseChangelogEntry omits author fields when keepIndividuals is false', () => {
  const kept = new Set(['status']);
  const raw = {
    id: 10001,
    created: '2026-08-28T10:30:00.000+0100',
    author: { accountId: 'acc123', displayName: 'Alice' },
    items: [{ field: 'status', fieldId: 'status', from: '10001', to: '10002' }],
  };
  const entry = normaliseChangelogEntry(raw, 'PROJ-123', kept, false);
  assert.equal(entry?.authorAccountId, undefined);
  assert.equal(entry?.authorName, undefined);
  assert('authorAccountId' in entry! ? 'found' : 'not found', 'not found');
});

test('changelogSprintIds includes recent closed and all live sprints', () => {
  const sprints: SprintSnapshot[] = [
    { id: 1, name: 'Old', state: 'closed', startDate: '2026-06-01', endDate: '2026-06-14' },
    { id: 2, name: 'Closed 2', state: 'closed', startDate: '2026-07-01', endDate: '2026-07-14' },
    { id: 3, name: 'Current', state: 'active', startDate: '2026-08-28', endDate: '2026-09-11' },
    { id: 4, name: 'Future', state: 'future', startDate: '2026-09-11', endDate: '2026-09-25' },
  ];
  const ids = changelogSprintIds(sprints, 1);
  // Window of 1: only the most recent closed (id 2), plus active and future
  assert(ids.has(2));
  assert(ids.has(3));
  assert(ids.has(4));
  assert(!ids.has(1));
});

test('changelogSprintIds includes all closed sprints when window is large', () => {
  const sprints: SprintSnapshot[] = [
    { id: 1, name: 'Old', state: 'closed', startDate: '2026-06-01', endDate: '2026-06-14' },
    { id: 2, name: 'Recent', state: 'closed', startDate: '2026-07-01', endDate: '2026-07-14' },
    { id: 3, name: 'Current', state: 'active', startDate: '2026-08-28', endDate: '2026-09-11' },
  ];
  const ids = changelogSprintIds(sprints, 10);
  // Window of 10 (larger than 2 closed sprints): all closed plus active
  assert(ids.has(1));
  assert(ids.has(2));
  assert(ids.has(3));
});

test('changelogScope filters issues to in-scope sprints', () => {
  const team = {
    sprints: [
      { id: 1, name: 'S1', state: 'closed', startDate: '2026-08-14' } as SprintSnapshot,
      { id: 2, name: 'S2', state: 'closed', startDate: '2026-08-28' } as SprintSnapshot,
      { id: 3, name: 'S3', state: 'active', startDate: '2026-09-11' } as SprintSnapshot,
    ],
    issues: [
      { key: 'A', updated: '2026-09-03T12:00:00Z', sprintIds: [1] },
      { key: 'B', updated: '2026-09-03T12:00:00Z', sprintIds: [1, 2] },
      { key: 'C', updated: '2026-09-03T12:00:00Z', sprintIds: [4] }, // out of scope
      { key: 'D', updated: '2026-09-03T12:00:00Z', sprintIds: [3] },
    ],
  };
  // window=1 means most recent 1 closed sprint (id 2) plus all active/future (id 3)
  const scoped = changelogScope(team, 1);
  const keys = scoped.map((i: any) => i.key);
  assert.deepEqual(keys, ['B', 'D']);
});

test('issuesNeedingChangelog returns keys that moved or were never seen', () => {
  const issues = [
    { key: 'A', updated: '2026-09-03T12:00:00Z' },
    { key: 'B', updated: '2026-09-03T12:00:00Z' },
    { key: 'C', updated: '2026-09-03T12:00:00Z' },
  ];
  const seen = {
    A: '2026-09-03T11:00:00Z', // moved
    B: '2026-09-03T12:00:00Z', // unchanged
  };
  const needed = issuesNeedingChangelog(issues, seen);
  assert.deepEqual(needed, ['A', 'C']); // A moved, C never seen, B unchanged
});

test('issuesNeedingChangelog returns results in sorted order', () => {
  const issues = [
    { key: 'C', updated: '2026-09-03T12:00:00Z' },
    { key: 'A', updated: '2026-09-03T12:00:00Z' },
    { key: 'B', updated: '2026-09-03T12:00:00Z' },
  ];
  const seen: Record<string, string> = {};
  const needed = issuesNeedingChangelog(issues, seen);
  assert.deepEqual(needed, ['A', 'B', 'C']);
});

test('mergeChangelogEntries dedupes and sorts by created then id', () => {
  const existing: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'A',
      created: '2026-08-28T10:00:00Z',
      items: [],
    },
    {
      id: '3',
      issueKey: 'A',
      created: '2026-08-30T10:00:00Z',
      items: [],
    },
  ];
  const incoming: ChangelogEntry[] = [
    {
      id: '2',
      issueKey: 'A',
      created: '2026-08-29T10:00:00Z',
      items: [],
    },
    {
      id: '1', // duplicate
      issueKey: 'A',
      created: '2026-08-28T10:00:00Z',
      items: [],
    },
    {
      id: '4',
      issueKey: 'B',
      created: '2026-08-27T10:00:00Z',
      items: [],
    },
  ];
  const merged = mergeChangelogEntries(existing, incoming);
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged.map((e: any) => e.id),
    ['4', '1', '2', '3'],
  );
  // Verify the duplicate was not added
  assert.equal(merged.filter((e: any) => e.id === '1').length, 1);
});

test('mergeChangelogEntries preserves existing entry when duplicate is incoming', () => {
  const existing: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'A',
      created: '2026-08-28T10:00:00Z',
      items: [{ field: 'status', fieldName: 'status', fromId: null, toId: '1', fromName: null, toName: 'Done' }],
    },
  ];
  const incoming: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'A',
      created: '2026-08-28T10:00:00Z',
      items: [{ field: 'status', fieldName: 'status', fromId: null, toId: '2', fromName: null, toName: 'Other' }],
    },
  ];
  const merged = mergeChangelogEntries(existing, incoming);
  // Existing should be preserved
  assert.deepEqual(merged[0]?.items[0]?.toId, '1');
});
