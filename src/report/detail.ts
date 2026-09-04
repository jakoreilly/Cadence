import { gitlabProjectUrl, issueUrl } from '../links.js';
import type {
  BlockerEdge,
  DiscussedItem,
  FlaggedRegister,
  MixEntry,
  RosterSummary,
  SubtaskStructure,
  TaxonomySummary,
} from '../taxonomy.js';
import { escapeHtml, expander, explain, figures, kpi, link, notYet, pct, rate, term, tip } from './format.js';
import { nouns, openAllLink, ticketWithTitle, type RenderContext } from './panels.js';

// ---------------------------------------------------------------------------
// The business-and-dev detail panels.
//
// The delivery panels answer "is this team OK". These answer the questions a
// person asks when the answer is no: what kind of work is this, who is on it,
// which specific tickets are on fire, and what is holding what up.
//
// They follow the same three rules as every other panel here - a plain-English
// lede, a collapsed explainer for a reader who has never seen the board, and a
// route out to the live system on every identifier - plus one of their own:
//
//   A CATEGORICAL BREAKDOWN MUST STATE ITS SCOPE IN THE SAME SENTENCE AS ITS
//   NUMBER. "62% of this board is bugs" is nearly always a statement about a
//   decade of closed tickets. The same figure over the active sprint is a
//   statement about this fortnight, and only the second one is actionable. Every
//   table here is scoped and says so in its own heading, not in a legend.
// ---------------------------------------------------------------------------

const SCOPE_LABEL: Record<string, string> = {
  active: 'in the active sprint',
  backlog: 'on the backlog',
  recent: 'resolved recently',
  all: 'everything on the board',
};

/** A horizontal share bar. Width is the share of the LARGEST bucket, not of the
 *  total, so a mix with one dominant category still shows readable bars for the
 *  tail - the tail is where the interesting categories are. The number beside
 *  it is always the true share, so the bar is decoration and the figure is the
 *  fact. */
function mixRows(entries: MixEntry[], total: number, limit: number, opts: { showOpen?: boolean } = {}): string {
  const top = entries.slice(0, limit);
  const max = top.reduce((m, e) => Math.max(m, e.issues), 0) || 1;
  return top
    .map(
      (e) => `<tr>
        <td>${escapeHtml(e.name)}</td>
        <td class="num" data-sort="${e.issues}">${e.issues}</td>
        <td class="bar-cell"><span class="bar" style="width:${Math.round((e.issues / max) * 100)}%"></span>
          <span class="bar-label">${pct(e.issues, total)}</span></td>
        ${opts.showOpen ? `<td class="num" data-sort="${e.open}">${e.open}</td>` : ''}
        <td class="num" data-sort="${e.points}">${e.points > 0 ? e.points : '<span class="muted">—</span>'}</td>
      </tr>`,
    )
    .join('');
}

/** `bare` is for a `mixTable` called from INSIDE `scopeTable`'s own `expander`
 *  below - wrapping it there would put a `details` inside a `details`, which
 *  is valid HTML but renders as two chevrons and two clicks for one table. */
function mixTable(title: string, entries: MixEntry[], total: number, limit: number, opts: { showOpen?: boolean; note?: string; bare?: boolean } = {}): string {
  if (entries.length === 0) return '';
  const table = `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>${escapeHtml(title)}</th><th class="num">Issues</th><th>Share</th>${
        opts.showOpen ? '<th class="num">Open</th>' : ''
      }<th class="num">Points</th></tr></thead>
      <tbody>${mixRows(entries, total, limit, opts)}</tbody></table></div>`;
  return `<div class="mix-block">
    <h4>${escapeHtml(title)}</h4>
    ${opts.bare ? table : figures(Math.min(entries.length, limit), table)}
    ${opts.note ? `<p class="footnote">${opts.note}</p>` : ''}
    ${entries.length > limit ? `<p class="footnote muted">${entries.length - limit} more not shown.</p>` : ''}
  </div>`;
}

