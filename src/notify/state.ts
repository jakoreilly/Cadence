import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../snapshot.js';
import type { InterventionSeverity } from '../interventions.js';

// ---------------------------------------------------------------------------
// What has already been said out loud.
//
// This is the second of the two questions the alerting layer has to answer, and
// it is NOT the same as "is this new". The snapshot diff answers whether a
// finding appeared today; this file answers whether the reader has already been
// told about it. Both are needed:
//
//   - The diff alone re-posts everything the second time `alert` runs in a day,
//     because nothing in a snapshot records that a message was sent.
//   - This file alone cannot tell a first-ever run from a quiet day, and cannot
//     see that a threshold crossed yesterday and still crossed today is not
//     news.
//
// It lives beside the snapshots rather than in the profile directory because it
// describes a particular collected SERIES, not the site's configuration: point
// --data somewhere else and the alert history that goes with those snapshots
// goes with them.
// ---------------------------------------------------------------------------

export interface AlertRecord {
  /** Content identity - see alertIdentity in digest.ts. Never Intervention.id,
   *  which is positional. */
  identity: string;
  team: string;
  kind: string;
  /** The severity as last SENT. An item that comes back stronger is news again,
   *  and this is the field that decides that. */
  severity: InterventionSeverity;
  title: string;
  firstSeenDate: string;
  lastSentDate: string | null;
  sends: number;
  /** True when the record was written by the first run's baseline sweep rather
   *  than by an alert actually going out. Kept so "we never told you about this"
   *  stays distinguishable from "we told you on day one". */
  seeded: boolean;
}

export interface AlertState {
  version: 1;
  profile: string;
  /** The date of the run that established the baseline. */
  seededAt: string | null;
  lastRunDate: string | null;
  records: AlertRecord[];
}

export function statePath(dataDir: string, profileName: string): string {
  return join(dataDir, profileName, 'alert-state.json');
}

/** Null when no state exists, which is the signal for a SEEDING run rather than
 *  a defect. The distinction matters: a missing state file means every standing
 *  item on the estate looks new, and firing 60 alerts on day one is the fastest
 *  way to have the channel muted before the feature is ever useful. */
export function readState(dataDir: string, profileName: string): AlertState | null {
  const path = statePath(dataDir, profileName);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as AlertState;
  if (raw.version !== 1 || !Array.isArray(raw.records)) {
    throw new Error(`${path} is not an alert-state file this build understands (version ${raw.version}). Delete it to re-seed.`);
  }
  return raw;
}

export function writeState(dataDir: string, profileName: string, state: AlertState): string {
  const path = statePath(dataDir, profileName);
  writeJsonAtomic(path, state);
  return path;
}

export function emptyState(profileName: string): AlertState {
  return { version: 1, profile: profileName, seededAt: null, lastRunDate: null, records: [] };
}
