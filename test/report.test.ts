import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeLoad,
  backlogSummary,
  buildReport,
  carryoverLeaders,
  escapeHtml,
  groupByPrefix,
  loadVerdict,
  projectPrefixes,
  shortSprintLabel,
  type ReportTeamInput,
} from '../src/report/index.js';
import type { IssueSnapshot, SprintSnapshot, TeamSnapshot } from '../src/types.js';
import type { TeamTrends } from '../src/derive.js';
import type { TeamQuality } from '../src/quality.js';
import type { ReviewMetrics } from '../src/review.js';
import { teamHealth } from '../src/insights.js';
import type { PracticeSummary, SprintOutlook } from '../src/insights.js';
import { summariseColumnDwell, type TeamHistory } from '../src/history.js';

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1',
    id: '1',
    issueType: 'Story',
    status: 'In Progress',
    statusCategory: 'In Progress',
    created: '2026-08-20T09:00:00.000Z',
    updated: '2026-08-31T09:00:00.000Z',
    storyPoints: 3,
    storyPointsField: 'customfield_10006',
    flagged: false,
    labels: [],
    components: [],
    sprintIds: [6145],
    links: [],
    inBacklog: false,
    ...over,
  };
}

const ACTIVE: SprintSnapshot = {
  id: 6145,
  name: 'Panther services 55',
  state: 'active',
  startDate: '2026-08-26T10:00:00.000Z',
  endDate: '2026-09-08T23:00:00.000Z',
};

function team(issues: IssueSnapshot[], sprints: SprintSnapshot[] = [ACTIVE]): TeamSnapshot {
  return { key: 'panther', boardId: 701, boardName: 'WEB Scrum', columns: [], sprints, issues, errors: [] };
}

// --- projectPrefixes ----------------------------------------------------------

test('projectPrefixes counts the issues on the board, most common first', () => {
  const t = team([
    issue({ key: 'PAY-1' }),
    issue({ key: 'PAY-2' }),
    issue({ key: 'CSP-9' }),
  ]);
  assert.deepEqual(projectPrefixes(t), [
    { key: 'PAY', count: 2 },
    { key: 'CSP', count: 1 },
  ]);
});

test('projectPrefixes reads the issues, NOT the board location', () => {
  // Live: board 703 is located in project OPS but every issue on it is
  // LOG-keyed - it is a mirror view of board 702. Trusting the board's own
  // projectKey would file it under the wrong prefix entirely.
  const mirror: TeamSnapshot = { ...team([issue({ key: 'LOG-1' }), issue({ key: 'LOG-2' })]), boardId: 703, boardName: 'Fleet Scrum Board' };
  assert.equal(projectPrefixes(mirror)[0]?.key, 'LOG');
});

test('projectPrefixes ignores a key with no dash', () => {
  assert.deepEqual(projectPrefixes(team([issue({ key: 'NODASH' })])), []);
});

// --- activeLoad ---------------------------------------------------------------

test('activeLoad dedupes an issue sitting in two concurrent active sprints', () => {
  // Live: board 705 'PAY & CSP' has SIX concurrent active sprints. Summing
  // per-sprint committed points would count a shared issue once per sprint.
  const a: SprintSnapshot = { id: 1, name: 'CSP App', state: 'active', startDate: '2026-08-01T00:00:00.000Z' };
  const b: SprintSnapshot = { id: 2, name: 'CSP service', state: 'active', startDate: '2026-08-02T00:00:00.000Z' };
  const t = team(
    [
      issue({ key: 'PAY-1', sprintIds: [1, 2], storyPoints: 5 }), // in BOTH
      issue({ key: 'PAY-2', sprintIds: [2], storyPoints: 3 }),
    ],
    [a, b],
  );
  const load = activeLoad(t);
  assert.equal(load.sprintCount, 2);
  assert.equal(load.issues, 2, 'the shared issue must be counted once');
  assert.equal(load.points, 8, 'not 13 - the 5-pointer is in two sprints');
  assert.deepEqual(load.sprintNames, ['CSP App', 'CSP service']);
});

test('activeLoad reports unestimated and already-resolved counts', () => {
  const t = team([
    issue({ key: 'A', storyPoints: 5 }),
    issue({ key: 'B', storyPoints: null, storyPointsField: null }),
    issue({ key: 'C', storyPoints: 2, statusCategory: 'Done' }),
  ]);
  const load = activeLoad(t);
  assert.equal(load.issues, 3);
  assert.equal(load.points, 7);
  assert.equal(load.unestimated, 1);
  assert.equal(load.resolved, 1);
});

