import { gitlabGet, gitlabPaginate } from './collect.js';
import type { Secrets } from '../types.js';

export interface DiscoveredGroup {
  id: number;
  /** The value that goes into a team's `gitlabGroups`. */
  fullPath: string;
  name: string;
  /** null when the group is top-level. */
  parentId: number | null;
  webUrl: string;
  /** Whether the token owner is a member. Reported, never used to filter - see
   *  the GOTCHA on discoverGroups. */
  isMember: boolean;
  /** Merge requests updated inside the window. `atLeast` is true when the count
   *  hit the page limit and the real number is higher - see the GOTCHA below. */
  recentMergeRequests: { count: number; atLeast: boolean } | null;
  /** Populated when the MR probe failed for this group alone. */
  error?: string;
}

/** Every group the token can see, membership or not.
 *
 *  GOTCHA, and it cost a wrong answer before it was found: filtering with
 *  `min_access_level=10` restricts the listing to groups the token owner is a
 *  MEMBER of, and **a manager is frequently not a member of their own team's
 *  group**. On this instance that filter returned 28 groups and hid the one that
 *  actually matters - `web-storefront`, which is where board 701 (WEB
 *  Scrum = Web Platform Project) does its work. Configuring from the filtered
 *  list produced review metrics for an entirely different set of people.
 *
 *  So the listing is `all_available=true` and membership is REPORTED, never used
 *  to exclude. A group you can read merge requests from is a group worth
 *  offering, whether or not you were added to it.
 *
 *  GOTCHA: this returns subgroups as well as top-level groups, and a subgroup's
 *  merge requests are ALSO returned by its parent. Listing both a parent and a
 *  child in one team double-counts nothing (collectTeamMergeRequests dedupes on
 *  the global MR id) but does waste a full pagination sweep, so the report marks
 *  the parent/child relationship rather than leaving it to be spotted by eye. */
export async function discoverGroups(
  secrets: Secrets,
  opts: { windowDays?: number; search?: string; membersOnly?: boolean } = {},
): Promise<DiscoveredGroup[]> {
  const search = opts.search ? `&search=${encodeURIComponent(opts.search)}` : '';
  const raw = await gitlabPaginate(
    secrets,
    `/groups?${opts.membersOnly ? 'min_access_level=10' : 'all_available=true'}${search}`,
  );

  // Which of them the token owner is actually a member of - for display only.
  const memberIds = new Set<number>();
  if (!opts.membersOnly) {
    try {
      for (const g of await gitlabPaginate(secrets, `/groups?min_access_level=10${search}`)) {
        memberIds.add(g.id);
      }
    } catch {
      // Non-fatal: the listing is still correct, just without the member column.
    }
  }

  const groups: DiscoveredGroup[] = raw.map((g: any) => ({
    id: g.id,
    fullPath: g.full_path,
    name: g.full_name ?? g.name,
    parentId: g.parent_id ?? null,
    webUrl: g.web_url ?? '',
    isMember: opts.membersOnly ? true : memberIds.has(g.id),
    recentMergeRequests: null,
  }));

  if (opts.windowDays === undefined) return groups;

  const since = new Date(Date.now() - opts.windowDays * 86_400_000).toISOString();
  // One probe per group. The unfiltered listing runs to a few hundred on a
  // self-managed instance, which is a slow command but a once-per-team one.
  for (const g of groups) {
    try {
      g.recentMergeRequests = await countRecentMergeRequests(secrets, g.fullPath, since);
    } catch (err) {
      // One inaccessible group must not sink the listing: a Guest membership on
      // a group with merge requests disabled returns 403 here and 200 above.
      g.error = (err as Error).message;
    }
  }
  return groups;
}

const PROBE_PAGE = 100;

/** How many merge requests a group has seen recently.
 *
 *  GOTCHA: this deliberately does NOT read the X-Total header. GitLab omits the
 *  count headers entirely once a result set is large (and on any keyset-paginated
 *  response), so a collector that trusts X-Total silently reports 0 for exactly
 *  the busiest groups. Fetching one page and reporting ">= 100" when another page
 *  exists is one request either way and cannot lie. */
async function countRecentMergeRequests(
  secrets: Secrets,
  fullPath: string,
  since: string,
): Promise<{ count: number; atLeast: boolean }> {
  const { body, nextPage } = await gitlabGet(
    secrets,
    `/groups/${encodeURIComponent(fullPath)}/merge_requests` +
      `?scope=all&state=all&updated_after=${encodeURIComponent(since)}&per_page=${PROBE_PAGE}&page=1`,
  );
  const count = Array.isArray(body) ? body.length : 0;
  return { count, atLeast: Boolean(nextPage) };
}

/** Renders the listing, marking which groups are worth configuring.
 *
 *  Sorted by activity rather than by name: the question this command answers is
 *  "which of these is a team", and a group with no merge requests in the window
 *  is not one. */
export function formatGroups(groups: DiscoveredGroup[], windowDays?: number): string {
  const ids = new Set(groups.map((g) => g.id));
  const byActivity = [...groups]
    .sort(
      (a, b) =>
        (b.recentMergeRequests?.count ?? -1) - (a.recentMergeRequests?.count ?? -1) ||
        a.fullPath.localeCompare(b.fullPath),
    )
    // A group with no merge requests in the window is not a team. Listing every
    // dormant group on a self-managed instance buries the handful that are.
    .filter((g) => g.recentMergeRequests === null || g.recentMergeRequests.count > 0 || Boolean(g.error));

  const out: string[] = [];
  for (const g of byActivity) {
    const nested = g.parentId !== null && ids.has(g.parentId) ? '  (subgroup of a group also listed)' : '';
    const member = g.isMember ? '  ' : ' *';
    let activity = '';
    if (g.error) activity = `  MR probe failed: ${g.error.slice(0, 60)}`;
    else if (g.recentMergeRequests) {
      const { count, atLeast } = g.recentMergeRequests;
      activity = `  ${atLeast ? `>=${count}` : String(count)} MR(s)/${windowDays}d`;
    }
    out.push(`${String(g.id).padStart(7)}${member} ${g.fullPath.padEnd(44)}${activity}${nested}`);
  }
  out.push('');
  out.push('  * = you are not a member of this group. That is NOT a reason to skip it -');
  out.push('      a manager is often not a member of their own team\'s group.');
  return out.join('\n');
}
