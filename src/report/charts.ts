import type { SprintMetrics } from '../derive.js';
import { dwellIsReportable } from '../history.js';
import type { CyclePoint, TeamHistory } from '../history.js';
import type { PracticeSummary } from '../insights.js';
import type { CompositionSeries, WipSummary } from '../flow.js';
import type { EpicRollupResult, EstateEpicResult } from '../epics.js';
import { activeEpics } from '../epics.js';
import type { PeopleEstate } from '../people.js';
import type { ReviewMetrics } from '../review.js';
import { loadVerdict, type ReportTeamInput } from './model.js';
import { shortSprintLabel } from './format.js';

// ---------------------------------------------------------------------------
// Chart specifications.
//
// Chart.js is vendored and inlined (see assets.ts) and is allowed to DRAW and
// nothing else. Every number plotted is also rendered as literal text beside
// the chart, so a blocked script degrades the page to readable tables and there
// is no client-side path that can arrive at a different figure from the CLI.
//
// A chart makes everything look equally solid, which is exactly why nothing
// labelled WEAK or UNUSABLE in derive.ts is drawn here without its label
// travelling with it in the surrounding panel.
// ---------------------------------------------------------------------------

export const C = {
  accent: '#5b9bff',
  accent2: '#9d7bff',
  good: '#2fd08a',
  watch: '#e2b53f',
  poor: '#ff6b5c',
  muted: '#6b7a99',
  grid: '#243049',
  /** The categorical set, in the order a chart should consume it. Eight rather
   *  than three because the estate views genuinely have more than three
   *  categories; the old spec folded everything past the third into a grey
   *  "other" bucket, which is a lie when the tail is half the board's work.
   *
   *  Carried as CSS CUSTOM PROPERTY NAMES, not hex: client.ts resolves them off
   *  the live stylesheet immediately before `new Chart(...)`, so a mark repaints
   *  when the reader switches theme or prints. The tokens are declared for the
   *  dark page, the light page and the print stylesheet in css.ts. Cadence's own
   *  older specs keep their baked hex - the resolver passes a plain colour
   *  string straight through - so this is additive, not a restyle. */
  cat: [
    'var(--c-1)', 'var(--c-2)', 'var(--c-3)', 'var(--c-4)',
    'var(--c-5)', 'var(--c-6)', 'var(--c-7)', 'var(--c-8)',
  ] as const,
  /** The two stops of the gradient wash under a line or area series. client.ts
   *  turns the pair into a real CanvasGradient at draw time. */
  fillHi: 'var(--c-fill-hi)',
  fillLo: 'var(--c-fill-lo)',
};

/** Picks `n` colours off a fixed ramp, spread across its whole range.
 *
 *  A sequential ramp encodes MAGNITUDE by position along it, so taking the
 *  first n of an eight-step ramp renders a 3-column board inside the ramp's
 *  darkest quarter - three near-identical colours for three maximally-different
 *  stages. Spreading uses the full contrast the ramp was built to provide and
 *  stays monotonic at every board size. n greater than the ramp length repeats
 *  the end colour rather than wrapping - wrapping a sequential scale makes the
 *  largest value look like the smallest. */
export function ramp(scale: readonly string[], n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [scale[scale.length - 1]!];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = Math.round((i * (scale.length - 1)) / (n - 1));
    out.push(scale[Math.min(at, scale.length - 1)]!);
  }
  return out;
}

/** `n` categorical inks, in palette order, cycling once the eight run out.
 *
 *  Cycling is safe here in a way it is not on a ramp: a categorical scale
 *  encodes IDENTITY, so a repeated hue is an ambiguity the legend resolves, not
 *  a false ordering. It is still a smell - nothing in this file should be
 *  plotting nine categories, and if something starts to, the fix is to bucket
 *  the tail rather than to widen the palette. */
export function categorical(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(C.cat[i % C.cat.length]!);
  return out;
}

/** Marks a colour string as the TOP stop of a vertical gradient wash, faded to
 *  --c-fill-lo at the axis. client.ts recognises the wrapper and builds the
 *  real CanvasGradient at draw time, because a gradient needs the pixel height
 *  of the plot area, which does not exist until the chart is laid out.
 *
 *  GOTCHA: it has to survive JSON.stringify, so it is a STRING with a sentinel
 *  prefix rather than an object or a function. */