test('activeLoad is all zeroes on a board with no active sprint', () => {
  const t = team([issue()], [{ id: 9, name: 'old', state: 'closed' }]);
  const load = activeLoad(t);
  assert.equal(load.sprintCount, 0);
  assert.equal(load.issues, 0);
  assert.equal(load.points, 0);
});

// --- loadVerdict --------------------------------------------------------------

const load = (over: Partial<import('../src/report/index.js').ActiveLoad> = {}) => ({
  sprintCount: 1, sprintNames: ['s'], issues: 10, points: 50, unestimated: 0, resolved: 0, ...over,
});

test('loadVerdict withholds "within band" when the sprint is mostly unestimated', () => {
  // Live: board 705 has 149 of 154 active issues unestimated, so its 27
  // committed points are five issues' worth. A green "within band" against a
  // p90 of 104.8 would be the most misleading cell on the page.
  const v = loadVerdict(load({ issues: 154, unestimated: 149, points: 27 }), 104.8);
  assert.equal(v.tone, 'unknown');
  assert.equal(v.label, 'not comparable');
});

test('loadVerdict still reports over-p90 when estimates are missing', () => {
  // A partial count that ALREADY exceeds the p90 is a valid lower bound, so the
  // warning is kept even though the basis is incomplete.
  const v = loadVerdict(load({ issues: 100, unestimated: 90, points: 200 }), 104.8);
  assert.equal(v.tone, 'over');
});

test('loadVerdict says within band only when the sprint is well estimated', () => {
  assert.deepEqual(loadVerdict(load({ issues: 10, unestimated: 0, points: 50 }), 104.8), { tone: 'within', label: 'within band' });
  // Exactly at the two-thirds coverage threshold still counts as comparable.
  assert.equal(loadVerdict(load({ issues: 9, unestimated: 3, points: 50 }), 104.8).tone, 'within');
});

test('loadVerdict copes with no active sprint and no forecast', () => {
  assert.equal(loadVerdict(load({ sprintCount: 0 }), 100).label, 'no active sprint');
  assert.equal(loadVerdict(load(), null).label, 'no forecast');
});

// --- shortSprintLabel ---------------------------------------------------------

test('shortSprintLabel takes the trailing token for a chart axis', () => {
  assert.equal(shortSprintLabel('Core Sprint - 2026 S17'), 'S17');
  assert.equal(shortSprintLabel('onboarding-hub B# Sprint 61'), '61');
  assert.equal(shortSprintLabel('Panther services 55'), '55');
  assert.equal(shortSprintLabel('Vulnerabilities'), 'Vulnerab');
});

// --- carryoverLeaders ---------------------------------------------------------

test('carryoverLeaders ranks worst-first and excludes done issues', () => {
  const t = team([
    issue({ key: 'A', sprintIds: [1, 2, 3, 4, 5, 6, 6145] }),
    issue({ key: 'B', sprintIds: [1, 6145] }),
    issue({ key: 'C', sprintIds: [1, 2, 3, 6145], statusCategory: 'Done' }),
    issue({ key: 'D', sprintIds: [1, 2, 3, 6145] }),
  ]);
  assert.deepEqual(carryoverLeaders(t), [
    { key: 'A', sprintCount: 7, summary: undefined },
    { key: 'D', sprintCount: 4, summary: undefined },
  ]);
});

test('carryoverLeaders respects the limit and returns [] with no active sprint', () => {
  const many = Array.from({ length: 10 }, (_, i) => issue({ key: `K${i}`, sprintIds: [1, 2, 3, 6145] }));
  assert.equal(carryoverLeaders(team(many), 3).length, 3);
  assert.deepEqual(carryoverLeaders(team([], [])), []);
});

// --- escapeHtml ---------------------------------------------------------------

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`R&D "quotes" 'single'`), 'R&amp;D &quot;quotes&quot; &#39;single&#39;');
});

// --- buildReport --------------------------------------------------------------

function trends(over: Partial<TeamTrends> = {}): TeamTrends {
  return {
    team: 'panther',
    boardId: 701,
    boardName: 'WEB Scrum',
    approximate: true,
    sprints: [
      {
        id: 1, name: 'Panther services 53', state: 'closed',
        committedIssues: 20, committedPoints: 60, completedIssues: 9, completedPoints: 24,
        unestimatedCommitted: 0, carriedOut: 3, leadTimeDaysP50: null, leadTimeDaysP90: null,
        daysLate: 0.5, completedByType: {},
      },
      {
        id: 2, name: 'Panther services 54', state: 'closed',
        committedIssues: 22, committedPoints: 70, completedIssues: 11, completedPoints: 32,
        unestimatedCommitted: 0, carriedOut: 4, leadTimeDaysP50: null, leadTimeDaysP90: null,
        daysLate: 1, completedByType: {},
      },
      {
        id: 3, name: 'Panther services 55', state: 'active',
        committedIssues: 50, committedPoints: 198, completedIssues: 0, completedPoints: 0,
        unestimatedCommitted: 12, carriedOut: 0, leadTimeDaysP50: null, leadTimeDaysP90: null,
        daysLate: null, completedByType: {},
      },
    ],
    pointsForecast: { basis: 12, p10: 19.1, p50: 28.0, p90: 107.8, relativeSpread: 3.17 },
    issuesForecast: { basis: 12, p10: 5, p50: 8, p90: 20, relativeSpread: 1.9 },
    carryoverRateMedian: 0.3,
    ...over,
  };
}

