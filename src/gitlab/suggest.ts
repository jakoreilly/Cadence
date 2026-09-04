import { botAccountSet, gitlabGet, isAutomation, parseIssueKeys } from './collect.js';
import type { DiscoveredGroup } from './discover.js';
import type { JiraSnapshot, Secrets, TeamSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Which GitLab group belongs to which Jira board?
//
// THE MANAGER DOES NOT KNOW, AND FINDING OUT IS A PURPOSE OF THIS TOOL RATHER
// THAN A PREREQUISITE FOR IT. That is the design premise of this file: nothing
// in it asks the reader to supply a mapping and nothing writes one. It produces
// the EVIDENCE and a person decides, which is what makes the four mappings in
// profiles/acme/config.json defensible when somebody asks "how do you know
// that group belongs to that team".
//
// The recipe was run by hand as a throwaway script in the third session and got
// all four boards right in one pass; the same idea shipped for Confluence as
// `discover-spaces` in the sixth. This is that recipe, promoted to a command.
//
// TWO AXES, and the existing mappings are only trustworthy because both agreed:
//
//   1. ISSUE KEYS - merge requests carrying a key that matches a real issue on
//      that board. Strong evidence, but it depends on branch-naming discipline
//      the tool does not control and cannot assume.
//   2. PEOPLE - the share of the group's recent human MR authors who are
//      assignees on that board. Weaker per person, but it does not care what
//      anybody names a branch, and it is available where axis 1 is empty.
//
// Both are reported for every board, always, because a single combined score
// would hide the one case that matters most: a group that scores a little
// against several boards at once. That is the signature of shared
// infrastructure (`Acme`, `shared-platform`, `smt`,
// `gateway-common` on this instance) rather than of a team's home, and configuring
// one would attribute four teams' work to whichever board happened to edge it.
// ---------------------------------------------------------------------------

/** A merge request reduced to what the mapping needs: what it says it is about,
 *  and who opened it. */
export interface SuggestMergeRequest {
  title: string;
  sourceBranch: string;
  authorName?: string;
  authorUsername?: string;
}

export interface GroupActivity {
  id: number;
  fullPath: string;
  name: string;
  webUrl: string;
  isMember: boolean;
  parentId: number | null;
  mergeRequests: SuggestMergeRequest[];
  /** True when the window held more merge requests than were fetched, so every
   *  count for this group is a lower bound. Reported rather than hidden, for the
   *  reason recorded on countRecentMergeRequests in discover.ts. */
  truncated: boolean;
  error?: string;
}

/** What a board looks like from the mapping's point of view. */
export interface BoardFacts {
  team: string;
  boardId: number;
  boardName?: string;
  /** Project prefixes counted from the ISSUES on the board, never from the
   *  board's own location.projectKey - board 703 is located in project OPS and
   *  every issue on it is LOG-keyed (GOTCHA 18). */
  projectKeys: string[];
  /** Every issue key on the board, for the "does this merge request reference
   *  real work on this board" test. */
  issueKeys: ReadonlySet<string>;
  /** Assignee display names, normalised for comparison. */
  assignees: ReadonlySet<string>;
  /** Whether `assignees` is scoped to recent activity or to the board's whole
   *  history. The output has to say which: board 704 carries 8,556 issues going
   *  back years and its all-time assignee list includes people who have left. */
  assigneeBasis: 'recent' | 'all';
  assigneeCount: number;
  /** Groups already configured for this team, so the output can say "this is
   *  the one you already have" rather than presenting it as a discovery. */
  configuredGroups: readonly string[];
}

// --- name matching ----------------------------------------------------------

/** Comparable form of a person's display name.
 *
 *  Combining marks are stripped so an accented surname matches its unaccented
 *  spelling. Jira and GitLab are two separate identity stores on this estate
 *  with no shared account id, so the display name is the only join available -
 *  which is also why per-person attribution being ON is load-bearing here and
 *  not merely a reporting nicety (docs/decisions.md). */
// Memoised because `namesMatch` is the inner loop of this whole command and it
// normalises FOUR times per call (twice directly, twice more inside `tokens`).
// It is invoked once per (human author x board assignee) pair, per board, per
// group - and boardFacts warns that a long-lived board's assignee list is "most
// of the department". Over a few hundred groups that is millions of NFKD
// normalisations of a few dozen distinct strings. Keyed on the RAW name so each
// cache stays a pure function of its input; unbounded is safe because the key
// space is the display names in one snapshot and the process is short-lived.
const normalCache = new Map<string, string>();
const tokenCache = new Map<string, string[]>();

export function normaliseName(name: string): string {
  const hit = normalCache.get(name);
  if (hit !== undefined) return hit;
  const out = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  normalCache.set(name, out);
  return out;
}

/** GOTCHA: the returned array is CACHED and shared, so every caller must treat
 *  it as read-only. `namesMatch` copies before sorting for exactly this reason. */
function tokens(name: string): string[] {
  const hit = tokenCache.get(name);
  if (hit !== undefined) return hit;
  const out = normaliseName(name).split(' ').filter(Boolean);
  tokenCache.set(name, out);
  return out;
}

/** Is this the same person in two identity stores?
 *
 *  Three tiers, increasingly loose, because exact string equality is not
 *  enough: these display names are typed by different people into different
 *  systems and differ in token ORDER and in whether a middle name is present
 *  ("Marcus David Lowe" against "Marcus Lowe").
 *
 *  The subset tier requires at least two shared tokens deliberately. One shared
 *  token matches every person who shares a first name, and this axis is
 *  reported as a HEADCOUNT SHARE - a single false match on a six-author group
 *  moves the share by 17 points, which is enough to hand a shared
 *  infrastructure group a verdict it has not earned. */
export function namesMatch(a: string, b: string): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if ([...ta].sort().join(' ') === [...tb].sort().join(' ')) return true;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const shared = [...sa].filter((t) => sb.has(t)).length;
  if (shared < 2) return false;
  return shared === sa.size || shared === sb.size;
}

