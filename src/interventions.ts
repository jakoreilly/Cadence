import { isDone } from './quality.js';
import type { IssueComment, IssueSnapshot, TeamSnapshot } from './types.js';
import type { ReviewMetrics } from './review.js';
import type { SprintOutlook } from './insights.js';
import { issuesBySprint } from './derive.js';
import type { TeamTrends } from './derive.js';
import type { WipSummary } from './flow.js';
import type { ChurnSummary } from './history.js';

// ---------------------------------------------------------------------------
// The intervention feed: "what would I actually do about any of this today".
//
// Every other panel in this tool reports a MEASUREMENT. This one reports a
// DECISION a manager can take, with the evidence attached and the reason stated
// in a sentence they can repeat in a meeting. It is the difference between a
// dashboard and a hand-off.
//
// Three rules it keeps:
//
//   1. Every intervention names the ACTION, not just the problem. "60% of merged
//      work is unreviewed" is a finding; "ask Alex and Andre to pair on
//      reviews for two weeks - those two are the 60%" is an intervention.
//   2. Nothing here invents a number. Every figure quoted is one the derive,
//      insights, review, flow or history layers already computed, and the
//      intervention only chooses which to raise and what to say about it.
//   3. Severity is a bucket with a stated threshold, never a score. `act-now`
//      means somebody is already stopped; `this-week` means it will stop
//      somebody; `watch` means it is drifting.
//
// The comment scan is the one genuinely new signal here, and it is the most
// valuable: the Flagged field is the FORMAL blocker signal and the comment
// thread is the real one. A team that never touches Flagged still writes
// "blocked waiting on the platform team" in a comment, and until now nothing in
// this tool could see that.
// ---------------------------------------------------------------------------

export type InterventionSeverity = 'act-now' | 'this-week' | 'watch';

export interface Intervention {
  /** Stable within a report, for deep-linking and de-duplication. */
  id: string;
  team: string;
  severity: InterventionSeverity;
  /** Machine-readable family, for filtering and for the embedded JSON. */
  kind: string;
  /** One line, written to be readable by someone who has never seen this board. */
  title: string;
  /** What was observed, with its numbers. */
  what: string;
  /** Why it matters - the consequence, not a restatement. */
  why: string;
  /** What to do about it. Always an action a manager can take this week. */
  action: string;
  /** Tickets the reader should open. */
  issueKeys: string[];
  /** A verbatim quote or a figure, where one exists. Never paraphrased: a
   *  paraphrase of somebody's comment is a claim about what they meant. */
  evidence?: string;
  /** The stable identity a content-addressed caller (interventionIdentity,
   *  below) should key on INSTEAD of issueKeys, for a per-item finding that
   *  is not about a Jira issue at all - a merge request, say. Without this,
   *  every `review-stalled` finding for a team collapses onto the same
   *  identity, because `issueKeys` is empty for all of them: not a Jira ticket
   *  ID to omit, a Jira ticket ID that never existed. A state file keyed on
   *  that would track one stalled merge request per team no matter how many
   *  are actually stalled, and "is this new" would silently stop meaning
   *  anything for the rest. */
  identityKey?: string;
  /** Ordering only, never displayed - a visible score invites an argument about
   *  the score instead of about the work. */
  weight: number;
}

/** The content identity of a finding, stable across runs.
 *
 *  GOTCHA: `Intervention.id` looks made for this and must never be used. It is
 *  `${team}-${kind}-${seq++}`, so it is POSITIONAL: one ticket clearing its flag
 *  renumbers every later flagged item, and a state file keyed on it would report
 *  the whole feed as new the next morning. Identity has to be what the finding
 *  is ABOUT - the team, the kind, and the tickets named - so the same blockage
 *  on the same ticket is the same alert tomorrow no matter what moved around it.
 *
 *  Issue keys are sorted and capped: `unassigned` names every unowned ticket in
 *  the sprint, and letting a 37-key list into the identity would make one ticket
 *  being assigned look like a brand-new finding about the other 36. The first
 *  three sorted keys are enough to distinguish two findings of the same kind on
 *  the same board while staying stable as the tail changes.
 *
 *  This lives here, not in digest.ts, because the report's since-yesterday panel
 *  is a second caller - the alerting path and the report have to agree on what
 *  "the same finding as yesterday" means, and the only way to guarantee that is
 *  for there to be one function. */
