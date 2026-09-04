// ---------------------------------------------------------------------------
// Profile configuration (committed, non-secret)
// ---------------------------------------------------------------------------

export interface TeamConfig {
  /** Stable slug used in snapshot output and on disk. Never derive this from the
   *  board name - board names get renamed and that would fork the time series. */
  key: string;
  /** Jira Agile board id. A team IS a board here (see docs/decisions.md). */
  boardId: number;
  description?: string;
  enabled: boolean;
  /** GitLab group full paths whose merge requests belong to this team.
   *  Used when `config.forge` is `gitlab` (the default). */
  gitlabGroups: string[];
  /** GitHub repositories (`owner/repo`) whose pull requests belong to this team.
   *  Used when `config.forge` is `github`. GitHub has no nested-group concept, so
   *  this is a flat list you fill in by hand - there is no `suggest-groups`
   *  equivalent for GitHub yet. */
  githubRepos?: string[];
  /** Confluence space keys holding this team's documentation.
   *
   *  Optional, and DERIVED rather than asked for: `discover-spaces` scores every
   *  visible space by how often this board's project keys appear in it, the same
   *  evidence-first recipe that mapped the GitLab groups (docs/handover.md). A
   *  team with none configured simply gets deep SEARCH links instead of resolved
   *  pages - the reader is never left without a route to the documentation. */
  confluenceSpaces?: string[];
}

/** Where the alerting layer sends what it decides to send, and how much.
 *
 *  Absent means the `alert` command still RUNS and prints - a dry run with no
 *  destination is the useful default, because the first question about an alert
 *  feed is always "what would it have said". Only an explicit `enabled: true`
 *  posts anything anywhere.
 *
 *  Nothing secret lives here: the Slack token is in secrets.local.json, and the
 *  channel name and page id are not credentials. */
export interface AlertsConfig {
  slack?: { enabled: boolean; channel: string };
  /** `pageId` is the numeric id of the Confluence page holding the running log
   *  table. Read it out of the page URL - /wiki/spaces/KEY/pages/<id>/Title. */
  confluence?: { enabled: boolean; pageId?: string };
  /** The floor. Mirrors InterventionSeverity in src/interventions.ts, and the
   *  two are pinned together by SEVERITY_RANK being indexed with this value. */
  minSeverity: 'act-now' | 'this-week' | 'watch';
  /** Most alerts to send in one run, spread ROUND ROBIN across teams (see
   *  rankInterventions). Whatever the cap drops is counted and named in the
   *  message: a silent truncation reads as "that was everything". */
  limit: number;
}

export interface Config {
  site: string;
  teams: TeamConfig[];
  /** Which code-review host the merge/pull-request half of a collection reads.
   *
   *  `gitlab` (the default, and what a missing or unrecognised value falls back
   *  to) reads GitLab merge requests via `teams[].gitlabGroups`. `github` reads
   *  GitHub pull requests via `teams[].githubRepos`. Everything downstream - the
   *  `review` metrics, the report, the alert feed - is forge-agnostic: both
   *  collectors emit the same `MergeRequestSnapshot` shape into the same
   *  `gitlab.json` snapshot slot, distinguished only by its `source` field. */
  forge: 'gitlab' | 'github';
  /** Days of merge/pull-request history to pull per collection run. Snapshots
   *  are cumulative, so this only needs to exceed the collection interval.
   *  (Named for GitLab historically; it applies to both forges.) */
  gitlabWindowDays: number;
  /** GitLab usernames that are automation, not people - CI bots, static
   *  analysis, automated reviewers.
   *
   *  This exists because GitLab's own `bot` flag is NOT set on these accounts on
   *  a self-managed instance: they are ordinary users created for a service, so
   *  nothing in the API distinguishes them. Without this list, every review
   *  metric measures the bot. See the GOTCHA in gitlab/collect.ts. */
  reviewBotAccounts: string[];
  /** Pull Confluence context (space home, recently-updated pages, pages that
   *  mention this board's project keys) alongside Jira and GitLab. Off unless a
   *  team has confluenceSpaces, because a site-wide CQL sweep is expensive and
   *  most profiles will not want it. */
  confluence: boolean;
  /** Retain per-person attribution (assignee/author/reviewer) in snapshots.
   *  Turning this off drops those fields at WRITE time, so the data never lands
   *  on disk - it is not a display toggle. */
  individualAttribution: boolean;
  /** Alert routing. See AlertsConfig - defaults to a no-destination config, so
   *  `alert` is print-only until a channel or a page is configured. */
  alerts: AlertsConfig;
}

