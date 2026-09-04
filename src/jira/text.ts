// ---------------------------------------------------------------------------
// Turning Jira rich text into something a report can print.
//
// Jira Cloud's v3 REST API returns descriptions and comment bodies as ADF
// (Atlassian Document Format) - a nested JSON document, NOT a string. The v2
// API returns wiki markup, which IS a string. Both shapes reach this codebase:
// v3 for issues, and any future v2 call for comments, so every reader has to
// cope with both or it silently prints "[object Object]".
//
// Everything here is truncated at COLLECTION time rather than at render time.
// The snapshot is the durable artifact and is committed to the repo: keeping
// full descriptions for 20,700 issues would multiply its size for text that no
// panel is ever going to show. What the UI needs is enough to recognise the
// ticket, not a mirror of Jira.
// ---------------------------------------------------------------------------

/** Text nodes that carry meaning but no `text` property of their own. */
function nodeText(node: any): string {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'text':
      return typeof node.text === 'string' ? node.text : '';
    // A mention renders as a name in Jira and as nothing at all if it is
    // skipped, which turns "blocked waiting on @Sandeep" into "blocked waiting
    // on" - the opposite of the sentence's meaning.
    case 'mention':
      return node.attrs?.text ? String(node.attrs.text) : '@user';
    case 'emoji':
      return node.attrs?.shortName ? String(node.attrs.shortName) : '';
    case 'hardBreak':
      return '\n';
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ? String(node.attrs.url) : '';
    case 'status':
      return node.attrs?.text ? `[${node.attrs.text}]` : '';
    case 'date':
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : '';
    default:
      return '';
  }
}

/** Nodes after which a line break belongs, so a bulleted list does not come out
 *  as one run-on sentence. */
const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'panel', 'rule', 'tableRow',
]);

function walk(node: any, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const own = nodeText(node);
  if (own) out.push(own);
  if (Array.isArray(node.content)) walk(node.content, out);
  if (BLOCK_TYPES.has(node.type)) out.push('\n');
}

/** Collapses whitespace without destroying paragraph boundaries entirely.
 *  Newlines survive as a single space because the report renders these in a
 *  one- or two-line hover card, where a preserved line break just wastes the
 *  space that would have shown more words. */
function collapse(s: string): string {
  return s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').replace(/ ·( ·)+/g, ' · ').trim().replace(/^·\s*/, '').replace(/\s*·$/, '');
}

export interface Excerpt {
  text: string;
  truncated: boolean;
}

/** Flattens an ADF document, a wiki-markup string, or null into bounded plain
 *  text.
 *
 *  GOTCHA: an empty ADF document is `{type:'doc',content:[{type:'paragraph'}]}`,
 *  not null and not an empty string. Testing the RAW value for truthiness
 *  therefore reports every empty description as present, and the UI then draws a
 *  "description" row containing nothing. Emptiness is decided on the FLATTENED
 *  text, which is the only representation that can be empty in one way. */
export function excerpt(raw: unknown, maxChars: number): Excerpt | undefined {
  if (raw === null || raw === undefined) return undefined;
  let text: string;
  if (typeof raw === 'string') text = collapse(raw);
  else if (typeof raw === 'object') {
    const parts: string[] = [];
    walk(raw, parts);
    text = collapse(parts.join(' '));
  } else text = collapse(String(raw));

  if (!text) return undefined;
  if (text.length <= maxChars) return { text, truncated: false };
  // Cut on a word boundary where one is close by, so the excerpt does not end
  // mid-word for the sake of four characters.
  const cut = text.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return { text: (space > maxChars * 0.7 ? cut.slice(0, space) : cut).trimEnd(), truncated: true };
}

// ---------------------------------------------------------------------------
// Blocker links
// ---------------------------------------------------------------------------

/** Link-type names that mean "this cannot proceed until that is done".
 *
 *  GOTCHA: the direction words are CONFIGURABLE PER SITE and the pair is
 *  asymmetric - Jira's default "Blocks" link type has outward text "blocks" and
 *  inward text "is blocked by", but sites rename them ("Blocked by",
 *  "Dependency"). Matching on `type.name` alone cannot tell the two ends apart,
 *  and matching on direction alone assumes the default naming. So the DIRECTION
 *  TEXT already stored on each link is what is tested, lower-cased, and the
 *  phrase "blocked by" is what decides - it is the one form that is unambiguous
 *  in both the default and every rename observed. */
export function classifyBlockers(links: Array<{ type: string; direction: 'inward' | 'outward'; key: string }>): {
  blockedBy: string[];
  blocks: string[];
} {
  const blockedBy: string[] = [];
  const blocks: string[] = [];
  for (const l of links) {
    const t = l.type.toLowerCase();
    if (t.includes('blocked by') || t.includes('is blocked')) blockedBy.push(l.key);
    else if (t.includes('block')) blocks.push(l.key);
  }
  return {
    blockedBy: [...new Set(blockedBy)].sort(),
    blocks: [...new Set(blocks)].sort(),
  };
}