// --- board facts ------------------------------------------------------------

const RECENT_ASSIGNEE_DAYS = 90;
const MIN_RECENT_ASSIGNEES = 5;

/** Reduces a collected board to the facts the scorer needs.
 *
 *  GOTCHA: the assignee set is scoped to issues touched in the last 90 days
 *  wherever that leaves enough people to divide by. Scoring against a board's
 *  ALL-TIME assignees sounds more generous and is worse: board 704 carries
 *  8,556 issues going back years, so its all-time assignee list is most of the
 *  department and a group of five strangers can score 60% against it. Where the
 *  recent list is too thin to be a denominator this falls back to all-time and
 *  SAYS so through `assigneeBasis`, because a share computed on a different
 *  basis from the one the reader assumes is the exact failure this tool exists
 *  to avoid (GOTCHA 23). */
export function boardFacts(
  team: TeamSnapshot,
  configuredGroups: readonly string[] = [],
  opts: { now?: Date; recentDays?: number } = {},
): BoardFacts {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.recentDays ?? RECENT_ASSIGNEE_DAYS) * 86_400_000).toISOString();

  const issueKeys = new Set<string>();
  const prefixCounts = new Map<string, number>();
  const recent = new Set<string>();
  const all = new Set<string>();

  for (const i of team.issues) {
    issueKeys.add(i.key);
    const dash = i.key.lastIndexOf('-');
    if (dash > 0) {
      const pk = i.key.slice(0, dash);
      prefixCounts.set(pk, (prefixCounts.get(pk) ?? 0) + 1);
    }
    const name = i.assignee?.displayName;
    if (!name) continue;
    all.add(name);
    if (i.updated >= cutoff) recent.add(name);
  }

  const useRecent = recent.size >= MIN_RECENT_ASSIGNEES;
  const chosen = useRecent ? recent : all;

  return {
    team: team.key,
    boardId: team.boardId,
    boardName: team.boardName,
    projectKeys: [...prefixCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k),
    issueKeys,
    assignees: new Set([...chosen].map(normaliseName)),
    assigneeBasis: useRecent ? 'recent' : 'all',
    assigneeCount: chosen.size,
    configuredGroups,
  };
}

/** Every project prefix present anywhere in the snapshot.
 *
 *  This is the filter that makes the key parse trustworthy: `V2-3` is a
 *  syntactically valid Jira key, and the unfiltered parse on this instance also
 *  turns up `UTF`, `CVE` and `ISO` out of branch names (GOTCHA 7). Anything
 *  that is not a real project on this site is noise. */
export function knownProjectKeys(jira: JiraSnapshot): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const team of jira.teams) {
    for (const i of team.issues) {
      const dash = i.key.lastIndexOf('-');
      if (dash > 0) keys.add(i.key.slice(0, dash));
    }
  }
  return keys;
}

// --- scoring ----------------------------------------------------------------

