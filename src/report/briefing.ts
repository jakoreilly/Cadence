import { jsonForScript } from './assets.js';
import { dwellIsReportable, MIN_DWELL_BASIS } from '../history.js';
import { escapeAttr, escapeHtml, expander } from './format.js';
import type { ReportInput, ReportTeamInput } from './model.js';

// ---------------------------------------------------------------------------
// The hand-off layer: everything needed to turn this report into prose, and
// nothing that a language model would have to guess at.
//
// The problem this solves. The report answers "what is happening" in numbers.
// It cannot answer "what does this MEAN for the PayGateway migration" or "write me
// the three paragraphs I need for Thursday's steering committee", because those
// answers need business context that is not in Jira. A person can supply that
// context; so can a model, given the numbers and the guardrails.
//
// Three design decisions, and they are the whole point:
//
//   1. THE DIGEST IS SMALL ON PURPOSE. The report already embeds the complete
//      derived model as #to-data, and on this estate that is roughly 3 MB - tens
//      of thousands of tokens before a single word is written, most of it ticket
//      keys nobody will mention. #to-brief carries only what a narrative actually
//      cites - measured at roughly 3% of the full model on this estate, about
//      14 KB per team - and every prompt below points at it FIRST and names
//      #to-data as the place to drill only when asked about one team. Cheap by
//      construction rather than by asking the model to be brief.
//
//      The banner reports both sizes as MEASURED at generation time rather than
//      as a claim in prose, because "a few kilobytes" was written here when the
//      digest held four fields and was quietly wrong by an order of magnitude
//      three commits later. A number the build computes cannot rot that way.
//
//   2. THE PROMPTS TRAVEL WITH THE GUARDRAILS. Every prompt embeds the same
//      trustworthiness rules the machine-readable payload carries, because the
//      failure mode here is not a model that says too little - it is a model
//      that quotes `committedPoints` for a closed sprint, which is provably
//      wrong (it counts an issue in all sixteen sprints it passed through), and
//      says it with total confidence in a document that goes to the board.
//
//   3. EVERY PANEL CARRIES ITS OWN QUESTION. A `data-ask` attribute on each
//      section is a prompt scoped to that panel alone. It is the difference
//      between "explain this report" and "explain why this team's approval to
//      merge gap is 182 hours", and the second one is answerable in a few
//      hundred tokens.
// ---------------------------------------------------------------------------

/** The rules any narrative written from this report has to keep. Deliberately
 *  duplicated from MACHINE_README rather than imported and reworded: this copy
 *  is what gets pasted into a chat window on its own, and a guardrail that only
 *  exists in a JSON block the reader did not paste is not a guardrail. */
export const NARRATIVE_RULES = [
  'Every number you use must be quoted from the digest or the embedded model. Do not compute new figures and present them as measurements.',
  'Never quote committedPoints, committedIssues or carriedOut for a CLOSED sprint. They count every issue in that sprint today, so an item that passed through sixteen sprints counts as committed in all sixteen. They are accurate for the ACTIVE sprint only.',
  'Never compare story points between teams. Estimation culture differs per board; a point on one board is not a point on another.',
  'Never build a per-person productivity ranking. The assignee field records who holds a ticket today, not who did the work.',
  'A null means not measurable. It never means zero.',
  'Lead time is created-to-resolved and includes backlog dwell. Do not call it cycle time.',
  'Review rates are over merge requests a PERSON opened. Bot-authored merge requests are excluded and counted separately; including them roughly quadruples the apparent unreviewed rate and describes the robots, not the team.',
  'Where a figure has a caveat in the digest, carry the caveat into the sentence. Do not strip it to make the sentence cleaner.',
];

export interface BriefingPrompt {
  id: string;
  label: string;
  /** One line, shown under the button. */
  blurb: string;
  text: string;
}

const RULES_BLOCK = NARRATIVE_RULES.map((r) => `- ${r}`).join('\n');

/** GOTCHA: the stale-data warning has to be duplicated into the PROMPT TEXT and
 *  not merely into the digest, for exactly the reason recorded above about the
 *  rules block - the prompt gets pasted into a chat window on its own, and a
 *  caveat that lives only in a JSON block the reader did not paste is not a
 *  caveat. This one matters more than most: without it a model will write
 *  "no blockers recorded on tran" from a snapshot where the blocker links were
 *  never collected at all. */
