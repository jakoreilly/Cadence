import { SCHEMA_VERSION, type ConfluenceSnapshot, type GitLabSnapshot, type JiraSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Is the snapshot on disk actually able to answer what the code now asks of it?
//
// This module exists because of the single most expensive gap in the project's
// history: the sixth session built the whole context layer - ticket summaries,
// descriptions, comment threads, epic names, blocker links - and the seventh
// discovered it had NEVER ONCE been rendered against real data. The snapshot on
// disk was still at schema 2, the report printed "not collected" 109 times, and
// nothing anywhere said so. A report rendered against stale data does not look
// broken. It looks finished.
//
// THE POINT WORTH KEEPING, and the reason there are two checks below rather
// than one: the declared `schemaVersion` is NOT proof that the fields are
// there. `collect --no-issue-detail` writes a snapshot stamped at the current
// version carrying none of that version's content, and a version-only check
// reports it as healthy. So this asks both questions:
//
//   1. is the file's declared version behind the code (SCHEMA_HISTORY), and
//   2. at the current version, is the OPTIONAL content actually populated
//      where it is expected to be (coverage gaps).
//
// Both produce the same two things the reader needs and the version number
// alone cannot give: WHICH fields are missing, and WHAT TO RUN.
// ---------------------------------------------------------------------------

/** What each schema bump added, in words a reader recognises from the report.
 *
 *  GOTCHA: this table is the machine-readable twin of the prose block above
 *  `SCHEMA_VERSION` in types.ts, and the two can drift - somebody bumping the
 *  constant has no reason to look in this file. `test/schema.test.ts` asserts
 *  that the table's highest version IS `SCHEMA_VERSION` and that no version in
 *  between is skipped, so a bump without a description fails the build instead
 *  of silently shipping a warning banner that says "missing: " and nothing
 *  else. Do not "tidy" that test away. */
export const SCHEMA_HISTORY: ReadonlyArray<{
  version: number;
  /** Which snapshot file the addition landed in. */
  file: SnapshotFile;
  /** Named the way the report names them, not the way the type does. */
  adds: readonly string[];
}> = [
  {
    version: 2,
    file: 'gitlab',
    adds: [
      'code-review signals on merge requests (first human review, approvals, bot classification)',
    ],
  },
  {
    version: 3,
    file: 'gitlab',
    adds: ['who reviewed other people\'s work (human commenter identities)'],
  },
  {
    version: 4,
    file: 'jira',
    adds: [
      'ticket titles',
      'ticket descriptions (the hover cards)',
      'comment threads (the discussion panel and the unflagged-blocker scan)',
      'status ids (WIP by the board\'s own columns)',
      'blocker links (what is holding up what)',
      'epic names (without them the epic panel prints bare keys)',
    ],
  },
];

export type SnapshotFile = 'jira' | 'gitlab' | 'context';

export interface SchemaFileStatus {
  file: SnapshotFile;
  /** False when the file is absent from the snapshot directory entirely. */
  present: boolean;
  /** The version the file declares. Null when the file is absent. */
  found: number | null;
  expected: number;
  behind: boolean;
  /** Reader-facing names of what the code expects and this file cannot carry. */
  missing: string[];
}

/** A field that the snapshot's own version says it should carry, and does not.
 *
 *  Distinct from `SchemaFileStatus` on purpose: a file at the current version
 *  with an empty detail pass is a DIFFERENT problem with a different fix (drop
 *  a `--no-...` flag) from a file written by older code (re-collect), and
 *  collapsing the two loses the fix. */
export interface CoverageGap {
  /** What is missing, in the report's own vocabulary. */
  what: string;
  /** Where it was expected. A gap with no scope is unreadable: "0 of 20,701"
   *  and "0 of 725" are the same sentence and completely different findings. */
  scope: string;
  present: number;
  total: number;
  /** The flag that skips this, so the reader can tell "not collected" from
   *  "deliberately not collected". */
  cause: string;
}

export interface SchemaAssessment {
  expected: number;
  files: SchemaFileStatus[];
  gaps: CoverageGap[];
  /** The one thing most callers check. */
  stale: boolean;
  /** One line naming the problem, or null when there is nothing to say. */
  headline: string | null;
  /** The command that fixes it, or null. */
  remedy: string | null;
}

function statusFor(file: SnapshotFile, found: number | null, present: boolean): SchemaFileStatus {
  const behind = present && found !== null && found < SCHEMA_VERSION;
  const missing = behind
    ? SCHEMA_HISTORY.filter((h) => h.version > (found ?? 0) && h.file === file).flatMap((h) => [...h.adds])
    : [];
  return { file, present, found, expected: SCHEMA_VERSION, behind, missing };
}

/** Issues sitting in an active sprint - the scope the detail pass covers.
 *
 *  Mirrors `activeLoad` in report/model.ts rather than reading
 *  `sprints.find(state === 'active')`: board 705 runs six concurrent active
 *  sprints, and taking the first one would scope this check to a sixth of the
 *  work it is meant to check. */
function activeSprintCoverage(jira: JiraSnapshot): { inActive: number; withComments: number } {
  let inActive = 0;
  let withComments = 0;
  for (const team of jira.teams) {
    const activeIds = new Set(team.sprints.filter((s) => s.state === 'active').map((s) => s.id));
    for (const issue of team.issues) {
      if (!issue.sprintIds.some((id) => activeIds.has(id))) continue;
      inActive++;
      if (issue.comments !== undefined) withComments++;
    }
  }
  return { inActive, withComments };
}

/** Coverage gaps: content the snapshot's OWN declared version promises and the
 *  file does not actually carry.
 *
 *  Every check is scoped to where the collector puts the field, never to the
 *  whole board. Comment threads and descriptions are gathered for active-sprint
 *  work and the top of the backlog only (jira/collect.ts, and it is a bound
 *  worth keeping - comment threads for 20,700 issues would multiply the
 *  snapshot for no gain). Testing them against every issue would fire every
 *  single day, and a warning that always fires is a warning nobody reads. */
function coverageGaps(
  jira: JiraSnapshot | null,
  gitlab: GitLabSnapshot | null,
  context: ConfluenceSnapshot | null,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  if (jira && jira.schemaVersion >= 4) {
    // Counted in place rather than via flatMap/filter. On this estate that is
    // 20,700 issues across four boards, and the discarded intermediate arrays
    // were allocated three times over in this one function - on every `report`
    // AND on every feed `alert` builds, of which there are two.
    let issueCount = 0;
    let summaries = 0;
    for (const team of jira.teams) {
      for (const issue of team.issues) {
        issueCount++;
        if (issue.summary !== undefined) summaries++;
      }
    }
    if (issueCount > 0 && summaries < issueCount) {
      gaps.push({
        what: 'ticket titles',
        scope: 'every collected issue',
        present: summaries,
        total: issueCount,
        cause: 'an interrupted Jira sweep - titles cost nothing extra and no flag turns them off',
      });
    }

    // The detail pass is all-or-nothing per run, so "how many active-sprint
    // issues came back with a comments array" separates "the pass never ran"
    // from "it ran and these tickets have no comments". `comments: []` is
    // collected-and-empty; undefined is not-collected, and the two must not
    // read alike (GOTCHA 24).
    // Both figures come from ONE walk of the active-sprint scope. The two used
    // to be computed by separate passes that each rebuilt the same set of active
    // sprint ids and each allocated a full array of the matching issues.
    const { inActive, withComments: withDetail } = activeSprintCoverage(jira);
    if (inActive > 0 && withDetail === 0) {
      gaps.push({
        what: 'ticket descriptions and comment threads',
        scope: 'issues in an active sprint',
        present: 0,
        total: inActive,
        cause: 'collected with --no-issue-detail',
      });
    }

    const withEpics = jira.teams.filter((t) => t.epics !== undefined).length;
    if (withEpics < jira.teams.length) {
      gaps.push({
        what: 'epic names',
        scope: 'boards',
        present: withEpics,
        total: jira.teams.length,
        cause: 'collected with --no-issue-detail, or the board has no epic endpoint',
      });
    }
  }

  if (gitlab && gitlab.schemaVersion >= 3) {
    const mrs = gitlab.teams.flatMap((t) => t.mergeRequests);
    const withReview = mrs.filter((m) => m.review !== undefined).length;
    if (mrs.length > 0 && withReview === 0) {
      gaps.push({
        what: 'code-review signals (who reviewed what, and how fast)',
        scope: 'collected merge requests',
        present: 0,
        total: mrs.length,
        cause: 'collected with --no-review-detail',
      });
    }
  }

  if (context) {
    const empty = context.teams.filter((t) => t.pages.length === 0).length;
    if (empty === context.teams.length && context.teams.length > 0) {
      gaps.push({
        what: 'Confluence pages',
        scope: 'teams in the context snapshot',
        present: 0,
        total: context.teams.length,
        cause: 'no team names a space - run discover-spaces',
      });
    }
  }

  return gaps;
}

/** Everything the report needs to say about the freshness of what it is about
 *  to render. Pure: takes the snapshots already in hand, touches no disk. */
export function assessSchema(input: {
  jira: JiraSnapshot | null;
  gitlab: GitLabSnapshot | null;
  context: ConfluenceSnapshot | null;
}): SchemaAssessment {
  const files: SchemaFileStatus[] = [
    statusFor('jira', input.jira?.schemaVersion ?? null, Boolean(input.jira)),
    statusFor('gitlab', input.gitlab?.schemaVersion ?? null, Boolean(input.gitlab)),
    statusFor('context', input.context?.schemaVersion ?? null, Boolean(input.context)),
  ];
  const gaps = coverageGaps(input.jira, input.gitlab, input.context);
  const behind = files.filter((f) => f.behind);
  const stale = behind.length > 0 || gaps.length > 0;

  let headline: string | null = null;
  let remedy: string | null = null;
  if (behind.length > 0) {
    const which = behind.map((f) => `${f.file}.json at schema ${f.found}`).join(', ');
    headline =
      `The snapshot on disk is BEHIND this build of the tool: ${which}, against schema ${SCHEMA_VERSION}. ` +
      `Panels built on what was added since will say "not collected" and the report will still look complete.`;
    remedy = 'collect --force';
  } else if (gaps.length > 0) {
    headline =
      `The snapshot is at schema ${SCHEMA_VERSION} but was collected WITHOUT some of its content, ` +
      `so panels built on it are empty for a reason no reader can see.`;
    remedy = 'collect --force';
  }

  return { expected: SCHEMA_VERSION, files, gaps, stale, headline, remedy };
}

const num = (n: number): string => n.toLocaleString('en-GB');

/** The CLI rendering: plain lines, worst first, ending in a command to run.
 *
 *  Returns [] when there is nothing wrong, so the caller has no condition of
 *  its own to get wrong. */
export function formatSchemaWarning(a: SchemaAssessment, profileDir?: string): string[] {
  if (!a.stale) return [];
  const out: string[] = ['', `WARNING: ${a.headline}`];

  for (const f of a.files.filter((x) => x.behind)) {
    out.push(`  ${f.file}.json is at schema ${f.found}, this build expects ${f.expected}. Missing:`);
    for (const m of f.missing) out.push(`    - ${m}`);
    if (f.missing.length === 0) {
      out.push('    - (nothing this file carries changed; the stamp is simply old)');
    }
  }

  for (const g of a.gaps) {
    out.push(
      `  ${g.what}: ${num(g.present)} of ${num(g.total)} ${g.scope} - ${g.cause}.`,
    );
  }

  out.push('');
  out.push(`  Fix: node dist/src/cli.js ${a.remedy} --profile ${profileDir ?? '<dir>'}`);
  out.push('  A report rendered against stale data does not look broken - it looks finished.');
  out.push('');
  return out;
}
