import {
  boardUrl,
  confluenceSearchUrl,
  gitlabGroupMergeRequestsUrl,
  gitlabGroupUrl,
  gitlabProjectUrl,
  issueUrl,
  jqlUrl,
  keysJql,
  sprintReportUrl,
} from '../links.js';
import { activeEpics, backlogEpics, sprintFocus, type EpicRollup } from '../epics.js';
import type { AttentionItem, HealthTone, SlowItem, SprintOutlook, TeamHealth } from '../insights.js';
import type { Intervention, InterventionSeverity } from '../interventions.js';
import { countChanges, type ChangeKind, type ChangeSummary } from '../changes.js';
import {
  escapeAttr,
  escapeHtml,
  explain,
  figures,
  fmt,
  hours,
  kpi,
  link,
  notYet,
  pct,
  rate,
  term,
} from './format.js';
import { dwellIsReportable, MIN_DWELL_BASIS } from '../history.js';
import type { ReportTeamInput } from './model.js';

// ---------------------------------------------------------------------------
// Every panel on the page.
//
// The governing rule, and the reason this file was rewritten: THE READER KNOWS
// NOTHING. They may never have seen this board, this team or a burndown. So
// every panel carries three things beyond its numbers - a plain-English lede, a
// collapsed "what this is and what to do with it", and a route out to the live
// system (a Jira ticket, a GitLab merge-request list, a Confluence page). A
// number with no route to its source is a number the reader has to take on
// trust, and this report is read by people whose job is not to take things on
// trust.
//
// The trustworthiness labels are load-bearing and travel with the numbers, not
// only in the legend. See derive.ts and review.ts for what each one means.
// ---------------------------------------------------------------------------

export interface RenderContext {
  site: string;
  gitlabOrigin: string;
  windowDays: number;
  /** Which forge produced `mergeRequests`, from GitLabSnapshot.source.
   *
   *  The whole derive layer is forge-agnostic by design - review.ts, history and
   *  the alert feed have no `if (github)` anywhere (docs/decisions.md, "GitLab
   *  and GitHub share one snapshot shape"). The COPY cannot be: "merged with
   *  nobody looking" is a sentence about a specific artefact, and on a GitHub
   *  profile the artefact is a pull request. Defaults to gitlab so a caller that
   *  did not set it reads exactly as it did before this existed. */
  forge?: 'gitlab' | 'github';
}

/** The forge's own nouns, for copy. Lower case; capitalise at the call site.
 *
 *  Deliberately a lookup rather than a template: "MR"/"PR" is not derivable from
 *  "merge request"/"pull request", and a reader who sees "PRs" beside "merge
 *  request" in the same panel trusts neither. */
export function nouns(ctx: RenderContext): {
  one: string; many: string; One: string; Many: string;
  abbr: string; abbrMany: string; host: string;
} {
  return ctx.forge === 'github'
    ? { one: 'pull request', many: 'pull requests', One: 'Pull request', Many: 'Pull requests', abbr: 'PR', abbrMany: 'PRs', host: 'GitHub' }
    : { one: 'merge request', many: 'merge requests', One: 'Merge request', Many: 'Merge requests', abbr: 'MR', abbrMany: 'MRs', host: 'GitLab' };
}

// --- ticket rendering ------------------------------------------------------------

/** The hover card behind a ticket key.
 *
 *  This is the single highest-value thing added to the report: the tables were
 *  previously columns of opaque identifiers, and the only way to find out what
 *  WEB-1387 was involved leaving the page. Summary, status, owner, size, age and
 *  the latest comment are all already in the snapshot. */
export function ticketTipText(i: {
  key: string;
  summary?: string;
  description?: string;
  status?: string;
  issueType?: string;
  assignee?: string;
  storyPoints?: number | null;
  ageDays?: number | null;
  idleDays?: number | null;
  sprintCount?: number;
  epicKey?: string;
  epicName?: string;
  blockedBy?: string[];
  latestComment?: { author?: string; created: string; body: string };
}): string {
  const parts: string[] = [];
  parts.push(i.summary ? `${i.key} — ${i.summary}` : `${i.key} (no title in this snapshot)`);
  const facts: string[] = [];
  if (i.issueType) facts.push(i.issueType);
  if (i.status) facts.push(i.status);
  facts.push(i.assignee ? i.assignee : 'unassigned');
  if (i.storyPoints !== undefined) facts.push(i.storyPoints === null ? 'no estimate' : `${i.storyPoints} pts`);
  if (i.sprintCount !== undefined && i.sprintCount > 1) facts.push(`${i.sprintCount} sprints`);
  if (i.ageDays !== undefined && i.ageDays !== null) facts.push(`${Math.round(i.ageDays)}d old`);
  if (i.idleDays !== undefined && i.idleDays !== null) facts.push(`idle ${Math.round(i.idleDays)}d`);
  parts.push(facts.join(' · '));
  if (i.epicKey) parts.push(`Epic: ${i.epicName ?? i.epicKey}`);
  if (i.blockedBy && i.blockedBy.length > 0) parts.push(`Blocked by ${i.blockedBy.join(', ')}`);
  if (i.description) parts.push(i.description);
  if (i.latestComment) {
    parts.push(`Latest comment${i.latestComment.author ? ` (${i.latestComment.author})` : ''}: ${i.latestComment.body}`);
  }
  return parts.join('\n');
}