function quality(over: Partial<TeamQuality> = {}): TeamQuality {
  return {
    team: 'panther',
    boardId: 701,
    boardName: 'WEB Scrum',
    counts: { issues: 100, inActiveSprint: 73, inBacklog: 10, everInASprint: 90 },
    findings: [
      { code: 'carried-three-plus-sprints', severity: 'high', count: 44, outOf: 73, detail: 'x', examples: [] },
    ],
    collectionErrors: [],
    ...over,
  };
}

function review(over: Partial<ReviewMetrics> = {}): ReviewMetrics {
  return {
    team: 'panther', groups: ['web-storefront'],
    totalMergeRequests: 329, automationAuthored: 250, humanAuthoredTotal: 79,
    merged: 72, open: 5, closedUnmerged: 2, draft: 0,
    reviewDetailKnown: 79, humanReviewed: 31, automatedReviewed: 70,
    mergedKnown: 72, mergedWithoutHumanReview: 43, mergedWithNoHumanInvolvement: 43,
    hoursToFirstHumanReviewP50: 20, hoursToFirstHumanReviewP90: 42, hoursToFirstHumanReviewBasis: 30,
    hoursToFirstAutomatedReviewP50: 0.2, hoursToFirstAutomatedReviewBasis: 79,
    hoursOpenToMergeP50: 17, hoursOpenToMergeP90: 40, hoursOpenToMergeBasis: 72,
    hoursApprovalToMergeP50: 3, hoursApprovalToMergeP90: 11, hoursApprovalToMergeBasis: 29,
    approvedAfterMerge: 0,
    awaitingFirstHumanReview: [],
    latencyBuckets: [], neverHumanReviewed: 0,
    withIssueKey: 19,
    ...over,
  };
}

const emptyPractice = (): PracticeSummary => ({ people: [], reviewerIdentitiesUnknown: false });

function baseTeam(over: Partial<ReportTeamInput> = {}): ReportTeamInput {
  return {
    key: 'panther',
    boardName: 'WEB Scrum',
    prefix: 'WEB',
    trends: trends(),
    quality: quality(),
    activeLoad: { sprintCount: 1, sprintNames: ['Panther services 55'], issues: 73, points: 198, unestimated: 12, resolved: 0 },
    attention: [],
    practice: emptyPractice(),
    outlook: null,
    health: teamHealth({ unreviewedRate: 0.6, carryoverRate: 0.6, unestimatedRate: 0.16, relativeSpread: 3.17, outlook: null }),
    slowest: [],
    carryoverLeaders: [
      { key: 'WEB-100', sprintCount: 16 },
      { key: 'WEB-101', sprintCount: 16 },
    ],
    review: review(),
    ...over,
  };
}

const BASE_INPUT = {
  site: 'acme.atlassian.net',
  generatedAt: '2026-08-26T12:00:00.000Z',
  jiraDate: '2026-08-26',
  jiraCapturedAt: '2026-08-26T07:00:00.000Z',
};

// --- groupByPrefix ------------------------------------------------------------

test('groupByPrefix groups teams under their board prefix, biggest group first', () => {
  const a = baseTeam({ key: 'a', prefix: 'LOG' });
  const b = baseTeam({ key: 'b', prefix: 'WEB' });
  const c = baseTeam({ key: 'c', prefix: 'LOG' });
  const groups = groupByPrefix([a, b, c]);
  assert.deepEqual(groups.map((g: { prefix: string }) => g.prefix), ['LOG', 'WEB']);
  assert.deepEqual(groups[0]!.teams.map((t: ReportTeamInput) => t.key), ['a', 'c']);
});


// --- rendering ----------------------------------------------------------------

/** The chart specs are embedded as JSON in a script tag. Pulling them back out
 *  is how these tests check WHICH numbers were charted, rather than trusting
 *  that a canvas somewhere got the right ones. */
function charts(html: string): Record<string, any> {
  const m = /window\.__TO_CHARTS__ = (\{[\s\S]*?\});<\/script>/.exec(html);
  assert.ok(m, 'chart payload should be embedded');
  return JSON.parse(m![1]!);
}

