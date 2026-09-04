import type { IssueSnapshot, JiraSnapshot, SprintSnapshot, TeamSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// The data-quality report. Entirely deterministic, no AI, no network - it reads
// one snapshot and reports what is missing or contradictory in it.
//
// This ships first on purpose. Velocity and burndown are meaningless until the
// underlying Jira hygiene is known, and on the sampled site it already is not
// clean (WEB-1387 had null in BOTH story-point fields), so "how trustworthy is
// this data" is the first honest thing this tool can tell a manager.
// ---------------------------------------------------------------------------

export interface TeamQuality {
  team: string;
  boardId: number;
  boardName?: string;
  boardType?: string;
  activeSprint?: { id: number; name: string; startDate?: string; endDate?: string; hasGoal: boolean };
  counts: {
    issues: number;
    inActiveSprint: number;
    inBacklog: number;
    everInASprint: number;
  };
  findings: QualityFinding[];
  collectionErrors: string[];
}

export interface QualityFinding {
  code: string;
  severity: 'high' | 'medium' | 'low';
  count: number;
  /** Denominator the count is measured against, when a rate is meaningful. */
  outOf?: number;
  detail: string;
  /** A bounded sample of offending issue keys, for someone to go and look. */
  examples: string[];
}

const MAX_EXAMPLES = 5;

function finding(
  code: string,
  severity: QualityFinding['severity'],
  issues: IssueSnapshot[],
  detail: string,
  outOf?: number,
): QualityFinding | null {
  if (issues.length === 0) return null;
  return {
    code,
    severity,
    count: issues.length,
    outOf,
    detail,
    examples: issues.slice(0, MAX_EXAMPLES).map((i) => i.key),
  };
}

export function activeSprintOf(team: TeamSnapshot): SprintSnapshot | undefined {
  const active = team.sprints.filter((s) => s.state === 'active');
  // More than one active sprint on a board is legal in Jira and usually means
  // two teams share the board - which breaks every per-team metric downstream.
  // The most recently started one is used, and the overlap is reported as a
  // finding rather than silently resolved.
  return active.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
}

/** Takes the narrowest shape it actually reads, so the history layer - which
 *  works on a PROJECTION of a snapshot rather than the whole thing, see
 *  historyProjection in history.ts - can use the identical done-ness test rather
 *  than a second copy of the rule that could drift from this one. TypeScript is
 *  structural, so every existing caller passing a full IssueSnapshot is
 *  unaffected. */
export function isDone(issue: { statusCategory: string }): boolean {
  // statusCategory, never the status NAME: this site has custom statuses like
  // "Product Owner Review" whose category is To Do, and a name-based test would
  // classify them by whatever the words happen to look like.
  return issue.statusCategory === 'Done';
}

export function daysBetween(fromIso: string | undefined, to: Date): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return (to.getTime() - t) / 86_400_000;
}

export interface QualityOptions {
  /** An issue sitting in an In Progress category this long without an update is
   *  reported as stale. 10 days is deliberately just past a two-week sprint's
   *  midpoint - the cadence observed on board 701. */
  staleDays: number;
  now: Date;
}

