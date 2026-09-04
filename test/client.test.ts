import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, type ReportInput, type ReportTeamInput } from '../src/report/index.js';
import type { TeamTrends } from '../src/derive.js';

// ---------------------------------------------------------------------------
// The client script had NO coverage at all, and it is where two real defects
// lived: every team panel was left hidden with scripting blocked, and the chart
// tooltip callbacks were functions that JSON.stringify silently dropped, so the
// feature shipped and never once ran. Both were invisible to a test that only
// asserted the HTML contained the right attributes.
//
// So this executes CLIENT_JS against a deliberately minimal DOM stub. It proves
// the boot path runs end to end without throwing, that the tab / theme / filter
// / copy wiring finds the hooks buildReport actually emits, and that a chart
// spec reaches Chart() with a real callback installed. It proves NOTHING about
// layout, paint or CSS - that needs a browser, and the noscript behaviour is
// asserted against the markup instead, in report.test.ts.
//
// GOTCHA: the stub is built from ids scraped out of the GENERATED report rather
// than hardcoded, so renaming a hook in report/index.ts without renaming it in
// client.ts fails here instead of silently doing nothing in a browser.
// ---------------------------------------------------------------------------

function clientSource(): string {
  const src = readFileSync(new URL('../../src/report/client.ts', import.meta.url), 'utf8');
  const m = /String\.raw`([\s\S]*)`;\s*$/.exec(src);
  assert.ok(m, 'could not extract CLIENT_JS from src/report/client.ts');
  return m![1]!;
}

// --- fixtures -----------------------------------------------------------------

const EMPTY_FORECAST = { basis: 0, p10: null, p50: null, p90: null, relativeSpread: null };

function trends(over: Partial<TeamTrends> = {}): TeamTrends {
  return {
    team: 'panther', boardId: 701, boardName: 'WEB Scrum', approximate: true,
    sprints: [
      { id: 1, name: 'Panther services 41', state: 'closed', completedIssues: 9, completedPoints: 30,
        committedIssues: 20, committedPoints: 60, unestimatedCommitted: 2, carriedOut: 4,
        leadTimeDaysP50: 12, leadTimeDaysP90: 40, daysLate: 0.4, completedByType: { Story: 9 } },
      { id: 2, name: 'Panther services 42', state: 'closed', completedIssues: 11, completedPoints: 44,
        committedIssues: 22, committedPoints: 70, unestimatedCommitted: 1, carriedOut: 3,
        leadTimeDaysP50: 9, leadTimeDaysP90: 31, daysLate: 0.2, completedByType: { Story: 11 } },
    ],
    pointsForecast: { basis: 2, p10: 30, p50: 37, p90: 44, relativeSpread: 0.38 },
    issuesForecast: { basis: 2, p10: 9, p50: 10, p90: 11, relativeSpread: 0.2 },
    carryoverRateMedian: 0.18,
    ...over,
  };
}

function team(key: string): ReportTeamInput {
  return {
    key,
    boardName: 'WEB Scrum',
    prefix: 'WEB',
    trends: trends(),
    quality: {
      team: key, boardId: 701,
      counts: { issues: 10, inActiveSprint: 5, inBacklog: 3, everInASprint: 7 },
      findings: [], collectionErrors: [],
    },
    activeLoad: { sprintCount: 1, sprintNames: ['Panther services 43'], issues: 5, points: 40, unestimated: 0, resolved: 1 },
    carryoverLeaders: [],
    attention: [
      { key: 'WEB-1', summaryType: 'Bug', status: 'In Development', assignee: 'Dev One', sprintCount: 4,
        ageDays: 30, idleDays: 12, storyPoints: 3, reasons: ['blocked'], weight: 100 },
      { key: 'WEB-2', summaryType: 'Story', status: 'To Do', assignee: 'Dev Two', sprintCount: 1,
        ageDays: 4, idleDays: 1, storyPoints: null, reasons: ['unestimated'], weight: 5 },
    ],
    practice: { people: [], reviewerIdentitiesUnknown: false },
    outlook: null,
    health: {
      signals: [{ label: 'Code review', tone: 'poor', value: '60%', detail: 'Most merged work went in unreviewed.' }],
      poorCount: 1, watchCount: 0, headline: 'poor',
    },
    slowest: [],
  };
}

