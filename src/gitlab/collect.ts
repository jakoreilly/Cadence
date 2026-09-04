import type { MergeRequestSnapshot, Person, ReviewSignals, Secrets, TeamConfig } from '../types.js';
import { mapWithConcurrency } from '../concurrency.js';

// GOTCHA (carried over from Emberwatch/src/code/gitlab.ts):
// GitLab personal access tokens go in a PRIVATE-TOKEN header. A Bearer
// Authorization header works only for OAuth tokens and returns 401 for a PAT.
function gitlabAuth(secrets: Secrets): { baseUrl: string; token: string } {
  if (!secrets.gitlabBaseUrl || !secrets.gitlabToken) {
    throw new Error('GitLab collection needs gitlabBaseUrl and gitlabToken in secrets.local.json');
  }
  return { baseUrl: secrets.gitlabBaseUrl.replace(/\/+$/, ''), token: secrets.gitlabToken };
}

// GOTCHA: a group path is a SINGLE url-encoded path parameter -
// "logistics-hub%2Fservices". encodeURIComponent does this correctly; building
// the URL via new URL(...) does NOT (it leaves "/" alone in a path segment).
const enc = (p: string) => encodeURIComponent(p);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GitLabPage {
  body: any;
  nextPage: string | null;
}

export async function gitlabGet(secrets: Secrets, path: string, maxRetries = 4): Promise<GitLabPage> {
  const { baseUrl, token } = gitlabAuth(secrets);
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${baseUrl}/api/v4${path}`, {
      headers: { 'private-token': token, accept: 'application/json' },
    });
    if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(resp.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
      continue;
    }
    if (!resp.ok) throw new Error(`GitLab API ${path} failed: ${resp.status} ${await resp.text()}`);
    return { body: await resp.json(), nextPage: resp.headers.get('x-next-page') || null };
  }
}

/** Walks a keyset/offset paginated collection endpoint.
 *
 *  GOTCHA: GitLab signals "more pages" with the X-Next-Page RESPONSE HEADER,
 *  not with anything in the body, and it returns an EMPTY STRING rather than
 *  omitting the header on the last page. Looping until the body is empty
 *  instead works but costs one wasted request per collection; looping on a
 *  truthy header is correct and cheap. */
export async function gitlabPaginate(secrets: Secrets, path: string, perPage = 100): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const { body, nextPage } = await gitlabGet(secrets, `${path}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(body)) throw new Error(`GitLab ${path} returned a non-array page`);
    out.push(...body);
    if (!nextPage) return out;
    page = Number(nextPage);
    if (!Number.isFinite(page)) return out;
  }
}

function toPerson(raw: any, keepIndividuals: boolean): Person | undefined {
  if (!raw || !keepIndividuals) return undefined;
  return { accountId: String(raw.id), displayName: raw.name ?? raw.username ?? 'unknown' };
}

/** Jira keys referenced by a merge request.
 *
 *  Jira's own "Development" field (customfield_10900) was empty on every issue
 *  sampled on this site, so title/branch parsing is the only correlation
 *  available.
 *
 *  GOTCHA: the key pattern alone CANNOT be made safe. "V2-3" in "bump to V2-3"
 *  is a version string, but it is also a syntactically valid Jira key, because
 *  Jira permits two-character keys containing digits. No amount of regex
 *  tightening separates the two. So `knownProjectKeys` is the real filter -
 *  pass the project keys actually present in the Jira snapshot and everything
 *  else is discarded. It is optional only so the parser stays unit-testable
 *  and usable before a Jira snapshot exists; when omitted, every candidate is
 *  returned and callers must treat the result as unvalidated. */
export function parseIssueKeys(
  title: string,
  sourceBranch: string,
  knownProjectKeys?: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  for (const text of [title, sourceBranch]) {
    for (const m of (text ?? '').matchAll(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]*-\d+)/g)) {
      const key = m[1];
      if (!key) continue;
      if (knownProjectKeys && !knownProjectKeys.has(key.slice(0, key.lastIndexOf('-')))) continue;
      found.add(key);
    }
  }
  return [...found].sort();
}