/** What kind of work is this board carrying, right now. */
export function taxonomyPanel(ctx: RenderContext, t: { key: string; prefix: string; taxonomy?: TaxonomySummary; taxonomyBacklog?: TaxonomySummary; taxonomyRecent?: TaxonomySummary }): string {
  const tx = t.taxonomy;
  if (!tx) return notYet('Work mix not computed', 'No issue taxonomy was derived for this team.');
  if (tx.issues === 0) return `<p class="lede">No work in the active sprint to break down.</p>`;

  const estimated = tx.issues - tx.unestimated;
  const bugTone = tx.bugShare === null ? '' : tx.bugShare >= 0.4 ? 'poor' : tx.bugShare >= 0.25 ? 'watch' : 'good';

  const scopeTable = (label: string, s: TaxonomySummary | undefined): string => {
    if (!s || s.issues === 0) return '';
    return expander(`${label} — ${s.issues} issues`, `
      ${mixTable('Type', s.types, s.issues, 8, { showOpen: s.scope !== 'recent', bare: true })}
      ${mixTable('Priority', s.priorities, s.issues, 6, { showOpen: s.scope !== 'recent', bare: true })}
      ${mixTable('Label', s.labels, s.issues, 8, { note: 'Labels are multi-valued, so shares do not sum to 100%.', bare: true })}
      ${mixTable('Component', s.components, s.issues, 8, { note: 'Components are multi-valued, so shares do not sum to 100%.', bare: true })}`);
  };

  return `
    <p class="lede">What the ${escapeHtml(t.prefix)} board is actually carrying ${SCOPE_LABEL.active}: the mix of
      ${term('issue types', 'The Jira type on the ticket — Story, Bug, Task, Sub-task and whatever else this site has configured. Read as-is: this site uses BOTH "Bug" and "Defect (Standalone)", so a tool that counted only "Bug" would under-report broken things by roughly half.')},
      priorities and labels. This is the answer to "what does this team spend its fortnight on".</p>
    <div class="kpis">
      ${kpi('In the active sprint', String(tx.issues), `${tx.points} pts estimated`)}
      ${kpi('Estimated', pct(estimated, tx.issues), `${estimated} of ${tx.issues} carry points`, estimated / tx.issues < 0.5 ? 'watch' : 'good',
        'Share of the sprint carrying a story-point estimate in either of this site’s two point fields. Below two-thirds, any points total is a lower bound rather than a measure.')}
      ${kpi('Broken things', tx.bugShare === null ? '—' : rate(tx.bugShare), 'bugs, defects and incidents', bugTone as never,
        'Share of the active sprint whose issue type reads as something broken — Bug, Defect, Incident or Problem, matched as text because sites rename these. A high share is not automatically bad; it is bad when the team believes it is building features.')}
      ${kpi('Distinct types', String(tx.types.length), 'type names in use')}
    </div>
    ${mixTable('Type', tx.types, tx.issues, 10, { showOpen: true })}
    ${mixTable('Priority', tx.priorities, tx.issues, 6, { showOpen: true, note: 'A board where nearly everything is one priority is a board where priority is not being used to decide anything.' })}
    ${mixTable('Label', tx.labels, tx.issues, 8, { note: 'Labels are multi-valued, so shares do not sum to 100%. Labels are usually where a team hides its real categories — release trains, workstreams, tech debt.' })}
    ${mixTable('Component', tx.components, tx.issues, 8, { note: 'Components are multi-valued, so shares do not sum to 100%.' })}
    <h4>The same mix over other scopes</h4>
    ${scopeTable('On the backlog', t.taxonomyBacklog)}
    ${scopeTable(`Resolved in the last ${ctx.windowDays} days`, t.taxonomyRecent)}
    ${explain(
      'The mix of issue types, priorities, labels and components across the work in the active sprint, with the backlog and recently-resolved work available for comparison.',
      'It is the difference between "the team is behind" and "the team is behind because two thirds of the sprint is unplanned bug work". A delivery number tells you something is wrong; this tells you what kind of wrong. Comparing the sprint mix against the backlog mix also shows whether the team is working on what it said it would.',
      'Look for a bug share that is much higher in the sprint than on the backlog — that is unplanned work arriving mid-sprint. Look for a priority column where everything is one value, which means priority is decorative. If the labels here mean nothing to you, ask the team what they are: they are usually the team’s real taxonomy.',
    )}`;
}

