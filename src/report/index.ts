import type { ChangeSummary } from '../changes.js';
import type { HealthTone } from '../insights.js';
import type { Intervention } from '../interventions.js';
import { rankInterventions } from '../interventions.js';
import { boardUrl } from '../links.js';
import { CSS } from './css.js';
import { CLIENT_JS } from './client.js';
import { chartJsSource, jsonForScript } from './assets.js';
import {
  burndownChart,
  cfdChart,
  columnAgeingChart,
  compositionChart,
  crossTeamLoadChart,
  cycleScatterChart,
  deliveryChart,
  epicChart,
  estateEpicChart,
  portfolioChart,
  practiceChart,
  reviewLatencyChart,
  wipChart,
  type ChartSpec,
} from './charts.js';
import { dataPanel, estateEpicsPanel, mappingPanel, peoplePanel } from './estate.js';
import { orgChart } from './orgmap.js';
import {
  escapeAttr,
  escapeHtml,
  expander,
  figures,
  explain,
  fmt,
  kpi,
  link,
  pct,
  rate,
  tag,
  term,
} from './format.js';
import {
  groupByPrefix,
  loadVerdict,
  type ReportInput,
  type ReportTeamInput,
} from './model.js';
import {
  attentionTable,
  backlogPanel,
  cfdPanel,
  changesPanel,
  churnPanel,
  columnAgeingPanel,
  compositionPanel,
  contextPanel,
  cyclePanel,
  epicsPanel,
  healthPanel,
  interventionFeed,
  nouns,
  orientationPanel,
  outlookLabel,
  outlookPanel,
  outlookTone,
  practicePanel,
  slowestPanel,
  ticket,
  wipPanel,
  type RenderContext,
} from './panels.js';
import {
  blockerPanel,
  discussionPanel,
  flaggedPanel,
  rosterPanel,
  subtaskPanel,
  taxonomyPanel,
} from './detail.js';
import { ask, briefingBanner, briefingData } from './briefing.js';
import { freshnessBanner } from './freshness.js';

// ---------------------------------------------------------------------------
// The static UI: one self-contained HTML file. No server, no build step, no
// CDN, no runtime network of any kind - it has to open from the filesystem on
// a locked-down corporate laptop and survive a projector.
//
// Chart.js is VENDORED: read out of node_modules at generation time and
// inlined. It is allowed to draw and nothing else. Every number it plots is
// also rendered as literal text in the HTML beside it, so:
//   - a blocked inline script degrades the page to readable tables, and
//   - there is no client-side code path that can produce a different number
//     from the one the CLI prints.
//
// A chart makes everything look equally solid, so nothing in here promotes a
// WEAK or UNUSABLE metric (see derive.ts, review.ts) without carrying its
// label alongside the number, and reassuring verdicts are withheld when their
// basis is missing (loadVerdict in model.ts, sprintOutlook in insights.ts).
//
// THE ORGANISING PRINCIPLE OF THIS PAGE, and what changed in the sixth
// session: the report is now written for a reader who knows NOTHING - not the
// board, not the team, not what a p90 is. Three things carry that:
//   1. an intervention feed at the top that states an ACTION, not a metric;
//   2. a hover card on every ticket, person and piece of jargon;
//   3. a collapsed "what this is and what to do with it" on every panel.
// None of it is decoration. A number a reader cannot interpret is a number
// they will either ignore or misquote, and both are worse than no number.
// ---------------------------------------------------------------------------

export { escapeHtml, shortSprintLabel } from './format.js';
export {
  activeLoad,
  backlogSummary,
  carryoverLeaders,
  groupByPrefix,
  loadVerdict,
  projectPrefixes,
} from './model.js';
export type {
  ActiveLoad,
  BacklogItem,
  BacklogSummary,
  CarryoverLeader,
  LoadTone,
  LoadVerdict,
  ReportInput,
  ReportTeamInput,
} from './model.js';

const RECENT_SPRINTS = 14;

// --- triage -------------------------------------------------------------------

function verdictOf(h: HealthTone): string {
  return h === 'good' ? 'well oiled — step back' : h === 'watch' ? 'worth a look' : h === 'poor' ? 'needs you' : 'not enough data';
}

function triageBanner(ctx: RenderContext, teams: ReportTeamInput[]): string {
  const order: Record<HealthTone, number> = { poor: 0, watch: 1, unknown: 2, good: 3 };
  const sorted = [...teams].sort(
    (a, b) => order[a.health.headline] - order[b.health.headline] || b.health.poorCount - a.health.poorCount,
  );
  const cards = sorted
    .map((t) => {
      const worst = t.health.signals.filter((s) => s.tone === 'poor');
      const watch = t.health.signals.filter((s) => s.tone === 'watch');
      const acts = (t.interventions ?? []).filter((i) => i.severity === 'act-now').length;
      const why =
        worst.length > 0
          ? `${worst.map((s) => s.label.toLowerCase()).join(', ')} ${worst.length === 1 ? 'is' : 'are'} in the red.`
          : watch.length > 0
            ? `${watch.map((s) => s.label.toLowerCase()).join(', ')} worth watching.`
            : t.health.headline === 'good'
              ? 'Every measured signal is healthy.'
              : 'Not enough mapped data to judge.';
      return `<div class="triage-card ${t.health.headline}">
        <div class="who"><a href="#team=${escapeAttr(t.key)}" data-target="panel-${escapeAttr(t.key)}"
              data-target-tab="tab-${escapeAttr(t.key)}">${escapeHtml(t.key)}</a>
          <span class="prefix">${escapeHtml(t.prefix)}</span></div>
        <div class="verdict" data-summary-line>${escapeHtml(t.key)} — ${escapeHtml(verdictOf(t.health.headline))}</div>
        <div class="why" data-summary-line>${escapeHtml(why)}</div>
        ${acts > 0 ? `<div class="acts">${acts} thing${acts === 1 ? '' : 's'} to act on now</div>` : ''}
        <div class="board-link">${link(boardUrl(ctx.site, t.boardId ?? t.trends.boardId), 'open board')}</div>
      </div>`;
    })
    .join('');
  return `<div class="triage" id="triage-summary">${cards}</div>`;
}

// --- portfolio ----------------------------------------------------------------

