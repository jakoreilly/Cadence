import { practiceByPerson } from './insights.js';
import type { RosterSummary } from './taxonomy.js';
import type { MergeRequestSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// The estate-wide view of people, rolled up ACROSS boards.
//
// Why this layer exists at all. `roster()` in taxonomy.ts answers "who is on
// this board", and it is computed once per board, so somebody who works on two
// of them appears as two rows that are never added together and never sit
// beside each other. That makes the one genuinely cross-team question
// unanswerable from the report: WHO IS STRETCHED ACROSS SEVERAL TEAMS. It is
// also the question a manager actually asks - a person carrying six items on
// one board is normal, and the same person carrying three items on each of
// three boards, with three standups and three sets of priorities, is the
// person about to drop something.
//
// WHAT THIS IS NOT, and the constraint the whole module is written under.
// This is a CONTACT SHEET rolled up, not a scorecard rolled up. Aggregating
// across boards does not relax the per-person rules recorded in the README and
// docs/decisions.md; if anything it tightens them, because an estate-wide table
// is exactly the artefact somebody would try to sort by output. So:
//
//   1. NO POINTS ARE EVER SUMMED ACROSS BOARDS. Not once, not as a total, not
//      in a tooltip. Estimation culture differs wildly per board here - one
//      leaves 97% of its active sprint unestimated - so a point on one board is
//      not a point on another and adding them produces a number that looks
//      like load and is not. Points stay inside their team's own row.
//   2. NO RATE PER PERSON. Nothing here divides one person's number by
//      another's, or by a total.
//   3. GIVE AND RECEIVE ALWAYS TRAVEL TOGETHER. "Merged with nobody looking"
//      beside "reviews given on other people's work" reads as a picture of who
//      has picked up the team's review habit. Either one alone reads as a list
//      of offenders, and the estate-wide version of that list would be the most
//      misusable thing this tool has ever produced.
//   4. COUNTS OF WORK HELD, NEVER WORK DONE. Every Jira figure here is
//      "assigned right now", which is a fact about today, not an attribution of
//      past output - the assignee is who holds it NOW (see
//      compositionBySprint).
// ---------------------------------------------------------------------------

/** One person's presence on one board. */
export interface PersonBoard {
  team: string;
  openAssigned: number;
  openInActiveSprint: number;
  /** Points on THIS board only. Deliberately never summed with another board's
   *  - see rule 1 in this file's header. */
  openPoints: number;
  flaggedAssigned: number;
  resolvedRecently: number;
  reportedRecently: number;
}

export interface EstatePerson {
  name: string;
  /** Every board they appear on, busiest first. */
  boards: PersonBoard[];
  /** Boards they hold OPEN work on. The cross-team load signal - a person on
   *  three boards' active sprints is in three standups. */
  activeBoardCount: number;
  openAssigned: number;
  openInActiveSprint: number;
  flaggedAssigned: number;
  resolvedRecently: number;
  reportedRecently: number;

  // The GitLab side is computed from a DEDUPED merge-request set rather than
  // summed across boards, so two boards mapped to one group cannot double it.
  mergeRequestsAuthored: number;
  mergedKnown: number;
  /** Merged with no human comment and no human approval. Never shown without
   *  reviewsGiven beside it - see rule 3. */
  mergedUnreviewed: number;
  /** Distinct merge requests by OTHER people they commented on or approved. */
  reviewsGiven: number;
  /** Distinct GitLab projects they opened a merge request in. */
  projects: string[];

  /** In Jira on some board, never in GitLab in this window. Usually product,
   *  QA or support - a finding about what they do, not about absence. */
  jiraOnly: boolean;
  gitlabOnly: boolean;
}

export interface PeopleEstate {
  people: EstatePerson[];
  /** People holding open work on more than one board. */
  crossTeamCount: number;
  /** People holding open work in an ACTIVE sprint on more than one board - the
   *  sharper version of the same signal, because backlog items on a second
   *  board cost nobody a standup. */
  crossTeamActiveCount: number;
  boardsCovered: number;
  recentDays: number;
  gitlabWindowDays?: number;
  /** True when reviewer identities were missing on ANY board, so every
   *  reviewsGiven here is a LOWER BOUND rather than a count. Unknown, not zero
   *  - the distinction PracticeSummary exists to preserve. */
  reviewerIdentitiesUnknown: boolean;
  /** Open, unassigned issues in an active sprint, across every board. Nobody's
   *  name on them, so they are on nobody's row - which is exactly why the
   *  figure has to be stated beside the table. */
  unassignedOpenInActiveSprint: number;
  /** Merge requests the GitLab figures were computed over, after deduping. */
  mergeRequestsConsidered: number;
}

/** Display-name matching, identical to roster()'s.
 *
 *  GOTCHA: Jira and GitLab share no id on a typical Jira/GitLab pair - Jira has accountIds,
 *  GitLab has usernames, and nothing joins them - so identity is the trimmed,
 *  case-folded DISPLAY NAME and nothing else. This has to be the same rule
 *  roster() uses or a person would merge into one row on their board and split
 *  into two here, and the two panels would disagree about how many people exist.
 *  Somebody who spells their name differently in the two systems therefore
 *  appears twice, once jiraOnly and once gitlabOnly. That is reported honestly
 *  as two rows rather than guessed at with fuzzy matching, which would silently
 *  merge two real people who share a surname. */
const norm = (s: string): string => s.trim().toLowerCase();

export interface EstatePeopleInput {
  teams: Array<{ key: string; roster?: RosterSummary }>;
  /** Every merge request in the window, from every mapped group. Deduped here
   *  by merge-request id, so a caller that hands over overlapping groups gets a
   *  correct answer rather than a doubled one. */
  mergeRequests: MergeRequestSnapshot[];
  recentDays: number;
  gitlabWindowDays?: number;
  reviewerIdentitiesUnknown?: boolean;
  /** Cap on rows returned. The full set is what the counts above are computed
   *  from, so a cap truncates the table and never the findings. */
  limit?: number;
}

export function estatePeople(input: EstatePeopleInput): PeopleEstate {
  const rows = new Map<string, EstatePerson>();
  const jiraNames = new Set<string>();
  const gitlabNames = new Set<string>();

  const row = (name: string): EstatePerson => {
    const k = norm(name);
    const found = rows.get(k);
    if (found) return found;
    const fresh: EstatePerson = {
      name,
      boards: [],
      activeBoardCount: 0,
      openAssigned: 0,
      openInActiveSprint: 0,
      flaggedAssigned: 0,
      resolvedRecently: 0,
      reportedRecently: 0,
      mergeRequestsAuthored: 0,
      mergedKnown: 0,
      mergedUnreviewed: 0,
      reviewsGiven: 0,
      projects: [],
      jiraOnly: false,
      gitlabOnly: false,
    };
    rows.set(k, fresh);
    return fresh;
  };

  // --- the Jira side: summed over the per-board rosters ---------------------
  //
  // GOTCHA: this sums per-board counts, so two configured boards that are
  // MIRRORS of each other - the same issues surfaced twice - would double every
  // figure here. That is why the profile config rejects mirror boards on
  // evidence (board 703 shares 249 of 249 sprints with 702; board 706 shares 27
  // of 28 with 705) rather than configuring both. If a mirror is ever
  // configured deliberately, this table is the first thing that becomes wrong,
  // and it will be wrong quietly.
  let unassigned = 0;
  let boardsCovered = 0;
  for (const t of input.teams) {
    if (!t.roster) continue;
    boardsCovered++;
    unassigned += t.roster.unassignedOpenInActiveSprint;
    for (const m of t.roster.members) {
      const p = row(m.name);
      jiraNames.add(norm(m.name));
      p.boards.push({
        team: t.key,
        openAssigned: m.openAssigned,
        openInActiveSprint: m.openInActiveSprint,
        openPoints: m.openPoints,
        flaggedAssigned: m.flaggedAssigned,
        resolvedRecently: m.resolvedRecently,
        reportedRecently: m.reportedRecently,
      });
      p.openAssigned += m.openAssigned;
      p.openInActiveSprint += m.openInActiveSprint;
      p.flaggedAssigned += m.flaggedAssigned;
      p.resolvedRecently += m.resolvedRecently;
      p.reportedRecently += m.reportedRecently;
    }
  }

  // --- the GitLab side: over a deduped merge-request set --------------------
  const seen = new Set<number>();
  const mrs: MergeRequestSnapshot[] = [];
  for (const m of input.mergeRequests) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    mrs.push(m);
  }

  // practiceByPerson is the canonical give-and-receive computation and it
  // already excludes bot-authored merge requests. Calling it here rather than
  // re-implementing the same counting means the estate table and every team's
  // review panel cannot disagree about one person's figures.
  const practice = practiceByPerson(mrs);
  for (const person of practice.people) {
    const p = row(person.name);
    gitlabNames.add(norm(person.name));
    p.mergeRequestsAuthored += person.authored;
    p.mergedKnown += person.mergedKnown;
    p.mergedUnreviewed += person.mergedUnreviewed;
    p.reviewsGiven += person.reviewsGiven;
  }

  // Projects come off the merge requests directly: practiceByPerson does not
  // carry them, and "what does this person actually work on" is the cheapest
  // useful thing on the row.
  const projects = new Map<string, Set<string>>();
  for (const m of mrs) {
    const author = m.author?.displayName;
    if (!author || !m.projectPath) continue;
    if (m.review?.authorIsAutomation === true) continue;
    const k = norm(author);
    const set = projects.get(k) ?? new Set<string>();
    set.add(m.projectPath);
    projects.set(k, set);
  }

  for (const [k, p] of rows) {
    p.projects = [...(projects.get(k) ?? [])].sort();
    p.jiraOnly = jiraNames.has(k) && !gitlabNames.has(k);
    p.gitlabOnly = !jiraNames.has(k) && gitlabNames.has(k);
    p.activeBoardCount = p.boards.filter((b) => b.openInActiveSprint > 0).length;
    p.boards.sort(
      (a, b) => b.openInActiveSprint - a.openInActiveSprint || b.openAssigned - a.openAssigned || a.team.localeCompare(b.team),
    );
  }

  const all = [...rows.values()];
  // Ordered by CROSS-TEAM SPREAD first, then by load. The whole reason this
  // table exists is the person on three boards, so they have to be the first
  // row - sorting by open items would bury them under whoever holds the most
  // tickets on one board, which is the question the per-team roster already
  // answers.
  const people = all.sort(
    (a, b) =>
      b.activeBoardCount - a.activeBoardCount ||
      b.boards.length - a.boards.length ||
      b.openInActiveSprint - a.openInActiveSprint ||
      b.openAssigned - a.openAssigned ||
      b.mergeRequestsAuthored - a.mergeRequestsAuthored ||
      a.name.localeCompare(b.name),
  );

  return {
    people: input.limit ? people.slice(0, input.limit) : people,
    crossTeamCount: all.filter((p) => p.boards.filter((b) => b.openAssigned > 0).length > 1).length,
    crossTeamActiveCount: all.filter((p) => p.activeBoardCount > 1).length,
    boardsCovered,
    recentDays: input.recentDays,
    gitlabWindowDays: input.gitlabWindowDays,
    reviewerIdentitiesUnknown: input.reviewerIdentitiesUnknown ?? practice.reviewerIdentitiesUnknown,
    unassignedOpenInActiveSprint: unassigned,
    mergeRequestsConsidered: mrs.length,
  };
}