export function interventionIdentity(i: Intervention): string {
  // identityKey wins when the intervention set one: a finding that is not
  // about a Jira issue at all (a merge request, say) has an empty issueKeys,
  // and every such finding for a team would otherwise collapse onto the same
  // identity - not "no ticket to distinguish it", but no field to distinguish
  // it AT ALL. See the note on Intervention.identityKey above.
  if (i.identityKey) return `${i.team}|${i.kind}|${i.identityKey}`;
  const keys = [...i.issueKeys].sort().slice(0, 3).join(',');
  return `${i.team}|${i.kind}|${keys}`;
}

const DAY = 86_400_000;
const daysSince = (iso: string | undefined, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / DAY : null;
};

// --- comment scanning ---------------------------------------------------------

/** Phrases that mean somebody is stopped, or about to be.
 *
 *  Substring matching on lower-cased text, deliberately. A tokeniser would be
 *  more precise and would miss "blocked/waiting", "blocker:", "un-blocked" and
 *  every other way people actually type. The cost of the loose match is a false
 *  positive the reader dismisses in one glance at the quote - which is why the
 *  QUOTE is always shown beside the finding and never just the verdict. */
const BLOCKER_PHRASES = [
  'blocked', 'blocker', 'blocking', 'waiting on', 'waiting for', 'wait for',
  'on hold', 'cannot proceed', "can't proceed", 'cant proceed', 'stuck',
  'no response', 'chasing', 'chased', 'escalat', 'dependency on', 'depends on',
  'need a decision', 'needs a decision', 'need approval', 'needs approval',
  'awaiting', 'not able to', 'unable to progress',
];

/** Phrases that resolve one. A thread whose LAST word is "unblocked now" is not
 *  a blocker, and reporting it as one is the fastest way to have the whole panel
 *  dismissed as noise. */
const RESOLVED_PHRASES = ['unblocked', 'no longer blocked', 'resolved now', 'this is done', 'good to go', 'sorted now'];

export interface CommentSignal {
  phrase: string;
  comment: IssueComment;
}

/** The most recent comment that reads like a blocker, if the thread has not
 *  since said otherwise.
 *
 *  GOTCHA: comments arrive NEWEST FIRST from the collector (see recentComments),
 *  so the first match walking forward is the latest one - and the resolution
 *  test only has to consider comments NEWER than the match, which is everything
 *  before it in the array. Walking the array the other way finds the oldest
 *  complaint on a long ticket and reports a blocker that was cleared in March. */
export function blockerInComments(comments: IssueComment[] | undefined): CommentSignal | null {
  if (!comments || comments.length === 0) return null;
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i]!;
    const body = c.body.toLowerCase();
    const phrase = BLOCKER_PHRASES.find((p) => body.includes(p));
    if (!phrase) continue;
    if (RESOLVED_PHRASES.some((p) => body.includes(p))) return null;
    const newer = comments.slice(0, i);
    if (newer.some((n) => RESOLVED_PHRASES.some((p) => n.body.toLowerCase().includes(p)))) return null;
    return { phrase, comment: c };
  }
  return null;
}

// --- the feed ------------------------------------------------------------------

export interface InterventionInput {
  team: TeamSnapshot;
  trends: TeamTrends;
  outlook: SprintOutlook | null;
  review?: ReviewMetrics;
  wip: WipSummary;
  churn?: ChurnSummary | null;
  now: Date;
  staleDays: number;
  /** Cap on the per-ticket interventions of any one kind. Ten blocked tickets
   *  is a finding; forty rows of it is a wall the reader scrolls past. */
  perKindLimit?: number;
}

const SEVERITY_WEIGHT: Record<InterventionSeverity, number> = { 'act-now': 1000, 'this-week': 500, watch: 100 };

/** Tie-break between kinds that landed in the same severity bucket.
 *
 *  Severity alone is not enough, and the first live run showed why: eight
 *  claimed-but-not-moving tickets from one team, each just past the two-week
 *  staleness threshold, filled the whole front page and pushed an explicitly
 *  FLAGGED blocker and a missed due date below the fold. Somebody saying out
 *  loud that they are stopped, and a date already broken, outrank an inference
 *  from a timestamp - so the ordering says so rather than leaving it to
 *  whichever number happened to be larger. */