function portfolioPanel(ctx: RenderContext, teams: ReportTeamInput[]): string {
  const rows = teams
    .map((t) => {
      const pf = t.trends.pointsForecast;
      const v = loadVerdict(t.activeLoad, pf.p90);
      const carry = t.quality.findings.find((f) => f.code === 'carried-three-plus-sprints');
      const unest = t.activeLoad.issues > 0 ? t.activeLoad.unestimated / t.activeLoad.issues : null;
      const unrev = t.review && t.review.mergedKnown > 0 ? t.review.mergedWithoutHumanReview / t.review.mergedKnown : null;
      const oTone = outlookTone(t.outlook);
      const people = t.composition?.latestContributors ?? null;
      return `<tr>
        <td><a href="#team=${escapeAttr(t.key)}"><strong>${escapeHtml(t.key)}</strong></a>
            <div class="muted">${escapeHtml(t.boardName ?? '')} &middot; #${t.trends.boardId}</div></td>
        <td><span class="prefix">${escapeHtml(t.prefix)}</span></td>
        <td class="num" data-sort="${people ?? -1}">${people === null ? '—' : people}</td>
        <td class="num" data-sort="${pf.p50 ?? -1}">${fmt(pf.p50)}</td>
        <td class="num" data-sort="${pf.p90 ?? -1}">${fmt(pf.p90)}</td>
        <td class="num ${v.tone === 'over' ? 'poor' : ''}" data-sort="${t.activeLoad.points}">${t.activeLoad.points}${t.activeLoad.sprintCount > 1 ? `<div class="muted">${t.activeLoad.sprintCount} sprints</div>` : ''}</td>
        <td class="num ${v.tone === 'over' ? 'poor' : v.tone === 'within' ? 'good' : 'unknown'}">${escapeHtml(v.label)}</td>
        <td class="num ${oTone}">${escapeHtml(outlookLabel(t.outlook))}</td>
        <td class="num ${unest !== null && unest > 0.33 ? 'poor' : ''}" data-sort="${unest ?? -1}">${rate(unest)}</td>
        <td class="num" data-sort="${pf.relativeSpread ?? -1}">${rate(pf.relativeSpread)}</td>
        <td class="num" data-sort="${carry && carry.outOf ? carry.count / carry.outOf : -1}">${carry ? pct(carry.count, carry.outOf ?? carry.count) : '—'}</td>
        <td class="num ${unrev !== null && unrev >= 0.5 ? 'poor' : ''}" data-sort="${unrev ?? -1}">${rate(unrev)}</td>
      </tr>`;
    })
    .join('');

  const overloaded = teams.filter((t) => loadVerdict(t.activeLoad, t.trends.pointsForecast.p90).tone === 'over');
  const notComparable = teams.filter((t) => loadVerdict(t.activeLoad, t.trends.pointsForecast.p90).label === 'not comparable');

  return `<section class="panel" id="portfolio">
    <h2>Portfolio ${tag('sound', 'SOUND', 'Anchored to a fact recorded when it happened, and independent of current board state.')}</h2>
    <p class="lede">${teams.length} teams, one per Jira board. Every figure is that team's own history &mdash; there is
      no shared target and no cross-team ranking implied: a point on one board is not a point on another.</p>
    <div class="chart-box"><canvas id="chart-portfolio"></canvas></div>
    ${figures(
      teams.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr>
        <th>Team</th><th>Prefix</th>
        <th class="num">${term('People', 'Distinct people who completed at least one issue in the most recent closed sprint.')}</th>
        <th class="num">${term('p50', "The team's median completed points across its own recent closed sprints. A typical sprint.")}</th>
        <th class="num">${term('p90', 'The 90th percentile of the same. Close to the best this team has ever delivered.')}</th>
        <th class="num">Committed</th>
        <th class="num">${term('Load', 'Committed points against the p90. “Over p90” means the team has promised more than it has ever delivered.')}</th>
        <th class="num">This sprint</th>
        <th class="num">Unestimated</th>
        <th class="num">${term('Spread', 'p90 minus p10 as a share of the median. Above 100% the median stops being a usable planning number.')}</th>
        <th class="num">${term('Carried 3+', 'Open items in the active sprint that have already been in three or more sprints.')}</th>
        <th class="num">${term('Merged unreviewed', `Share of merged ${nouns(ctx).many}, opened by a person, that had no comment or approval from anybody but their author.`)}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`,
    )}
    ${
      overloaded.length > 0
        ? `<div class="callout warn"><div class="big">${overloaded.length} of ${teams.length}</div>
           <div class="body">teams are carrying more points than they delivered in any closed sprint their own forecast
           is built on (${overloaded.map((t) => `${escapeHtml(t.key)} <strong>${t.activeLoad.points}</strong> vs p90 ${fmt(t.trends.pointsForecast.p90)}`).join(', ')}).
           Committing above p90 is not a stretch goal; on this evidence it is a plan to carry work over.</div></div>`
        : ''
    }
    ${
      notComparable.length > 0
        ? `<div class="callout neutral"><div class="big">${notComparable.length} of ${teams.length}</div>
           <div class="body">teams cannot have their load compared to their history at all, because more than a third of
           their active sprint carries no estimate (${notComparable.map((t) => escapeHtml(t.key)).join(', ')}). Their
           committed column counts only the estimated minority, so it reads low and is <strong>not</strong> spare
           capacity.</div></div>`
        : ''
    }
    <p class="footnote">Click a column heading to sort; hover a heading for what it means. "Load" says <em>over p90</em>
      only when committed points already exceed the p90 &mdash; a valid lower bound even when estimates are missing
      &mdash; and withholds the reassuring <em>within band</em> verdict when more than a third of the sprint is
      unestimated.</p>
  </section>`;
}

// --- per-sprint history table ----------------------------------------------------

function deliveryPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const closed = t.trends.sprints.filter((s) => s.state === 'closed').slice(-RECENT_SPRINTS);
  const pf = t.trends.pointsForecast;
  const board = t.boardId ?? t.trends.boardId;
  const rows = [...closed]
    .reverse()
    .map(
      (s) => `<tr>
      <td>${link(`${boardUrl(ctx.site, board)}&view=reporting&chart=sprintRetrospective&sprint=${s.id}`, s.name)}
        <div class="muted">${s.completeDate ? escapeHtml(s.completeDate.slice(0, 10)) : s.endDate ? escapeHtml(s.endDate.slice(0, 10)) : ''}</div></td>
      <td class="num" data-sort="${s.completedIssues}">${s.completedIssues}</td>
      <td class="num" data-sort="${s.completedPoints}">${s.completedPoints}</td>
      <td class="num" data-sort="${s.unestimatedCommitted}">${s.unestimatedCommitted}</td>
      <td class="num" data-sort="${s.daysLate ?? -99}">${fmt(s.daysLate)}</td>
      <td class="num" data-sort="${s.leadTimeDaysP50 ?? -1}">${fmt(s.leadTimeDaysP50, 0)}</td>
      <td>${Object.entries(s.completedByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, n]) => `<span class="chip">${escapeHtml(k)} ${n}</span>`)
        .join('')}</td>
    </tr>`,
    )
    .join('');

  return `
    <p class="chart-note">Story points <strong>completed</strong> per closed sprint, with this team's own p50 and p90.
      The amber column is the active sprint's <em>committed</em> load &mdash; promised, not yet delivered.</p>
    <div class="chart-box"><canvas id="chart-delivery-${escapeAttr(t.key)}"></canvas></div>
    <div class="kpis">
      ${kpi('p10 — a bad sprint', fmt(pf.p10), `basis ${pf.basis} closed sprints`, '', 'One sprint in ten delivers less than this. It is the number to plan on when a commitment must be kept.')}
      ${kpi('p50 — a typical sprint', fmt(pf.p50), 'the median', '', 'Half this team’s sprints deliver more than this, half less.')}
      ${kpi('p90 — a very good sprint', fmt(pf.p90), 'rarely beaten', '', 'Only one sprint in ten beats this. Committing above it is committing to a best-ever result.')}
      ${kpi('Spread', rate(pf.relativeSpread), 'p90 − p10, over the median', pf.relativeSpread !== null && pf.relativeSpread > 2 ? 'poor' : pf.relativeSpread !== null && pf.relativeSpread > 1 ? 'watch' : 'good', 'How wide the band is. Above 100% the median is wider than itself and stops being a planning number — plan on the p10 instead.')}
    </div>
    ${figures(
      closed.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Sprint</th><th class="num">Done</th><th class="num">Points</th>
        <th class="num">${term('Unestimated', 'Issues in that sprint with no estimate in either story-point field. Its points total is understated by whatever they were worth.')}</th>
        <th class="num">${term('Days late', 'Between the planned end date and when the sprint was actually closed. Nearly every sprint here closes a fraction late because teams close manually at standup — only a slip of more than a day or so means anything.')}</th>
        <th class="num">${term('Lead p50', 'Median created → resolved for the work completed in that sprint. WEAK: it includes backlog dwell.')}</th>
        <th>What was delivered</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
    )}
    <p class="footnote">Completed points are anchored to each issue's resolution date falling inside that sprint's
      window, so they are independent of how the board looks today. Committed and carryover figures for <em>closed</em>
      sprints are not sound on the same basis and are deliberately not charted &mdash; see the legend.</p>
    ${explain(
      'What this team actually finished, sprint by sprint, and the band its own recent history forms.',
      'It replaces a target nobody agreed to with evidence the team produced itself. A commitment above the p90 is a commitment to a best-ever sprint, and that can be said out loud to anybody who asks for more.',
      'Quote the p10 when a date has to be kept and the p50 when planning normally. If the spread is above 100%, say the median is not a planning number for this team — and check the composition panel for a headcount change underneath it.',
    )}`;
}

// --- team panel ---------------------------------------------------------------

/** The team tab grew to twenty-plus sections, and a flat subnav of twenty links
 *  is a list you scroll past rather than read. Grouped, it becomes four things
 *  to choose between, and the choice is the one a reader actually has in mind:
 *
 *    DECIDE   what to do, and will this sprint land.
 *    FLOW     where the work is and how it is moving. Every observed metric.
 *    PEOPLE   who is on this board and how they work. Contact sheet, not
 *             scorecard, throughout.
 *    CONTEXT  what this work IS, what it is queued behind, and what to distrust.
 *
 *  Ordered so the sections a daily reader needs are the ones they land on. */
type SectionGroup = 'decide' | 'flow' | 'people' | 'context';

const GROUP_LABEL: Record<SectionGroup, string> = {
  decide: 'Decide',
  flow: 'How work is flowing',
  people: 'People & practice',
  context: 'Context & caveats',
};

const GROUP_ORDER: SectionGroup[] = ['decide', 'flow', 'people', 'context'];

interface Section {
  id: string;
  title: string;
  tagHtml: string;
  lede: string;
  bodyHtml: string;
  /** Which group this section navigates under, and is emitted in. */
  group: SectionGroup;
  /** The section's own reading, where a real figure supplies one. Rolled up to
   *  a dot on the group heading so the subnav says which GROUP needs opening
   *  rather than only listing what exists. A section with no figure that could
   *  honestly supply a tone leaves this unset and contributes nothing to its
   *  group's dot, which is why the dot can be absent - absent, never drawn as
   *  green, for the same reason "not measurable" is never drawn as zero. */
  tone?: HealthTone;
  /** Sections start open only when they NEED the reader today.
   *
   *  The rule, in priority order:
   *    1. empty or not-yet-measured  -> closed
   *    2. tone poor or watch         -> open
   *    3. carries an act-now finding -> open
   *    4. changed since the last collection -> open
   *    5. otherwise                  -> closed
   *
   *  Rule 1 stays FIRST so an empty section can never be forced open by a tone
   *  it inherited from a figure it does not have. Each section literal below
   *  still sets this to the RULE-1 emptiness predicate; `needsReader` is the
   *  resolver that folds rules 2-5 in afterwards. */
  collapsed?: boolean;
  /** The one line a CLOSED section shows beside its heading, so it is summarised
   *  rather than hidden. Derived only from figures computed elsewhere - never a
   *  new measurement. Absent means the heading and its tag say enough. */
  gist?: string;
  /** A question scoped to THIS panel, for the hand-off layer. The client script
   *  turns it into a small "Ask" affordance in the heading. Scoped rather than
   *  general on purpose: "explain this report" is an expensive, vague request,
   *  and "explain why this team's approval-to-merge gap is 182 hours" is
   *  answerable in a few hundred tokens. */
  ask?: string;
}

function sectionHtml(teamKey: string, s: Section): string {
  return `<section class="panel" id="sec-${escapeAttr(teamKey)}-${escapeAttr(s.id)}" data-section="${escapeAttr(s.id)}"${
    s.ask ? ask(`About team "${teamKey}" in this Cadence report: ${s.ask}`) : ''
  }>
    <details class="expander sec"${s.collapsed ? '' : ' open'} data-needs="${s.collapsed ? 'false' : 'true'}">
      <summary>
        <h2>${escapeHtml(s.title)} ${s.tagHtml}</h2>
        ${s.tone ? `<span class="dot ${s.tone}" title="${escapeAttr(verdictOf(s.tone))}"></span>` : ''}
        ${s.gist ? `<span class="sec-gist muted">${escapeHtml(s.gist)}</span>` : ''}
      </summary>
      <div class="expander-body">
        ${s.lede ? `<p class="lede">${s.lede}</p>` : ''}
        ${s.bodyHtml}
      </div>
    </details>
  </section>`;
}

// Which SECTION an intervention kind is about, for rule 4 of `needsReader`
// below (see the kinds in ../interventions.ts). An explicit table rather than a
// fuzzy string match: a wrong mapping silently opens or closes the wrong
// sections, which is worse than not having rule 4 at all. A kind added there
// without an entry here falls through to undefined and is silently excluded
// from rule 4 rather than crashing the build - correct, because "no honest
// mapping yet" is a valid state for a new kind.
const CHANGE_KIND_SECTION: Record<string, string | null> = {
  flagged: 'flagged',
  'blocked-by-open': 'blockers',
  'blocker-in-comments': 'blockers',
  stale: 'attention',
  overdue: 'attention',
  'sprint-overdue': 'sprint',
  'wip-overload': 'board',
  unassigned: 'attention',
  'no-goal': 'sprint',
  'over-committed': 'sprint',
  'review-stalled': 'review',
  'review-gap': 'review',
  'merge-lag': 'review',
  'scope-churn': 'churn',
  'comments-not-collected': 'trust',
};

// Whether a section needs the reader TODAY. One function, applied to every
// section, so the rule is in one place and a reader can be told what it is.
//
// GOTCHA: this must run AFTER the sections array is built, because it reads
// s.tone and s.collapsed that the declarations set. Applying it inside the
// array literal would read undefined for both and quietly close everything.
function needsReader(s: Section, actNow: number, changedIds: Set<string>): boolean {
  if (s.collapsed) return false; // rule 1 wins outright
  if (s.tone === 'poor' || s.tone === 'watch') return true;
  if (s.id === 'act' && actNow > 0) return true;
  if (changedIds.has(s.id)) return true;
  return false;
}

function teamPanel(ctx: RenderContext, t: ReportTeamInput, changes: ChangeSummary | undefined): string {
  const pf = t.trends.pointsForecast;
  const v = loadVerdict(t.activeLoad, pf.p90);
  const carry = t.quality.findings.find((f) => f.code === 'carried-three-plus-sprints');
  const unrev = t.review && t.review.mergedKnown > 0 ? t.review.mergedWithoutHumanReview / t.review.mergedKnown : null;
  const blocked = t.attention.filter((a) => a.reasons.includes('blocked') || a.reasons.includes('blocked-by') || a.reasons.includes('commented-blocked')).length;
  const acts = (t.interventions ?? []).filter((i) => i.severity === 'act-now').length;

  const highFindings = t.quality.findings.filter((f) => f.severity === 'high' && f.code !== 'carried-three-plus-sprints');

  const sections: Section[] = [
    {
      id: 'act',
      group: 'decide',
      tone: acts > 0 ? 'poor' : 'good',
      title: 'What to do about this team',
      tagHtml: tag('new', 'ACTIONS'),
      lede:
        'Every other panel here reports a measurement. This one reports a decision, with the evidence attached and the ' +
        'reason written so it can be repeated in a meeting.',
      bodyHtml: interventionFeed(ctx, t.interventions ?? [], { showTeam: false, id: `ivn-${t.key}` }),
    },
    {
      id: 'about',
      group: 'context',
      title: 'What this team is',
      tagHtml: tag('new', 'ORIENTATION'),
      lede: 'The same team named in Jira, in GitLab and in Confluence, with a route into each. Read this first if the board is unfamiliar.',
      bodyHtml: orientationPanel(ctx, t),
    },
    {
      id: 'sprint',
      group: 'decide',
      tone: outlookTone(t.outlook),
      title: 'Will this sprint land?',
      tagHtml: tag('sound', 'SOUND'),
      lede: '',
      bodyHtml: outlookPanel(t),
    },
    {
      id: 'board',
      group: 'flow',
      title: 'Where the work is sitting',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: "The active sprint laid out across the board's own columns, and who is holding what.",
      bodyHtml: wipPanel(ctx, t),
    },
    {
      id: 'workmix',
      group: 'flow',
      title: 'What kind of work is this?',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: '',
      bodyHtml: taxonomyPanel(ctx, t),
      collapsed: !t.taxonomy || t.taxonomy.issues === 0,
      ask: 'read its workMix and explain in plain business language what this team spends its time on, what the labels and components appear to mean, and whether the sprint mix differs from the backlog mix.',
    },
    {
      id: 'epics',
      group: 'flow',
      title: 'Epics',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: 'The larger pieces of work this sprint is advancing, and what is queued behind them.',
      bodyHtml: epicsPanel(ctx, t),
      collapsed: !t.epics || t.epics.rollups.length === 0,
      ask: 'read its epics and write a short business summary of each one - what it appears to deliver, for whom, and how far along it is. Say where the epic names are too terse to tell.',
    },
    {
      id: 'flagged',
      group: 'decide',
      title: 'Flagged as blocked',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: '',
      bodyHtml: flaggedPanel(ctx, t),
      collapsed: !t.flagged || t.flagged.total === 0,
      ask: 'read trouble.flaggedOpen and the flagged tickets, and tell me which of them I personally need to intervene on this week and who I should talk to for each.',
    },
    {
      id: 'blockers',
      group: 'decide',
      title: 'What is holding up what',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: '',
      bodyHtml: blockerPanel(ctx, t),
      collapsed: !t.blockers || t.blockers.length === 0,
      ask: 'read its blocker graph and tell me which single ticket, if unblocked, would free the most other work, and what unblocking it would take.',
    },
    {
      id: 'attention',
      group: 'decide',
      title: 'Work that needs you',
      tagHtml: tag('sound', 'SOUND'),
      lede: 'Open items in the active sprint that a manager can actually act on, most urgent first. Hover any ticket for its title, owner and latest comment.',
      bodyHtml: attentionTable(ctx, t.attention, 30, `attention-${t.key}`),
    },
    {
      id: 'discussion',
      group: 'people',
      title: 'What people are arguing about',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: '',
      bodyHtml: discussionPanel(ctx, t),
      collapsed: !t.discussed || t.discussed.length === 0,
      ask: 'read trouble.mostDiscussed, including the quoted comments, and tell me what each of those conversations is actually about and what decision would end it.',
    },
    {
      id: 'subtasks',
      group: 'flow',
      title: 'Tickets broken into subtasks',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('new', 'NEW')}`,
      lede: '',
      bodyHtml: subtaskPanel(ctx, t),
      collapsed: !t.subtasks || t.subtasks.parentsWithChildren === 0,
      ask: 'read its subtask structure and tell me which parent tickets are effectively finished but still open, and which large parents have not been started.',
    },
    {
      id: 'delivery',
      group: 'flow',
      title: 'Delivery over time',
      tagHtml: tag('sound', 'SOUND'),
      lede: '',
      bodyHtml: deliveryPanel(ctx, t),
      ask: 'read its velocity percentiles and sprint history and explain, without jargon, how predictable this team is and what commitment level would be realistic.',
    },
    {
      id: 'people',
      group: 'people',
      title: 'Team composition over time',
      tagHtml: `${tag('weak', 'WEAK')} ${tag('new', 'NEW')}`,
      lede: 'How many people delivered in each sprint, who they were, and when that changed. Read a velocity trend against this, never on its own.',
      bodyHtml: compositionPanel(t),
      collapsed: !t.composition || t.composition.sprints.length === 0,
      ask: 'read its composition series and tell me whether any velocity change lines up with a change in how many people were delivering.',
    },
    {
      id: 'roster',
      group: 'people',
      title: 'Who is on this board',
      tagHtml: `${tag('caveat', 'contact sheet, not a scorecard')} ${tag('new', 'NEW')}`,
      lede: '',
      bodyHtml: rosterPanel(ctx, t),
      collapsed: !t.roster || t.roster.members.length === 0,
      ask: 'read its people list and tell me who carries concentrated load, who reviews other people\'s work, and who appears in Jira but never in GitLab (and what that probably means). Do not rank anyone by output.',
    },
    {
      id: 'churn',
      group: 'flow',
      title: 'Scope churn & burndown',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('caveat', 'needs two collected days')}`,
      lede:
        'What changed about this sprint between collections &mdash; observed, not reconstructed. This is the sound ' +
        'replacement for the committed and carryover figures the rest of the report refuses to chart.',
      bodyHtml: churnPanel(ctx, t),
      collapsed: !t.history || t.history.days < 2,
    },
    {
      id: 'flow',
      group: 'flow',
      title: 'How work is flowing through the board',
      tagHtml: `${tag('weak', 'WEAK')} ${tag('caveat', 'needs two collected days')} ${tag('new', 'NEW')}`,
      lede:
        'The active sprint\'s work distributed across this board\'s own columns, on every collected day. ' +
        'A band that widens day over day is work arriving in a stage faster than it leaves — the thing ' +
        'neither the burndown nor the column-ageing panel can show, because one totals and the other is a snapshot.',
      bodyHtml: cfdPanel(ctx, t),
      collapsed: !t.history?.flow || t.history.flow.days.length < 2,
      ask: 'read its cumulative flow and tell me which column is accumulating work faster than it clears, and what that queue is waiting on.',
    },
    {
      id: 'ageing',
      group: 'flow',
      title: 'How long work sits in each column',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('caveat', 'bounded by when collection started')} ${tag('new', 'NEW')}`,
      lede:
        "The queue that is actually holding delivery up, walked from the column each ticket was recorded in on every " +
        'collected day &mdash; not from its last-updated timestamp, which resets when somebody merely comments.',
      bodyHtml: columnAgeingPanel(ctx, t),
      collapsed: !t.history || t.history.days < 2 || (t.history.columnDwell?.length ?? 0) === 0,
      ask: 'read its columnDwell figures and tell me which queue is the real constraint on this board, which specific tickets are stuck in it, and what a queue of that shape usually means.',
    },
    {
      id: 'cycle',
      group: 'flow',
      title: 'Cycle time',
      tagHtml: `${tag('sound', 'SOUND')} ${tag('caveat', 'bounded by when collection started')}`,
      lede: 'How long work takes once someone actually starts it, separated from how long it waited first.',
      bodyHtml: cyclePanel(ctx, t),
      collapsed: !t.history || t.history.days < 2,
    },
    {
      id: 'review',
      group: 'people',
      title: 'Code review practice',
      tagHtml: tag('caveat', 'training signal, not a ranking'),
      lede: 'The only leading indicator in this report: whether merged code was looked at by a second person.',
      bodyHtml: practicePanel(ctx, t),
    },
    {
      id: 'backlog',
      group: 'context',
      title: 'Backlog',
      tagHtml: tag('sound', 'SOUND'),
      lede: 'What is queued behind the active sprint, in the order the team ranked it.',
      bodyHtml: backlogPanel(ctx, t),
    },
    {
      id: 'context',
      group: 'context',
      title: 'Documentation & context',
      tagHtml: tag('new', 'CONFLUENCE'),
      lede: 'Where this team writes things down. Links only — always the live page, never a copy.',
      bodyHtml: contextPanel(ctx, t),
      collapsed: !t.confluence || t.confluence.pages.length === 0,
    },
    {
      id: 'slowest',
      group: 'flow',
      title: 'Longest to get through',
      tagHtml: tag('weak', 'WEAK'),
      lede: `Work resolved in the last ${ctx.windowDays} days, longest lead time first.`,
      bodyHtml: slowestPanel(ctx, t.slowest, ctx.windowDays),
      collapsed: true,
    },
    {
      id: 'trust',
      group: 'context',
      tone: highFindings.length > 0 || t.quality.collectionErrors.length > 0 ? 'poor' : 'good',
      title: 'Read these numbers with care',
      tagHtml: tag('caveat', 'DATA QUALITY'),
      lede: 'What is missing or contradictory in the underlying Jira data for this board.',
      bodyHtml:
        highFindings.length > 0 || t.quality.collectionErrors.length > 0
          ? `<ul class="caveats">${
              highFindings
                .map(
                  (f) =>
                    `<li><strong>${escapeHtml(f.code)}</strong>${f.outOf ? ` (${f.count} of ${f.outOf}, ${pct(f.count, f.outOf)})` : ` (${f.count})`} &mdash; ${escapeHtml(f.detail)}${
                      f.examples.length > 0 ? ` <span class="muted">e.g. ${f.examples.map((k) => ticket(ctx, { key: k })).join(' ')}</span>` : ''
                    }</li>`,
                )
                .join('') + t.quality.collectionErrors.map((e) => `<li><strong>collection</strong> &mdash; ${escapeHtml(e)}</li>`).join('')
            }</ul>`
          : `<p class="lede good-note">No high-severity data-quality findings on this board.</p>`,
      collapsed: highFindings.length === 0 && t.quality.collectionErrors.length === 0,
    },
  ];

  // The subnav, GROUPED. Worst tone in a group becomes the dot on its heading,
  // so the list says which group is worth opening rather than only listing what
  // exists. A group whose sections supply no tone gets no dot - absent, never
  // drawn as green, for the same reason "not measurable" is never drawn as zero
  // anywhere else on this page.
  const worst = (list: Section[]): HealthTone | null => {
    const order: HealthTone[] = ['poor', 'watch', 'unknown', 'good'];
    const tones = list.map((s) => s.tone).filter((x): x is HealthTone => Boolean(x));
    if (tones.length === 0) return null;
    return order.find((o) => tones.includes(o)) ?? null;
  };

  // Rule 4: sections that carry a finding new or escalated for THIS team since
  // the last collection. Eased and cleared changes are good news, not a reason
  // to open a section - only `new` and `escalated` land here. Unmapped kinds
  // are skipped rather than guessed at, per CHANGE_KIND_SECTION's own comment.
  const changedIds = new Set<string>(
    (changes?.changes ?? [])
      .filter((c) => c.team === t.key && (c.kind === 'new' || c.kind === 'escalated'))
      .map((c) => CHANGE_KIND_SECTION[c.intervention.kind])
      .filter((id): id is string => Boolean(id)),
  );

  // Sections that are collapsed by their own declaration for a reason OTHER
  // than emptiness - "deliberately downweighted", not "no data yet". Excluded
  // so the gist below never claims "not yet measured" about a section that may
  // well have rows.
  const ALWAYS_COLLAPSED_NOT_EMPTY = new Set(['slowest']);

  // Fold rules 2-4 over the emptiness-only `collapsed` every section literal
  // above already set (rule 1). `empty` is read BEFORE `needsReader` runs (it
  // is rule 1's own input) and BEFORE this loop overwrites `collapsed` with the
  // final open/closed state, so the gist can still tell "genuinely empty" apart
  // from "quiet by rule 5".
  for (const s of sections) {
    const empty = Boolean(s.collapsed) && !ALWAYS_COLLAPSED_NOT_EMPTY.has(s.id);
    s.collapsed = !needsReader(s, acts, changedIds);
    s.gist = empty ? 'not yet measured' : undefined;
  }

  // The floor: on a healthy board every section can legitimately close under
  // rules 1-4, and a panel that is two dozen one-line rows reads as broken
  // rather than as good news. `act`, `sprint` and `board` are the orientation
  // trio and open regardless; if fewer than three sections would be open in
  // total, the whole `decide` group opens rather than leaving a reader with
  // almost nothing to read.
  const FLOOR_ALWAYS_OPEN = new Set(['act', 'sprint', 'board']);
  for (const s of sections) {
    if (FLOOR_ALWAYS_OPEN.has(s.id)) s.collapsed = false;
  }
  if (sections.filter((s) => !s.collapsed).length < 3) {
    for (const s of sections) {
      if (s.group === 'decide') s.collapsed = false;
    }
  }

  const subnav = GROUP_ORDER.map((grp) => {
    const inGroup = sections.filter((s) => s.group === grp);
    if (inGroup.length === 0) return '';
    const dot = worst(inGroup);
    return `<div class="subnav-group">
      <div class="subnav-head">${escapeHtml(GROUP_LABEL[grp])}${
        dot ? ` <span class="dot ${dot}" title="${escapeAttr(verdictOf(dot))}"></span>` : ''
      }</div>
      ${inGroup
        .map(
          (s) =>
            `<a class="subnav-link" href="#view=teams&team=${escapeAttr(t.key)}&sec=${escapeAttr(s.id)}"
               data-sec-link="sec-${escapeAttr(t.key)}-${escapeAttr(s.id)}">${escapeHtml(s.title)}${
                 s.tone ? ` <span class="dot ${s.tone}" title="${escapeAttr(verdictOf(s.tone))}"></span>` : ''
               }</a>`,
        )
        .join('')}
    </div>`;
  }).join('');

  // Sections are emitted in GROUP order rather than declaration order, so the
  // page a reader scrolls matches the list they just read. Within a group the
  // declaration order is preserved.
  const ordered = GROUP_ORDER.flatMap((grp) => sections.filter((s) => s.group === grp));

  return `<div class="tabpanel" id="panel-${escapeAttr(t.key)}" role="tabpanel" aria-labelledby="tab-${escapeAttr(t.key)}" hidden>
    <section class="panel team-head" id="head-${escapeAttr(t.key)}" data-team-head="${escapeAttr(t.key)}">
      <h2>${escapeHtml(t.key)} <span class="muted">${escapeHtml(t.boardName ?? '')} &middot; ${link(boardUrl(ctx.site, t.boardId ?? t.trends.boardId), `board #${t.boardId ?? t.trends.boardId}`)}</span>
        <span class="prefix">${escapeHtml(t.prefix)}</span>
        <span class="dot ${t.health.headline}" title="${escapeAttr(verdictOf(t.health.headline))}"></span>
        <button type="button" class="btn btn-sm" data-md-team="${escapeAttr(t.key)}"
          title="Copy this team's panels as Markdown, so one board can be handed to somebody without regenerating the whole file.">Copy this team as Markdown</button></h2>
      <div class="kpis">
        ${kpi('Act on now', String(acts), `${(t.interventions ?? []).length} total suggestions`, acts > 0 ? 'poor' : 'good', 'Interventions where somebody is already stopped or a promise has already been missed.')}
        ${kpi('This sprint', outlookLabel(t.outlook), t.outlook?.endDate ? `ends ${escapeHtml(t.outlook.endDate.slice(0, 10))}` : 'no active sprint', outlookTone(t.outlook))}
        ${kpi('Committed', `${t.activeLoad.points} pts`, `${escapeHtml(v.label)} &middot; p90 ${fmt(pf.p90)}`, v.tone === 'over' ? 'poor' : v.tone === 'within' ? 'good' : 'unknown')}
        ${kpi('Blocked or stuck', String(blocked), 'flagged, dependency-blocked, or blocked in comments', blocked === 0 ? 'good' : 'poor', 'Counts three different signals: the Flagged field, a link to an open blocker, and blocker language in the latest comment. The last two are new — a team that never touches Flagged still writes it down.')}
        ${kpi('Merged unreviewed', rate(unrev), t.review ? `${t.review.mergedWithoutHumanReview} of ${t.review.mergedKnown} ${nouns(ctx).abbrMany}` : 'no GitLab group mapped', unrev === null ? 'unknown' : unrev >= 0.4 ? 'poor' : unrev >= 0.2 ? 'watch' : 'good')}
        ${kpi('Carried 3+ sprints', carry ? pct(carry.count, carry.outOf ?? carry.count) : '—', carry ? `${carry.count} of ${carry.outOf} open items` : 'none', carry && carry.outOf ? (carry.count / carry.outOf >= 0.5 ? 'poor' : carry.count / carry.outOf >= 0.25 ? 'watch' : 'good') : 'good')}
      </div>
      ${healthPanel(t.health)}
      <p class="lede">Sections that need you today are open. The rest are closed to one line and open on a click &mdash; nothing is hidden, and <strong>Expand all</strong> opens every one. A section is open because its reading is poor or worth watching, because it carries something to act on now, or because it changed since the last collection.</p>
      <div class="ivn-controls" data-lens-for="${escapeAttr(t.key)}">
        <button type="button" class="chip-btn" data-lens="needs">Only what needs me</button>
        <button type="button" class="chip-btn on" data-lens="all">Everything <span class="muted">${sections.length}</span></button>
      </div>
      <nav class="subnav" aria-label="Sections for ${escapeAttr(t.key)}">${subnav}</nav>
    </section>
    <!-- The condensed sticky bar. A SEPARATE element from the KPI row above
         rather than that row made sticky: a six-tile grid pinned to the top of
         the viewport eats a third of a laptop screen and the reader loses the
         panel they were reading to the thing reminding them what they were
         reading. This is one line - which board and how it reads - and
         client.ts reveals it once the real head has scrolled away. Hidden by
         default so it never appears without script. -->
    <div class="team-sticky" data-sticky-for="${escapeAttr(t.key)}" hidden>
      <strong>${escapeHtml(t.key)}</strong>
      <span class="muted">${escapeHtml(t.boardName ?? '')}</span>
      <span class="dot ${t.health.headline}"></span>
      <span class="sticky-kpi">${escapeHtml(outlookLabel(t.outlook))}</span>
      <span class="sticky-kpi">${t.activeLoad.points} pts · ${escapeHtml(v.label)}</span>
      ${acts > 0 ? `<span class="sticky-kpi poor">${acts} to act on now</span>` : ''}
      ${blocked > 0 ? `<span class="sticky-kpi poor">${blocked} blocked</span>` : ''}
      <a class="sticky-top" href="#head-${escapeAttr(t.key)}">back to the top of ${escapeHtml(t.key)}</a>
    </div>
    <!-- Shown by client.ts only when the lens hides every section - a reader
         who filters to "only what needs me" on a healthy board must be told the
         board is quiet, not left staring at an unexplained blank panel. Hidden
         by default so it never appears without script (the lens itself does
         nothing without script either). -->
    <p class="notyet" data-lens-empty-for="${escapeAttr(t.key)}" hidden><strong>Nothing on this board needs you today.</strong>
      No section is showing a poor or watch reading, nothing is at the act-now level, and nothing changed since the
      last collection. Switch to <strong>Everything</strong> to read the board anyway.</p>
    ${ordered.map((s) => sectionHtml(t.key, s)).join('')}
  </div>`;
}

// --- orientation & legend ---------------------------------------------------------

const HOW_TO_READ = (n: ReturnType<typeof nouns>) => `
<section class="panel orientation" id="how-to-read">
  <h2>New to this report? Start here.</h2>
  <p class="lede">Everything below is generated from dated snapshots of Jira and GitLab. No AI wrote any of it and no
    model computed any number in it &mdash; every figure is arithmetic over recorded facts, so it can be traced back to
    the ticket or the ${n.one} it came from. Hover anything underlined for a definition; click any ticket key to
    open it.</p>
  ${expander(
    'What a “team” means here, and what the numbers are measured against',
    `<dl class="explain">
      <dt>A team is a Jira board</dt>
      <dd>Not the Jira <em>Team</em> field, which is empty on every issue on this site, and not the project, which is too
        coarse &mdash; one project can host several boards, and one board can carry several projects' tickets.</dd>
      <dt>There is no target anywhere in this report</dt>
      <dd>Every expectation is the team's <strong>own recent history</strong>: the p10, p50 and p90 of what it has
        actually completed in its last dozen closed sprints. Nobody has to agree to a number for the comparison to be
        fair, and “you are committed above your own best-ever sprint” is a sentence that survives being argued with.</dd>
      <dt>Story points are never compared between teams</dt>
      <dd>Estimation culture differs wildly by board here &mdash; one board leaves 97% of its active sprint unestimated,
        another's median sprint is 51 points against a third's 28. A point on one board is not a point on another, and
        this report never adds them together.</dd>
      <dt>There is deliberately no per-person productivity figure</dt>
      <dd>Assignee is on every issue, so it could be computed. It would not survive being questioned: points measure the
        estimate rather than the difficulty or the value, and the person who spends a day unblocking two colleagues
        scores zero. What is measured instead is <em>practice</em> &mdash; who merges work with nobody looking at it,
        and who reviews other people's. Both are habits a conversation can change.</dd>
      <dt>Colour</dt>
      <dd><span class="swatch good"></span> healthy &middot; <span class="swatch watch"></span> worth watching &middot;
        <span class="swatch poor"></span> needs you &middot; <span class="swatch unknown"></span> not measurable.
        “Not measurable” is never drawn as zero: a burndown from one observation is a flat line, and a flat line is the
        picture of a sprint going perfectly.</dd>
    </dl>`,
    { open: false },
  )}
  ${expander(
    'How to use this in a meeting',
    `<ol class="steps">
      <li>Open <strong>Act on this</strong> at the top. It is ordered by urgency and every card says what to do, not just
        what is wrong.</li>
      <li>Use the <strong>Portfolio</strong> table to say which teams need you and which do not. Green means step back
        &mdash; that is a finding too, and it is the one that buys back your week.</li>
      <li>Go into a team's tab for the detail. <em>What this team is</em> orients anyone who has not seen the board;
        <em>Where the work is sitting</em> shows the queue that is actually holding things up.</li>
      <li>Quote figures with their basis. Every panel carries a SOUND / WEAK / UNUSABLE tag and every truncated list has
        an “open this in Jira” link, so nothing here has to be taken on trust.</li>
    </ol>`,
    { open: false },
  )}
