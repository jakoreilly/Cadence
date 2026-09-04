import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botAccountSet, deriveReviewSignals, isAutomation } from '../src/gitlab/collect.js';
import { firstHumanTouchAt, hadHumanReview, humanAuthored, reviewMetrics } from '../src/review.js';
import { mergeCertificates } from '../src/tls.js';
import { formatGroups } from '../src/gitlab/discover.js';
import type { MergeRequestSnapshot, ReviewSignals } from '../src/types.js';

// Every shape here was observed live on gitlab.example.com (GitLab 18.11.7),
// not invented - the note payloads in particular.

const BOTS = botAccountSet(['SonarQube']);

function note(over: Record<string, unknown>): any {
  return { system: false, author: { username: 'nia.barrett' }, created_at: '2026-08-25T10:00:00.000Z', body: '', ...over };
}

// --- automation identification ----------------------------------------------

test('isAutomation matches case-insensitively', () => {
  // GitLab usernames are case-preserving but not case-sensitive, and the config
  // file gets "sonarqube" typed into it.
  assert.equal(isAutomation('SonarQube', BOTS), true);
  assert.equal(isAutomation('sonarqube', BOTS), true);
  assert.equal(isAutomation('nia.barrett', BOTS), false);
  assert.equal(isAutomation(undefined, BOTS), false);
});

test('isAutomation cannot fall back to the GitLab bot flag', () => {
  // Regression guard for the live finding: `bot` is undefined on every note
  // author this instance returns, including the automated reviewer. If someone
  // "simplifies" isAutomation into a check on author.bot, this fails.
  assert.equal(isAutomation('SonarQube', botAccountSet([])), false);
});


test('isAutomation matches the DISPLAY NAME as well as the username', () => {
  // The live failure this guards: the automation account on this instance is
  // username "bot", display name "I'm a Bot", and reviewBotAccounts was
  // maintained from the GitLab UI - so it listed "I'm a Bot". A username-only
  // match classified it as a person, and it authored 28 merge requests in the
  // onboarding-hub group. GitLab's own bot flag is false on the account, so nothing in
  // the API catches this.
  const bots = botAccountSet(["I'm a Bot"]);
  assert.equal(isAutomation('bot', bots, "I'm a Bot"), true, 'display name must match');
  assert.equal(isAutomation('bot', bots), false, 'username alone genuinely does not match');
  assert.equal(isAutomation('bot', botAccountSet(['bot']), 'Nia Barrett'), true, 'username still matches');
  // A person is never swept up by either half.
  assert.equal(isAutomation('nia.barrett', bots, 'Nia Barrett'), false);
  assert.equal(isAutomation(undefined, bots, undefined), false);
});
// --- note classification ----------------------------------------------------

test('system notes are not review', () => {
  // Observed: "assigned to @bruno.alves", "marked this merge request as
  // draft", "added 1 commit". These outnumber real comments roughly 3:1.
  const notes = [
    note({ system: true, body: 'assigned to @bruno.alves' }),
    note({ system: true, body: 'marked this merge request as **draft**' }),
    note({ system: true, body: 'added 1 commit' }),
  ];
  const s = deriveReviewSignals(notes, null, 'bruno.alves', 0, BOTS, true);
  assert.equal(s.humanCommentCount, 0);
  assert.equal(s.firstHumanCommentAt, undefined);
});

test('the automated reviewer is not counted as a human reviewer', () => {
  // The whole point. Observed live: SonarQube posted 49 of 94 non-system
  // comments and comments within ~8 minutes of opening.
  const notes = [
    note({ author: { username: 'SonarQube' }, created_at: '2026-08-26T12:38:16.901Z', body: 'Automated Code Review' }),
    note({ author: { username: 'nia.barrett' }, created_at: '2026-08-26T14:00:00.000Z', body: 'real comment' }),
  ];
  const s = deriveReviewSignals(notes, null, 'bruno.alves', 0, BOTS, true);
  assert.equal(s.automatedCommentCount, 1);
  assert.equal(s.humanCommentCount, 1);
  assert.equal(s.firstAutomatedCommentAt, '2026-08-26T12:38:16.901Z');
  assert.equal(s.firstHumanCommentAt, '2026-08-26T14:00:00.000Z');
});

test('the author commenting on their own merge request is not review', () => {
  const notes = [note({ author: { username: 'nia.barrett' }, body: 'self note' })];
  const s = deriveReviewSignals(notes, null, 'nia.barrett', 0, BOTS, true);
  assert.equal(s.authorCommentCount, 1);
  assert.equal(s.humanCommentCount, 0);
});

