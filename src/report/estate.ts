import type { PeopleEstate } from '../people.js';
import { confluenceSpaceUrl, gitlabGroupUrl, issueUrl } from '../links.js';
import {
  escapeAttr,
  escapeHtml,
  expander,
  explain,
  figures,
  kpi,
  link,
  notYet,
  pct,
  rate,
  term,
  tip,
} from './format.js';
import type { ReportInput, ReportTeamInput } from './model.js';
import { openAllLink, type RenderContext } from './panels.js';

// ---------------------------------------------------------------------------
// The estate-wide views: PEOPLE, EPICS, DATA and the MAPPING diagram.
//
// Everything else on this page is scoped to one board, and each of these three
// panels exists because a per-board panel structurally cannot answer its
// question:
//
//   PEOPLE  - `roster()` runs once per board, so somebody working across two
//             appears as two rows that are never added together. "Who is
//             stretched across three teams" is therefore unanswerable from the
//             team tabs no matter how carefully they are read.
//   EPICS   - an epic rollup counts the issues VISIBLE ON ONE BOARD, so an epic
//             split across two reads 100% done on one of them. The per-board
//             GOTCHA names this and cannot fix it from inside one board.
//   DATA    - the schema assessment, the collection errors and the quality
//             findings were scattered: a banner at the top, a section inside
//             every team tab, and a paragraph in the legend. "Can I trust this
//             file" is one question and deserves one place to ask it.
//
// The MAPPING diagram is different in kind. It is not a metric at all - it is
// the tool's most distinctive claim, that the Jira/GitLab/Confluence mapping was
// DERIVED FROM EVIDENCE rather than guessed, and until now that claim lived
// only in `description` strings inside a config file nobody opens. A reader who
// cannot see how a board was joined to a GitLab group has no reason to believe
// any code-review figure on the page.
//
// The per-person rules do not relax here. See the header of src/people.ts: no
// points summed across boards, no rate per person, give-and-receive always
// together, counts of work HELD rather than work done.
// ---------------------------------------------------------------------------

// --- people -------------------------------------------------------------------