const STALE_NOTE = (headline: string) =>
  `
IMPORTANT - the snapshot behind this report is not fully current: ${headline} ` +
  `Read dataFreshness in the digest before writing anything, state the limitation in your first line, and never ` +
  `report an un-collected field as an absence of the thing it measures.
`;

const PREAMBLE = (site: string, date: string, stale?: string | null) =>
  (stale ? STALE_NOTE(stale) : '') +
  `You are reading a Cadence report for ${site}, generated from immutable Jira and GitLab snapshots captured ${date}. ` +
  `Open the report file and read the JSON in the <script id="to-brief"> block first. It carries every headline figure for every team ` +
  `and is roughly one thirtieth the size of the full model. Only read <script id="to-data"> if you need per-ticket detail for one ` +
  `specific team - it is very large, and reading it when the digest would do is the main way this gets expensive.\n\n` +
  `Rules you must keep:\n${RULES_BLOCK}\n`;

/** The prompts offered on the page. Kept to five: a menu of twenty is a menu
 *  nobody reads, and these five are the documents this report is actually asked
 *  to produce. */
export function briefingPrompts(input: ReportInput): BriefingPrompt[] {
  const pre = PREAMBLE(input.site, input.jiraDate, input.schema?.stale ? input.schema.headline : null);
  const teamKeys = input.teams.map((t) => t.key).join(', ');
  return [
    {
      id: 'exec',
      label: 'Executive summary',
      blurb: 'Three paragraphs for senior management, no jargon.',
      text:
        `${pre}\nWrite an executive summary of this report for senior management who have never seen these boards.\n\n` +
        `Three or four short paragraphs. Lead with the single most important thing across all ${input.teams.length} teams (${teamKeys}), ` +
        `not with a team-by-team walk. Name the teams that need a decision and say what the decision is. ` +
        `Explain any term you use in the same sentence you use it - assume the reader does not know what a p90 or a carryover is. ` +
        `End with the two or three things you would ask for. No bullet lists of metrics; this is prose somebody will read aloud.`,
    },
    {
      id: 'business',
      label: 'Business context brief',
      blurb: 'What each team is building, in business language.',
      text:
        `${pre}\nWrite a BUSINESS context brief: what each of these teams is actually building and for whom.\n\n` +
        `For each team use its epics (epics.active), its sprint goals, its Confluence page titles (confluence.pages) and the ` +
        `board description, which records why this board and this GitLab group were mapped together. ` +
        `Describe the workstream in business terms - the product, the customer, the programme - not in ticket keys. ` +
        `Where the evidence does not support a claim about what a team does, say that the documentation does not make it clear rather than inferring. ` +
        `Finish with a short section on where two teams appear to be working on the same thing, if they do.`,
    },
    {
      id: 'dev',
      label: 'Engineering brief',
      blurb: 'Delivery practice, review culture, technical risk.',
      text:
        `${pre}\nWrite an ENGINEERING brief for a technical audience.\n\n` +
        `Cover, per team: what the work mix says (taxonomy - bug share, estimation coverage, priority use), the review culture ` +
        `(review.mergedWithoutHumanReviewRate and the approval-to-merge gap, always over human-authored merge requests), ` +
        `flow (wip, blockers, stalled parents), and predictability (trends p10/p50/p90 spread against the active commitment). ` +
        `Call out the specific technical risks you can evidence and say what you would change. ` +
        `Be direct about which teams are healthy - a brief that finds everything alarming is not useful.`,
    },
    {
      id: 'team',
      label: 'One-team deep dive',
      blurb: 'Everything about a single team. Edit the key first.',
      text:
        `${pre}\nWrite a deep dive on the team with key "${input.teams[0]?.key ?? 'TEAM'}". ` +
        `(Replace that key with any of: ${teamKeys}.)\n\n` +
        `Read that team's entry in the digest, then read its entry in <script id="to-data"> for the ticket-level detail. ` +
        `Structure it as: what this team builds; how it is delivering; what is in its way; who is on it; and what I should do this week. ` +
        `Quote specific ticket keys and name the specific people only where the point requires it - and where you name somebody, ` +
        `describe a habit or a load, never a performance judgement. ` +
        `Include the flagged items, the most-discussed tickets and the blocker graph, because those are where the unwritten problems are.`,
    },
    {
      id: 'talking',
      label: 'Talking points',
      blurb: 'What to raise, with whom, this week.',
      text:
        `${pre}\nTurn this report into a list of conversations I should have this week.\n\n` +
        `Use the interventions[] array as your starting point - each one already names an action - but write them as things to SAY, ` +
        `with the person or team to say them to and the evidence to bring. Order them by what will go wrong soonest if I do nothing. ` +
        `For each, give me one sentence of context, the specific figure or ticket to cite, and the question to ask. ` +
        `Where the right move is to ask rather than to tell - because the data shows a symptom and not a cause - make that explicit.`,
    },
  ];
}