export interface AxisScore {
  team: string;
  boardId: number;
  /** Merge requests carrying a key that IS an issue on this board. The strong
   *  signal. */
  keyHits: number;
  /** Merge requests carrying a key with one of this board's project prefixes
   *  that is NOT an issue on the board. Kept apart from `keyHits` because the
   *  two mean different things: this is work on a project the board does not
   *  carry, or an issue outside the collected scope. */
  prefixOnlyHits: number;
  /** Human MR authors in the window who are also assignees on this board. */
  matchedAuthors: string[];
  humanAuthors: number;
  authorShare: number;
  assigneeBasis: 'recent' | 'all';
}

export type Verdict = 'propose' | 'possible' | 'shared' | 'none';

export interface GroupSuggestion {
  group: Omit<GroupActivity, 'mergeRequests'>;
  mergeRequestCount: number;
  humanAuthors: string[];
  automationAuthors: string[];
  scores: AxisScore[];
  best: AxisScore | null;
  runnerUp: AxisScore | null;
  verdict: Verdict;
  /** Project prefixes seen in this group's merge-request keys, with the board
   *  each belongs to where there is one. This is the GOTCHA-15 diagnostic and
   *  the reason a zero key-hit count is not read as a branch-naming problem. */
  prefixes: Array<{ key: string; count: number; team: string | null }>;
  /** Reader-facing evidence and warnings, in the order they should be read. */
  notes: string[];
  /** The team this group is already configured for, if any. */
  configuredFor: string | null;
  /** An ANCESTOR group proposed for the same team, whose merge-request listing
   *  already includes this one's. Set by `scoreGroups`, which is the only place
   *  that can see the whole tree. A covered group is kept in the output as
   *  evidence and kept OUT of the proposal list. */
  coveredBy: string | null;
}

/** Thresholds for `propose`. Hand-picked, and openly so - but calibrated
 *  against the live estate rather than guessed, and the calibration is the
 *  interesting part.
 *
 *  A proposal needs ONE axis to be strong and the other merely present, because
 *  the four mappings confirmed by hand split evenly on WHICH axis carries them:
 *
 *    payments-core -> fs                    36 key hits, 8 of 11 authors
 *    onboarding-hub -> fcp                        21 key hits, 5 of 7 authors
 *    web-storefront -> panther  11 key hits, 2 of 2 authors  <- keys carry it
 *    logistics-hub -> tran                2 key hits, 6 of 8 authors  <- people carry it
 *
 *  GOTCHA: a first cut required only ONE key hit and two matched authors, and
 *  that admitted `gateway-common` (3 merge requests, 1 WEB key, 2 of 2 authors) and
 *  `web-storefront/rex-adapter` (1 CSP key, 2 of 2 authors) as proposals
 *  for panther and fs. Both are wrong, and `gateway-common` is named in
 *  docs/handover.md as a shared group that must NOT be proposed. On a
 *  two-author group 100% is one person agreeing with themselves - a SHARE is
 *  meaningless at that size, so one axis has to clear an ABSOLUTE bar. */
const PROPOSE = {
  /** Key hits enough to carry a proposal on their own. */
  strongKeys: 5,
  /** Matched authors enough to carry a proposal on their own. */
  strongAuthors: 3,
  /** What the other axis must at least show. */
  minKeys: 1,
  minAuthors: 1,
  minShare: 0.25,
  dominance: 2,
};

function betterAxis(a: AxisScore, b: AxisScore): number {
  return (
    b.keyHits - a.keyHits ||
    b.matchedAuthors.length - a.matchedAuthors.length ||
    b.authorShare - a.authorShare ||
    a.team.localeCompare(b.team)
  );
}

/** Scores one group against every board at once.
 *
 *  Against EVERY board rather than one at a time, and that is the load-bearing
 *  design choice here: shared infrastructure is only visible from the
 *  cross-board view. `shared-platform` looks like a plausible
 *  home for any single team you test it against on its own, and obviously not a
 *  team at all the moment you can see it matching one or two people on four
 *  boards at once. */