const INPUT: ReportInput = {
  site: 'acme.atlassian.net',
  generatedAt: '2026-08-26T18:00:00.000Z',
  jiraDate: '2026-08-26',
  jiraCapturedAt: '2026-08-26T07:00:00.000Z',
  teams: [team('panther'), team('tran')],
};

// --- the stub -----------------------------------------------------------------

interface Harness {
  tabs: any[];
  panels: any[];
  themeBtn: any;
  filterInput: any;
  filterCount: any;
  rows: any[];
  copyBtn: any;
  doc: any;
  store: Map<string, string>;
  constructed: any[];
  clipboard: () => string | null;
}

function run(html: string, opts: { hash?: string; storedTheme?: string } = {}): Harness {
  function el(tag: string, attrs: Record<string, string> = {}, text = ''): any {
    const node: any = {
      // GOTCHA: `tabIndex` here reflects the real `tabindex` HTML attribute,
      // not a hardcoded default - the generated markup ships every tab at
      // tabindex="-1" and boot.ts sets exactly one to 0 in the "no team hash"
      // path. Defaulting every stub node to 0 regardless of the attribute made
      // that path untestable: every tab looked focusable before boot ever ran.
      tag, id: attrs.id ?? '', _attrs: { ...attrs }, children: [], textContent: text, value: '',
      hidden: false, tabIndex: attrs.tabindex !== undefined ? Number(attrs.tabindex) : 0,
      style: {}, cells: [], rows: [], _listeners: {} as Record<string, any[]>,
      classList: {
        _set: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)),
        add(c: string) { this._set.add(c); },
        remove(c: string) { this._set.delete(c); },
        contains(c: string) { return this._set.has(c); },
      },
      getAttribute(n: string) { return n in node._attrs ? node._attrs[n] : null; },
      setAttribute(n: string, v: unknown) { node._attrs[n] = String(v); },
      removeAttribute(n: string) { delete node._attrs[n]; },
      hasAttribute(n: string) { return n in node._attrs; },
      addEventListener(t: string, fn: any) { (node._listeners[t] ??= []).push(fn); },
      removeEventListener() {},
      dispatch(t: string, ev: any = {}) {
        (node._listeners[t] ?? []).forEach((fn: any) => fn({ target: node, preventDefault() {}, ...ev }));
      },
      click() { node.dispatch('click'); },
      focus() { doc.activeElement = node; },
      scrollIntoView() {},
      querySelector(sel: string) { return node.querySelectorAll(sel)[0] ?? null; },
      querySelectorAll(): any[] { return []; },
      getContext() { return {}; },
      appendChild(c: any) { node.children.push(c); return c; },
      removeChild(c: any) { node.children = node.children.filter((x: any) => x !== c); },
      select() {},
      closest() { return null; },
      get offsetParent() { return node.hidden ? null : {}; },
    };
    return node;
  }

  const ids = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1]!);
  const tabIds = ids(/id="(tab-[^"]+)"/g);
  const panelIds = ids(/id="(panel-[^"]+)"/g);
  const filterFor = ids(/data-filter-for="([^"]+)"/g);
  const copyFrom = ids(/data-copy-from="([^"]+)"/g);

  assert.ok(tabIds.length > 0, 'the report emitted no tabs - the harness would prove nothing');
  assert.ok(filterFor.length > 0, 'the report emitted no filter box');
  assert.ok(copyFrom.length > 0, 'the report emitted no copy button');

  const byId = new Map<string, any>();
  const make = (id: string, attrs: Record<string, string> = {}) => {
    const n = el('div', { id, ...attrs });
    byId.set(id, n);
    return n;
  };

  const tabs = tabIds.map((id) => {
    // tabindex: '-1' matches the real markup - every tab is emitted at
    // tabindex="-1" and select() (or the "no team hash" boot path) is what
    // moves exactly one to 0.
    const n = el('button', { id, 'data-target': `panel-${id.replace(/^tab-/, '')}`, role: 'tab', tabindex: '-1' });
    byId.set(id, n);
    return n;
  });
  const panels = panelIds.map((id) => {
    const n = make(id);
    n.hidden = true;
    return n;
  });
  for (const id of ids(/<canvas id="([^"]+)"/g)) byId.set(id, el('canvas', { id }));

  const tabGroup = el('div', { 'data-tabs': '' });
  tabGroup.querySelectorAll = (sel: string) => (sel.includes('role=tab') ? tabs : []);

  const themeBtn = make('theme-toggle');
  make('modal-backdrop');
  const modalBody = make('modal-body');
  modalBody.querySelectorAll = () => [];

  const rows = [el('tr', {}, 'WEB-1 blocked Dev One'), el('tr', {}, 'WEB-2 unestimated Dev Two')];
  const table = make(filterFor[0]!);
  table.tBodies = [{ rows }];
  table.tHead = null;
  const filterInput = el('input', {});
  const filterCount = el('span', { class: 'count' });
  const filterBox = el('div', { 'data-filter-for': filterFor[0]! });
  filterBox.querySelector = (sel: string) => (sel === 'input' ? filterInput : sel === '.count' ? filterCount : null);

  const summary = make(copyFrom[0]!);
  summary.querySelectorAll = () => [el('div', {}, 'panther — needs you'), el('div', {}, 'code review is in the red.')];
  const copyBtn = el('button', { 'data-copy-from': copyFrom[0]! }, 'Copy summary');

  const doc: any = {
    activeElement: null,
    documentElement: el('html'),
    body: el('body'),
    _listeners: {} as Record<string, any[]>,
    addEventListener(t: string, fn: any) { (doc._listeners[t] ??= []).push(fn); },
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => el(tag),
    execCommand: () => true,
    querySelector(sel: string) { return doc.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel: string): any[] {
      if (sel === '[data-tabs]') return [tabGroup];
      // Phase 9 nests two tab groups (the view rail, data-tabs="view", and the
      // per-board bar, data-tabs="team"); the boot path now scopes its
      // roving-tabindex and fallback queries to the team bar specifically. The
      // stub flattens everything into one group, so any "[data-tabs...] [role=tab]"
      // selector resolves to the same tab list.
      if (/\[data-tabs[^\]]*\]\s*\[role=tab\]/.test(sel)) return tabs;
      if (sel === '[data-filter-for]') return [filterBox];
      if (sel === '[data-copy-from]') return [copyBtn];
      if (sel === 'table[data-sortable]') return [table];
      return [];
    },
  };

  const constructed: any[] = [];
  function Chart(this: any, _ctx: unknown, spec: any) {
    constructed.push(spec);
    this.destroy = () => {};
  }
  (Chart as any).defaults = { font: {}, plugins: { legend: { labels: {} } } };

  const store = new Map<string, string>();
  if (opts.storedTheme) store.set('cadence-theme', opts.storedTheme);

  const specsMatch = /window\.__TO_CHARTS__ = ([\s\S]*?);<\/script>/.exec(html);
  const win: any = {
    location: { hash: opts.hash ?? '' },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, v),
    },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    __TO_CHARTS__: specsMatch ? JSON.parse(specsMatch[1]!) : {},
  };

  let clipboardText: string | null = null;
  const ctx: Record<string, unknown> = {
    window: win,
    document: doc,
    Chart,
    navigator: { clipboard: { writeText: (t: string) => { clipboardText = t; return Promise.resolve(); } } },
    history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#243049' }),
    setTimeout: (fn: () => void) => fn(),
  };

  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(ctx), clientSource())(...Object.values(ctx));

  return {
    tabs, panels, themeBtn, filterInput, filterCount, rows, copyBtn, doc, store, constructed,
    clipboard: () => clipboardText,
  };
}