export function peoplePanel(ctx: RenderContext, input: ReportInput): string {
  const p = input.people;
  if (!p) {
    return notYet(
      'Not computed for this report.',
      'The estate-wide people rollup needs per-board rosters, which this report was generated without.',
    );
  }
  if (p.people.length === 0) {
    return `<p class="lede">No named people were found on any collected board.</p>`;
  }

  const spread = p.people.filter((x) => x.activeBoardCount > 1);
  const jiraOnly = p.people.filter((x) => x.jiraOnly).length;
  const gitlabOnly = p.people.filter((x) => x.gitlabOnly).length;

  const boardChips = (x: PeopleEstate['people'][number]): string =>
    x.boards
      .filter((b) => b.openAssigned > 0 || b.openInActiveSprint > 0)
      .map(
        (b) =>
          `<a class="chip team-chip" href="#view=teams&team=${escapeAttr(b.team)}"
             data-tip="${escapeAttr(
               `${b.team}: ${b.openInActiveSprint} open in an active sprint, ${b.openAssigned} open in total, ${b.openPoints} points on that board's own scale.`,
             )}" title="${escapeAttr(`${b.team}: ${b.openInActiveSprint} in sprint, ${b.openAssigned} open`)}"
             >${escapeHtml(b.team)} <strong>${b.openInActiveSprint}</strong></a>`,
      )
      .join('') || '<span class="muted">no open work</span>';

  const rows = p.people
    .map((x) => {
      const badges = [
        x.activeBoardCount > 1
          ? tip(
              `<span class="tag caveat">${x.activeBoardCount} boards</span>`,
              'Holds open work in an active sprint on more than one board — so they are in more than one standup, against more than one set of priorities. This is a load fact, not a judgement.',
            )
          : '',
        x.jiraOnly
          ? tip(
              '<span class="tag caveat">Jira only</span>',
              'Appears in Jira on some board and never in GitLab in this window. Usually product, QA, support or management rather than absence — but it can also mean their two accounts are spelled differently, in which case they are two rows here.',
            )
          : '',
        x.gitlabOnly
          ? tip(
              '<span class="tag caveat">GitLab only</span>',
              'Writes code against a mapped group but holds no Jira issue on any collected board. Often somebody from an uncollected team, or a second account spelling.',
            )
          : '',
      ].join('');

      return `<tr>
        <td>${escapeHtml(x.name)} ${badges}</td>
        <td class="num" data-sort="${x.activeBoardCount}">${x.activeBoardCount || '—'}</td>
        <td class="chips-cell" data-sort="${x.openInActiveSprint}">${boardChips(x)}</td>
        <td class="num" data-sort="${x.openAssigned}">${x.openAssigned}</td>
        <td class="num ${x.flaggedAssigned > 0 ? 'poor' : ''}" data-sort="${x.flaggedAssigned}">${x.flaggedAssigned || '—'}</td>
        <td class="num" data-sort="${x.mergeRequestsAuthored}">${x.mergeRequestsAuthored || '—'}</td>
        <td class="num" data-sort="${x.mergedUnreviewed}">${
          x.mergedKnown === 0 ? '—' : `${x.mergedUnreviewed} of ${x.mergedKnown}`
        }</td>
        <td class="num ${p.reviewerIdentitiesUnknown ? 'unknown' : x.reviewsGiven === 0 && x.mergeRequestsAuthored > 0 ? 'watch' : ''}"
            data-sort="${x.reviewsGiven}">${p.reviewerIdentitiesUnknown ? '?' : x.reviewsGiven || '—'}</td>
        <td>${
          x.projects.length === 0
            ? '<span class="muted">—</span>'
            : x.projects
                .slice(0, 3)
                .map((pr) => `<span class="chip">${escapeHtml(pr)}</span>`)
                .join('') + (x.projects.length > 3 ? `<span class="muted"> +${x.projects.length - 3}</span>` : '')
        }</td>
      </tr>`;
    })
    .join('');

  return `
    <div class="kpis">
      ${kpi(
        'People across the estate',
        String(p.people.length),
        `on ${p.boardsCovered} collected board${p.boardsCovered === 1 ? '' : 's'}`,
        '',
        'Distinct names, matched between Jira and GitLab by display name because the two systems share no id on this instance. Somebody who spells their name differently in the two appears twice.',
      )}
      ${kpi(
        'On more than one board',
        String(p.crossTeamActiveCount),
        'holding open work in two or more active sprints',
        p.crossTeamActiveCount > 0 ? 'watch' : 'good',
        'The signal no team tab can show. Three boards means three standups and three sets of priorities competing for the same person, which is the ordinary way something quietly gets dropped.',
      )}
      ${kpi(
        'Unassigned in a sprint',
        String(p.unassignedOpenInActiveSprint),
        'open, in an active sprint, nobody’s name on it',
        p.unassignedOpenInActiveSprint > 0 ? 'watch' : 'good',
        'These items are on nobody’s row in the table below, which is exactly why the count is stated here. Work with no owner is work with nobody to ask about it.',
      )}
      ${kpi(
        'In Jira, never in GitLab',
        String(jiraOnly),
        `${gitlabOnly} the other way round`,
        '',
        'Not absence. It is almost always product, QA, support or management — people whose contribution this tool cannot see, and whose omission from a “team” would describe the wrong team.',
      )}
    </div>

    ${
      spread.length > 0
        ? `<h3>Who is spread across boards</h3>
           <p class="chart-note">One bar per person, one segment per board, counting <strong>open items held in an
             active sprint</strong>. Read the number of SEGMENTS, not the length: this is a picture of how many
             places somebody is expected to be, not of how much they do.</p>
           <div class="chart-box" style="height:${Math.max(180, Math.min(14, spread.length) * 26 + 90)}px">
             <canvas id="chart-crossteam"></canvas></div>
           <p class="footnote">${spread
             .slice(0, 14)
             .map(
               (x) =>
                 `${escapeHtml(x.name)} <strong>${x.boards
                   .filter((b) => b.openInActiveSprint > 0)
                   .map((b) => `${escapeHtml(b.team)} ${b.openInActiveSprint}`)
                   .join(' + ')}</strong>`,
             )
             .join(' &middot; ')}</p>`
        : `<p class="lede good-note">Nobody is holding open sprint work on more than one board. Whatever else is
             true, no individual is being asked to be in two places at once.</p>`
    }

    ${figures(
      p.people.length,
      `<div class="table-scroll"><table data-sortable id="people-table">
      <thead><tr>
        <th>Person</th>
        <th class="num">${term('Boards', 'How many boards’ active sprints they hold open work on. The cross-team load signal.')}</th>
        <th>${term('Where, and how much', 'Open items in an active sprint, per board. Click a chip to open that board’s tab.')}</th>
        <th class="num">${term('Open in total', 'Every open issue assigned to them right now, across boards, in any scope. Assignment as it stands today — not an attribution of past work.')}</th>
        <th class="num">${term('Flagged', 'Open issues assigned to them that somebody has marked as blocked. A flag is a person saying in writing that they are stopped.')}</th>
        <th class="num">${term('MRs opened', 'Merge requests they authored in the GitLab window, across every mapped group, deduped by merge request.')}</th>
        <th class="num">${term('Merged unreviewed', 'Of the merge requests they opened that merged and whose review detail was read, how many went in with no comment and no approval from anybody but themselves.')}</th>
        <th class="num">${term('Reviews given', 'Distinct merge requests by OTHER people they commented on or approved. Shown beside “merged unreviewed” always, never on its own — the pair is a picture of who has the review habit, either half alone is a list of offenders.')}</th>
        <th>Repositories</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`,
    )}

    ${
      p.reviewerIdentitiesUnknown
        ? `<p class="footnote"><strong>“Reviews given” is unknown in this snapshot, not zero.</strong> It needs
             commenter identities, added in schema 3. Unknown shows as <code>?</code>.</p>`
        : ''
    }

    <p class="footnote">
      <strong>Story points are deliberately absent from every total on this page.</strong> A point on one board is
      not a point on another — estimation culture differs wildly here, one board leaves 97% of its active sprint
      unestimated — so adding somebody's points across boards would produce a figure that looks like load and is
      not. Points appear only inside a board's own chip, on that board's own scale.
      There is no per-person productivity figure anywhere in this report and this table does not introduce one:
      every Jira number here is work <em>held right now</em>, which is a fact about assignment, not about output.
    </p>

    ${explain(
      `Every named person across all ${p.boardsCovered} collected boards, with which boards they hold work on, what they hold, and both sides of their code-review habit. Matched between Jira and GitLab by display name; recent windows are ${p.recentDays} days for Jira${p.gitlabWindowDays ? ` and ${p.gitlabWindowDays} for GitLab` : ''}.`,
      'Because the per-team roster panels cannot see across boards, and the cross-board picture is where the real load problem lives. A person holding six items on one board is a normal sprint; the same person holding three items on each of three boards is in three standups, against three sets of priorities, and is the ordinary way something gets quietly dropped. That is a fact about how the work is arranged, and arranging work is the one thing a manager can actually change.',
      'Start with the “boards” column sorted descending — the top rows are the people whose week is being competed over, and the fix is usually a conversation with the other board rather than with them. Read “merged unreviewed” and “reviews given” together and only together: a person with a high left column and a zero right column has not been shown the habit, which is a pairing, not a performance conversation. Treat “Jira only” as information about what somebody does, never as a gap.',
    )}`;
}

// --- epics across the estate ---------------------------------------------------

export function estateEpicsPanel(ctx: RenderContext, input: ReportInput): string {
  const e = input.estateEpics;
  if (!e) {
    return notYet('Not computed for this report.', 'The cross-board epic rollup needs per-board epic rollups.');
  }
  if (e.epics.length === 0) {
    return `<p class="lede">No epics were found on any collected board. Work with no epic is reported inside each
      team's own epics panel, where it is often the largest bucket.</p>`;
  }

  const rows = e.epics
    .slice(0, 40)
    .map((r) => {
      const remaining = r.issues - r.doneIssues;
      return `<tr class="${r.crossTeam ? 'row-alert' : ''}">
        <td class="key-cell">${link(issueUrl(ctx.site, r.key), r.key, 'key')}
          <div class="muted">${
            r.nameKnown ? escapeHtml(r.name) : '<em>name not collected — this is the key</em>'
          }</div></td>
        <td>${r.teams
          .map(
            (t) =>
              `<a class="chip team-chip" href="#view=teams&team=${escapeAttr(t.team)}"
                 data-tip="${escapeAttr(
                   `${t.team}: ${t.issues} issue(s) under this epic on that board, ${t.doneIssues} done, ${t.activeIssues} in an active sprint, ${t.backlogIssues} on the backlog.`,
                 )}"
                 title="${escapeAttr(`${t.team}: ${t.issues} issues, ${t.doneIssues} done`)}">${escapeHtml(t.team)}</a>`,
          )
          .join('')}</td>
        <td class="num" data-sort="${r.issues}">${r.issues}</td>
        <td class="num" data-sort="${r.progress ?? -1}">${rate(r.progress)}</td>
        <td class="num" data-sort="${remaining}"><strong>${remaining}</strong></td>
        <td class="num" data-sort="${r.activeOpenIssues}">${r.activeOpenIssues || '—'}</td>
        <td class="num" data-sort="${r.backlogOpenIssues}">${r.backlogOpenIssues || '—'}</td>
        <td class="num ${r.blocked > 0 ? 'poor' : ''}" data-sort="${r.blocked}">${r.blocked || '—'}</td>
        <td class="num ${r.carried > 0 ? 'watch' : ''}" data-sort="${r.carried}">${r.carried || '—'}</td>
        <td class="num" data-sort="${r.oldestOpenDays ?? -1}">${
          r.oldestOpenDays === null ? '—' : Math.round(r.oldestOpenDays)
        }</td>
        <td class="num" data-sort="${r.people.length}">${r.people.length || '—'}</td>
      </tr>`;
    })
    .join('');

  const crossKeys = e.epics.filter((r) => r.crossTeam).map((r) => r.key);

  return `
    <div class="kpis">
      ${kpi('Epics on collected boards', String(e.epics.length), `across ${e.boardsCovered} board${e.boardsCovered === 1 ? '' : 's'}`)}
      ${kpi(
        'Spanning more than one board',
        String(e.crossTeamCount),
        'no single board view shows these whole',
        e.crossTeamCount > 0 ? 'watch' : 'good',
        'An epic split across two boards gets two rollups, each counting only its own board’s issues — so one of them can read 100% done while the epic is half finished. These are the rows where a per-team epic panel is actively misleading, and they are highlighted in the table.',
      )}
      ${kpi(
        'Names collected',
        e.namesCollected ? 'yes' : 'partly',
        e.namesCollected ? 'every epic has its real name' : 'some names fall back to the key',
        e.namesCollected ? 'good' : 'watch',
        'Epic names arrived in schema 4. On an older snapshot the “name” is the key, and the panel says so rather than implying the epic is called WEB-42.',
      )}
    </div>

    <p class="chart-note">Progress across every collected board, sorted by what is <strong>left</strong> rather than
      by how far along it is &mdash; the epic with the most remaining issues is the one still here next quarter,
      and sorting by percentage puts a two-issue epic above a two-hundred-issue one. The four segments are a
      partition, so the bar's length is the epic's issue count.</p>
    <div class="chart-box" style="height:${Math.max(200, Math.min(12, e.epics.length) * 26 + 90)}px">
      <canvas id="chart-estate-epics"></canvas></div>

    ${figures(
      Math.min(e.epics.length, 40),
      `<div class="table-scroll"><table data-sortable id="estate-epics-table">
      <thead><tr>
        <th>Epic</th><th>Boards</th>
        <th class="num">Issues</th>
        <th class="num">${term('Done', 'Done issues over total issues, on COLLECTED boards only. A progress hint, never a completion claim — work under this epic on a board this profile does not collect is invisible here.')}</th>
        <th class="num">Left</th>
        <th class="num">${term('In a sprint', 'Open and in an active sprint somewhere. Work actually moving.')}</th>
        <th class="num">${term('Queued', 'Open and on a backlog. Work not started.')}</th>
        <th class="num">Blocked</th>
        <th class="num">${term('Carried 3+', 'Open items under this epic that have been in three or more sprints. Almost always means the item is too big or too vague.')}</th>
        <th class="num">${term('Oldest open', 'Age in days of the oldest open item under this epic. An epic whose oldest open item is two years old is not in progress; it is a label on a pile.')}</th>
        <th class="num">People</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`,
    )}
    ${e.epics.length > 40 ? `<p class="footnote muted">${e.epics.length - 40} more not shown; the counts above are over all of them.</p>` : ''}
    ${
      crossKeys.length > 0
        ? `<p class="footnote">Epics spanning boards: ${crossKeys
            .slice(0, 12)
            .map((k) => link(issueUrl(ctx.site, k), k, 'key'))
            .join(' ')} ${openAllLink(ctx, crossKeys, 'open all of them in Jira')}</p>`
        : ''
    }

    ${explain(
      'Every epic on every collected board, rolled up by epic key so an epic split across two boards is one row with its real spread.',
      'Because the per-team epic panel is honest about a limitation it cannot fix from inside one board: it counts the issues visible on THAT board, so an epic half-delivered on one board and half-queued on another reads as finished on the first. That is the single most quotable wrong number this tool can produce, and this is where it gets corrected. Percentages here are still over collected boards only — an epic with work on a board this profile does not collect is still incomplete, and no arithmetic anywhere can tell you that.',
      'Look at the highlighted rows first: those are the epics where somebody has probably already told you a number from one board’s tab. Then work down the “left” column, not the percentage. Anything with a large “queued” and a small “in a sprint” is not in progress whatever its status says.',
    )}`;
}