export function scoreGroup(
  activity: GroupActivity,
  boards: readonly BoardFacts[],
  opts: { botAccounts?: readonly string[]; known?: ReadonlySet<string> } = {},
): GroupSuggestion {
  const bots = botAccountSet(opts.botAccounts ?? []);
  const human: string[] = [];
  const automation: string[] = [];
  const seen = new Set<string>();

  for (const mr of activity.mergeRequests) {
    const name = mr.authorName ?? mr.authorUsername;
    if (!name) continue;
    const id = normaliseName(name);
    if (seen.has(id)) continue;
    seen.add(id);
    // GOTCHA 14 and 20, applied to the MAPPING rather than to the review rates:
    // the automation account authors more merge requests than anybody on this
    // instance (250 of 329 in one group), and it is an assignee on no board.
    // Leaving it in the denominator drags every author share down by however
    // much CI happens to run in that group, which says nothing about whose
    // team it is. Matched on display name as well as username, because the
    // account here is username `bot` with display name "I'm a Bot".
    if (isAutomation(mr.authorUsername, bots, mr.authorName)) automation.push(name);
    else human.push(name);
  }

  // Keys parsed ONCE per merge request, not once per merge request per board.
  // `parseIssueKeys` runs two `matchAll` sweeps over the title and the branch
  // name, and it was being called from inside the per-board scoring loop below
  // as well as here - so four configured boards meant five parses of the same
  // two strings. On the busiest group (329 merge requests) across a few hundred
  // groups that is a six-figure count of redundant regex passes, and the answer
  // cannot differ between boards: the parse depends only on the MR and `known`.
  const keysByMr = activity.mergeRequests.map((mr) => parseIssueKeys(mr.title, mr.sourceBranch, opts.known));

  // Prefix tally over the whole group, restricted to project keys that exist
  // somewhere on this site. This is what answers "if not this board, then whose
  // work is this group doing".
  const prefixCounts = new Map<string, number>();
  for (const keys of keysByMr) {
    for (const key of keys) {
      const dash = key.lastIndexOf('-');
      if (dash <= 0) continue;
      const pk = key.slice(0, dash);
      prefixCounts.set(pk, (prefixCounts.get(pk) ?? 0) + 1);
    }
  }
  const teamOfPrefix = new Map<string, string>();
  for (const b of boards) {
    // First board wins a shared prefix and boards are visited in configured
    // order. Used only for a diagnostic sentence, never for a score.
    for (const pk of b.projectKeys) if (!teamOfPrefix.has(pk)) teamOfPrefix.set(pk, b.team);
  }
  const prefixes = [...prefixCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count, team: teamOfPrefix.get(key) ?? null }));

  const scores: AxisScore[] = boards.map((board) => {
    const prefixSet = new Set(board.projectKeys);
    const boardAssignees = [...board.assignees];
    let keyHits = 0;
    let prefixOnlyHits = 0;
    for (const keys of keysByMr) {
      if (keys.length === 0) continue;
      // Per merge request, not per key: an MR titled "LOG-1 LOG-2 LOG-3" is
      // one piece of evidence that this group works on that board, not three.
      if (keys.some((k) => board.issueKeys.has(k))) keyHits++;
      else if (keys.some((k) => prefixSet.has(k.slice(0, k.lastIndexOf('-'))))) prefixOnlyHits++;
    }
    const matched = human.filter((name) => boardAssignees.some((a) => namesMatch(name, a)));
    return {
      team: board.team,
      boardId: board.boardId,
      keyHits,
      prefixOnlyHits,
      matchedAuthors: matched,
      humanAuthors: human.length,
      authorShare: human.length > 0 ? matched.length / human.length : 0,
      assigneeBasis: board.assigneeBasis,
    };
  });

  const ranked = [...scores].sort(betterAxis);
  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const configuredFor = boards.find((b) => b.configuredGroups.includes(activity.fullPath))?.team ?? null;

  const notes: string[] = [];
  let verdict: Verdict = 'none';

  if (activity.error) {
    notes.push(`Merge requests could not be read for this group: ${activity.error}`);
  } else if (!best || activity.mergeRequests.length === 0) {
    notes.push('No merge requests in the window, so there is nothing to score. Not a team, or not active.');
  } else {
    const withAny = scores.filter((s) => s.keyHits > 0 || s.matchedAuthors.length > 0);
    const keyTop = [...scores].sort((a, b) => b.keyHits - a.keyHits || a.team.localeCompare(b.team))[0]!;
    const authorTop = [...scores].sort(
      (a, b) =>
        b.matchedAuthors.length - a.matchedAuthors.length ||
        b.authorShare - a.authorShare ||
        a.team.localeCompare(b.team),
    )[0]!;
    const bothAxes = keyTop.keyHits > 0 && authorTop.matchedAuthors.length > 0;
    const agree = bothAxes && keyTop.team === authorTop.team;
    const dominant = runnerUp === null || runnerUp.keyHits === 0 || best.keyHits >= runnerUp.keyHits * PROPOSE.dominance;

    // Shared infrastructure is tested FIRST, because it is a rejection and the
    // scores that produce it would otherwise read as a weak proposal. Its
    // signature is breadth without depth: a couple of people who work across
    // teams matching on three or more boards, and no board's key evidence
    // standing out.
    const sharedShape = withAny.length >= 3 && best.keyHits < 3 && best.matchedAuthors.length <= 2;

    if (sharedShape) {
      verdict = 'shared';
      notes.push(
        `Matches ${withAny.length} boards (${withAny.map((s) => s.team).join(', ')}) and none of them strongly. ` +
          'That is the shape of a shared or infrastructure group rather than a team home - the matches are a ' +
          'handful of people who work across teams. Do NOT configure it against a team: its merge requests would ' +
          "be attributed to whichever board edged it, and every one of that team's review rates would move.",
      );
    } else if (
      agree &&
      dominant &&
      best.authorShare >= PROPOSE.minShare &&
      ((best.keyHits >= PROPOSE.strongKeys && best.matchedAuthors.length >= PROPOSE.minAuthors) ||
        (best.matchedAuthors.length >= PROPOSE.strongAuthors && best.keyHits >= PROPOSE.minKeys))
    ) {
      verdict = 'propose';
      const carried = best.keyHits >= PROPOSE.strongKeys ? 'the issue keys' : 'the people';
      notes.push(
        `Both axes agree on ${best.team} and ${carried} carry it: ${best.keyHits} merge request(s) carry a key ` +
          `matching a real issue on board ${best.boardId}, and ${best.matchedAuthors.length} of ` +
          `${best.humanAuthors} human authors (${Math.round(best.authorShare * 100)}%) are assignees on it.`,
      );
    } else if (bothAxes || best.keyHits > 0 || best.matchedAuthors.length > 0) {
      verdict = 'possible';
      if (bothAxes && !agree) {
        notes.push(
          `The two axes DISAGREE: the issue keys point at ${keyTop.team} (${keyTop.keyHits} hits) and the people ` +
            `point at ${authorTop.team} (${authorTop.matchedAuthors.length} of ${authorTop.humanAuthors} authors). ` +
            'Every mapping that has been confirmed by hand had both axes agreeing. Do not configure on one axis.',
        );
      } else if (agree) {
        // Both axes point the same way and neither is strong enough to carry
        // it. Saying which bar was missed is the difference between a reader
        // widening the window and a reader configuring it anyway.
        notes.push(
          `Both axes point at ${best.team} but the evidence is too thin to propose: ${best.keyHits} key hit(s) ` +
            `(${PROPOSE.strongKeys} would carry it alone) and ${best.matchedAuthors.length} of ` +
            `${best.humanAuthors} authors matched (${PROPOSE.strongAuthors} would carry it alone). ` +
            'On a group this small a percentage share is one or two people agreeing with themselves.',
        );
      } else if (!dominant && runnerUp) {
        notes.push(
          `${best.team} leads on issue keys but not clearly (${best.keyHits} against ${runnerUp.keyHits} for ` +
            `${runnerUp.team}). Look at the projects listed below, or widen the window, before deciding.`,
        );
      } else {
        notes.push(
          'Only one axis has anything to say, so this is a lead rather than a mapping: ' +
            `${best.keyHits} key hit(s), ${best.matchedAuthors.length} of ${best.humanAuthors} authors matched.`,
        );
      }
    } else {
      notes.push('No key hits and no author matches against any configured board. Not a team on this estate.');
    }

    // The GOTCHA-15 diagnostic, and the ORDER of the two readings IS the
    // lesson: this originally recorded "0 of 332 merge requests in logistics-hub
    // carry a Jira key" and read it as a branch-naming problem. It was not -
    // logistics-hub was being tested against WEB keys because it was then wrongly
    // mapped to board 701. Tested against LOG keys it yields 15 hits. So a
    // zero key count is evidence of the WRONG BOARD at least as much as
    // evidence about branch naming, and it has to be checked in that order.
    if (best.keyHits === 0 && verdict !== 'none') {
      const elsewhere = prefixes.filter((p) => p.team !== null);
      const unconfigured = prefixes.filter((p) => p.team === null);
      if (elsewhere.length > 0) {
        notes.push(
          `Zero merge requests match ${best.team}'s issues, but this group's merge requests DO carry ` +
            `${elsewhere.map((p) => `${p.key} (${p.count}, board ${p.team})`).join(', ')}. ` +
            'Check the board before blaming branch naming - a zero here has meant the wrong board before.',
        );
      } else if (unconfigured.length > 0) {
        // The most interesting thing this command can find, and the reason it
        // exists: a group doing real, key-tagged work on a project that has no
        // board configured at all. That is a candidate TEAM, not a bad mapping.
        notes.push(
          `Zero merge requests match any configured board, but this group's merge requests carry ` +
            `${unconfigured.map((p) => `${p.key} (${p.count})`).join(', ')} - real project keys with no board ` +
            'configured against them. Check the mapping first, and consider whether that project is a team ' +
            'nobody has added yet (discover-boards will say whether it has closed sprints to report on).',
        );
      } else {
        notes.push(
          'Zero merge requests carry any key belonging to a project on this site. Check the mapping first; ' +
            'only then conclude that this group does not put issue keys in its branches or titles.',
        );
      }
    }

    if (activity.truncated) {
      notes.push(
        'The window held more merge requests than were fetched, so every count for this group is a LOWER ' +
          'bound. Re-run with a shorter --window if the ranking looks close.',
      );
    }
    if (best.assigneeBasis === 'all') {
      notes.push(
        'This board has too few recently-active assignees to divide by, so the people axis is measured against ' +
          'its ALL-TIME assignee list. On a long-lived board that list is most of the department - treat the ' +
          'share as an upper bound.',
      );
    }
    if (configuredFor) {
      notes.push(
        configuredFor === best.team
          ? `Already configured for ${configuredFor}, and the evidence still agrees.`
          : `WARNING: already configured for ${configuredFor}, but the evidence now points at ${best.team}. ` +
              'One of the two is wrong, and every metric for both teams depends on which.',
      );
    }
  }

  return {
    // The merge requests themselves are deliberately NOT carried out of here.
    // On the busiest group that is 329 titles and branch names per group per
    // board, and `--json` would become a second copy of the GitLab snapshot for
    // no gain: everything a reader needs to check the verdict is in `scores`,
    // `prefixes` and `notes`.
    group: {
      id: activity.id,
      fullPath: activity.fullPath,
      name: activity.name,
      webUrl: activity.webUrl,
      isMember: activity.isMember,
      parentId: activity.parentId,
      truncated: activity.truncated,
      ...(activity.error ? { error: activity.error } : {}),
    },
    mergeRequestCount: activity.mergeRequests.length,
    humanAuthors: human,
    automationAuthors: automation,
    scores,
    best,
    runnerUp,
    verdict,
    prefixes,
    notes,
    configuredFor,
    coveredBy: null,
  };
}