/** Parent tickets and their children. */
export function subtaskPanel(ctx: RenderContext, t: { key: string; subtasks?: SubtaskStructure }): string {
  const s = t.subtasks;
  if (!s) return notYet('Subtask structure not computed', 'No parent/child breakdown was derived for this team.');
  if (s.parentsWithChildren === 0) {
    return `<p class="lede">Nothing on this board is broken into subtasks. That is not a defect &mdash; plenty of
      teams work in whole tickets &mdash; but it does mean a large ticket here gives no visible progress until it is finished.</p>`;
  }

  const rows = s.parents
    .map(
      (p) => `<tr class="${p.stalledParent ? 'row-alert' : ''}">
      <td class="key-cell">${ticketWithTitle(ctx, { key: p.key, summary: p.summary, issueType: p.issueType, status: p.status, assignee: p.assignee })}</td>
      <td>${escapeHtml(p.issueType)}</td>
      <td>${escapeHtml(p.status)}</td>
      <td class="num" data-sort="${p.children}">${p.children}</td>
      <td class="num" data-sort="${p.childrenDone}">${p.childrenDone}</td>
      <td class="bar-cell"><span class="bar ${p.stalledParent ? 'bar-alert' : ''}" style="width:${Math.round((p.childrenDone / p.children) * 100)}%"></span>
        <span class="bar-label">${pct(p.childrenDone, p.children)}</span></td>
      <td>${p.stalledParent ? '<span class="tag caveat">all children done, parent open</span>' : `${openAllLink(ctx, p.childKeys, 'children')}`}</td>
    </tr>`,
    )
    .join('');

  return `
    <p class="lede">${s.parentsWithChildren} ticket${s.parentsWithChildren === 1 ? '' : 's'} on this board
      ${s.parentsWithChildren === 1 ? 'is' : 'are'} broken into ${s.children} ${term('child issues', 'A subtask or child issue — a piece of work tracked underneath a parent ticket. The parent is usually the thing the business asked for; the children are how the team chose to build it.')}.
      The rows worth your attention are at the top.</p>
    <div class="kpis">
      ${kpi('Parents with children', String(s.parentsWithChildren), `${s.children} child issues in total`)}
      ${kpi('Finished but still open', String(s.stalledParents), 'every child done, parent is not', s.stalledParents > 0 ? 'watch' : 'good',
        'Parent tickets where every single child is closed and the parent itself is not. Either somebody forgot to close it, or there is work in the parent that was never written down as a child. Both are worth a one-line question.')}
      ${kpi('Children with no parent here', String(s.orphanChildren.length), 'parent is on another board',
        '', 'The child names a parent that is not on this board. Usually legitimate — cross-team work — but it is why these tickets look unattached in every other view.')}
    </div>
    <div class="table-scroll"><table data-sortable>
      <thead><tr><th>Parent</th><th>Type</th><th>Status</th><th class="num">Children</th><th class="num">Done</th><th>Progress</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${
      s.orphanChildren.length > 0
        ? expander(`${s.orphanChildren.length} child issue(s) whose parent is not on this board`, `<ul class="plain">${s.orphanChildren
            .map((o) => `<li>${ticketWithTitle(ctx, { key: o.key, summary: o.summary })} &rarr; parent ${escapeHtml(o.parentKey)}</li>`)
            .join('')}</ul>`)
        : ''
    }
    ${explain(
      'Parent tickets on this board and how many of their subtasks are finished. Epics are deliberately excluded — an epic is a container for a quarter of work, not a subtask parent, and including them would bury the real structure.',
      'Subtask completion is the only progress signal that exists inside a ticket. A parent at 6 of 7 children is nearly done; a parent at 0 of 9 has not started, and on a status board both look identical because both say "In Progress". It is also the cheapest way to spot work that is actually finished and simply never closed.',
      'Start with the rows marked "all children done, parent open" — those are usually a five-second fix and they are inflating this team’s carryover and WIP. Then look for parents with many children and none done: that is work that was planned and never picked up.',
    )}`;
}

