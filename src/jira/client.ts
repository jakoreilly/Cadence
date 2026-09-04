import type { Secrets } from '../types.js';

export interface JiraClient {
  get(path: string): Promise<any>;
  /** An authenticated POST. Exists for exactly one endpoint - the bulk
   *  changelog fetch - and is on the interface rather than smuggled in so a
   *  test double has to declare that it answers one. */
  post(path: string, body: unknown): Promise<any>;
  /** Walks a startAt/maxResults Agile endpoint and returns every item. */
  paginate(path: string, valuesKey: string, opts?: PaginateOptions): Promise<any[]>;
  /** The ceiling on concurrent Atlassian requests, shared by every pass built
   *  on this client. Exposed so a caller that pools ABOVE the client - the
   *  board sweep runs several boards at once - can see that the ceiling exists
   *  rather than multiplying its own concurrency by the client's. */
  readonly gate: RequestGate;
}

function authHeader(secrets: Secrets): string {
  return 'Basic ' + Buffer.from(`${secrets.atlassianEmail}:${secrets.atlassianApiToken}`).toString('base64');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An Atlassian answer that was not ok, carrying the STATUS as a number.
 *
 *  The status is on the error rather than only in its message because callers
 *  branch on it - the bulk changelog path has to tell "this site does not
 *  implement that endpoint" (demote for the whole run) from "that request did
 *  not work this time" (retry this chunk). Reading it back out of the message
 *  means pattern-matching a string that also contains the response BODY, so an
 *  error page that happens to mention a number is indistinguishable from that
 *  number being the status. */
export class AtlassianHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 404 specifically, because "this board no longer exists" is a real answer
 *  that callers treat differently from a failure. Kept as its own class rather
 *  than a status check at every call site because that is how the collector
 *  already reads. */
export class JiraNotFound extends AtlassianHttpError {
  constructor(message: string) {
    super(404, message);
  }
}

// ---------------------------------------------------------------------------
// The in-flight ceiling
//
// WHY THIS EXISTS. Every Atlassian pass in this tool used to be strictly
// sequential, and the reason given was always the same: "Jira Cloud rate-limits
// a parallel board sweep readily". That is an argument for a CEILING, not for
// one at a time - the same argument src/concurrency.ts already makes for the
// GitLab review pass. But a ceiling only works if it is shared: three passes
// each holding their own `createJiraClient` and each politely keeping two
// requests in flight is six in flight, and nothing in the code says so.
//
// So the limit lives on the client, one client is built per run, and the
// Confluence collector - which is on the same host, the same credentials and
// the same rate limit - takes the same gate rather than opening its own.
// ---------------------------------------------------------------------------

/** A FIFO semaphore. Requests queue in the order they were submitted, so a
 *  pass that submits work in a deterministic order gets it executed in a
 *  deterministic order too - which is not what makes the snapshot
 *  deterministic (that is the input-order fold in mapWithConcurrency) but does
 *  make a slow run reproducible enough to reason about. */
export interface RequestGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly maxInFlight: number;
}

/** Concurrent Atlassian requests across the whole run.
 *
 *  Four, not forty, and chosen the same way DEFAULT_REVIEW_CONCURRENCY was: to
 *  be obviously safe rather than optimal. The retry policy below already backs
 *  off on 429 with Retry-After, so the failure mode of being slightly too high
 *  is a slower run rather than a broken one - but the failure mode of being far
 *  too high is a cascade of 429s that reads like a permissions problem, which
 *  is the exact confusion the retry policy was written to end. */
export const DEFAULT_ATLASSIAN_IN_FLIGHT = 4;