/** Is `child` a subgroup of `parent`, by path? */
function isDescendantOf(child: string, parent: string): boolean {
  return child.startsWith(`${parent}/`);
}

/** Every group scored, most convincing first, with subgroups of a proposed
 *  parent collapsed into it. Pure.
 *
 *  GOTCHA, and without it this command's answer is unusable: a parent group's
 *  merge-request endpoint ALREADY RETURNS its subgroups' merge requests, so a
 *  subgroup of a real team's group scores the same evidence twice and gets
 *  proposed on its own. Measured on this estate: `onboarding-hub` scored 21 key hits and 5
 *  of 7 authors, and `onboarding-hub/v2` scored 21 key hits and 5 of 7 authors - the
 *  identical numbers, because they are the identical merge requests. Left
 *  uncollapsed the command proposed NINETEEN mappings where four were wanted,
 *  which buries the answer it exists to produce and invites configuring both a
 *  parent and a child, wasting a full pagination sweep on every collection.
 *
 *  The subgroup stays in the output with its evidence - somebody may genuinely
 *  want to scope a team to one subgroup - it just stops being a PROPOSAL. */
export function scoreGroups(
  activity: readonly GroupActivity[],
  boards: readonly BoardFacts[],
  opts: { botAccounts?: readonly string[]; known?: ReadonlySet<string> } = {},
): GroupSuggestion[] {
  const order: Record<Verdict, number> = { propose: 0, possible: 1, shared: 2, none: 3 };
  const scored = activity.map((a) => scoreGroup(a, boards, opts));

  const proposals = scored.filter((s) => s.verdict === 'propose');
  for (const s of proposals) {
    // The NEAREST proposed ancestor for the same team, so a three-deep tree
    // reports "covered by payments-core/gpg" rather than jumping to `payments-core`.
    const ancestors = proposals
      .filter((p) => p !== s && p.best?.team === s.best?.team && isDescendantOf(s.group.fullPath, p.group.fullPath))
      .sort((a, b) => b.group.fullPath.length - a.group.fullPath.length);
    const nearest = ancestors[0];
    if (nearest) {
      s.coveredBy = nearest.group.fullPath;
      s.notes.push(
        `Covered by ${nearest.group.fullPath}, which is a parent group: GitLab returns a subgroup's merge ` +
          'requests from its parent, so these are the same merge requests counted again. Configure the parent ' +
          'unless you specifically want this team scoped to this subgroup alone.',
      );
    }
  }

  return scored.sort(
      (a, b) =>
        order[a.verdict] - order[b.verdict] ||
        // A covered subgroup sorts after the parent that covers it, so the
        // reader meets the four answers before the twelve restatements of them.
        (a.coveredBy ? 1 : 0) - (b.coveredBy ? 1 : 0) ||
        (b.best?.keyHits ?? 0) - (a.best?.keyHits ?? 0) ||
        (b.best?.matchedAuthors.length ?? 0) - (a.best?.matchedAuthors.length ?? 0) ||
        a.group.fullPath.localeCompare(b.group.fullPath),
    );
}

