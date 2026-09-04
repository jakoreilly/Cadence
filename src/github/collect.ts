import type { MergeRequestSnapshot, Person, ReviewSignals, Secrets, TeamConfig } from '../types.js';
import { mapWithConcurrency } from '../concurrency.js';
import {
  botAccountSet,
  DEFAULT_REVIEW_CONCURRENCY,
  isAutomation,
  parseIssueKeys,
  type CollectMergeRequestOptions,
} from '../gitlab/collect.js';

// The GitHub counterpart to gitlab/collect.ts. It produces the SAME
// MergeRequestSnapshot / ReviewSignals shapes, so `review.ts`, the report and
// the alert feed do not know or care which forge a snapshot came from. The
// differences are all in how the data is fetched and classified:
//
//   - GitHub identifies a repo as exactly `owner/repo` - no variable-depth
//     nesting to probe - so `teams[].githubRepos` is a flat hand-written list
//     and there is no `suggest-groups` equivalent.
//   - Pagination is the RFC 5988 `Link` header, not GitLab's `X-Next-Page`.
//   - A PR's state is `open`/`closed` with a separate `merged_at`; it is mapped
//     to GitLab's `opened`/`closed`/`merged` here so review.ts's state filters
//     work unchanged.
//   - GitHub DOES expose automation: `user.type === "Bot"` and a `[bot]` login
//     suffix. The configured `reviewBotAccounts` list still applies on top, for
//     service accounts created as ordinary users.

function githubAuth(secrets: Secrets): { apiBase: string; token: string } {
  if (!secrets.githubToken) {
    throw new Error(
      'GitHub collection needs githubToken in secrets.local.json (or GITHUB_TOKEN); ' +
        'githubBaseUrl is only for GitHub Enterprise Server',
    );
  }
  const webBase = secrets.githubBaseUrl ? secrets.githubBaseUrl.replace(/\/+$/, '') : 'https://github.com';
  const apiBase = secrets.githubBaseUrl ? `${webBase}/api/v3` : 'https://api.github.com';
  return { apiBase, token: secrets.githubToken };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The `rel="next"` URL from a Link header, or null on the last page.
 *
 *  GOTCHA: GitHub returns the FULL next URL (query string and all), so a
 *  paginator must follow it verbatim rather than incrementing a `page=` of its
 *  own - the cursor for `sort=updated` listings is not a simple page number. */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1] ?? null;
  }
  return null;
}

interface GhResponse {
  body: any;
  next: string | null;
}