// --- the compact digest --------------------------------------------------------

function round(v: number | null | undefined, d = 1): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

/** One team, reduced to what a narrative actually cites.
 *
 *  The omissions are the design. No ticket arrays beyond a handful of named
 *  examples, no per-sprint series, no merge-request list - all of that is in
 *  #to-data for the one team somebody drills into, and carrying it here would
 *  make the cheap path as expensive as the expensive one. */
function digestTeam(t: ReportTeamInput): Record<string, unknown> {
  const tx = t.taxonomy;
  const r = t.review;
  return {
    key: t.key,
    board: t.boardName ?? null,
    boardId: t.boardId ?? null,
    projectKeys: (t.prefixes ?? []).slice(0, 3).map((p) => p.key),
    gitlabGroups: t.gitlabGroups ?? [],
    confluenceSpaces: (t.confluence?.spaces ?? []).map((s) => s.key ?? s.name).filter(Boolean),
    confluencePageTitles: (t.confluence?.pages ?? []).slice(0, 12).map((p) => p.title),
    whyThisMapping: t.description ?? null,

    health: {
      overall: t.health.headline,
      poorSignals: t.health.poorCount,
      watchSignals: t.health.watchCount,
      signals: t.health.signals.map((s) => ({ name: s.label, tone: s.tone, value: s.value, detail: s.detail })),
    },
    sprint: {
      activeSprints: t.activeLoad.sprintCount,
      names: t.activeLoad.sprintNames,
      goals: (t.sprintGoals ?? []).map((g) => g.goal).filter(Boolean),
      committedIssues: t.activeLoad.issues,
      committedPoints: t.activeLoad.points,
      unestimated: t.activeLoad.unestimated,
      resolvedSoFar: t.activeLoad.resolved,
      outlook: t.outlook
        ? {
            verdict: t.outlook.verdict,
            sprintName: t.outlook.sprintName,
            daysRemaining: t.outlook.daysRemaining,
            elapsedFraction: round(t.outlook.elapsedFraction, 2),
            donePoints: t.outlook.donePoints,
            remainingPoints: t.outlook.remainingPoints,
            paceRatio: round(t.outlook.paceRatio),
            unreliableReason: t.outlook.unreliableReason ?? null,
          }
        : null,
    },
    velocity: {
      p10: round(t.trends.pointsForecast.p10),
      p50: round(t.trends.pointsForecast.p50),
      p90: round(t.trends.pointsForecast.p90),
      relativeSpread: round(t.trends.pointsForecast.relativeSpread, 2),
      basisSprints: t.trends.pointsForecast.basis,
      carryoverRateMedian: round(t.trends.carryoverRateMedian, 2),
      note: "Empirical percentiles over this team's own recent closed sprints. Never compare across teams. A high relativeSpread means the median is a poor planning number.",
    },
    workMix: tx
      ? {
          scope: 'active sprint',
          issues: tx.issues,
          bugShare: round(tx.bugShare, 2),
          estimatedShare: tx.issues ? round((tx.issues - tx.unestimated) / tx.issues, 2) : null,
          topTypes: tx.types.slice(0, 5).map((x) => ({ name: x.name, issues: x.issues })),
          topLabels: tx.labels.slice(0, 6).map((x) => ({ name: x.name, issues: x.issues })),
          topComponents: tx.components.slice(0, 5).map((x) => ({ name: x.name, issues: x.issues })),
        }
      : null,
    review: r
      ? {
          humanAuthored: r.humanAuthoredTotal,
          automationAuthored: r.automationAuthored,
          merged: r.merged,
          mergedWithoutHumanReview: r.mergedWithoutHumanReview,
          mergedWithoutHumanReviewRate:
            r.mergedKnown > 0 ? round(r.mergedWithoutHumanReview / r.mergedKnown, 2) : null,
          approvedAfterMerge: r.approvedAfterMerge,
          awaitingReviewNow: r.awaitingFirstHumanReview.length,
          hoursToFirstHumanReviewP50: round(r.hoursToFirstHumanReviewP50),
          hoursToFirstHumanReviewBasis: r.hoursToFirstHumanReviewBasis ?? null,
          hoursOpenToMergeP50: round(r.hoursOpenToMergeP50),
          hoursApprovalToMergeP50: round(r.hoursApprovalToMergeP50),
          hoursApprovalToMergeBasis: r.hoursApprovalToMergeBasis,
          withIssueKey: r.withIssueKey,
          caveat: 'Rates are over human-authored merge requests only. Latencies are over the ones that got a review - survivorship.',
        }
      : null,
    flow: t.wip
      ? {
          totalInProgress: t.wip.totalInProgress,
          usingBoardColumns: t.wip.usingBoardColumns,
          overloaded: t.wip.overloaded,
          perColumn: t.wip.columns
            .filter((c) => !c.done)
            .map((c) => ({ column: c.name, issues: c.issues, stale: c.stale, medianIdleDays: round(c.medianIdleDays, 0) })),
          // Observed column ageing, which is the SOUND version of medianIdleDays
          // above: that one is derived from the ticket's `updated` timestamp and
          // resets when somebody merely comments, this one is walked from the
          // column each ticket was actually recorded in on each collected day.
          // Both are carried so a narrative can use the right one, and the
          // caveat says which is which.
          columnAgeing: (t.history?.columnDwell ?? []).slice(0, 10).map((c) => {
            const ok = dwellIsReportable(c);
            return {
              column: c.column,
              openHere: c.count,
              // NULL, not the raw percentile, below the basis bar. A model handed
              // a number will quote it, and "a null means not measurable, never
              // zero" is already one of the narrative rules - so the thin case
              // has to arrive as a null rather than as a 3 with a caveat several
              // fields away that the prose may not carry.
              medianDaysInColumn: ok ? round(c.medianDwellDays, 0) : null,
              p90DaysInColumn: ok ? round(c.p90DwellDays, 0) : null,
              observedBasis: c.basis,
              unobservedEntries: c.censored,
              longestSitting: c.oldest.slice(0, 3).map((i) => ({
                key: i.key,
                days: round(i.dwellDays, 0),
                atLeast: i.censored,
              })),
            };
          }),
          caveat:
            'medianIdleDays comes from the ticket\'s last-updated timestamp and resets on any edit, including a comment. ' +
            'columnAgeing is observed column membership across collected days and is the figure to quote for "how long has this been stuck". ' +
            'A columnAgeing entry with longestSitting[].atLeast true began before collection started, so its days are a LOWER bound, not a measurement. ' +
            `medianDaysInColumn and p90DaysInColumn are null wherever observedBasis is below ${MIN_DWELL_BASIS}: openHere is still exact there, but too few entries into that column were observed for a median to mean anything. Do not describe such a column as fast.`,
        }
      : null,
    epics: t.epics
      ? {
          namesCollected: t.epics.namesCollected,
          activeCount: t.epics.rollups.filter((e) => e.active.issues > 0).length,
          inSprint: t.epics.rollups
            .filter((e) => e.active.issues > 0)
            .slice(0, 8)
            .map((e) => ({
              key: e.key,
              name: e.name,
              activeIssues: e.active.issues,
              doneShareOnThisBoard: round(e.progress, 2),
              blocked: e.blocked,
              carried: e.carried,
              people: e.people.slice(0, 6),
              oldestOpenDays: round(e.oldestOpenDays, 0),
            })),
          inBacklogOnly: t.epics.rollups
            .filter((e) => e.active.issues === 0 && e.backlog.issues > 0)
            .slice(0, 8)
            .map((e) => ({ key: e.key, name: e.name, backlogIssues: e.backlog.issues })),
          caveat:
            'progress counts ISSUES visible on THIS board. Work under the same epic on another board is invisible, so a rollup can read 100% while the epic is half finished.',
        }
      : null,
    backlog: t.backlog
      ? { issues: t.backlog.issues, unestimated: t.backlog.unestimated, medianAgeDays: round(t.backlog.medianAgeDays, 0), olderThan90Days: t.backlog.olderThan90Days }
      : null,
    people: t.roster
      ? {
          namesSeen: t.roster.members.length,
          holdingSprintWork: t.roster.activeContributors,
          unassignedSprintWork: t.roster.unassignedOpenInActiveSprint,
          heaviestLoads: t.roster.members
            .slice(0, 5)
            .map((m) => ({ name: m.name, openInSprint: m.openInActiveSprint, mrs: m.mergeRequestsAuthored, reviewsGiven: m.reviewsGiven })),
          caveat: 'A contact sheet, not a scorecard. Counts what somebody holds, never what they produced.',
        }
      : null,
    composition: t.composition
      ? {
          medianContributors: t.composition.medianContributors,
          latestContributors: t.composition.latestContributors,
          recentJoiners: t.composition.sprints.slice(-1)[0]?.joined ?? [],
          recentLeavers: t.composition.sprints.slice(-1)[0]?.left ?? [],
          caveat: 'Assignee-based and WEAK. Reliable for "did this team change size", not for attendance.',
        }
      : null,
    trouble: {
      flaggedOpen: t.flagged?.total ?? null,
      flaggedInActiveSprint: t.flagged?.inActiveSprint ?? null,
      flaggedOutsideThePlan: t.flagged?.strandedFlags ?? null,
      openBlockersGatingOthers: (t.blockers ?? []).filter((b) => !b.blockerDone).length,
      stalledParents: t.subtasks?.stalledParents ?? null,
      mostDiscussed: (t.discussed ?? []).slice(0, 5).map((d) => ({
        key: d.key,
        summary: d.summary ?? null,
        comments: d.commentCount,
        sprints: d.sprintCount,
        latestComment: d.latestComment ? `${d.latestComment.author ?? 'someone'}: ${d.latestComment.body}` : null,
      })),
      carriedThreePlusSprints: t.carryoverLeaders.slice(0, 5).map((c) => ({ key: c.key, sprints: c.sprintCount, summary: c.summary ?? null })),
    },
    interventions: (t.interventions ?? []).slice(0, 8).map((i) => ({
      severity: i.severity,
      kind: i.kind,
      title: i.title,
      what: i.what,
      why: i.why,
      action: i.action,
      tickets: i.issueKeys.slice(0, 6),
      evidence: i.evidence ?? null,
    })),
  };
}