export function assessTeam(team: TeamSnapshot, opts: QualityOptions): TeamQuality {
  const sprint = activeSprintOf(team);
  const inSprint = sprint ? team.issues.filter((i) => i.sprintIds.includes(sprint.id)) : [];
  const openInSprint = inSprint.filter((i) => !isDone(i));
  const findings: (QualityFinding | null)[] = [];

  const activeSprints = team.sprints.filter((s) => s.state === 'active');
  if (activeSprints.length > 1) {
    findings.push({
      code: 'multiple-active-sprints',
      severity: 'high',
      count: activeSprints.length,
      detail:
        `Board has ${activeSprints.length} active sprints (${activeSprints.map((s) => s.name).join(', ')}). ` +
        `Per-team velocity and burndown will blend them - split the board or map each sprint to its own team.`,
      examples: [],
    });
  }

  if (sprint && !sprint.goal) {
    findings.push({
      code: 'sprint-goal-missing',
      severity: 'medium',
      count: 1,
      detail: `Active sprint "${sprint.name}" has no goal set, so there is nothing to measure delivery against.`,
      examples: [],
    });
  }

  // --- Estimation ---------------------------------------------------------
  findings.push(
    finding(
      'unestimated-in-sprint',
      'high',
      openInSprint.filter((i) => i.storyPoints === null),
      'Open issues in the active sprint with no story points in either point field. Velocity forecasting is ' +
        'unavailable for these, and a sprint that is mostly unestimated cannot be forecast at all.',
      openInSprint.length,
    ),
  );

  // Which of the two point fields is actually in use. A team split across both
  // is the specific failure mode that makes velocity look like it halved.
  const fieldsUsed = new Map<string, number>();
  for (const i of team.issues) {
    if (i.storyPointsField) fieldsUsed.set(i.storyPointsField, (fieldsUsed.get(i.storyPointsField) ?? 0) + 1);
  }
  if (fieldsUsed.size > 1) {
    findings.push({
      code: 'story-points-split-across-fields',
      severity: 'high',
      count: fieldsUsed.size,
      detail:
        `Story points are recorded in ${fieldsUsed.size} different fields on this board (` +
        [...fieldsUsed.entries()].map(([f, n]) => `${f}: ${n} issues`).join(', ') +
        `). Totals are only correct because both are read - but the split usually means two different ` +
        `issue-type schemes are in play on one board.`,
      examples: [],
    });
  }

  // --- Ownership and flow -------------------------------------------------
  findings.push(
    finding(
      'unassigned-in-sprint',
      'medium',
      openInSprint.filter((i) => !i.assignee),
      'Open issues in the active sprint with no assignee. Cannot be attributed to anyone, and typically ' +
        'means work that is committed but not actually started.',
      openInSprint.length,
    ),
  );

  const stale = openInSprint.filter((i) => {
    if (i.statusCategory !== 'In Progress') return false;
    const d = daysBetween(i.updated, opts.now);
    return d !== null && d >= opts.staleDays;
  });
  findings.push(
    finding(
      'stale-in-progress',
      'high',
      stale,
      `Issues in an In Progress status with no update for ${opts.staleDays}+ days. The most reliable early ` +
        `signal of silent blockage - the work is claimed but nothing is moving.`,
      openInSprint.length,
    ),
  );

  findings.push(
    finding(
      'flagged-blocked',
      'medium',
      openInSprint.filter((i) => i.flagged),
      'Issues explicitly flagged as blocked in the active sprint.',
      openInSprint.length,
    ),
  );

  // --- Carryover ----------------------------------------------------------
  findings.push(
    finding(
      'carried-three-plus-sprints',
      'high',
      openInSprint.filter((i) => i.sprintIds.length >= 3),
      'Open issues that have been in three or more sprints. Persistent carryover almost always means the ' +
        'item is badly defined or too large, not that it is being worked badly.',
      openInSprint.length,
    ),
  );

  // --- Scope ---------------------------------------------------------------
  // Single-snapshot approximation of scope churn: created after the sprint
  // started. It undercounts, because an OLD issue pulled in mid-sprint is
  // invisible here - that needs two snapshots, which is exactly what daily
  // collection accumulates. Flagged as approximate so it is never read as exact.
  if (sprint?.startDate) {
    // GOTCHA: compared as INSTANTS, never as strings. Jira returns issue
    // `created` with the site's local offset ("2026-08-18T11:35:49.740+0100")
    // and the Agile API returns sprint `startDate` as Zulu
    // ("2026-08-18T10:55:49.892Z"). A lexicographic compare of the two is wrong
    // whenever the date-and-time prefix is close, and it fails in the direction
    // that INVENTS churn: confirmed on the 2026-08-26 snapshot, team `tran`
    // reported 11 issues created after its sprint opened when only 9 were -
    // LOG-7504 and LOG-7505 were both created before it. Same rule as
    // completedInSprint in derive.ts.
    const sprintStart = Date.parse(sprint.startDate);
    const addedAfterStart = inSprint.filter((i) => {
      const created = Date.parse(i.created);
      return Number.isFinite(created) && Number.isFinite(sprintStart) && created > sprintStart;
    });
    findings.push(
      finding(
        'created-after-sprint-start',
        'medium',
        addedAfterStart,
        'Issues created after the active sprint started - an approximate lower bound on scope churn. ' +
          'Exact churn needs two snapshots and becomes available once collection has run on consecutive days.',
        inSprint.length,
      ),
    );
  }

  // --- Resolution bookkeeping ----------------------------------------------
  // Scoped to the WHOLE board, not just the active sprint: completedInSprint
  // (derive.ts) and compositionBySprint (flow.ts) both key on resolutionDate to
  // decide which sprint an issue's completion belongs to, so a Done issue with
  // none is invisible to every completed-count and velocity figure this tool
  // produces - not wrong, silently absent, which is worse.
  findings.push(
    finding(
      'done-without-resolution-date',
      'medium',
      team.issues.filter((i) => isDone(i) && !i.resolutionDate),
      'Issues in a Done status category with no resolution date recorded. Every completed-issue and ' +
        'completed-points figure in "trends" is anchored to resolutionDate falling inside a sprint window, so ' +
        'these are counted as done nowhere - not in the sprint they actually finished in, not in the forecast.',
      team.issues.length,
    ),
  );

  // --- Due dates already broken at planning time ----------------------------
  // Distinct from the day-by-day "overdue" intervention, which is computed
  // against `now` and therefore changes every time the report runs. This is
  // computed against the SPRINT'S OWN start date, so it is a fact about the
  // plan itself: a due date earlier than the sprint even began was already
  // broken before anyone committed to it, and that is visible at planning -
  // nobody has to wait for the date to pass a second time to see it.
  if (sprint?.startDate) {
    const sprintStart = Date.parse(sprint.startDate);
    const alreadyBroken = openInSprint.filter((i) => {
      if (!i.dueDate) return false;
      const due = Date.parse(i.dueDate);
      return Number.isFinite(due) && Number.isFinite(sprintStart) && due < sprintStart;
    });
    findings.push(
      finding(
        'due-before-sprint-start',
        'medium',
        alreadyBroken,
        'Open issues in the active sprint whose due date was already in the past when the sprint started. ' +
          'Committing these without resetting the date carries a broken promise into the plan rather than raising it.',
        openInSprint.length,
      ),
    );
  }

  // --- Board configuration ------------------------------------------------
  if (team.columns.length === 0 && team.errors.length === 0) {
    findings.push({
      code: 'no-board-columns',
      severity: 'medium',
      count: 1,
      detail:
        'No column configuration was returned for this board, so status-to-column mapping is unavailable and ' +
        'cycle-time boundaries will have to fall back to status categories.',
      examples: [],
    });
  }

  return {
    team: team.key,
    boardId: team.boardId,
    boardName: team.boardName,
    boardType: team.boardType,
    activeSprint: sprint
      ? { id: sprint.id, name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate, hasGoal: Boolean(sprint.goal) }
      : undefined,
    counts: {
      issues: team.issues.length,
      inActiveSprint: inSprint.length,
      inBacklog: team.issues.filter((i) => i.inBacklog).length,
      everInASprint: team.issues.filter((i) => i.sprintIds.length > 0).length,
    },
    findings: findings.filter((f): f is QualityFinding => f !== null),
    collectionErrors: team.errors,
  };
}