export interface Secrets {
  atlassianBaseUrl: string;
  atlassianEmail: string;
  atlassianApiToken: string;
  gitlabBaseUrl?: string;
  gitlabToken?: string;
  /** GitHub personal-access or fine-grained token (needs `repo` read / `pull
   *  requests: read`). Validated lazily: only a `forge: github` collection uses
   *  it. */
  githubToken?: string;
  /** GitHub Enterprise Server host ONLY, e.g. `https://github.acme.example`.
   *  Leave unset for github.com - there is no github.com equivalent, the
   *  collector falls back to `https://api.github.com`. */
  githubBaseUrl?: string;
  /** Slack bot or user token, xoxb-/xoxp-. Validated lazily where used: every
   *  command except `alert --slack` runs without it. */
  slackToken?: string;
}

// ---------------------------------------------------------------------------
// Field map (discovered once per site, cached in the profile directory)
// ---------------------------------------------------------------------------

export interface FieldMap {
  discoveredAt: string;
  /** Sprint field, "customfield_10001" on acme. */
  sprint: string;
  /** EVERY field named like a story-point field, in priority order. There are
   *  two on acme (customfield_10006 "Story Points" and
   *  customfield_11000 "Story point estimate") and different projects populate
   *  different ones - reading only the first silently under-reports velocity. */
  storyPoints: string[];
  epicLink?: string;
  rank?: string;
  flagged?: string;
  team?: string;
}

// ---------------------------------------------------------------------------
// Snapshot shape (the durable artifact; bump schemaVersion on any change)
// ---------------------------------------------------------------------------

// 2: added ReviewSignals to MergeRequestSnapshot (first-human-review timing,
//    approval counts, bot classification). Snapshots at version 1 have no
//    `review` field and the review metrics report them as unknown, not as
//    unreviewed.
// 3: added ReviewSignals.humanCommenters. Version 2 recorded how MANY human
//    comments a merge request got but not WHO wrote them, so "who reviews other
//    people's work" - the counterpart to "who merges without review", and the
//    one that identifies who is already doing the right thing - could not be
//    answered at all. Approver identities alone are not a substitute: on this
//    instance almost every approval is the bot, so comments are where human
//    review actually shows up. Snapshots at version 2 leave the array empty,
//    which the insights layer reports as unknown rather than as "reviewed
//    nothing".
// 4: the CONTEXT schema. Everything added here exists to answer "I am looking at
//    a ticket key and a number, and I have no idea what any of it means":
//      - IssueSnapshot.summary - the report could not print a ticket's title.
//        `summary` was already being REQUESTED from Jira on every fetch and then
//        dropped on the floor by normaliseIssue, so this costs nothing extra.
//      - IssueSnapshot.description - a bounded plain-text excerpt, for the hover
//        card. Truncated at collection time, not at render time: the snapshot is
//        the durable artifact and a full description field would multiply its
//        size for text no panel can show.
//      - IssueSnapshot.comments - the last few comments on work that is OPEN in
//        the active sprint. This is where a blocker is actually written down;
//        the Flagged field is the formal signal and the comment thread is the
//        real one, and a manager who reads only the flag misses most of them.
//      - IssueSnapshot.blockedBy / blocks - already derivable from `links`, but
//        materialised so the blocker graph does not have to re-parse link-type
//        prose in three places.
//      - TeamSnapshot.epics - epic key -> name and done state, from the board's
//        own epic endpoint. Without it an epic rollup can only print keys.
//    Every one of these is OPTIONAL on the type. A schema-3 snapshot stays
//    readable and the panels that need them say "not collected yet" rather than
//    rendering an empty state that reads as "nothing here".
export const SCHEMA_VERSION = 4;