export function briefingDigest(input: ReportInput): Record<string, unknown> {
  return {
    what: 'A compact digest of this Cadence report, for writing narrative from. Read this instead of #to-data unless you need per-ticket detail for one team.',
    rules: NARRATIVE_RULES,
    site: input.site,
    jiraSnapshot: input.jiraDate,
    gitlabWindowDays: input.windowDays ?? 30,
    generatedAt: input.generatedAt,
    teamCount: input.teams.length,
    // The freshness verdict travels WITH the data, for the same reason the rules
    // do: a model handed this digest has no other way to know that half the
    // context fields were absent from the snapshot it is describing, and
    // "nothing is flagged on this board" is a very different sentence when the
    // flag register was never collected. Absent when the snapshot is current.
    dataFreshness: input.schema && input.schema.stale
      ? {
          warning: input.schema.headline,
          missing: input.schema.files.filter((f) => f.behind).flatMap((f) => f.missing),
          notCollected: input.schema.gaps.map((g) => `${g.what} (${g.present} of ${g.total} ${g.scope}; ${g.cause})`),
          instruction:
            'Say this in the first line of anything you write from this digest. An empty panel and an un-collected panel are not the same claim.',
        }
      : undefined,
    teams: input.teams.map(digestTeam),
  };
}

// --- the page furniture ---------------------------------------------------------