export function gradientFill(top: string): string {
  return `gradient:${top}`;
}

/** Steps in the flow ramp defined by css.ts. */
export const FLOW_STEPS = 8;

/** Band tokens for a board with any number of columns, in BOARD order.
 *
 *  A board's columns are a SEQUENCE - positions in one pipeline - so the ramp
 *  is one hue running light to dark, per the sequential rule. Any column count
 *  is mapped monotonically onto the ramp's fixed steps rather than interpolated
 *  at build time, because the ramp differs between the light and dark themes and
 *  only CSS knows which is showing. Boards here carry three to eight columns; a
 *  wider one simply lands more columns on the same eight steps, which merges two
 *  adjacent bands - visibly worse than a wrong colour, and the legend and the
 *  table underneath still separate them. */
export function flowColours(n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [`var(--c-flow-${FLOW_STEPS})`];
  return Array.from({ length: n }, (_, i) => {
    const step = 1 + Math.round((i / (n - 1)) * (FLOW_STEPS - 1));
    return `var(--c-flow-${step})`;
  });
}

export interface ChartSpec {
  type: string;
  data: unknown;
  options: unknown;
  /** Anything the chart needs that JSON cannot carry.
   *
   *  GOTCHA: Chart.js tooltip callbacks are FUNCTIONS, and every spec here is
   *  serialised with JSON.stringify, which drops function values silently -
   *  `{tooltip:{callbacks:{title:fn}}}` comes out as `"callbacks":{}` with no
   *  error. The axis-label-to-real-name tooltip was written, shipped, and never
   *  once rendered. So the DATA a callback needs travels here and client.ts
   *  installs the callback itself. */
  _meta?: {
    tooltipTitles?: string[];
    tooltipAfterBody?: string[];
    /** Per-POINT tooltip lines, for a chart whose marks are not one-per-index -
     *  a scatter, where dataIndex identifies a point inside a dataset rather
     *  than a shared category. Keyed by dataset index, then point index. */
    pointLabels?: string[][];
    /** Labels for an axis whose values are NUMBERS that stand for something
     *  else - a scatter's day offsets standing for dates. Keyed by the tick
     *  value as a string; a value with no entry gets no tick label, which is
     *  how a sparse set of labels lands on a dense axis. Same reason as the
     *  tooltip callbacks: a Chart.js tick callback is a FUNCTION and
     *  JSON.stringify drops it, so the DATA travels here and client.ts installs
     *  the callback. */
    xTickLabels?: Record<string, string>;
  };
}

const gridScale = (title?: string) => ({
  grid: { color: C.grid, drawBorder: false },
  ticks: { maxRotation: 0, autoSkip: true },
  title: title ? { display: true, text: title, color: '#93a0ba' } : undefined,
});

/** Completed points per closed sprint, with the team's own p50/p90 drawn
 *  across, and the active sprint's committed load as a final distinct column.
 *
 *  GOTCHA: this plots COMPLETED points only. Charting `committedPoints` per
 *  closed sprint would put the UNUSABLE metric on a projector - it counts every
 *  issue in that sprint NOW, so an item that passed through 16 sprints counts
 *  as committed in all 16 and board 701 shows sprints with 123 committed
 *  against 11 completed. The ACTIVE sprint's committed load is accurate today,
 *  so it is drawn, in its own colour and labelled as not-yet-delivered. */