test('buildReport surfaces the headline numbers and the over-p90 warning', () => {
  const html = buildReport({ ...BASE_INPUT, gitlabDate: '2026-08-26', gitlabCapturedAt: 'x', teams: [baseTeam()] });

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /198 pts/);
  assert.match(html, /107\.8/);
  assert.match(html, /43 of 72/);
  assert.match(html, /over p90/);
  assert.match(html, /more points than they delivered in any closed sprint/i);
});

test('the report is self-contained: no external fetch of any kind', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  // The whole point of the format - it has to open from file:// on a locked
  // down laptop. Chart.js is inlined, not linked.
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  // Nothing may be LOADED from a remote host. Checked per-attribute rather than
  // on the raw text because the inlined Chart.js carries its project URL in a
  // licence comment, and a URL in a comment fetches nothing.
  //
  // GOTCHA: `href` is deliberately NOT in this list, and the distinction is the
  // whole reason the test is written this way. Every ticket key, board, GitLab
  // group and Confluence page in this report is now an <a href> to the live
  // system - that is the feature that makes the page legible to somebody who
  // does not already know the estate, and it fetches nothing until a person
  // clicks it. A rule that bans every remote URL bans that too, and the
  // difference between "loads a remote resource" and "offers a link" is exactly
  // what "self-contained" means here.
  assert.doesNotMatch(html, /(?:src|action|srcset|data|poster)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket/);
  assert.match(html, /Chart/);
});

test('external links open in a new tab and cannot reach back into this page', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  const anchors = html.match(/<a\b[^>]*href\s*=\s*["']https?:[^>]*>/gi) ?? [];
  assert.ok(anchors.length > 0, 'the report should link out to Jira and GitLab');
  for (const a of anchors) {
    // target=_blank without rel=noopener hands the opened page a handle on this
    // one via window.opener. Modern browsers imply noopener, older corporate
    // ones do not, and this file is built for the older corporate one.
    assert.match(a, /target="_blank"/, `missing target on ${a}`);
    assert.match(a, /rel="noopener noreferrer"/, `missing rel on ${a}`);
  }
});

test('the delivery chart plots completed points, never committed', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  const spec = charts(html)['chart-delivery-panther'];
  const bars = spec.data.datasets[0].data;
  // The two closed sprints COMPLETED 24 and 32 points; they were COMMITTED 60
  // and 70. Charting committed for a closed sprint is the UNUSABLE metric.
  assert.deepEqual(bars.slice(0, 2), [24, 32]);
  assert.ok(!bars.includes(60) && !bars.includes(70), 'committed totals must not be charted');
  // The active sprint IS charted, as committed-not-delivered, in its own colour.
  assert.equal(bars[2], 198);
  assert.notEqual(spec.data.datasets[0].backgroundColor[2], spec.data.datasets[0].backgroundColor[0]);
  // p50 and p90 reference lines are drawn across.
  const lines = spec.data.datasets.filter((d: any) => d.type === 'line');
  assert.equal(lines.length, 2);
});

test('a board with several concurrent active sprints names them all', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [
      baseTeam({
        key: 'fs', prefix: 'PAY',
        activeLoad: {
          sprintCount: 6,
          sprintNames: ['Vulnerabilities', 'CSP App', 'PayGateway sprint 3', 'Click to Pay sprint 3', 'CSP service', 'Backlog sprint'],
          issues: 120, points: 210, unestimated: 30, resolved: 5,
        },
        quality: quality({
          findings: [{ code: 'multiple-active-sprints', severity: 'high', count: 6, detail: 'Board has 6 active sprints', examples: [] }],
        }),
      }),
    ],
  });
  assert.match(html, /6 sprints|6 concurrent/);
  assert.match(html, /multiple-active-sprints/);
});

test('the portfolio table lists every team and flags the overloaded ones', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [
      baseTeam({ key: 'panther', prefix: 'WEB' }),
      baseTeam({
        key: 'tran', prefix: 'LOG', review: undefined,
        activeLoad: { sprintCount: 1, sprintNames: ['Core Sprint - 2026 S17'], issues: 10, points: 5, unestimated: 0, resolved: 1 },
      }),
    ],
  });
  assert.match(html, /Portfolio/);
  assert.match(html, /id="panel-panther"/);
  assert.match(html, /id="panel-tran"/);
  assert.match(html, /1 of 2/);
  assert.match(html, /over p90/);
  assert.match(html, /within band/);
  assert.match(html, /no GitLab group is mapped/i);
});