</section>`;

const LEGEND = (n: ReturnType<typeof nouns>) => `
<section class="panel legend" id="legend">
  <h2>How to read the trust labels</h2>
  <dl>
    <dt>${tag('sound', 'SOUND')}</dt>
    <dd>Anchored to a fact recorded when it happened &mdash; a resolution date, a comment timestamp, a merge timestamp
      &mdash; and independent of current board state. Safe to plan or report on.</dd>
    <dt>${tag('weak', 'WEAK')}</dt>
    <dd>Directionally right but overstated in a known way. Lead time here is created&rarr;resolved, so it includes
      backlog dwell and is not cycle time. Team composition is another: the assignee is the assignee <em>now</em>.</dd>
    <dt>${tag('unusable', 'UNUSABLE')}</dt>
    <dd>Reconstructed from a single snapshot in a way that is provably wrong for closed sprints &mdash; an item in 16
      sprints counts as "committed" in all 16. Not charted anywhere here; the scope-churn panel is the sound
      replacement, and it needs consecutive daily snapshots.</dd>
    <dt>${tag('caveat', 'CAVEAT')}</dt>
    <dd>Sound, but only over a subset that survives a filter. Review latency is computed only over ${n.many} that
      got a human review, so it is quoted with its basis, never alone.</dd>
    <dt>${tag('new', 'NEW')}</dt>
    <dd>Added in this version: the intervention feed, board-column WIP, epic rollups, team composition over time,
      Confluence context, and the comment scan that finds blockers nobody flagged.</dd>
  </dl>
  <h3>Glossary</h3>
  <dl class="glossary">
    <dt>Story point</dt><dd>A relative size the team put on a ticket. It measures the estimate, not the hours and not the value.</dd>
    <dt>p10 / p50 / p90</dt><dd>Percentiles of what this team completed in its own recent closed sprints. p50 is the median &mdash; a typical sprint. p90 is close to its best ever. p10 is what to promise when a date must be kept.</dd>
    <dt>Spread</dt><dd>p90 minus p10, as a share of the median. Above 100% the band is wider than the median itself, so the median is not a planning number.</dd>
    <dt>Carryover</dt><dd>Work that has been in three or more sprints. Almost always means the item is too big or too vague, not that it is being worked badly.</dd>
    <dt>WIP</dt><dd>Work in progress &mdash; how much is started but not finished, at once. Parallel work does not finish faster; it finishes later, all at once.</dd>
    <dt>Cycle time</dt><dd>From the first day work was seen in progress to the day it was resolved. Excludes backlog dwell.</dd>
    <dt>Lead time</dt><dd>From created to resolved. Includes however long it sat in the backlog, which is usually most of it.</dd>
    <dt>Scope churn</dt><dd>Work added to, removed from, or re-estimated inside a sprint after it started. A 3 that becomes an 8 moved the commitment by 5 points without a ticket moving.</dd>
    <dt>Merged unreviewed</dt><dd>A ${n.one} that went in with no comment and no approval from anybody but its author. Counted only over ${n.many} a person opened.</dd>
    <dt>Epic</dt><dd>A larger piece of work several tickets belong to. The level at which “when will this be done” has an answer.</dd>
    <dt>Flagged</dt><dd>Jira's formal “this is blocked” marker. This report also looks for blocker language in comments, because most teams write it there and forget the flag.</dd>
  </dl>
  <p class="footnote" style="margin-top:14px">
    <strong>Why there is no points-per-person figure anywhere in this report.</strong> Assignee is on every issue, so it
    could be computed &mdash; but it would not survive being questioned. Estimation culture differs wildly by board,
    points measure the <em>estimate</em> rather than the difficulty or the value, and the person who spends a day
    unblocking two colleagues scores zero. What is measured instead is <em>practice</em>: who merges work with nobody
    looking at it, and who reviews other people's. Both are habits training can change, and neither ranks anyone at
    their job.
  </p>
