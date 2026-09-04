// ---------------------------------------------------------------------------
// Deep links.
//
// A report full of bare identifiers - WEB-1387, `logistics-hub`, board 701 - is
// only legible to someone who already knows the estate. Every one of those is a
// URL away from the thing it names, and a reader who can click through to the
// ticket stops needing to be told what the ticket is.
//
// Everything here is derived from data ALREADY IN THE SNAPSHOT. Nothing reads
// secrets and nothing calls the network: the Jira host is on the snapshot, and
// the GitLab host is recovered from the merge-request web URLs the collector
// recorded. That matters because the report is generated from files on disk and
// must produce identical output whether or not credentials happen to be present.
// ---------------------------------------------------------------------------

/** The Jira site as an absolute origin.
 *
 *  GOTCHA: `config.site` is a bare HOST ("acme.atlassian.net"), not a
 *  URL, while `secrets.atlassianBaseUrl` is a full one. Both end up in front of
 *  this function depending on the caller, and prefixing "https://" onto a value
 *  that already has it produces "https://https://…" - a link that fails
 *  silently, because a broken href looks exactly like a working one until it is
 *  clicked. */
export function siteOrigin(site: string): string {
  const trimmed = site.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function issueUrl(site: string, key: string): string {
  const origin = siteOrigin(site);
  return origin ? `${origin}/browse/${encodeURIComponent(key)}` : '';
}

/** The board itself. `/secure/RapidBoard.jspa?rapidView=N` is used rather than
 *  the newer `/jira/software/c/projects/KEY/boards/N` route because it needs
 *  only the board ID - the project key in the modern route is the board's
 *  LOCATION project, and board 703 is located in OPS while containing only
 *  LOG issues, so building that route from the issue prefix produces a link to
 *  a board that does not exist. */
export function boardUrl(site: string, boardId: number): string {
  const origin = siteOrigin(site);
  return origin ? `${origin}/secure/RapidBoard.jspa?rapidView=${boardId}` : '';
}

export function sprintReportUrl(site: string, boardId: number, sprintId: number): string {
  const origin = siteOrigin(site);
  return origin
    ? `${origin}/secure/RapidBoard.jspa?rapidView=${boardId}&view=reporting&chart=sprintRetrospective&sprint=${sprintId}`
    : '';
}

/** A JQL search the reader can open, edit and re-run. Used wherever the report
 *  shows a COUNT that it has truncated: "43 of these" is only useful if the
 *  other 30 are one click away. */
export function jqlUrl(site: string, jql: string): string {
  const origin = siteOrigin(site);
  return origin ? `${origin}/issues/?jql=${encodeURIComponent(jql)}` : '';
}

/** A JQL clause listing specific keys, for the "open all of these" links.
 *  Bounded: a URL carrying 400 issue keys exceeds what several corporate
 *  proxies will forward, and the failure is a blank page rather than an error. */
export function keysJql(keys: string[], limit = 60): string {
  const list = keys.slice(0, limit);
  return list.length === 0 ? '' : `key in (${list.join(',')}) order by rank`;
}

export function confluenceSearchUrl(site: string, text: string): string {
  const origin = siteOrigin(site);
  return origin ? `${origin}/wiki/search?text=${encodeURIComponent(text)}` : '';
}

/** A space's own home, from its key.
 *
 *  `/wiki/spaces/<KEY>` is the stable form on Cloud and it resolves whether or
 *  not the space has an overview page, which is why the key is used rather than
 *  a page id: the collected space record carries the key on every snapshot and
 *  a homepage id on none of them. */
export function confluenceSpaceUrl(site: string, spaceKey: string): string {
  const origin = siteOrigin(site);
  return origin && spaceKey ? `${origin}/wiki/spaces/${encodeURIComponent(spaceKey)}` : '';
}

// --- GitLab ------------------------------------------------------------------

/** Recovers the GitLab origin from any merge-request web URL in the snapshot.
 *
 *  The alternative is threading `secrets.gitlabBaseUrl` through the report
 *  layer, which would make the HTML depend on credentials being present at
 *  RENDER time - so regenerating an old report on a machine without them would
 *  silently drop every GitLab link. The URLs are already in the data. */
export function gitlabOriginFrom(webUrls: Array<string | undefined>): string {
  for (const u of webUrls) {
    if (!u) continue;
    const m = /^(https?:\/\/[^/]+)/i.exec(u);
    if (m) return m[1]!;
  }
  return '';
}

export function gitlabGroupUrl(origin: string, groupPath: string): string {
  return origin ? `${origin}/${groupPath.replace(/^\/+/, '')}` : '';
}

/** The group's merge-request list, filtered the way the report's own numbers
 *  are: merged, most recent first. Someone who disbelieves a figure should land
 *  on the list it was counted from. */
export function gitlabGroupMergeRequestsUrl(origin: string, groupPath: string, state = 'merged'): string {
  return origin ? `${origin}/groups/${groupPath.replace(/^\/+/, '')}/-/merge_requests?state=${state}&sort=updated_desc` : '';
}

export function gitlabProjectUrl(origin: string, projectPath: string | undefined): string {
  return origin && projectPath ? `${origin}/${projectPath.replace(/^\/+/, '')}` : '';
}
