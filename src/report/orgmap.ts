import type { PeopleEstate } from '../people.js';
import { escapeAttr, escapeHtml } from './format.js';
import { groupByPrefix, type ReportInput, type ReportTeamInput } from './model.js';

// ---------------------------------------------------------------------------
// THE SHAPE OF THE ESTATE: the two pictures this report could not draw.
//
// Every other visual in this file answers a question about a QUANTITY - how
// long, how many, how much left. The two here answer questions about
// STRUCTURE, and a bar chart cannot hold either of them:
//
//   1. WHAT REPORTS TO WHAT. The estate is a three-level hierarchy - the whole
//      estate, the project-prefix groups, the boards inside them - and until
//      now that hierarchy existed only as the order rows happened to appear in.
//      A reader who did not already know the estate had no way to learn from
//      this file that two of the boards are one product.
//   2. WHO IS ON MORE THAN ONE BOARD. people.ts computes this and the people
//      table lists it, but a table of "3 boards" in a cell is a fact you have
//      to assemble in your head across forty rows. As a graph it is the shape
//      of the picture: the people who span teams are the ones in the middle.
//
// WHY TWO DIFFERENT TECHNOLOGIES, which looks like indecision and is not:
//
//   The org chart is SVG, rendered on the SERVER, in the markup. It is a small,
//   fixed, exact structure that must be present on a laptop with scripting
//   blocked and must come out of a printer, and both of those rule out a canvas
//   - a <canvas> prints as a blank rectangle and, with no script, was never
//   drawn in the first place.
//
//   The people graph is WEBGL, drawn on the CLIENT. Its layout is a physics
//   simulation with no closed form, it has to stay at 60fps while the reader
//   drags a node through five hundred edges, and it is an EXPLORATION - it
//   answers a question the reader forms while looking at it, which is exactly
//   the case where an interactive view earns its cost. It degrades in two
//   steps rather than one: WebGL unavailable falls back to the same renderer
//   on a 2D canvas, and scripting blocked falls back to the table underneath,
//   which carries every number the graph encodes. See client.ts.
//
// The rule the rest of the report is written under holds here without
// exception: NOTHING IS ONLY IN A PICTURE. Every figure either visual encodes
// is also written out as text in the same panel.
// ---------------------------------------------------------------------------

// --- the org chart -----------------------------------------------------------

interface TreeNode {
  id: string;
  kind: 'estate' | 'group' | 'board';
  label: string;
  /** The second line inside the box: headcount, board count, whatever the level
   *  can honestly state. */
  meta: string;
  /** Verdict tone, for the status bar down the left edge of the box. */
  tone: 'good' | 'watch' | 'poor' | 'unknown' | 'none';
  /** Things needing action now. Rendered as a count, never as a colour alone. */
  acts: number;
  href?: string;
  children: TreeNode[];
  /** Filled by `layout()`. */
  x: number;
  y: number;
}

const BOX_W = 208;
const BOX_H = 62;
/** Vertical pitch between sibling boxes, box included. */
const ROW = 78;
/** Horizontal pitch between levels, box included. */
const COL = 268;
const PAD = 16;

/** Assigns every node an (x, y) in a tidy left-to-right tree.
 *
 *  This is the Reingold-Tilford result without Reingold-Tilford's machinery,
 *  and it is worth being explicit about why that is legitimate here rather than
 *  a corner cut. The general algorithm needs contour threading because a
 *  subtree can be deeper than its sibling, so two subtrees at different depths
 *  can collide sideways and the fix is to slide whole subtrees apart. THIS tree
 *  cannot do that: every leaf is a board and every board is at the SAME depth -
 *  2 when the group level is drawn, 1 when it is collapsed, never a mix - so
 *  laying the leaves out on a fixed pitch in order and centring each parent on
 *  the span of its children is provably overlap-free and provably centred,
 *  which are the two aesthetics the full algorithm exists to guarantee.
 *
 *  GOTCHA: that argument is load-bearing. If a fourth level is ever added, or a
 *  group is allowed to hold a board AND a sub-group side by side, this stops
 *  being correct and starts producing overlapping boxes - silently, because
 *  nothing here checks. Add the real algorithm at that point rather than
 *  nudging constants. */
