import {
  interventionIdentity as alertIdentity,
  rankInterventions,
  type Intervention,
  type InterventionSeverity,
} from '../interventions.js';
import { boardUrl, issueUrl } from '../links.js';
import type { AlertRecord, AlertState } from './state.js';
import type { Feed, TeamCaveats, TeamFeed } from './feed.js';

// ---------------------------------------------------------------------------
// From a day's interventions to the handful of things worth interrupting
// somebody about - and nothing else.
//
// Three rules, and every one of them is a rule about what NOT to send:
//
//   1. An alert that fires every day is an alert nobody reads. 15 top-ranked
//      interventions exist across four teams on any given day and most are
//      unchanged since yesterday. A threshold crossed yesterday and still
//      crossed today is not news.
//   2. The basis of a figure travels with the figure. A message is the smallest
//      surface in this tool and the most likely to be forwarded without the page
//      it came from, so the caveat is IN the message, not in the report it links
//      to.
//   3. Nothing here computes a number. Every figure in an outgoing message is a
//      string the derive layer already produced; this module chooses which to
//      send and formats it. `test/notify.test.ts` pins that by asserting every
//      digit in a rendered alert body traces back to the intervention text.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<InterventionSeverity, number> = { 'act-now': 3, 'this-week': 2, watch: 1 };
const SEVERITY_LABEL: Record<InterventionSeverity, string> = {
  'act-now': 'ACT NOW',
  'this-week': 'THIS WEEK',
  watch: 'WATCH',
};

/** Intervention kinds an alert is allowed to carry.
 *
 *  An ALLOWLIST, not a blocklist, and that is the whole point: a new
 *  intervention kind cannot reach a Slack channel until somebody adds it here
 *  and therefore thinks about whether its basis survives being quoted alone.
 *  This is the enforceable form of the rule in docs/handover.md - a WEAK or
 *  UNUSABLE figure must not be promoted into a summary without fixing its basis
 *  first - because a message has no room for a trustworthiness legend.
 *
 *  What is deliberately NOT here:
 *    - `comments-not-collected`: a coverage gap, not a finding. It travels as the
 *      freshness line on the run instead, where it belongs.
 *    - `no-goal` and `wip-overload`: real, worth a conversation at the next
 *      planning session, and not worth an out-of-band interruption. They stay in
 *      the report. */
export const ALERTABLE_KINDS = new Set([
  'flagged',
  'overdue',
  'sprint-overdue',
  'blocked-by-open',
  'blocker-in-comments',
  'over-committed',
  'review-stalled',
  'review-gap',
  'merge-lag',
  'scope-churn',
  'stale',
  'unassigned',
]);

/** Which team-level basis notes each kind has to carry. */
const KIND_CAVEATS: Record<string, Array<keyof TeamCaveats>> = {
  'over-committed': ['points'],
  'scope-churn': ['points', 'churn'],
  'review-gap': ['review'],
  'merge-lag': ['review'],
  'blocker-in-comments': ['comments'],
};

/** The content identity of a finding, stable across runs.
 *
 *  Re-exported under the name this module has always used it by. The function
 *  itself lives in interventions.ts because the report's since-yesterday panel
 *  is a second caller - the alerting path and the report have to agree on what
 *  "the same finding as yesterday" means, and the only way to guarantee that is
 *  for there to be one function. See interventionIdentity there for the
 *  reasoning, including why `Intervention.id` must never be used for this. */
export { alertIdentity };

/** Why an item is being sent - or, for `standing`, why it is not. */
export type AlertStatus =
  /** Absent from the previous snapshot's feed: it became true since yesterday. */
  | 'new'
  /** Present in both feeds, but stronger today than when it was last sent. */
  | 'escalated'
  /** Already present yesterday and never actually reported - `alert` did not run,
   *  or it was below the floor then. Not new, but the reader has not been told. */
  | 'unreported'
  /** Present, already sent, unchanged. Counted, never repeated. */
  | 'standing';

