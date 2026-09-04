import { test } from 'node:test';
import assert from 'node:assert/strict';
import { droppedTeamsOnForce, mergeCollectedTeams } from '../src/mergeTeams.js';

// --- mergeCollectedTeams -----------------------------------------------------

test('a full collection needs nothing carried forward', () => {
  const result = mergeCollectedTeams([{ key: 'fs' }, { key: 'fcp' }], [{ key: 'fs' }, { key: 'fcp' }]);
  assert.deepEqual(result.carriedForward, []);
  assert.deepEqual(result.teams.map((t) => t.key), ['fcp', 'fs']);
});

test('a team not re-collected this run is carried forward from the existing snapshot', () => {
  const existing = [{ key: 'fs', errors: ['stale'] }, { key: 'panther' }, { key: 'tran' }];
  // --team fs narrows this run to one team.
  const result = mergeCollectedTeams([{ key: 'fs', errors: [] }], existing);
  assert.deepEqual(result.carriedForward, ['panther', 'tran']);
  assert.deepEqual(result.teams.map((t) => t.key), ['fs', 'panther', 'tran']);
  // The carried-forward entry is the EXISTING one, untouched - not a stub.
  const fs = result.teams.find((t) => t.key === 'fs') as { key: string; errors: string[] };
  assert.deepEqual(fs.errors, []);
});

test('a fresh day with no existing snapshot carries nothing forward', () => {
  const result = mergeCollectedTeams([{ key: 'fs' }], undefined);
  assert.deepEqual(result.carriedForward, []);
  assert.deepEqual(result.teams.map((t) => t.key), ['fs']);
});

test('re-collecting a team replaces its existing entry rather than duplicating it', () => {
  const existing = [{ key: 'fs', version: 1 }];
  const result = mergeCollectedTeams([{ key: 'fs', version: 2 }], existing);
  assert.equal(result.teams.length, 1);
  assert.equal((result.teams[0] as { version: number }).version, 2);
});

// --- droppedTeamsOnForce -----------------------------------------------------

test('force over a full team set drops nothing', () => {
  assert.deepEqual(droppedTeamsOnForce(['fs', 'fcp'], new Set(['fs', 'fcp'])), []);
});

test('force narrowed by --team names what it would delete', () => {
  assert.deepEqual(droppedTeamsOnForce(['fs', 'fcp', 'panther', 'tran'], new Set(['fs'])), ['fcp', 'panther', 'tran']);
});

test('force on a day with no existing snapshot has nothing to drop', () => {
  assert.deepEqual(droppedTeamsOnForce([], new Set(['fs'])), []);
});