test('a mostly-unestimated sprint never renders as reassuringly within band', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [
      baseTeam({
        key: 'fs', prefix: 'PAY', review: undefined,
        // Board 705's real shape: 154 active issues, 149 with no estimate.
        activeLoad: { sprintCount: 6, sprintNames: ['Vulnerabilities'], issues: 154, points: 27, unestimated: 149, resolved: 16 },
        trends: trends({ pointsForecast: { basis: 12, p10: 12, p50: 12, p90: 104.8, relativeSpread: 7.7 } }),
      }),
    ],
  });
  assert.match(html, /not comparable/);
  // The verdict CELL must never read green here. ("within band" still appears
  // in the footnote explaining the verdict - that is the legend, not a claim
  // about this team - so the assertion targets the cell.)
  assert.doesNotMatch(html, /<td class="num good">/);
  assert.match(html, /not<\/strong> spare\s*\n?\s*capacity|not comparable/);
});

test('buildReport escapes a hostile board name and a hostile ticket key', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [
      baseTeam({
        boardName: '<img src=x onerror=alert(1)>',
        attention: [{
          key: '<script>alert(1)</script>', summaryType: 'Bug', status: 'Open', assignee: '"><b>x</b>',
          sprintCount: 4, ageDays: 30, idleDays: 12, storyPoints: null, reasons: ['blocked'], weight: 100,
        }],
      }),
    ],
  });
  // GOTCHA: the assertion is against the RENDERED markup with the embedded
  // machine-readable island stripped out, and that distinction is the whole
  // point. Inside <script type="application/json"> the browser does not parse
  // HTML at all, so a raw "<img src=x onerror=...>" there is inert text - the
  // one and only way out of that block is a literal "</script", which
  // jsonForScript neutralises and the next test pins down. Asserting over the
  // whole file instead would force the payload to be HTML-escaped too, which
  // would corrupt it as JSON for no security gain.
  // GOTCHA: the `g` flag is load-bearing. There are now TWO application/json
  // islands - the full model (#to-data) and the briefing digest (#to-brief) -
  // and a non-global replace strips only the first, leaving the second's inert
  // JSON text to fail the assertion below as if it were a live XSS. It is not:
  // the reasoning in the comment above applies identically to both blocks.
  const rendered = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(rendered, /<img src=x/);
  assert.match(rendered, /&lt;img src=x/);
  // The ticket key reaches the page twice - as a table cell AND inside the
  // URI-encoded modal payload - and must be safe in both.
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>/);
});

test('with scripting blocked every team panel is still readable', () => {
  // The regression this exists for: panels carry `hidden` in the markup so the
  // tabs work the instant the page paints. Nothing removed it when scripting was
  // blocked, so the whole report collapsed to the portfolio table while the
  // noscript banner claimed "all team sections are expanded" - on the
  // locked-down laptop this file exists to open on.
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  const noscriptStyle = /<noscript><style>([\s\S]*?)<\/style><\/noscript>/.exec(html);
  assert.ok(noscriptStyle, 'expected a <noscript><style> block to un-hide the panels');
  assert.match(noscriptStyle![1]!, /\.tabpanel\[hidden\]\s*\{\s*display:block\s*!important/);
  // ...and the tab strip has to go with it, or it reads as broken controls -
  // both levels of it now: the per-board bar and the top-level view rail.
  assert.match(noscriptStyle![1]!, /\.tabbar[^}]*\{\s*display:none/);
  assert.match(noscriptStyle![1]!, /\.viewbar[^}]*\{\s*display:none/);
});

test('a hostile board name cannot break out of the embedded data island', () => {
  // The escape hatch a JSON island DOES have. If "</script" survived verbatim
  // the block would end early, the rest of the payload would land in the page as
  // text, and whatever followed it would be parsed as markup.
  const html = buildReport({
    ...BASE_INPUT,
    teams: [baseTeam({ boardName: '</script><img src=x onerror=alert(1)>' })],
  });
  assert.equal((html.match(/<script type="application\/json" id="to-data">/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<\/script><img src=x/);
  assert.match(html, /<\\\/script/);
});

test('--no-embed-data omits the machine-readable island entirely', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()], embedData: false });
  assert.doesNotMatch(html, /application\/json/);
  // ...and the human report is unaffected.
  assert.match(html, /Delivery Command Centre/);
});

test('the embedded payload carries the trustworthiness contract, not just numbers', () => {
  // A JSON blob strips every visual cue - the SOUND/WEAK/UNUSABLE tags, the
  // footnotes, the withheld verdicts. A reader that only sees numbers would
  // happily quote committedIssues for a closed sprint, which this codebase knows
  // to be wrong by a factor of ten. The labels have to be fields, not decoration.
  const input = { ...BASE_INPUT, teams: [baseTeam()] };
  const html = buildReport(input);
  const island = /<script type="application\/json" id="to-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(island, 'expected an embedded data island');
  const data = JSON.parse(island![1]!);
  assert.ok(Array.isArray(data.readme.trustworthiness.unusable));
  assert.match(data.readme.trustworthiness.unusable.join(' '), /committedIssues/);
  assert.match(data.readme.trustworthiness.weak.join(' '), /leadTimeDays/);
  assert.ok(data.readme.doNot.length > 0);
  assert.equal(data.teams.length, input.teams.length);
});

