import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrowOptional, narrowToTeam, numericFlag, parseArgs } from '../src/args.js';
import { ConfigError } from '../src/config.js';

// These three functions decide what every command operates on, and each fails -
// where it fails - into a confident wrong answer rather than an error. They had
// no coverage at all until they moved out of cli.ts, which calls main() at the
// top level and therefore cannot be imported from a test.

// --- parseArgs -----------------------------------------------------------------

test('parseArgs reads the command and its flag values', () => {
  const { command, flags } = parseArgs(['report', '--profile', 'profiles/acme', '--out', 'r.html']);
  assert.equal(command, 'report');
  assert.equal(flags.profile, 'profiles/acme');
  assert.equal(flags.out, 'r.html');
});

test('a valueless flag becomes the string "true", which is what the CLI compares against', () => {
  // Every boolean check in cli.ts is `=== 'true'` rather than a truthiness test,
  // precisely because of this representation.
  const { flags } = parseArgs(['collect', '--dry-run', '--force']);
  assert.equal(flags['dry-run'], 'true');
  assert.equal(flags.force, 'true');
});

test('a flag followed by another flag does not swallow it as a value', () => {
  const { flags } = parseArgs(['alert', '--dry-run', '--resend', '--limit', '4']);
  assert.equal(flags['dry-run'], 'true');
  assert.equal(flags.resend, 'true');
  assert.equal(flags.limit, '4');
});

test('an explicit false is preserved and reads as off', () => {
  const { flags } = parseArgs(['collect', '--no-gitlab', 'false']);
  assert.equal(flags['no-gitlab'], 'false');
  assert.notEqual(flags['no-gitlab'], 'true'); // so the CLI treats it as off
});

test('no command at all is an empty string, not a crash', () => {
  assert.deepEqual(parseArgs([]), { command: '', flags: {} });
});

test('a repeated flag takes the last value', () => {
  assert.equal(parseArgs(['x', '--team', 'a', '--team', 'b']).flags.team, 'b');
});

// --- numericFlag ---------------------------------------------------------------

test('numericFlag returns the fallback when the flag is absent', () => {
  assert.equal(numericFlag({}, 'window', 12), 12);
});

test('numericFlag parses a real number', () => {
  assert.equal(numericFlag({ window: '6' }, 'window', 12), 6);
  assert.equal(numericFlag({ 'stale-days': '2.5' }, 'stale-days', 10), 2.5);
});

// The whole reason this function exists. Each of these, left as a bare Number(),
// produces a confident wrong report rather than an error: NaN makes every
// `d >= staleDays` false so a board reads as clean, and slice(-NaN) collapses to
// slice(0) so the forecast silently uses every sprint the board ever had.
for (const bad of ['abc', '', '0', '-3', 'NaN', 'Infinity']) {
  test(`numericFlag rejects ${JSON.stringify(bad)} instead of failing quietly`, () => {
    assert.throws(() => numericFlag({ window: bad }, 'window', 12), ConfigError);
  });
}

test('the rejection names the flag and echoes what was typed', () => {
  // The reader has to be able to see their own typo in the message.
  assert.throws(
    () => numericFlag({ 'stale-days': 'ten' }, 'stale-days', 10),
    /--stale-days must be a positive number, got "ten"/,
  );
});

// --- narrowToTeam --------------------------------------------------------------

const snap = () => ({
  capturedAt: 'x',
  teams: [{ key: 'panther', n: 1 }, { key: 'tran', n: 2 }, { key: 'fcp', n: 3 }],
});

test('no --team leaves the snapshot exactly as it was', () => {
  const s = snap();
  assert.equal(narrowToTeam(s, undefined, 'jira'), s, 'the same object, not a copy');
});

test('narrowToTeam keeps only the named team', () => {
  const out = narrowToTeam(snap(), 'tran', 'jira');
  assert.deepEqual(out.teams.map((t) => t.key), ['tran']);
});

test('narrowToTeam shares the surviving team objects rather than cloning them', () => {
  // A 30 MB snapshot must not be deep-copied to look at one board.
  const s = snap();
  const out = narrowToTeam(s, 'tran', 'jira');
  assert.equal(out.teams[0], s.teams[1]);
  assert.notEqual(out, s, 'but the wrapper is a copy, so the original is untouched');
  assert.equal(s.teams.length, 3);
});

test('narrowToTeam carries the rest of the snapshot forward', () => {
  assert.equal(narrowToTeam(snap(), 'fcp', 'jira').capturedAt, 'x');
});

test('an unknown team is a loud error listing what IS there, never an empty estate', () => {
  // A typo would otherwise produce a clean, confident, entirely empty report.
  assert.throws(() => narrowToTeam(snap(), 'panter', 'jira'), ConfigError);
  assert.throws(
    () => narrowToTeam(snap(), 'panter', 'jira'),
    /No team "panter" in the jira snapshot\. It carries: panther, tran, fcp/,
  );
});

test('the error says which snapshot it looked in', () => {
  assert.throws(() => narrowToTeam(snap(), 'nope', 'gitlab'), /in the gitlab snapshot/);
});

test('an empty snapshot reports "(none)" rather than a bare trailing colon', () => {
  assert.throws(() => narrowToTeam({ teams: [] }, 'tran', 'jira'), /It carries: \(none\)/);
});

// --- narrowOptional ------------------------------------------------------------

test('narrowOptional tolerates a team the snapshot has never heard of', () => {
  // Not every board has a GitLab group or a Confluence space mapped, so a
  // missing team there is an empty panel, not a failed command.
  const out = narrowOptional(snap(), 'no-such-team');
  assert.deepEqual(out!.teams, []);
});

test('narrowOptional passes a null snapshot straight through', () => {
  assert.equal(narrowOptional(null, 'tran'), null);
});

test('narrowOptional with no --team is a no-op', () => {
  const s = snap();
  assert.equal(narrowOptional(s, undefined), s);
});