async function githubGet(secrets: Secrets, urlOrPath: string, maxRetries = 4): Promise<GhResponse> {
  const { apiBase, token } = githubAuth(secrets);
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${apiBase}${urlOrPath}`;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cadence',
      },
    });
    // Primary and secondary rate limits both surface as 403 or 429. When
    // x-ratelimit-remaining is "0" the wait is until x-ratelimit-reset (epoch
    // seconds); otherwise honour Retry-After; otherwise exponential backoff. The
    // wait is capped so a run can never hang for a full rate-limit hour.
    if ((resp.status === 403 || resp.status === 429) && attempt < maxRetries) {
      const remaining = resp.headers.get('x-ratelimit-remaining');
      const retryAfter = Number(resp.headers.get('retry-after'));
      const reset = Number(resp.headers.get('x-ratelimit-reset'));
      let waitMs = 2 ** attempt * 1000;
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
      else if (remaining === '0' && Number.isFinite(reset)) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
      await sleep(Math.min(waitMs, 60_000));
      continue;
    }
    // 404 is a meaningful answer while probing a repo path, not an error.
    if (resp.status === 404) return { body: null, next: null };
    if (!resp.ok) throw new Error(`GitHub API ${url} failed: ${resp.status} ${await resp.text()}`);
    return { body: await resp.json(), next: parseNextLink(resp.headers.get('link')) };
  }
}

/** Follows `Link` pagination. `stop` short-circuits an ordered listing (the PR
 *  sweep is sorted by `updated` descending, so the first row older than the
 *  window means every later row is too). */
async function githubPaginate(secrets: Secrets, path: string, stop?: (row: any) => boolean): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = path;
  while (url) {
    const { body, next }: GhResponse = await githubGet(secrets, url);
    if (body == null) break;
    if (!Array.isArray(body)) throw new Error(`GitHub ${url} returned a non-array page`);
    for (const row of body) {
      if (stop && stop(row)) return out;
      out.push(row);
    }
    url = next;
  }
  return out;
}

function toPerson(user: any, keepIndividuals: boolean): Person | undefined {
  if (!user || !keepIndividuals) return undefined;
  return { accountId: String(user.id ?? user.login ?? 'unknown'), displayName: user.name ?? user.login ?? 'unknown' };
}

function earlier(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

/** Is this GitHub actor automation rather than a person?
 *
 *  Three signals, any of which is sufficient: GitHub's own `type: "Bot"`, a
 *  `[bot]` login suffix (GitHub Apps like dependabot[bot]), and the configured
 *  `reviewBotAccounts` list - which still matters, because a CI service account
 *  created as an ordinary user has `type: "User"` and no suffix, exactly the
 *  case the GitLab collector's list exists for. */
export function isGithubAutomation(user: any, botAccounts: ReadonlySet<string>): boolean {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  const login: string = user.login ?? '';
  if (/\[bot\]$/i.test(login)) return true;
  return isAutomation(login || undefined, botAccounts, user.name);
}

export function normaliseGithubPr(
  raw: any,
  keepIndividuals: boolean,
  knownProjectKeys?: ReadonlySet<string>,
): MergeRequestSnapshot {
  const headRef: string = raw.head?.ref ?? '';
  // Map GitHub's (state, merged_at) to GitLab's single state string so
  // review.ts's `m.state === 'merged' | 'opened' | 'closed'` filters are shared.
  const state = raw.merged_at ? 'merged' : raw.state === 'open' ? 'opened' : 'closed';
  return {
    id: raw.id,
    iid: raw.number,
    projectId: raw.base?.repo?.id ?? 0,
    projectPath: raw.base?.repo?.full_name ?? undefined,
    title: raw.title ?? '',
    state,
    draft: Boolean(raw.draft),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at ?? undefined,
    closedAt: raw.closed_at ?? undefined,
    sourceBranch: headRef,
    targetBranch: raw.base?.ref ?? '',
    author: toPerson(raw.user, keepIndividuals),
    assignees: (raw.assignees ?? []).map((a: any) => toPerson(a, keepIndividuals)).filter(Boolean) as Person[],
    reviewers: (raw.requested_reviewers ?? []).map((a: any) => toPerson(a, keepIndividuals)).filter(Boolean) as Person[],
    issueKeys: parseIssueKeys(raw.title ?? '', headRef, knownProjectKeys),
    webUrl: raw.html_url ?? '',
  };
}

/** Reduces a pull request's reviews and issue comments into the shared
 *  ReviewSignals shape. Pure, so the classification rules are tested against
 *  recorded GitHub payload shapes rather than a mock HTTP layer.
 *
 *  `reviews`  = GET /repos/{o}/{r}/pulls/{n}/reviews  (state + submitted_at + body)
 *  `comments` = GET /repos/{o}/{r}/issues/{n}/comments (the PR conversation tab) */
export function deriveGithubReviewSignals(
  reviews: any[],
  comments: any[],
  prUser: any,
  requestedReviewerCount: number,
  botAccounts: ReadonlySet<string>,
  keepIndividuals: boolean,
): ReviewSignals {
  const authorLogin: string | undefined = prUser?.login;
  const signals: ReviewSignals = {
    authorIsAutomation: isGithubAutomation(prUser, botAccounts),
    humanCommentCount: 0,
    automatedCommentCount: 0,
    authorCommentCount: 0,
    humanApprovalCount: 0,
    automatedApprovalCount: 0,
    humanCommenters: [],
    humanApprovals: [],
    automatedApprovals: [],
    reviewerCount: requestedReviewerCount,
  };
  const commenterByKey = new Map<string, Person>();

  // A "comment" is an issue comment or a review that carried a written body. A
  // bodyless review (a bare Approve, or GitHub's occasional empty COMMENTED
  // event) is not a comment - but the reviewer identity is still folded in
  // below, because taking a position on a PR is a person looking at it.
  const written: Array<{ user: any; at: string | undefined }> = [];
  for (const c of comments) written.push({ user: c?.user, at: c?.created_at });
  for (const r of reviews) {
    if (String(r?.body ?? '').trim()) written.push({ user: r?.user, at: r?.submitted_at });
  }
  for (const c of written) {
    const login: string | undefined = c.user?.login;
    if (login && authorLogin && login === authorLogin) {
      signals.authorCommentCount++;
      continue;
    }
    if (isGithubAutomation(c.user, botAccounts)) {
      signals.automatedCommentCount++;
      signals.firstAutomatedCommentAt = earlier(signals.firstAutomatedCommentAt, c.at);
      continue;
    }
    signals.humanCommentCount++;
    signals.firstHumanCommentAt = earlier(signals.firstHumanCommentAt, c.at);
    const person = toPerson(c.user, keepIndividuals);
    if (person) commenterByKey.set(person.accountId, person);
  }

  // Any review by a non-author human - APPROVED, CHANGES_REQUESTED or a
  // bodyless COMMENTED - makes that person a reviewer of this PR.
  for (const r of reviews) {
    const login: string | undefined = r?.user?.login;
    if (!login || (authorLogin && login === authorLogin)) continue;
    if (isGithubAutomation(r?.user, botAccounts)) continue;
    const person = toPerson(r?.user, keepIndividuals);
    if (person) commenterByKey.set(person.accountId, person);
  }
  signals.humanCommenters = [...commenterByKey.values()];

  // Approvals: DISTINCT approvers (a re-review after changes is still one
  // person's approval), matching the GitLab collector's approved_by semantics.
  const humanApprovers = new Map<string, { at: string | undefined; person: Person | undefined }>();
  const autoApprovers = new Map<string, { at: string | undefined; person: Person | undefined }>();
  for (const r of reviews) {
    if (r?.state !== 'APPROVED') continue;
    const login: string = r?.user?.login ?? 'unknown';
    const at: string | undefined = r?.submitted_at;
    const bucket = isGithubAutomation(r?.user, botAccounts) ? autoApprovers : humanApprovers;
    const prev = bucket.get(login);
    if (prev) prev.at = earlier(prev.at, at);
    else bucket.set(login, { at, person: toPerson(r?.user, keepIndividuals) });
  }
  signals.humanApprovalCount = humanApprovers.size;
  signals.automatedApprovalCount = autoApprovers.size;
  for (const v of humanApprovers.values()) {
    if (v.person) signals.humanApprovals.push(v.person);
    signals.firstHumanApprovalAt = earlier(signals.firstHumanApprovalAt, v.at);
  }
  for (const v of autoApprovers.values()) {
    if (v.person) signals.automatedApprovals.push(v.person);
    signals.firstAutomatedApprovalAt = earlier(signals.firstAutomatedApprovalAt, v.at);
  }

  return signals;
}

async function collectPrReviewDetail(
  secrets: Secrets,
  raw: any,
  botAccounts: ReadonlySet<string>,
  keepIndividuals: boolean,
): Promise<ReviewSignals> {
  const repo = raw?.base?.repo?.full_name;
  const number = raw?.number;
  const requestedReviewerCount = (raw?.requested_reviewers ?? []).length;

  let reviews: any[] = [];
  let comments: any[] = [];
  try {
    reviews = await githubPaginate(secrets, `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
    // `comments` on the list payload is the issue-comment count; skip the call
    // when it is zero, the same optimisation as the GitLab collector's
    // user_notes_count check.
    if ((raw?.comments ?? 0) > 0) {
      comments = await githubPaginate(secrets, `/repos/${repo}/issues/${number}/comments?per_page=100`);
    }
  } catch (err) {
    const partial = deriveGithubReviewSignals(reviews, comments, raw?.user, requestedReviewerCount, botAccounts, keepIndividuals);
    partial.error = (err as Error).message;
    return partial;
  }
  return deriveGithubReviewSignals(reviews, comments, raw?.user, requestedReviewerCount, botAccounts, keepIndividuals);
}