const KIND_PRIORITY: Record<string, number> = {
  flagged: 160,
  overdue: 150,
  // Just under an overdue TICKET: a broken promise to a named person outranks a
  // broken sprint boundary, but both outrank an inference from a timestamp.
  'sprint-overdue': 140,
  'blocked-by-open': 130,
  'blocker-in-comments': 120,
  'over-committed': 90,
  'review-stalled': 75,
  'merge-lag': 70,
  'review-gap': 70,
  'scope-churn': 60,
  stale: 50,
  unassigned: 40,
  'no-goal': 30,
  'wip-overload': 30,
  'comments-not-collected': 0,
};

export function interventions(input: InterventionInput): Intervention[] {
  const { team, now, staleDays } = input;
  const limit = input.perKindLimit ?? 8;
  const out: Intervention[] = [];
  let seq = 0;
  const push = (i: Omit<Intervention, 'id' | 'team' | 'weight'> & { weight?: number }): void => {
    out.push({
      ...i,
      id: `${team.key}-${i.kind}-${seq++}`,
      team: team.key,
      weight: SEVERITY_WEIGHT[i.severity] + (KIND_PRIORITY[i.kind] ?? 0) + (i.weight ?? 0),
    });
  };

  // Hoisted above every section because both the per-ticket scans and the
  // sprint-level ones need it. Board 705 runs six concurrent active sprints, so
  // "the active sprint" is a set here and never a single object.
  const active = team.sprints.filter((s) => s.state === 'active');
  const activeIds = new Set(active.map((s) => s.id));
  const inSprint = team.issues.filter((i) => i.sprintIds.some((id) => activeIds.has(id)));
  const open = inSprint.filter((i) => !isDone(i));
  const byKey = new Map(team.issues.map((i) => [i.key, i]));
  const label = (i: IssueSnapshot): string => (i.summary ? `${i.key} “${i.summary}”` : i.key);

  // --- 1. explicitly flagged ------------------------------------------------
  const flagged = open.filter((i) => i.flagged);
  for (const i of flagged.slice(0, limit)) {
    const idle = daysSince(i.updated, now);
    push({
      kind: 'flagged',
      severity: idle !== null && idle >= 3 ? 'act-now' : 'this-week',
      title: `${label(i)} is flagged as blocked`,
      what:
        `Someone set the Flagged field on this ticket${i.assignee ? `, which is assigned to ${i.assignee.displayName}` : ' and it has no assignee'}` +
        `${idle === null ? '' : `, and nothing has changed on it for ${Math.round(idle)} day${Math.round(idle) === 1 ? '' : 's'}`}.`,
      why:
        'A flag is the strongest signal on a board because a person already said out loud that they are stopped. ' +
        'The only question left is whether anybody acted on it.',
      action:
        idle !== null && idle >= 3
          ? 'Ask today what the flag is waiting on and who owns the other side of it. A flag that has sat for days is usually waiting on somebody outside the team, which is the part only a manager can move.'
          : 'Confirm at the next standup that the flag is being worked and that the person it depends on knows.',
      issueKeys: [i.key],
      evidence: i.description,
      weight: Math.min(200, (idle ?? 0) * 10),
    });
  }

  // --- 2. blocked by something that is still open ---------------------------
  // Distinct from the flag: nobody had to remember to raise this one, it is a
  // fact about the link graph. It is also the only signal here that identifies
  // the OTHER ticket, which is where the intervention actually lands.
  const chained = open
    .map((i) => ({ issue: i, blockers: (i.blockedBy ?? []).map((k) => byKey.get(k)).filter((b): b is IssueSnapshot => Boolean(b) && !isDone(b!)) }))
    .filter((x) => x.blockers.length > 0);
  for (const { issue, blockers } of chained.slice(0, limit)) {
    const worst = blockers.reduce((a, b) => ((daysSince(b.updated, now) ?? 0) > (daysSince(a.updated, now) ?? 0) ? b : a), blockers[0]!);
    const worstIdle = daysSince(worst.updated, now);
    const offBoard = blockers.filter((b) => !b.sprintIds.some((id) => activeIds.has(id)));
    push({
      kind: 'blocked-by-open',
      severity: worstIdle !== null && worstIdle >= staleDays ? 'act-now' : 'this-week',
      title: `${label(issue)} cannot finish until ${blockers.map((b) => b.key).join(', ')} does`,
      what:
        `This ticket is linked as blocked by ${blockers.length} open item${blockers.length === 1 ? '' : 's'}: ` +
        `${blockers.map((b) => `${b.key} (${b.status}${b.assignee ? `, ${b.assignee.displayName}` : ', unassigned'})`).join('; ')}.` +
        `${offBoard.length > 0 ? ` ${offBoard.map((b) => b.key).join(', ')} ${offBoard.length === 1 ? 'is' : 'are'} not in the active sprint at all, so nobody is scheduled to clear ${offBoard.length === 1 ? 'it' : 'them'}.` : ''}`,
      why:
        offBoard.length > 0
          ? 'Committed work that depends on uncommitted work is the most common way a sprint quietly fails: the dependency is nobody\'s priority this sprint, so it never moves.'
          : 'The dependency is in the sprint, so this is a sequencing question rather than a scheduling one - but it means two items have to land, not one.',
      action:
        offBoard.length > 0
          ? `Either pull ${offBoard.map((b) => b.key).join(', ')} into the sprint or take ${issue.key} out of it. Leaving both as they are guarantees one of them carries over.`
          : `Check the order of work: ${blockers.map((b) => b.key).join(', ')} needs to be finished first, so it should be started first.`,
      issueKeys: [issue.key, ...blockers.map((b) => b.key)],
      weight: Math.min(200, (worstIdle ?? 0) * 8),
    });
  }

  // --- 3. a blocker written in the comments that nobody flagged -------------
  const commentsCollected = open.some((i) => i.comments !== undefined);
  const silent = open
    .filter((i) => !i.flagged)
    .map((i) => ({ issue: i, signal: blockerInComments(i.comments) }))
    .filter((x): x is { issue: IssueSnapshot; signal: CommentSignal } => x.signal !== null);
  for (const { issue, signal } of silent.slice(0, limit)) {
    const age = daysSince(signal.comment.created, now);
    push({
      kind: 'blocker-in-comments',
      severity: age !== null && age >= staleDays ? 'act-now' : 'this-week',
      title: `${label(issue)} sounds blocked in its comments, but is not flagged`,
      what:
        `The latest comment${signal.comment.author ? ` (${signal.comment.author.displayName}` : ' ('}` +
        `${age === null ? '' : `, ${Math.round(age)} day${Math.round(age) === 1 ? '' : 's'} ago`}) contains “${signal.phrase}”. ` +
        `The Flagged field on this ticket is not set, so this blockage appears in no report, no board filter and no standup summary.`,
      why:
        'Teams write the truth in comments and forget the flag. Every metric on this page that counts blocked work counts the FLAG, so a blockage that lives only in a comment thread is invisible to all of them - including to whoever is deciding what to help with.',
      action:
        'Read the comment and, if it is real, ask the assignee to flag it. Two minutes of hygiene makes it visible to every filter the team already uses - and tells you whether this is one ticket or a pattern.',
      issueKeys: [issue.key],
      evidence: `“${signal.comment.body}”${signal.comment.truncated ? ' …' : ''}`,
      weight: Math.min(200, (age ?? 0) * 6),
    });
  }

  // --- 4. claimed but not moving --------------------------------------------
  const stale = open
    .filter((i) => i.statusCategory === 'In Progress' && !i.flagged)
    .map((i) => ({ issue: i, idle: daysSince(i.updated, now) }))
    .filter((x) => x.idle !== null && x.idle >= staleDays)
    .sort((a, b) => (b.idle ?? 0) - (a.idle ?? 0));
  for (const { issue, idle } of stale.slice(0, limit)) {
    push({
      kind: 'stale',
      severity: (idle ?? 0) >= staleDays * 2 ? 'act-now' : 'this-week',
      title: `${label(issue)} has been in progress for ${Math.round(idle ?? 0)} days with no change`,
      what: `Status is “${issue.status}”${issue.assignee ? `, assigned to ${issue.assignee.displayName}` : ' with no assignee'}, and nothing has been updated on it for ${Math.round(idle ?? 0)} days.`,
      why: 'Claimed-but-not-moving is the most reliable early sign of a silent blockage. Nobody raises it, because from the inside it feels like something they are about to get back to.',
      action: 'Ask directly what it is waiting on rather than waiting for standup - the answer is almost always a dependency, a decision or a question nobody chased.',
      issueKeys: [issue.key],
      weight: Math.min(200, (idle ?? 0) * 5),
    });
  }

  // --- 5. past its due date --------------------------------------------------
  const overdue = open
    .filter((i) => i.dueDate)
    .map((i) => ({ issue: i, over: daysSince(i.dueDate, now) }))
    .filter((x) => x.over !== null && x.over > 0)
    .sort((a, b) => (b.over ?? 0) - (a.over ?? 0));
  for (const { issue, over } of overdue.slice(0, limit)) {
    push({
      kind: 'overdue',
      severity: (over ?? 0) >= 7 ? 'act-now' : 'this-week',
      title: `${label(issue)} passed its due date ${Math.round(over ?? 0)} days ago`,
      what: `Due ${issue.dueDate?.slice(0, 10)}, still ${issue.status}.`,
      why: 'A due date on a Jira ticket is usually a promise made to somebody outside the team, and it is the one kind of slip that reaches a customer or a regulator before it reaches a report.',
      action: 'Find out who was promised this and re-set the expectation now, while there is still a conversation to have rather than an apology to make.',
      issueKeys: [issue.key],
      weight: Math.min(250, (over ?? 0) * 8),
    });
  }

  // --- 5b. an active sprint that is past its own end date -------------------
  //
  // The outlook panel already PRINTS this ("9.3 days overdue") and that was not
  // enough: interventions.ts read no sprint dates at all, so the one place a
  // manager looks first never mentioned it. Found live on 2026-08-27 - board
  // 705's sprint 5942 `Vulnerabilities` ended 2026-08-17 and was still active
  // ten days later, while the other five sprints on that board end 2026-08-31.
  //
  // GOTCHA: this is per SPRINT, not per team, and that is the point. The outlook
  // panel takes the EARLIEST end date across concurrent active sprints and
  // renders it beside the aggregate name "6 concurrent sprints", so a reader
  // cannot tell whether one is overdue or all six are. An intervention that said
  // "this team's sprint is overdue" would repeat that ambiguity in the one place
  // it is least recoverable - a forwarded alert with no page to scroll.
  const overdueSprints = active
    .map((s) => ({ sprint: s, over: daysSince(s.endDate, now) }))
    .filter((x): x is { sprint: typeof x.sprint; over: number } => x.over !== null && x.over > 0)
    .sort((a, b) => b.over - a.over);
  // Indexed once, outside the loop: `issues.filter(...)` per overdue sprint is
  // another full board scan each time, and a board can have six active sprints.
  // Built only when there is something to look up - an empty Map rather than a
  // null, so the loop body needs no non-null assertion that a later edit could
  // quietly invalidate.
  const bySprint: Map<number, IssueSnapshot[]> =
    overdueSprints.length > 0 ? issuesBySprint(team.issues) : new Map();
  for (const { sprint, over } of overdueSprints.slice(0, limit)) {
    const stillOpen = (bySprint.get(sprint.id) ?? []).filter((i) => !isDone(i));
    const others = active.filter((s) => s.id !== sprint.id);
    push({
      kind: 'sprint-overdue',
      // Three days rather than one: a sprint that ended yesterday and closes at
      // this morning's ceremony is normal, and an alert that fires on every
      // sprint boundary is an alert that gets muted.
      severity: over >= 3 ? 'act-now' : 'this-week',
      title: `Sprint “${sprint.name}” ended ${Math.round(over)} days ago and is still open`,
      what:
        `${sprint.name} has an end date of ${sprint.endDate?.slice(0, 10)} and Jira still reports it as active, ` +
        `${over.toFixed(1)} days later, with ${stillOpen.length} item${stillOpen.length === 1 ? '' : 's'} still open in it` +
        `${others.length > 0 ? `. ${others.length} other sprint${others.length === 1 ? '' : 's'} on this board ${others.length === 1 ? 'is' : 'are'} also active, and ${others.length === 1 ? 'it is' : 'they are'} not overdue` : ''}.`,
      why:
        'A sprint left open past its end date stops being a sprint: nothing closes it, so its velocity never lands in the ' +
        'history every forecast on this page is calibrated from, and its unfinished work is never counted as carryover. ' +
        'The team looks steadier than it is, in both directions.',
      action:
        `Close ${sprint.name} and move what is unfinished into the next sprint, or set a new end date and say why. ` +
        'Either is honest; leaving it open means no sprint on this board has a boundary any more.',
      issueKeys: stillOpen.slice(0, 10).map((i) => i.key),
      // The SPRINT is the identity, for the same reason this finding is emitted
      // per sprint rather than per team: a board can run several concurrent
      // sprints, and keying on the tickets still open in one of them makes the
      // finding look new every time somebody closes a ticket in it - which is
      // the one thing that is definitely NOT news about an overdue sprint.
      identityKey: `sprint-${sprint.id}`,
      weight: Math.min(250, over * 8),
    });
  }

  // --- 6. team-level: too much in one person's hands ------------------------
  const overloaded = new Set(input.wip.overloaded);
  for (const person of input.wip.perPerson.filter((p) => overloaded.has(p.name)).slice(0, 4)) {
    push({
      kind: 'wip-overload',
      severity: 'watch',
      title: `${person.name} has ${person.inProgress} items in progress at once`,
      what: `${person.inProgress} tickets (${person.keys.slice(0, 6).join(', ')}${person.keys.length > 6 ? ', …' : ''}) are all in an In Progress status against the same person.`,
      why: 'Parallel work does not finish faster; it finishes later, all at once, at the end of the sprint - which is exactly the shape of a sprint that carries over.',
      action: 'Ask which one they intend to finish first, and agree that the others go back to the To Do column until it lands. This is a two-minute conversation that moves a carryover figure.',
      issueKeys: person.keys,
      // The PERSON is what this finding is about, so the person is its identity.
      // Without it the identity falls back to the first three sorted issue keys,
      // and those churn while the finding does not: one ticket leaving the
      // in-progress list and another joining it reports the same person, still
      // overloaded, as one finding CLEARED and one NEW. The key cap does not
      // help - the churn is inside the first three keys, not in the tail.
      identityKey: person.name,
      weight: person.inProgress * 5,
    });
  }

  // --- 7. team-level: nobody owns committed work ----------------------------
  const unassigned = open.filter((i) => !i.assignee);
  if (unassigned.length >= 3) {
    push({
      kind: 'unassigned',
      severity: 'this-week',
      title: `${unassigned.length} items in the sprint have no owner`,
      what: `${unassigned.length} of ${open.length} open items in the active sprint are unassigned (${unassigned.slice(0, 6).map((i) => i.key).join(', ')}${unassigned.length > 6 ? ', …' : ''}).`,
      why: 'Committed work with no owner is usually work nobody has started. It counts fully towards the commitment and delivers nothing until somebody picks it up.',
      action: 'Assign them at the next standup, or take them out of the sprint. Either is honest; leaving them in makes the commitment look larger than the plan.',
      issueKeys: unassigned.map((i) => i.key),
      // One per team, so the team IS the identity - and it has to be stated,
      // because this finding names every unowned ticket in the sprint and those
      // keys move constantly. Without it, one ticket being assigned while another
      // arrives in the first three sorted keys reports the finding as cleared and
      // a new one appearing, when the count actually went up by one.
      identityKey: 'team',
      weight: unassigned.length * 3,
    });
  }

  // --- 8. team-level: the sprint has no goal --------------------------------
  const goalless = active.filter((s) => !s.goal);
  if (active.length > 0 && goalless.length === active.length) {
    push({
      kind: 'no-goal',
      severity: 'watch',
      title: `The active sprint has no goal`,
      what: `${goalless.map((s) => `“${s.name}”`).join(', ')} ${goalless.length === 1 ? 'has' : 'have'} no sprint goal set in Jira.`,
      why: 'Without a goal there is nothing to say the sprint succeeded or failed against, so the only available verdict is "did we finish all the tickets" - which no sprint ever does, and which trains everyone to ignore the answer.',
      action: 'Ask the team to write one sentence at planning. It is the cheapest change on this page and it is the one that makes every other number on it interpretable.',
      issueKeys: [],
    });
  }

  // --- 9. team-level: committed above anything ever delivered ---------------
  const p90 = input.trends.pointsForecast.p90;
  const o = input.outlook;
  if (o && !o.unreliableReason && p90 !== null && o.committedPoints > p90) {
    push({
      kind: 'over-committed',
      severity: o.verdict === 'will-not-land' ? 'act-now' : 'this-week',
      title: `This sprint is carrying ${o.committedPoints} points against a best-ever ${p90.toFixed(0)}`,
      what:
        `${o.committedPoints} committed points is above this team's own p90 of ${p90.toFixed(1)} over its last ${input.trends.pointsForecast.basis} productive sprints` +
        `${o.paceRatio !== null && o.paceRatio > 1 ? `, and the remaining work needs ${o.paceRatio.toFixed(1)}× the pace it normally goes` : ''}.`,
      why: 'Committing above the p90 is not a stretch goal. On this team\'s own evidence it is a decision to carry work over, taken at planning, before anyone has done anything wrong.',
      action: 'Cut the sprint back to the p50 now and say which items moved. Doing it in week one is a plan; doing it in week two is a miss.',
      issueKeys: [],
      weight: Math.round(((o.committedPoints - p90) / Math.max(p90, 1)) * 100),
    });
  }

  // --- 9b. a merge request nobody has reviewed, sitting open right now -------
  // Distinct from `review-gap` below: that is a rear-facing RATE over what has
  // already merged, and review is the only LEADING indicator this tool
  // produces - a merge request open for weeks with no human review is a
  // problem today, not a statistic about last month. `awaitingFirstHumanReview`
  // is already the actionable list (open, human-authored, not draft, no human
  // review yet); this only decides which of it is worth naming a manager today.
  const stalledReview = (input.review?.awaitingFirstHumanReview ?? []).filter((mr) => mr.openHours >= 48);
  for (const mr of stalledReview.slice(0, limit)) {
    const days = mr.openHours / 24;
    push({
      kind: 'review-stalled',
      severity: mr.openHours >= 168 ? 'act-now' : 'this-week',
      title: `${mr.projectPath ? `${mr.projectPath}: ` : ''}“${mr.title}” has waited ${days.toFixed(1)} days for its first human review`,
      what: `Opened ${days.toFixed(1)} days ago; nobody but the automated reviewer has commented or approved it since. ${mr.webUrl}`,
      why: 'A merge request nobody has looked at is not merely slow - it is work that cannot land, cannot be corrected, and is quietly diverging from everything merged around it while it waits.',
      action: 'Ask the assigned reviewer directly, or reassign it. A merge request stalled this long usually means the reviewer does not know it is waiting, not that they are ignoring it.',
      issueKeys: [],
      evidence: mr.webUrl,
      identityKey: mr.webUrl,
      weight: Math.min(200, days * 8),
    });
  }

  // --- 10. team-level: review practice --------------------------------------
  const r = input.review;
  if (r && r.mergedKnown > 0) {
    const rate = r.mergedWithoutHumanReview / r.mergedKnown;
    if (rate >= 0.4) {
      push({
        kind: 'review-gap',
        severity: 'this-week',
        title: `${Math.round(rate * 100)}% of this team's merged work had no human review`,
        what: `${r.mergedWithoutHumanReview} of ${r.mergedKnown} merge requests a person opened merged with no comment and no approval from anybody but their author. Automation-authored merge requests are excluded from both figures.`,
        why: 'Unreviewed merges are the one quality signal here that leads rather than lags - it shows up in defects and in bus-factor months before it shows up in velocity.',
        action: 'Name the two or three people the number actually comes from (the review-practice table below) and pair them with somebody who already reviews. A team-wide policy announcement changes nothing; a specific pairing does.',
        issueKeys: [],
        weight: Math.round(rate * 100),
      });
    }
    // The approval->merge split is what separates a reviewer-availability
    // problem from a process one, and no amount of reviewer training touches
    // the second. Measured live: fcp sat at a p50 of 182 hours here.
    const approvalLag = r.hoursApprovalToMergeP50;
    if (approvalLag !== null && approvalLag >= 48) {
      push({
        kind: 'merge-lag',
        severity: 'this-week',
        title: `Work sits ${Math.round(approvalLag)} hours after a human approves it`,
        what: `Median human approval → merged is ${approvalLag.toFixed(1)} hours${r.hoursOpenToMergeP50 !== null ? `, against a median open → merged of ${r.hoursOpenToMergeP50.toFixed(1)} hours` : ''}.`,
        why: 'This delay is AFTER sign-off, so it is not waiting for a reviewer. It is a process or permissions problem - a release train, a protected branch nobody can merge to, or a step nobody owns - and reviewer training cannot touch it.',
        action: 'Ask the team what happens between approval and merge. The answer is usually one gate, and it is usually removable.',
        issueKeys: [],
        weight: Math.round(approvalLag),
      });
    }
  }

  // --- 11. team-level: scope moving under the sprint ------------------------
  const churn = input.churn;
  if (churn && churn.observations > 0 && churn.netPoints !== 0) {
    const growing = churn.netPoints > 0;
    if (Math.abs(churn.netPoints) >= 8) {
      push({
        kind: 'scope-churn',
        severity: growing ? 'this-week' : 'watch',
        title: `The sprint ${growing ? 'grew' : 'shrank'} by ${Math.abs(churn.netPoints)} points after it started`,
        what:
          `Across ${churn.observations} observed day${churn.observations === 1 ? '' : 's'}: +${churn.addedPoints} added, -${churn.removedPoints} removed, ` +
          `${churn.reestimatedPoints >= 0 ? '+' : ''}${churn.reestimatedPoints} from re-estimation.`,
        why: growing
          ? 'Scope added after planning is the difference between a team that missed its commitment and a team whose commitment was changed underneath it. Only one of those is a delivery problem, and the burndown alone cannot tell them apart.'
          : 'Work leaving a sprint mid-flight is sometimes good triage and sometimes a quiet retreat. Which it was is worth knowing before the retrospective decides.',
        action: growing
          ? 'At the retrospective, show what was added and ask who agreed to it. The point is not to refuse mid-sprint work - it is to make the trade visible when it is made.'
          : 'Check whether the removed items went back to the backlog or simply vanished from the plan.',
        issueKeys: [],
        weight: Math.abs(churn.netPoints),
      });
    }
  }

  // --- 12. the comment scan itself did not run ------------------------------
  if (!commentsCollected && open.length > 0) {
    push({
      kind: 'comments-not-collected',
      severity: 'watch',
      title: 'Comment threads were not collected for this snapshot',
      what: 'No open item in the active sprint carries comment data, so the "blocked in the comments but never flagged" scan could not run.',
      why: 'That scan finds the blockages nobody remembered to flag, which on most boards outnumber the flagged ones. Its absence is a gap in coverage, not a clean result.',
      action: 'Re-run collect (comment detail is on by default from schema 4). Until then, treat the blocked count on this page as flagged-only.',
      issueKeys: [],
    });
  }

  return out.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
}

/** The whole estate's interventions for the front page, worst first but ROUND
 *  ROBIN across teams.
 *
 *  GOTCHA: a straight sort by weight is the obvious implementation and it is
 *  wrong for this page. Measured on the 2026-08-26 snapshot, a straight sort
 *  produced a top fifteen in which eight entries were the same kind of finding
 *  from the same team - `fs` happens to have a lot of long-idle tickets - and a
 *  reader scanning it would conclude that three of the four teams had nothing
 *  wrong. The front page's job is "where across the estate do I need to look",
 *  and one team's tail must not be able to answer it. Each team's own tab still
 *  shows its full list in pure weight order.
 *
 *  Within a round the strongest remaining item from each team is taken, so the
 *  first N entries are still the worst thing on each board rather than an
 *  arbitrary sample. */
export function rankInterventions(all: Intervention[], limit: number): Intervention[] {
  const byTeam = new Map<string, Intervention[]>();
  for (const i of [...all].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))) {
    const list = byTeam.get(i.team) ?? [];
    list.push(i);
    byTeam.set(i.team, list);
  }
  // Teams whose worst item is worst overall go first inside each round, so the
  // single most urgent thing in the estate is still the first card.
  const queues = [...byTeam.values()].sort((a, b) => (b[0]?.weight ?? 0) - (a[0]?.weight ?? 0));

  const out: Intervention[] = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const q of queues) {
      const next = q[round];
      if (!next) continue;
      out.push(next);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  return out;
}
