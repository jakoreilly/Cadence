import type { ChangelogEntry } from '../types.js';
import { AtlassianHttpError, type JiraClient } from './client.js';
import { normaliseChangelogEntry } from './changelog.js';

// ---------------------------------------------------------------------------
// Fetching changelogs for a set of issues.
//
// WHY THIS IS ITS OWN MODULE. This loop lived inline and IDENTICALLY TWICE in
// cli.ts - once in `backfill-changelog`, once in the delta pass of `collect` -
// and it had no test coverage, because cli.ts calls main() at the top level and
// cannot be imported from a test (see the header of cliargs.ts). Two copies of
// an untested loop is how both copies came to record a FAILED fetch as a
// successful read, which is a permanent hole in an append-only store.
//
// WHY BULK. The per-issue endpoint is one request per issue: 1,892 issues on a
// first backfill across four boards, in series. `POST /rest/api/3/changelog/
// bulkfetch` takes up to 1,000 issue ids in the body and answers for all of
// them, so the same backfill is ~19 requests instead of 1,892. That is by a
// wide margin the largest saving available anywhere in the collection.
//
// WHY THE FALLBACK IS NOT OPTIONAL. bulkfetch is a Jira CLOUD platform-v3
// endpoint. This tool is pointed at a Cloud site today, but the rest of the
// collector is written to survive an instance that answers 400 where the docs
// promise 200 (see the /sprint-on-a-kanban-board GOTCHA), and a changelog
// backfill that dies on an unrecognised endpoint would be a regression against
// a pass that works today. So an unsupported answer demotes the whole run to
// the per-issue path, once, with a line on stderr - it does not fail.
// ---------------------------------------------------------------------------

export const BULK_CHANGELOG_PATH = '/rest/api/3/changelog/bulkfetch';

/** Issue ids per bulk request.
 *
 *  The endpoint accepts up to 1,000, and 100 is deliberately well under it. The
 *  response carries every change history for every issue named, so a chunk of
 *  1,000 long-lived tickets is a single response of tens of megabytes that has
 *  to be buffered and parsed whole, and one transient failure costs all 1,000.
 *  At 100 a first backfill is ~19 requests instead of 1,892 - the saving is
 *  already two orders of magnitude and the remaining factor of ten buys
 *  nothing but blast radius. */
export const CHANGELOG_BULK_CHUNK = 100;

/** `maxResults` on a bulk request, in CHANGE HISTORIES rather than issues -
 *  which is why it is far larger than the chunk size above, and why
 *  `nextPageToken` still has to be followed. */
const BULK_MAX_RESULTS = 1000;

/** A bulk chunk that has not terminated after this many pages is answering with
 *  a token it never retires. Bounded rather than trusted: an unbounded
 *  `while (nextPageToken)` against a server bug is an infinite loop inside a
 *  scheduled job. */
const MAX_BULK_PAGES = 200;

/** One issue whose changelog is wanted.
 *
 *  `id` as well as `key` because the bulk endpoint answers keyed by ISSUE ID,
 *  so ids are what it is asked for - a response keyed by something other than
 *  what was sent would have to be matched by guesswork. `updated` because it is
 *  what gets recorded in the store's `seen` map on success. */
export interface ChangelogTarget {
  id: string;
  key: string;
  updated: string;
}

/** Pairs the keys `issuesNeedingChangelog` selected back up with the ids and
 *  `updated` stamps they came from.
 *
 *  Pure, and separate from the fetch so the pairing is testable: an issue whose
 *  key is needed but which is somehow absent from `issues` is DROPPED rather
 *  than fetched with a guessed id, because a bulk request keyed on a wrong id
 *  would silently attribute one issue's history to another.
 *
 *  Order follows `neededKeys`, which issuesNeedingChangelog already sorts by
 *  key - so an interrupted backfill resumes over the same sequence and the
 *  store grows monotonically. */
export function changelogTargets<T extends { id: string; key: string; updated: string }>(
  issues: readonly T[],
  neededKeys: readonly string[],
): ChangelogTarget[] {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const out: ChangelogTarget[] = [];
  for (const key of neededKeys) {
    const issue = byKey.get(key);
    if (!issue) continue;
    out.push({ id: String(issue.id), key: issue.key, updated: issue.updated });
  }
  return out;
}

