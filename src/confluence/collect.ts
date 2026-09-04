import type { ConfluencePage, ConfluenceSpace, Secrets, TeamConfig, TeamSnapshot } from '../types.js';
import { createAtlassianGet, type RequestGate } from '../jira/client.js';

// ---------------------------------------------------------------------------
// Confluence context.
//
// WHY THIS EXISTS. Everything else in this tool answers "how is delivery
// going" for someone who already knows what WEB, ONB and `panther` are. A
// report that opens with "panther: 198 pts committed against a p90 of 107.8"
// is unreadable to anyone who does not, and that includes most of the senior
// management it is shown to - and, on any board the manager does not run
// day to day, the manager. Confluence is where the answer to "what IS this
// team, and what is this epic for" is already written down. This pulls the
// pointers to it into the snapshot so the report can put a route to the
// explanation next to every number.
//
// WHAT IT DELIBERATELY DOES NOT DO: store page BODIES. The report is a
// self-contained file that has to open from the filesystem, and a wiki mirror
// inside it would be stale the day after it was generated and would quietly
// become the thing people read instead of the live page. Titles, timestamps and
// URLs only.
//
// Same rules as everywhere else: pure normalisers separated from the network,
// no AI, and a team that fails is recorded with its errors rather than aborting
// the run.
// ---------------------------------------------------------------------------

/** Joins a Confluence-relative link (`/spaces/ENG/pages/123/Title`) onto the
 *  site base.
 *
 *  GOTCHA: the v1 search API returns `url` relative to the WIKI root, not to the
 *  site root - "/spaces/X/pages/1" has to become
 *  "https://site/wiki/spaces/X/pages/1". Concatenating it onto the site base
 *  alone produces a 404 that looks like a permissions problem, and concatenating
 *  it onto a base that already ends in /wiki produces /wiki/wiki. Both have to
 *  be handled here rather than at three call sites. */