/** A ticket key as a link to Jira, wrapped in its hover card. */
export function ticket(ctx: RenderContext, i: Parameters<typeof ticketTipText>[0]): string {
  const href = issueUrl(ctx.site, i.key);
  const text = ticketTipText(i);
  const anchor = href
    ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(i.key)}</a>`
    : escapeHtml(i.key);
  return `<span class="ticket tip" data-tip="${escapeAttr(text)}" title="${escapeAttr(text)}" tabindex="0">${anchor}</span>`;
}

/** Key plus title, for a table cell wide enough to carry both. The title is
 *  clamped by CSS rather than truncated here, so the hover card and the copy
 *  buffer still hold the whole thing. */
export function ticketWithTitle(ctx: RenderContext, i: Parameters<typeof ticketTipText>[0]): string {
  return `<div class="tcell">${ticket(ctx, i)}${
    i.summary ? `<span class="tsummary">${escapeHtml(i.summary)}</span>` : '<span class="tsummary muted">title not in this snapshot</span>'
  }</div>`;
}

/** "Open all N of these in Jira" - the escape hatch from every truncated list. */
export function openAllLink(ctx: RenderContext, keys: string[], label?: string): string {
  const jql = keysJql(keys);
  if (!jql) return '';
  return link(jqlUrl(ctx.site, jql), label ?? `Open all ${Math.min(keys.length, 60)} in Jira`, 'btn-link');
}

// --- interventions ----------------------------------------------------------------

const SEVERITY_LABEL: Record<InterventionSeverity, string> = {
  'act-now': 'Act now',
  'this-week': 'This week',
  watch: 'Watch',
};

const SEVERITY_MEANING: Record<InterventionSeverity, string> = {
  'act-now': 'Somebody is already stopped, or a promise has already been missed. Waiting for the next standup costs a day.',
  'this-week': 'Nobody is stopped yet, but on current evidence somebody will be. Cheap to fix now, expensive to fix later.',
  watch: 'Drifting rather than broken. Worth naming at a retrospective rather than acting on today.',
};

export function interventionCard(ctx: RenderContext, i: Intervention, showTeam: boolean): string {
  const keys = i.issueKeys.slice(0, 8);
  return `<article class="ivn ${i.severity}" data-kind="${escapeAttr(i.kind)}" data-team="${escapeAttr(i.team)}" data-severity="${escapeAttr(i.severity)}">
    <header>
      <span class="sev tip" data-tip="${escapeAttr(SEVERITY_MEANING[i.severity])}" title="${escapeAttr(SEVERITY_MEANING[i.severity])}" tabindex="0">${escapeHtml(SEVERITY_LABEL[i.severity])}</span>
      ${showTeam ? `<a class="team-chip" href="#team=${escapeAttr(i.team)}">${escapeHtml(i.team)}</a>` : ''}
      <span class="kind">${escapeHtml(i.kind.replace(/-/g, ' '))}</span>
    </header>
    <h4 data-summary-line>${escapeHtml(i.title)}</h4>
    <p class="what">${escapeHtml(i.what)}</p>
    ${i.evidence ? `<blockquote class="evidence">${escapeHtml(i.evidence)}</blockquote>` : ''}
    <div class="whyact">
      <div><span class="lbl">Why it matters</span>${escapeHtml(i.why)}</div>
      <div><span class="lbl">What to do</span><strong>${escapeHtml(i.action)}</strong></div>
    </div>
    ${
      keys.length > 0
        ? `<footer>${keys.map((k) => ticket(ctx, { key: k })).join(' ')}${
            i.issueKeys.length > keys.length ? ` <span class="muted">+${i.issueKeys.length - keys.length} more</span>` : ''
          } ${openAllLink(ctx, i.issueKeys)}</footer>`
        : ''
    }
  </article>`;
}

export function interventionFeed(ctx: RenderContext, items: Intervention[], opts: { showTeam: boolean; id: string; limit?: number }): string {
  if (items.length === 0) {
    return `<p class="lede good-note">Nothing here needs a manager today. No flagged blocker, no dependency waiting on
      uncommitted work, nothing claimed-and-not-moving, nothing past its due date. That is the state you want, and it is
      worth saying out loud rather than leaving as an empty box.</p>`;
  }
  const shown = items.slice(0, opts.limit ?? items.length);
  const teams = [...new Set(items.map((i) => i.team))].sort();
  const severities: InterventionSeverity[] = ['act-now', 'this-week', 'watch'];
  const counts = severities.map((s) => ({ s, n: items.filter((i) => i.severity === s).length })).filter((x) => x.n > 0);

  return `<div class="ivn-controls" data-ivn-for="${escapeAttr(opts.id)}">
      <span class="muted">Show</span>
      <button type="button" class="chip-btn on" data-filter-severity="">all ${items.length}</button>
      ${counts.map((c) => `<button type="button" class="chip-btn ${c.s}" data-filter-severity="${c.s}">${escapeHtml(SEVERITY_LABEL[c.s])} ${c.n}</button>`).join('')}
      ${
        opts.showTeam && teams.length > 1
          ? `<span class="sep"></span><button type="button" class="chip-btn on" data-filter-team="">all teams</button>` +
            teams.map((t) => `<button type="button" class="chip-btn" data-filter-team="${escapeAttr(t)}">${escapeHtml(t)}</button>`).join('')
          : ''
      }
    </div>
    <div class="ivn-grid" id="${escapeAttr(opts.id)}">${shown.map((i) => interventionCard(ctx, i, opts.showTeam)).join('')}</div>
    ${shown.length < items.length ? `<p class="footnote">Showing the ${shown.length} highest-priority of ${items.length}. The rest are in each team's own tab.</p>` : ''}`;
}

// --- what changed since the previous collected day ----------------------------------

const CHANGE_LABEL: Record<ChangeKind, string> = {
  new: 'NEW',
  escalated: 'WORSE',
  eased: 'EASED',
  cleared: 'GONE',
};

const CHANGE_MEANING: Record<ChangeKind, string> = {
  new: 'This finding was not present on the previous collected day. It became true in between - which is what makes it the cheapest thing on the page to act on.',
  escalated: 'This finding was present on the previous collected day at a lower severity. Something about it got worse in between.',
  eased: 'Still present, but at a lower severity than on the previous collected day. Somebody moved it, or it stopped ageing.',
  cleared:
    'Present on the previous collected day and absent today. Somebody acted on it, or it aged out of the window the finding is measured over - both look identical from here, so it is reported as gone rather than as fixed.',
};

/** What changed between the two most recent collected days.
 *
 *  The one panel on this page that is not a picture of today. Everything else
 *  answers "what is true now", which leaves a reader who opens this file every
 *  morning unable to tell the finding that appeared overnight from the six that
 *  have been standing for a fortnight - and the overnight one is the only one
 *  still cheap to act on.
 *
 *  Nothing here is recomputed: every card is an intervention the derive layer
 *  produced, and the comparison is `diffInterventions`, which is the same
 *  identity function the alerting path decides "is this news" with. */
export function changesPanel(ctx: RenderContext, s: ChangeSummary | undefined): string {
  if (!s) {
    return notYet(
      'Not compared.',
      'This report was generated without a previous day to compare against. It is not a claim that nothing changed.',
    );
  }

  if (s.from === null) {
    return notYet(
      'This is the first collected day for this profile.',
      `There is nothing to compare ${escapeHtml(s.to)} against, so all ${s.totalToday} findings below are reported as
       standing rather than as new. Saying "${s.totalToday} new findings" here would be a claim this tool cannot
       support &mdash; it has never seen yesterday. This panel fills in on the next collection.`,
    );
  }

  // Hoisted out of the narrowing above so the card closure below still sees a
  // string. TypeScript re-widens `s.from` inside a callback.
  const from = s.from;
  const counts = countChanges(s);
  const shortGap = s.observedHours !== null && s.observedHours < 20;

  const gapLine =
    s.observedHours !== null
      ? `Compared against <strong>${escapeHtml(s.from)}</strong>, captured <strong>${s.observedHours} wall-clock hours</strong> earlier.` +
        (shortGap
          ? ` <strong>That is less than a working day</strong>, and most of an overnight interval is not working time
             at all &mdash; so a quiet panel here is a short interval, not a quiet team.`
          : '')
      : `Compared against <strong>${escapeHtml(s.from)}</strong>.`;

  if (s.changes.length === 0) {
    return `<div class="kpis">
        ${kpi('Changed', '0', `of ${s.totalToday} findings`, 'good')}
        ${kpi('Interval', s.observedHours !== null ? `${s.observedHours} h` : '—', `${escapeHtml(s.from)} → ${escapeHtml(s.to)}`, shortGap ? 'watch' : '')}
      </div>
      <p class="lede good-note">Nothing appeared, worsened, eased or cleared between the two collected days. Every one
        of the ${s.totalToday} findings on this page was already true on ${escapeHtml(s.from)}.</p>
      <p class="footnote">${gapLine}</p>`;
  }

  const cards = s.changes
    .map(
      (c) => `<div class="chg chg-${c.kind}">
        <div class="chg-strip">
          <span class="chg-badge ${c.kind} tip" data-tip="${escapeAttr(CHANGE_MEANING[c.kind])}" title="${escapeAttr(CHANGE_MEANING[c.kind])}" tabindex="0">${CHANGE_LABEL[c.kind]}</span>
          ${
            c.previousSeverity && c.kind !== 'cleared'
              ? `<span class="muted">was ${escapeHtml(SEVERITY_LABEL[c.previousSeverity])}</span>`
              : ''
          }
          ${
            c.kind === 'cleared'
              ? `<span class="muted">as it read on ${escapeHtml(from)} &mdash; this finding is not on today's board</span>`
              : ''
          }
        </div>
        ${interventionCard(ctx, c.intervention, true)}
      </div>`,
    )
    .join('');

  return `
    <div class="kpis">
      ${kpi(
        'Appeared',
        String(counts.new),
        `not present on ${escapeHtml(s.from)}`,
        counts.new > 0 ? 'watch' : 'good',
        'Findings that became true between the two collected days. These are the cheapest things on the page to act on, because nobody has had time to build around them yet.',
      )}
      ${kpi(
        'Got worse',
        String(counts.escalated),
        'same finding, higher severity',
        counts.escalated > 0 ? 'poor' : 'good',
        'Present on both days, and more severe today than yesterday. A finding that is climbing is usually a better use of a morning than a worse one that is stable.',
      )}
      ${kpi(
        'Eased or gone',
        String(counts.eased + counts.cleared),
        `${counts.cleared} gone, ${counts.eased} less severe`,
        'good',
        'Gone means present yesterday and absent today. Somebody acted on it, or it aged out of the window it is measured over - those look identical from here, so it is never reported as "fixed".',
      )}
      ${kpi(
        'Unchanged',
        String(s.unchanged),
        `of ${s.totalToday} findings today`,
        '',
        'Present on both days at the same severity. Counted rather than listed, because they are the rest of this report.',
      )}
    </div>
    <div class="chg-grid">${cards}</div>
    <p class="footnote">${gapLine} Both days are built the same way and each is measured against
      <strong>its own capture time</strong>, which is what makes them comparable at all: build yesterday's findings with
      today's clock and everything that crossed a staleness threshold overnight appears on both days and never shows up
      here. A finding is the same finding across days when it is about the same team, the same kind of problem and the
      same tickets &mdash; so one ticket being assigned does not make the other thirty-six a new finding.</p>
    ${explain(
      'The difference between the findings on the most recent collected day and those on the day before it: what appeared, what got more severe, what eased, and what is gone.',
      'Every other panel here is a picture of today, and a picture of today cannot distinguish a problem that started overnight from one that has been standing for a fortnight. The overnight one is the one still cheap to fix, and it is invisible in a ranked list where a nine-day-old blocker outranks it.',
      'Work the "appeared" and "got worse" cards first - they are the delta, and they are short. Then check the "gone" list against your own memory: something you did not fix and that vanished anyway is usually a sprint closing or a ticket leaving a window, and that is worth knowing before you report it as progress.',
    )}`;
}

// --- orientation -------------------------------------------------------------------

/** Who this team is, in the terms of the systems they actually use.
 *
 *  This panel exists because every identifier elsewhere on the page - `fs`,
 *  WEB, `logistics-hub`, board 701 - is meaningless to a reader who has not spent
 *  a year in this estate, and the mapping between them was previously recorded
 *  only in a comment in a config file. */
export function orientationPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const goals = t.sprintGoals ?? [];
  const prefixes = t.prefixes ?? [{ key: t.prefix, count: 0 }];
  const conf = t.confluence;
  const board = t.boardId ?? t.trends.boardId;

  const rows: string[] = [];
  rows.push(`<dt>Jira board</dt><dd>${link(boardUrl(ctx.site, board), `${t.boardName ?? 'board'} · #${board}`)}
    <div class="muted">A “team” in this report IS a Jira board. Not the Team field (empty on every issue on this site) and
      not the project (too coarse — one project can host several boards).</div></dd>`);
  rows.push(`<dt>Ticket prefixes</dt><dd>${prefixes
    .slice(0, 4)
    .map((p) => `<span class="prefix">${escapeHtml(p.key)}</span>${p.count ? ` <span class="muted">${p.count}</span>` : ''}`)
    .join(' ')}
    <div class="muted">Counted from the issues actually on the board, not from the board's own project — board 703 lives in
      project OPS and carries only LOG work.</div></dd>`);

  if (t.gitlabGroups && t.gitlabGroups.length > 0) {
    rows.push(`<dt>GitLab</dt><dd>${t.gitlabGroups
      .map(
        (g) =>
          `${link(gitlabGroupUrl(ctx.gitlabOrigin, g), g)} <span class="muted">(${link(
            gitlabGroupMergeRequestsUrl(ctx.gitlabOrigin, g),
            'merged MRs',
          )})</span>`,
      )
      .join(' · ')}
      <div class="muted">Every code-review figure on this page is counted from these groups and nowhere else. Scope is the
        difference between a reassuring number and a real one.</div></dd>`);
  } else {
    rows.push(`<dt>GitLab</dt><dd><span class="muted">No group mapped, so nothing on this page measures this team's code
      review.</span> Run <code>discover-groups</code>, then the mapping recipe in docs/handover.md — it is derived from
      evidence, not guessed.</dd>`);
  }

  const searchTerms = prefixes.slice(0, 1).map((p) => p.key);
  rows.push(`<dt>Documentation</dt><dd>${
    conf && conf.pages.length > 0
      ? conf.pages
          .slice(0, 6)
          .map((p) => `${link(p.url, p.title)} <span class="muted">${escapeHtml(p.spaceKey)}${p.lastUpdated ? ` · ${p.lastUpdated.slice(0, 10)}` : ''}</span>`)
          .join('<br/>')
      : `<span class="muted">No Confluence context collected for this team.</span>`
  }
    <div class="muted">${
      conf && conf.pages.length > 0
        ? `${conf.pages.length} page(s) from ${conf.spaces.map((s) => escapeHtml(s.key)).join(', ') || 'search'}. Titles and links only — this report is never a mirror of the wiki, so what you click is always the live page.`
        : `Run <code>discover-spaces</code> to find which space belongs to this team, then add it to <code>confluenceSpaces</code>. Until then: ${searchTerms
            .map((s) => link(confluenceSearchUrl(ctx.site, s), `search Confluence for ${s}`))
            .join(', ')}.`
    }</div></dd>`);

  if (goals.length > 0) {
    rows.push(`<dt>Sprint goal${goals.length > 1 ? 's' : ''}</dt><dd>${goals
      .map(
        (g) =>
          `<div class="goal">${link(sprintReportUrl(ctx.site, board, g.id), g.name)} — ${
            g.goal ? `<strong>${escapeHtml(g.goal)}</strong>` : '<span class="warn-text">no goal set</span>'
          }${g.endDate ? ` <span class="muted">ends ${escapeHtml(g.endDate.slice(0, 10))}</span>` : ''}</div>`,
      )
      .join('')}
      ${
        goals.every((g) => !g.goal)
          ? `<div class="muted">Without a goal there is nothing for the sprint to succeed or fail against, so the only
             available verdict is “did we finish every ticket” — which no sprint ever does.</div>`
          : ''
      }</dd>`);
  }

  if (t.description) {
    rows.push(`<dt>Why this mapping</dt><dd class="prov">${escapeHtml(t.description)}</dd>`);
  }

  return `<dl class="orient">${rows.join('')}</dl>`;
}

// --- health -------------------------------------------------------------------------

export function healthPanel(h: TeamHealth): string {
  const rows = h.signals
    .map(
      (s) => `<div class="health-row ${s.tone}">
        <div class="h-label">${escapeHtml(s.label)}</div>
        <div class="h-value">${escapeHtml(s.value)}</div>
        <div class="h-detail">${escapeHtml(s.detail)}</div>
      </div>`,
    )
    .join('');
  return `<div class="health">${rows}</div>`;
}

// --- outlook -------------------------------------------------------------------------

export function outlookTone(o: SprintOutlook | null): HealthTone {
  if (!o || o.verdict === 'unknown') return 'unknown';
  return o.verdict === 'on-track' ? 'good' : o.verdict === 'at-risk' ? 'watch' : 'poor';
}

export function outlookLabel(o: SprintOutlook | null): string {
  if (!o) return 'no active sprint';
  return o.verdict === 'unknown' ? 'unknown' : o.verdict === 'on-track' ? 'on track' : o.verdict === 'at-risk' ? 'at risk' : 'will not land';
}

export function outlookPanel(t: ReportTeamInput): string {
  const o = t.outlook;
  if (!o) return `<p class="lede">No active sprint on this board.</p>`;
  const tone = outlookTone(o);
  const dl = o.daysRemaining;
  const elapsed = o.elapsedFraction;
  const donePct = o.committedPoints > 0 ? o.donePoints / o.committedPoints : null;
  const meter =
    elapsed === null
      ? ''
      : `<div class="meter" role="img" aria-label="${Math.round(elapsed * 100)}% of the sprint elapsed"><span style="width:${(elapsed * 100).toFixed(1)}%"></span>${
          donePct === null ? '' : `<i style="width:${(Math.min(1, donePct) * 100).toFixed(1)}%"></i>`
        }</div>
         <div class="meter-labels"><span>${Math.round(elapsed * 100)}% of the sprint elapsed</span>
           <span>${donePct === null ? '—' : `${Math.round(donePct * 100)}% of the points done`}</span></div>
         ${
           elapsed < 0.25 && (tone === 'watch' || tone === 'poor')
             ? `<p class="footnote">Only ${Math.round(elapsed * 100)}% of the sprint has elapsed. A verdict this early
                reflects the size of the commitment, not the team's progress against it.</p>`
             : ''
         }`;
  return `
    ${meter}
    <div class="callout ${tone === 'poor' ? 'warn' : tone === 'unknown' ? 'neutral' : ''}">
      <div class="big">${escapeHtml(outlookLabel(o))}</div>
      <div class="body">
        <strong>${escapeHtml(o.sprintName)}</strong>${o.endDate ? ` ends ${escapeHtml(o.endDate.slice(0, 10))}` : ''}${
          dl === null ? '' : dl >= 0 ? ` &mdash; ${dl.toFixed(1)} days left` : ` &mdash; <strong>${Math.abs(dl).toFixed(1)} days overdue</strong>`
        }${
          // The date is the EARLIEST across concurrent sprints, so it belongs to
          // one of them. Board 705 runs six and sprint 5942 "Vulnerabilities"
          // ended nine days before the other five: printing "6 concurrent
          // sprints ends 2026-08-17 - 9.3 days overdue" reads as all six being
          // overdue. Naming the sprint is the whole fix.
          o.endDateSprintName ? ` (that date is <strong>${escapeHtml(o.endDateSprintName)}</strong>, the earliest of the ${escapeHtml(o.sprintName)})` : ''
        }.<br/>
        ${o.donePoints} of ${o.committedPoints} pts done, <strong>${o.remainingPoints} pts remaining</strong>.
        ${
          o.unreliableReason
            ? `<br/>${escapeHtml(o.unreliableReason)} No landing verdict is offered for this sprint.`
            : o.requiredPointsPerDay !== null && o.historicalPointsPerDay !== null
              ? `<br/>That needs <strong>${o.requiredPointsPerDay.toFixed(1)} pts/day</strong>; this team's own p50 pace is
                 ${o.historicalPointsPerDay.toFixed(1)} pts/day${o.paceRatio !== null && o.paceRatio > 1 ? ` &mdash; <strong>${o.paceRatio.toFixed(1)}&times; faster than it normally goes</strong>` : ''}.`
              : ''
        }
      </div>
    </div>
    ${explain(
      'Whether the work still open in the active sprint can be finished before the sprint ends, at the pace this team itself has historically delivered.',
      'A sprint that will not land is worth knowing about in week one, when scope can still be cut and somebody outside the team can still be told. In week two it is an apology.',
      'If this says “will not land”, decide now what comes out of the sprint and say so. If it says “unknown” because the sprint is mostly unestimated, the fix is estimation, not effort.',
    )}`;
}

// --- work in progress ------------------------------------------------------------------

export function wipPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const w = t.wip;
  if (!w || w.columns.length === 0) return `<p class="lede">No active sprint to place on the board.</p>`;

  const cols = w.columns.filter((c) => c.issues > 0);
  const colRows = cols
    .map(
      (c) => `<tr class="${c.done ? 'done-col' : ''}">
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td class="num" data-sort="${c.issues}">${c.issues}</td>
      <td class="num" data-sort="${c.points}">${c.points}</td>
      <td class="num ${c.stale > 0 && !c.done ? 'poor' : ''}" data-sort="${c.stale}">${c.stale}</td>
      <td class="num" data-sort="${c.medianIdleDays ?? -1}">${c.medianIdleDays === null ? '—' : Math.round(c.medianIdleDays)}</td>
      <td>${openAllLink(ctx, c.keys, `open ${Math.min(c.keys.length, 60)}`)}</td>
    </tr>`,
    )
    .join('');

  const peopleRows = w.perPerson
    .slice(0, 20)
    .map((p) => {
      const over = w.overloaded.includes(p.name);
      return `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td class="num ${over ? 'poor' : ''}" data-sort="${p.inProgress}">${p.inProgress}</td>
        <td class="num" data-sort="${p.points}">${p.points}</td>
        <td class="keys">${p.keys.slice(0, 5).map((k) => ticket(ctx, { key: k })).join(' ')}${p.keys.length > 5 ? ` <span class="muted">+${p.keys.length - 5}</span>` : ''}</td>
      </tr>`;
    })
    .join('');

  const wipPeople = w.perPerson.slice(0, 20);
  return `
    <div class="chart-box short"><canvas id="chart-wip-${escapeHtml(t.key)}"></canvas></div>
    ${figures(
      cols.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Column</th><th class="num">Issues</th><th class="num">Points</th>
        <th class="num">${term('Stale', `In this column with no update for ${w.staleDays} or more days.`)}</th>
        <th class="num">Median idle days</th><th data-nosort></th></tr></thead>
      <tbody>${colRows}</tbody></table></div>`,
    )}
    ${
      !w.usingBoardColumns
        ? `<p class="footnote"><strong>Grouped by status name, not by the board's own columns.</strong> The join needs the
           status ID on each issue, which this snapshot predates. It fills in on the next collection; until then the order
           here is by size rather than by the board's flow.</p>`
        : ''
    }
    <h3>Who is holding what</h3>
    ${figures(
      wipPeople.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Person</th><th class="num">${term('In progress', 'Items assigned to this person that sit in an In Progress status category, in the active sprint.')}</th><th class="num">Points</th><th data-nosort>Tickets</th></tr></thead>
      <tbody>${peopleRows}</tbody></table></div>`,
    )}
    ${
      w.overloaded.length > 0
        ? `<div class="callout warn"><div class="big">${w.overloaded.length}</div><div class="body">
             ${w.overloaded.length === 1 ? 'person is' : 'people are'} holding more than ${w.wipLimit} items in progress at once
             (${w.overloaded.map((n) => escapeHtml(n)).join(', ')}). Parallel work does not finish faster; it finishes
             later, all at once, at the end of the sprint.</div></div>`
        : ''
    }
    ${explain(
      `Where the sprint's work is sitting right now, in the board's own columns, and how much of it has not moved in ${w.staleDays} days.`,
      'A points total says how much work there is; it never says where it is stuck. A queue building up in one column — code review, waiting test — is the actual constraint, and it is invisible in every other panel on this page.',
      'Look for the deepest column that is not “Done”, and for the red bar inside it. That is where to ask what is holding things up. Then look at whether one person is holding five items at once.',
    )}`;
}

// --- epics --------------------------------------------------------------------------------

function epicRow(ctx: RenderContext, r: EpicRollup, scope: 'active' | 'backlog'): string {
  const slice = scope === 'active' ? r.active : r.backlog;
  const progress = r.progress ?? 0;
  const epicLabel = r.key === '(no epic)' ? '(no epic)' : r.key;
  const tipText =
    `${r.key} — ${r.name}\n${r.total.issues} issues on this board, ${r.total.doneIssues} done` +
    `${r.blocked > 0 ? `\n${r.blocked} open item(s) blocked` : ''}` +
    `${r.carried > 0 ? `\n${r.carried} open item(s) carried 3+ sprints` : ''}` +
    `${r.people.length > 0 ? `\nOpen work with: ${r.people.join(', ')}` : ''}` +
    `${r.oldestOpenDays !== null ? `\nOldest open item: ${Math.round(r.oldestOpenDays)} days` : ''}`;
  return `<tr>
    <td>
      <div class="tcell">
        ${r.key === '(no epic)' ? `<span class="ticket tip" data-tip="${escapeAttr(tipText)}" title="${escapeAttr(tipText)}" tabindex="0">${escapeHtml(epicLabel)}</span>` : ticket(ctx, { key: r.key, summary: r.name })}
        <span class="tsummary">${escapeHtml(r.name)}${r.nameKnown ? '' : ' <em>(name not collected)</em>'}</span>
      </div>
    </td>
    <td class="num" data-sort="${slice.issues}">${slice.issues}</td>
    <td class="num" data-sort="${slice.points}">${slice.points}</td>
    <td class="num" data-sort="${slice.doneIssues}">${scope === 'active' ? slice.doneIssues : '—'}</td>
    <td class="num ${r.blocked > 0 ? 'poor' : ''}" data-sort="${r.blocked}">${r.blocked || '—'}</td>
    <td class="num ${r.carried > 0 ? 'watch' : ''}" data-sort="${r.carried}">${r.carried || '—'}</td>
    <td class="num" data-sort="${progress}">
      <div class="bar" title="${Math.round(progress * 100)}% of this epic's issues on this board are done">
        <span style="width:${(progress * 100).toFixed(1)}%"></span></div>
      <span class="bar-label">${rate(r.progress)}</span>
    </td>
    <td class="people">${r.people.slice(0, 3).map((p) => escapeHtml(p)).join(', ')}${r.people.length > 3 ? ` <span class="muted">+${r.people.length - 3}</span>` : ''}</td>
  </tr>`;
}

export function epicsPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const e = t.epics;
  if (!e || e.rollups.length === 0) {
    return notYet(
      'No epic data in this snapshot.',
      'Epic names come from the board\'s own epic endpoint, added in schema 4. Until the next collection runs, work can only be grouped by ticket key.',
    );
  }
  const active = activeEpics(e);
  const queued = backlogEpics(e).slice(0, 12);
  const focus = sprintFocus(e);

  const head = `<thead><tr>
      <th>Epic</th><th class="num">Issues</th><th class="num">Points</th><th class="num">Done</th>
      <th class="num">${term('Blocked', 'Open items under this epic that are flagged, or linked as blocked by something still open.')}</th>
      <th class="num">${term('Carried', 'Open items under this epic that have been in three or more sprints.')}</th>
      <th class="num">${term('Progress', "Share of this epic's issues ON THIS BOARD that are done. A count of issues, not of value, and blind to work under the same epic on another board.")}</th>
      <th>People</th>
    </tr></thead>`;

  return `
    <div class="kpis">
      ${kpi('Epics in this sprint', String(focus.epics), focus.largestKey ? `largest is ${escapeHtml(focus.largestKey)}` : '—', focus.epics > 6 ? 'watch' : '')}
      ${kpi('Biggest single epic', rate(focus.largestShare), 'share of the sprint’s issues', '', 'What fraction of this sprint’s issues sit under one epic. A sprint spread thinly across nine epics finishes none of them.')}
      ${kpi('Epics queued behind', String(backlogEpics(e).length), 'in the backlog, nothing in the sprint')}
      ${kpi('Blocked items across epics', String(e.rollups.reduce((a, r) => a + r.blocked, 0)), 'flagged or dependency-blocked', e.rollups.some((r) => r.blocked > 0) ? 'watch' : 'good')}
    </div>
    ${active.length > 0 ? `<div class="chart-box"><canvas id="chart-epics-${escapeHtml(t.key)}"></canvas></div>` : ''}
    <h3>Being worked on now</h3>
    ${
      active.length > 0
        ? figures(active.length, `<div class="table-scroll"><table data-sortable>${head}<tbody>${active.map((r) => epicRow(ctx, r, 'active')).join('')}</tbody></table></div>`)
        : `<p class="lede">Nothing in the active sprint carries an epic.</p>`
    }
    <h3>Queued in the backlog</h3>
    ${
      queued.length > 0
        ? figures(queued.length, `<div class="table-scroll"><table data-sortable>${head}<tbody>${queued.map((r) => epicRow(ctx, r, 'backlog')).join('')}</tbody></table></div>`)
        : `<p class="lede">No epic has backlog work waiting behind the sprint.</p>`
    }
    ${
      !e.namesCollected
        ? `<p class="footnote"><strong>Epic names were not collected for this snapshot</strong>, so the labels fall back to
           keys. Nothing else in this panel is affected.</p>`
        : ''
    }
    ${explain(
      'The larger pieces of work this sprint is advancing, and what is queued behind them. Grouped by the Epic Link on each ticket, with the epic name read from the board.',
      'A sprint reported as “73 issues, 198 points” says nothing about whether the team is finishing one thing or making 1% progress on eleven. The epic is the unit senior management already thinks in — and it is the level at which “when will this be done” has an answer.',
      'Look at the number of epics in the sprint. More than five or six usually means the team is spread across too many fronts to finish any of them, and consolidating is a planning decision, not an effort one. Then look at the Blocked column: a blocked epic is a stalled initiative, not a stalled ticket.',
    )}`;
}

// --- attention table -------------------------------------------------------------------------

const REASON_ADVICE: Record<string, string> = {
  blocked:
    'Someone has flagged this as blocked. It is the strongest signal on the board because a person already said so out loud — the only question is whether anyone acted on it.',
  'blocked-by':
    'This is linked as blocked by another ticket that is still open. If that ticket is not in the sprint, nobody is scheduled to clear it and this one will carry over.',
  'commented-blocked':
    'The comment thread reads like somebody is stopped, but the Flagged field is not set — so this blockage is invisible to every board filter and every count of blocked work, including the ones on this page.',
  overdue:
    'Past its due date. A due date on a ticket is usually a promise to somebody outside the team, and it is the kind of slip that reaches a customer before it reaches a report.',
  carried:
    'This has survived several sprints. Persistent carryover almost always means the item is too big or too vaguely defined, not that it is being worked badly. Splitting it usually helps more than chasing it.',
  stale:
    'Claimed but not moving. The most reliable early sign of a silent blockage — worth a direct question rather than waiting for the standup.',
  unestimated: 'No estimate in either point field, so this work is invisible to any forecast including the one on this page.',
  unassigned: 'In the sprint but nobody owns it. Usually means committed-but-not-started.',
};

export function attentionTable(ctx: RenderContext, items: AttentionItem[], limit: number, tableId: string): string {
  if (items.length === 0) {
    return `<p class="lede good-note">Nothing in the active sprint is blocked, stale or long-carried. This is the state you want.</p>`;
  }
  const rows = items
    .slice(0, limit)
    .map((it) => {
      const chips = it.reasons.map((r) => `<span class="chip ${r}" title="${escapeAttr(REASON_ADVICE[r] ?? '')}">${escapeHtml(r.replace('-', ' '))}</span>`).join('');
      const href = issueUrl(ctx.site, it.key);
      const detail =
        `<button class="close">Close</button>` +
        `<h3>${href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.key)}</a>` : escapeHtml(it.key)}${
          it.summary ? ` — ${escapeHtml(it.summary)}` : ''
        }</h3>` +
        `<div class="modal-sub">${escapeHtml(it.summaryType)} &middot; ${escapeHtml(it.status)}${it.assignee ? ` &middot; ${escapeHtml(it.assignee)}` : ' &middot; unassigned'}${
          it.epicKey ? ` &middot; epic ${escapeHtml(it.epicName ?? it.epicKey)}` : ''
        }</div>` +
        (it.description ? `<p class="modal-desc">${escapeHtml(it.description)}</p>` : '') +
        `<dl>` +
        `<dt>In sprints</dt><dd>${it.sprintCount}</dd>` +
        `<dt>Age</dt><dd>${it.ageDays === null ? '—' : `${Math.round(it.ageDays)} days since created`}</dd>` +
        `<dt>Last change</dt><dd>${it.idleDays === null ? '—' : `${Math.round(it.idleDays)} days ago`}</dd>` +
        `<dt>Estimate</dt><dd>${it.storyPoints === null ? 'none' : `${it.storyPoints} pts`}</dd>` +
        (it.blockedBy && it.blockedBy.length > 0 ? `<dt>Blocked by</dt><dd>${it.blockedBy.map((k) => escapeHtml(k)).join(', ')}</dd>` : '') +
        (it.overdueDays !== undefined ? `<dt>Overdue</dt><dd>${Math.round(it.overdueDays)} days past its due date</dd>` : '') +
        (it.commentCount !== undefined ? `<dt>Comments</dt><dd>${it.commentCount}</dd>` : '') +
        `</dl>` +
        (it.latestComment
          ? `<blockquote class="evidence">${escapeHtml(it.latestComment.body)}<footer>${escapeHtml(it.latestComment.author ?? 'unknown')} · ${escapeHtml(
              it.latestComment.created.slice(0, 10),
            )}</footer></blockquote>`
          : '') +
        it.reasons.map((r) => `<div class="advice"><strong>${escapeHtml(r.replace('-', ' '))}</strong> &mdash; ${escapeHtml(REASON_ADVICE[r] ?? '')}</div>`).join('');
      return `<tr class="clickable" data-detail="${encodeURIComponent(detail)}">` +
        `<td class="key-cell">${ticketWithTitle(ctx, it)}</td>` +
        `<td>${chips}</td>` +
        `<td class="num" data-sort="${it.sprintCount}">${it.sprintCount}</td>` +
        `<td class="num" data-sort="${it.idleDays ?? 0}">${it.idleDays === null ? '—' : Math.round(it.idleDays)}</td>` +
        `<td class="num" data-sort="${it.ageDays ?? 0}">${it.ageDays === null ? '—' : Math.round(it.ageDays)}</td>` +
        `<td>${it.assignee ? escapeHtml(it.assignee) : '<span class="muted">unassigned</span>'}</td>` +
        `<td>${escapeHtml(it.status)}</td>` +
        `</tr>`;
    })
    .join('');

  return `<div class="filter" data-filter-for="${escapeAttr(tableId)}">
      <label class="muted" for="${escapeAttr(tableId)}-q">Filter</label>
      <input id="${escapeAttr(tableId)}-q" type="search" autocomplete="off"
             placeholder="ticket, title, person, status or reason&hellip;">
      <span class="count"></span>
      ${openAllLink(ctx, items.map((i) => i.key), 'Open this list in Jira')}
    </div>
    <div class="table-scroll"><table data-sortable id="${escapeAttr(tableId)}">
    <thead><tr>
      <th>Ticket</th><th data-nosort>Why it needs you</th>
      <th class="num">Sprints</th><th class="num">Idle&nbsp;days</th><th class="num">Age&nbsp;days</th>
      <th>Assignee</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="footnote">Hover any ticket for its title, owner and latest comment; click the row for the full detail and what
      the reason usually means. Showing ${Math.min(items.length, limit)} of ${items.length}.
      Sorted by urgency: an explicit block outranks a dependency, which outranks a blocker written only in the comments,
      which outranks staleness.</p>`;
}

// --- review practice ------------------------------------------------------------------------

export function practicePanel(ctx: RenderContext, t: ReportTeamInput): string {
  const p = t.practice;
  const n = nouns(ctx);
  if (!t.review) {
    return `<p class="lede">No GitLab group is mapped to this team, so review practice cannot be measured.
      That mapping is a derivation job, not a question for the reader &mdash; see docs/decisions.md.</p>`;
  }
  const r = t.review;
  const plotted = p.people.filter((x) => x.authored > 0 || x.reviewsGiven > 0);
  const rows = plotted
    .slice(0, 20)
    .map((x) => {
      const share = x.mergedKnown > 0 ? x.mergedUnreviewed / x.mergedKnown : null;
      const tone = share === null ? '' : share >= 0.5 ? 'poor' : share >= 0.2 ? 'watch' : 'good';
      return `<tr>
        <td>${escapeHtml(x.name)}</td>
        <td class="num">${x.authored}</td>
        <td class="num ${tone}" data-sort="${share ?? -1}">${x.mergedKnown === 0 ? '—' : `${x.mergedUnreviewed} of ${x.mergedKnown}`}</td>
        <td class="num ${tone}" data-sort="${share ?? -1}">${share === null ? '—' : rate(share)}</td>
        <td class="num ${p.reviewerIdentitiesUnknown ? 'unknown' : x.reviewsGiven === 0 ? 'watch' : ''}" data-sort="${x.reviewsGiven}">${p.reviewerIdentitiesUnknown ? '?' : x.reviewsGiven}</td>
      </tr>`;
    })
    .join('');

  const projects = new Map<string, { path: string; count: number }>();
  for (const mr of t.mergeRequests ?? []) {
    if (!mr.projectPath) continue;
    const e = projects.get(mr.projectPath) ?? { path: mr.projectPath, count: 0 };
    e.count++;
    projects.set(mr.projectPath, e);
  }
  const topProjects = [...projects.values()].sort((a, b) => b.count - a.count).slice(0, 12);

  return `
    <div class="kpis">
      ${kpi('Merged with no human review', rate(r.mergedKnown ? r.mergedWithoutHumanReview / r.mergedKnown : null), `${r.mergedWithoutHumanReview} of ${r.mergedKnown} ${n.many} a person opened`, r.mergedKnown === 0 ? 'unknown' : r.mergedWithoutHumanReview / r.mergedKnown >= 0.4 ? 'poor' : r.mergedWithoutHumanReview / r.mergedKnown >= 0.2 ? 'watch' : 'good')}
      ${kpi('Opened by automation', String(r.automationAuthored), 'excluded from every rate here', '', 'Dependency bumps and mechanical analyser fixes that nobody was ever meant to read. Counting them changed the unreviewed rate from 54% to 12% on the same data - which is why they are excluded and reported separately.')}
      ${kpi('Open → first human review', hours(r.hoursToFirstHumanReviewP50), `p90 ${hours(r.hoursToFirstHumanReviewP90)} · basis ${r.hoursToFirstHumanReviewBasis}`, '', `Computed only over ${n.many} that GOT a human review. A survivorship sample - always quote it with its basis.`)}
      ${kpi('Approval → merged', hours(r.hoursApprovalToMergeP50), `p90 ${hours(r.hoursApprovalToMergeP90)}`, r.hoursApprovalToMergeP50 !== null && r.hoursApprovalToMergeP50 >= 48 ? 'poor' : '', 'Time between a person approving and the change actually merging. A large number here is a process or permissions problem, not a reviewer-availability one.')}
    </div>
    ${
      (r.latencyBuckets ?? []).some((b) => b.count > 0) || (r.neverHumanReviewed ?? 0) > 0
        ? `<h3>How long work waits for a person</h3>
           <p class="chart-note">The distribution behind that median. The <strong>never</strong> bar is not a slow
             bucket &mdash; it is work that merged or is sitting with nobody having looked at it at all, and it is
             deliberately drawn apart from the latency bars so it cannot read as &ldquo;reviewed, eventually&rdquo;.</p>
           <div class="chart-box" style="height:196px"><canvas id="chart-latency-${escapeAttr(t.key)}"></canvas></div>
           <p class="footnote">${(r.latencyBuckets ?? [])
             .map((b) => `${escapeHtml(b.label)} <strong>${b.count}</strong>`)
             .join(' &middot; ')} &middot; never <strong>${r.neverHumanReviewed ?? 0}</strong>
             &mdash; over the ${r.reviewDetailKnown} ${n.many} a person opened whose review detail was read.
             Bucket boundaries are working-time landmarks, not round numbers: review latency is log-distributed
             everywhere, and uniform 24-hour buckets put &ldquo;within the hour&rdquo; and &ldquo;same day&rdquo; in one bar.</p>`
        : ''
    }
    ${plotted.length > 0 ? `<div class="chart-box" style="height:${Math.max(200, Math.min(14, plotted.length) * 26 + 90)}px"><canvas id="chart-practice-${escapeHtml(t.key)}"></canvas></div>` : ''}
    ${figures(
      plotted.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr>
        <th>Person</th><th class="num">${n.abbrMany} opened</th><th class="num">Merged unreviewed</th>
        <th class="num">Rate</th><th class="num">${term('Reviews given', `Distinct ${n.many} by OTHER people that this person commented on or approved. Deduped per ${n.one}, so a reviewer leaving eight remarks counts once.`)}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`,
    )}
    ${
      p.reviewerIdentitiesUnknown
        ? `<p class="footnote"><strong>"Reviews given" is unknown for this snapshot.</strong> It needs commenter
           identities, which were added in schema 3; this data was collected before that. Re-run <code>collect</code>
           to populate it. Unknown is shown as <code>?</code> rather than as zero.</p>`
        : ''
    }
    ${
      topProjects.length > 0
        ? `<h3>Where the code lives</h3>
           <p class="lede">The repositories these ${n.many} came from, busiest first. Every figure above was counted
             from these and nowhere else.</p>
           <div class="repos">${topProjects
             .map(
               (pr) =>
                 `<a class="repo" href="${escapeAttr(gitlabProjectUrl(ctx.gitlabOrigin, pr.path))}" target="_blank" rel="noopener noreferrer">
                   <span class="path">${escapeHtml(pr.path)}</span><span class="n">${pr.count}</span></a>`,
             )
             .join('')}</div>
           ${(t.gitlabGroups ?? [])
             .map((g) => `<p class="footnote">${link(gitlabGroupMergeRequestsUrl(ctx.gitlabOrigin, g), `Open the merged ${n.many} for ${g} in ${n.host}`)}</p>`)
             .join('')}`
        : ''
    }
    <p class="footnote">
      <strong>This is a training list, not a ranking.</strong> "Merged unreviewed" means the ${n.one} went in with
      no comment and no approval from anybody but its author &mdash; a gap in company practice that a conversation
      fixes. "Reviews given" is the counterpart: distinct ${n.many} by other people that this person commented on
      or approved, which is the habit worth spreading. Bot-authored ${n.many} are excluded from both.
      There is deliberately no points-per-person figure anywhere in this report &mdash; see the legend.
    </p>
    ${explain(
      `Whether merged code was looked at by a second person, and who is doing the looking. Counted from ${n.many} a PERSON opened; automation-authored ones are excluded and reported separately.`,
      `It is the only leading indicator in this report. Unreviewed merges show up in defects and in bus-factor months before they show up in a velocity chart. And the denominator is the argument: including bot-authored ${n.many} changed this figure from 54% to 12% on identical data.`,
      'Find the two or three people the number actually comes from and pair them with somebody who already reviews. A policy announcement changes nothing; a named pairing does. If “Approval → merged” is large, the problem is a gate after sign-off and no amount of reviewer training touches it.',
    )}`;
}

// --- churn, cycle, backlog, slowest --------------------------------------------------------

export function churnPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const h = t.history;
  if (!h || h.days < 2) {
    return notYet(
      'Not measured yet.',
      `Everything in this panel is the difference between two collected days, and this profile has ${h?.days ?? 0} for
       ${escapeHtml(t.key)}. That is not zero churn &mdash; it is nothing measured. It fills in on the next collection.`,
    );
  }
  const c = h.churn;
  if (!c) return `<p class="lede">No active sprint to measure scope against.</p>`;

  const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
  const cell = (label: string, value: string, tone = '') =>
    `<div class="churn-cell"><div class="n ${tone}">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div></div>`;

  // The same caution the CLI carries: consecutive folder names are not a day of
  // activity. The first two real snapshots on this estate were 8.7 hours apart
  // and every hour of it was overnight, so every figure below was correctly zero
  // and would have read as a quiet sprint day.
  const overnight =
    h.observedHours !== null && h.observedHours < 20
      ? `<div class="callout neutral"><div class="body"><strong>These two snapshots are ${escapeHtml(String(h.observedHours))} hours
           apart</strong>, which is not a full working day. A zero here means nothing changed in those hours &mdash;
           not that nothing changed in the sprint.</div></div>`
      : '';

  return `
    ${overnight}
    <div class="churn">
      ${cell('added', `${signed(c.addedPoints)} pts`, c.addedPoints > 0 ? 'up' : '')}
      ${cell('removed', `-${c.removedPoints} pts`, c.removedPoints > 0 ? 'down' : '')}
      ${cell('re-estimated', `${signed(c.reestimatedPoints)} pts`, c.reestimatedPoints > 0 ? 'up' : c.reestimatedPoints < 0 ? 'down' : '')}
      ${cell('net change', `${signed(c.netPoints)} pts`, c.netPoints > 0 ? 'up' : c.netPoints < 0 ? 'down' : '')}
      ${cell('churn rate', c.churnRate === null ? '—' : rate(c.churnRate))}
      ${cell('observations', `${c.observations} day${c.observations === 1 ? '' : 's'}`)}
    </div>
    ${
      c.lateAdditions.length > 0
        ? figures(
            Math.min(c.lateAdditions.length, 15),
            `<div class="table-scroll"><table data-sortable>
             <thead><tr><th>Added after the sprint opened</th><th>Type</th><th class="num">Points</th><th>Assignee</th></tr></thead>
             <tbody>${c.lateAdditions
               .slice(0, 15)
               .map(
                 (a) => `<tr><td class="key-cell">${ticket(ctx, { key: a.key, issueType: a.issueType, storyPoints: a.storyPoints, assignee: a.assignee })}</td><td>${escapeHtml(a.issueType)}</td>
                   <td class="num" data-sort="${a.storyPoints ?? -1}">${a.storyPoints ?? '—'}</td>
                   <td>${a.assignee ? escapeHtml(a.assignee) : '<span class="muted">unassigned</span>'}</td></tr>`,
               )
               .join('')}</tbody></table></div>`,
          ) + (c.lateAdditions.length > 15 ? `<p class="footnote">... and ${c.lateAdditions.length - 15} more.</p>` : '')
        : `<p class="footnote">Nothing entered this sprint after it opened, across ${c.observations} observed day(s).</p>`
    }
    ${
      h.burndown.length >= 2
        ? `<div class="chart-box short"><canvas id="chart-burndown-${escapeHtml(t.key)}"></canvas></div>`
        : `<p class="footnote">A burndown line needs at least two collected days holding this sprint.</p>`
    }
    <p class="footnote"><strong>These are the figures a single snapshot cannot give.</strong> "Committed" and
      "carryover" for a closed sprint are labelled UNUSABLE elsewhere in this report because they count every issue
      in that sprint <em>now</em>. Everything here is the difference between two records, each written on the day it
      was true, and no later board activity can restate either. Re-estimation counts as churn: a 3 that becomes an 8
      moved the commitment by 5 points without a ticket moving.</p>
    ${explain(
      'What changed about the sprint between two collected days: work added, work removed, and work re-estimated.',
      'It separates “this team missed its commitment” from “this team’s commitment was changed underneath it”. Only one of those is a delivery problem, and a burndown alone cannot tell them apart.',
      'If scope grew, show the added list at the retrospective and ask who agreed to it. The aim is not to refuse mid-sprint work — it is to make the trade visible at the moment it is made.',
    )}`;
}

export function cyclePanel(ctx: RenderContext, t: ReportTeamInput): string {
  const h = t.history;
  if (!h || h.days < 2) {
    return notYet(
      'Not measured yet.',
      'Cycle time needs to see work move into progress and then out of it, which takes at least two collected days.',
    );
  }
  const c = h.cycle;
  if (c.basis === 0) {
    return notYet(
      'Nothing has both started and finished inside the observed window yet.',
      c.censored > 0
        ? `${c.censored} item(s) were already in progress when collection began on ${escapeHtml(c.observedFrom ?? '?')}, so their start is unobserved and they are excluded rather than counted from day one.`
        : '',
    );
  }

  // The distribution behind the two percentiles. Every mark on it is also a row
  // in the table below and both numbers are in the KPI tiles, so a blocked
  // script loses the shape and no figure.
  const scatter =
    (h.cyclePoints?.length ?? 0) >= 3
      ? `<p class="chart-note">Each mark is one resolved ticket: when it resolved, against how long it was in
           progress. Read the SPREAD, not the marks &mdash; a tight band with two high outliers is two
           conversations, and a wide cloud at the same p90 is a process. Hollow rings started before collection
           began, so their value is a lower bound and they are excluded from the percentile lines.</p>
         <div class="chart-box"><canvas id="chart-cycle-${escapeAttr(t.key)}"></canvas></div>
         ${
           (h.cyclePointsOmitted ?? 0) > 0
             ? `<p class="footnote">Plotting the ${h.cyclePoints.length} most recently resolved items;
                ${h.cyclePointsOmitted} older observation(s) are not drawn. The percentiles above are computed over
                <strong>all ${c.basis}</strong> uncensored observations, not over the plotted subset.</p>`
             : ''
         }`
      : '';

  return `
    <div class="kpis">
      ${kpi('Cycle time p50', `${fmt(c.p50)} d`, 'first seen in progress &rarr; resolved', '', 'How long work takes once somebody actually starts it. Excludes however long it sat in the backlog first.')}
      ${kpi('Cycle time p90', `${fmt(c.p90)} d`, `basis ${c.basis} item(s)`)}
      ${kpi('Backlog dwell', c.medianBacklogDwellDays === null ? '—' : `${fmt(c.medianBacklogDwellDays)} d`, 'median wait before work started')}
      ${kpi('Unobserved starts', String(c.censored), 'already in progress on day one', c.censored > 0 ? 'watch' : 'good')}
    </div>
    ${scatter}
    ${figures(
      h.slowestCycle.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Ticket</th><th>Type</th><th class="num">Cycle&nbsp;days</th><th class="num">Lead&nbsp;days</th><th>Started</th><th>Resolved</th></tr></thead>
      <tbody>${h.slowestCycle
        .map(
          (i) => `<tr><td class="key-cell">${ticket(ctx, { key: i.key, issueType: i.issueType })}</td><td>${escapeHtml(i.issueType)}</td>
            <td class="num" data-sort="${i.cycleDays}">${i.cycleDays.toFixed(1)}</td>
            <td class="num" data-sort="${i.leadDays ?? -1}">${i.leadDays === null ? '—' : i.leadDays.toFixed(0)}</td>
            <td>${escapeHtml(i.startedOn)}</td><td>${escapeHtml(i.resolvedOn)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`,
    )}
    <p class="footnote"><strong>This is the metric "Longest to get through" is labelled WEAK for lacking.</strong>
      Lead time is created &rarr; resolved and is mostly backlog dwell; cycle time counts only the stretch someone was
      actually working, measured from the first day the item was seen in an In&nbsp;Progress status. Work already
      underway when collection began has no observed start, so it is a lower bound and is excluded from the
      percentiles rather than flattering them.</p>`;
}

/** The cumulative flow diagram, with every value it plots written out beneath it.
 *
 *  The table is not a nicety here, it is the rule: a CFD is read by shape and a
 *  shape is exactly what a blocked script leaves behind as blank space. Every
 *  cell the chart draws is a cell in the grid below it, so the panel degrades
 *  to a day-by-day count of where the sprint's work was sitting - which is
 *  slower to read and says the same thing. */
export function cfdPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const h = t.history;
  if (!h || h.days < 2) {
    return notYet(
      'Not measured yet.',
      `A flow diagram is a picture of what changed between collected days, and this profile has ${h?.days ?? 0} for
       ${escapeHtml(t.key)}. It is not a claim that nothing has moved &mdash; nothing has been observed moving yet.
       It fills in on the next collection.`,
    );
  }

  const flow = h.flow;
  if (!flow) {
    // Two genuinely different causes, and the reader has to be told which:
    // "no active sprint" is a state of the team, "no board columns" is a state
    // of the board configuration and is somebody's job to fix.
    const noColumns = h.columnDwell.length === 0;
    return notYet(
      noColumns ? 'No active sprint, or no board columns to place work in.' : 'No active sprint to chart.',
      `A flow diagram distributes an active sprint's work across the board's own columns. Without an active sprint
       there is no flow to draw, and without a column configuration there is nothing to distribute the work across
       &mdash; which is the <code>no-board-columns</code> data-quality finding, not an absence of work. Status names
       are never used as a substitute here, for the reason the rest of this report gives.`,
    );
  }

  if (flow.days.length < 2) {
    return notYet(
      'Only one day of this sprint has been collected.',
      `The sprint ${escapeHtml(flow.sprintName)} has been observed on a single collected day so far, and one point is
       not a flow. A chart drawn from it would be a flat line, which is the picture of a sprint going perfectly.`,
    );
  }

  const first = flow.days[0]!;
  const last = flow.days[flow.days.length - 1]!;
  const doneIdx = flow.columns.length - 1;

  // Which band grew the most across the observed window. This is the whole
  // point of the panel expressed as one figure, so it is stated rather than
  // left to be spotted - and it is a difference between two recorded counts,
  // not a rate or a projection.
  const growth = flow.columns
    .map((column, i) => ({ column, delta: (last.counts[i] ?? 0) - (first.counts[i] ?? 0), now: last.counts[i] ?? 0 }))
    // The done column growing is work being finished, which is the one band
    // whose growth is good news and must not be reported as a warning.
    .filter((_, i) => i !== doneIdx)
    .sort((a, b) => b.delta - a.delta)[0];

  const scopeDelta = last.total - first.total;

  const header = flow.columns
    .map((c) => `<th class="num">${escapeHtml(c)}</th>`)
    .join('');
  const rows = flow.days
    .map(
      (d, di) => `<tr>
        <td><strong>${escapeHtml(d.date)}</strong>${
        di === 0 && flow.censoredStart ? ' <span class="tag caveat">first collected day</span>' : ''
      }</td>
        ${flow.columns.map((_, i) => `<td class="num">${d.counts[i] ?? 0}</td>`).join('')}
        <td class="num"><strong>${d.total}</strong></td>
      </tr>`,
    )
    .join('');

  return `
    <div class="kpis">
      ${kpi(
        'In this sprint now',
        String(last.total),
        scopeDelta === 0
          ? 'unchanged since the first collected day'
          : `${scopeDelta > 0 ? '+' : ''}${scopeDelta} since ${escapeHtml(first.date)}`,
        scopeDelta > 0 ? 'watch' : '',
        'Issues, not points: several boards here leave most of their sprint unestimated, so a points-based flow diagram would draw the estimated minority and silently omit the rest.',
      )}
      ${kpi(
        'Finished',
        String(last.counts[doneIdx] ?? 0),
        `in ${escapeHtml(flow.columns[doneIdx] ?? '')} · ${(last.counts[doneIdx] ?? 0) - (first.counts[doneIdx] ?? 0)} since ${escapeHtml(first.date)}`,
        '',
        "The bottom band of the diagram: work sitting in the board's last column. It is the board's own definition of done, not a status name this tool chose.",
      )}
      ${kpi(
        'Fastest-growing queue',
        growth && growth.delta > 0 ? `+${growth.delta}` : '—',
        growth && growth.delta > 0
          ? `${escapeHtml(growth.column)} · ${growth.now} there now`
          : 'no queue has grown across the observed days',
        growth && growth.delta > 0 ? 'watch' : 'good',
        'The column that gained the most work between the first and last collected day, excluding the done column. A band that widens is work arriving in a stage faster than it leaves - which is what a flow diagram exists to show, and what a burndown cannot.',
      )}
      ${kpi(
        'Days observed',
        String(flow.days.length),
        h.observedHours !== null ? `${h.observedHours}h end to end` : 'single capture',
        flow.days.length < 3 ? 'watch' : '',
        'Collected days on which this sprint existed. Two is the minimum for a shape; a fortnight of them is where the shape starts being worth arguing about.',
      )}
    </div>
    <div class="chart-box"><canvas id="chart-cfd-${escapeAttr(t.key)}"></canvas></div>
    <p class="chart-note">${escapeHtml(flow.sprintName)} &mdash; each band is one of ${escapeHtml(
      t.boardName ?? t.key,
    )}'s own columns, stacked with its last column at the bottom. The top line is the sprint's whole scope.</p>
    ${figures(
      flow.days.length,
      `<div class="table-scroll"><table>
      <thead><tr><th>Collected day</th>${header}<th class="num">${term(
        'In sprint',
        'Every issue in the sprint on that day, which is the top line of the diagram. The bands beneath sum to it exactly.',
      )}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
    )}
    <p class="footnote">${
      flow.censoredStart
        ? `<strong>The left edge of this diagram is where collection began, not where the sprint began.</strong>
           ${escapeHtml(flow.sprintName)} was already running on ${escapeHtml(first.date)}, the first day collected for
           this team, so the shape before that is unknown rather than flat.`
        : `The diagram starts on ${escapeHtml(first.date)}, the first collected day this sprint appears on.`
    } ${
      h.observedHours !== null && h.observedHours < 20
        ? `<strong>The whole observed window is ${h.observedHours} wall-clock hours</strong>, which is less than a
           working day &mdash; a flat diagram over that interval is a short interval, not a stalled sprint.`
        : ''
    } Every figure the chart draws is in the table above it, so a blocked script costs the shape and no data.</p>
    ${explain(
      "Where the active sprint's work sat, across the board's own columns, on every day that was collected. The bands are stacked, so the top line is the sprint's whole scope and each band's thickness is how much work was in that column that day.",
      'This is the only view here that shows a queue GROWING. The column-ageing panel says how long work has sat in each column right now, and the burndown says how much is left in total; neither can show work arriving in a stage faster than it leaves, which is the failure that produces a sprint where everything is "nearly done" on the last day. A widening band is that failure while it is still cheap to fix.',
      'Read the bands, not the values. A band that thickens day over day is the constraint - go and ask what the work in it is waiting for. A top line that rises is scope arriving mid-sprint, and the churn panel names exactly which tickets. A bottom band that stays flat while the others move is work being started and not finished, which is a WIP problem rather than a capacity one.',
    )}`;
}

/** How long the active sprint's open work has been sitting in each board column.
 *
 *  This is the panel the WIP panel's "median idle days" column cannot honestly
 *  be: that figure is derived from `updated`, which moves on ANY field change -
 *  a comment, a re-estimate, a relabel - so a ticket that has sat in `waiting
 *  test` for a fortnight reads as freshly touched the moment somebody comments
 *  on it. This one is walked from column membership actually RECORDED on each
 *  collected day (history.ts's columnDwellNow), so it carries the same
 *  evidentiary standing as the churn and cycle-time panels and the same bound:
 *  nothing can see before the first snapshot.
 *
 *  The two panels are deliberately kept apart rather than merged. "Where is the
 *  work now" is answerable from one snapshot and is on the board panel; "how
 *  long has it been there" needs two and belongs with the other observed
 *  metrics, under the same caveat about when collection started. */
export function columnAgeingPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const h = t.history;
  if (!h || h.days < 2) {
    return notYet(
      'Not measured yet.',
      `How long something has sat in a column is a difference between two collected days, and this profile has
       ${h?.days ?? 0} for ${escapeHtml(t.key)}. That is not "nothing is ageing" &mdash; it is nothing measured.
       It fills in on the next collection.`,
    );
  }
  const cols = h.columnDwell;
  if (cols.length === 0) {
    return notYet(
      'No active sprint to measure.',
      'Column ageing covers the work open in an active sprint. With no active sprint there is no queue to age, which is not the same as a queue that is moving.',
    );
  }

  // REPORTABLE, not merely non-null. Measured on the first real snapshot that
  // could produce this panel: board 701's `waiting test` held 47 open issues of
  // which 46 were already there on day one, so its "median" rested on a single
  // observation - and this KPI printed it as "Slowest queue: 3 d" beside a count
  // of 47. See MIN_DWELL_BASIS. `cols` is already sorted by median descending.
  const reportable = cols.filter(dwellIsReportable);
  const worst = reportable[0];
  const totalOpen = cols.reduce((a, c) => a + c.count, 0);
  const totalCensored = cols.reduce((a, c) => a + c.censored, 0);
  // Deliberately not a threshold with a colour: the reader is told what the
  // longest queue IS and left to judge it, because a "good" dwell for `waiting
  // test` on a fortnightly cadence is not one for `in development`.
  //
  // Depth needs no basis at all - a count of what is sitting there right now is
  // exact on one snapshot - so this KPI is always available even when every
  // median is withheld, and it is the one that still says something useful on a
  // profile that has only just started collecting.
  const deepest = [...cols].sort((a, b) => b.count - a.count)[0];

  const rows = cols
    .map((c) => {
      const oldest = c.oldest
        .map(
          (i) =>
            `${ticket(ctx, { key: i.key, issueType: i.issueType, assignee: i.assignee, idleDays: i.dwellDays })}` +
            `<span class="muted">&nbsp;${Math.round(i.dwellDays)}d${i.censored ? '+' : ''}</span>`,
        )
        .join(' ');
      // A withheld median renders as an em dash, never as 0 - and sorts to the
      // bottom rather than to the top, so "sort by slowest" does not lead with
      // the columns that could not be measured.
      const ok = dwellIsReportable(c);
      return `<tr class="${ok ? '' : 'row-muted'}">
        <td><strong>${escapeHtml(c.column)}</strong></td>
        <td class="num" data-sort="${c.count}">${c.count}</td>
        <td class="num" data-sort="${ok ? c.medianDwellDays! : -1}">${ok ? Math.round(c.medianDwellDays!) : '<span class="muted">—</span>'}</td>
        <td class="num" data-sort="${ok ? c.p90DwellDays! : -1}">${ok ? Math.round(c.p90DwellDays!) : '<span class="muted">—</span>'}</td>
        <td class="num" data-sort="${c.basis}">${
          ok
            ? c.basis
            : `<span class="tip" data-tip="${escapeAttr(`Only ${c.basis} of the ${c.count} issues in this column were observed entering it, which is too few for a median to mean anything. The count is exact; the percentiles are withheld rather than guessed.`)}" title="too few observed entries to quote a median">${c.basis}</span>`
        }</td>
        <td class="num" data-sort="${c.censored}">${c.censored > 0 ? `<span class="tag caveat">${c.censored}</span>` : '<span class="muted">—</span>'}</td>
        <td class="keys">${oldest}${
          c.count > c.oldest.length ? ` <span class="muted">+${c.count - c.oldest.length}</span>` : ''
        }</td>
        <td>${openAllLink(ctx, c.oldest.map((i) => i.key), `open ${Math.min(c.oldest.length, 60)}`)}</td>
      </tr>`;
    })
    .join('');

  return `
    <div class="kpis">
      ${kpi(
        'Slowest queue',
        worst ? `${Math.round(worst.medianDwellDays!)} d` : '—',
        worst
          ? `${escapeHtml(worst.column)} · from ${worst.basis} observed`
          : `no column has ${MIN_DWELL_BASIS} observed entries yet`,
        worst ? '' : 'unknown',
        `The board column whose open work has the longest median time sitting in it, counted from observed column membership rather than from the "updated" timestamp. Withheld entirely until some column has at least ${MIN_DWELL_BASIS} observed entries - a median drawn from one ticket is not a median.`,
      )}
      ${kpi(
        'Deepest queue',
        deepest ? String(deepest.count) : '—',
        deepest ? escapeHtml(deepest.column) : '—',
        '',
        'The column holding the most open sprint work right now. Depth and slowness are different problems: a deep column that turns over quickly is a working pipeline.',
      )}
      ${kpi('Open work placed', String(totalOpen), `across ${cols.length} column${cols.length === 1 ? '' : 's'}`)}
      ${kpi(
        'Unobserved entries',
        String(totalCensored),
        'already in their column on day one',
        totalCensored > 0 ? 'watch' : 'good',
        'These were already sitting where they are when collection began, so how long they have been there is unknown - a LOWER bound, not a number. They are counted here and excluded from the medians rather than flattering them.',
      )}
    </div>
    ${reportable.length > 0 ? `<div class="chart-box short"><canvas id="chart-ageing-${escapeAttr(t.key)}"></canvas></div>` : ''}
    ${figures(
      cols.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr>
        <th>Column</th>
        <th class="num">${term('Open', 'Issues from the active sprint sitting in this column right now. Exact - a count needs only one snapshot.')}</th>
        <th class="num">${term('Median days', 'Median time the issues in this column have been in it, from the first collected day each was observed here. Excludes the ones already here when collection started, and is withheld entirely below ' + MIN_DWELL_BASIS + ' observed entries.')}</th>
        <th class="num">${term('p90 days', 'The 90th percentile of the same. A p90 far above the median is a stuck tail rather than a uniformly slow queue.')}</th>
        <th class="num">${term('Basis', 'Issues in this column whose entry into it was actually observed. The two figures to the left are computed from these and nothing else.')}</th>
        <th class="num">${term('Unobserved', 'Issues already in this column on the first collected day. Their real entry predates collection, so they are excluded from the percentiles.')}</th>
        <th>Longest sitting</th>
        <th data-nosort></th>
      </tr></thead>
      <tbody>${rows}</tbody></table></div>`,
    )}
    <p class="footnote"><strong>A <code>+</code> after a day count means a lower bound</strong> &mdash; that ticket was
      already in its column on ${escapeHtml(h.observedFrom ?? 'the first collected day')}, so it has been there at least
      that long and possibly far longer. A median is <strong>withheld rather than estimated</strong> for any column with
      fewer than ${MIN_DWELL_BASIS} observed entries: the count in such a row is still exact, and only the percentiles
      are missing. ${
        reportable.length === 0
          ? `<strong>No column on this board has ${MIN_DWELL_BASIS} observed entries yet</strong>, so no median is shown anywhere above and the chart is omitted. Every count is real; what is missing is time, and it accrues on its own as work moves through the board on days that were collected.`
          : `${totalCensored} of ${totalOpen} open items were already in their column when collection began, and that proportion falls every day.`
      }</p>
    ${explain(
      "How long the active sprint's open work has been sitting in each of the board's own columns, walked from the column each ticket was recorded in on every collected day.",
      'This is the queue that is actually holding delivery up, and it is the one number a status board cannot show: a column view says twelve things are "In Review" and gives no hint that four of them have been there three weeks. It is also the honest version of the idle figure on the board panel above, which is derived from the ticket\'s last-updated timestamp and therefore resets when somebody merely comments.',
      'Find the column with the longest median and ask what the work in it is waiting FOR - it is usually a person or a permission rather than effort. Then compare the median against the p90: if the p90 is far higher, the queue is fine and a handful of specific tickets are stuck, and those are named in the last column.',
    )}`;
}

export function backlogPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const b = t.backlog;
  if (!b || b.issues === 0) return `<p class="lede">Nothing on this board's backlog.</p>`;
  const stale = b.issues > 0 ? b.olderThan90Days / b.issues : 0;
  return `
    <div class="kpis">
      ${kpi('On the backlog', String(b.issues), `${b.points} pts estimated`)}
      ${kpi('Unestimated', pct(b.unestimated, b.issues), `${b.unestimated} of ${b.issues}`, b.unestimated / b.issues >= 0.5 ? 'watch' : 'good')}
      ${kpi('Median age', b.medianAgeDays === null ? '—' : `${Math.round(b.medianAgeDays)} d`, 'since created')}
      ${kpi('Older than 90 days', pct(b.olderThan90Days, b.issues), `${b.olderThan90Days} of ${b.issues}`, stale >= 0.5 ? 'watch' : 'good')}
    </div>
    <div class="table-scroll"><table data-sortable>
      <thead><tr><th>Next up</th><th>Type</th><th class="num">Points</th><th class="num">Age&nbsp;days</th><th>Epic</th><th>Status</th></tr></thead>
      <tbody>${b.nextUp
        .map(
          (i) => `<tr><td class="key-cell">${ticketWithTitle(ctx, i)}</td><td>${escapeHtml(i.issueType)}</td>
            <td class="num" data-sort="${i.storyPoints ?? -1}">${i.storyPoints ?? '—'}</td>
            <td class="num" data-sort="${i.ageDays ?? 0}">${i.ageDays === null ? '—' : Math.round(i.ageDays)}</td>
            <td>${i.epicKey ? escapeHtml(i.epicName ?? i.epicKey) : '<span class="muted">—</span>'}</td>
            <td>${escapeHtml(i.status)}</td></tr>`,
        )
        .join('')}</tbody></table></div>
    <p class="footnote"><strong>"Next up" is board rank order</strong> &mdash; the order the team put them in, which is
      what actually gets pulled &mdash; not age order, which would show the items nobody wants. A large share older
      than 90 days is not a defect on its own; a backlog where <em>most</em> items are is a list nobody triages.
      ${openAllLink(ctx, b.allKeys, 'Open the backlog in Jira')}</p>`;
}