test('buildReport handles a team with no carryover finding', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [baseTeam({ quality: quality({ findings: [] }), carryoverLeaders: [] })],
  });
  assert.match(html, /<!doctype html>/i);
});

test('buildReport copes with a team that has no closed sprints at all', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [
      baseTeam({
        trends: trends({ sprints: [], pointsForecast: { basis: 0, p10: null, p50: null, p90: null, relativeSpread: null } }),
        activeLoad: { sprintCount: 0, sprintNames: [], issues: 0, points: 0, unestimated: 0, resolved: 0 },
        outlook: null,
      }),
    ],
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /no active sprint/i);
});

test('an empty attention list reads as the good outcome, not as a blank table', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam({ attention: [] })] });
  assert.match(html, /Nothing in the active sprint is blocked, stale or long-carried/);
});


// --- backlogSummary ------------------------------------------------------------

const BACKLOG_NOW = new Date('2026-09-01T00:00:00.000Z');

function backlogIssue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: 'WEB-1', id: '1', issueType: 'Story', status: 'To Do', statusCategory: 'To Do',
    created: '2026-08-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
    storyPoints: 3, storyPointsField: 'customfield_10006', flagged: false, labels: [],
    components: [], sprintIds: [], links: [], inBacklog: true, ...over,
  };
}

function backlogTeam(issues: IssueSnapshot[]): TeamSnapshot {
  return { key: 't', boardId: 1, columns: [], sprints: [], issues, errors: [] };
}

test('backlogSummary counts only open work sitting on the backlog', () => {
  const t = backlogTeam([
    backlogIssue({ key: 'A' }),
    backlogIssue({ key: 'B', statusCategory: 'Done' }),   // done - not queued work
    backlogIssue({ key: 'C', inBacklog: false }),          // in a sprint already
  ]);
  const b = backlogSummary(t, BACKLOG_NOW);
  assert.equal(b.issues, 1);
  assert.equal(b.points, 3);
});

test('"next up" follows board rank, not age or key order', () => {
  // GOTCHA under test: rank is the only field that reflects the order the team
  // put them in, and it is what actually gets pulled. Age order shows the items
  // nobody wants, which is the exact opposite.
  const t = backlogTeam([
    backlogIssue({ key: 'OLD', rank: '0|zzzzzz:', created: '2020-01-01T00:00:00.000Z' }),
    backlogIssue({ key: 'NEXT', rank: '0|aaaaaa:', created: '2026-08-30T00:00:00.000Z' }),
  ]);
  assert.deepEqual(backlogSummary(t, BACKLOG_NOW).nextUp.map((i) => i.key), ['NEXT', 'OLD']);
});

test('an unranked backlog item sorts last, because absent is not top of the list', () => {
  const t = backlogTeam([
    backlogIssue({ key: 'NORANK' }),
    backlogIssue({ key: 'RANKED', rank: '0|mmmmmm:' }),
  ]);
  assert.deepEqual(backlogSummary(t, BACKLOG_NOW).nextUp.map((i) => i.key), ['RANKED', 'NORANK']);
});

test('backlogSummary reports estimate coverage and the stale tail', () => {
  const t = backlogTeam([
    backlogIssue({ key: 'A', storyPoints: null, created: '2020-01-01T00:00:00.000Z' }),
    backlogIssue({ key: 'B', storyPoints: 5, created: '2026-08-30T00:00:00.000Z' }),
  ]);
  const b = backlogSummary(t, BACKLOG_NOW);
  assert.equal(b.unestimated, 1);
  assert.equal(b.points, 5);
  assert.equal(b.olderThan90Days, 1);
  assert.ok(b.medianAgeDays !== null);
});

test('an empty backlog reports zeroes and a null age, never a made-up median', () => {
  const b = backlogSummary(backlogTeam([]), BACKLOG_NOW);
  assert.equal(b.issues, 0);
  assert.equal(b.medianAgeDays, null);
  assert.deepEqual(b.nextUp, []);
});

// --- the hand-off layer -------------------------------------------------------

/** Pulls one embedded JSON island back out of the rendered page. */
function island(html: string, id: string): string | null {
  const marker = `id="${id}">`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  return html.slice(from, html.indexOf('</script>', from));
}

