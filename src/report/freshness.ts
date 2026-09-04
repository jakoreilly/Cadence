import type { SchemaAssessment } from '../schema.js';
import { escapeHtml, expander } from './format.js';

// ---------------------------------------------------------------------------
// "Is what you are reading actually current?" - rendered where it cannot be
// missed.
//
// This banner is the HTML half of src/schema.ts and it sits ABOVE the hand-off
// banner deliberately, because the failure it guards against is not a reader
// who is confused. It is a reader who is not confused at all: 109 "not
// collected" markers spread across 21 panels read as "that panel has nothing in
// it today", and the report goes to senior management looking finished.
//
// Three constraints, all learned the hard way elsewhere on this page:
//   - it is NOT inside a <details>. A collapsed warning is a warning nobody
//     opens, and on a scripting-blocked laptop a <summary> the reader cannot
//     expand is content that is simply gone.
//   - it survives print. Somebody will print this and hand it round; a paper
//     copy that has quietly dropped the "these numbers are from old code"
//     notice is worse than no notice at all.
//   - it names the FIELDS and the COMMAND. "Schema 2 < 4" tells the reader
//     nothing they can act on. "No ticket titles, no comment threads - run
//     collect --force" tells them everything.
// ---------------------------------------------------------------------------

const num = (n: number): string => n.toLocaleString('en-GB');

/** Returns '' when the snapshot is current, so the caller interpolates it
 *  unconditionally and has no condition of its own to get wrong. */
export function freshnessBanner(assessment: SchemaAssessment | undefined): string {
  if (!assessment || !assessment.stale) return '';

  const behind = assessment.files.filter((f) => f.behind);
  const cmd = `node dist/src/cli.js ${assessment.remedy ?? 'collect --force'} --profile &lt;your profile&gt;`;

  const behindHtml = behind
    .map(
      (f) => `<li><code>${escapeHtml(f.file)}.json</code> was written by older code
        (schema&nbsp;${escapeHtml(String(f.found))}, this build expects&nbsp;${escapeHtml(String(f.expected))}).
        ${
          f.missing.length > 0
            ? `Not in this file, so every panel built on it says &ldquo;not collected&rdquo;:
               <ul class="plain">${f.missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
            : 'Nothing this particular file carries changed &mdash; the stamp is simply old.'
        }</li>`,
    )
    .join('');

  const gapsHtml = assessment.gaps
    .map(
      (g) => `<li><strong>${escapeHtml(g.what)}</strong>: ${escapeHtml(num(g.present))} of
        ${escapeHtml(num(g.total))} ${escapeHtml(g.scope)} carry it &mdash; ${escapeHtml(g.cause)}.</li>`,
    )
    .join('');

  return `<section class="stale" id="stale-data" role="alert">
    <div class="stale-head">
      <span class="stale-badge">Read this before you quote anything below</span>
      <h2>This report was rendered against a snapshot that cannot answer everything the tool now asks</h2>
      <p class="lede">${escapeHtml(assessment.headline ?? '')}</p>
    </div>
    ${behindHtml ? `<ul class="plain stale-list">${behindHtml}</ul>` : ''}
    ${gapsHtml ? `<ul class="plain stale-list">${gapsHtml}</ul>` : ''}
    <p class="stale-fix">Re-collect, then regenerate: <code>${cmd}</code></p>
    ${expander('Why this warning exists', `
      <p>An empty panel and an un-collected panel look identical, and the difference between them is the
        difference between &ldquo;this team has no blockers&rdquo; and &ldquo;we did not look&rdquo;. This tool
        shipped a whole layer of ticket context once, rendered it against a snapshot written before that layer
        existed, and printed &ldquo;not collected&rdquo; 109 times in a report that read as complete.</p>
      <p><strong>A snapshot stamped at the current version is not proof its content is there.</strong> Collecting
        with <code>--no-issue-detail</code> or <code>--no-review-detail</code> produces a current-version file with
        none of that content in it, so this check counts the fields as well as reading the stamp.</p>
      <p>Snapshots are immutable by design and a day cannot be backfilled, so <code>--force</code> REPLACES the
        day rather than adding one. That is the right trade here &mdash; a day recorded by code that could not see
        half the fields is not a day worth keeping &mdash; but it is a real loss and worth knowing about.</p>`)}
  </section>`;
}