test('"first" means earliest timestamp, not first element', () => {
  // An edited note can come back out of order despite sort=asc.
  const notes = [
    note({ created_at: '2026-08-25T15:00:00.000Z' }),
    note({ created_at: '2026-08-25T09:00:00.000Z' }),
  ];
  const s = deriveReviewSignals(notes, null, 'someone.else', 0, BOTS, true);
  assert.equal(s.firstHumanCommentAt, '2026-08-25T09:00:00.000Z');
});

// --- approvals --------------------------------------------------------------

test('approved_by nests the user one level down', () => {
  // Live shape: { approved_by: [ { user: { username: ... } } ] }. Reading
  // entry.username instead gives undefined, which classifies every approval -
  // including the bot's - as human.
  const approvals = { approved_by: [{ user: { id: 7, username: 'SonarQube', name: 'SonarQube' } }] };
  const s = deriveReviewSignals([], approvals, 'nia.barrett', 0, BOTS, true);
  assert.equal(s.automatedApprovalCount, 1);
  assert.equal(s.humanApprovalCount, 0);
});

test('approval counts survive individualAttribution being off', () => {
  // "Was this approved by a person" is a team-level fact; "which person" is not.
  // If the metric read humanApprovals.length, turning attribution off would
  // silently report that nothing is ever reviewed.
  const approvals = { approved_by: [{ user: { id: 3, username: 'priya', name: 'Priya Raman' } }] };
  const s = deriveReviewSignals([], approvals, 'nia.barrett', 0, BOTS, false);
  assert.equal(s.humanApprovalCount, 1);
  assert.deepEqual(s.humanApprovals, []);
  assert.equal(hadHumanReview({ review: s } as MergeRequestSnapshot), true);
});

test('approval time comes from the system note, since approved_by has none', () => {
  const notes = [note({ system: true, author: { username: 'priya' }, created_at: '2026-08-26T11:00:00.000Z', body: 'approved this merge request' })];
  const approvals = { approved_by: [{ user: { id: 3, username: 'priya' } }] };
  const s = deriveReviewSignals(notes, approvals, 'nia.barrett', 0, BOTS, true);
  assert.equal(s.firstHumanApprovalAt, '2026-08-26T11:00:00.000Z');
});

test('the merge request author is classified as automation when it is a bot', () => {
  const s = deriveReviewSignals([], null, 'SonarQube', 0, BOTS, true);
  assert.equal(s.authorIsAutomation, true);
});

// --- unknown vs unreviewed --------------------------------------------------

function mr(over: Partial<MergeRequestSnapshot>): MergeRequestSnapshot {
  return {
    id: 1, iid: 1, projectId: 1, title: 't', state: 'merged', draft: false,
    createdAt: '2026-08-25T09:00:00.000Z', updatedAt: '2026-08-26T09:00:00.000Z',
    mergedAt: '2026-08-26T09:00:00.000Z', sourceBranch: 'b', targetBranch: 'main',
    assignees: [], reviewers: [], issueKeys: [], webUrl: '', ...over,
  };
}

function signals(over: Partial<ReviewSignals> = {}): ReviewSignals {
  return {
    authorIsAutomation: false, humanCommentCount: 0, automatedCommentCount: 0, authorCommentCount: 0,
    humanCommenters: [], humanApprovalCount: 0, automatedApprovalCount: 0, humanApprovals: [],
    automatedApprovals: [], reviewerCount: 0, ...over,
  };
}

test('a merge request with no review detail is UNKNOWN, not unreviewed', () => {
  assert.equal(hadHumanReview(mr({})), null);
});

test('a merge request whose review detail failed is UNKNOWN, not unreviewed', () => {
  assert.equal(hadHumanReview(mr({ review: signals({ error: 'GitLab API failed: 403' }) })), null);
});

test('an error after a comment was already read still counts as reviewed', () => {
  assert.equal(hadHumanReview(mr({ review: signals({ humanCommentCount: 1, error: 'page 2 failed' }) })), true);
});

test('firstHumanTouchAt takes the earlier of comment and approval', () => {
  const m = mr({
    review: signals({
      firstHumanCommentAt: '2026-08-26T12:00:00.000Z',
      firstHumanApprovalAt: '2026-08-26T10:00:00.000Z',
      humanApprovalCount: 1,
    }),
  });
  assert.equal(firstHumanTouchAt(m), '2026-08-26T10:00:00.000Z');
});