export interface Person {
  accountId: string;
  displayName: string;
  email?: string;
}

export interface SprintSnapshot {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future' | string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

/** One comment, trimmed to what a manager scanning for trouble needs.
 *
 *  Deliberately not the whole thread: comments are collected only for work that
 *  is OPEN in the active sprint, capped per issue, and the body is truncated at
 *  collection time. The purpose is "is there a blocker written in here that
 *  nobody flagged", not a mirror of Jira. */
export interface IssueComment {
  id: string;
  author?: Person;
  created: string;
  updated?: string;
  /** Plain text, flattened from ADF and truncated. Never HTML - it is rendered
   *  escaped, and a snapshot that carried markup would make that a lie. */
  body: string;
  /** True when the body was cut short. */
  truncated: boolean;
}

/** An epic as the board reports it. The board's own epic endpoint is the only
 *  place the NAME lives - the Epic Link custom field on an issue carries the
 *  key alone, so without this an epic rollup can print "WEB-42" and nothing
 *  else, which is exactly the "I don't know what this means" problem. */
export interface EpicSnapshot {
  id: number;
  key: string;
  name: string;
  summary?: string;
  done: boolean;
}

export interface IssueSnapshot {
  key: string;
  id: string;
  issueType: string;
  /** The ticket's title. Schema 4. Undefined on older snapshots, where the UI
   *  falls back to the key alone rather than printing an empty title. */
  summary?: string;
  /** Bounded plain-text excerpt of the description. Schema 4, optional. */
  description?: string;
  /** True when `description` was cut short at collection time. */
  descriptionTruncated?: boolean;
  /** Both are kept deliberately: status NAMES are heavily customised on this
   *  site ("Product Owner Review" sits in the To Do category), so any metric
   *  keyed on the name alone is wrong, and any metric keyed on the category
   *  alone is too coarse. */
  status: string;
  /** The status ID. Schema 4, optional.
   *
   *  Without it the board's own column configuration is unusable: columns carry
   *  `statusIds` and the issue carried only the status NAME, so nothing could
   *  join the two and a WIP-by-column view had to guess from status categories -
   *  which collapses `Waiting development`, `In Development`, `In Review`,
   *  `waiting test` and `Test` into one bucket called "In Progress". */
  statusId?: string;
  statusCategory: string;
  statusCategoryChangedAt?: string;
  priority?: string;
  resolution?: string;
  resolutionDate?: string;
  created: string;
  updated: string;
  dueDate?: string;
  assignee?: Person;
  reporter?: Person;
  creator?: Person;
  storyPoints: number | null;
  /** Which field the points came from. Needed to tell "nobody estimates" apart
   *  from "we read the wrong field". */
  storyPointsField: string | null;
  epicKey?: string;
  /** Epic name, resolved from the board's epic list at collection time so the
   *  report never has to print a bare key. Schema 4, optional. */
  epicName?: string;
  parentKey?: string;
  rank?: string;
  flagged: boolean;
  labels: string[];
  components: string[];
  /** Every sprint the issue has ever been in, sorted ascending by id, which is
   *  chronological because Jira allocates sprint ids monotonically. Jira itself
   *  returns them in insertion order - see the GOTCHA in jira/collect.ts.
   *  Carryover streaks are counted from this, not from the changelog. */
  sprintIds: number[];
  timeOriginalEstimateSeconds?: number;
  timeSpentSeconds?: number;
  links: Array<{ type: string; direction: 'inward' | 'outward'; key: string }>;
  /** Issue keys this one is BLOCKED BY, materialised from `links`. Schema 4.
   *
   *  Kept as its own field rather than re-derived at every call site because the
   *  test is on link-type PROSE ("is blocked by", "Blocks", "blocked by") which
   *  is configurable per site, and three copies of that matcher is three places
   *  for it to drift. */
  blockedBy?: string[];
  /** Issue keys this one BLOCKS. Schema 4. */
  blocks?: string[];
  /** Recent comments, collected only for open work in the active sprint.
   *  Undefined means NOT COLLECTED (schema 3, or --no-comment-detail); an empty
   *  array means collected and there were none. The two must not render alike. */
  comments?: IssueComment[];
  /** Total comments on the issue, even when only the last few were kept. */
  commentCount?: number;
  /** True when the issue is on the board's backlog rather than in a sprint. */
  inBacklog: boolean;
}

export interface TeamSnapshot {
  key: string;
  boardId: number;
  boardName?: string;
  boardType?: string;
  /** Board column -> status names, from the board configuration. This is what
   *  lets the derive layer decide what "in progress" means PER TEAM instead of
   *  guessing from status names. */
  columns: Array<{ name: string; statusIds: string[] }>;
  sprints: SprintSnapshot[];
  issues: IssueSnapshot[];
  /** Epics on this board, from /board/{id}/epic. Schema 4; undefined on older
   *  snapshots, which the epic panel reports as not-collected. */
  epics?: EpicSnapshot[];
  /** Non-fatal problems hit while collecting this team. A partial team is
   *  recorded WITH its errors rather than aborting the whole run. */
  errors: string[];
}

export interface JiraSnapshot {
  schemaVersion: number;
  source: 'jira';
  site: string;
  capturedAt: string;
  individualAttribution: boolean;
  fieldMap: FieldMap;
  teams: TeamSnapshot[];
}

export interface MergeRequestSnapshot {
  id: number;
  iid: number;
  projectId: number;
  projectPath?: string;
  title: string;
  state: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  sourceBranch: string;
  targetBranch: string;
  author?: Person;
  assignees: Person[];
  reviewers: Person[];
  /** Jira keys parsed out of the title and branch name. The Jira "Development"
   *  field (customfield_10900) was empty on every issue sampled, so branch/title
   *  parsing is the only correlation available. */
  issueKeys: string[];
  webUrl: string;
  /** Review signals. Populated only when `collectReviewDetail` ran; a snapshot
   *  collected before that existed has `review: undefined`, which the derive
   *  layer must treat as "unknown", never as "no review happened". */
  review?: ReviewSignals;
}

/** What actually happened to a merge request between opening and merging.
 *
 *  Everything here is split HUMAN vs AUTOMATED deliberately. On this instance
 *  the automated reviewer comments within ~11 minutes and approves nearly every
 *  merge request, so a metric that does not separate the two reports an
 *  excellent review latency for a merge request no person ever looked at.
 *  Confirmed live: of 24 consecutively merged MRs, 24 were approved and 21 of
 *  those approvals were the bot; 0 had a human reviewer assigned. */
export interface ReviewSignals {
  /** The merge request was OPENED by a configured bot account.
   *
   *  This is the difference between a defensible number and an indefensible
   *  one. On this instance 221 of the 248 merge requests that merged without any
   *  human review were opened by the automated account - dependency bumps and
   *  mechanical fixes that nobody intended a person to read. Counting them makes
   *  the unreviewed rate 54%; excluding them makes it 12%, and 12% is the figure
   *  that describes the team. Every rate in review.ts therefore uses
   *  human-authored merge requests as its denominator. */
  authorIsAutomation: boolean;
  /** First non-system comment by someone who is neither the author nor a
   *  configured bot. Undefined means no human ever commented. */
  firstHumanCommentAt?: string;
  /** First non-system comment by a configured bot account. */
  firstAutomatedCommentAt?: string;
  humanCommentCount: number;
  automatedCommentCount: number;
  /** DISTINCT people, other than the author and the bots, who commented.
   *
   *  Distinct, not one entry per comment: a reviewer who leaves eight remarks
   *  on one merge request reviewed one merge request, and counting them eight
   *  times would make a thorough reviewer look like eight reviewers. Empty when
   *  individualAttribution is off, and empty on schema-2 snapshots - both are
   *  "unknown", never "reviewed nothing". */
  humanCommenters: Person[];
  /** Comments by the merge request's own author, counted separately so a
   *  self-answered thread never reads as review. */
  authorCommentCount: number;
  firstHumanApprovalAt?: string;
  firstAutomatedApprovalAt?: string;
  /** Approval COUNTS, always populated.
   *
   *  Separate from the Person arrays on purpose. With individualAttribution off
   *  the arrays are empty by design, and a metric that asked
   *  `humanApprovals.length > 0` would then report that nobody ever approved
   *  anything - turning a privacy setting into a silent data corruption. "Was
   *  this approved by a person" is a team-level fact and survives attribution
   *  being switched off; "which person" does not. */
  humanApprovalCount: number;
  automatedApprovalCount: number;
  /** Approver identities. Empty when individualAttribution is off. */
  humanApprovals: Person[];
  automatedApprovals: Person[];
  /** Reviewers assigned on the merge request itself, from the list payload. */
  reviewerCount: number;
  /** Set when the notes or approvals call failed for this MR alone. The MR is
   *  still recorded; the review fields are simply unknown rather than zero. */
  error?: string;
}

/** The merge/pull-request half of a collection. Named `GitLabSnapshot` and
 *  written to `gitlab.json` for history, but forge-agnostic: `source` says which
 *  host produced it, and a `github` collection fills `teams[].groups` with
 *  `owner/repo` names instead of GitLab group paths. Every downstream reader
 *  (`review.ts`, the report, the alert feed) works from `mergeRequests` alone
 *  and does not care which forge it came from. */
export interface GitLabSnapshot {
  schemaVersion: number;
  source: 'gitlab' | 'github';
  capturedAt: string;
  windowDays: number;
  individualAttribution: boolean;
  teams: Array<{ key: string; groups: string[]; mergeRequests: MergeRequestSnapshot[]; errors: string[] }>;
}

// ---------------------------------------------------------------------------
// Confluence context (schema 4, optional third snapshot file)
// ---------------------------------------------------------------------------

/** A Confluence page, reduced to what a link and a one-line orientation need.
 *
 *  No body is stored. The report is a self-contained file that opens on a
 *  locked-down laptop and it must not become a stale mirror of the wiki: what a
 *  reader needs is the TITLE, WHEN it was last touched and a URL that opens the
 *  live page. An excerpt is kept only where Confluence itself supplies one. */
export interface ConfluencePage {
  id: string;
  title: string;
  /** Absolute URL, already joined to the site base. */
  url: string;
  spaceKey: string;
  spaceName?: string;
  lastUpdated?: string;
  lastUpdatedBy?: string;
  /** Confluence's own search excerpt, plain text, when the page was found via
   *  CQL search rather than listed. */
  excerpt?: string;
  /** Why this page is in the snapshot: the space home, a recently-updated page,
   *  or a page that mentions one of the board's project keys. */
  reason: 'space-home' | 'recent' | 'mentions-project';
  /** The project key whose mention pulled this page in. */
  matched?: string;
}

export interface ConfluenceSpace {
  key: string;
  name: string;
  url: string;
  type?: string;
  /** Pages in the space that mention this team's project keys. The evidence
   *  behind the mapping, kept so it can be shown rather than asserted. */
  mentionHits?: number;
}

export interface ConfluenceSnapshot {
  schemaVersion: number;
  source: 'confluence';
  capturedAt: string;
  site: string;
  teams: Array<{
    key: string;
    spaces: ConfluenceSpace[];
    pages: ConfluencePage[];
    errors: string[];
  }>;
}
//
// NOT a snapshot, and deliberately not stored like one. A changelog entry
// carries its own real Jira timestamp and is immutable the moment Jira records
// it, so writing it into a dated snapshot directory would store the same 2019
// status transition once per collected day - 300 copies by next summer, on top
// of a jira.json that is already 31.7 MB. It lives once, at
// data/<profile>/changelog/<boardId>.json, and is appended to.
//
// This is the answer to the honest limit stated all over history.ts: "nothing
// here can see before the first snapshot". A changelog can. It is retroactively
// complete, so cycle time, sprint membership and the flow diagram stop being
// bounded by when collection started.
// ---------------------------------------------------------------------------

/** One field change inside one changelog entry.
 *
 *  GOTCHA (the wire names are not the field names): Jira sends these as
 *  `from`/`fromString`/`to`/`toString`. `toString` is NOT usable as a property
 *  name on a stored object - it shadows Object.prototype.toString, so
 *  `String(item)` and every implicit coercion of the object start throwing
 *  "not a function", and template literals over the item become a runtime
 *  error that no type check catches. The wire names are read in
 *  `normaliseChangelogItem` and never stored; these are the stored names.
 *
 *  `fromId`/`toId` are the ids and are what every metric must key on.
 *  `fromName`/`toName` are display strings, kept only so a reader of the JSON
 *  can tell what happened, and used in logic ONLY through
 *  `resolveStatusId` (Phase 2), which counts every time it has to. */
export interface ChangelogItem {
  /** The field's id where Jira supplies one (`status`, `resolution`,
   *  `assignee`, or a `customfield_NNNNN`), else its display name. This is what
   *  the field filter matches on. */
  field: string;
  /** Jira's own `field` value - the display name. Kept for readability of the
   *  stored file; never matched on. */
  fieldName: string;
  /** Status id, sprint id list (comma-separated), accountId, or a raw value for
   *  fields that have no id (Story Points). Null where the field was empty. */
  fromId: string | null;
  toId: string | null;
  fromName: string | null;
  toName: string | null;
}

/** One changelog entry - a single edit, carrying every field it changed. */
export interface ChangelogEntry {
  /** Jira's own history id. THE dedupe key: it is stable, unique per issue
   *  history record, and monotonic, which is what makes the store append-only
   *  without any diffing. */
  id: string;
  issueKey: string;
  /** When the change happened, per Jira. ISO 8601 with offset, as Jira sends it. */
  created: string;
  /** Who made the change. Both fields are absent - not empty, ABSENT - when the
   *  profile has individualAttribution off - the same write-time rule the rest
   *  of the collector follows, so the data never reaches disk. */
  authorAccountId?: string;
  authorName?: string;
  items: ChangelogItem[];
}

/** Everything known about one board's changelog history. */
export interface ChangelogStore {
  /** Bumped only if the STORE's own shape changes, independently of
   *  SCHEMA_VERSION - the store is not a snapshot and its readers are not the
   *  snapshot readers. */
  storeVersion: number;
  boardId: number;
  /** Team key, for a human reading the file. Not used in logic - the board id
   *  is the identity, because a team key can be renamed in config and the
   *  board id cannot. */
  teamKey: string;
  /** When this store was last appended to. */
  updatedAt: string;
  /** issue key -> the `updated` timestamp that issue carried when its changelog
   *  was last fetched. This is what bounds a daily run to the delta: an issue
   *  whose `updated` has not moved cannot have a new changelog entry.
   *
   *  GOTCHA: `updated` moves on changes that produce NO changelog entry at all
   *  - a comment being added is the common one. So this over-fetches slightly
   *  and never under-fetches, which is the only safe direction: the dedupe on
   *  `id` absorbs a re-fetch, whereas a missed entry is invisible forever. */
  seen: Record<string, string>;
  /** Sorted by (created, id). Append-only: an entry here is never altered or
   *  removed. */
  entries: ChangelogEntry[];
}

/** The store's own shape version. */
export const CHANGELOG_STORE_VERSION = 1;