function layout(root: TreeNode): { width: number; height: number } {
  let nextLeafSlot = 0;
  const place = (n: TreeNode, depth: number): void => {
    n.x = PAD + depth * COL;
    if (n.children.length === 0) {
      n.y = PAD + nextLeafSlot * ROW;
      nextLeafSlot += 1;
      return;
    }
    for (const c of n.children) place(c, depth + 1);
    const first = n.children[0]!;
    const last = n.children[n.children.length - 1]!;
    n.y = (first.y + last.y) / 2;
  };
  place(root, 0);

  let maxX = 0;
  let maxY = 0;
  const measure = (n: TreeNode): void => {
    maxX = Math.max(maxX, n.x + BOX_W);
    maxY = Math.max(maxY, n.y + BOX_H);
    n.children.forEach(measure);
  };
  measure(root);
  return { width: maxX + PAD, height: maxY + PAD };
}

/** The elbow connector from a parent's right edge to a child's left edge.
 *
 *  An orthogonal elbow rather than a diagonal or a bezier, because this is a
 *  containment hierarchy and a right-angled join is the convention every reader
 *  has already learnt for one. A curve would say "flow", which is what the
 *  cumulative-flow diagram says and this does not. The 8px corner radius is
 *  there only so the join does not alias into a black pixel on a dark page. */
function elbow(parent: TreeNode, child: TreeNode): string {
  const x1 = parent.x + BOX_W;
  const y1 = parent.y + BOX_H / 2;
  const x2 = child.x;
  const y2 = child.y + BOX_H / 2;
  const mid = x1 + (x2 - x1) / 2;
  if (Math.abs(y1 - y2) < 1) return `M${x1} ${y1} H${x2}`;
  const r = Math.min(8, Math.abs(y2 - y1) / 2);
  const dir = y2 > y1 ? 1 : -1;
  return (
    `M${x1} ${y1} H${mid - r} ` +
    `Q${mid} ${y1} ${mid} ${y1 + r * dir} ` +
    `V${y2 - r * dir} ` +
    `Q${mid} ${y2} ${mid + r} ${y2} ` +
    `H${x2}`
  );
}

function nodeSvg(n: TreeNode): string {
  const cls = `org-node org-${n.kind}${n.tone === 'none' ? '' : ` tone-${n.tone}`}`;
  const label = escapeHtml(n.label);
  const meta = escapeHtml(n.meta);
  // The status bar is a SHAPE - a 3px stripe down the left edge - as well as a
  // colour. Colour alone is not a signal for a reader who cannot separate red
  // from amber, and it is not a signal at all on the mono printer this file is
  // routinely put through.
  const bar =
    n.tone === 'none'
      ? ''
      : `<rect class="org-bar" x="0" y="0" width="3" height="${BOX_H}" rx="1.5"/>`;
  const acts =
    n.acts > 0
      ? `<text class="org-acts" x="${BOX_W - 12}" y="24" text-anchor="end">${n.acts} to act on</text>`
      : '';
  // GOTCHA: the bar comes AFTER the box. SVG has no z-index - paint order is
  // document order - so a status stripe emitted first is painted first and then
  // covered by the box that follows it, leaving every node looking untoned with
  // nothing in the markup to suggest why.
  const inner =
    `<rect class="org-box" x="0" y="0" width="${BOX_W}" height="${BOX_H}" rx="7"/>` +
    `${bar}` +
    `<text class="org-label" x="14" y="25">${label}</text>` +
    `<text class="org-meta" x="14" y="44">${meta}</text>` +
    acts;
  const body = n.href
    ? `<a href="${escapeAttr(n.href)}" class="org-link">${inner}</a>`
    : inner;
  return `<g class="${cls}" transform="translate(${n.x},${n.y})">${body}</g>`;
}

/** Builds the estate hierarchy from the same grouping the rest of the page
 *  navigates by, so the diagram cannot drift out of step with the tabs. */
