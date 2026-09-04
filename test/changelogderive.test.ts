import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusNameIndex,
  statusTransitions,
  resolveStatusId,
  firstWorkStart,
  emptyResolutionStats,
  sprintMembershipAt,
  parseSprintIdList,
} from '../src/changelogDerive.js';
import type { ChangelogEntry } from '../src/types.js';

test('statusNameIndex maps names to ids when unique', () => {
  const issues = [
    { status: 'To Do', statusId: '10001' },
    { status: 'In Progress', statusId: '10002' },
    { status: 'Done', statusId: '10003' },
  ];
  const { byName, ambiguous } = statusNameIndex(issues);
  assert.equal(byName.get('To Do'), '10001');
  assert.equal(byName.get('In Progress'), '10002');
  assert.equal(byName.get('Done'), '10003');
  assert.deepEqual(ambiguous, []);
});

test('statusNameIndex flags names mapping to multiple ids', () => {
  const issues = [
    { status: 'In Progress', statusId: '10002' },
    { status: 'In Progress', statusId: '10005' },
    { status: 'Done', statusId: '10003' },
  ];
  const { byName, ambiguous } = statusNameIndex(issues);
  assert.equal(byName.has('In Progress'), false);
  assert.deepEqual(ambiguous, ['In Progress']);
});

test('statusNameIndex ignores issues without statusId', () => {
  const issues = [
    { status: 'To Do', statusId: '10001' },
    { status: 'Orphaned', statusId: undefined },
  ];
  const { byName } = statusNameIndex(issues);
  assert.equal(byName.has('Orphaned'), false);
});

test('resolveStatusId prefers id over name', () => {
  const stats = emptyResolutionStats();
  const index = {
    byName: new Map([['To Do', '10001']]),
  };
  const result = resolveStatusId('10002', 'To Do', index, stats);
  assert.equal(result, '10002');
  assert.equal(stats.byId, 1);
  assert.equal(stats.byName, 0);
});

test('resolveStatusId falls back to name', () => {
  const stats = emptyResolutionStats();
  const index = {
    byName: new Map([['To Do', '10001']]),
  };
  const result = resolveStatusId(null, 'To Do', index, stats);
  assert.equal(result, '10001');
  assert.equal(stats.byId, 0);
  assert.equal(stats.byName, 1);
});

test('resolveStatusId returns null and counts unresolved', () => {
  const stats = emptyResolutionStats();
  const index = {
    byName: new Map([['To Do', '10001']]),
  };
  const result = resolveStatusId(null, 'Unknown', index, stats);
  assert.equal(result, null);
  assert.equal(stats.unresolved, 1);
});

test('statusTransitions extracts status transitions and sorts by timestamp', () => {
  const entries: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'PROJ-1',
      created: '2026-09-03T10:00:00Z',
      items: [
        { field: 'status', fieldName: 'status', fromId: '10001', toId: '10002', fromName: 'To Do', toName: 'In Progress' },
      ],
    },
    {
      id: '2',
      issueKey: 'PROJ-1',
      created: '2026-09-01T10:00:00Z',
      items: [
        { field: 'status', fieldName: 'status', fromId: null, toId: '10001', fromName: null, toName: 'To Do' },
      ],
    },
  ];
  const stats = emptyResolutionStats();
  const index = { byName: new Map(), ambiguous: [] };
  const transitions = statusTransitions(entries, index, stats);
  assert.equal(transitions.length, 2);
  assert.equal(transitions[0]?.issueKey, 'PROJ-1');
  assert.equal(transitions[0]?.at, '2026-09-01T10:00:00Z');
  assert.equal(transitions[1]?.at, '2026-09-03T10:00:00Z');
});

test('statusTransitions filters non-status items', () => {
  const entries: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'PROJ-1',
      created: '2026-09-03T10:00:00Z',
      items: [
        { field: 'status', fieldName: 'status', fromId: '10001', toId: '10002', fromName: 'To Do', toName: 'In Progress' },
        { field: 'customfield_10001', fieldName: 'Sprint', fromId: '100', toId: '101', fromName: 'S1', toName: 'S2' },
      ],
    },
  ];
  const stats = emptyResolutionStats();
  const index = { byName: new Map(), ambiguous: [] };
  const transitions = statusTransitions(entries, index, stats);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.toStatusId, '10002');
});

test('statusTransitions drops unresolvable statuses', () => {
  const entries: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'PROJ-1',
      created: '2026-09-03T10:00:00Z',
      items: [
        { field: 'status', fieldName: 'status', fromId: null, toId: null, fromName: null, toName: 'Unknown' },
      ],
    },
  ];
  const stats = emptyResolutionStats();
  const index = { byName: new Map(), ambiguous: [] };
  const transitions = statusTransitions(entries, index, stats);
  assert.equal(transitions.length, 0);
  assert.equal(stats.unresolved, 1);
});

