import type { HealthTone } from '../insights.js';

// ---------------------------------------------------------------------------
// The vocabulary the whole report is written in.
//
// Two things live here that are worth naming, because they are the answer to
// "the reader knows nothing and must still be informed":
//
//   `tip()`   - a hover card. Every ticket key, every person, every metric that
//               has a definition carries one. It degrades to the native `title`
//               attribute when scripting is blocked, so the explanation survives
//               on the locked-down laptop this file exists to open on.
//
//   `explain()` - a collapsed "what this means / what to do" block. Written for
//               somebody who has never seen a burndown, closed by default so it
//               does not patronise the reader who has. This is what makes the
//               report legible to senior management without turning it into a
//               training deck.
//
// The escaping rule is strict and asymmetric on purpose: anything named
// `...Html` is TRUSTED and its caller must have escaped its own dynamic parts;
// everything else is escaped here. The names carry the contract so it is
// visible at the call site rather than only in the body.
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaping for a value going into an attribute that JavaScript will later read
 *  back out and render. Same rules, plus newlines, which break an attribute. */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, ' ');
}

export const fmt = (v: number | null | undefined, d = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d);
export const int = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : String(Math.round(v));
export const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
export const rate = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`;

/** A day count as something a person says out loud. "3 days" beats "3.0 d" in
 *  a sentence and loses nothing: nobody acts differently on 3.2 days. */
export function days(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const n = Math.round(v);
  return `${n} day${n === 1 ? '' : 's'}`;
}

export function hours(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v < 48) return `${v.toFixed(1)}h`;
  return `${(v / 24).toFixed(1)}d`;
}

/** Trailing token of a sprint name, for a chart axis where the full name will
 *  not fit. "Core Sprint - 2026 S17" -> "S17", "onboarding-hub B# Sprint 61" -> "61". */
export function shortSprintLabel(name: string): string {
  const m = /(\S+)\s*$/.exec(name.trim());
  return m ? m[1]!.slice(0, 8) : name.slice(0, 8);
}

// --- hover cards ---------------------------------------------------------------

/** Wraps content in a hover card.
 *
 *  GOTCHA: the native `title` attribute is set as well as `data-tip`, and that
 *  duplication is deliberate rather than sloppy. `data-tip` drives the styled
 *  card, which can carry several lines and survives on a touch screen; `title`
 *  is what a reader gets when the inline script is blocked, which on the
 *  locked-down corporate laptop this report is built for is a normal Tuesday. A
 *  tooltip that exists only in JavaScript is a tooltip that does not exist for
 *  the audience that most needs it. The client script REMOVES the title when it
 *  takes over, so the two never render on top of each other. */
export function tip(innerHtml: string, text: string, extraClass = ''): string {
  if (!text) return innerHtml;
  const t = escapeAttr(text);
  return `<span class="tip ${extraClass}" data-tip="${t}" title="${t}" tabindex="0">${innerHtml}</span>`;
}

/** A term with a definition attached. Used for every piece of jargon on the
 *  page - p90, carryover, WIP, cycle time - so the reader never has to already
 *  know one to read the sentence it is in. */
export function term(label: string, definition: string): string {
  return `<span class="term tip" data-tip="${escapeAttr(definition)}" title="${escapeAttr(definition)}" tabindex="0">${escapeHtml(label)}</span>`;
}

// --- expandable explainers ------------------------------------------------------

/** A collapsed block. `bodyHtml` is TRUSTED. */
export function expander(summaryText: string, bodyHtml: string, opts: { open?: boolean; kind?: string } = {}): string {
  return `<details class="expander ${opts.kind ?? ''}"${opts.open ? ' open' : ''}>
    <summary>${escapeHtml(summaryText)}</summary>
    <div class="expander-body">${bodyHtml}</div>
  </details>`;
}

/** The standard "I have never seen this before" block: what the panel is
 *  measuring, why it matters, and what a reader is supposed to do with it.
 *
 *  All three are required arguments. A panel that cannot say what to do with
 *  its number probably should not be on the page, and making the field optional
 *  is how that check gets skipped. */
export function explain(what: string, why: string, action: string): string {
  return expander('What this is, and what to do with it', `
    <dl class="explain">
      <dt>What it measures</dt><dd>${what}</dd>
      <dt>Why it matters</dt><dd>${why}</dd>
      <dt>What to do</dt><dd>${action}</dd>
    </dl>`);
}

// --- small components -----------------------------------------------------------

/** One KPI tile. `label` and `value` are escaped; `noteHtml` is TRUSTED. */
export function kpi(
  label: string,
  value: string,
  noteHtml: string,
  tone: HealthTone | '' = '',
  definition?: string,
): string {
  const labelHtml = definition ? term(label, definition) : escapeHtml(label);
  return `<div class="kpi ${tone}"><div class="label">${labelHtml}</div>` +
    `<div class="value">${escapeHtml(value)}</div><div class="note">${noteHtml}</div></div>`;
}

export function tag(kind: 'sound' | 'weak' | 'unusable' | 'caveat' | 'new', text: string, definition?: string): string {
  const inner = definition
    ? `<span class="tip" data-tip="${escapeAttr(definition)}" title="${escapeAttr(definition)}" tabindex="0">${escapeHtml(text)}</span>`
    : escapeHtml(text);
  return `<span class="tag ${kind}">${inner}</span>`;
}

/** An external link. Every one in this report opens a new tab, because the
 *  report is a file the reader came back to and losing it to a navigation is a
 *  small betrayal. `rel=noopener` because `target=_blank` without it hands the
 *  opened page a handle on this one. */
export function link(href: string, text: string, cls = ''): string {
  if (!href) return escapeHtml(text);
  return `<a class="${cls}" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/** An empty-state that says NOTHING WAS MEASURED, as distinct from measuring
 *  zero. The two look identical on a dashboard and mean opposite things - a
 *  burndown drawn from one observation is a flat line, and a flat line is the
 *  picture of a sprint going perfectly. */
