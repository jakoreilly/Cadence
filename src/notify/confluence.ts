import type { Secrets } from '../types.js';
import { ConfigError } from '../config.js';
import type { InterventionSeverity } from '../interventions.js';

// ---------------------------------------------------------------------------
// The Confluence running log, ported from
// Emberwatch/src/notify/confluence.ts.
//
// Why a wiki page as well as a channel: a Slack message is read once and lost,
// and the question a manager gets asked three weeks later is "how long has that
// been like that". A page that accumulates one row per finding per day answers
// it, in the place the rest of the team's documentation already lives.
//
// The merge-and-re-sort logic is kept almost verbatim from the source repo,
// including its reason for existing: the tool can run twice in a day and must
// then REPLACE the day's row rather than append a byte-identical second copy.
// ---------------------------------------------------------------------------

export interface AlertLogRow {
  /** YYYY-MM-DD, the snapshot date - not the wall-clock date of the run. A row
   *  is a statement about a snapshot, and re-running the tool tomorrow against
   *  an older snapshot must not re-date its findings. */
  date: string;
  team: string;
  severity: InterventionSeverity;
  /** new / escalated / not previously reported. */
  status: string;
  title: string;
  action: string;
  /** The basis notes, joined. Present in the row for the same reason they are in
   *  the Slack message: this page is where somebody will quote the figure from. */
  basis: string;
  links: { label: string; url: string }[];
}