/** The banner. Deliberately at the TOP of the report and deliberately loud.
 *
 *  It is the one piece of UI here that tells the reader the document is only
 *  half of what they can have: the numbers are finished and the explanation is
 *  one paste away. A reader who does not know that will read the tables and
 *  conclude the tool cannot answer "so what". */
function kb(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** The digest, its prompts, and the two MEASURED sizes the banner quotes -
 *  built once and shared between the banner and the embedded block.
 *
 *  GOTCHA: `briefingBanner` and `briefingData` each used to build the digest and
 *  serialise it independently, and the banner additionally serialised
 *  `input.teams` purely to measure it. That is four full passes over a model this
 *  file's own header measures at roughly 3 MB on this estate - several megabytes
 *  of JSON string built and immediately discarded on every `report` run, for two
 *  numbers and one embed. Memoised on the input object rather than recomputed,
 *  because both callers are handed the same `ReportInput` by `buildReport`.
 *
 *  The sizes are UTF-16 code-unit counts, not bytes - `String.length` - so they
 *  are exact for ASCII and a slight under-count for the non-ASCII characters
 *  that do appear in ticket titles. They exist to tell a reader that the digest
 *  is orders of magnitude smaller than the full model, and they carry that at
 *  any plausible encoding. */
const briefingCache = new WeakMap<ReportInput, { payload: Record<string, unknown>; digestBytes: number; fullBytes: number }>();

function briefingPayload(input: ReportInput): { payload: Record<string, unknown>; digestBytes: number; fullBytes: number } {
  const hit = briefingCache.get(input);
  if (hit) return hit;
  const payload = { ...briefingDigest(input), prompts: briefingPrompts(input) };
  const built = {
    payload,
    digestBytes: JSON.stringify(payload).length,
    fullBytes: JSON.stringify(input.teams).length,
  };
  briefingCache.set(input, built);
  return built;
}

export function briefingBanner(input: ReportInput): string {
  const prompts = briefingPrompts(input);
  // Measured, not asserted. See the note in this file's header.
  const { digestBytes, fullBytes } = briefingPayload(input);
  const embedded = input.embedData !== false;
  const buttons = prompts
    .map(
      (p) => `<button type="button" class="ask-btn" data-prompt-id="${escapeAttr(p.id)}">
        <span class="ask-btn-label">${escapeHtml(p.label)}</span>
        <span class="ask-btn-blurb">${escapeHtml(p.blurb)}</span>
      </button>`,
    )
    .join('');

  return `<section class="briefing" id="briefing">
    <div class="briefing-head">
      <span class="briefing-badge">Half of this report is not written yet</span>
      <h2>Ask Claude to turn these numbers into the document you actually need</h2>
      <p class="lede">Everything below is measured and deterministic &mdash; no model computed any of it. What it
        <em>cannot</em> tell you is what any of it means for your programme, because that context is not in Jira.
        ${
          embedded
            ? `This file carries a compact briefing digest and a set of ready-made prompts so a model can write that part
        cheaply and without inventing numbers &mdash; the digest is <strong>${escapeHtml(kb(digestBytes))}</strong>
        against <strong>${escapeHtml(kb(fullBytes))}</strong> for the full per-ticket model.`
            : `This report was generated with <code>--no-embed-data</code>, so <strong>no machine-readable data is
        embedded in it</strong> and the prompts below have nothing to read. Regenerate without that flag to use them.`
        }</p>
    </div>
    ${embedded ? `<ol class="briefing-how">
      <li><strong>Copy a prompt</strong> below.</li>
      <li><strong>Open Claude Code</strong> in a terminal, or claude.ai, and paste it.</li>
      <li><strong>Attach or point it at this HTML file.</strong> The prompt tells it to read the
        <code>#to-brief</code> block first, so it costs a fraction of what reading the whole report would.</li>
    </ol>
    <div class="ask-grid">${buttons}</div>
    <p class="briefing-copied" id="briefing-copied" role="status" aria-live="polite"></p>` : ''}
    ${!embedded ? '' : expander('What is embedded in this file, and why a model can be trusted with it', `
      <p>Two JSON blocks are embedded in this HTML:</p>
      <dl class="explain">
        <dt><code>#to-brief</code></dt><dd><strong>${escapeHtml(kb(digestBytes))}.</strong> Every headline figure,
          per team, plus the rules below and the prompts themselves. This is what the prompts point at, and it is
          why asking for a summary is cheap.</dd>
        <dt><code>#to-data</code></dt><dd><strong>${escapeHtml(kb(fullBytes))}.</strong> The complete derived model,
          including every ticket. Worth reading only for a single-team deep dive.</dd>
      </dl>
      <p>Both carry the same guardrails, because the risk with a generated narrative is not that it says too
        little &mdash; it is that it states something provably wrong with total confidence in a document that goes
        to the board. The rules travel with the data:</p>
      <ul class="plain rules">${NARRATIVE_RULES.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`)}
  </section>`;
}

/** The embedded digest and prompt set.
 *
 *  Honours `embedData` exactly as the full model does, and that is deliberate
 *  rather than incidental. The digest is smaller, but it is not less sensitive:
 *  it carries people's names, their current load and verbatim comment text. A
 *  reader who passes --no-embed-data to keep that out of a file they are about
 *  to email has asked for it to be out of the file, not for it to be smaller. */
export function briefingData(input: ReportInput): string {
  if (input.embedData === false) return '';
  const { payload } = briefingPayload(input);
  return `<script type="application/json" id="to-brief">${jsonForScript(payload)}</script>`;
}

/** A per-panel question, rendered as an attribute the client script turns into
 *  a small "Ask" affordance. Returns an attribute string, so a panel that has
 *  nothing worth asking about simply omits it. */
export function ask(question: string): string {
  return ` data-ask="${escapeAttr(question)}"`;
}
