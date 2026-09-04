import type {
  EpicSnapshot,
  FieldMap,
  IssueComment,
  IssueSnapshot,
  Person,
  SprintSnapshot,
  TeamConfig,
  TeamSnapshot,
} from '../types.js';
import { issueFields, JiraNotFound, type JiraClient } from './client.js';
import { classifyBlockers, excerpt } from './text.js';

/** How much of a description survives into the snapshot.
 *
 *  280 characters is a deliberate ceiling, not a rounding of "some". The
 *  snapshot is committed to the repo and already runs 27 MB a day across four
 *  boards; a full description field on 20,700 issues would add several more for
 *  text that only ever appears in a hover card two lines tall. This is the
 *  amount that fits there. */
export const DESCRIPTION_CHARS = 280;
/** Comment bodies are shorter still: the question a comment answers here is
 *  "is there a blocker written down that nobody flagged", and that is visible in
 *  the first sentence or it is not visible at all. */
export const COMMENT_CHARS = 240;
/** Comments kept per issue, most recent first. */
export const COMMENTS_PER_ISSUE = 3;

// ---------------------------------------------------------------------------
// Pure normalisers - every one of these is unit-tested against fixtures, and
// none of them touch the network.
// ---------------------------------------------------------------------------

export function toPerson(raw: any, keepIndividuals: boolean): Person | undefined {
  if (!raw || !keepIndividuals) return undefined;
  return {
    accountId: raw.accountId,
    displayName: raw.displayName,
    email: raw.emailAddress ?? undefined,
  };
}

/** Sprint values arrive in one of two shapes and BOTH occur in practice:
 *  a real object (what /rest/api/3 and /rest/agile/1.0 return today), or the
 *  legacy GreenHopper toString - "...Sprint@1a2b[id=6145,name=Panther 55,...]".
 *  Parsing only the object form loses every sprint on the legacy shape, which
 *  reads as "this issue was never in a sprint" and destroys carryover counts. */
export function parseSprintValue(v: unknown): SprintSnapshot | null {
  if (v && typeof v === 'object') {
    const o = v as any;
    if (typeof o.id !== 'number') return null;
    return {
      id: o.id,
      name: String(o.name ?? ''),
      state: String(o.state ?? 'unknown'),
      goal: o.goal || undefined,
      startDate: o.startDate ?? undefined,
      endDate: o.endDate ?? undefined,
      completeDate: o.completeDate ?? undefined,
    };
  }
  if (typeof v !== 'string') return null;
  const body = v.slice(v.indexOf('[') + 1, v.lastIndexOf(']'));
  if (!body) return null;
  const kv = new Map<string, string>();
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const id = Number(kv.get('id'));
  if (!Number.isFinite(id)) return null;
  const val = (k: string) => {
    const s = kv.get(k);
    return s && s !== '<null>' && s !== 'null' ? s : undefined;
  };
  return {
    id,
    name: val('name') ?? '',
    state: (val('state') ?? 'unknown').toLowerCase(),
    goal: val('goal'),
    startDate: val('startDate'),
    endDate: val('endDate'),
    completeDate: val('completeDate'),
  };
}

/** Every sprint object carried on one raw issue. Kept separate from
 *  normaliseIssue so the collector can merge issue-side sprint metadata into
 *  the board-side sprint list without parsing the issue twice. */
export function extractSprints(raw: any, map: FieldMap): SprintSnapshot[] {
  const v = map.sprint ? raw?.fields?.[map.sprint] : undefined;
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.map(parseSprintValue).filter((s): s is SprintSnapshot => s !== null);
}

/** Reads the FIRST story-point field that actually holds a number and reports
 *  which one it was. Returning the source field is what makes "this team does
 *  not estimate" distinguishable from "we read the wrong of the two fields". */
export function readStoryPoints(fields: any, candidates: string[]): { points: number | null; field: string | null } {
  for (const id of candidates) {
    const v = fields?.[id];
    if (typeof v === 'number' && Number.isFinite(v)) return { points: v, field: id };
  }
  return { points: null, field: null };
}