export interface Alert {
  intervention: Intervention;
  identity: string;
  status: AlertStatus;
  /** True when this went out because the reader asked for a resend rather than
   *  because anything changed. It has to be visible in the message: a resend is
   *  told to ignore what was already said, so labelling an item "not previously
   *  reported" when it very likely was is a claim the tool cannot support. */
  resent?: boolean;
  /** The severity this identity was last SENT at, when it has been. */
  previousSeverity?: InterventionSeverity;
  /** Basis notes that must travel with this item's figures. */
  caveats: string[];
  /** Deep links to everything the item names. */
  links: { label: string; url: string }[];
}

export interface AlertPlan {
  date: string;
  capturedAt: string;
  /** True when no state existed: the run records a baseline and sends a summary
   *  instead of one message per standing finding. */
  seeding: boolean;
  /** The previous collected date the feed was diffed against, when there was
   *  one. Null on the first collected day, which is reported rather than
   *  silently treated as "everything is new". */
  comparedWith: string | null;
  send: Alert[];
  standing: Alert[];
  /** Above the floor and dropped by the per-run cap. Named, never silent. */
  suppressedByLimit: Alert[];
  /** Sent before and gone from today's feed. Somebody acted, or it aged out. */
  cleared: AlertRecord[];
  /** The snapshot-freshness line, when the snapshot is behind or incomplete. */
  freshness: string | null;
  /** Every finding above the floor today, whatever became of it.
   *
   *  GOTCHA: this is what the state must be written from, and reconstructing it
   *  as `[...send, ...suppressedByLimit, ...standing]` is the obvious shortcut
   *  and is wrong on exactly the run where it matters. A SEEDING run sends
   *  nothing, so those three lists are empty, so the baseline was written with
   *  zero records - and the next morning all 26 standing findings on this estate
   *  fired as "not previously reported". The baseline run's whole job is to
   *  record, so the thing it records has to exist independently of what it sent. */
  considered: Alert[];
  /** Every alertable finding present today at ANY severity, floor or not.
   *
   *  GOTCHA: this is what decides whether a state record is DROPPED, and it is
   *  deliberately not `considered`. The two differ by exactly the items that sit
   *  below the severity floor, and using `considered` there silently threw away
   *  the history of anything that de-escalated:
   *
   *    day 1  a flag idle four days fires at act-now and is recorded
   *    day 2  somebody touches the ticket, so it drops to this-week... or with a
   *           `watch` floor, below it entirely. It is still present, so it is
   *           correctly NOT reported as cleared - but it was absent from
   *           `considered`, so its record was deleted anyway.
   *    day 3  it goes idle again and re-crosses the floor. With no record it
   *           classifies as `unreported` - "not previously reported" - which is
   *           a false statement about a finding that was reported on day 1, and
   *           its firstSeenDate and send count are gone for good.
   *
   *  `cleared` has always been computed against this set. The state deletion has
   *  to agree with it, or the tool reports an item as still standing and forgets
   *  it in the same run. */
  presentToday: string[];
  /** Total findings above the floor today. `considered.length`, kept as a field
   *  so a `--json` reader does not have to count an array to get the headline. */
  candidates: number;
}

export interface ClassifyInput {
  today: Feed;
  /** The previous collected day's feed, or null on the first day. */
  previous: Feed | null;
  state: AlertState | null;
  minSeverity: InterventionSeverity;
  limit: number;
  /** Send today's picture regardless of what has already been said. The caller
   *  also passes an empty state; this flag is what makes the messages SAY so. */
  resend?: boolean;
}

function caveatsFor(i: Intervention, caveats: TeamCaveats): string[] {
  const wanted = KIND_CAVEATS[i.kind] ?? [];
  return wanted.map((k) => caveats[k]).filter((c): c is string => Boolean(c));
}

function linksFor(i: Intervention, site: string, team: TeamFeed): { label: string; url: string }[] {
  // Capped at six: a message listing 37 ticket links is a message nobody opens
  // any of. The board link is always last, and it is the route to the rest.
  const out = i.issueKeys.slice(0, 6).map((k) => ({ label: k, url: issueUrl(site, k) }));
  out.push({ label: `board ${team.boardName ?? team.boardId}`, url: boardUrl(site, team.boardId) });
  return out.filter((l) => l.url !== '');
}

/** Which findings to send, which to count, and which to name as dropped.
 *
 *  Pure: takes two feeds and the state, returns the plan. Nothing here reads a
 *  file or posts anything, so the whole decision is testable offline and a
 *  `--dry-run` prints exactly what a real run would send. */