/** The tickets people are arguing about. */
export function discussionPanel(ctx: RenderContext, t: { key: string; discussed?: DiscussedItem[]; commentScope?: string }): string {
  const items = t.discussed;
  if (!items) return notYet('Comment detail not collected', 'Run <code>collect</code> without <code>--no-issue-detail</code> to gather comment counts and threads.');
  if (items.length === 0) return `<p class="lede">No open work on this board has any comments on it.</p>`;

  const rows = items
    .map(
      (i) => `<tr>
      <td class="key-cell">${ticketWithTitle(ctx, { key: i.key, summary: i.summary, issueType: i.issueType, status: i.status, assignee: i.assignee, sprintCount: i.sprintCount })}</td>
      <td class="num" data-sort="${i.commentCount}"><strong>${i.commentCount}</strong></td>
      <td>${escapeHtml(i.status)}</td>
      <td>${i.assignee ? escapeHtml(i.assignee) : '<span class="muted">unassigned</span>'}</td>
      <td class="num" data-sort="${i.sprintCount}">${i.sprintCount}</td>
      <td>${i.flagged ? '<span class="tag caveat">flagged</span>' : ''}</td>
    </tr>
    ${
      i.latestComment
        ? `<tr class="quote-row"><td colspan="6"><blockquote class="comment">
            <span class="comment-meta">${escapeHtml(i.latestComment.author ?? 'someone')} &middot; ${escapeHtml(i.latestComment.created.slice(0, 10))}</span>
            ${escapeHtml(i.latestComment.body)}${i.latestComment.truncated ? '<span class="muted"> […]</span>' : ''}
          </blockquote></td></tr>`
        : ''
    }`,
    )
    .join('');

  return `
    <p class="lede">The open tickets with the most conversation on them. A long comment thread is the cheapest
      available signal that a ticket is <em>contested, confusing or stuck</em> &mdash; and unlike a flag, nobody has
      to remember to set it. Arguing about a ticket <em>is</em> the signal.</p>
    <div class="table-scroll"><table data-sortable>
      <thead><tr><th>Ticket</th><th class="num">Comments</th><th>Status</th><th>Owner</th><th class="num">Sprints</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="footnote">Quotes are verbatim and truncated at collection time &mdash; a paraphrase of somebody's comment
      is a claim about what they meant. ${t.commentScope ? escapeHtml(t.commentScope) : ''}</p>
    ${explain(
      'Open tickets ranked by how many comments they carry, with the most recent comment quoted underneath.',
      'Comment volume finds the trouble that no formal field captures. The Flagged field only fires when somebody remembers to set it; a comment thread grows on its own. A ticket with twenty comments and three sprints of carryover is a decision nobody has made, and it will keep costing the team a fortnight at a time until somebody makes it.',
      'Read the quotes, not the counts. If the latest comment is a question addressed to somebody outside the team, that ticket is waiting on a person and you are the one who can go and get them. If it is an argument about scope, it needs a decision rather than more sprint capacity.',
    )}`;
}