</section>`;

// --- machine-readable payload -------------------------------------------------

const MACHINE_README = {
  what: 'The complete derived model behind this report. Every number was computed by the deterministic derive/insights/history/epics/flow/interventions layers from dated Jira and GitLab snapshots. No model computed any of it.',
  doNot: [
    'Do not compute new numbers from these fields and present them as measurements - state which field a figure came from.',
    'Do not quote any field listed under trustworthiness.unusable. It is present for completeness and is provably wrong.',
    'Do not compare story points across teams. Estimation culture differs by board; a point on one board is not a point on another.',
    'Do not derive a per-person productivity ranking. Points-per-person is deliberately absent and the reason is in trustworthiness.deliberatelyAbsent.',
    'Do not treat composition[].people as an attendance record. It is who is CURRENTLY assigned work that resolved in that sprint window.',
  ],
  trustworthiness: {
    sound: [
      'trends.sprints[].completedIssues / completedPoints - anchored to each issue resolutionDate falling inside that sprint window.',
      'review.* - comment, approval and merge timestamps are facts recorded when they happened.',
      'history.* - each figure is the difference between two records, each written on the day it was true.',
      'outlook, activeLoad, attention, wip, epics - all describe the board as it stands today, which is when it was captured.',
      'interventions[] - every figure quoted inside one was computed by another layer; the intervention only chooses what to raise.',
    ],
    weak: [
      'trends.sprints[].leadTimeDaysP50 / P90 and slowest[].leadTimeDays - these are CREATED to resolved, so they include backlog dwell. history.cycle is the same measurement without it.',
      'composition.* - the assignee is the assignee NOW, not at resolution time. Good enough for "did this team change size", not for "what did this person do".',
      'epics[].progress - a count of ISSUES on THIS BOARD. Work under the same epic on another board is invisible, so a rollup can read 100% while the epic is half finished.',
    ],
    unusable: [
      'trends.sprints[].committedIssues / committedPoints / carriedOut FOR CLOSED SPRINTS - they count every issue in that sprint NOW, so an item that passed through 16 sprints counts as committed in all 16. For the ACTIVE sprint both are accurate today. history.churn is the sound replacement.',
    ],
    caveats: [
      'review.hoursToFirstHumanReview* is computed only over merge requests that GOT a human review - a survivorship sample. Always quote it with hoursToFirstHumanReviewBasis.',
      'Every review RATE is over merge requests a person opened. Bot-authored ones are excluded and counted in review.automationAuthored. Widening that denominator roughly quadruples the apparent unreviewed rate and says nothing about the team.',
      'practice.reviewerIdentitiesUnknown true means reviewsGiven is UNKNOWN, not zero.',
      'A null anywhere in this payload means not measurable, never zero.',
      'history.cycle.censored counts work already in progress when collection began; its start is unobserved and it is excluded from the percentiles.',
      'interventions of kind "blocker-in-comments" come from substring matching on comment text. The matched quote travels with every one of them precisely so a false positive can be dismissed at a glance rather than believed.',
    ],
    deliberatelyAbsent:
      'There is no points-per-person figure. Estimation culture differs wildly by board, points measure the estimate rather than the difficulty or the value, and the person who spends a day unblocking two colleagues scores zero. What is measured instead is practice: who merges work with nobody looking at it, and who reviews other people. See docs/decisions.md.',
  },
};

function machineReadable(input: ReportInput): string {
  const payload = {
    generator: 'cadence report',
    readme: MACHINE_README,
    site: input.site,
    generatedAt: input.generatedAt,
    jiraDate: input.jiraDate,
    jiraCapturedAt: input.jiraCapturedAt,
    gitlabDate: input.gitlabDate ?? null,
    gitlabCapturedAt: input.gitlabCapturedAt ?? null,
    windowDays: input.windowDays ?? 30,
    teams: input.teams,
  };
  return `<script type="application/json" id="to-data">${jsonForScript(payload)}</script>`;
}

// --- entry point --------------------------------------------------------------

export function buildReport(input: ReportInput): string {
  const windowDays = input.windowDays ?? 30;
  const ctx: RenderContext = {
    site: input.site,
    gitlabOrigin: input.gitlabOrigin ?? '',
    windowDays,
    forge: input.forge ?? 'gitlab',
  };
  const groups = groupByPrefix(input.teams);
  const ordered = groups.flatMap((g) => g.teams);

  const charts: Record<string, ChartSpec> = { 'chart-portfolio': portfolioChart(input.teams) };
  for (const t of input.teams) {
    charts[`chart-delivery-${t.key}`] = deliveryChart(t, RECENT_SPRINTS);
    const pc = practiceChart(t.practice, 14, ctx.forge);
    if (pc && t.review) charts[`chart-practice-${t.key}`] = pc;
    const bc = t.history ? burndownChart(t.history) : null;
    if (bc) charts[`chart-burndown-${t.key}`] = bc;
    const fc = t.history ? cfdChart(t.history) : null;
    if (fc) charts[`chart-cfd-${t.key}`] = fc;
    const ac = t.history ? columnAgeingChart(t.history) : null;
    if (ac) charts[`chart-ageing-${t.key}`] = ac;
    const sc = t.history ? cycleScatterChart(t.history) : null;
    if (sc) charts[`chart-cycle-${t.key}`] = sc;
    const wc = t.wip ? wipChart(t.wip) : null;
    if (wc) charts[`chart-wip-${t.key}`] = wc;
    const ec = t.epics ? epicChart(t.epics) : null;
    if (ec) charts[`chart-epics-${t.key}`] = ec;
    const lc = t.review ? reviewLatencyChart(t.review) : null;
    if (lc) charts[`chart-latency-${t.key}`] = lc;
    const cc = t.composition ? compositionChart(t.composition) : null;
    if (cc) charts[`chart-composition-${t.key}`] = cc;
  }

  // The two estate-wide charts. Registered only when their view has something
  // to draw, so a single-board profile with no epics gets a panel that says so
  // rather than an empty axis.
  const ctl = input.people ? crossTeamLoadChart(input.people, input.teams.map((t) => t.key)) : null;
  if (ctl) charts['chart-crossteam'] = ctl;
  const eec = input.estateEpics ? estateEpicChart(input.estateEpics) : null;
  if (eec) charts['chart-estate-epics'] = eec;

  // The estate hierarchy as a server-rendered SVG. Empty string on a
  // single-board profile - a hierarchy diagram of one thing is a box - and the
  // section around it is then omitted rather than rendered empty.
  const org = orgChart(input);

  const allInterventions: Intervention[] = input.teams.flatMap((t) => t.interventions ?? []);
  const topInterventions = rankInterventions(allInterventions, 15);
  const actNow = allInterventions.filter((i) => i.severity === 'act-now').length;

  const tabs = ordered
    .map((t) => {
      const acts = (t.interventions ?? []).filter((i) => i.severity === 'act-now').length;
      return `<button class="tab" role="tab" id="tab-${escapeAttr(t.key)}" data-target="panel-${escapeAttr(t.key)}"
           aria-selected="false" aria-controls="panel-${escapeAttr(t.key)}" tabindex="-1">${escapeHtml(t.key)}
           <span class="muted">${escapeHtml(t.prefix)}</span>${acts > 0 ? `<span class="badge">${acts}</span>` : ''}<span class="dot ${t.health.headline}"></span></button>`;
    })
    .join('');

  const panels = ordered.map((t) => teamPanel(ctx, t, input.changes)).join('');

  const gitlabLine = input.gitlabDate
    ? `GitLab ${escapeHtml(input.gitlabDate)} &middot; ${windowDays}-day window`
    : 'no GitLab snapshot';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cadence — Delivery Command Centre</title>
<style>${CSS}</style>
<!-- GOTCHA: every team panel carries a hidden attribute in the markup so the tabs
     work the instant the page paints rather than after a flash of all the
     panels stacked. With scripting BLOCKED nothing ever removes it, so the whole
     report collapsed to the portfolio table while the noscript banner below
     claimed "all team sections are expanded" - on a locked-down corporate
     laptop, which is the deployment this file exists to satisfy. A <style>
     inside <noscript> is the only thing that fires exactly when the script does
     not. The same block opens every collapsed <details>, for the same reason:
     a summary the reader cannot expand is content that is simply gone. -->
<noscript><style>
  .tabpanel[hidden] { display:block !important; }
  .tabbar, .viewbar, .view-hint { display:none; }
  .tabpanel { border-top:1px solid var(--line); margin-top:18px; padding-top:6px; }
  details.expander > .expander-body { display:block !important; }
  .ivn-controls { display:none; }
  /* Every control below does nothing without script. A button that silently
     fails is worse than an absent one - the reader concludes the report is
     broken rather than that the feature needs JavaScript. */
  #search-open, .palette-backdrop, .team-sticky, [data-md-team] { display:none !important; }
  /* The subnav's group dots are honest without script, but its links point at
     "#view=teams&team=x&sec=y", which no script is there to parse. With every
     panel expanded onto one page the plain section anchors work, so the links
     are neutralised into plain text rather than left as dead ends. */
  .subnav-link { pointer-events:none; text-decoration:none; }
</style></noscript>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div>
      <h1>Delivery Command Centre</h1>
      <div class="sub">${escapeHtml(input.site)} &middot; Jira ${escapeHtml(input.jiraDate)} &middot; ${gitlabLine}</div>
    </div>
    <div class="stamp">
      <div class="toolbar">
        <button type="button" class="btn" id="search-open" title="Search every ticket, person, epic, board and panel in this file (Ctrl-K)">Search <kbd>Ctrl</kbd><kbd>K</kbd></button>
        <button type="button" class="btn" id="theme-toggle">Light theme</button>
        <button type="button" class="btn" id="expand-all">Expand all</button>
        <button type="button" class="btn" data-copy-from="triage-summary">Copy summary</button>
        <button type="button" class="btn" id="print-btn">Print</button>
      </div>
      <div style="margin-top:7px">generated ${escapeHtml(input.generatedAt)}<br/>captured ${escapeHtml(input.jiraCapturedAt)}</div>
    </div>
  </div>

  <noscript><span class="nojs">Scripting is disabled, so the charts, tabs, hover cards and ticket pop-ups are inactive.
    Every number they show is also written out as text below &mdash; all six views, every team section and every collapsed
    explainer are expanded onto one page, and hovering a ticket still shows its detail through the browser's own tooltip.</span></noscript>

  <!-- The freshness banner comes FIRST, above the hand-off banner and above the
       actions. A reader who is about to quote a figure needs to know the figure
       came from a snapshot older than the code before they read the figure, not
       after. Renders to nothing when the snapshot is current. -->
  ${freshnessBanner(input.schema)}

  ${briefingBanner(input)}

  ${HOW_TO_READ(nouns(ctx))}

  <!-- The top-level view rail. The page had grown to a stack of quite different
       readings - the estate-wide decisions, twenty sections per board for
       several boards, and the estate-wide rollups - and a reader opening it in a
       hurry had to scroll past all of it to reach the one panel they came for.
       Six views, each a different QUESTION rather than more evidence about the
       same one.
       "Across the estate" is selected in the MARKUP, not by the script, so the
       landing view paints without waiting for anything and the deliberate
       choice recorded in client.ts - that a plain load lands on a team-NEUTRAL
       view rather than on whichever board sorts first - is preserved: the team
       tabs inside the Teams view still start with none of them selected.
       TWO ELEMENTS: the outer .viewbar is the full-width band, the inner
       .viewrail is the control that carries role=tablist and data-tabs. -->
  <div class="viewbar">
   <div class="viewrail" role="tablist" data-tabs="view" aria-label="Report views">
    <button class="tab" role="tab" id="tab-view-estate" data-target="panel-view-estate"
      aria-selected="true" aria-controls="panel-view-estate" tabindex="0">Across the estate${
        actNow > 0 ? `<span class="badge">${actNow}</span>` : ''
      }</button>
    <button class="tab" role="tab" id="tab-view-teams" data-target="panel-view-teams"
      aria-selected="false" aria-controls="panel-view-teams" tabindex="-1">Teams <span class="muted">${input.teams.length}</span></button>
    <button class="tab" role="tab" id="tab-view-people" data-target="panel-view-people"
      aria-selected="false" aria-controls="panel-view-people" tabindex="-1">People${
        input.people ? ` <span class="muted">${input.people.people.length}</span>` : ''
      }${
        input.people && input.people.crossTeamActiveCount > 0
          ? `<span class="badge">${input.people.crossTeamActiveCount}</span>`
          : ''
      }</button>
    <button class="tab" role="tab" id="tab-view-epics" data-target="panel-view-epics"
      aria-selected="false" aria-controls="panel-view-epics" tabindex="-1">Epics${
        input.estateEpics ? ` <span class="muted">${input.estateEpics.epics.length}</span>` : ''
      }</button>
    <button class="tab" role="tab" id="tab-view-data" data-target="panel-view-data"
      aria-selected="false" aria-controls="panel-view-data" tabindex="-1">Data${
        input.schema?.stale ? '<span class="badge">stale</span>' : ''
      }</button>
    <button class="tab" role="tab" id="tab-view-mapping" data-target="panel-view-mapping"
      aria-selected="false" aria-controls="panel-view-mapping" tabindex="-1">Mapping</button>
   </div>
  </div>

  <div class="tabpanel" id="panel-view-estate" role="tabpanel" aria-labelledby="tab-view-estate">
    <section class="panel act-panel" id="act-on-this">
      <h2>Act on this ${tag('new', 'ACTIONS')}</h2>
      <p class="lede">${
        actNow > 0
          ? `<strong>${actNow} thing${actNow === 1 ? '' : 's'} across ${input.teams.length} teams where somebody is already stopped or a promise has already been missed.</strong>`
          : 'Nothing across the estate is at the “act now” level today.'
      }
        Every card names the action, not just the problem, and carries the evidence it was drawn from.</p>
      ${interventionFeed(ctx, topInterventions, { showTeam: true, id: 'ivn-all' })}
      ${explain(
        'A ranked list of decisions a manager can take today, assembled from signals across Jira and GitLab: flagged blockers, dependencies on work nobody scheduled, blocker language in comments that nobody flagged, work claimed but not moving, missed due dates, over-commitment, and review or merge-process gaps.',
        'Every other panel reports a measurement, and a measurement needs interpreting before anyone can act. This is the interpretation, with its evidence attached so it can be checked rather than believed.',
        'Work down from the top. “Act now” means the cost of waiting for the next standup is already being paid. If a card is wrong, the quote or the ticket underneath it will show that in one glance — which is why they are always shown.',
      )}
    </section>

    ${triageBanner(ctx, input.teams)}

    <section class="panel" id="since-collection">
      <h2>Since the last collection ${tag('sound', 'SOUND')} ${tag('new', 'NEW')}</h2>
      <p class="lede">What appeared, got worse, eased or cleared between the two most recent collected days. Everything
        else on this page is a picture of today; this is the part of it that is news.</p>
      ${changesPanel(ctx, input.changes)}
    </section>

    ${portfolioPanel(ctx, input.teams)}

    ${
      org
        ? `<section class="panel" id="org-shape"${ask(
            'describe the shape of this estate from the hierarchy - which group carries the most boards, and whether the boards inside a group look like one product or several unrelated ones.',
          )}>
      <h2>The shape of the estate ${tag('sound', 'STRUCTURE')}</h2>
      <p class="lede">Every other panel on this page is a measurement. This one is the <em>arrangement</em> &mdash;
        which boards belong to which project group, how many people hold work on each, and where the things needing
        action sit in that structure. A reader who has never seen this estate cannot read any figure below until
        they know this.</p>
      ${org}
      ${explain(
        'The three levels this report is organised around: the whole estate, the project-prefix groups the boards fall into, and the boards themselves. Each board box carries its overall reading, how many people hold open work on it, and how many things on it need acting on now.',
        "The grouping is not a label somebody typed - it is the Jira project prefix the board's issues actually carry, which is the same grouping the team tabs and the portfolio table are built from. So the diagram cannot drift out of step with the rest of the page.",
        'Click a board to open its tab. If two boards you think of as one product appear under different groups, that is a real finding about how the Jira projects are set up, not a drawing error.',
      )}
    </section>`
        : ''
    }

    <p class="view-hint">All views are below. The tabs need JavaScript; the content does not.</p>
  </div>

  <div class="tabpanel" id="panel-view-teams" role="tabpanel" aria-labelledby="tab-view-teams" hidden>
    <section class="panel">
      <h2>Teams</h2>
      <p class="lede">One tab per board. The dot shows that team's overall reading &mdash; green means every measured
        signal is healthy and you can leave them to it. A number badge is how many things on that team need acting on now.</p>
      <div class="tabbar" role="tablist" data-tabs="team">${tabs}</div>
      ${panels}
    </section>
  </div>

  <!-- People, Epics, Data and Mapping are estate-wide readings, and every one
       of them exists because the per-board panels structurally cannot answer
       its question - somebody on two boards is two roster rows that are never
       added, an epic split across two reads as finished on one, the trust
       question is scattered three places. See the header of report/estate.ts. -->
  <div class="tabpanel" id="panel-view-people" role="tabpanel" aria-labelledby="tab-view-people" hidden>
    <section class="panel" id="people-estate"${ask(
      'read the people rollup and tell me who is spread across the most boards, what that probably costs them, and which review pairings would help. Do not rank anyone by output.',
    )}>
      <h2>People across every board ${tag('caveat', 'contact sheet, not a scorecard')} ${tag('new', 'NEW')}</h2>
      <p class="lede">Each team's roster panel is computed for one board, so somebody working across two appears as
        two rows that are never added together. This is the only view that adds them &mdash; and it adds
        <em>counts of work held</em> and nothing else. There is no per-person productivity figure here, no rate,
        and no story points totalled across boards.</p>
      ${peoplePanel(ctx, input)}
    </section>
  </div>

  <div class="tabpanel" id="panel-view-epics" role="tabpanel" aria-labelledby="tab-view-epics" hidden>
    <section class="panel" id="epics-estate"${ask(
      'read the cross-board epic rollup and write a short business summary of the five with the most work left - what each appears to deliver, for whom, and where it is stuck.',
    )}>
      <h2>Epics across every board ${tag('weak', 'WEAK')} ${tag('new', 'NEW')}</h2>
      <p class="lede">An epic rollup on a team tab counts only the issues on <em>that</em> board, so an epic split
        across two can read as finished on one of them. Here the same epic key is one row, with every board it
        touches. Still bounded by what this profile collects: work under an epic on an uncollected board is
        invisible, which is why the tag says WEAK rather than SOUND.</p>
      ${estateEpicsPanel(ctx, input)}
    </section>
  </div>

  <div class="tabpanel" id="panel-view-data" role="tabpanel" aria-labelledby="tab-view-data" hidden>
    <section class="panel" id="data-provenance"${ask(
      'read the schema assessment and the data-quality findings and tell me which of them I should raise as a Jira configuration problem rather than with an individual team.',
    )}>
      <h2>Can you trust this file? ${tag('caveat', 'DATA QUALITY')} ${tag('new', 'NEW')}</h2>
      <p class="lede">Where this came from, whether the snapshot behind it can answer what the current code asks,
        and what is missing or contradictory underneath. Read it before quoting anything to somebody who will act
        on it.</p>
      ${dataPanel(ctx, input)}
    </section>
  </div>

  <div class="tabpanel" id="panel-view-mapping" role="tabpanel" aria-labelledby="tab-view-mapping" hidden>
    <section class="panel" id="mapping"${ask(
      'read the team descriptions and tell me, for each board, how confident the GitLab and Confluence mapping looks and what would strengthen the weakest one.',
    )}>
      <h2>What is joined to what ${tag('sound', 'PROVENANCE')} ${tag('new', 'NEW')}</h2>
      ${mappingPanel(ctx, input.teams)}
    </section>
  </div>

  ${LEGEND(nouns(ctx))}
  <footer>Cadence &middot; no AI, no runtime network, generated entirely from collected snapshots.</footer>
</div>

<!-- The search palette. This file's own Ctrl-F searches text inside HIDDEN tab
     panels and scrolls to nothing, so a reader searching for a ticket that IS
     in the report concludes it is not. This opens the right view and the right
     board first, then goes to the row. The index it searches is built by
     client.ts from the ALREADY-RENDERED DOM - it computes no figure and invents
     no row. Empty in the markup and filled on first open, because a search box
     that cannot search is worse than none on the scripting-blocked laptop this
     file targets - the noscript block hides it outright. -->
<div class="palette-backdrop" id="palette-backdrop" hidden>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Search this report">
    <input type="search" id="palette-input" placeholder="Search tickets, people, epics, panels&hellip;"
      autocomplete="off" spellcheck="false" aria-controls="palette-results">
    <div class="palette-hint">Enter opens the first result &middot; &uarr;&darr; to move &middot; Esc to close</div>
    <ul class="palette-results" id="palette-results" role="listbox"></ul>
  </div>
</div>

<div class="modal-backdrop" id="modal-backdrop"><div class="modal" id="modal-body" role="dialog" aria-modal="true"></div></div>
<div class="tipcard" id="tipcard" role="tooltip" aria-hidden="true"></div>

${briefingData(input)}
${input.embedData === false ? '' : machineReadable(input)}
<script>${chartJsSource()}</script>
<script>window.__TO_CHARTS__ = ${jsonForScript(charts)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