export function normaliseMergeRequest(
  raw: any,
  keepIndividuals: boolean,
  knownProjectKeys?: ReadonlySet<string>,
): MergeRequestSnapshot {
  return {
    id: raw.id,
    iid: raw.iid,
    projectId: raw.project_id,
    projectPath: raw.references?.full ? String(raw.references.full).split('!')[0] : undefined,
    title: raw.title ?? '',
    state: raw.state,
    // GitLab exposes this as both `draft` and the older `work_in_progress`;
    // older self-managed versions only send the latter.
    draft: Boolean(raw.draft ?? raw.work_in_progress),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at ?? undefined,
    closedAt: raw.closed_at ?? undefined,
    sourceBranch: raw.source_branch ?? '',
    targetBranch: raw.target_branch ?? '',
    author: toPerson(raw.author, keepIndividuals),
    assignees: (raw.assignees ?? []).map((a: any) => toPerson(a, keepIndividuals)).filter(Boolean) as Person[],
    reviewers: (raw.reviewers ?? []).map((a: any) => toPerson(a, keepIndividuals)).filter(Boolean) as Person[],
    issueKeys: parseIssueKeys(raw.title ?? '', raw.source_branch ?? '', knownProjectKeys),
    webUrl: raw.web_url ?? '',
  };
}


// ---------------------------------------------------------------------------
// Review signals
// ---------------------------------------------------------------------------

/** Is this note author automation rather than a person?
 *
 *  GOTCHA (confirmed live on gitlab.example.com): GitLab's own `bot` property is
 *  UNDEFINED on every note author this instance returns, including the automated
 *  reviewer. `bot: true` is only set for project/group access-token identities;
 *  a service account created as an ordinary user - which is what a self-managed
 *  CI integration normally is - is indistinguishable from a person in the API.
 *  So the bot list has to be configuration. There is no way to infer it.
 *
 *  Getting this wrong is not a rounding error. On this instance the automated
 *  reviewer posted 49 of the 94 non-system comments sampled and approved 18 of
 *  20 consecutively merged merge requests, so treating it as a reviewer reports
 *  a median time-to-review of a few minutes for code no person read. */
export function isAutomation(
  username: string | undefined,
  botAccounts: ReadonlySet<string>,
  displayName?: string,
): boolean {
  // GOTCHA: matched on the display NAME as well as the username, and this is
  // not belt-and-braces - it is the failure this cost. `reviewBotAccounts` is
  // maintained by hand from what a person sees in the GitLab UI, which is the
  // display name. On this instance the automation account is username "bot",
  // display name "I'm a Bot", and the profile listed "I'm a Bot" - so a
  // username-only match classified it as a PERSON. It authored 28 merge
  // requests in the onboarding-hub group, 14 of them merged, which both inflated that
  // team's unreviewed rate and, worse, put a robot in the per-person review
  // practice table as somebody to have a training conversation with.
  // GitLab's own `bot` flag is false on it, so nothing in the API rescues this
  // (see the note above and GOTCHA 12 in docs/handover.md).
  if (username && botAccounts.has(username.toLowerCase())) return true;
  if (displayName && botAccounts.has(displayName.toLowerCase())) return true;
  return false;
}

export function botAccountSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((n) => n.toLowerCase()));
}

/** Reduces a merge request's notes and approvals into the review signals.
 *
 *  Pure, so the classification rules are testable against the note shapes
 *  observed live rather than against a mock of the HTTP layer. */