/** Everything somebody marked as blocked. */
export function flaggedPanel(ctx: RenderContext, t: { key: string; flagged?: FlaggedRegister }): string {
  const f = t.flagged;
  if (!f) return notYet('Flag register not computed', 'No flagged-issue register was derived for this team.');
  if (f.total === 0) {
    return `<p class="lede">Nothing on this board is flagged. Read that carefully: it means nobody has <em>set</em>
      a flag, which is not the same as nothing being blocked. The discussion and blocker panels are where an
      unflagged blocker actually shows up.</p>`;
  }

  const rows = f.items
    .map(
      (i) => `<tr class="${i.sprintCount >= 3 ? 'row-alert' : ''}">
      <td class="key-cell">${ticketWithTitle(ctx, { key: i.key, summary: i.summary, issueType: i.issueType, status: i.status, assignee: i.assignee, sprintCount: i.sprintCount })}</td>
      <td>${escapeHtml(i.status)}</td>
      <td>${i.assignee ? escapeHtml(i.assignee) : '<span class="muted">unassigned</span>'}</td>
      <td class="num" data-sort="${i.ageDays ?? 0}">${i.ageDays === null ? '—' : Math.round(i.ageDays)}</td>
      <td class="num" data-sort="${i.sprintCount}">${i.sprintCount}</td>
      <td class="num" data-sort="${i.commentCount ?? -1}">${i.commentCount ?? '<span class="muted">—</span>'}</td>
      <td>${
        i.blockedBy.length > 0
          ? i.blockedBy.map((b) => link(issueUrl(ctx.site, b), b, 'key')).join(' ')
          : i.inActiveSprint
            ? '<span class="muted">in sprint</span>'
            : i.inBacklog
              ? '<span class="muted">backlog</span>'
              : '<span class="tag caveat">outside the plan</span>'
      }</td>
    </tr>`,
    )
    .join('');

  return `
    <p class="lede">${f.total} open ticket${f.total === 1 ? '' : 's'} on this board carry a
      ${term('flag', 'Jira’s Flagged field — the formal "this is blocked" marker. On this site it is a multi-select field rather than a checkbox, so an empty value means not flagged. It only ever fires when a person remembers to set it.')},
      worst-carried first.</p>
    <div class="kpis">
      ${kpi('Flagged and open', String(f.total), 'across the whole board', f.total > 20 ? 'watch' : '')}
      ${kpi('In the active sprint', String(f.inActiveSprint), 'blocking work you committed to', f.inActiveSprint > 0 ? 'watch' : 'good')}
      ${kpi('Outside the plan', String(f.strandedFlags), 'flagged, not in a sprint or the backlog', f.strandedFlags > 0 ? 'poor' : 'good',
        'Somebody marked this as blocked and then it left the plan entirely — it is in no active sprint and not on the backlog. This is the easiest category of work in Jira to lose completely, which is why it is counted separately.')}
    </div>
    <div class="table-scroll"><table data-sortable>
      <thead><tr><th>Ticket</th><th>Status</th><th>Owner</th><th class="num">Age&nbsp;days</th><th class="num">Sprints</th><th class="num">Comments</th><th>Blocked by</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${f.total > f.items.length ? `<p class="footnote muted">${f.total - f.items.length} more not shown. ${openAllLink(ctx, f.items.map((i) => i.key), 'Open these in Jira')}</p>` : `<p class="footnote">${openAllLink(ctx, f.items.map((i) => i.key), 'Open all of these in Jira')}</p>`}
    ${explain(
      'Every open ticket carrying Jira’s Flagged field, sorted by how many sprints it has survived.',
      'A flag is somebody on the team telling you, in writing, that they are stopped. It is the one signal in this whole report that a human deliberately raised rather than a tool inferred. A flag that has survived three sprints means the person raised it, nothing happened, and they have stopped expecting anything to happen.',
      'Take the rows highlighted at the top — flagged and carried three or more sprints. For each one, the question is not "what is the status" but "who owns removing this blocker, and is that person on this team". If the answer is somebody outside the team, that is yours to go and get. Anything in the "outside the plan" count should be either scheduled or closed today.',
    )}`;
}

