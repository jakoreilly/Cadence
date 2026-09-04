import { deriveTrends } from '../derive.js';
import { deriveReview } from '../review.js';
import { wipSummary } from '../flow.js';
import { sprintOutlook } from '../insights.js';
import { activeLoad } from '../report/model.js';
import { interventions, type Intervention } from '../interventions.js';
import { seriesByTeam, teamHistory } from '../history.js';
import { loadProjectedDays } from '../loadHistory.js';
import { assessSchema, type SchemaAssessment } from '../schema.js';
import { listSnapshotDates, readSnapshot } from '../snapshot.js';
import type { ConfluenceSnapshot, GitLabSnapshot, JiraSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// One day's intervention feed, plus the BASIS of every figure in it.
//
// This is the layer the alerting path reads, and it exists for one reason: an
// alert is the smallest surface this tool has and the most likely to be
// forwarded on its own, with no page to scroll and no legend underneath. So a
// figure cannot travel out of here without the sentence that says what it is
// measured over.
//
// It computes nothing new. Every number comes from derive / insights / review /
// flow / history exactly as the report gets it; this module only assembles those
// inputs for a given collected date and attaches the caveats that already exist
// elsewhere as panel footnotes.
// ---------------------------------------------------------------------------

/** The basis notes for one team, keyed by what they qualify.
 *
 *  A record rather than a list because each alert carries only the ones that
 *  apply to it: pasting all four onto every message is how a caveat becomes
 *  boilerplate that nobody reads, which is the same failure as having none. */
export interface TeamCaveats {
  /** Estimate coverage. Attached to anything quoting points. */
  points?: string;
  /** The review denominator - human-authored merge requests only. */
  review?: string;
  /** The wall-clock interval the churn figures were observed over. */
  churn?: string;
  /** What scope the comment scan actually saw. */
  comments?: string;
}

export interface TeamFeed {
  team: string;
  boardId: number;
  boardName?: string;
  interventions: Intervention[];
  caveats: TeamCaveats;
}

export interface Feed {
  date: string;
  /** The snapshot's own capture time. This is the clock every figure in the feed
   *  was measured against, and the reason two feeds can be compared at all. */
  capturedAt: string;
  site: string;
  schema: SchemaAssessment;
  teams: TeamFeed[];
}

const MIN_ESTIMATE_COVERAGE = 2 / 3;

/** Collected dates up to and including `date`, oldest first. */
export function datesUpTo(dataDir: string, profileName: string, date: string): string[] {
  return listSnapshotDates(dataDir, profileName).filter((d) => d <= date);
}

export interface FeedOptions {
  dataDir: string;
  profileName: string;
  /** The collected date to build the feed FOR. */
  date: string;
  staleDays: number;
  /** Forecast window, in closed sprints. Matches the report's default. */
  window: number;
}

/** The intervention feed as it stood on one collected day.
 *
 *  GOTCHA: the clock is the SNAPSHOT'S `capturedAt`, never the wall clock, and
 *  that is what makes yesterday's feed comparable with today's rather than a
 *  re-aged copy of it. Build yesterday's feed with today's clock and every
 *  idle-day count in it grows by a day, so items that crossed the staleness
 *  threshold overnight appear in BOTH feeds - and the alerting layer, which
 *  calls anything present in both "not news", would suppress exactly the items
 *  that just became true. The same mistake in the other direction (today's feed
 *  built with a stale clock) hides everything that aged into view today.
 *
 *  Returns null when the day has no jira.json - `collect --gitlab-only` and a
 *  failed Jira run both leave a day without one, and reading that as an empty
 *  board would report every ticket on the estate as resolved overnight. */
export function buildFeed(opts: FeedOptions): Feed | null {
  const { dataDir, profileName, date } = opts;
  const jira = readSnapshot<JiraSnapshot>(dataDir, profileName, date, 'jira');
  if (!jira) return null;
  const gitlab = readSnapshot<GitLabSnapshot>(dataDir, profileName, date, 'gitlab');
  const context = readSnapshot<ConfluenceSnapshot>(dataDir, profileName, date, 'context');

  const asOf = new Date(jira.capturedAt);
  const trends = deriveTrends(jira, opts.window);
  const reviewByTeam = new Map((gitlab ? deriveReview(gitlab) : []).map((r) => [r.team, r]));

  // History is bounded at `date` on purpose. Yesterday's feed must be built from
  // what was knowable yesterday, or a churn figure that only exists because of
  // today's snapshot appears in both feeds and is never news.
  //
  // Drawn from the shared projection cache rather than re-read here.
  // `alert` builds TWO feeds whose date ranges overlap almost completely, so this
  // loop runs twice per run over nearly the same days - which is exactly why the
  // projections are cached rather than re-derived. See loadHistory.ts.
  const days = loadProjectedDays(dataDir, profileName, date);
  const historyByTeam = new Map([...seriesByTeam(days)].map(([key, series]) => [key, teamHistory(series)]));

  const teams: TeamFeed[] = jira.teams.map((t, i) => {
    const trend = trends[i]!;
    const review = reviewByTeam.get(t.key);
    const wip = wipSummary(t, { now: asOf, staleDays: opts.staleDays });
    const outlook = sprintOutlook(t, trend, asOf);
    const history = historyByTeam.get(t.key) ?? null;
    const load = activeLoad(t);

    const caveats: TeamCaveats = {};

    // The single most forwardable wrong sentence this tool could produce. Board
    // 705 leaves 97% of its active sprint unestimated, and "fs is at 97%
    // unestimated" becomes "fs has no capacity left" in one retelling. The
    // caveat says what the number is and, explicitly, what it is not.
    const coverage = load.issues > 0 ? (load.issues - load.unestimated) / load.issues : 0;
    if (load.issues > 0 && coverage < MIN_ESTIMATE_COVERAGE) {
      caveats.points =
        `${Math.round((1 - coverage) * 100)}% of this team's active-sprint work carries no estimate ` +
        `(${load.unestimated} of ${load.issues} issues), so any points figure here is a floor and not a measure of ` +
        `the work outstanding. It does not mean the team is out of capacity, and it is not comparable with another board.`;
    }

    // The 12%-vs-54% lesson, in one sentence. Same data, different denominator.
    if (review) {
      caveats.review =
        `Review figures are over the ${review.humanAuthoredTotal} merge requests a PERSON opened in the ` +
        `${gitlab?.windowDays ?? 30}-day window; ${review.automationAuthored} automation-authored ones are excluded from ` +
        `both sides of every rate. Including them moved the same measurement from 12% to 54% on this estate.`;
    }

    // GOTCHA 31, carried into the alert. Two consecutive snapshot DATES are not
    // a day of activity: the first two real days here were 8.7 hours apart and
    // every one of them was overnight, so zero churn was correct and read as a
    // quiet working day.
    if (history && history.churn && history.observedHours !== null) {
      caveats.churn =
        `Churn is observed between captures ${history.churn.observedFrom} and ${history.churn.observedTo}, ` +
        `${history.observedHours} wall-clock hours apart` +
        (history.observedHours < 20
          ? ' - less than a working day, so a small figure here is a short interval and not a quiet sprint.'
          : '.');
    }

    if (t.issues.some((x) => x.comments !== undefined)) {
      caveats.comments =
        'Comment threads are collected for open work in an active sprint only, so the comment scan covers that work ' +
        'rather than the whole board.';
    }

    return {
      team: t.key,
      boardId: t.boardId,
      boardName: t.boardName,
      caveats,
      interventions: interventions({
        team: t,
        trends: trend,
        outlook,
        review,
        wip,
        churn: history?.churn ?? null,
        now: asOf,
        staleDays: opts.staleDays,
        // GOTCHA: the report's default per-kind cap of 8 must NOT be used here,
        // and it produced a false "new" on the first two-day exercise. The cap
        // exists so a page is readable - ten blocked tickets is a finding and
        // forty rows of it is a wall - but this feed is the thing "is it new" is
        // decided against, and a capped feed makes an item look new the moment
        // something above it drops out. Measured: closing one of board 705's six
        // active sprints removed six items from the fs list, and CSP-360 -
        // twenty-two days idle and unchanged for weeks - surfaced as "new since
        // the last snapshot". The per-run `limit` and the severity floor are what
        // keep the message short; this number only has to be larger than any
        // board's real tail.
        perKindLimit: 50,
      }),
    };
  });

  return {
    date,
    capturedAt: jira.capturedAt,
    site: jira.site,
    schema: assessSchema({ jira, gitlab, context }),
    teams,
  };
}