export function slowestPanel(ctx: RenderContext, items: SlowItem[], windowDays: number): string {
  if (items.length === 0) return `<p class="lede">Nothing resolved in the last ${windowDays} days.</p>`;
  const rows = items
    .map(
      (s) => `<tr>
      <td class="key-cell">${ticket(ctx, { key: s.key, issueType: s.issueType, assignee: s.assignee, sprintCount: s.sprintCount })}</td>
      <td>${escapeHtml(s.issueType)}</td>
      <td class="num" data-sort="${s.leadTimeDays}">${Math.round(s.leadTimeDays)}</td>
      <td class="num" data-sort="${s.sprintCount}">${s.sprintCount}</td>
      <td>${s.assignee ? escapeHtml(s.assignee) : '<span class="muted">unassigned</span>'}</td>
      <td>${s.resolutionDate ? escapeHtml(s.resolutionDate.slice(0, 10)) : '—'}</td>
    </tr>`,
    )
    .join('');
  return `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Ticket</th><th>Type</th><th class="num">Lead&nbsp;days</th><th class="num">Sprints</th><th>Assignee</th><th>Resolved</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="footnote"><strong>Lead time is created &rarr; resolved</strong>, so it includes however long the item sat
      in the backlog before anyone picked it up. That makes it a fair question about the <em>backlog</em> and a bad one
      about a person &mdash; a 500-day lead time usually means an old ticket was finally cleared, not that someone took
      500 days. True cycle time needs work-start, which consecutive daily snapshots supply.</p>`;
}