// The approval note outlives the approval: a push that resets approvals, or an
// approval a person removed, leaves "approved this merge request" in the system
// notes while the approvals endpoint reports none. Observed live on the
// 2026-08-28 snapshot (payments-core/csp/android/mobile-app!76), where it put the
// same merge request in "awaiting first human review" AND in the human-review
// latency basis.
test('an approval note with no standing approval supplies no human-review time', () => {
  const m = mr({ review: signals({ firstHumanApprovalAt: '2026-08-26T10:00:00.000Z', humanApprovalCount: 0 }) });
  assert.equal(firstHumanTouchAt(m), undefined);
  assert.equal(hadHumanReview(m), false);
});

test('a withdrawn approval is not an approval-to-merge lag either', () => {
  const m = reviewMetrics(
    {
      key: 'fs',
      groups: ['payments-core'],
      mergeRequests: [mr({ review: signals({ firstHumanApprovalAt: '2026-08-25T10:00:00.000Z', humanApprovalCount: 0 }) })],
    },
    '2026-08-26T09:00:00.000Z',
  );
  assert.equal(m.hoursApprovalToMergeBasis, 0);
  assert.equal(m.mergedWithoutHumanReview, 1);
});

// --- the denominator --------------------------------------------------------

test('humanAuthored excludes bot-opened merge requests but keeps unknown ones', () => {
  const list = [
    mr({ id: 1, review: signals({ authorIsAutomation: true }) }),
    mr({ id: 2, review: signals({ authorIsAutomation: false }) }),
    mr({ id: 3 }), // no review detail - cannot be proven automation, so kept
  ];
  assert.deepEqual(humanAuthored(list).map((m) => m.id), [2, 3]);
});

test('review rates exclude bot-authored merge requests from the denominator', () => {
  // The live regression this guards: including bot-authored merge requests
  // reported 248 of 460 merged unreviewed (54%); excluding them reported
  // 27 of 225 (12%). Same data, and only one of the two describes the team.
  const botMerges = Array.from({ length: 8 }, (_, i) =>
    mr({ id: 100 + i, review: signals({ authorIsAutomation: true }) }));
  const humanReviewedMerge = mr({ id: 1, review: signals({ humanCommentCount: 2 }) });
  const humanUnreviewedMerge = mr({ id: 2, review: signals({}) });

  const m = reviewMetrics(
    { key: 't', groups: ['g'], mergeRequests: [...botMerges, humanReviewedMerge, humanUnreviewedMerge] },
    '2026-08-26T12:00:00.000Z',
  );

  assert.equal(m.totalMergeRequests, 10);
  assert.equal(m.automationAuthored, 8);
  assert.equal(m.humanAuthoredTotal, 2);
  assert.equal(m.mergedKnown, 2);
  // 1 of 2, not 9 of 10.
  assert.equal(m.mergedWithoutHumanReview, 1);
});

test('unknown merge requests stay out of the rate denominators entirely', () => {
  const m = reviewMetrics(
    { key: 't', groups: [], mergeRequests: [mr({ id: 1 }), mr({ id: 2, review: signals({ humanCommentCount: 1 }) })] },
    '2026-08-26T12:00:00.000Z',
  );
  assert.equal(m.humanAuthoredTotal, 2);
  assert.equal(m.reviewDetailKnown, 1);
  assert.equal(m.mergedKnown, 1);
  assert.equal(m.mergedWithoutHumanReview, 0);
});

test('the awaiting-review list is open, non-draft, human-authored work only', () => {
  const m = reviewMetrics(
    {
      key: 't', groups: [],
      mergeRequests: [
        mr({ id: 1, state: 'opened', mergedAt: undefined, review: signals({}) }),
        mr({ id: 2, state: 'opened', mergedAt: undefined, draft: true, review: signals({}) }),
        mr({ id: 3, state: 'opened', mergedAt: undefined, review: signals({ humanCommentCount: 1 }) }),
        mr({ id: 4, state: 'opened', mergedAt: undefined, review: signals({ authorIsAutomation: true }) }),
      ],
    },
    '2026-08-26T09:00:00.000Z',
  );
  assert.equal(m.awaitingFirstHumanReview.length, 1);
  assert.equal(m.awaitingFirstHumanReview[0]?.openHours, 24);
});

// --- tls --------------------------------------------------------------------

test('mergeCertificates unions without duplicating across line endings', () => {
  // The Windows store returns CRLF, Node's bundle LF. A naive union installs
  // ~140 duplicate roots on every run.
  const a = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
  const b = '-----BEGIN CERTIFICATE-----\r\nAAA\r\n-----END CERTIFICATE-----\r\n';
  const c = '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n';
  assert.deepEqual(mergeCertificates([a], [b, c]), [a, c]);
});