test('the briefing digest grows far more slowly than the full per-ticket model', () => {
  // The whole economic argument for the hand-off layer is that a narrative can
  // be written from the digest instead of from #to-data.
  //
  // GOTCHA: this is asserted as a GROWTH property, not as a size ratio on one
  // report, and the difference matters. The digest carries a fixed overhead of
  // roughly 11 KB - the five prompts and the rules block - which on a two-ticket
  // synthetic fixture makes it LARGER than the model it summarises. The ratio
  // that holds on the real estate (70 KB against 2.1 MB) is a consequence of the
  // digest being flat in ticket count while the model is linear in it. So the
  // test adds tickets and checks that only one side moves.
  const big = Array.from({ length: 300 }, (_, i) => ({
    key: `WEB-${i}`, summaryType: 'Story', status: 'In Development', assignee: 'Dev One',
    sprintCount: 3, ageDays: 40, idleDays: 12, storyPoints: 3, reasons: ['stale' as const], weight: 10,
  }));
  const small = buildReport({ ...BASE_INPUT, teams: [baseTeam({ attention: [] })] });
  const large = buildReport({ ...BASE_INPUT, teams: [baseTeam({ attention: big })] });

  const digestGrowth = island(large, 'to-brief')!.length - island(small, 'to-brief')!.length;
  const modelGrowth = island(large, 'to-data')!.length - island(small, 'to-data')!.length;
  assert.ok(modelGrowth > 20_000, `the model must actually grow with tickets (grew ${modelGrowth})`);
  assert.ok(
    digestGrowth < modelGrowth / 10,
    `digest grew ${digestGrowth} for a model that grew ${modelGrowth} - the digest is carrying per-ticket data`,
  );
});

test('the digest names every team and never carries a full ticket list', () => {
  const html = buildReport({
    ...BASE_INPUT,
    teams: [baseTeam({ key: 'panther' }), baseTeam({ key: 'tran', prefix: 'LOG' })],
  });
  const parsed = JSON.parse(island(html, 'to-brief')!);
  assert.deepEqual(parsed.teams.map((t: { key: string }) => t.key), ['panther', 'tran']);
  // `attention` is the biggest per-ticket array in the model. It must not have
  // been copied wholesale into the cheap island.
  assert.equal(parsed.teams[0].attention, undefined);
});

test('every offered prompt carries the trustworthiness rules with it', () => {
  // A guardrail that lives only in a JSON block the reader did not paste is not
  // a guardrail. The prompt text has to be safe to use entirely on its own.
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  const parsed = JSON.parse(island(html, 'to-brief')!);
  assert.ok(parsed.prompts.length >= 3);
  for (const p of parsed.prompts) {
    assert.match(p.text, /committedPoints/, `prompt "${p.id}" must warn about closed-sprint commitment figures`);
    assert.match(p.text, /never build a per-person productivity ranking/i, `prompt "${p.id}" must forbid ranking people`);
    assert.match(p.text, /to-brief/, `prompt "${p.id}" must point at the cheap island first`);
  }
});

test('--no-embed-data suppresses the briefing digest as well as the full model', () => {
  // The digest is smaller but not less sensitive: it carries people's names,
  // their current load and verbatim comment text. Somebody who asked for data
  // not to be embedded asked for it to be OUT of the file, not smaller.
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()], embedData: false });
  assert.equal(island(html, 'to-brief'), null);
  assert.equal(island(html, 'to-data'), null);
  assert.doesNotMatch(html, /application\/json/);
  // ...and the banner has to say so rather than offering buttons that do nothing.
  assert.match(html, /no machine-readable data is/i);
});

test('the banner reports the two payload sizes as measured, not as prose', () => {
  // "a few kilobytes" was written into this banner when the digest held four
  // fields and was wrong by an order of magnitude three commits later.
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  assert.match(html, /<strong>\d+(\.\d+)? [KM]B<\/strong>/);
});

test('each detail panel carries its own scoped question for the hand-off', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam()] });
  assert.match(html, /data-ask="/);
  // The question must name the team it is about, or pasting it loses the scope.
  assert.match(html, /About team &quot;panther&quot;/);
});

// --- the column-ageing panel ----------------------------------------------------
//
// Open item 21: `columnDwellNow`/`summariseColumnDwell` shipped tested and in the
// CLI, and was deliberately left out of the report. These cover the wiring, and
// in particular that the panel keeps the same discipline the rest of the page
// does about a figure whose basis is too thin to quote.