export function deriveReviewSignals(
  notes: any[],
  approvals: any,
  authorUsername: string | undefined,
  reviewerCount: number,
  botAccounts: ReadonlySet<string>,
  keepIndividuals: boolean,
  authorDisplayName?: string,
): ReviewSignals {
  const signals: ReviewSignals = {
    authorIsAutomation: isAutomation(authorUsername, botAccounts, authorDisplayName),
    humanCommentCount: 0,
    automatedCommentCount: 0,
    authorCommentCount: 0,
    humanApprovalCount: 0,
    automatedApprovalCount: 0,
    humanCommenters: [],
    humanApprovals: [],
    automatedApprovals: [],
    reviewerCount,
  };
  // Distinct commenters, keyed by accountId so one person leaving eight remarks
  // counts once. See the note on humanCommenters in types.ts.
  const commenterByKey = new Map<string, Person>();

  // GOTCHA: `sort=asc` is requested, but the ordering is not relied on - a note
  // edited after the fact can come back out of order, and "first" must mean
  // earliest timestamp, not first element.
  for (const note of notes) {
    // System notes are GitLab's own event log ("assigned to @x", "marked as
    // draft", "added 1 commit"). They are not review, and they outnumber real
    // comments roughly three to one on this instance.
    if (note?.system) continue;
    const username: string | undefined = note?.author?.username;
    const at: string | undefined = note?.created_at;

    if (username && authorUsername && username === authorUsername) {
      signals.authorCommentCount++;
      continue;
    }
    if (isAutomation(username, botAccounts, note?.author?.name)) {
      signals.automatedCommentCount++;
      signals.firstAutomatedCommentAt = earlier(signals.firstAutomatedCommentAt, at);
      continue;
    }
    signals.humanCommentCount++;
    signals.firstHumanCommentAt = earlier(signals.firstHumanCommentAt, at);
    // The COUNT above is unconditional; only the identity is gated on
    // attribution, exactly as approvals are - so turning attribution off
    // degrades "who reviewed" to unknown without corrupting "was it reviewed".
    const person = toPerson(note?.author, keepIndividuals);
    if (person) commenterByKey.set(person.accountId, person);
  }
  signals.humanCommenters = [...commenterByKey.values()];

  // GOTCHA: the approvals payload nests the user one level down - entries are
  // `{ user: { username, ... } }`, not the user object directly, so a naive
  // `entry.username` is undefined for every approver and every approval then
  // silently classifies as human.
  for (const entry of approvals?.approved_by ?? []) {
    const user = entry?.user ?? entry;
    if (!user) continue;
    // The COUNT is incremented unconditionally; only the identity is gated on
    // attribution. See the note on humanApprovalCount in types.ts.
    const person = toPerson(user, keepIndividuals);
    if (isAutomation(user?.username, botAccounts, user?.name)) {
      signals.automatedApprovalCount++;
      if (person) signals.automatedApprovals.push(person);
    } else {
      signals.humanApprovalCount++;
      if (person) signals.humanApprovals.push(person);
    }
  }

  // Approval TIMES exist only as system notes - `approved_by` carries no
  // timestamp at all - so they are undefined whenever notes could not be read.
  // The body is matched loosely because GitLab has used both "approved this
  // merge request" and "approved this MR" across versions.
  for (const note of notes) {
    if (!note?.system) continue;
    if (!/\bapproved this\b/i.test(String(note?.body ?? ''))) continue;
    const username: string | undefined = note?.author?.username;
    if (isAutomation(username, botAccounts, note?.author?.name)) {
      signals.firstAutomatedApprovalAt = earlier(signals.firstAutomatedApprovalAt, note?.created_at);
    } else {
      signals.firstHumanApprovalAt = earlier(signals.firstHumanApprovalAt, note?.created_at);
    }
  }

  return signals;
}

