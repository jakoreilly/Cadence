import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTeamMergeRequests } from '../src/gitlab/collect.js';
import type { Secrets, TeamConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// The review pass fetches several merge requests at once, and the whole reason
// that is allowed is that the SNAPSHOT does not depend on it. Snapshots are the
// product and are diffed day to day, so if completion order could reach the file
// then a slow network would look like a board that changed overnight.
//
// That is a claim, so it is tested rather than asserted in a comment. The stub
// below answers with DELIBERATELY UNEVEN latency - inverted against merge-request
// order, so the last request issued is the first to come back - which is the
// condition under which an order-sensitive implementation produces a wrong file.
// ---------------------------------------------------------------------------

const SECRETS: Secrets = {
  atlassianBaseUrl: 'https://example.atlassian.net',
  atlassianEmail: 'a@b.c',
  atlassianApiToken: 't',
  gitlabBaseUrl: 'https://git.example.local',
  gitlabToken: 'glpat-test',
};

const TEAM: TeamConfig = {
  key: 'tran', boardId: 1, enabled: true, gitlabGroups: ['logistics-hub'],
};

const MR_COUNT = 24;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rawMergeRequests(): any[] {
  return Array.from({ length: MR_COUNT }, (_, i) => ({
    id: 1000 + i,
    iid: i + 1,
    project_id: 7,
    references: { full: `logistics-hub/svc!${i + 1}` },
    title: `LOG-${5000 + i} do the thing`,
    state: i % 3 === 0 ? 'merged' : 'opened',
    created_at: `2026-08-${String((i % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
    updated_at: '2026-08-31T09:00:00.000Z',
    merged_at: i % 3 === 0 ? '2026-08-30T09:00:00.000Z' : null,
    source_branch: `feature/LOG-${5000 + i}`,
    author: { id: 50 + (i % 4), name: `Person ${i % 4}`, username: `p${i % 4}` },
    reviewers: i % 2 === 0 ? [{ id: 99, name: 'Reviewer', username: 'rev' }] : [],
    assignees: [],
    web_url: `https://git.example.local/logistics-hub/svc/-/merge_requests/${i + 1}`,
    // Half carry comments, so the notes leg is exercised and skipped in the
    // same run - that asymmetry is what makes the per-item work uneven.
    user_notes_count: i % 2 === 0 ? 2 : 0,
  }));
}

/** Installs a fake GitLab. Returns a restore function and the request log. */
function stubGitLab(): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace('https://git.example.local/api/v4', '');

    const json = (body: any, nextPage = '') => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'x-next-page' ? nextPage : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });

    if (path.startsWith('/groups/')) return json(rawMergeRequests());

    // Latency INVERTED against iid: the highest-numbered merge request answers
    // fastest, so completion order is the reverse of input order.
    const iid = Number(/merge_requests\/(\d+)\//.exec(path)?.[1] ?? 0);
    await tick(Math.max(1, (MR_COUNT - iid) * 2));

    if (path.includes('/notes')) {
      return json([
        { system: false, author: { id: 99, name: 'Reviewer', username: 'rev' }, created_at: '2026-08-29T10:00:00.000Z', body: 'looks fine' },
        { system: true, author: { id: 99, name: 'Reviewer', username: 'rev' }, created_at: '2026-08-29T11:00:00.000Z', body: 'approved this merge request' },
      ]);
    }
    if (path.includes('/approvals')) {
      return json({ approved_by: iid % 4 === 0 ? [{ user: { id: 99, name: 'Reviewer', username: 'rev' } }] : [] });
    }
    throw new Error(`unexpected path ${path}`);
  }) as typeof fetch;

  return { restore: () => { globalThis.fetch = original; }, calls };
}

async function collectAt(reviewConcurrency: number) {
  const stub = stubGitLab();
  try {
    return await collectTeamMergeRequests(SECRETS, TEAM, {
      windowDays: 30,
      keepIndividuals: true,
      now: new Date('2026-09-01T06:00:00.000Z'),
      botAccounts: [],
      withReviewDetail: true,
      reviewConcurrency,
    });
  } finally {
    stub.restore();
  }
}

test('the review pass writes the same snapshot at any concurrency', async () => {
  const sequential = await collectAt(1);
  const pooled = await collectAt(6);
  const wide = await collectAt(MR_COUNT * 2);

  assert.equal(sequential.mergeRequests.length, MR_COUNT);
  // Deep-equal on the whole collected shape, not a sampled field: the point is
  // that NOTHING in the snapshot moves, including the review signals that are
  // reduced from the notes and approvals fetched concurrently.
  assert.deepEqual(pooled, sequential, 'concurrency 6 must match strictly sequential');
  assert.deepEqual(wide, sequential, 'an over-wide pool must match too');

  // And the review detail really was collected, or the equality above is vacuous.
  assert.ok(sequential.mergeRequests.every((m) => m.review !== undefined));
  assert.ok(sequential.mergeRequests.some((m) => (m.review?.humanCommentCount ?? 0) > 0));
  assert.ok(sequential.mergeRequests.some((m) => (m.review?.humanApprovalCount ?? 0) > 0));
});

test('progress is reported once per merge request and ends on the total', async () => {
  const stub = stubGitLab();
  const seen: number[] = [];
  try {
    await collectTeamMergeRequests(SECRETS, TEAM, {
      windowDays: 30,
      keepIndividuals: true,
      now: new Date('2026-09-01T06:00:00.000Z'),
      withReviewDetail: true,
      reviewConcurrency: 5,
      onProgress: (done, total) => {
        assert.equal(total, MR_COUNT);
        seen.push(done);
      },
    });
  } finally {
    stub.restore();
  }
  assert.deepEqual(seen, Array.from({ length: MR_COUNT }, (_, i) => i + 1));
});

test('a pooled run makes the same requests as a sequential one, not more', async () => {
  const a = stubGitLab();
  try {
    await collectTeamMergeRequests(SECRETS, TEAM, {
      windowDays: 30, keepIndividuals: true, now: new Date('2026-09-01T06:00:00.000Z'),
      withReviewDetail: true, reviewConcurrency: 1,
    });
  } finally { a.restore(); }

  const b = stubGitLab();
  try {
    await collectTeamMergeRequests(SECRETS, TEAM, {
      windowDays: 30, keepIndividuals: true, now: new Date('2026-09-01T06:00:00.000Z'),
      withReviewDetail: true, reviewConcurrency: 6,
    });
  } finally { b.restore(); }

  // Same SET of requests, and the same count - the pool must not retry or
  // duplicate anything. Sorted because issue order is what is allowed to differ.
  assert.deepEqual([...b.calls].sort(), [...a.calls].sort());
});