export function deliveryChart(t: ReportTeamInput, recent: number): ChartSpec {
  const closed = t.trends.sprints.filter((s) => s.state === 'closed').slice(-recent);
  const labels = closed.map((s: SprintMetrics) => shortSprintLabel(s.name));
  const full = closed.map((s) => s.name);
  const values: Array<number | null> = closed.map((s) => s.completedPoints);
  const colors = closed.map(() => C.accent);

  if (t.activeLoad.sprintCount > 0) {
    labels.push(t.activeLoad.sprintCount === 1 ? shortSprintLabel(t.activeLoad.sprintNames[0] ?? '') : 'active');
    full.push(
      t.activeLoad.sprintCount === 1
        ? `${t.activeLoad.sprintNames[0]} (committed, not yet delivered)`
        : `${t.activeLoad.sprintCount} concurrent active sprints (committed, not yet delivered)`,
    );
    values.push(t.activeLoad.points);
    colors.push(C.watch);
  }

  const pf = t.trends.pointsForecast;
  const line = (v: number | null, color: string, label: string) => ({
    type: 'line',
    label,
    data: labels.map(() => v),
    borderColor: color,
    borderWidth: 1.5,
    borderDash: [6, 4],
    pointRadius: 0,
    fill: false,
  });

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Completed points', data: values, backgroundColor: colors, borderRadius: 3, order: 2 },
        ...(pf.p50 !== null ? [line(pf.p50, C.good, `p50 ${pf.p50.toFixed(0)}`)] : []),
        ...(pf.p90 !== null ? [line(pf.p90, C.poor, `p90 ${pf.p90.toFixed(0)}`)] : []),
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: { x: gridScale(), y: { ...gridScale('story points'), beginAtZero: true } },
    },
    _meta: { tooltipTitles: full },
  };
}