// --- composition -------------------------------------------------------------------------------

export function compositionPanel(t: ReportTeamInput): string {
  const c = t.composition;
  if (!c || c.sprints.length === 0) {
    return notYet('Not measured yet.', 'Composition is counted from who completed work in each closed sprint, and this board has none in the window.');
  }
  const recent = [...c.sprints].reverse().slice(0, 12);
  const changes = recent.filter((s) => s.joined.length > 0 || s.left.length > 0);

  return `
    <div class="kpis">
      ${kpi('People delivering now', c.latestContributors === null ? '—' : String(c.latestContributors), 'in the most recent closed sprint', '', 'Distinct people who completed at least one issue inside that sprint window.')}
      ${kpi('Typical team size', c.medianContributors === null ? '—' : String(c.medianContributors), `median across ${c.sprints.length} sprints`)}
      ${kpi('People seen in the window', String(c.people.length), `${c.people.filter((p) => p.current).length} in the latest sprint`)}
      ${kpi('Sprints with a change', String(changes.length), `of the last ${recent.length}`, changes.length > recent.length / 2 ? 'watch' : '')}
    </div>
    <div class="chart-box"><canvas id="chart-composition-${escapeHtml(t.key)}"></canvas></div>
    ${figures(
      recent.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Sprint</th><th class="num">People</th><th class="num">Points</th>
        <th class="num">${term('Pts / person', 'Points completed divided by the number of people who completed anything. It exists ONLY so a velocity drop can be read against a headcount drop - it is never shown per person and is not a productivity measure.')}</th>
        <th>Joined</th><th>Not seen this sprint</th></tr></thead>
      <tbody>${recent
        .map(
          (s) => `<tr>
        <td>${escapeHtml(s.name)}<div class="muted">${s.endDate ? escapeHtml(s.endDate.slice(0, 10)) : ''}</div></td>
        <td class="num" data-sort="${s.people.length}">${s.people.length}</td>
        <td class="num" data-sort="${s.completedPoints}">${s.completedPoints}</td>
        <td class="num" data-sort="${s.pointsPerContributor ?? -1}">${fmt(s.pointsPerContributor)}</td>
        <td class="people good-note">${s.joined.map((p) => escapeHtml(p)).join(', ') || '<span class="muted">—</span>'}</td>
        <td class="people">${s.left.map((p) => escapeHtml(p)).join(', ') || '<span class="muted">—</span>'}</td>
      </tr>`,
        )
        .join('')}</tbody></table></div>`,
    )}
    <h3>Who has been on this team</h3>
    ${figures(
      c.people.length,
      `<div class="table-scroll"><table data-sortable>
      <thead><tr><th>Person</th><th class="num">Sprints delivered in</th><th>First seen</th><th>Last seen</th><th>In the latest sprint</th></tr></thead>
      <tbody>${c.people
        .map(
          (p) => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td class="num" data-sort="${p.sprints}">${p.sprints}</td>
        <td>${escapeHtml(p.firstSeen ?? '—')}</td>
        <td>${escapeHtml(p.lastSeen ?? '—')}</td>
        <td class="${p.current ? 'good' : 'muted'}">${p.current ? 'yes' : 'no'}</td>
      </tr>`,
        )
        .join('')}</tbody></table></div>`,
    )}
    <p class="footnote"><strong>WEAK, and it matters here.</strong> The assignee on an issue is the assignee <em>now</em>,
      not at the moment it was resolved, so work reassigned after the fact is attributed to whoever holds it today and work
      nobody ever assigned is invisible. It is reliable enough to answer “did this team change size between sprint 40 and
      sprint 55”, which is the question. It is not reliable enough to answer “what did this person do”, which is
      deliberately not asked anywhere in this report. A single sprint's absence is leave at least as often as it is a
      departure &mdash; “not seen this sprint” is a list to read, never an attrition figure.</p>
    ${explain(
      'How many people delivered something in each sprint, who they were, and when that changed.',
      'It is the most common way a delivery number gets misread by somebody senior. A team that went from eight people to five and from 40 points to 28 did not get worse — but a velocity chart on its own shows a decline, and a forecast calibrated across the change is not a forecast at all.',
      'Before quoting a velocity trend, check this chart for a headcount change underneath it. If the team changed size in the forecast window, say so when you quote the p50.',
    )}`;
}