export function createRequestGate(maxInFlight: number): RequestGate {
  const width = Math.max(1, Math.floor(maxInFlight) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };

  return {
    maxInFlight: width,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= width) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export interface AtlassianGetOptions {
  maxRetries?: number;
  /** Share an existing ceiling instead of opening a private one. Confluence
   *  passes the Jira client's gate: same host, same token, same rate limit. */
  gate?: RequestGate;
  maxInFlight?: number;
}

/** A raw authenticated GET against the Atlassian site, with the retry policy
 *  below. Exported because Confluence lives on the SAME host and the same
 *  credentials as Jira (under /wiki) and duplicating the 429/Retry-After
 *  handling for it would be two copies of the one rule that keeps a scheduled
 *  sweep from cascading into failures that look like permission errors. */
export function createAtlassianGet(secrets: Secrets, opts: AtlassianGetOptions = {}): (path: string) => Promise<any> {
  const request = createAtlassianRequest(secrets, opts);
  return (path: string) => request('GET', path);
}

/** The GET above and the one POST, sharing the retry policy and the gate.
 *
 *  Split out rather than duplicated because the 429/Retry-After rule is not
 *  method-specific and a second copy of it is a second thing to forget to
 *  update - the comment below is the whole reason this policy exists at all. */
export function createAtlassianRequest(
  secrets: Secrets,
  opts: AtlassianGetOptions = {},
): (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<any> {
  const baseUrl = secrets.atlassianBaseUrl.replace(/\/+$/, '');
  const header = authHeader(secrets);
  const maxRetries = opts.maxRetries ?? 4;
  const gate = opts.gate ?? createRequestGate(opts.maxInFlight ?? DEFAULT_ATLASSIAN_IN_FLIGHT);

  return function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    return gate.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const resp = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization: header,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        // GOTCHA: Jira Cloud rate-limits a board-by-board sweep readily once you
        // are past a handful of boards. It answers 429 with Retry-After in
        // SECONDS, and ignoring it turns into a cascade of failures that look
        // like permission errors. 5xx gets the same backoff - these are usually
        // transient on Atlassian's side.
        if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
          const retryAfter = Number(resp.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
          await sleep(waitMs);
          continue;
        }

        // 404 is a real answer for "this board no longer exists" - callers decide
        // whether that is fatal, so it must be distinguishable from other errors.
        if (resp.status === 404) throw new JiraNotFound(`Atlassian 404: ${path}`);
        if (!resp.ok) {
          throw new AtlassianHttpError(resp.status, `Atlassian API ${path} failed: ${resp.status} ${await resp.text()}`);
        }
        if (resp.status === 204) return undefined;
        return resp.json();
      }
    });
  };
}

export interface PaginateOptions {
  /** Rows asked for per request. See DEFAULT_PAGE_SIZE - asking for more than
   *  the endpoint allows is safe and is the point. */
  pageSize?: number;
}

/** Rows requested per paginated Agile call.
 *
 *  100, not 50. The Agile API caps `maxResults` per endpoint and echoes the cap
 *  back, so asking for 100 gets 100 where the endpoint allows it and 50 where
 *  it does not - which is strictly fewer round trips than always asking for 50
 *  and never more. On the largest board here the backlog leg alone runs to 8,556 issues: 172
 *  requests at 50, 86 at 100 wherever the cap permits.
 *
 *  GOTCHA: this is only safe because the terminate-on-short-page test below
 *  compares against the OBSERVED page width rather than the REQUESTED one. A
 *  naive `values.length < pageSize` would read a capped 50-row page as the last
 *  page and silently drop everything after it. */
export const DEFAULT_PAGE_SIZE = 100;

export function createJiraClient(
  secrets: Secrets,
  opts: { maxRetries?: number; maxInFlight?: number; gate?: RequestGate } = {},
): JiraClient {
  const gate = opts.gate ?? createRequestGate(opts.maxInFlight ?? DEFAULT_ATLASSIAN_IN_FLIGHT);
  const request = createAtlassianRequest(secrets, { maxRetries: opts.maxRetries, gate });
  const get = (path: string) => request('GET', path);
  const post = (path: string, body: unknown) => request('POST', path, body);

  async function paginate(path: string, valuesKey: string, opts: PaginateOptions = {}): Promise<any[]> {
    const requested = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE);
    const out: any[] = [];
    let startAt = 0;
    // The widest page this endpoint has actually returned. The Agile API caps
    // maxResults per endpoint, so this is the real page width, discovered
    // rather than assumed - see DEFAULT_PAGE_SIZE.
    let observedWidth = 0;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await get(`${path}${sep}startAt=${startAt}&maxResults=${requested}`);
      const values: any[] = page?.[valuesKey] ?? [];
      out.push(...values);
      if (values.length > observedWidth) observedWidth = values.length;

      // GOTCHA: the Agile API silently CAPS maxResults (50 on most endpoints)
      // and echoes the cap back. Advancing startAt by the requested page size
      // instead of the returned length skips rows without any error - always
      // step by what actually came back.
      if (values.length === 0) return out;
      startAt += values.length;

      // isLast is authoritative where present; `total` is absent on several
      // Agile endpoints, so it cannot be the primary termination test.
      if (page.isLast === true) return out;
      if (typeof page.total === 'number' && startAt >= page.total) return out;
      // Last resort, and the reason `observedWidth` is tracked: a page narrower
      // than every page before it is the end. Comparing against `requested`
      // instead would stop after the first capped page.
      if (page.isLast === undefined && typeof page.total !== 'number' && values.length < observedWidth) return out;
    }
  }

  return { get, post, paginate, gate };
}

/** Field ids requested on every issue fetch, built from the discovered map. */
export function issueFields(fieldIds: string[]): string {
  const base = [
    'summary', 'issuetype', 'status', 'statuscategorychangedate', 'priority',
    'resolution', 'resolutiondate', 'created', 'updated', 'duedate',
    'assignee', 'reporter', 'creator', 'labels', 'components', 'parent',
    'issuelinks', 'timeoriginalestimate', 'timespent',
  ];
  return [...base, ...fieldIds].join(',');
}