export function classify(input: ClassifyInput): AlertPlan {
  const { today, previous, state, minSeverity, limit } = input;
  const floor = SEVERITY_RANK[minSeverity];

  const alertable = (t: TeamFeed): Intervention[] => t.interventions.filter((i) => ALERTABLE_KINDS.has(i.kind));

  // Yesterday's feed indexed by identity. Severity is kept, not just presence:
  // "present yesterday" and "present yesterday at the same severity" are
  // different facts and only the second one means "not news".
  const yesterday = new Map<string, InterventionSeverity>();
  for (const t of previous?.teams ?? []) {
    for (const i of alertable(t)) yesterday.set(alertIdentity(i), i.severity);
  }

  const sentBefore = new Map((state?.records ?? []).map((r) => [r.identity, r]));

  const candidates: Alert[] = [];
  const everythingToday = new Set<string>();
  for (const team of today.teams) {
    for (const i of alertable(team)) {
      const identity = alertIdentity(i);
      everythingToday.add(identity);
      if (SEVERITY_RANK[i.severity] < floor) continue;

      const record = sentBefore.get(identity);
      let status: AlertStatus;
      if (record) {
        // GOTCHA: this test used to be `record.sends > 0`, which looks more
        // precise and moved the day-one firehose to day two instead of removing
        // it. A SEEDED record has `sends: 0` - the baseline run recorded it and
        // deliberately said nothing - so treating "recorded but never sent" as
        // unreported made all 26 standing findings on this estate fire on the
        // second run. The baseline has to mean "already visible in the report,
        // not news", which is exactly what the seeding message says it means. An
        // escalation still fires, because the SEEDED severity is what the next
        // run compares against.
        status = SEVERITY_RANK[i.severity] > SEVERITY_RANK[record.severity] ? 'escalated' : 'standing';
      } else if (yesterday.has(identity)) {
        // Present yesterday and never actually reported: either `alert` did not
        // run, or the item was seeded as a baseline. Worth sending once, and
        // worth labelling honestly - calling a nine-day-old blocker "new" is the
        // fastest way to lose the reader's trust in every other label here.
        status = 'unreported';
      } else {
        status = 'new';
      }

      candidates.push({
        intervention: i,
        identity,
        status,
        resent: input.resend === true,
        previousSeverity: record?.severity,
        caveats: caveatsFor(i, team.caveats),
        links: linksFor(i, today.site, team),
      });
    }
  }

  const standing = candidates.filter((c) => c.status === 'standing');
  const fresh = candidates.filter((c) => c.status !== 'standing');

  // Ranked ROUND ROBIN across teams, reusing the front page's own ordering: one
  // team's tail must not be able to answer "where do I need to look today".
  // Reconstructing the alert from the ranked intervention is safe because
  // identity is a function of the intervention.
  const byIdentity = new Map(fresh.map((c) => [c.identity, c]));
  const ranked = rankInterventions(
    fresh.map((c) => c.intervention),
    fresh.length,
  );
  const ordered = ranked.map((i) => byIdentity.get(alertIdentity(i))!).filter(Boolean);

  const send = ordered.slice(0, limit);
  const suppressedByLimit = ordered.slice(limit);

  const cleared = (state?.records ?? []).filter((r) => r.sends > 0 && !everythingToday.has(r.identity));

  const seeding = state === null;
  const freshness = today.schema.stale ? today.schema.headline : null;

  return {
    date: today.date,
    capturedAt: today.capturedAt,
    seeding,
    comparedWith: previous?.date ?? null,
    send: seeding ? [] : send,
    standing,
    suppressedByLimit: seeding ? [] : suppressedByLimit,
    cleared: seeding ? [] : cleared,
    freshness,
    considered: candidates,
    presentToday: [...everythingToday],
    candidates: candidates.length,
  };
}

/** The state to persist after a run. Everything above the floor is recorded, so
 *  a standing item is never re-sent, and the seeding run records a baseline with
 *  `sends: 0` so a later "we never told you this" stays distinguishable from
 *  "we told you on day one". */