export function normaliseIssue(
  raw: any,
  map: FieldMap,
  opts: { keepIndividuals: boolean; backlogKeys: Set<string> },
): IssueSnapshot {
  const f = raw.fields ?? {};
  const { points, field } = readStoryPoints(f, map.storyPoints);

  const links: IssueSnapshot['links'] = [];
  for (const l of f.issuelinks ?? []) {
    if (l.outwardIssue) {
      links.push({ type: l.type?.outward ?? l.type?.name ?? 'relates to', direction: 'outward', key: l.outwardIssue.key });
    }
    if (l.inwardIssue) {
      links.push({ type: l.type?.inward ?? l.type?.name ?? 'relates to', direction: 'inward', key: l.inwardIssue.key });
    }
  }

  // The Flagged field is a multi-select, not a boolean: an unflagged issue is
  // null and a flagged one is a one-element array of options. A bare !! would
  // therefore report an empty array as flagged - hence the length check.
  const flaggedRaw = map.flagged ? f[map.flagged] : undefined;
  const flagged = Array.isArray(flaggedRaw) ? flaggedRaw.length > 0 : Boolean(flaggedRaw);

  const desc = excerpt(f.description, DESCRIPTION_CHARS);
  const { blockedBy, blocks } = classifyBlockers(links);

  return {
    key: raw.key,
    id: String(raw.id),
    issueType: f.issuetype?.name ?? 'Unknown',
    // GOTCHA: `summary` was in the requested field list from the very first
    // commit and was then dropped here, so every snapshot on disk carries the
    // network cost of fetching ticket titles and none of the benefit. A report
    // that can only print "WEB-1387" cannot tell a reader who does not already
    // know the board anything at all.
    summary: typeof f.summary === 'string' && f.summary.length > 0 ? f.summary : undefined,
    description: desc?.text,
    descriptionTruncated: desc?.truncated ? true : undefined,
    status: f.status?.name ?? 'Unknown',
    statusId: f.status?.id !== undefined ? String(f.status.id) : undefined,
    statusCategory: f.status?.statusCategory?.name ?? 'Unknown',
    statusCategoryChangedAt: f.statuscategorychangedate ?? undefined,
    priority: f.priority?.name ?? undefined,
    resolution: f.resolution?.name ?? undefined,
    resolutionDate: f.resolutiondate ?? undefined,
    created: f.created,
    updated: f.updated,
    dueDate: f.duedate ?? undefined,
    assignee: toPerson(f.assignee, opts.keepIndividuals),
    reporter: toPerson(f.reporter, opts.keepIndividuals),
    creator: toPerson(f.creator, opts.keepIndividuals),
    storyPoints: points,
    storyPointsField: field,
    epicKey: (map.epicLink ? f[map.epicLink] : undefined) ?? undefined,
    parentKey: f.parent?.key ?? undefined,
    rank: (map.rank ? f[map.rank] : undefined) ?? undefined,
    flagged,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c: any) => c.name),
    // GOTCHA (confirmed live on WEB-1180): Jira returns the Sprint array in
    // INSERTION order, not chronological order - a real value was
    // [5462, 6145, 5840, 5566, 5976, 5636, 5738], with the currently active
    // sprint sitting second. Sorting ascending restores chronological order,
    // because sprint ids increase monotonically as sprints are created. Without
    // this, sprintIds[0] is not the first sprint the issue was in.
    sprintIds: extractSprints(raw, map)
      .map((s) => s.id)
      .sort((a, b) => a - b),
    timeOriginalEstimateSeconds: f.timeoriginalestimate ?? undefined,
    timeSpentSeconds: f.timespent ?? undefined,
    links,
    blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    comments: undefined,
    commentCount: typeof f.comment?.total === 'number' ? f.comment.total : undefined,
    inBacklog: opts.backlogKeys.has(raw.key),
  };
}

// ---------------------------------------------------------------------------
// Detail pass: descriptions, comments and epic names
// ---------------------------------------------------------------------------

/** Normalises one comment from either the v3 (ADF body) or v2 (string body)
 *  shape - `excerpt` copes with both, which is the whole reason it exists. */