export function absoluteUrl(baseUrl: string, link: string | undefined): string {
  const site = baseUrl.replace(/\/+$/, '');
  if (!link) return `${site}/wiki`;
  if (/^https?:\/\//i.test(link)) return link;
  const path = link.startsWith('/') ? link : `/${link}`;
  if (path.startsWith('/wiki/')) return `${site}${path}`;
  return `${site}/wiki${path}`;
}

/** Confluence search excerpts arrive with `@@@hl@@@`/`@@@endhl@@@` highlight
 *  markers around the matched term and HTML entities elsewhere. Left in, they
 *  render as literal noise in the report. */
export function cleanExcerpt(raw: unknown, maxChars = 220): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const text = raw
    .replace(/@@@endhl@@@/g, '')
    .replace(/@@@hl@@@/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
}

export function normaliseSearchResult(
  raw: any,
  baseUrl: string,
  reason: ConfluencePage['reason'],
  matched?: string,
): ConfluencePage | null {
  const content = raw?.content ?? raw;
  const id = content?.id ?? raw?.id;
  if (!id) return null;
  const spaceKey = raw?.resultGlobalContainer?.displayUrl?.match(/\/spaces\/([^/]+)/)?.[1] ?? content?.space?.key ?? raw?.space?.key;
  return {
    id: String(id),
    // `raw.title` on a search hit carries the highlight markers too, so the
    // content title is preferred and the search title is only the fallback.
    title: String(content?.title ?? cleanExcerpt(raw?.title, 200) ?? 'Untitled'),
    url: absoluteUrl(baseUrl, raw?.url ?? content?._links?.webui),
    spaceKey: String(spaceKey ?? '?'),
    spaceName: raw?.resultGlobalContainer?.title ?? content?.space?.name,
    lastUpdated: raw?.lastModified ?? content?.version?.when,
    lastUpdatedBy: content?.version?.by?.displayName,
    excerpt: cleanExcerpt(raw?.excerpt),
    reason,
    matched,
  };
}

export function normaliseSpace(raw: any, baseUrl: string): ConfluenceSpace | null {
  if (!raw?.key) return null;
  return {
    key: String(raw.key),
    name: String(raw.name ?? raw.key),
    url: absoluteUrl(baseUrl, raw?._links?.webui ?? `/spaces/${raw.key}`),
    type: raw.type,
  };
}

/** Project keys a board actually carries, counted from its ISSUES.
 *
 *  Same rule as `projectPrefixes` in the report layer, and for the same reason:
 *  board 703 is located in project OPS and every issue on it is LOG-keyed, so
 *  the board's own location would search Confluence for the wrong product. */
export function projectKeysOf(team: TeamSnapshot): string[] {
  const counts = new Map<string, number>();
  for (const i of team.issues) {
    const dash = i.key.lastIndexOf('-');
    if (dash > 0) counts.set(i.key.slice(0, dash), (counts.get(i.key.slice(0, dash)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
}

/** CQL is quoted with double quotes and has no escape for one inside a term, so
 *  a stray quote in a project key or space key would produce a 400 that reads
 *  like a malformed query. Keys are alphanumeric on every Atlassian site, so
 *  anything else is dropped rather than escaped. */
export function cqlSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9_\- ]/g, '');
}

export interface CollectContextOptions {
  /** Pages per space in the "recently updated" list. */
  recentPerSpace?: number;
  /** Pages per project key in the "mentions this product" list. */
  mentionsPerKey?: number;
  /** How many of the board's project keys to search for. The tail of that list
   *  is usually one or two stray issues moved onto the board from elsewhere, and
   *  searching for them pulls in another team's documentation. */
  topProjectKeys?: number;
  /** Share the Jira client's in-flight ceiling.
   *
   *  Confluence is the SAME host, the same credentials and the same rate limit
   *  as Jira - that is already why this module borrows createAtlassianGet - so
   *  it must borrow the ceiling too. Without this, a Confluence pass adds its
   *  own concurrency on top of whatever the Jira passes are doing and the limit
   *  that is written down is not the limit that applies. */
  gate?: RequestGate;
}

export async function collectTeamContext(
  secrets: Secrets,
  team: TeamConfig,
  snapshot: TeamSnapshot | undefined,
  opts: CollectContextOptions = {},
): Promise<{ spaces: ConfluenceSpace[]; pages: ConfluencePage[]; errors: string[] }> {
  const get = createAtlassianGet(secrets, { gate: opts.gate });
  const base = secrets.atlassianBaseUrl.replace(/\/+$/, '');
  const errors: string[] = [];
  const spaceKeys = (team.confluenceSpaces ?? []).map(cqlSafe).filter(Boolean);
  const recentPerSpace = opts.recentPerSpace ?? 8;
  const mentionsPerKey = opts.mentionsPerKey ?? 8;
  const topKeys = (snapshot ? projectKeysOf(snapshot) : []).slice(0, opts.topProjectKeys ?? 2).map(cqlSafe).filter(Boolean);

  const spaces: ConfluenceSpace[] = [];
  const byId = new Map<string, ConfluencePage>();

  const add = (p: ConfluencePage | null): void => {
    if (!p) return;
    // First reason wins. A page that is both the space home and recently
    // updated is a space home; listing it twice would make the context panel
    // look like it found more than it did.
    if (!byId.has(p.id)) byId.set(p.id, p);
  };

  for (const key of spaceKeys) {
    try {
      const raw = await get(`/wiki/rest/api/space/${encodeURIComponent(key)}?expand=homepage`);
      const space = normaliseSpace(raw, base);
      if (space) spaces.push(space);
      if (raw?.homepage) {
        add({
          id: String(raw.homepage.id),
          title: String(raw.homepage.title ?? space?.name ?? key),
          url: absoluteUrl(base, raw.homepage._links?.webui),
          spaceKey: key,
          spaceName: space?.name,
          reason: 'space-home',
        });
      }
    } catch (err) {
      errors.push(`space ${key}: ${(err as Error).message}`);
    }
  }

  if (spaceKeys.length > 0) {
    const cql = `space in (${spaceKeys.join(',')}) and type = page order by lastmodified desc`;
    try {
      const raw = await get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${recentPerSpace * spaceKeys.length}`);
      for (const r of raw?.results ?? []) add(normaliseSearchResult(r, base, 'recent'));
    } catch (err) {
      errors.push(`recent pages: ${(err as Error).message}`);
    }
  }

  // Pages that mention the board's own project keys. This is what finds the
  // documentation for a team whose space is not configured, and it is the same
  // evidence-first move that mapped the GitLab groups: search for the thing the
  // team's work is actually named after rather than asking the reader which
  // space is theirs.
  for (const key of topKeys) {
    const scope = spaceKeys.length > 0 ? `space in (${spaceKeys.join(',')}) and ` : '';
    const cql = `${scope}type = page and text ~ "${key}-" order by lastmodified desc`;
    try {
      const raw = await get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${mentionsPerKey}`);
      for (const r of raw?.results ?? []) add(normaliseSearchResult(r, base, 'mentions-project', key));
    } catch (err) {
      errors.push(`mentions of ${key}: ${(err as Error).message}`);
    }
  }

  return {
    spaces,
    pages: [...byId.values()].sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? '')),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Discovery: which space belongs to which team
// ---------------------------------------------------------------------------

export interface SpaceScore {
  key: string;
  name: string;
  url: string;
  /** Search hits, per project key, that landed in this space. */
  hitsByKey: Record<string, number>;
  total: number;
}

/** Scores every space by how often this board's project keys appear in it.
 *
 *  The manager does not know which Confluence space belongs to which team, and
 *  finding that out is a purpose of this tool rather than a prerequisite for it
 *  - exactly as with the GitLab groups (docs/handover.md). One CQL search per
 *  project key, tallied by space, produces the evidence; the caller prints it
 *  and the person decides. Nothing here writes to the config. */
export async function discoverSpaces(
  secrets: Secrets,
  projectKeys: string[],
  opts: { limitPerKey?: number } = {},
): Promise<SpaceScore[]> {
  const get = createAtlassianGet(secrets);
  const base = secrets.atlassianBaseUrl.replace(/\/+$/, '');
  const limit = opts.limitPerKey ?? 100;
  const byKey = new Map<string, SpaceScore>();

  for (const raw of projectKeys) {
    const key = cqlSafe(raw);
    if (!key) continue;
    const cql = `type = page and text ~ "${key}-" order by lastmodified desc`;
    const resp = await get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
    for (const r of resp?.results ?? []) {
      const page = normaliseSearchResult(r, base, 'mentions-project', key);
      if (!page || page.spaceKey === '?') continue;
      const entry = byKey.get(page.spaceKey) ?? {
        key: page.spaceKey,
        name: page.spaceName ?? page.spaceKey,
        url: absoluteUrl(base, `/spaces/${page.spaceKey}`),
        hitsByKey: {},
        total: 0,
      };
      entry.hitsByKey[key] = (entry.hitsByKey[key] ?? 0) + 1;
      entry.total++;
      byKey.set(page.spaceKey, entry);
    }
  }

  return [...byKey.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

export function formatSpaceScores(scores: SpaceScore[]): string {
  if (scores.length === 0) return 'No Confluence page mentions any of these project keys.';
  const lines = ['  hits  space                            evidence'];
  for (const s of scores) {
    const ev = Object.entries(s.hitsByKey)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ');
    lines.push(`  ${String(s.total).padStart(4)}  ${`${s.key} - ${s.name}`.slice(0, 32).padEnd(32)} ${ev}`);
  }
  lines.push('');
  lines.push('Put the winning space key into teams[].confluenceSpaces in the profile config.');
  lines.push('A space that scores on SEVERAL teams is a shared/company space, not a team home.');
  return lines.join('\n');
}