/** What is holding up what. */
export function blockerPanel(ctx: RenderContext, t: { key: string; blockers?: BlockerEdge[] }): string {
  const edges = t.blockers;
  if (!edges) return notYet('Blocker graph not computed', 'No dependency graph was derived for this team.');
  if (edges.length === 0) return `<p class="lede">No open ticket on this board records a "blocked by" link.</p>`;

  const rows = edges
    .map(
      (e) => `<tr class="${!e.blockerDone && e.blocked.length > 1 ? 'row-alert' : ''}">
      <td class="key-cell">${e.blockerSummary !== undefined || e.blockerStatus !== undefined
        ? ticketWithTitle(ctx, { key: e.blocker, summary: e.blockerSummary, status: e.blockerStatus })
        : link(issueUrl(ctx.site, e.blocker), e.blocker, 'key')}</td>
      <td>${e.blockerStatus ? escapeHtml(e.blockerStatus) : '<span class="muted">not on this board</span>'}</td>
      <td>${e.blockerDone ? '<span class="tag sound">done</span>' : '<span class="tag caveat">open</span>'}</td>
      <td class="num" data-sort="${e.blocked.length}"><strong>${e.blocked.length}</strong></td>
      <td>${e.blocked.map((b) => link(issueUrl(ctx.site, b), b, 'key')).join(' ')}</td>
    </tr>`,
    )
    .join('');

  const stillOpen = edges.filter((e) => !e.blockerDone);
  const doneButBlocking = edges.filter((e) => e.blockerDone);

  return `
    <p class="lede">Which tickets are holding up other tickets. One unfinished ticket gating a queue of others is
      the highest-leverage thing on this page &mdash; unstick it and several people move at once.</p>
    <div class="kpis">
      ${kpi('Open blockers', String(stillOpen.length), 'unfinished, and something waits on them', stillOpen.length > 0 ? 'watch' : 'good')}
      ${kpi('Done but still blocking', String(doneButBlocking.length), 'finished — did anyone tell them?', doneButBlocking.length > 0 ? 'watch' : 'good',
        'The blocking ticket is closed but the tickets it blocks are still open and still record the dependency. Usually this means the work was unblocked and nobody went back to tell the people waiting.')}
    </div>
    <div class="table-scroll"><table data-sortable>
      <thead><tr><th>Blocker</th><th>Status</th><th></th><th class="num">Blocks</th><th>Waiting on it</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${explain(
      'Jira "is blocked by" links between open tickets, grouped by the blocking ticket and ranked by how many things wait on it.',
      'Dependencies are invisible on a board — a column view shows twelve tickets in progress and gives no hint that four of them are waiting on the same one. This is the view where a single stuck ticket stops looking like one ticket and starts looking like a queue.',
      'Work top-down. The first row is the ticket whose completion unblocks the most people, and it is almost always worth more of your attention than anything in the backlog. For rows marked "done but still blocking", go and tell the waiting owners — that work may already be free to start.',
    )}`;
}

