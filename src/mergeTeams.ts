// ---------------------------------------------------------------------------
// The merge rules `collect` applies when --team narrows a run to fewer teams
// than the profile configures.
//
// Pulled out of cli.ts because this is the code whose bugs destroy the asset:
// snapshots cannot be backfilled, so a wrong merge here is not a bug that gets
// fixed on the next run, it is a day of history that is gone. It lived inline
// in a 250-line `case` block with no test coverage before this file existed.
//
// Two situations, two different correct answers:
//
//   - GitLab and Confluence CAN carry a non-collected team's existing entry
//     forward unchanged, because "this team's merge requests as of yesterday's
//     collection" is still a true, dated fact even when today's run did not
//     re-fetch it.
//   - Jira CANNOT: an issue snapshot restamped under today's capturedAt would
//     claim to be an observation made today when it was not, which is worse
//     than a missing day (see the GOTCHA in cli.ts on the --force guard). So
//     Jira gets a refusal, not a merge - `droppedTeamsOnForce` below, called
//     BEFORE collection starts.
// ---------------------------------------------------------------------------

/** Any per-team snapshot slice this merges - the GitLab and Confluence team
 *  entries both satisfy this with nothing extra. */
export interface KeyedTeam {
  key: string;
}

export interface MergeResult<T extends KeyedTeam> {
  /** Collected teams first, then carried-forward ones, sorted by key - the
   *  order every caller already sorted to before this existed. */
  teams: T[];
  /** Keys present in `existing` but not re-collected this run, carried forward
   *  unchanged. Named so the caller can log each one rather than merging
   *  silently - see the GOTCHA on the GitLab leg in cli.ts. */
  carriedForward: string[];
}

/** Folds this run's freshly collected teams together with whatever a previous
 *  run for the SAME day already wrote, keeping anything not re-collected.
 *
 *  Pure: no snapshot is read or written here, so the fold itself is testable
 *  without a filesystem. `existing` is `undefined` on a day with no prior
 *  write for this source, which is the ordinary case and not an error. */
export function mergeCollectedTeams<T extends KeyedTeam>(collected: T[], existing: T[] | undefined): MergeResult<T> {
  const collectedKeys = new Set(collected.map((t) => t.key));
  const carriedForward = (existing ?? []).filter((t) => !collectedKeys.has(t.key));
  const teams = [...collected, ...carriedForward].sort((a, b) => a.key.localeCompare(b.key));
  return { teams, carriedForward: carriedForward.map((t) => t.key) };
}

/** Which already-collected Jira teams a `--force` re-collection would erase.
 *
 *  `--force` exists to genuinely overwrite a day, and that is fine when it
 *  overwrites what it also re-collects. It stops being fine the moment
 *  `--team` has narrowed the run: the Jira half cannot carry a non-collected
 *  team forward the way GitLab and Confluence do (see the header), so writing
 *  the narrowed set under `{ force: true }` silently deletes the other teams'
 *  record of that day. Returns the keys that would be lost, empty when there
 *  is nothing to lose - a fresh day, or a run collecting every configured
 *  team. */
export function droppedTeamsOnForce(existingTeamKeys: readonly string[], collectingKeys: ReadonlySet<string>): string[] {
  return existingTeamKeys.filter((k) => !collectingKeys.has(k));
}