export function normaliseComment(raw: any, keepIndividuals: boolean): IssueComment | null {
  if (!raw?.id) return null;
  const body = excerpt(raw.body, COMMENT_CHARS);
  if (!body) return null;
  return {
    id: String(raw.id),
    author: toPerson(raw.author ?? raw.updateAuthor, keepIndividuals),
    created: raw.created ?? raw.updated ?? '',
    updated: raw.updated && raw.updated !== raw.created ? raw.updated : undefined,
    body: body.text,
    truncated: body.truncated,
  };
}

/** The last few comments on an issue, newest first.
 *
 *  GOTCHA: the `comment` FIELD returns comments OLDEST first and caps at its own
 *  maxResults, so `comments.slice(0, 3)` yields the three oldest - which on a
 *  long-running ticket are the ones from months ago that say "picked this up".
 *  The newest comments are the ones that say why it is stuck. Taken from the
 *  END, and `total` is kept separately so the UI can say "3 of 27". */
export function recentComments(field: any, keepIndividuals: boolean): { comments: IssueComment[]; total: number } {
  const all: any[] = Array.isArray(field?.comments) ? field.comments : [];
  const kept = all
    .slice(-COMMENTS_PER_ISSUE)
    .reverse()
    .map((c) => normaliseComment(c, keepIndividuals))
    .filter((c): c is IssueComment => c !== null);
  return { comments: kept, total: typeof field?.total === 'number' ? field.total : all.length };
}

export function normaliseEpic(raw: any): EpicSnapshot | null {
  if (!raw?.key) return null;
  return {
    id: Number(raw.id),
    key: String(raw.key),
    // The epic NAME is a distinct field from the epic issue's summary and the
    // two are often different - the name is the short label on the board swim
    // lane, which is what a reader recognises.
    name: String(raw.name ?? raw.summary ?? raw.key),
    summary: raw.summary && raw.summary !== raw.name ? String(raw.summary) : undefined,
    done: raw.done === true,
  };
}

/** One issue's detail-pass payload.
 *
 *  `comments`/`commentTotal` are OPTIONAL, and that is the whole contract: a
 *  pass that did not ASK Jira for the comment field must leave them absent, not
 *  set them to `[]` and `0`. See applyIssueDetail. */
export interface IssueDetail {
  description?: string;
  descriptionTruncated?: boolean;
  comments?: IssueComment[];
  commentTotal?: number;
}

/** Folds a detail-pass payload back onto the issues already collected.
 *
 *  Pure, and separate from the network call, so the merge rule is testable: an
 *  issue the detail pass did not reach keeps `comments: undefined`, which the UI
 *  reads as NOT COLLECTED. Setting it to `[]` there would claim the thread was
 *  read and found empty, and that is the difference between "no blocker was
 *  written down" and "nobody looked".
 *
 *  GOTCHA: that applies just as much to an issue the pass DID reach with a
 *  narrower field list. The backlog leg fetches `fields=summary,description`
 *  with no `comment`, so folding a `comments: []` from it in claimed 400 backlog
 *  tickets on the 2026-08-28 snapshot had been read and found silent. An absent
 *  `comments` on the payload therefore leaves whatever the issue already had. */
export function applyIssueDetail(
  issues: IssueSnapshot[],
  detail: Map<string, IssueDetail>,
  epics: Map<string, EpicSnapshot>,
): IssueSnapshot[] {
  return issues.map((i) => {
    const d = detail.get(i.key);
    const epic = i.epicKey ? epics.get(i.epicKey) : undefined;
    if (!d && !epic) return i;
    return {
      ...i,
      description: d?.description ?? i.description,
      descriptionTruncated: d?.descriptionTruncated ?? i.descriptionTruncated,
      comments: d?.comments ?? i.comments,
      commentCount: d?.commentTotal ?? i.commentCount,
      epicName: epic?.name ?? i.epicName,
    };
  });
}

/** Sprint metadata reaches us twice: from the board's sprint list, and inlined
 *  on every issue. Merging both matters because a sprint an issue carries but
 *  the board no longer lists (moved boards, deleted sprints) would otherwise
 *  leave issue.sprintIds pointing at nothing. */
