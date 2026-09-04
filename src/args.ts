import { ConfigError } from './config.js';

// ---------------------------------------------------------------------------
// Argument parsing and snapshot selection.
//
// WHY THIS IS ITS OWN MODULE. All three functions here decide what a command
// will operate on, and every one of them fails - if it fails - into a CONFIDENT
// WRONG ANSWER rather than an error: a bad `--window` silently forecasts off
// every sprint the board has ever had, a bad `--team` silently reports an empty
// estate. That is the exact failure class this codebase spends most of its
// comments guarding against, so it is the code that most wants tests.
//
// It could not have them while it lived in cli.ts, because that module calls
// `main()` at the top level - importing it from a test would run the CLI against
// the test runner's own argv. So the logic moved out and cli.ts kept the
// orchestration. Nothing here reads a file, touches the network, or knows what a
// command is.
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

/** Splits `argv` into a command and `--flag [value]` pairs.
 *
 *  A flag with no value, or one immediately followed by another flag, becomes
 *  the string `'true'` - which is why every boolean check in the CLI is written
 *  `flags.x === 'true'` rather than a truthiness test. `--no-gitlab false` would
 *  therefore set `'false'`, and the `=== 'true'` comparison correctly reads that
 *  as off.
 *
 *  Unrecognised bare words are skipped rather than rejected. That is deliberate
 *  and not laziness: this parser has no schema of valid flags, so it cannot tell
 *  a typo from an argument it was never told about, and refusing the ones it does
 *  not recognise would make every new flag a breaking change for a scheduled
 *  task that still passes an old one. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    flags[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
  }
  return { command, flags };
}

/** A numeric flag, or its default.
 *
 *  GOTCHA: a bare `Number(flags.x)` fails into a CONFIDENT WRONG ANSWER rather
 *  than an error. `--stale-days abc` makes every `d >= NaN` false, so
 *  `stale-in-progress` finds nothing and the report reads as a clean board.
 *  `--window abc` makes `metrics.slice(-NaN)` collapse to `slice(0)`, silently
 *  forecasting off every sprint the board has ever had instead of the last 12.
 *  Neither prints a warning. Validate at the edge instead. */
export function numericFlag(flags: Record<string, string>, key: string, fallback: number): number {
  const raw = flags[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`--${key} must be a positive number, got "${raw}"`);
  }
  return value;
}

/** Narrows a snapshot to one team, for `--team`.
 *
 *  A SHALLOW copy: the filtered snapshot shares the surviving teams' issue
 *  arrays with the original rather than cloning them, so narrowing a 30 MB
 *  snapshot costs nothing. Nothing downstream mutates what it reads - the derive
 *  layer is pure throughout - so sharing is safe here in the same way it is safe
 *  for readSnapshot to hand the same parsed object to two callers.
 *
 *  Fails loudly on a key that matches nothing rather than reporting an empty
 *  estate. A typo in `--team` would otherwise produce a clean, confident,
 *  entirely empty report, which is worse than an error in exactly the way this
 *  codebase keeps saying: an empty result and a result that was never measured
 *  look identical on a page. The available keys are listed, because the reader
 *  asking for one team probably does not remember the exact slugs. */
export function narrowToTeam<T extends { teams: Array<{ key: string }> }>(
  snapshot: T,
  teamKey: string | undefined,
  what: string,
): T {
  if (!teamKey) return snapshot;
  const teams = snapshot.teams.filter((t) => t.key === teamKey);
  if (teams.length === 0) {
    throw new ConfigError(
      `No team "${teamKey}" in the ${what} snapshot. It carries: ${snapshot.teams.map((t) => t.key).join(', ') || '(none)'}`,
    );
  }
  return { ...snapshot, teams };
}

/** `narrowToTeam` for the snapshots a team is allowed to be ABSENT from.
 *
 *  The GitLab and Confluence halves are keyed on the same team slug as the Jira
 *  half, but not every board has a group or a space mapped - so a `--team` that
 *  is legitimately missing from one of them is a report with that panel empty,
 *  not an error. The Jira half is the one that must exist, and it uses the
 *  strict form above. */
export function narrowOptional<T extends { teams: Array<{ key: string }> }>(
  snapshot: T | null,
  teamKey: string | undefined,
): T | null {
  if (!snapshot || !teamKey) return snapshot;
  return { ...snapshot, teams: snapshot.teams.filter((t) => t.key === teamKey) };
}