/** Who is on this board. */
export function rosterPanel(ctx: RenderContext, t: { key: string; roster?: RosterSummary; gitlabGroups?: string[] }): string {
  const r = t.roster;
  const n = nouns(ctx);
  if (!r) return notYet('Roster not computed', 'No per-person roster was derived for this team.');
  if (r.members.length === 0) return `<p class="lede">No named people found on this board.</p>`;

  const rows = r.members
    .map((m) => {
      const badges = [
        m.jiraOnly ? tip('<span class="tag caveat">Jira only</span>', 'Appears in Jira and never in GitLab in these windows. Usually product, QA, support or management rather than absence — but it can also mean their two accounts are spelled differently.') : '',
        m.gitlabOnly ? tip('<span class="tag caveat">GitLab only</span>', 'Writes code against this team’s repositories but holds no Jira issue on this board. Often somebody from another team contributing, or a second account spelling.') : '',
      ].join('');
      return `<tr>
      <td><strong>${escapeHtml(m.name)}</strong> ${badges}</td>
      <td class="num" data-sort="${m.openInActiveSprint}">${m.openInActiveSprint || '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.openAssigned}">${m.openAssigned || '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.openPoints}">${m.openPoints || '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.flaggedAssigned}">${m.flaggedAssigned ? `<span class="tag caveat">${m.flaggedAssigned}</span>` : '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.resolvedRecently}">${m.resolvedRecently || '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.reportedRecently}">${m.reportedRecently || '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.mergeRequestsAuthored}">${m.mergeRequestsAuthored || '<span class="muted">—</span>'}</td>
      <td class="num" data-sort="${m.reviewsGiven}">${m.reviewsGiven || '<span class="muted">—</span>'}</td>
      <td>${
        m.projects.length === 0
          ? '<span class="muted">—</span>'
          : m.projects
              .slice(0, 3)
              .map((p) => link(gitlabProjectUrl(ctx.gitlabOrigin, p), p.split('/').slice(-1)[0] ?? p, 'key'))
              .join(' ') + (m.projects.length > 3 ? ` <span class="muted">+${m.projects.length - 3}</span>` : '')
      }</td>
    </tr>`;
    })
    .join('');

  return `
    <p class="lede">Everyone who holds work on this board or writes code against its repositories. This is a
      <strong>contact sheet, not a scorecard</strong> &mdash; it answers "whose ticket is this, and where else do
      they work", which is the question a manager asks twenty times a week.</p>
    <div class="kpis">
      ${kpi('People holding sprint work', String(r.activeContributors), 'with an open issue in the active sprint')}
      ${kpi('Names seen in total', String(r.members.length), `Jira all-time, GitLab last ${r.gitlabWindowDays ?? ctx.windowDays} days`)}
      ${kpi('Unassigned sprint work', String(r.unassignedOpenInActiveSprint), 'open, in the sprint, nobody’s name on it',
        r.unassignedOpenInActiveSprint > 0 ? 'watch' : 'good',
        'Open issues in an active sprint with no assignee. Work with no name on it is work nobody has agreed to do, and it is the most common reason a sprint quietly fails to land.')}
    </div>
    <div class="table-scroll"><table data-sortable>
      <thead><tr>
        <th>Person</th>
        <th class="num">${term('Sprint', 'Open issues assigned to them in an active sprint — their current load.')}</th>
        <th class="num">${term('Open', 'Every open issue assigned to them anywhere on this board, including backlog.')}</th>
        <th class="num">Points</th>
        <th class="num">${term('Flagged', 'Open issues assigned to them that carry a blocked flag.')}</th>
        <th class="num">${term('Resolved', `Issues resolved in the last ${r.recentDays} days that are assigned to them NOW. Weak: the assignee is who holds it today, not necessarily who did it.`)}</th>
        <th class="num">${term('Raised', `Issues they reported in the last ${r.recentDays} days. The biggest reporters are often support and product people rather than developers — a roster that omits them describes the wrong team.`)}</th>
        <th class="num">${term(n.abbrMany, `${n.Many} they authored in the last ${r.gitlabWindowDays ?? ctx.windowDays} days. Automation accounts are excluded.`)}</th>
        <th class="num">${term('Reviews', `${n.Many} they left a review comment on. On this instance almost every formal APPROVAL is the bot, so comments are where human review actually lives.`)}</th>
        <th>Repos</th>
      </tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${explain(
      `Everyone who appears as an assignee or reporter on this board, or as a ${n.one} author or reviewer in its mapped ${n.host} repositories, with what they currently hold.`,
      `Two uses. First, it is a directory: you can see whose ticket something is and which repositories they touch without asking. Second, the shape of the table tells you about the team — somebody carrying twenty open issues while nobody else carries five is a bottleneck, and a large "Raised" column with an empty "${n.abbrMany}" column identifies the people who define work rather than build it.`,
      'Look for load that is concentrated on one or two names, and for people with flagged work who are not in your regular conversations. Do NOT read this as productivity: the columns count what somebody holds, not what they produced, and the assignee field records who holds a ticket today rather than who did the work.',
    )}
    <p class="footnote"><strong>Why this is not a performance measure.</strong> Jira’s assignee field is
      overwritten whenever work changes hands, so "Resolved" credits whoever holds the ticket now. Merge-request
      counts vary by an order of magnitude between a team that squashes and one that does not. These columns are
      reliable for <em>finding people</em> and unreliable for <em>ranking</em> them, and they are presented in that
      spirit deliberately. ${
        (t.gitlabGroups ?? []).length > 0
          ? `Identities are matched between Jira and GitLab by display name; somebody who spells their name differently in the two systems appears as two rows rather than being guessed into one.`
          : ''
      }</p>`;
}
