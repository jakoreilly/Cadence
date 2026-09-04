import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botAccountSet } from '../src/gitlab/collect.js';
import {
  deriveGithubReviewSignals,
  isGithubAutomation,
  normaliseGithubPr,
  parseNextLink,
} from '../src/github/collect.js';
import { hadHumanReview, humanAuthored } from '../src/review.js';

// Payload shapes follow the GitHub REST API (pulls, pulls/{n}/reviews,
// issues/{n}/comments) as documented for api-version 2022-11-28.

const BOTS = botAccountSet(['SonarQube', 'ci-bot']);

// --- automation identification --------------------------------------------------

test('isGithubAutomation uses type, the [bot] suffix, AND the configured list', () => {
  assert.equal(isGithubAutomation({ login: 'dependabot[bot]', type: 'Bot' }, botAccountSet([])), true, 'type Bot');
  assert.equal(isGithubAutomation({ login: 'renovate[bot]', type: 'User' }, botAccountSet([])), true, '[bot] suffix');
  assert.equal(isGithubAutomation({ login: 'ci-bot', type: 'User' }, BOTS), true, 'configured service account');
  assert.equal(isGithubAutomation({ login: 'CI-BOT', type: 'User' }, BOTS), true, 'match is case-insensitive');
  assert.equal(isGithubAutomation({ login: 'nia', type: 'User', name: 'Nia Barrett' }, BOTS), false, 'a person');
  assert.equal(isGithubAutomation(null, BOTS), false);
});

// --- PR normalisation ---------------------------------------------------------

const RAW_PR = {
  id: 900123,
  number: 42,
  title: 'WEB-1387 add tariff endpoint',
  state: 'closed',
  draft: false,
  created_at: '2026-08-20T09:00:00Z',
  updated_at: '2026-08-22T14:00:00Z',
  merged_at: '2026-08-22T14:00:00Z',
  closed_at: '2026-08-22T14:00:00Z',
  html_url: 'https://github.com/acme/web-storefront/pull/42',
  user: { id: 1, login: 'rosa', name: 'Rosa D Amico', type: 'User' },
  assignees: [{ id: 1, login: 'rosa', name: 'Rosa D Amico' }],
  requested_reviewers: [{ id: 2, login: 'andre', name: 'Andre Lima' }],
  head: { ref: 'feature/WEB-1387-tariff' },
  base: { ref: 'main', repo: { id: 55, full_name: 'acme/web-storefront' } },
  comments: 3,
};

test('normaliseGithubPr maps a merged PR onto the GitLab-style snapshot shape', () => {
  const mr = normaliseGithubPr(RAW_PR, true, new Set(['WEB']));
  assert.equal(mr.id, 900123);
  assert.equal(mr.iid, 42);
  assert.equal(mr.projectId, 55);
  assert.equal(mr.projectPath, 'acme/web-storefront');
  // review.ts filters on state === 'merged' | 'opened' | 'closed'; a GitHub PR
  // with merged_at set must read as 'merged', not 'closed'.
  assert.equal(mr.state, 'merged');
  assert.equal(mr.mergedAt, '2026-08-22T14:00:00Z');
  assert.equal(mr.sourceBranch, 'feature/WEB-1387-tariff');
  assert.equal(mr.targetBranch, 'main');
  assert.equal(mr.webUrl, 'https://github.com/acme/web-storefront/pull/42');
  assert.deepEqual(mr.issueKeys, ['WEB-1387']);
  assert.equal(mr.author?.displayName, 'Rosa D Amico');
  assert.equal(mr.reviewers[0]?.displayName, 'Andre Lima');
});

test('normaliseGithubPr distinguishes an open PR from a closed-unmerged one', () => {
  assert.equal(normaliseGithubPr({ ...RAW_PR, state: 'open', merged_at: null }, false).state, 'opened');
  assert.equal(normaliseGithubPr({ ...RAW_PR, state: 'closed', merged_at: null }, false).state, 'closed');
});

test('normaliseGithubPr drops person fields when attribution is off', () => {
  const mr = normaliseGithubPr(RAW_PR, false);
  assert.equal(mr.author, undefined);
  assert.equal(mr.reviewers.length, 0);
});

test('a version-shaped token in a title is not taken as an issue key without a known-keys filter match', () => {
  const mr = normaliseGithubPr({ ...RAW_PR, title: 'bump to V2-3', head: { ref: 'chore/bump' } }, false, new Set(['WEB']));
  assert.deepEqual(mr.issueKeys, []);
});

// --- review signal derivation -----------------------------------------------

const PERSON = (login: string) => ({ id: login.length, login, name: login.toUpperCase(), type: 'User' });