function buildTree(input: ReportInput, people: PeopleEstate | undefined): TreeNode {
  const groups = groupByPrefix(input.teams);
  const headcount = (t: ReportTeamInput): number =>
    people ? people.people.filter((p) => p.boards.some((b) => b.team === t.key)).length : 0;

  // WHEN THE MIDDLE LEVEL IS DROPPED, and why this is not a special case bolted
  // on to make one profile look tidier.
  //
  // The groups are Jira project prefixes. On an estate where every board sits
  // under its own prefix, the group level is a one-to-one relabelling of the
  // board level - three columns of boxes saying the same four things, joined by
  // wires that encode nothing. A hierarchy diagram whose middle rank has a
  // fan-out of exactly one everywhere is not a hierarchy; drawing it anyway
  // asserts a structure that is not there, which is the one thing this report
  // is not allowed to do.
  //
  // So the level is drawn when it GROUPS something and dropped when it does
  // not. The prefix is not lost either way: it stays on the board box, where it
  // is a fact about that board rather than a claim about the estate's shape.
  const grouping = groups.some((g) => g.teams.length > 1);

  const boardNode = (t: ReportTeamInput): TreeNode => {
    const acts = (t.interventions ?? []).filter((i) => i.severity === 'act-now').length;
    const heads = headcount(t);
    const who = heads > 0 ? `${heads} ${heads === 1 ? 'person' : 'people'}` : 'roster not collected';
    return {
      id: `board-${t.key}`,
      kind: 'board',
      label: t.key,
      // Without the group column the prefix has nowhere else to be, so it joins
      // the board's own meta line rather than disappearing.
      meta: grouping ? who : `${t.prefix} · ${who}`,
      tone: t.health.headline,
      acts,
      // Into the team's own tab, through the same hash scheme every other deep
      // link on the page uses - so this is navigation, not decoration.
      href: `#view=teams&team=${encodeURIComponent(t.key)}`,
      children: [],
      x: 0,
      y: 0,
    };
  };

  const groupNodes: TreeNode[] = grouping
    ? groups.map((g) => ({
        id: `group-${g.prefix}`,
        kind: 'group' as const,
        label: g.prefix,
        meta: `${g.teams.length} board${g.teams.length === 1 ? '' : 's'}`,
        tone: 'none' as const,
        acts: 0,
        children: g.teams.map(boardNode),
        x: 0,
        y: 0,
      }))
    : groups.flatMap((g) => g.teams.map(boardNode));

  const boardCount = input.teams.length;
  return {
    id: 'estate',
    kind: 'estate',
    label: input.site,
    meta:
      `${boardCount} board${boardCount === 1 ? '' : 's'}` +
      (grouping ? ` in ${groups.length} groups` : '') +
      (people ? ` · ${people.people.length} people` : ''),
    tone: 'none',
    acts: 0,
    children: groupNodes,
    x: 0,
    y: 0,
  };
}

/** The org chart, as a self-contained inline SVG.
 *
 *  Returns the empty string for a single-board profile: a hierarchy diagram of
 *  one thing is a box, and a box teaches nobody anything. An empty panel that
 *  says "structure" is worse than no panel, because it implies the tool looked
 *  and found nothing rather than that there was nothing to look at. */
export function orgChart(input: ReportInput): string {
  if (input.teams.length < 2) return '';
  const root = buildTree(input, input.people);
  const { width, height } = layout(root);

  const wires: string[] = [];
  const nodes: string[] = [];
  const walk = (n: TreeNode): void => {
    nodes.push(nodeSvg(n));
    for (const c of n.children) {
      wires.push(`<path class="org-wire" d="${elbow(n, c)}"/>`);
      walk(c);
    }
  };
  walk(root);

  // Intrinsic width with max-width:100%, rather than width="100%".
  //
  // width="100%" with a "meet" aspect ratio is the trap: the diagram is 776
  // units wide and the panel is about 1180, so the box stretched to 1180 while
  // the CONTENT stayed at its own scale and pinned itself to the left, leaving
  // 400px of dead canvas nobody could see was canvas. Asking for the natural
  // size and letting max-width shrink it on a narrow screen gives a diagram
  // that is the size it wants to be, left-aligned with everything else on the
  // page, and still fits a phone and a sheet of A4.
  return (
    `<div class="orgchart">` +
    `<svg viewBox="0 0 ${width} ${height}" ` +
    `style="width:${width}px;max-width:100%;height:auto" ` +
    `preserveAspectRatio="xMinYMin meet" role="img" ` +
    `aria-label="Estate hierarchy: ${escapeAttr(input.site)}, ` +
    `${input.teams.length} boards${root.children.some((c) => c.kind === 'group') ? ' in ' + root.children.length + ' groups' : ''}">` +
    `<g class="org-wires">${wires.join('')}</g>` +
    `<g class="org-nodes">${nodes.join('')}</g>` +
    `</svg>` +
    `</div>`
  );
}
