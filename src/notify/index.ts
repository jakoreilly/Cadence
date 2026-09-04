import { buildFeed, datesUpTo, type Feed } from './feed.js';
import { alertMessage, classify, formatPlan, headline, nextState, type Alert, type AlertPlan } from './digest.js';
import { emptyState, readState, writeState, statePath } from './state.js';
import { postToSlack, requireSlackToken } from './slack.js';
import { appendLogRows, type AlertLogRow } from './confluence.js';
import type { Config, Secrets } from '../types.js';

// ---------------------------------------------------------------------------
// The alerting run: assemble two feeds, decide, then route.
//
// The order matters and is the whole design. Everything that DECIDES anything
// happens before the first network call, and `--dry-run` stops exactly there -
// so what a dry run prints is what a real run would send, not an approximation
// of it. The two writers only format and post.
// ---------------------------------------------------------------------------

export interface RunAlertsOptions {
  dataDir: string;
  profileDir: string;
  profileName: string;
  config: Config;
  secrets: Secrets;
  /** The snapshot date to alert on. Defaults to the newest collected day. */
  date?: string;
  staleDays: number;
  window: number;
  /** Overrides config.alerts.limit. */
  limit?: number;
  /** Print and decide, send nothing, write no state. */
  dryRun: boolean;
  /** Force a destination on or off regardless of config, for a one-off run. */
  slack?: boolean;
  confluence?: boolean;
  /** Send the current picture regardless of what has already been said.
   *
   *  The honest escape hatch for two real situations: the first time a channel
   *  is turned on and somebody wants today's top findings in it rather than a
   *  baseline summary, and a message that was sent into the wrong channel. It
   *  skips the "already reported" test only - the severity floor, the per-run cap
   *  and the caveats all still apply - and the run records what it sent, so the
   *  next morning is quiet again. */
  resend?: boolean;
}

export interface RunAlertsResult {
  plan: AlertPlan;
  /** Everything above the floor today, sent or not - what the state records. */
  considered: Alert[];
  slackTs?: string;
  confluencePage?: string;
  statePath?: string;
}

function logRow(a: Alert, date: string): AlertLogRow {
  return {
    date,
    team: a.intervention.team,
    severity: a.intervention.severity,
    // Same wording as the Slack message: a resent row must not claim in the
    // permanent log that it had never been reported.
    status: a.resent ? 're-sent on request' : a.status,
    title: a.intervention.title,
    action: a.intervention.action,
    basis: a.caveats.join(' '),
    links: a.links,
  };
}

export async function runAlerts(opts: RunAlertsOptions): Promise<RunAlertsResult> {
  const { dataDir, profileName, config } = opts;
  const dates = datesUpTo(dataDir, profileName, opts.date ?? '9999-99-99');
  const date = opts.date ?? dates[dates.length - 1];
  if (!date) throw new Error(`No snapshots found under ${dataDir}/${profileName} - run "collect" first`);

  const today = buildFeed({ dataDir, profileName, date, staleDays: opts.staleDays, window: opts.window });
  if (!today) throw new Error(`No jira.json in snapshot ${date}`);

  // The previous collected day with a jira.json - not `date` minus one. A day
  // collected with --gitlab-only has no Jira file, and treating the gap as an
  // empty board would report the entire estate as new findings.
  let previous: Feed | null = null;
  for (const d of [...dates.filter((x) => x < date)].reverse()) {
    previous = buildFeed({ dataDir, profileName, date: d, staleDays: opts.staleDays, window: opts.window });
    if (previous) break;
  }

  const state = readState(dataDir, profileName);
  // --resend passes an EMPTY state rather than null: null means "no state file
  // exists", which is what selects the baseline run, and an explicit resend is
  // the opposite of a baseline.
  const plan = classify({
    today,
    previous,
    state: opts.resend ? emptyState(profileName) : state,
    minSeverity: config.alerts.minSeverity,
    limit: opts.limit ?? config.alerts.limit,
    resend: opts.resend,
  });

  // Everything above the floor, sent or not: the state has to record the
  // standing and the capped items too, or tomorrow they all look unreported.
  // This comes off the plan rather than being reassembled from its lists - see
  // the GOTCHA on AlertPlan.considered.
  const result: RunAlertsResult = { plan, considered: plan.considered };

  if (opts.dryRun) return result;

  const slackOn = opts.slack ?? config.alerts.slack?.enabled === true;
  const confluenceOn = opts.confluence ?? config.alerts.confluence?.enabled === true;

  if (slackOn) {
    const channel = config.alerts.slack?.channel;
    if (!channel) throw new Error('Slack is on for this run but config.alerts.slack.channel is not set');
    const token = requireSlackToken(opts.secrets, opts.profileDir);
    const replies = plan.send.map((a) => alertMessage(a));
    // The channel gets the status line even on a nothing-new day. That is
    // deliberate: silence is ambiguous - it reads identically to the scheduled
    // job having failed - and one line a day is the cheapest way to say "this
    // ran, and there was nothing".
    result.slackTs = await postToSlack(opts.profileDir, channel, token, headline(plan), replies);
  }

  if (confluenceOn) {
    const pageId = config.alerts.confluence?.pageId;
    if (!pageId) throw new Error('The Confluence log is on for this run but config.alerts.confluence.pageId is not set');
    const rows = plan.send.map((a) => logRow(a, plan.date));
    if (rows.length > 0) result.confluencePage = await appendLogRows(opts.secrets, pageId, rows);
  }

  // State is written LAST and only after the sends succeeded. A crash mid-post
  // therefore repeats an alert on the next run, which is the right way round:
  // a duplicate is an annoyance and a silently swallowed act-now finding is the
  // failure this whole layer exists to prevent.
  const updated = nextState(state ?? emptyState(profileName), plan, profileName, plan.considered);
  writeState(dataDir, profileName, updated);
  result.statePath = statePath(dataDir, profileName);

  return result;
}

export { formatPlan };