export interface ChangelogFetchResult {
  /** Normalised entries, in fetch order. Deduping and ordering belong to
   *  mergeChangelogEntries, which the store already applies. */
  entries: ChangelogEntry[];
  /** `{ issueKey: updated }` for the issues whose changelog was ACTUALLY READ.
   *
   *  Never for one that failed. `seen` means "the changelog was read at this
   *  `updated`", and issuesNeedingChangelog will not come back to an issue
   *  until `updated` moves again - so stamping a failure here is a permanent
   *  hole in a store that cannot be backfilled. */
  seenUpdates: Record<string, string>;
  issuesRead: number;
  /** Atlassian requests spent. Reported so the saving is measurable rather than
   *  asserted, and so a silent demotion to the per-issue path is visible in the
   *  run's own output. */
  requests: number;
  mode: 'bulk' | 'per-issue' | 'mixed' | 'none';
  errors: string[];
}

export interface ChangelogFetchOptions {
  chunkSize?: number;
  /** Set false to force the per-issue path - for a site whose bulk endpoint is
   *  known bad, and for the test that proves the two paths agree. */
  allowBulk?: boolean;
  onProgress?: (issuesRead: number, total: number) => void;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += width) out.push(items.slice(i, i + width));
  return out;
}

/** Statuses that mean "this site does not have that endpoint".
 *
 *  404 is the honest answer for a missing endpoint; 400, 405 and 501 are what
 *  instances actually send for one they do not implement, and 410 for one they
 *  have removed. */
const UNSUPPORTED_STATUSES = new Set([400, 404, 405, 410, 501]);

/** Does this failure mean the endpoint is not there, as opposed to "that
 *  request did not work this time"?
 *
 *  The distinction decides whether the whole run is demoted or only this chunk
 *  is retried per-issue. Read off the error's STATUS, never its message: the
 *  message carries the response BODY as well, and an error page that mentions
 *  one of these numbers - a request id, a content length, a port - would read
 *  as the status itself and demote the run for the rest of its life.
 *
 *  Anything that is not an HTTP answer at all - a socket reset, a 429 that
 *  outlasted the retry policy, a 502 - is transient by construction and must
 *  NOT cost the bulk path. */
function isUnsupported(err: unknown): boolean {
  return err instanceof AtlassianHttpError && UNSUPPORTED_STATUSES.has(err.status);
}