test('an approval by a person and a comment by the bot are classified apart', () => {
  const reviews = [
    { user: PERSON('andre'), state: 'APPROVED', submitted_at: '2026-08-21T10:00:00Z', body: '' },
    { user: { login: 'sonarqube', type: 'User' }, state: 'COMMENTED', submitted_at: '2026-08-20T09:05:00Z', body: 'Quality gate passed' },
  ];
  const comments = [
    { user: { login: 'sonarqube', type: 'User' }, created_at: '2026-08-20T09:06:00Z', body: 'coverage 81%' },
  ];
  const s = deriveGithubReviewSignals(reviews, comments, PERSON('rosa'), 1, BOTS, true);
  assert.equal(s.authorIsAutomation, false);
  assert.equal(s.humanApprovalCount, 1);
  assert.equal(s.automatedApprovalCount, 0);
  assert.equal(s.firstHumanApprovalAt, '2026-08-21T10:00:00Z');
  assert.equal(s.humanCommentCount, 0, 'the only comments were the bot');
  assert.equal(s.automatedCommentCount, 2, 'bot review body + bot issue comment');
  assert.equal(s.humanCommenters.length, 1, 'the approver still counts as a reviewer');
  assert.equal(s.humanCommenters[0]?.displayName, 'ANDRE');
  assert.equal(s.reviewerCount, 1);
});

test('the PR author\'s own comments are never review', () => {
  const s = deriveGithubReviewSignals(
    [],
    [{ user: PERSON('rosa'), created_at: '2026-08-21T00:00:00Z', body: 'rebased' }],
    PERSON('rosa'),
    0,
    BOTS,
    true,
  );
  assert.equal(s.authorCommentCount, 1);
  assert.equal(s.humanCommentCount, 0);
  assert.equal(s.humanCommenters.length, 0);
});

test('two approvals by the same person count once, keeping the earliest time', () => {
  const reviews = [
    { user: PERSON('andre'), state: 'APPROVED', submitted_at: '2026-08-22T10:00:00Z', body: '' },
    { user: PERSON('andre'), state: 'APPROVED', submitted_at: '2026-08-21T10:00:00Z', body: 'lgtm now' },
  ];
  const s = deriveGithubReviewSignals(reviews, [], PERSON('rosa'), 1, BOTS, true);
  assert.equal(s.humanApprovalCount, 1);
  assert.equal(s.firstHumanApprovalAt, '2026-08-21T10:00:00Z');
});

test('distinct human commenters are de-duplicated across reviews and comments', () => {
  const reviews = [{ user: PERSON('andre'), state: 'CHANGES_REQUESTED', submitted_at: '2026-08-20T10:00:00Z', body: 'needs a test' }];
  const comments = [
    { user: PERSON('andre'), created_at: '2026-08-20T11:00:00Z', body: 'thanks' },
    { user: PERSON('sam'), created_at: '2026-08-20T12:00:00Z', body: 'also this' },
  ];
  const s = deriveGithubReviewSignals(reviews, comments, PERSON('rosa'), 0, BOTS, true);
  assert.equal(s.humanCommentCount, 3);
  assert.deepEqual(s.humanCommenters.map((p) => p.displayName).sort(), ['ANDRE', 'SAM']);
});

test('with attribution off the COUNTS survive but the identities do not', () => {
  const reviews = [{ user: PERSON('andre'), state: 'APPROVED', submitted_at: '2026-08-21T10:00:00Z', body: 'ok' }];
  const s = deriveGithubReviewSignals(reviews, [], PERSON('rosa'), 1, BOTS, false);
  assert.equal(s.humanApprovalCount, 1, 'was it approved by a person: still answerable');
  assert.equal(s.humanApprovals.length, 0, 'which person: not written');
  assert.equal(s.humanCommenters.length, 0);
});

test('review.ts reads GitHub-derived signals with no special-casing', () => {
  const merged = normaliseGithubPr(RAW_PR, true, new Set(['WEB']));
  merged.review = deriveGithubReviewSignals(
    [{ user: PERSON('andre'), state: 'APPROVED', submitted_at: '2026-08-21T10:00:00Z', body: 'lgtm' }],
    [],
    PERSON('rosa'),
    1,
    BOTS,
    true,
  );
  assert.equal(humanAuthored([merged]).length, 1, 'a person opened it, so it stays in the denominator');
  assert.equal(hadHumanReview(merged), true, 'a person approved it');
});

// --- Link-header pagination -------------------------------------------------

test('parseNextLink pulls the rel="next" URL and nothing else', () => {
  const link =
    '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", ' +
    '<https://api.github.com/repositories/1/pulls?page=9>; rel="last"';
  assert.equal(parseNextLink(link), 'https://api.github.com/repositories/1/pulls?page=2');
  assert.equal(parseNextLink('<https://api.github.com/x?page=9>; rel="last"'), null, 'no next on the last page');
  assert.equal(parseNextLink(null), null);
});