/** GitHub counterpart to `collectTeamMergeRequests`. Same options, same return
 *  shape - the caller in cli.ts picks between the two on `config.forge`. */
export async function collectTeamPullRequests(
  secrets: Secrets,
  team: TeamConfig,
  opts: CollectMergeRequestOptions,
): Promise<{ mergeRequests: MergeRequestSnapshot[]; errors: string[] }> {
  const { windowDays, keepIndividuals, now, knownProjectKeys } = opts;
  const botAccounts = botAccountSet(opts.botAccounts ?? []);
  const errors: string[] = [];
  const sinceMs = now.getTime() - windowDays * 86_400_000;
  const byId = new Map<number, MergeRequestSnapshot>();
  const rawById = new Map<number, any>();

  for (const repo of team.githubRepos ?? []) {
    try {
      // GOTCHA: /pulls has no `updated_after`. Sorting by `updated` descending
      // and stopping at the first row outside the window is the standard way to
      // bound it - anything earlier in the list is more recently updated, so a
      // single stale row means the rest of the listing is stale too.
      const raw = await githubPaginate(
        secrets,
        `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
        (row) => {
          const t = Date.parse(row?.updated_at ?? '');
          return Number.isFinite(t) && t < sinceMs;
        },
      );
      for (const r of raw) {
        const mr = normaliseGithubPr(r, keepIndividuals, knownProjectKeys);
        byId.set(mr.id, mr);
        rawById.set(mr.id, r);
      }
    } catch (err) {
      errors.push(`repo ${repo}: ${(err as Error).message}`);
    }
  }

  if (opts.withReviewDetail) {
    const entries = [...byId.entries()];
    const reviews = await mapWithConcurrency(
      entries,
      opts.reviewConcurrency ?? DEFAULT_REVIEW_CONCURRENCY,
      ([id]) => collectPrReviewDetail(secrets, rawById.get(id), botAccounts, keepIndividuals),
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
