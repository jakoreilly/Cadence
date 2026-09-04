import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Vendored third-party assets, inlined into the generated HTML.
//
// Chart.js is read from node_modules at GENERATION time and embedded in the
// output file. Nothing is fetched when the report is opened, so the "single
// self-contained file that works from file:// on a locked-down laptop" rule
// still holds - see the header of report/index.ts.
//
// Chart.js is only allowed to DRAW. Every number it plots was computed by the
// derive/insights layer and is embedded alongside as literal text in the HTML,
// so a blocked script degrades the page to plain tables rather than to blank
// panels, and there is no client-side path that can arrive at a different
// number from the CLI.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

let cached: string | null = null;

/** Locates the UMD build inside the installed chart.js.
 *
 *  GOTCHA: `require.resolve('chart.js/dist/chart.umd.js')` throws
 *  ERR_PACKAGE_PATH_NOT_EXPORTED. Chart.js 4 declares an `exports` map listing
 *  only ".", "./auto" and "./helpers", and a subpath that is not in the map is
 *  unreachable even though the file is right there on disk - `package.json`
 *  itself is not exported either, so that is no way in.
 *
 *  So the MAIN entry is resolved (allowed: it is "." in the map) and the UMD
 *  build is read from the same directory. The UMD file is what is wanted rather
 *  than the ESM or CJS build because it has to run from a bare inline <script>
 *  with no module loader at all. */
function resolveChartUmd(): string {
  const main = require.resolve('chart.js');
  return join(dirname(main), 'chart.umd.js');
}

export function chartJsSource(): string {
  if (cached !== null) return cached;
  const path = resolveChartUmd();
  // GOTCHA: any occurrence of "</script" inside an inline <script> ends the
  // block early and dumps the rest of the library as page text. Chart.js does
  // not contain one today, but a minifier or a future version easily could, and
  // the failure looks like a corrupted page rather than an escaping bug.
  cached = readFileSync(path, 'utf8').replace(/<\/script/gi, '<\\/script');
  return cached;
}

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built from char codes
// rather than written literally: they are invisible in every editor, so a
// literal one in source is silently destroyed by a stray reformat or by a tool
// that normalises whitespace - and the bug it guards against then comes back
// with no visible diff.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** Embeds a value as JSON inside a <script> block.
 *
 *  Same "</script" GOTCHA as above, plus U+2028/U+2029: both are legal inside a
 *  JSON string but are LINE TERMINATORS in JavaScript source, so a Jira summary
 *  containing one turns the embedded payload into a syntax error and blanks
 *  every chart on the page. JSON.stringify does not escape them. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, '<\\/script')
    .split(LINE_SEP)
    .join('\\u2028')
    .split(PARA_SEP)
    .join('\\u2029');
}