// --- context (Confluence) --------------------------------------------------------------------

export function contextPanel(ctx: RenderContext, t: ReportTeamInput): string {
  const c = t.confluence;
  const prefixes = (t.prefixes ?? [{ key: t.prefix, count: 0 }]).slice(0, 3);
  const searchLinks = prefixes.map((p) => link(confluenceSearchUrl(ctx.site, p.key), `Confluence: “${p.key}”`, 'btn-link')).join(' ');

  if (!c || c.pages.length === 0) {
    return `${notYet(
      'No Confluence context collected for this team.',
      `Nothing here is broken &mdash; the sweep is opt-in. Run <code>discover-spaces --profile &lt;dir&gt;</code>: it scores every
       visible space by how often this board's project keys appear in it and prints the evidence, the same way the GitLab
       groups were derived. Add the winner to <code>confluenceSpaces</code> in the profile and the next collection fills
       this in.`,
    )}
    <p class="lede">In the meantime, these searches go straight to the live wiki: ${searchLinks}</p>
    ${c && c.errors.length > 0 ? `<ul class="caveats">${c.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}`;
  }

  const byReason = (reason: string) => c.pages.filter((p) => p.reason === reason);
  const group = (title: string, note: string, pages: typeof c.pages): string =>
    pages.length === 0
      ? ''
      : `<h3>${escapeHtml(title)}</h3><p class="lede">${escapeHtml(note)}</p>
         <ul class="pages">${pages
           .map(
             (p) => `<li>
             ${link(p.url, p.title)}
             <div class="muted">${escapeHtml(p.spaceName ?? p.spaceKey)}${p.lastUpdated ? ` · updated ${escapeHtml(p.lastUpdated.slice(0, 10))}` : ''}${
               p.lastUpdatedBy ? ` by ${escapeHtml(p.lastUpdatedBy)}` : ''
             }${p.matched ? ` · mentions ${escapeHtml(p.matched)}` : ''}</div>
             ${p.excerpt ? `<div class="excerpt">${escapeHtml(p.excerpt)}</div>` : ''}
           </li>`,
           )
           .join('')}</ul>`;

  return `
    <div class="kpis">
      ${kpi('Spaces', String(c.spaces.length), c.spaces.map((s) => escapeHtml(s.key)).join(', ') || '—')}
      ${kpi('Pages linked', String(c.pages.length), 'titles and links only, never content')}
      ${kpi('Most recent update', c.pages[0]?.lastUpdated ? escapeHtml(c.pages[0].lastUpdated.slice(0, 10)) : '—', 'across the linked pages')}
    </div>
    ${group('Start here', 'The space home pages — where a newcomer to this team should begin.', byReason('space-home'))}
    ${group('Recently updated', 'What this team has been writing down lately. Recency is the cheapest available proxy for “what is live right now”.', byReason('recent'))}
    ${group('Mentions this team’s work', 'Pages that name this board’s ticket prefixes — usually the specs, decisions and runbooks behind the tickets on this page.', byReason('mentions-project'))}
    <p class="footnote">${searchLinks}</p>
    ${c.errors.length > 0 ? `<ul class="caveats">${c.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
    ${explain(
      'Links into Confluence for this team: the space home, what has been written recently, and pages that mention this board’s ticket prefixes.',
      'Every other panel here assumes you know what the team does. This one is the answer to “I have never seen this board before” — and it is the difference between a report a newcomer can act on and one only its author can read.',
      'Read the space home first if the team is unfamiliar. Nothing here is a copy: every link opens the live page, so what you read is current even when the report is a week old.',
    )}`;
}