// --- group discovery --------------------------------------------------------

test('formatGroups lists groups the token owner is NOT a member of', () => {
  // The regression that produced a whole wrong report: filtering the listing to
  // groups the user belongs to hid web-storefront, which is where board
  // 701 actually works. Non-membership must be a marker, never a filter.
  const out = formatGroups(
    [
      { id: 687, fullPath: 'web-storefront', name: 'WEB', parentId: null, webUrl: '', isMember: false, recentMergeRequests: { count: 100, atLeast: true } },
      { id: 50, fullPath: 'logistics-hub', name: 'PT', parentId: null, webUrl: '', isMember: true, recentMergeRequests: { count: 48, atLeast: false } },
    ],
    30,
  );
  assert.match(out, /web-storefront/);
  assert.match(out, /\* web-storefront/);
});

test('formatGroups drops groups with no merge requests in the window', () => {
  // The unfiltered listing runs to hundreds on a self-managed instance; a
  // dormant group is not a team and burying the active ones costs the answer.
  const out = formatGroups(
    [
      { id: 1, fullPath: 'dormant', name: 'd', parentId: null, webUrl: '', isMember: true, recentMergeRequests: { count: 0, atLeast: false } },
      { id: 2, fullPath: 'active', name: 'a', parentId: null, webUrl: '', isMember: true, recentMergeRequests: { count: 5, atLeast: false } },
    ],
    30,
  );
  assert.doesNotMatch(out, /dormant/);
  assert.match(out, /active/);
});


// --- approval -> merge latency -------------------------------------------------

test('approval-to-merge separates a review-capacity problem from a process one', () => {
  // Two merge requests, identical open->merge time. One waited for a reviewer;
  // the other was signed off immediately and then sat. The headline unreviewed
  // rate cannot tell them apart and no amount of reviewer training fixes the
  // second.
  const waited = mr({
    createdAt: '2026-08-01T00:00:00.000Z',
    mergedAt: '2026-08-11T00:00:00.000Z',
    state: 'merged',
    review: signals({ humanApprovalCount: 1, firstHumanApprovalAt: '2026-08-10T00:00:00.000Z' }),
  });
  const sat = mr({
    createdAt: '2026-08-01T00:00:00.000Z',
    mergedAt: '2026-08-11T00:00:00.000Z',
    state: 'merged',
    review: signals({ humanApprovalCount: 1, firstHumanApprovalAt: '2026-08-02T00:00:00.000Z' }),
  });

  const one = reviewMetrics({ key: 't', groups: [], mergeRequests: [waited] }, '2026-08-12T00:00:00.000Z');
  const two = reviewMetrics({ key: 't', groups: [], mergeRequests: [sat] }, '2026-08-12T00:00:00.000Z');
  assert.equal(one.hoursOpenToMergeP50, two.hoursOpenToMergeP50);
  assert.equal(one.hoursApprovalToMergeP50, 24);
  assert.equal(two.hoursApprovalToMergeP50, 24 * 9);
});

test('an approval recorded after the merge is counted, not folded into the median', () => {
  // Somebody approving a change that is already in records as review having
  // happened on a merge that went in unreviewed. A negative interval must not
  // quietly pull the median down.
  const m = mr({
    createdAt: '2026-08-01T00:00:00.000Z',
    mergedAt: '2026-08-02T00:00:00.000Z',
    state: 'merged',
    review: signals({ humanApprovalCount: 1, firstHumanApprovalAt: '2026-08-03T00:00:00.000Z' }),
  });
  const metrics = reviewMetrics({ key: 't', groups: [], mergeRequests: [m] }, '2026-08-12T00:00:00.000Z');
  assert.equal(metrics.approvedAfterMerge, 1);
  assert.equal(metrics.hoursApprovalToMergeBasis, 0);
  assert.equal(metrics.hoursApprovalToMergeP50, null);
});

test('a merge request nobody approved contributes no approval latency at all', () => {
  const m = mr({
    createdAt: '2026-08-01T00:00:00.000Z',
    mergedAt: '2026-08-02T00:00:00.000Z',
    state: 'merged',
    review: signals({ humanCommentCount: 1, firstHumanCommentAt: '2026-08-01T06:00:00.000Z' }),
  });
  const metrics = reviewMetrics({ key: 't', groups: [], mergeRequests: [m] }, '2026-08-12T00:00:00.000Z');
  assert.equal(metrics.hoursApprovalToMergeBasis, 0);
  assert.equal(metrics.approvedAfterMerge, 0);
});