export function mergeSprints(fromBoard: SprintSnapshot[], fromIssues: SprintSnapshot[]): SprintSnapshot[] {
  const byId = new Map<number, SprintSnapshot>();
  // Issue-side entries land first so board-side entries, which are complete and
  // authoritative, overwrite them on conflict.
  for (const s of [...fromIssues, ...fromBoard]) {
    const existing = byId.get(s.id);
    byId.set(s.id, existing ? { ...existing, ...s } : s);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// Network collection
// ---------------------------------------------------------------------------

export interface CollectTeamOptions {
  keepIndividuals: boolean;
  /** Run the second pass that fetches descriptions, comments and epic names for
   *  work that is OPEN IN THE ACTIVE SPRINT plus the top of the backlog.
   *
   *  Bounded on purpose. Descriptions for all 20,700 issues on this site would
   *  add several megabytes to a snapshot that is committed daily, for text no
   *  panel shows: the hover cards and blocker readings only ever cover the
   *  active sprint and the next-up backlog. */
  withDetail?: boolean;
  /** Pages of the backlog (50 issues each) to fetch detail for, in board RANK
   *  order - so this is "the top N of the backlog", the part that actually gets
   *  pulled, not an arbitrary slice. */
  backlogDetailPages?: number;
}

export async function collectTeam(
  client: JiraClient,
  team: TeamConfig,
  map: FieldMap,
  opts: CollectTeamOptions | boolean,
): Promise<TeamSnapshot> {
  // The fourth argument used to be a bare boolean. Accepting both keeps every
  // existing caller and test working while the options object carries the new
  // detail-pass switches.
  const options: CollectTeamOptions = typeof opts === 'boolean' ? { keepIndividuals: opts } : opts;
  const keepIndividuals = options.keepIndividuals;
  const errors: string[] = [];
  const extra = [map.sprint, ...map.storyPoints, map.epicLink, map.rank, map.flagged, map.team].filter(
    (x): x is string => !!x,
  );
  const fields = issueFields(extra);

  let boardName: string | undefined;
  let boardType: string | undefined;
  let columns: TeamSnapshot['columns'] = [];
  try {
    const cfg = await client.get(`/rest/agile/1.0/board/${team.boardId}/configuration`);
    boardName = cfg?.name;
    boardType = cfg?.type;
    columns = (cfg?.columnConfig?.columns ?? []).map((c: any) => ({
      name: c.name,
      statusIds: (c.statuses ?? []).map((s: any) => String(s.id)),
    }));
  } catch (err) {
    // A board whose configuration is unreadable can still yield issues, and a
    // partial team beats an aborted run - the gap is recorded on the snapshot
    // rather than thrown.
    errors.push(`board configuration: ${(err as Error).message}`);
  }

  let boardSprints: SprintSnapshot[] = [];
  try {
    const raw = await client.paginate(`/rest/agile/1.0/board/${team.boardId}/sprint`, 'values');
    boardSprints = raw.map(parseSprintValue).filter((s): s is SprintSnapshot => s !== null);
  } catch (err) {
    // GOTCHA: /sprint answers 400 (not 404) on a KANBAN board, because sprints
    // are a scrum-only concept. Expected for a kanban team, not a failure.
    errors.push(`sprints: ${(err as Error).message}`);
  }

  const backlogKeys = new Set<string>();
  try {
    const backlog = await client.paginate(`/rest/agile/1.0/board/${team.boardId}/backlog?fields=key`, 'issues');
    for (const i of backlog) backlogKeys.add(i.key);
  } catch (err) {
    errors.push(`backlog: ${(err as Error).message}`);
  }

  let issues: IssueSnapshot[] = [];
  let issueSprints: SprintSnapshot[] = [];
  try {
    // GOTCHA: /board/{id}/issue returns the board's whole scope - sprint issues
    // AND backlog - so it is not enough to know where an issue sits. The
    // separate /backlog call above supplies that, via inBacklog.
    const raw = await client.paginate(`/rest/agile/1.0/board/${team.boardId}/issue?fields=${fields}`, 'issues');
    issues = raw.map((r) => normaliseIssue(r, map, { keepIndividuals, backlogKeys }));
    issueSprints = raw.flatMap((r) => extractSprints(r, map));
  } catch (err) {
    if (err instanceof JiraNotFound) errors.push(`board ${team.boardId} not found - has it been deleted?`);
    else throw err;
  }

  const sprints = mergeSprints(boardSprints, issueSprints);

  // --- epics ---------------------------------------------------------------
  // One cheap paginated call, and the only place an epic's NAME exists: the
  // Epic Link field on an issue carries the key alone, so without this every
  // epic rollup can print is "WEB-42".
  let epics: EpicSnapshot[] | undefined;
  try {
    const raw = await client.paginate(`/rest/agile/1.0/board/${team.boardId}/epic`, 'values');
    epics = raw.map(normaliseEpic).filter((e): e is EpicSnapshot => e !== null);
  } catch (err) {
    // 400 here means the same thing /sprint's 400 means on a kanban board: the
    // concept does not apply. Recorded, never fatal.
    errors.push(`epics: ${(err as Error).message}`);
  }

  // --- detail pass ---------------------------------------------------------
  if (options.withDetail !== false && issues.length > 0) {
    const detail = new Map<string, IssueDetail>();

    // `withComments` mirrors whether the CALLING request asked for the comment
    // field. Reading `f.comment` off a payload that never carried it yields an
    // empty thread and a total of 0, which is indistinguishable in the snapshot
    // from a ticket nobody has written on - see the GOTCHA on applyIssueDetail.
    const absorb = (raw: any, withComments: boolean): void => {
      const f = raw?.fields ?? {};
      const d = excerpt(f.description, DESCRIPTION_CHARS);
      const entry: IssueDetail = {
        description: d?.text,
        descriptionTruncated: d?.truncated ? true : undefined,
      };
      if (withComments) {
        const { comments, total } = recentComments(f.comment, keepIndividuals);
        entry.comments = comments;
        entry.commentTotal = total;
      }
      detail.set(raw.key, entry);
    };

    // Active sprints first. GOTCHA: this uses the per-SPRINT issue endpoint
    // rather than a jql= filter on the board endpoint, because `jql` is not
    // accepted on /board/{id}/issue on this instance's Agile version and the
    // failure is a 400 that reads like a permissions problem. A board can carry
    // several concurrent active sprints (board 705 has six), so every one is
    // swept and the map dedupes an issue that sits in two.
    for (const sprint of sprints.filter((sp) => sp.state === 'active')) {
      try {
        const raw = await client.paginate(
          `/rest/agile/1.0/board/${team.boardId}/sprint/${sprint.id}/issue?fields=summary,description,comment`,
          'issues',
        );
        for (const r of raw) absorb(r, true);
      } catch (err) {
        errors.push(`detail for sprint ${sprint.id}: ${(err as Error).message}`);
      }
    }

    // ...then the TOP of the backlog, in board rank order, which is what would
    // actually get pulled next. Bounded by page rather than by a filter so the
    // cost is fixed no matter how large the backlog is - board 704 has 8,556
    // issues and an unbounded sweep here would dwarf the whole collection.
    const pages = options.backlogDetailPages ?? 2;
    for (let page = 0; page < pages; page++) {
      try {
        const resp = await client.get(
          `/rest/agile/1.0/board/${team.boardId}/backlog?fields=summary,description&startAt=${page * 50}&maxResults=50`,
        );
        const raw: any[] = resp?.issues ?? [];
        // No `comment` in the field list above, so the comment half of the
        // payload is NOT COLLECTED for these and must stay undefined.
        for (const r of raw) absorb(r, false);
        if (raw.length < 50) break;
      } catch (err) {
        errors.push(`detail for backlog page ${page}: ${(err as Error).message}`);
        break;
      }
    }

    issues = applyIssueDetail(issues, detail, new Map((epics ?? []).map((e) => [e.key, e])));
  } else if (epics && epics.length > 0) {
    issues = applyIssueDetail(issues, new Map(), new Map(epics.map((e) => [e.key, e])));
  }

  return {
    key: team.key,
    boardId: team.boardId,
    boardName,
    boardType,
    columns,
    sprints,
    issues,
    epics,
    errors,
  };
}