function history(over: Partial<TeamHistory> = {}): TeamHistory {
  return {
    team: 'panther',
    days: 3,
    observedFrom: '2026-08-26',
    observedTo: '2026-08-28',
    observedHours: 48,
    churn: null,
    burndown: [],
    cycle: { p50: null, p90: null, basis: 0, censored: 0, observedFrom: '2026-08-26', medianBacklogDwellDays: null },
    slowestCycle: [],
    cyclePoints: [],
    cyclePointsOmitted: 0,
    columnDwell: [],
    ...over,
  };
}

const dwellItem = (key: string, column: string, dwellDays: number, censored = false) => ({
  key, issueType: 'Story', column, sinceDate: '2026-08-26', dwellDays, censored, assignee: 'Dev One',
});

test('the column-ageing panel renders its queues, worst quotable first', () => {
  const columnDwell = summariseColumnDwell([
    dwellItem('WEB-1', 'waiting test', 9),
    dwellItem('WEB-2', 'waiting test', 7),
    dwellItem('WEB-3', 'waiting test', 5),
    dwellItem('WEB-4', 'In Development', 2),
    dwellItem('WEB-5', 'In Development', 1),
    dwellItem('WEB-6', 'In Development', 1),
  ]);
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam({ history: history({ columnDwell }) })] });

  assert.match(html, /id="sec-panther-ageing"/, 'the section must exist');
  assert.match(html, /How long work sits in each column/);
  assert.match(html, /waiting test/);
  // The slowest quotable queue is named as the headline, with its basis.
  assert.match(html, /Slowest queue/);
  assert.match(html, /from 3 observed/);
  // Every named ticket is a route into Jira, like every other panel.
  assert.match(html, /browse\/WEB-1/);
  // And the chart is registered against the canvas the panel emitted.
  assert.ok(charts(html)['chart-ageing-panther'], 'the ageing chart should be registered');
  assert.match(html, /id="chart-ageing-panther"/);
});

test('a queue whose median rests on one observation is not charted or quoted', () => {
  // The live shape this guards against: board 701's `waiting test` held 47 open
  // issues, 46 already there on day one, and reported a median of 3 days from
  // the one that was left.
  const columnDwell = summariseColumnDwell([
    dwellItem('WEB-1', 'waiting test', 6),
    dwellItem('WEB-2', 'waiting test', 9, true),
    dwellItem('WEB-3', 'waiting test', 9, true),
  ]);
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam({ history: history({ columnDwell }) })] });

  assert.match(html, /id="sec-panther-ageing"/);
  // The count is exact and must still be shown...
  assert.match(html, /waiting test/);
  // ...but nothing may be plotted from a single observation.
  assert.equal(charts(html)['chart-ageing-panther'], undefined, 'nothing quotable, so no chart');
  assert.doesNotMatch(html, /id="chart-ageing-panther"/);
  assert.match(html, /No column on this board has 3 observed entries yet/);
  assert.match(html, /no column has 3 observed entries yet/);
});

test('column ageing says "not measured" rather than zero on a single collected day', () => {
  const html = buildReport({ ...BASE_INPUT, teams: [baseTeam({ history: history({ days: 1, columnDwell: [] }) })] });
  assert.match(html, /id="sec-panther-ageing"/);
  assert.match(html, /not "nothing is ageing"/);
  assert.equal(charts(html)['chart-ageing-panther'], undefined);
});

test('the briefing digest nulls a column median it will not let the reader quote', () => {
  const columnDwell = summariseColumnDwell([
    dwellItem('WEB-1', 'waiting test', 6),
    dwellItem('WEB-2', 'waiting test', 9, true),
    dwellItem('WEB-3', 'Dev', 4),
    dwellItem('WEB-4', 'Dev', 5),
    dwellItem('WEB-5', 'Dev', 6),
  ]);
  const html = buildReport({
    ...BASE_INPUT,
    teams: [baseTeam({ history: history({ columnDwell }), wip: {
      columns: [], usingBoardColumns: true, perPerson: [], overloaded: [], totalInProgress: 0,
      staleDays: 10, wipLimit: 3,
    } })],
  });
  const brief = JSON.parse(island(html, 'to-brief')!);
  const ageing = brief.teams[0].flow.columnAgeing as Array<Record<string, unknown>>;

  const thin = ageing.find((c) => c.column === 'waiting test')!;
  assert.equal(thin.openHere, 2, 'the depth is exact and is carried');
  assert.equal(thin.observedBasis, 1);
  // A model handed a number will quote it, so the thin case has to arrive as a
  // null - "a null means not measurable, never zero" is already a narrative rule.
  assert.equal(thin.medianDaysInColumn, null);
  assert.equal(thin.p90DaysInColumn, null);

  const solid = ageing.find((c) => c.column === 'Dev')!;
  assert.equal(solid.observedBasis, 3);
  assert.equal(solid.medianDaysInColumn, 5);
});