// --- the mapping diagram -------------------------------------------------------

/** Board to GitLab group to Confluence space, with the evidence.
 *
 *  This is the panel that makes the tool's most distinctive claim visible. The
 *  mapping between a Jira board, a GitLab group and a Confluence space is the
 *  thing every code-review and documentation figure on the page rests on, it
 *  was DERIVED - by counting Jira keys in merge-request titles and branch
 *  names, and issue-key mentions in wiki pages - and until now the derivation
 *  lived only in `description` strings inside a config file. A reader who cannot
 *  see why board 702 was joined to `logistics-hub` has no reason to believe the
 *  unreviewed rate underneath it, and "trust me, it was evidence-based" is not
 *  something a report gets to say about itself.
 *
 *  Drawn as three columns of nodes with the join written between them, rather
 *  than as a chart: this is a structure, not a quantity. */
export function mappingPanel(ctx: RenderContext, teams: ReportTeamInput[]): string {
  const rows = teams
    .map((t) => {
      const board = t.boardId ?? t.trends.boardId;
      const groups = t.gitlabGroups ?? [];
      const spaces = t.confluence?.spaces ?? [];
      const pages = t.confluence?.pages.length ?? 0;

      return `<div class="map-row">
        <div class="map-node jira">
          <div class="map-kind">Jira board</div>
          <a href="#view=teams&team=${escapeAttr(t.key)}"><strong>${escapeHtml(t.key)}</strong></a>
          <div class="muted">${escapeHtml(t.boardName ?? '')} &middot; #${board}</div>
          <div class="map-meta">${(t.prefixes ?? [{ key: t.prefix, count: 0 }])
            .slice(0, 3)
            .map((p) => `<span class="prefix">${escapeHtml(p.key)}</span>`)
            .join(' ')}</div>
        </div>
        <div class="map-join" aria-hidden="true"><span class="map-wire"></span></div>
        <div class="map-node gitlab ${groups.length === 0 ? 'absent' : ''}">
          <div class="map-kind">GitLab group</div>
          ${
            groups.length > 0
              ? groups.map((g) => `<div><strong>${link(gitlabGroupUrl(ctx.gitlabOrigin, g), g)}</strong></div>`).join('')
              : `<div class="muted">none mapped</div>`
          }
          <div class="map-meta">${
            t.review
              ? `${t.review.totalMergeRequests} MRs in the window &middot; ${t.review.automationAuthored} by automation`
              : 'nothing on this page measures this team’s code review'
          }</div>
        </div>
        <div class="map-join" aria-hidden="true"><span class="map-wire"></span></div>
        <div class="map-node confluence ${spaces.length === 0 ? 'absent' : ''}">
          <div class="map-kind">Confluence space</div>
          ${
            spaces.length > 0
              ? spaces
                  .map(
                    (s) =>
                      `<div><strong>${link(confluenceSpaceUrl(ctx.site, s.key), s.key)}</strong>
                       <span class="muted">${escapeHtml(s.name ?? '')}</span></div>`,
                  )
                  .join('')
              : `<div class="muted">none mapped</div>`
          }
          <div class="map-meta">${pages} page${pages === 1 ? '' : 's'} linked</div>
        </div>
      </div>
      ${
        t.description
          ? `<div class="map-why">${expander(
              `Why ${escapeHtml(t.key)} is mapped this way`,
              `<p class="prov">${escapeHtml(t.description)}</p>`,
              { open: false },
            )}</div>`
          : `<div class="map-why"><p class="footnote muted">No mapping note recorded for ${escapeHtml(
              t.key,
            )}. A mapping with no written evidence is a guess until somebody writes down why.</p></div>`
      }`;
    })
    .join('');

  const unmapped = teams.filter((t) => (t.gitlabGroups ?? []).length === 0);

  return `
    <p class="lede">Every code-review figure on this page is counted from the GitLab group in the middle column, and
      every documentation link from the Confluence space in the right one. Both joins were <strong>derived from
      evidence</strong> &mdash; Jira keys found in merge-request titles and branch names, issue-key mentions counted
      per wiki space &mdash; not configured by guess. The reasoning is under each row.</p>
    <div class="mapgraph">${rows}</div>
    ${
      unmapped.length > 0
        ? `<div class="callout neutral"><div class="big">${unmapped.length} of ${teams.length}</div>
             <div class="body">team${unmapped.length === 1 ? ' has' : 's have'} no GitLab group mapped
             (${unmapped.map((t) => escapeHtml(t.key)).join(', ')}), so nothing on this page measures
             ${unmapped.length === 1 ? 'its' : 'their'} code review. That is a gap in the mapping, not a finding
             about the team &mdash; run <code>discover-groups</code>.</div></div>`
        : ''
    }
    ${explain(
      'How each Jira board was joined to a GitLab group and a Confluence space, and the evidence each join rests on.',
      'Because scope is the difference between a reassuring number and a real one. Every review figure in this report is scoped to these groups and to nothing else, so a reader who cannot see the join has no basis for believing the figure — and a mapping that was actually derived from counted evidence deserves to be shown rather than asserted. Two shared spaces that scored highest were deliberately excluded for scoring against several boards at once, which is the signature of a programme space rather than a team’s home; that decision is in the notes.',
      'If a figure on a team tab looks wrong, check its row here first — the usual cause is a group that carries more or less than you assumed, not a bad measurement. A row with “none mapped” is a collection gap to close, not a team with no code.',
    )}`;
}