// --- collection -------------------------------------------------------------

const PER_PAGE = 100;

/** Recent merge requests for one group, bounded.
 *
 *  Bounded by PAGES and not by the date filter alone, because the busiest group
 *  on this instance carries 329 merge requests in 30 days and the mapping is
 *  decided by the first hundred as surely as by all of them. `truncated`
 *  travels with the result so a count can never be quoted as complete when it
 *  is not.
 *
 *  `scope=all` is not optional: without it a group merge-request listing returns
 *  only the TOKEN OWNER's merge requests (GOTCHA 9), which for a manager who
 *  opens none is an empty list from a busy group - the same failure shape as the
 *  membership filter in GOTCHA 16, and just as quiet. */
export async function collectGroupMergeRequests(
  secrets: Secrets,
  fullPath: string,
  opts: { windowDays?: number; maxPages?: number; now?: Date } = {},
): Promise<{ mergeRequests: SuggestMergeRequest[]; truncated: boolean }> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.windowDays ?? 30) * 86_400_000).toISOString();
  const maxPages = opts.maxPages ?? 2;
  const out: SuggestMergeRequest[] = [];
  let page = 1;
  let truncated = false;

  for (;;) {
    const { body, nextPage } = await gitlabGet(
      secrets,
      `/groups/${encodeURIComponent(fullPath)}/merge_requests` +
        `?scope=all&state=all&updated_after=${encodeURIComponent(since)}&per_page=${PER_PAGE}&page=${page}`,
    );
    for (const raw of Array.isArray(body) ? body : []) {
      out.push({
        title: raw.title ?? '',
        sourceBranch: raw.source_branch ?? '',
        authorName: raw.author?.name,
        authorUsername: raw.author?.username,
      });
    }
    if (!nextPage) break;
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    page = Number(nextPage) || page + 1;
  }

  return { mergeRequests: out, truncated };
}