export function nextState(previousState: AlertState | null, plan: AlertPlan, profileName: string, all: Alert[]): AlertState {
  const base = previousState ?? { version: 1 as const, profile: profileName, seededAt: plan.date, lastRunDate: null, records: [] };
  const kept = new Map(base.records.map((r) => [r.identity, r]));

  // Gone from today's feed: dropped rather than kept forever. A blockage that
  // was cleared in March must not suppress the same blockage recurring in
  // September - the recurrence is exactly the thing worth knowing.
  //
  // Keyed on `presentToday` - every alertable finding at ANY severity - and NOT
  // on `all`, which is only what cleared the floor. See the GOTCHA on
  // AlertPlan.presentToday: the two differ by exactly the de-escalated items,
  // and dropping those loses the history that makes their next escalation an
  // escalation rather than a first sighting. This has to agree with how `cleared`
  // is computed or a run can report an item as standing and forget it at once.
  const todayIdentities = new Set(plan.presentToday);
  for (const identity of [...kept.keys()]) if (!todayIdentities.has(identity)) kept.delete(identity);

  const sentNow = new Set(plan.send.map((a) => a.identity));
  for (const a of all) {
    const existing = kept.get(a.identity);
    const sending = sentNow.has(a.identity);
    kept.set(a.identity, {
      identity: a.identity,
      team: a.intervention.team,
      kind: a.intervention.kind,
      // Only a SENT message updates the recorded severity. Otherwise an item
      // that quietly escalated while suppressed would have its new severity
      // recorded as "already told them", and the escalation - the one thing that
      // makes a standing item news again - would never fire.
      severity: sending ? a.intervention.severity : (existing?.severity ?? a.intervention.severity),
      title: sending ? a.intervention.title : (existing?.title ?? a.intervention.title),
      firstSeenDate: existing?.firstSeenDate ?? plan.date,
      lastSentDate: sending ? plan.date : (existing?.lastSentDate ?? null),
      sends: (existing?.sends ?? 0) + (sending ? 1 : 0),
      seeded: existing?.seeded ?? plan.seeding,
    });
  }

  return {
    version: 1,
    profile: profileName,
    seededAt: base.seededAt ?? plan.date,
    lastRunDate: plan.date,
    records: [...kept.values()].sort((a, b) => a.identity.localeCompare(b.identity)),
  };
}

// --- rendering ---------------------------------------------------------------

const STATUS_LABEL: Record<AlertStatus, string> = {
  new: 'new since the last snapshot',
  escalated: 'escalated',
  unreported: 'not previously reported',
  standing: 'standing',
};

/** How a message is being rendered. The same content either way - only the
 *  escaping and the link syntax differ.
 *
 *  GOTCHA: the first cut rendered once for Slack and stripped the markup
 *  afterwards for the terminal, which printed `board PAY &amp; CSP` on the CLI.
 *  Slack's escaping is not reversible by removing asterisks, so the decision is
 *  made once, here, and the CLI never sees mrkdwn at all. */
export type RenderMode = 'slack' | 'plain';

/** Slack mrkdwn escaping. Only the three characters Slack itself treats as
 *  markup - doing more mangles the ticket titles this is quoting. */