// --- tests --------------------------------------------------------------------

test('a plain load with no #team= link boots without throwing and opens NO team tab', () => {
  // GOTCHA this pins: opening a freshly generated report used to auto-select
  // the first team ALPHABETICALLY BY PREFIX (groupByPrefix in model.ts) and
  // rewrite the URL to match, which has nothing to do with which team needs
  // attention. The page already has a team-neutral landing view above the tabs
  // - Act on this, the triage banner, the portfolio table - so a plain load now
  // leaves it as the landing page and opens no team panel until the reader
  // picks one.
  const h = run(buildReport(INPUT));
  assert.equal(h.tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 0);
  assert.equal(h.panels.filter((p) => !p.hidden).length, 0);
  // Roving tabindex still needs exactly one reachable stop in the tablist, or
  // the tabbar becomes unreachable by keyboard with nothing selected.
  assert.equal(h.tabs.filter((t) => t.tabIndex === 0).length, 1);
});

test('clicking a tab opens exactly that one panel', () => {
  const h = run(buildReport(INPUT));
  h.tabs[0].dispatch('click');
  assert.equal(h.tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
  assert.equal(h.panels.filter((p) => !p.hidden).length, 1);
});

test('a #team= link opens that team rather than the first one', () => {
  const h = run(buildReport(INPUT), { hash: '#team=tran' });
  const selected = h.tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  assert.equal(selected.getAttribute('data-target'), 'panel-tran');
});

test('an unknown team in the hash falls back to the first tab, never to nothing visible', () => {
  // The failure this guards: a stale link from a profile that no longer has that
  // team would otherwise leave every panel hidden and the report looking empty.
  const h = run(buildReport(INPUT), { hash: '#team=deleted' });
  assert.equal(h.panels.filter((p) => !p.hidden).length, 1);
});

test('chart tooltip callbacks are real functions by the time Chart() sees them', () => {
  // The regression this exists for: these were authored as functions on the spec
  // and JSON.stringify dropped them silently, so the tooltip that restores the
  // full sprint name never ran once. Asserting the markup cannot catch that.
  // A team's own charts draw on first reveal, not up front - see the "no team
  // tab opens on a plain load" test - so this needs an explicit hash to open one.
  const h = run(buildReport(INPUT), { hash: '#team=panther' });
  const withTitles = h.constructed.filter((s) => s._meta?.tooltipTitles);
  assert.ok(withTitles.length > 0, 'expected at least one chart carrying tooltip titles');
  const cb = withTitles[0].options.plugins.tooltip.callbacks.title;
  assert.equal(typeof cb, 'function');
  assert.equal(cb([{ dataIndex: 0 }]), 'Panther services 41');
});

test('the portfolio chart tooltip reports each team load verdict', () => {
  const h = run(buildReport(INPUT));
  const spec = h.constructed.find((s) => s._meta?.tooltipAfterBody);
  assert.ok(spec, 'expected the portfolio chart to carry afterBody text');
  assert.match(spec.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: 0 }]), /load: /);
});