/** Cross-team comparison: each team's p50, p90 and what it is carrying now. */
export function portfolioChart(teams: ReportTeamInput[]): ChartSpec {
  return {
    type: 'bar',
    data: {
      labels: teams.map((t) => t.key),
      datasets: [
        { label: 'p50 (typical sprint)', data: teams.map((t) => t.trends.pointsForecast.p50), backgroundColor: C.good, borderRadius: 3 },
        { label: 'p90 (best sprint)', data: teams.map((t) => t.trends.pointsForecast.p90), backgroundColor: C.accent, borderRadius: 3 },
        { label: 'committed now', data: teams.map((t) => t.activeLoad.points), backgroundColor: C.watch, borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: { x: gridScale(), y: { ...gridScale('story points'), beginAtZero: true } },
    },
    _meta: {
      tooltipAfterBody: teams.map((t) => `load: ${loadVerdict(t.activeLoad, t.trends.pointsForecast.p90).label}`),
    },
  };
}

/** Remaining points per collected day, against the ideal line. */
export function burndownChart(h: TeamHistory): ChartSpec | null {
  if (h.burndown.length < 2) return null;
  return {
    type: 'line',
    data: {
      labels: h.burndown.map((p) => p.date.slice(5)),
      datasets: [
        {
          label: 'Remaining points (observed)',
          data: h.burndown.map((p) => p.remainingPoints),
          borderColor: C.accent,
          backgroundColor: 'rgba(91,155,255,.12)',
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
          tension: 0.15,
        },
        {
          label: 'Ideal',
          data: h.burndown.map((p) => p.idealRemaining),
          borderColor: C.good,
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Committed',
          data: h.burndown.map((p) => p.committedPoints),
          borderColor: C.watch,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: { x: gridScale(), y: { ...gridScale('story points'), beginAtZero: true } },
    },
  };
}

/** Review practice: authored vs merged-unreviewed vs reviews given, per person.
 *
 *  Deliberately NOT a productivity chart - see the header of insights.ts. */
export function practiceChart(p: PracticeSummary, limit: number, forge?: 'gitlab' | 'github'): ChartSpec | null {
  const people = p.people.filter((x) => x.authored > 0 || x.reviewsGiven > 0).slice(0, limit);
  if (people.length === 0) return null;
  return {
    type: 'bar',
    data: {
      labels: people.map((x) => x.name),
      datasets: [
        { label: 'Merged with review', data: people.map((x) => x.mergedKnown - x.mergedUnreviewed), backgroundColor: C.good, stack: 'a', borderRadius: 2 },
        { label: 'Merged with NO human review', data: people.map((x) => x.mergedUnreviewed), backgroundColor: C.poor, stack: 'a', borderRadius: 2 },
        { label: "Reviews given on others' work", data: people.map((x) => x.reviewsGiven), backgroundColor: C.accent, stack: 'b', borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { position: 'bottom' } },
      scales: { x: { ...gridScale(forge === 'github' ? 'pull requests' : 'merge requests'), beginAtZero: true, stacked: true }, y: { ...gridScale(), stacked: true } },
    },
  };
}

/** Where the sprint's work is sitting, in the board's own column order.
 *
 *  Drawn as a horizontal bar rather than a pie: the question is "which queue is
 *  deepest", which is a length comparison, and a pie makes two similar slices
 *  indistinguishable. The stale portion is stacked on top in the warning colour
 *  because a deep column of things that are all moving is not a problem. */
export function wipChart(w: WipSummary): ChartSpec | null {
  const cols = w.columns.filter((c) => c.issues > 0);
  if (cols.length === 0) return null;
  return {
    type: 'bar',
    data: {
      labels: cols.map((c) => c.name),
      datasets: [
        {
          label: 'Moving',
          data: cols.map((c) => c.issues - c.stale),
          backgroundColor: cols.map((c) => (c.done ? C.good : C.accent)),
          stack: 'a',
          borderRadius: 2,
        },
        // The threshold comes off the summary, never a constant: `--stale-days`
        // changes the number this series counts, and a legend that says "10+"
        // while the bar counted 20 is a chart that argues with its own data.
        { label: `No change for ${w.staleDays}+ days`, data: cols.map((c) => c.stale), backgroundColor: C.poor, stack: 'a', borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { position: 'bottom' } },
      scales: { x: { ...gridScale('issues'), beginAtZero: true, stacked: true }, y: { ...gridScale(), stacked: true } },
    },
    _meta: { tooltipAfterBody: cols.map((c) => `${c.points} pts · median idle ${c.medianIdleDays === null ? '—' : `${Math.round(c.medianIdleDays)}d`}`) },
  };
}

/** Contributors per sprint against points delivered.
 *
 *  The two series share an x axis and deliberately have separate y axes: the
 *  entire point is to let a reader see a velocity drop line up with a headcount
 *  drop, and forcing points and people onto one scale makes the people line a
 *  flat smudge along the bottom. */
export function compositionChart(c: CompositionSeries): ChartSpec | null {
  if (c.sprints.length < 2) return null;
  return {
    type: 'bar',
    data: {
      labels: c.sprints.map((s) => shortSprintLabel(s.name)),
      datasets: [
        { type: 'bar', label: 'Points completed', data: c.sprints.map((s) => s.completedPoints), backgroundColor: C.accent, borderRadius: 3, yAxisID: 'y', order: 2 },
        {
          type: 'line',
          label: 'People who completed something',
          data: c.sprints.map((s) => s.people.length),
          borderColor: C.watch,
          backgroundColor: C.watch,
          borderWidth: 2,
          pointRadius: 3,
          yAxisID: 'y1',
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: gridScale(),
        y: { ...gridScale('story points'), beginAtZero: true, position: 'left' },
        y1: { ...gridScale('people'), beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } },
      },
    },
    _meta: {
      tooltipTitles: c.sprints.map((s) => s.name),
      tooltipAfterBody: c.sprints.map((s) =>
        [s.joined.length > 0 ? `joined: ${s.joined.join(', ')}` : '', s.left.length > 0 ? `not seen: ${s.left.join(', ')}` : '']
          .filter(Boolean)
          .join(' · '),
      ),
    },
  };
}

/** How long the active sprint's open work has sat in each board column.
 *
 *  Median and p90 side by side rather than median alone: a queue whose median is
 *  two days and whose p90 is thirty is a queue with a stuck tail, and that is a
 *  different problem from one where everything is uniformly slow. Both are drawn
 *  from OBSERVED column membership, not from `updated` - see columnDwellNow.
 *
 *  Returns null when there is nothing measurable, so the panel says "not yet"
 *  rather than drawing an empty axis: a flat zero here would read as a board
 *  where nothing waits, which is the opposite of not having looked. */
export function columnAgeingChart(h: TeamHistory): ChartSpec | null {
  // Only columns whose percentiles rest on enough observed entries are plotted.
  // A chart makes everything look equally solid - the reason this file's header
  // exists - so a bar drawn from ONE observation is the single most misleading
  // thing this panel could contain. dwellIsReportable is the same test the CLI
  // text, the table and the digest use, so no two of them can disagree.
  const rows = h.columnDwell.filter(dwellIsReportable);
  if (rows.length === 0) return null;
  return {
    type: 'bar',
    data: {
      labels: rows.map((c) => (c.column.length > 26 ? `${c.column.slice(0, 25)}…` : c.column)),
      datasets: [
        { label: 'Median days in this column', data: rows.map((c) => c.medianDwellDays), backgroundColor: C.accent, borderRadius: 2 },
        { label: 'p90 days', data: rows.map((c) => c.p90DwellDays), backgroundColor: C.watch, borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { position: 'bottom' } },
      scales: { x: { ...gridScale('days'), beginAtZero: true }, y: gridScale() },
    },
    _meta: {
      tooltipTitles: rows.map((c) => c.column),
      tooltipAfterBody: rows.map(
        (c) =>
          `${c.count} open here · from ${c.basis} observed ${c.basis === 1 ? 'entry' : 'entries'}` +
          (c.censored > 0 ? ` · ${c.censored} already here on day one, excluded from these figures` : ''),
      ),
    },
  };
}

/** Where the sprint's effort is going, by epic. */
export function epicChart(e: EpicRollupResult, limit = 10): ChartSpec | null {
  const rows = activeEpics(e).slice(0, limit);
  if (rows.length === 0) return null;
  return {
    type: 'bar',
    data: {
      labels: rows.map((r) => (r.name.length > 34 ? `${r.name.slice(0, 33)}…` : r.name)),
      datasets: [
        { label: 'Done in this sprint', data: rows.map((r) => r.active.doneIssues), backgroundColor: C.good, stack: 'a', borderRadius: 2 },
        { label: 'Still open', data: rows.map((r) => r.active.issues - r.active.doneIssues), backgroundColor: C.accent, stack: 'a', borderRadius: 2 },
        { label: 'Queued in the backlog', data: rows.map((r) => r.backlog.issues), backgroundColor: C.muted, stack: 'b', borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { position: 'bottom' } },
      scales: { x: { ...gridScale('issues'), beginAtZero: true, stacked: true }, y: { ...gridScale(), stacked: true } },
    },
    _meta: {
      tooltipTitles: rows.map((r) => `${r.key} — ${r.name}`),
      tooltipAfterBody: rows.map((r) => `${r.active.points} pts in sprint · ${r.blocked} blocked · ${r.carried} carried 3+ sprints`),
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 7 additions: the cumulative flow, cycle-time distribution and review-
// latency charts, plus the two estate-view charts. Ported from upstream; the
// arithmetic each one plots was added and unit-tested in Phases 3-5.
// ---------------------------------------------------------------------------

/** The cumulative flow diagram: where the active sprint's work sat on every
 *  collected day, stacked so the top line is the sprint's whole scope.
 *
 *  This is the one chart here that is read by SHAPE rather than by value. A band
 *  that widens day over day is work entering a stage faster than it leaves -
 *  the queue that will miss the sprint, visible while it is still cheap. The top
 *  line rising is scope arriving; a flat bottom band is nothing being finished.
 *
 *  Stacking order is REVERSED against board order on purpose, so the last
 *  column - done, on every board here - is the bottom band. That is the
 *  convention every reader of a CFD already has, and it is the only order in
 *  which "the green is growing" means what it looks like it means.
 *
 *  Returns null below two days: one point is not a flow, and a single-column
 *  chart drawn from it would read as a sprint that has never moved. */
export function cfdChart(h: TeamHistory): ChartSpec | null {
  const flow = h.flow;
  if (!flow || flow.days.length < 2 || flow.columns.length === 0) return null;

  const colours = flowColours(flow.columns.length);
  // Board order for the colours and the axis; reversed for the stack.
  const datasets = flow.columns
    .map((name, i) => ({
      label: name,
      data: flow.days.map((d) => d.counts[i] ?? 0),
      backgroundColor: colours[i]!,
      borderColor: colours[i]!,
      borderWidth: 1,
      pointRadius: 0,
      pointHitRadius: 8,
      fill: true,
      // Straight segments between observations. A smoothed curve would draw
      // values on days nothing was collected, which is the one thing this
      // layer's whole premise forbids.
      tension: 0,
    }))
    .reverse();

  return {
    type: 'line',
    data: { labels: flow.days.map((d) => d.date.slice(5)), datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: gridScale(),
        y: { ...gridScale('issues in the sprint'), stacked: true, beginAtZero: true },
      },
    },
    _meta: {
      tooltipTitles: flow.days.map((d) => d.date),
      tooltipAfterBody: flow.days.map(
        (d) =>
          `${d.total} issue${d.total === 1 ? '' : 's'} in ${flow.sprintName} on this day` +
          (d.date === flow.observedFrom && flow.censoredStart
            ? ' · the first collected day, so anything before this is not observed'
            : ''),
      ),
    },
  };
}


// --- cycle-time distribution --------------------------------------------------

/** Every resolved item's cycle time against the day it resolved, with the p50
 *  and p90 drawn across.
 *
 *  What this shows that `history.cycle` cannot. The panel above it reports two
 *  numbers, and a p90 of forty days is the SAME NUMBER whether this team's work
 *  uniformly takes about forty days or takes three days with two tickets stuck
 *  for six weeks. Those are opposite findings calling for opposite actions -
 *  one is a process problem, the other is two conversations. The scatter
 *  separates them at a glance and the percentiles never can.
 *
 *  Censored observations - work already in progress when collection began, so
 *  its cycle time is a LOWER BOUND - are drawn HOLLOW and are excluded from the
 *  reference lines, exactly as they are excluded from the percentiles in
 *  summariseCycleTimes. Drawing them filled would put a lower bound on the same
 *  footing as a measurement; dropping them would hide the team's longest-running
 *  work, which is usually the work worth looking at.
 *
 *  GOTCHA: the x axis is a LINEAR axis of day offsets, not a time axis.
 *  Chart.js time scales need a date adapter, and an adapter is a second library
 *  this file's whole premise - one vendored file, no network - forbids. So x is
 *  "days since the first resolution in the window" and the tick labels travel
 *  in _meta.xTickLabels for client.ts to install, for the same reason the
 *  tooltip callbacks do. */
export function cycleScatterChart(h: TeamHistory): ChartSpec | null {
  const pts = h.cyclePoints ?? [];
  if (pts.length < 3) return null;

  const dayOf = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000;
  const days = pts.map((p) => dayOf(p.resolvedOn)).filter((d) => Number.isFinite(d));
  if (days.length === 0) return null;
  const origin = Math.min(...days);
  const span = Math.max(...days) - origin;

  const mark = (p: CyclePoint) => ({ x: dayOf(p.resolvedOn) - origin, y: p.cycleDays });
  const measured = pts.filter((p) => !p.censored);
  const censored = pts.filter((p) => p.censored);
  if (measured.length === 0) return null;

  // A tick roughly every seventh of the span, snapped to whole days. A label on
  // every mark is a black smear along a 288px-high chart's axis.
  const step = Math.max(1, Math.ceil((span || 1) / 7));
  const xTickLabels: Record<string, string> = {};
  for (let d = 0; d <= span; d += step) {
    xTickLabels[String(d)] = new Date((origin + d) * 86_400_000).toISOString().slice(5, 10);
  }

  const c = h.cycle;
  const refLine = (v: number, colour: string, label: string) => ({
    type: 'line',
    label,
    data: [
      { x: 0, y: v },
      { x: span || 1, y: v },
    ],
    borderColor: colour,
    borderWidth: 1.5,
    borderDash: [6, 4],
    pointRadius: 0,
    fill: false,
  });

  const datasets: unknown[] = [
    {
      type: 'scatter',
      label: `Resolved (${measured.length})`,
      data: measured.map(mark),
      backgroundColor: C.accent,
      borderColor: C.accent,
      pointRadius: 3.5,
      pointHoverRadius: 6,
    },
  ];
  if (censored.length > 0) {
    datasets.push({
      type: 'scatter',
      label: `Started before collection began (${censored.length}) — lower bound`,
      // A ring, not a dot. The difference between a measurement and a lower
      // bound has to be visible in the MARK, because the legend is the first
      // thing a reader stops looking at.
      data: censored.map(mark),
      backgroundColor: 'transparent',
      borderColor: C.watch,
      borderWidth: 1.5,
      pointRadius: 4,
      pointHoverRadius: 6,
    });
  }
  if (c.p50 !== null) datasets.push(refLine(c.p50, C.good, `p50 ${c.p50.toFixed(1)}d`));
  if (c.p90 !== null) datasets.push(refLine(c.p90, C.poor, `p90 ${c.p90.toFixed(1)}d`));

  return {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      // `nearest`, not `index`: a scatter has no shared category to group by,
      // and index mode would pick whatever point happens to share an array
      // position in the other datasets - an unrelated ticket and a reference
      // line.
      interaction: { mode: 'nearest', intersect: true },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { ...gridScale('resolved'), type: 'linear', min: 0, max: span || 1 },
        y: { ...gridScale('days in progress'), beginAtZero: true },
      },
    },
    _meta: {
      xTickLabels,
      pointLabels: [
        measured.map((p) => `${p.key} · ${p.issueType} · ${p.cycleDays.toFixed(1)}d · resolved ${p.resolvedOn}`),
        ...(censored.length > 0
          ? [
              censored.map(
                (p) => `${p.key} · ${p.issueType} · at least ${p.cycleDays.toFixed(1)}d · start unobserved`,
              ),
            ]
          : []),
      ],
    },
  };
}


// --- review latency -----------------------------------------------------------

/** How long work waits for a person to look at it - as a distribution.
 *
 *  The panel's headline is the unreviewed SHARE and that stays the headline.
 *  This sits under it and answers the follow-up: when review does happen, is it
 *  a habit or an accident. A team with a four-hour median and nothing in the
 *  5d+ bar has a review culture; a team with the same median and a third of its
 *  work in that bar has half a review culture, and the median cannot tell them
 *  apart.
 *
 *  The "never" bar is in the warning ink and stands apart from the latency
 *  buckets, because it is not a slower version of the same thing - it is the
 *  absence of the thing. Folded into a 5d+ bucket it would read as "reviewed,
 *  eventually", which is the one reading the figure must not support.
 *
 *  All bucketing happens in review.ts. Nothing here counts anything. */
export function reviewLatencyChart(r: ReviewMetrics): ChartSpec | null {
  const buckets = r.latencyBuckets ?? [];
  const never = r.neverHumanReviewed ?? 0;
  const total = buckets.reduce((a, b) => a + b.count, 0);
  if (total + never === 0) return null;

  return {
    type: 'bar',
    data: {
      labels: [...buckets.map((b) => b.label), 'never'],
      datasets: [
        {
          label: 'Merge requests',
          data: [...buckets.map((b) => b.count), never],
          backgroundColor: [...buckets.map(() => C.accent), C.poor],
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: gridScale('hours to the first human comment or approval'),
        y: { ...gridScale('merge requests'), beginAtZero: true },
      },
    },
    _meta: {
      tooltipTitles: [
        ...buckets.map((b) => (b.toHours === null ? `${b.fromHours}h or longer` : `${b.fromHours}h to under ${b.toHours}h`)),
        'No human comment and no human approval, ever',
      ],
      tooltipAfterBody: [
        ...buckets.map(() => `of the ${total} that got a human review`),
        `of ${r.reviewDetailKnown} whose review detail was read`,
      ],
    },
  };
}

// --- cross-team load ----------------------------------------------------------

/** Who holds open sprint work on more than one board, stacked by board.
 *
 *  The only chart in this report about people, and drawn under tight
 *  constraints for that reason - see the header of people.ts. It plots a COUNT
 *  OF OPEN ITEMS HELD PER BOARD, which is a fact about today's assignment
 *  rather than about output, and no rate, no points and no cross-board total.
 *  What the stack shows is SPREAD: three segments on one row is somebody in
 *  three standups with three sets of priorities, and that is a load fact a
 *  manager can act on without it being a judgement about the person.
 *
 *  Only people on two or more boards appear. Everybody else is on their own
 *  team's roster panel, where the question is different and already answered;
 *  including them here would turn a cross-team signal into a leaderboard of who
 *  holds the most tickets, which is exactly the artefact this report refuses to
 *  produce. */
export function crossTeamLoadChart(p: PeopleEstate, teamKeys: string[], limit = 14): ChartSpec | null {
  const rows = p.people.filter((x) => x.activeBoardCount > 1).slice(0, limit);
  if (rows.length === 0) return null;

  // One band per board, from the sequential ramp the flow diagram uses. Boards
  // are not a sequence, but neither are they three categories to be told apart
  // by hue - the reader identifies them from the legend and the tooltip - and
  // reusing the ramp keeps the page to one validated palette instead of
  // inventing a fourth and fifth hue nobody checked.
  const inks = flowColours(teamKeys.length);

  return {
    type: 'bar',
    data: {
      labels: rows.map((x) => x.name),
      datasets: teamKeys.map((key, i) => ({
        label: key,
        data: rows.map((x) => x.boards.find((b) => b.team === key)?.openInActiveSprint ?? 0),
        backgroundColor: inks[i]!,
        stack: 'a',
        borderRadius: 2,
      })),
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { ...gridScale('open items in an active sprint'), beginAtZero: true, stacked: true },
        y: { ...gridScale(), stacked: true },
      },
    },
    _meta: {
      tooltipAfterBody: rows.map(
        (x) =>
          `${x.activeBoardCount} boards' active sprints · ${x.openAssigned} open in total` +
          (x.flaggedAssigned > 0 ? ` · ${x.flaggedAssigned} flagged` : ''),
      ),
    },
  };
}

// --- estate epic progress -----------------------------------------------------

/** Epic progress across every collected board: done, in a sprint, queued.
 *
 *  Sorted by what is LEFT rather than by size or by percentage complete. The
 *  epic with the most remaining issues is the one that will still be here next
 *  quarter, and sorting by percentage puts a two-issue epic above a
 *  two-hundred-issue one. Cross-team epics are called out in the tooltip
 *  because those are the rows no single board view can show correctly - the
 *  gap this whole panel exists to close.
 *
 *  The four segments are a PARTITION computed in epics.ts, so they add to the
 *  epic's issue count. Stacking `active.issues` beside `doneIssues` instead
 *  would count a finished sprint ticket in both. */
export function estateEpicChart(e: EstateEpicResult, limit = 12): ChartSpec | null {
  const rows = [...e.epics]
    .filter((r) => r.issues > 0)
    .sort((a, b) => b.issues - b.doneIssues - (a.issues - a.doneIssues) || b.issues - a.issues)
    .slice(0, limit);
  if (rows.length === 0) return null;

  return {
    type: 'bar',
    data: {
      labels: rows.map((r) => (r.name.length > 34 ? `${r.name.slice(0, 33)}…` : r.name)),
      datasets: [
        { label: 'Done', data: rows.map((r) => r.doneIssues), backgroundColor: C.good, stack: 'a', borderRadius: 2 },
        { label: 'Open in an active sprint', data: rows.map((r) => r.activeOpenIssues), backgroundColor: C.accent, stack: 'a', borderRadius: 2 },
        { label: 'Queued in a backlog', data: rows.map((r) => r.backlogOpenIssues), backgroundColor: C.accent2, stack: 'a', borderRadius: 2 },
        { label: 'Open, neither', data: rows.map((r) => r.openElsewhere), backgroundColor: C.muted, stack: 'a', borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { ...gridScale('issues on collected boards'), beginAtZero: true, stacked: true },
        y: { ...gridScale(), stacked: true },
      },
    },
    _meta: {
      tooltipTitles: rows.map((r) => `${r.key} — ${r.name}`),
      tooltipAfterBody: rows.map(
        (r) =>
          `${r.teams.map((t) => t.team).join(', ')}${r.crossTeam ? ' — spans boards, so no one board view shows it whole' : ''}` +
          ` · ${r.blocked} blocked · ${r.carried} carried 3+ sprints`,
      ),
    },
  };
}