function esc(text: string, mode: RenderMode): string {
  if (mode === 'plain') return text;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const bold = (text: string, mode: RenderMode): string => (mode === 'slack' ? `*${text}*` : text);

/** The one line that goes in the channel.
 *
 *  Counts, not findings: the channel gets a status line and the findings go in
 *  the thread, so a quiet day costs the reader one glance. */
export function headline(plan: AlertPlan, mode: RenderMode = 'slack'): string {
  const parts: string[] = [];
  if (plan.seeding) {
    parts.push(`baseline recorded for ${plan.candidates} standing item${plan.candidates === 1 ? '' : 's'}`);
  } else if (plan.send.some((a) => a.resent)) {
    parts.push(`${plan.send.length} re-sent on request (what was already reported was ignored)`);
  } else {
    const counts = { new: 0, escalated: 0, unreported: 0 } as Record<string, number>;
    for (const a of plan.send) counts[a.status] = (counts[a.status] ?? 0) + 1;
    if (counts.new) parts.push(`${counts.new} new`);
    if (counts.escalated) parts.push(`${counts.escalated} escalating`);
    if (counts.unreported) parts.push(`${counts.unreported} not previously reported`);
    if (parts.length === 0) parts.push('nothing new');
    parts.push(`${plan.standing.length} standing (not repeated)`);
    if (plan.suppressedByLimit.length > 0) parts.push(`${plan.suppressedByLimit.length} over the per-run cap`);
    if (plan.cleared.length > 0) parts.push(`${plan.cleared.length} cleared`);
  }

  const lines = [bold(`Cadence — ${plan.date}`, mode), parts.join(' · ')];
  lines.push(
    `Snapshot captured ${plan.capturedAt}` +
      (plan.comparedWith ? `, compared with ${plan.comparedWith}` : ', with no earlier snapshot to compare against'),
  );
  if (plan.freshness) lines.push(`${mode === 'slack' ? ':warning: ' : 'WARNING: '}${esc(plan.freshness, mode)}`);
  if (plan.seeding) {
    lines.push(
      'This is the first alert run for this profile, so nothing is being raised individually: everything currently ' +
        'standing has been recorded as the baseline. From the next run, only findings that are new, or that have got ' +
        'worse, are posted.',
    );
  }
  return lines.join('\n');
}

/** One finding, as a threaded reply.
 *
 *  Every field comes straight from the intervention. The only text this function
 *  adds is labels - "What", "Why", "Do" - and the status word. */
export function alertMessage(a: Alert, mode: RenderMode = 'slack'): string {
  const i = a.intervention;
  const status = a.resent
    ? 're-sent on request'
    : a.status === 'escalated' && a.previousSeverity
      ? `escalated from ${SEVERITY_LABEL[a.previousSeverity]}`
      : STATUS_LABEL[a.status];
  const lines = [
    bold(`[${SEVERITY_LABEL[i.severity]} · ${esc(i.team, mode)} · ${status}]`, mode),
    bold(esc(i.title, mode), mode),
    `${bold('What:', mode)} ${esc(i.what, mode)}`,
    `${bold('Why:', mode)} ${esc(i.why, mode)}`,
    `${bold('Do:', mode)} ${esc(i.action, mode)}`,
  ];
  if (i.evidence) lines.push(`${bold('Evidence:', mode)} ${esc(i.evidence, mode)}`);
  if (a.links.length > 0) {
    const links = a.links.map((l) => (mode === 'slack' ? `<${l.url}|${esc(l.label, mode)}>` : `${l.label} ${l.url}`));
    lines.push(`${bold('Open:', mode)} ${links.join(mode === 'slack' ? ' · ' : '  ')}`);
  }
  // Last, and never dropped to shorten a message. The basis is the difference
  // between a figure and a claim.
  for (const c of a.caveats) lines.push(mode === 'slack' ? `_Basis: ${esc(c, mode)}_` : `Basis: ${c}`);
  return lines.join('\n');
}

/** The CLI rendering, and what `--dry-run` prints. Same content, no mrkdwn. */
export function formatPlan(plan: AlertPlan): string[] {
  const out: string[] = [];
  out.push(...headline(plan, 'plain').split('\n'));
  out.push('');

  if (plan.send.length === 0 && !plan.seeding) {
    out.push('  Nothing to send. Every finding above the floor was already reported and has not got worse.');
  }
  for (const a of plan.send) {
    out.push(...alertMessage(a, 'plain').split('\n').map((l) => `  ${l}`));
    out.push('');
  }
  if (plan.suppressedByLimit.length > 0) {
    out.push(`  Over the per-run cap and NOT sent (raise --limit to include them):`);
    for (const a of plan.suppressedByLimit) out.push(`    - [${a.intervention.severity}] ${a.intervention.team}: ${a.intervention.title}`);
    out.push('');
  }
  if (plan.cleared.length > 0) {
    out.push(`  Cleared since it was last reported:`);
    for (const r of plan.cleared) out.push(`    - ${r.team}: ${r.title}`);
    out.push('');
  }
  if (plan.standing.length > 0) {
    out.push(`  Standing, already reported, not repeated: ${plan.standing.length}`);
    for (const a of plan.standing.slice(0, 20)) out.push(`    - [${a.intervention.severity}] ${a.intervention.team}: ${a.intervention.title}`);
    if (plan.standing.length > 20) out.push(`    … and ${plan.standing.length - 20} more`);
  }
  return out;
}