function earlier(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

/** Fetches the review detail for one merge request.
 *
 *  Two extra requests per merge request at worst. The notes call is skipped
 *  entirely when `user_notes_count` is 0 - that field counts NON-SYSTEM notes,
 *  so zero really does mean nobody and nothing commented, and on this instance
 *  it skips 82 of every 100 merge requests. The approvals call cannot be
 *  skipped: nothing in the list payload reveals whether an approval exists. */
export async function collectReviewDetail(
  secrets: Secrets,
  raw: any,
  botAccounts: ReadonlySet<string>,
  keepIndividuals: boolean,
): Promise<ReviewSignals> {
  const projectId = raw?.project_id;
  const iid = raw?.iid;
  const authorUsername: string | undefined = raw?.author?.username;
  const authorDisplayName: string | undefined = raw?.author?.name;
  const reviewerCount = (raw?.reviewers ?? []).length;

  let notes: any[] = [];
  let approvals: any = null;
  try {
    if ((raw?.user_notes_count ?? 0) > 0) {
      notes = await gitlabPaginate(
        secrets,
        `/projects/${projectId}/merge_requests/${iid}/notes?sort=asc&order_by=created_at`,
      );
    }
    const got = await gitlabGet(secrets, `/projects/${projectId}/merge_requests/${iid}/approvals`);
    approvals = got.body;
  } catch (err) {
    // A single unreadable merge request must not lose the other 599. The MR is
    // kept with `review.error` set, so the derive layer can exclude it from the
    // denominator instead of counting it as "nobody reviewed this".
    const partial = deriveReviewSignals(notes, approvals, authorUsername, reviewerCount, botAccounts, keepIndividuals, authorDisplayName);
    partial.error = (err as Error).message;
    return partial;
  }

  return deriveReviewSignals(notes, approvals, authorUsername, reviewerCount, botAccounts, keepIndividuals, authorDisplayName);
}

export interface CollectMergeRequestOptions {
  windowDays: number;
  keepIndividuals: boolean;
  now: Date;
  knownProjectKeys?: ReadonlySet<string>;
  /** Usernames treated as automation. Empty means every comment and approval is
   *  attributed to a person, which on an instance with an automated reviewer is
   *  simply wrong - see isAutomation. */
  botAccounts?: readonly string[];
  /** Fetch per-merge-request notes and approvals. Off makes a run roughly one
   *  request per merge request cheaper and leaves `review` undefined. */
  withReviewDetail?: boolean;
  /** Progress callback, so a run over several hundred merge requests is not
   *  silent for minutes. Reports a COUNT, not an index: the review pass runs
   *  several requests in flight, so "which one finished" has no single answer
   *  while "how many are done" always does. */
  onProgress?: (done: number, total: number) => void;
  /** Merge requests whose review detail is fetched at once.
   *
   *  The review pass is at least one request per merge request - 1,141 of them
   *  on this estate - and fully sequential it is the dominant wall-clock cost of
   *  the daily run. It is also the pass most able to get a token rate-limited,
   *  so this is deliberately a small fixed number rather than "all of them": a
   *  steady low request rate instead of a spike, with the existing
   *  429/Retry-After backoff in `gitlabGet` underneath as the safety net.
   *
   *  Output does NOT depend on this value. Results are folded back onto the
   *  merge requests by id and the snapshot is sorted by `createdAt`, so a run at
   *  1 and a run at 8 produce the same bytes - which matters because snapshots
   *  are the product and are diffed day to day. 1 restores the old strictly
   *  sequential behaviour. */
  reviewConcurrency?: number;
}

/** In-flight review requests when the caller does not say.
 *
 *  Six, not sixty. Chosen to be obviously safe rather than optimal: it is a
 *  ~6x wall-clock reduction on the slowest pass in the tool while keeping the
 *  request rate in the range a single interactive user of the GitLab UI already
 *  produces. Raise it with --review-concurrency if the instance tolerates it;
 *  the 429 handling means the failure mode of going too high is a slower run,
 *  not a broken one. */
export const DEFAULT_REVIEW_CONCURRENCY = 6;

export async function collectTeamMergeRequests(
  secrets: Secrets,
  team: TeamConfig,
  opts: CollectMergeRequestOptions,
): Promise<{ mergeRequests: MergeRequestSnapshot[]; errors: string[] }> {
  const { windowDays, keepIndividuals, now, knownProjectKeys } = opts;
  const botAccounts = botAccountSet(opts.botAccounts ?? []);
  const errors: string[] = [];
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const byId = new Map<number, MergeRequestSnapshot>();
  const rawById = new Map<number, any>();

  for (const group of team.gitlabGroups) {
    try {
      // GOTCHA: without scope=all the group endpoint returns only merge requests
      // created by the TOKEN OWNER, which silently reduces a whole team's
      // throughput to one person's. state=all keeps closed-without-merge MRs,
      // which are themselves a signal worth trending.
      const raw = await gitlabPaginate(
        secrets,
        `/groups/${enc(group)}/merge_requests?scope=all&state=all&updated_after=${encodeURIComponent(since)}`,
      );
      for (const r of raw) {
        const mr = normaliseMergeRequest(r, keepIndividuals, knownProjectKeys);
        // Subgroups overlap when a config lists both a parent and a child group;
        // dedupe on the global MR id so throughput is not double counted.
        byId.set(mr.id, mr);
        // The raw payload is kept alongside because the review pass needs
        // project_id, iid, the author username and user_notes_count, none of
        // which belong in the snapshot shape.
        rawById.set(mr.id, r);
      }
    } catch (err) {
      errors.push(`group ${group}: ${(err as Error).message}`);
    }
  }

  // BOUNDED, not sequential and not unbounded. The original loop was strictly
  // one at a time, for a reason that still holds - "a parallel burst across
  // hundreds of merge requests is what gets a token rate-limited" - but that is
  // an argument against Promise.all over 1,141 merge requests, not against
  // keeping a handful in flight. A small fixed pool is a steady low request rate
  // rather than a spike, `gitlabGet` already backs off on 429 with Retry-After,
  // and the result is identical either way: reviews are folded back onto the
  // merge requests they belong to and the snapshot is sorted by createdAt below,
  // so completion order cannot reach the file. See src/concurrency.ts.
  if (opts.withReviewDetail) {
    const entries = [...byId.entries()];
    const reviews = await mapWithConcurrency(
      entries,
      opts.reviewConcurrency ?? DEFAULT_REVIEW_CONCURRENCY,
      ([id]) => collectReviewDetail(secrets, rawById.get(id), botAccounts, keepIndividuals),
      opts.onProgress,
    );
    entries.forEach(([, mr], i) => {
      mr.review = reviews[i]!;
    });
  }

  return {
    mergeRequests: [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    errors,
  };
}