// --- the data view -------------------------------------------------------------

/** Everything about whether this file can be trusted, in one place.
 *
 *  Assembled rather than newly computed: the schema assessment, the per-board
 *  quality findings and the collection errors all already exist and were all
 *  already rendered - as a banner at the top of the page, as a section buried
 *  twenty panels deep inside each team tab, and as a paragraph in the legend.
 *  "Can I trust this?" is one question and a reader should not have to visit
 *  three places to ask it. The per-team section stays where it is: somebody
 *  reading one board's tab needs its caveats there, not in another view. */
export function dataPanel(ctx: RenderContext, input: ReportInput): string {
  const schema = input.schema;
  const totalErrors = input.teams.reduce((a, t) => a + t.quality.collectionErrors.length, 0);
  const highFindings = input.teams.flatMap((t) =>
    t.quality.findings.filter((f) => f.severity === 'high').map((f) => ({ team: t.key, f })),
  );

  const findingRows = highFindings
    .map(
      ({ team, f }) => `<tr>
      <td><a href="#view=teams&team=${escapeAttr(team)}">${escapeHtml(team)}</a></td>
      <td><code>${escapeHtml(f.code)}</code></td>
      <td class="num" data-sort="${f.count}">${f.count}${f.outOf ? ` <span class="muted">of ${f.outOf}</span>` : ''}</td>
      <td class="num" data-sort="${f.outOf ? f.count / f.outOf : -1}">${f.outOf ? pct(f.count, f.outOf) : '—'}</td>
      <td>${escapeHtml(f.detail)}</td>
    </tr>`,
    )
    .join('');

  const errorRows = input.teams
    .flatMap((t) => t.quality.collectionErrors.map((e) => ({ team: t.key, e })))
    .map(
      ({ team, e }) =>
        `<li><a href="#view=teams&team=${escapeAttr(team)}"><strong>${escapeHtml(team)}</strong></a> &mdash; ${escapeHtml(e)}</li>`,
    )
    .join('');

  const historyDays = input.teams.map((t) => t.history?.days ?? 0);
  const minDays = historyDays.length > 0 ? Math.min(...historyDays) : 0;

  return `
    <div class="kpis">
      ${kpi(
        'Snapshot',
        escapeHtml(input.jiraDate),
        `captured ${escapeHtml(input.jiraCapturedAt.slice(0, 16).replace('T', ' '))}`,
        schema?.stale ? 'poor' : 'good',
        'The dated folder every figure on this page was read from. Snapshots are immutable by design — a day cannot be backfilled, only replaced.',
      )}
      ${kpi(
        'Schema',
        schema ? (schema.stale ? 'behind the code' : `current (${schema.expected})`) : 'not assessed',
        schema?.headline ? escapeHtml(schema.headline) : 'the snapshot can answer everything the tool asks',
        schema ? (schema.stale ? 'poor' : 'good') : 'unknown',
        'A snapshot stamped at the current version is NOT proof its content is there — collecting with --no-issue-detail writes a current-version file carrying none of that version’s fields. So both the stamp and the field coverage are checked.',
      )}
      ${kpi(
        'Observed days',
        minDays === 0 ? 'one' : String(minDays),
        'the fewest any team has',
        minDays >= 2 ? 'good' : 'watch',
        'Churn, burndown, cycle time, column ageing and the flow diagram are all DIFFERENCES between two collected days. With one day they report “not yet”, never zero.',
      )}
      ${kpi(
        'Collection errors',
        String(totalErrors),
        totalErrors === 0 ? 'every board collected cleanly' : 'partial boards were kept, with their errors',
        totalErrors === 0 ? 'good' : 'watch',
        'A board that hit a non-fatal problem is recorded WITH its error rather than aborting the whole run, so a partial day is still a day — as long as somebody knows which part.',
      )}
    </div>

    ${
      schema && schema.stale
        ? `<div class="callout warn"><div class="big">stale</div><div class="body">The banner at the very top of this
             page has the detail and the command that fixes it. Nothing below is wrong, but panels built on the
             missing fields say “not collected”, and an un-collected panel looks exactly like an empty one.</div></div>`
        : `<p class="lede good-note">The snapshot this was rendered from can answer everything the current code asks
             of it. Where a panel says “not collected”, that is a collection flag, not stale code.</p>`
    }

    ${
      schema && schema.gaps.length > 0
        ? `<h3>Field coverage</h3>
           <div class="table-scroll"><table data-sortable>
             <thead><tr><th>Content</th><th class="num">Present</th><th class="num">Of</th><th class="num">Share</th><th>Why</th></tr></thead>
             <tbody>${schema.gaps
               .map(
                 (g) => `<tr><td>${escapeHtml(g.what)}</td>
                   <td class="num" data-sort="${g.present}">${g.present.toLocaleString('en-GB')}</td>
                   <td class="num" data-sort="${g.total}">${g.total.toLocaleString('en-GB')}</td>
                   <td class="num" data-sort="${g.total ? g.present / g.total : -1}">${pct(g.present, g.total)}
                     <span class="muted">${escapeHtml(g.scope)}</span></td>
                   <td>${escapeHtml(g.cause)}</td></tr>`,
               )
               .join('')}</tbody></table></div>`
        : ''
    }

    <h3>High-severity data-quality findings, every board</h3>
    ${
      highFindings.length > 0
        ? `<div class="table-scroll"><table data-sortable id="quality-table">
             <thead><tr><th>Team</th><th>Finding</th><th class="num">Count</th><th class="num">Share</th><th>What it means</th></tr></thead>
             <tbody>${findingRows}</tbody></table></div>
           <p class="footnote">Each team's own tab carries its findings in context, including the medium and low
             severities. This is the estate-wide roll-up so a pattern across boards &mdash; the same finding on all
             four is a site configuration problem, not a team problem &mdash; is visible at all.</p>`
        : `<p class="lede good-note">No high-severity data-quality findings on any collected board.</p>`
    }

    ${
      errorRows
        ? `<h3>Collection errors</h3><ul class="caveats">${errorRows}</ul>`
        : ''
    }

    <h3>What is embedded in this file</h3>
    ${
      input.embedData === false
        ? `<p class="lede">This report was generated with <code>--no-embed-data</code>, so <strong>nothing</strong>
             is embedded: no derived model and no briefing digest. What is rendered above is all there is, and
             every list on the page is bounded. A question that needs the detail behind a truncated list needs
             the report regenerating without that flag.</p>`
        : expander(
      'The complete derived model travels inside this HTML',
      `<p>The whole derived model is embedded as JSON in a script block with the id <code>to-data</code>, and a
         much smaller digest sits under <code>to-brief</code>. Neither is rendered; both are there so the file
         can be handed to somebody &mdash; or to a model &mdash; and answer questions the page necessarily
         truncated. <code>--no-embed-data</code> leaves both out for a smaller file.</p>
       <p><strong>Why it is worth the file size.</strong> Every rendered list on this page is bounded: the top 30
         attention items, the 12 deepest blockers, the 40 largest epics. On a <code>file://</code> page there is
         nowhere else to fetch the rest from, so the alternative to embedding is that the rest does not exist.
         The digest exists so a question that does not need per-ticket detail costs a few hundred tokens instead
         of megabytes.</p>
       <p>The payload carries its own README naming which of its fields are SOUND, WEAK and UNUSABLE, and what
         must not be computed from it &mdash; no cross-board point arithmetic, no per-person productivity, no
         quoting the fields it marks as provably wrong. Those rules are in the data because a payload read without
         the page around it has no other way to carry them.</p>`,
      { open: false },
    )}
    ${expander(
      'What no part of this report will tell you',
      `<dl class="explain">
        <dt>Anything before the first collected day</dt>
        <dd>Cycle time, column ageing and the flow diagram are walked from what was actually recorded. Work already
          in progress on day one has no observed start, so its figure is a lower bound — those observations are
          counted separately as censored and kept out of every percentile rather than flattering it.</dd>
        <dt>Committed and carried figures for closed sprints</dt>
        <dd>Reconstructed from one snapshot they are provably wrong: an item that passed through sixteen sprints
          counts as committed in all sixteen. They are in the payload for completeness, marked UNUSABLE, and
          charted nowhere. The scope-churn panel is the sound replacement and it needs consecutive days.</dd>
        <dt>Any comparison of story points between boards</dt>
        <dd>Estimation culture differs wildly per board here. No total on this page adds points across teams and
          no table ranks teams by them.</dd>
        <dt>What any individual produced</dt>
        <dd>There is no points-per-person figure and the estate-wide People view does not introduce one. Every
          per-person number is work HELD right now or a review habit, both of which are facts a conversation can
          act on, neither of which ranks anybody.</dd>
        <dt>Anything from a board this profile does not collect</dt>
        <dd>Most visible in the epic rollups, where an epic can read as finished because the rest of it lives
          somewhere nobody looked.</dd>
      </dl>`,
      { open: false },
    )}
    ${explain(
      'Where this file came from, whether the snapshot behind it can answer what the code asks, and what is missing or contradictory in the underlying data.',
      'Because an empty panel and an un-collected panel look identical, and the difference between them is the difference between “this team has no blockers” and “we did not look”. This tool once shipped a whole layer of ticket context, rendered it against a snapshot written before that layer existed, and printed “not collected” 109 times in a report that read as complete.',
      'Read this before quoting anything to somebody who will act on it. If the schema line is red, re-collect before the meeting rather than after it. If a finding here appears on every board, raise it as a Jira configuration problem rather than with four separate teams.',
    )}`;
}