function atlassianAuth(secrets: Secrets): { baseUrl: string; header: string } {
  if (!secrets.atlassianBaseUrl || !secrets.atlassianEmail || !secrets.atlassianApiToken) {
    throw new ConfigError('The Confluence log needs atlassianBaseUrl, atlassianEmail and atlassianApiToken in secrets.local.json');
  }
  const header = 'Basic ' + Buffer.from(`${secrets.atlassianEmail}:${secrets.atlassianApiToken}`).toString('base64');
  return { baseUrl: secrets.atlassianBaseUrl.replace(/\/+$/, ''), header };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SEVERITY_RANK: Record<InterventionSeverity, number> = { 'act-now': 3, 'this-week': 2, watch: 1 };

function severityColour(severity: InterventionSeverity): string {
  return severity === 'act-now' ? 'Red' : severity === 'this-week' ? 'Yellow' : 'Grey';
}

export const LOG_HEADER_ROW =
  '<tr>' +
  ['Snapshot', 'Team', 'Severity', 'Status', 'Finding', 'What to do', 'Basis', 'Open'].map((h) => `<th><p>${h}</p></th>`).join('') +
  '</tr>';

export function buildRowHtml(row: AlertLogRow): string {
  const severityCell =
    `<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${row.severity}</ac:parameter>` +
    `<ac:parameter ac:name="colour">${severityColour(row.severity)}</ac:parameter></ac:structured-macro>`;
  const links = row.links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(', ');
  return (
    '<tr>' +
    `<td><p>${escapeHtml(row.date)}</p></td>` +
    `<td><p>${escapeHtml(row.team)}</p></td>` +
    `<td><p>${severityCell}</p></td>` +
    `<td><p>${escapeHtml(row.status)}</p></td>` +
    `<td><p>${escapeHtml(row.title)}</p></td>` +
    `<td><p>${escapeHtml(row.action)}</p></td>` +
    // Empty rather than absent when there is no caveat: a blank cell reads as
    // "nothing to qualify", and a missing one shifts every column after it.
    `<td><p>${escapeHtml(row.basis)}</p></td>` +
    `<td><p>${links}</p></td>` +
    '</tr>'
  );
}

/** A row's severity, read back out of the status macro buildRowHtml wrote. Rows
 *  in some other shape sort to the bottom rather than randomly interleaved. */
function rowSeverity(rowHtml: string): number {
  const m = rowHtml.match(/<ac:parameter ac:name="title">([a-z-]+)<\/ac:parameter>/);
  const found = m?.[1] as InterventionSeverity | undefined;
  return found && found in SEVERITY_RANK ? SEVERITY_RANK[found] : -1;
}

/** The (snapshot date, team, finding) identity of a row, read back out of the
 *  HTML buildRowHtml wrote. Used to REPLACE a row rather than append a second
 *  copy of it. Returns null for anything that is not a data row - the header, or
 *  a row written in some other shape - so unrecognised rows are always kept,
 *  never silently dropped. */
function rowIdentity(rowHtml: string): string | null {
  const cells = [...rowHtml.matchAll(/<td><p>([\s\S]*?)<\/p><\/td>/g)].map((m) => m[1]);
  if (cells.length < 5) return null;
  return `${cells[0]}|${cells[1]}|${cells[4]}`; // snapshot date | team | finding
}

/** Merges new rows into the table's existing rows and re-sorts the whole tbody
 *  by severity descending, so the act-now entries stay at the top of a table
 *  that grows across many runs rather than only within one run's batch.
 *
 *  The header row (the only `<tr>` containing `<th>`) always stays first, and
 *  Array.prototype.sort is stable, so rows of equal severity keep their existing
 *  order - which is chronological, because that is the order they were appended.
 *
 *  GOTCHA (ported and still true here): `alert` can legitimately run twice
 *  against the same snapshot - once by the scheduled job and once by hand - and
 *  the second run must replace the day's row rather than append a byte-identical
 *  copy of it. */
export function mergeRowsSortedBySeverityDesc(storageHtml: string, newRowsHtml: string[]): string {
  const tbodyMatch = storageHtml.match(/<tbody>([\s\S]*?)<\/tbody>/);
  // The source repo throws here. This one appends a fresh log table instead: the
  // natural first step is to make an empty page and point the profile at it, and
  // "your page has no <tbody>" is a poor answer to a reasonable action.
  if (!tbodyMatch) {
    return (
      storageHtml +
      '<h2>Cadence alert log</h2>' +
      '<p>One row per finding raised, worst first. Written by <code>cadence alert</code>; ' +
      'the Basis column is part of the finding, not a footnote.</p>' +
      `<table><tbody>${LOG_HEADER_ROW}${newRowsHtml.join('')}</tbody></table>`
    );
  }

  const existingRows = [...(tbodyMatch[1] ?? '').matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const headerRows = existingRows.filter((r) => r.includes('<th>'));

  const supersededBy = new Map<string, string>();
  const appended: string[] = [];
  for (const row of newRowsHtml) {
    const id = rowIdentity(row);
    if (id === null) appended.push(row);
    else if (!supersededBy.has(id)) supersededBy.set(id, row);
  }

  const seen = new Set<string>();
  const dataRows: string[] = [];
  for (const row of existingRows.filter((r) => !r.includes('<th>'))) {
    const id = rowIdentity(row);
    const replacement = id !== null ? supersededBy.get(id) : undefined;
    if (replacement !== undefined) {
      if (seen.has(id!)) continue; // an earlier duplicate already collapsed into one
      seen.add(id!);
      dataRows.push(replacement);
    } else {
      dataRows.push(row);
    }
  }
  for (const [id, row] of supersededBy) if (!seen.has(id)) appended.push(row);
  dataRows.push(...appended);

  dataRows.sort((a, b) => rowSeverity(b) - rowSeverity(a));

  const newTbody = `<tbody>${headerRows.join('')}${dataRows.join('')}</tbody>`;
  const start = tbodyMatch.index!;
  return storageHtml.slice(0, start) + newTbody + storageHtml.slice(start + tbodyMatch[0].length);
}

async function confluenceApi(secrets: Secrets, path: string, init: RequestInit = {}): Promise<Record<string, any>> {
  const { baseUrl, header } = atlassianAuth(secrets);
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: header, 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (!resp.ok) throw new Error(`Confluence API ${path} failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as Record<string, any>;
}

export async function appendLogRows(secrets: Secrets, pageId: string, rows: AlertLogRow[]): Promise<string> {
  if (rows.length === 0) return '';
  const page = await confluenceApi(secrets, `/wiki/api/v2/pages/${pageId}?body-format=storage`);
  const newBody = mergeRowsSortedBySeverityDesc(page.body.storage.value, rows.map(buildRowHtml));
  await confluenceApi(secrets, `/wiki/api/v2/pages/${pageId}`, {
    method: 'PUT',
    body: JSON.stringify({
      id: pageId,
      status: 'current',
      title: page.title,
      spaceId: page.spaceId,
      body: { representation: 'storage', value: newBody },
      version: { number: page.version.number + 1, message: 'cadence alert: append findings' },
    }),
  });
  return String(page.title);
}