/** One bulk request chunk, following `nextPageToken` to the end. */
async function fetchChunkBulk(
  client: JiraClient,
  targets: readonly ChangelogTarget[],
  kept: ReadonlySet<string>,
  keepIndividuals: boolean,
): Promise<{ entries: ChangelogEntry[]; requests: number }> {
  const keyById = new Map(targets.map((t) => [String(t.id), t.key]));
  const entries: ChangelogEntry[] = [];
  let nextPageToken: string | undefined;
  let requests = 0;

  for (let page = 0; page < MAX_BULK_PAGES; page++) {
    const body: Record<string, unknown> = {
      issueIdsOrKeys: targets.map((t) => t.id),
      maxResults: BULK_MAX_RESULTS,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const resp = await client.post(BULK_CHANGELOG_PATH, body);
    requests++;

    const logs: any[] = Array.isArray(resp?.issueChangeLogs) ? resp.issueChangeLogs : [];
    for (const log of logs) {
      // Matched on the id that was SENT. An id that was not asked for cannot be
      // attributed to a key, and writing the numeric id into `issueKey` would
      // put a row in the store that no issue can ever be joined to - so it is
      // dropped rather than guessed.
      const key = keyById.get(String(log?.issueId));
      if (!key) continue;
      for (const h of log?.changeHistories ?? []) {
        const entry = normaliseChangelogEntry(h, key, kept, keepIndividuals);
        if (entry) entries.push(entry);
      }
    }

    const token = resp?.nextPageToken;
    nextPageToken = typeof token === 'string' && token.length > 0 ? token : undefined;
    if (!nextPageToken) return { entries, requests };
  }

  throw new Error(`${BULK_CHANGELOG_PATH} did not terminate after ${MAX_BULK_PAGES} pages`);
}

/** Every changelog entry for ONE issue, paginated.
 *
 *  Uses the DEDICATED changelog endpoint, not `expand=changelog` on an issue or
 *  search call. Three reasons, and the third is the one that decided it:
 *
 *   1. `expand` is documented as "currently not used" on
 *      /rest/agile/1.0/board/{id}/issue - the endpoint the collector already
 *      paginates - so it would have meant moving endpoints anyway.
 *   2. `expand=changelog` is hard-capped at the 100 most recent histories and
 *      `startAt` does not reach the changelog, so on a board with 249 closed
 *      sprints the truncation is real and silent.
 *   3. The cap is only worth accepting to save requests, and the store's
 *      `seen` map already saves them: after the first backfill only issues
 *      whose `updated` has moved are fetched at all.
 *
 *  GOTCHA: this is /rest/api/3, NOT /rest/agile/1.0. The rest of this collector
 *  is Agile-API-only, and `client.paginate` is written against the Agile
 *  convention - it steps `startAt` by what came back and terminates on
 *  `isLast`. The platform API answers with the same startAt/maxResults/isLast
 *  shape on this endpoint, so paginate works unchanged; that is a fact worth a
 *  comment rather than a coincidence worth relying on silently. */
export async function collectIssueChangelog(
  client: JiraClient,
  issueKey: string,
  kept: ReadonlySet<string>,
  keepIndividuals: boolean,
): Promise<ChangelogEntry[]> {
  const raw = await client.paginate(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`, 'values');
  const out: ChangelogEntry[] = [];
  for (const r of raw) {
    const entry = normaliseChangelogEntry(r, issueKey, kept, keepIndividuals);
    if (entry) out.push(entry);
  }
  return out;
}

/** Fetches changelogs for `targets`, bulk where the site supports it.
 *
 *  Never throws for a per-issue failure: the failure is recorded in `errors`,
 *  the issue is left OUT of `seenUpdates`, and the next run retries it. That is
 *  the whole contract - see ChangelogFetchResult.seenUpdates.
 *
 *  GOTCHA (the one place bulk and per-issue genuinely differ): a chunk whose
 *  REQUEST succeeded marks every issue in it as read, including one the response
 *  carried no history for. That is deliberate. bulkfetch omits an issue with an
 *  empty changelog rather than answering with an empty list, so requiring a
 *  response row before stamping `seen` would re-fetch every never-edited ticket
 *  on every run forever - which is exactly the cost `seen` exists to avoid. The
 *  per-issue path cannot make this mistake in either direction because a 404
 *  there throws. */
export async function fetchChangelogs(
  client: JiraClient,
  targets: readonly ChangelogTarget[],
  kept: ReadonlySet<string>,
  keepIndividuals: boolean,
  opts: ChangelogFetchOptions = {},
): Promise<ChangelogFetchResult> {
  const entries: ChangelogEntry[] = [];
  const seenUpdates: Record<string, string> = {};
  const errors: string[] = [];
  let issuesRead = 0;
  let requests = 0;
  let usedBulk = false;
  let usedPerIssue = false;

  if (targets.length === 0) {
    return { entries, seenUpdates, issuesRead: 0, requests: 0, mode: 'none', errors };
  }

  let bulkAvailable = opts.allowBulk !== false;

  for (const group of chunk(targets, opts.chunkSize ?? CHANGELOG_BULK_CHUNK)) {
    if (bulkAvailable) {
      try {
        const got = await fetchChunkBulk(client, group, kept, keepIndividuals);
        entries.push(...got.entries);
        requests += got.requests;
        for (const t of group) seenUpdates[t.key] = t.updated;
        issuesRead += group.length;
        usedBulk = true;
        opts.onProgress?.(issuesRead, targets.length);
        continue;
      } catch (err) {
        const message = (err as Error).message;
        if (isUnsupported(err)) {
          // Once, for the whole run. Retrying an endpoint the site does not
          // implement on every chunk would add one wasted request per chunk and
          // one duplicate line of stderr per chunk.
          bulkAvailable = false;
          errors.push(`bulk changelog unavailable, using one request per issue instead: ${message}`);
        } else {
          // Transient. The bulk path stays available for later chunks; THIS
          // chunk falls through to per-issue so a single blip costs one slow
          // chunk rather than 100 issues' history.
          errors.push(`bulk changelog chunk starting ${group[0]?.key}: ${message}`);
        }
      }
    }

    for (const t of group) {
      try {
        const got = await collectIssueChangelog(client, t.key, kept, keepIndividuals);
        entries.push(...got);
        seenUpdates[t.key] = t.updated;
        issuesRead++;
        usedPerIssue = true;
        // `requests` is a lower bound here: collectIssueChangelog paginates and
        // does not report how many pages it walked. One per issue is the floor
        // and the honest figure to compare against the bulk path.
        requests++;
        opts.onProgress?.(issuesRead, targets.length);
      } catch (err) {
        errors.push(`${t.key}: ${(err as Error).message}`);
      }
    }
  }

  const mode = usedBulk && usedPerIssue ? 'mixed' : usedBulk ? 'bulk' : usedPerIssue ? 'per-issue' : 'none';
  return { entries, seenUpdates, issuesRead, requests, mode, errors };
}