/** Fetches merge requests for every group. One request per page per group, so
 *  this is the slow half of the command and deliberately the only network in
 *  this file - everything above it is pure and tested offline. */
export async function collectActivity(
  secrets: Secrets,
  groups: readonly DiscoveredGroup[],
  opts: { windowDays?: number; maxPages?: number; onProgress?: (fullPath: string, i: number) => void } = {},
): Promise<GroupActivity[]> {
  const out: GroupActivity[] = [];
  let i = 0;
  for (const g of groups) {
    opts.onProgress?.(g.fullPath, ++i);
    const base = {
      id: g.id,
      fullPath: g.fullPath,
      name: g.name,
      webUrl: g.webUrl,
      isMember: g.isMember,
      parentId: g.parentId,
    };
    try {
      const { mergeRequests, truncated } = await collectGroupMergeRequests(secrets, g.fullPath, opts);
      out.push({ ...base, mergeRequests, truncated });
    } catch (err) {
      // One inaccessible group must not sink the sweep: a Guest membership on a
      // group with merge requests disabled returns 403 here and 200 on /groups.
      out.push({ ...base, mergeRequests: [], truncated: false, error: (err as Error).message });
    }
  }
  return out;
}

// --- rendering --------------------------------------------------------------

const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}~` : s.padEnd(n));

function axisLine(s: AxisScore, boards: readonly BoardFacts[]): string {
  const board = boards.find((b) => b.team === s.team);
  const keys = s.keyHits > 0 ? String(s.keyHits) : s.prefixOnlyHits > 0 ? `0 (+${s.prefixOnlyHits} unmatched)` : '0';
  const share = s.humanAuthors > 0 ? `${Math.round(s.authorShare * 100)}%` : '-';
  return (
    `    ${pad(`${s.team} (board ${s.boardId}${board ? `, ${board.projectKeys.slice(0, 2).join('/')}` : ''})`, 34)}` +
    ` keys ${pad(keys, 20)} authors ${s.matchedAuthors.length}/${s.humanAuthors} (${share})` +
    (s.matchedAuthors.length > 0 ? `  ${s.matchedAuthors.slice(0, 4).join(', ')}` : '')
  );
}

const HEADING: Record<Verdict, string> = {
  propose: 'PROPOSED - both axes agree',
  possible: 'POSSIBLE - one axis only, or the axes disagree',
  shared: 'SHARED / INFRASTRUCTURE - do not configure against a team',
  none: 'NO SIGNAL',
};

/** The whole command output. Evidence first, proposal second, and no config
 *  file written for the reader: the mappings in this profile are defensible
 *  because a person read the evidence and agreed with it. */
export function formatSuggestions(
  suggestions: readonly GroupSuggestion[],
  boards: readonly BoardFacts[],
  opts: { windowDays: number; showAll?: boolean } = { windowDays: 30 },
): string {
  const out: string[] = [];
  out.push(
    `Scoring ${suggestions.length} GitLab group(s) against ${boards.length} configured board(s), ` +
      `${opts.windowDays}-day merge-request window.`,
  );
  out.push('');
  for (const b of boards) {
    out.push(
      `  ${pad(b.team, 10)} board ${pad(String(b.boardId), 6)} ${pad(b.boardName ?? '', 24)} ` +
        `keys ${pad(b.projectKeys.slice(0, 3).join('/'), 16)} ${b.assigneeCount} ${b.assigneeBasis} assignee(s)` +
        (b.configuredGroups.length > 0 ? `  configured: ${b.configuredGroups.join(', ')}` : '  configured: none'),
    );
  }

  let lastHeading: string | null = null;
  for (const s of suggestions) {
    if (s.verdict === 'none' && !opts.showAll) continue;
    const heading =
      s.verdict === 'propose' && s.coveredBy
        ? 'SUBGROUPS of a proposed group - the same merge requests again, configure the parent'
        : HEADING[s.verdict];
    if (heading !== lastHeading) {
      out.push('');
      out.push(`--- ${heading} ---`);
      lastHeading = heading;
    }
    out.push('');
    out.push(
      `  ${s.group.fullPath}${s.group.isMember ? '' : ' *'}  ` +
        `${s.mergeRequestCount}${s.group.truncated ? '+' : ''} MR(s), ` +
        `${s.humanAuthors.length} human author(s)` +
        (s.automationAuthors.length > 0 ? `, ${s.automationAuthors.length} automation (excluded)` : ''),
    );
    for (const score of [...s.scores].sort(betterAxis)) out.push(axisLine(score, boards));
    if (s.prefixes.length > 0) {
      out.push(
        `    issue keys seen: ${s.prefixes
          .slice(0, 6)
          .map((p) => `${p.key} x${p.count}${p.team ? ` [${p.team}]` : ' [no configured board]'}`)
          .join(', ')}`,
      );
    }
    for (const n of s.notes) out.push(`    ${n}`);
  }

  // Covered subgroups are excluded: they are the same evidence a second time,
  // and a proposal list of nineteen where four are meant hides the answer.
  const proposals = suggestions.filter((s) => s.verdict === 'propose' && !s.coveredBy);
  const covered = suggestions.filter((s) => s.verdict === 'propose' && s.coveredBy);
  out.push('');
  out.push('---');
  if (covered.length > 0) {
    out.push(
      `${covered.length} subgroup(s) scored the same evidence as a parent group and are not listed as ` +
        'proposals - a parent\'s merge-request listing already includes them.',
    );
    out.push('');
  }
  if (proposals.length === 0) {
    out.push('Nothing scored strongly enough on BOTH axes to propose. That is a real answer rather than a');
    out.push('failure: every mapping in this profile that was later confirmed had both axes agreeing.');
  } else {
    out.push("To configure, put the group path into that team's teams[].gitlabGroups and record WHY in its");
    out.push('description - the evidence is what makes the mapping defensible when somebody asks:');
    for (const p of proposals) {
      const already = p.configuredFor === p.best?.team ? '  (already configured)' : '';
      out.push(`  ${p.best?.team} <- ${p.group.fullPath}${already}`);
    }
  }
  out.push('');
  out.push('  * = you are not a member of this group. NOT a reason to skip it: a manager is often not a member');
  out.push("      of their own team's group, and filtering on membership hid the correct group once.");
  out.push('  Nothing here has been written to the profile. A person reads the evidence and decides.');
  return out.join('\n');
}