export function assessSnapshot(snapshot: JiraSnapshot, opts: QualityOptions): TeamQuality[] {
  return snapshot.teams.map((t) => assessTeam(t, opts));
}

const SEVERITY_ORDER: Record<QualityFinding['severity'], number> = { high: 0, medium: 1, low: 2 };

export function formatQualityReport(results: TeamQuality[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const board = r.boardName ? `${r.boardName} (#${r.boardId})` : `#${r.boardId}`;
    lines.push(`\n${r.team}  ${board}${r.boardType ? `  [${r.boardType}]` : ''}`);
    lines.push(
      `  ${r.counts.issues} issues on board, ${r.counts.inActiveSprint} in active sprint, ` +
        `${r.counts.inBacklog} in backlog`,
    );
    if (r.activeSprint) {
      lines.push(
        `  active sprint: ${r.activeSprint.name}  ${r.activeSprint.startDate?.slice(0, 10) ?? '?'} -> ` +
          `${r.activeSprint.endDate?.slice(0, 10) ?? '?'}  goal: ${r.activeSprint.hasGoal ? 'yes' : 'MISSING'}`,
      );
    } else {
      lines.push('  active sprint: none');
    }
    for (const e of r.collectionErrors) lines.push(`  ! collection: ${e}`);
    if (r.findings.length === 0) {
      lines.push('  no data-quality findings');
      continue;
    }
    for (const f of [...r.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
      const rate = f.outOf ? ` (${f.count}/${f.outOf}, ${Math.round((f.count / f.outOf) * 100)}%)` : ` (${f.count})`;
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}${rate}`);
      lines.push(`      ${f.detail}`);
      if (f.examples.length) lines.push(`      e.g. ${f.examples.join(', ')}`);
    }
  }
  return lines.join('\n');
}