test('the theme toggle flips the attribute and remembers the choice', () => {
  const h = run(buildReport(INPUT));
  h.themeBtn.dispatch('click');
  const theme = h.doc.documentElement.getAttribute('data-theme');
  assert.ok(theme === 'light' || theme === 'dark', `unexpected theme "${theme}"`);
  assert.equal(h.store.get('cadence-theme'), theme);
});

test('a remembered theme is applied before anything is drawn', () => {
  const h = run(buildReport(INPUT), { storedTheme: 'light' });
  assert.equal(h.doc.documentElement.getAttribute('data-theme'), 'light');
});

test('the ticket filter hides rows and reports an honest count', () => {
  const h = run(buildReport(INPUT));
  h.filterInput.value = 'WEB-2';
  h.filterInput.dispatch('input');
  assert.equal(h.rows.filter((r) => r.hasAttribute('data-filtered')).length, 1);
  assert.match(h.filterCount.textContent, /showing 1 of 2/);
});

test('clearing the filter restores every row', () => {
  const h = run(buildReport(INPUT));
  h.filterInput.value = 'nothing matches this';
  h.filterInput.dispatch('input');
  assert.equal(h.rows.filter((r) => r.hasAttribute('data-filtered')).length, 2);
  h.filterInput.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.rows.filter((r) => r.hasAttribute('data-filtered')).length, 0);
});

test('copy summary reads the rendered text back, so it cannot disagree with the page', () => {
  const h = run(buildReport(INPUT));
  h.copyBtn.dispatch('click');
  const text = h.clipboard();
  assert.ok(text, 'nothing reached the clipboard');
  assert.match(text!, /panther/);
  assert.match(text!, /needs you/);
});