test('firstWorkStart finds earliest transition to a WIP column', () => {
  const transitions = [
    { issueKey: 'PROJ-1', at: '2026-09-01T10:00:00Z', fromStatusId: null, toStatusId: '10001' },
    { issueKey: 'PROJ-1', at: '2026-09-03T10:00:00Z', fromStatusId: '10001', toStatusId: '10002' },
    { issueKey: 'PROJ-2', at: '2026-09-02T10:00:00Z', fromStatusId: null, toStatusId: '10003' },
  ];
  const team = {
    columns: [
      { name: 'To Do', statusIds: ['10001'] },
      { name: 'In Progress', statusIds: ['10002'] },
      { name: 'Done', statusIds: ['10003'] },
    ],
  };
  const isWip = (col: string) => col === 'In Progress';
  const starts = firstWorkStart(transitions, team, isWip);
  // Only PROJ-1 has a transition to In Progress
  assert.equal(starts.get('PROJ-1'), '2026-09-03T10:00:00Z');
  assert.equal(starts.has('PROJ-2'), false);
});

test('firstWorkStart ignores later transitions for same issue', () => {
  const transitions = [
    { issueKey: 'PROJ-1', at: '2026-09-01T10:00:00Z', fromStatusId: null, toStatusId: '10002' },
    { issueKey: 'PROJ-1', at: '2026-09-02T10:00:00Z', fromStatusId: '10002', toStatusId: '10003' },
    { issueKey: 'PROJ-1', at: '2026-09-03T10:00:00Z', fromStatusId: '10003', toStatusId: '10002' },
  ];
  const team = {
    columns: [
      { name: 'In Progress', statusIds: ['10002'] },
      { name: 'Done', statusIds: ['10003'] },
    ],
  };
  const isWip = (col: string) => col === 'In Progress';
  const starts = firstWorkStart(transitions, team, isWip);
  // First transition to In Progress is 2026-09-01
  assert.equal(starts.get('PROJ-1'), '2026-09-01T10:00:00Z');
});

test('firstWorkStart uses columnResolver to classify columns', () => {
  const transitions = [
    { issueKey: 'PROJ-1', at: '2026-09-01T10:00:00Z', fromStatusId: null, toStatusId: '10001' },
  ];
  const team = {
    columns: [
      { name: 'To Do', statusIds: ['10001'] },
      { name: 'In Progress', statusIds: ['10002', '10003'] },
      { name: 'Done', statusIds: ['10004'] },
    ],
  };
  const isWip = (col: string) => col === 'In Progress';
  const starts = firstWorkStart(transitions, team, isWip);
  // Status 10001 resolves to "To Do", which is not WIP, so no start recorded
  assert.equal(starts.has('PROJ-1'), false);
});

test('sprintMembershipAt reconstructs membership across sprints at multiple instants', () => {
  const entries: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'PROJ-1',
      created: '2026-08-20T10:00:00Z',
      items: [
        { field: 'customfield_10001', fieldName: 'Sprint', fromId: null, toId: '1', fromName: null, toName: 'S1' },
      ],
    },
    {
      id: '2',
      issueKey: 'PROJ-1',
      created: '2026-08-28T10:00:00Z',
      items: [
        { field: 'customfield_10001', fieldName: 'Sprint', fromId: '1', toId: '1,2', fromName: 'S1', toName: 'S1, S2' },
      ],
    },
    {
      id: '3',
      issueKey: 'PROJ-1',
      created: '2026-09-01T10:00:00Z',
      items: [
        { field: 'customfield_10001', fieldName: 'Sprint', fromId: '1,2', toId: '2,3', fromName: 'S1, S2', toName: 'S2, S3' },
      ],
    },
  ];
  const issue = { key: 'PROJ-1', created: '2026-08-20T10:00:00Z', sprintIds: [2, 3] };

  // Before creation: should return null
  const before = sprintMembershipAt(issue, entries, '2026-08-19T00:00:00Z');
  assert.equal(before, null);

  // Inside sprint 1 (after first change, before second)
  const inS1 = sprintMembershipAt(issue, entries, '2026-08-27T00:00:00Z');
  assert.deepEqual([...inS1!].sort((a, b) => a - b), [1]);

  // Inside sprint 1 and 2 (after second change, before third)
  const inS1S2 = sprintMembershipAt(issue, entries, '2026-08-30T00:00:00Z');
  assert.deepEqual([...inS1S2!].sort((a, b) => a - b), [1, 2]);

  // Now (after all changes): should be in sprints 2 and 3
  const now = sprintMembershipAt(issue, entries, '2026-09-03T00:00:00Z');
  assert.deepEqual([...now!].sort((a, b) => a - b), [2, 3]);
});

test('sprintMembershipAt returns current membership when issue has no Sprint changelog after creation', () => {
  const entries: ChangelogEntry[] = [
    {
      id: '1',
      issueKey: 'PROJ-1',
      created: '2026-08-20T10:00:00Z',
      items: [
        { field: 'status', fieldName: 'status', fromId: null, toId: '10001', fromName: null, toName: 'To Do' },
      ],
    },
  ];
  const issue = { key: 'PROJ-1', created: '2026-08-20T10:00:00Z', sprintIds: [1, 2] };

  // No Sprint changelog entries, so returns current membership
  const result = sprintMembershipAt(issue, entries, '2026-09-03T00:00:00Z');
  assert.equal(result !== null, true);
  assert.deepEqual([...result!].sort((a, b) => a - b), [1, 2]);
});

test('parseSprintIdList handles comma-separated sprint ids', () => {
  const result = parseSprintIdList('6145,5462,1234');
  assert.deepEqual([...result].sort((a, b) => a - b), [1234, 5462, 6145]);
});

test('parseSprintIdList returns empty set for null', () => {
  const result = parseSprintIdList(null);
  assert.deepEqual(result.size, 0);
});