export function notYet(titleText: string, bodyHtml: string): string {
  return `<div class="notyet"><strong>${escapeHtml(titleText)}</strong> ${bodyHtml}</div>`;
}

/** A trend as an inline SVG, sized to sit inside a table cell.
 *
 *  Deliberately NOT a Chart.js instance. A sparkline per portfolio row is four
 *  more canvases, four more Chart handles to destroy and rebuild on every theme
 *  change, and four more things that lay out at zero width inside a hidden tab.
 *  An SVG is markup: it paints with the page, prints with the page, needs no
 *  script at all, and survives the locked-down laptop this file exists to open
 *  on - which is the same argument every other choice on this page was made on.
 *
 *  It carries no axis and no labels, because a sparkline is not a chart and
 *  pretending otherwise invites somebody to read a value off it. The numbers it
 *  draws are in the row beside it, and the tooltip states the range so the
 *  shape can never be the only source.
 *
 *  Nulls break the line rather than being drawn as zero - the same rule as
 *  everywhere else here. A missing sprint is not a sprint that delivered
 *  nothing. */
export function sparkline(
  values: Array<number | null>,
  opts: { width?: number; height?: number; title?: string } = {},
): string {
  const w = opts.width ?? 84;
  const h = opts.height ?? 20;
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length < 2) return `<span class="spark-none" title="Not enough history to draw a trend">—</span>`;

  const max = Math.max(...real);
  const min = Math.min(...real);
  // A flat series would divide by zero and, worse, would draw along the top or
  // the bottom edge depending on which way the rounding fell. Centred instead:
  // a flat line down the middle is what "this never changed" looks like.
  const range = max - min || 1;
  const pad = 1.5;
  const x = (i: number): number => (values.length < 2 ? w / 2 : pad + (i / (values.length - 1)) * (w - pad * 2));
  const y = (v: number): number => (max === min ? h / 2 : h - pad - ((v - min) / range) * (h - pad * 2));

  // Broken into segments so a null leaves a gap instead of a straight line
  // across the missing observation.
  //
  // A run of exactly ONE point cannot be a polyline, and dropping it would
  // erase an observation that happened - which is the opposite of the rule this
  // whole file follows about the difference between "no value" and "zero". It
  // is drawn as a lone mark instead.
  const segments: string[] = [];
  const isolated: string[] = [];
  let run: Array<{ x: number; y: number }> = [];
  const flush = (): void => {
    if (run.length > 1) segments.push(run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    else if (run.length === 1) {
      isolated.push(`<circle cx="${run[0]!.x.toFixed(1)}" cy="${run[0]!.y.toFixed(1)}" r="1.3" class="spark-dot"/>`);
    }
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      flush();
      return;
    }
    run.push({ x: x(i), y: y(v) });
  });
  flush();

  const lastIndex = values.reduce<number>((acc, v, i) => (v !== null && Number.isFinite(v) ? i : acc), -1);
  const lastValue = lastIndex >= 0 ? (values[lastIndex] as number) : null;
  const dot =
    lastValue === null
      ? ''
      : `<circle cx="${x(lastIndex).toFixed(1)}" cy="${y(lastValue).toFixed(1)}" r="1.9" class="spark-dot"/>`;

  const title = opts.title ?? `${real.length} observations, ${min} to ${max}`;
  return `<span class="spark" data-tip="${escapeAttr(title)}" title="${escapeAttr(title)}"><svg viewBox="0 0 ${w} ${h}"
    width="${w}" height="${h}" role="img" aria-label="${escapeAttr(title)}" focusable="false">${segments
      .map((pts) => `<polyline points="${pts}" fill="none" class="spark-line"/>`)
      .join('')}${isolated.join('')}${dot}</svg></span>`;
}

export function toneOfRate(v: number | null, watchAt: number, poorAt: number): HealthTone {
  if (v === null) return 'unknown';
  return v >= poorAt ? 'poor' : v >= watchAt ? 'watch' : 'good';
}

/** The figures behind a chart, collapsed.
 *
 *  The rule this satisfies is "every number a chart plots is also written as text,
 *  so a blocked script degrades to readable tables rather than blank panels". That
 *  rule requires the table to be PRESENT, not to be open - and `expander` is
 *  already force-opened by the print stylesheet, the print button, the
 *  scripting-blocked stylesheet and Expand all. So this costs nothing
 *  doctrinally and returns about a fifth of a team panel.
 *
 *  `rows` is stated in the summary so the reader knows the size of what they are
 *  opening. It is also the hook for a future row cap: cap inside here plus an
 *  inner expander for the remainder, and no call site changes.
 *
 *  `tableHtml` is TRUSTED, exactly as `expander`'s body is.
 */
export function figures(rows: number, tableHtml: string): string {
  const label = rows === 1 ? 'the 1 figure behind this chart' : `the ${rows} figures behind this chart`;
  return expander(label, tableHtml, { kind: 'figures' });
}

