import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlassianHttpError, createRequestGate, type JiraClient } from '../src/jira/client.js';
import { BULK_CHANGELOG_PATH, changelogTargets, fetchChangelogs } from '../src/jira/changelogFetch.js';
import { keptFields } from '../src/jira/changelog.js';
import type { FieldMap } from '../src/types.js';

// ---------------------------------------------------------------------------
// The bulk changelog endpoint is the whole reason a backfill is affordable -
// roughly 19 requests where the per-issue path needs 1,892 - and every part of
// it can lose history silently:
//
//   - a site that does not implement the endpoint must DEMOTE the run to the
//     per-issue path, not fail it;
//   - a transient failure must cost one chunk, not the bulk path;
//   - an issue whose fetch failed must NOT be recorded as seen, or the store
//     carries a permanent hole that no later run will fill;
//   - the two paths must produce the same entries for the same events.
//
// None of those show up in the output when they go wrong - a short read looks
// like a quiet board - so each one is tested rather than asserted in a comment.
// ---------------------------------------------------------------------------

const MAP: FieldMap = {
  sprint: 'customfield_10020',
  storyPoints: ['customfield_10016'],
  discoveredAt: '2026-09-01T00:00:00.000Z',
} as FieldMap;

// ---------------------------------------------------------------------------
// Bulk changelog, and the fallback that has to exist
// ---------------------------------------------------------------------------

const KEPT = keptFields(MAP);

const TARGETS = [
  { id: '101', key: 'RET-1', updated: '2026-09-01T09:00:00.000Z' },
  { id: '102', key: 'RET-2', updated: '2026-09-01T10:00:00.000Z' },
];

function history(id: string, to: string) {
  return {
    id,
    created: '2026-08-30T09:00:00.000Z',
    items: [{ field: 'status', fieldId: 'status', fromString: 'To Do', toString: to }],
  };
}

/** A client double. Records what was asked for; each handler is a function so a
 *  test can make one leg fail without touching the others. */
function stubClient(handlers: {
  post?: (path: string, body: any) => Promise<any>;
  paginate?: (path: string) => Promise<any[]>;
}): { client: JiraClient; posts: any[]; paginated: string[] } {
  const posts: any[] = [];
  const paginated: string[] = [];
  const client: JiraClient = {
    get: async () => ({}),
    post: async (path, body) => {
      posts.push({ path, body });
      if (!handlers.post) throw new AtlassianHttpError(404, `Atlassian API ${path} failed: 404 no such endpoint`);
      return handlers.post(path, body);
    },
    paginate: async (path) => {
      paginated.push(path);
      if (!handlers.paginate) throw new Error(`unexpected paginate ${path}`);
      return handlers.paginate(path);
    },
    gate: createRequestGate(1),
  };
  return { client, posts, paginated };
}

test('the bulk path reads every issue in one request and keys entries by issue KEY', async () => {
  const { client, posts, paginated } = stubClient({
    post: async () => ({
      issueChangeLogs: [
        { issueId: '101', changeHistories: [history('9001', 'In Progress')] },
        { issueId: '102', changeHistories: [history('9002', 'Done')] },
      ],
    }),
  });

  const result = await fetchChangelogs(client, TARGETS, KEPT, true);

  assert.equal(result.mode, 'bulk');
  assert.equal(result.requests, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, BULK_CHANGELOG_PATH);
  // Asked by ID, because the response is keyed by id - matching a response back
  // to a key by anything other than what was sent is guesswork.
  assert.deepEqual(posts[0].body.issueIdsOrKeys, ['101', '102']);
  assert.equal(paginated.length, 0, 'the per-issue endpoint must not be touched');

  assert.deepEqual(result.entries.map((e) => [e.id, e.issueKey]), [['9001', 'RET-1'], ['9002', 'RET-2']]);
  assert.deepEqual(result.seenUpdates, { 'RET-1': TARGETS[0]!.updated, 'RET-2': TARGETS[1]!.updated });
});

test('the bulk path follows nextPageToken to the end', async () => {
  let call = 0;
  const { client } = stubClient({
    post: async (_p, body) => {
      call++;
      if (call === 1) {
        assert.equal(body.nextPageToken, undefined);
        return { issueChangeLogs: [{ issueId: '101', changeHistories: [history('1', 'In Progress')] }], nextPageToken: 'tok' };
      }
      assert.equal(body.nextPageToken, 'tok');
      return { issueChangeLogs: [{ issueId: '102', changeHistories: [history('2', 'Done')] }] };
    },
  });
  const result = await fetchChangelogs(client, TARGETS, KEPT, true);
  assert.equal(result.requests, 2);
  assert.equal(result.entries.length, 2);
});

test('an unsupported bulk endpoint demotes the run to per-issue instead of losing history', async () => {
  // The whole point of the fallback. A site answering 404 for the bulk endpoint
  // must still get its changelog, or this "optimisation" is a regression
  // against a pass that worked.
  const { client, posts, paginated } = stubClient({
    paginate: async (path) => [history(path.includes('RET-1') ? '9001' : '9002', 'Done')],
  });

  const result = await fetchChangelogs(client, TARGETS, KEPT, true, { chunkSize: 1 });

  assert.equal(result.mode, 'per-issue');
  assert.equal(result.issuesRead, 2);
  // Probed ONCE, not once per chunk: two chunks were fetched and only the first
  // paid for the discovery.
  assert.equal(posts.length, 1);
  assert.equal(paginated.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /bulk changelog unavailable/);
  assert.deepEqual(Object.keys(result.seenUpdates).sort(), ['RET-1', 'RET-2']);
});

test('a transient bulk failure costs one chunk, not the bulk path', async () => {
  let call = 0;
  const { client, posts } = stubClient({
    post: async (_p, body) => {
      call++;
      // A 502 on the first chunk only. Not an "unsupported" signal, so the
      // second chunk must still go out in bulk.
      if (call === 1) throw new AtlassianHttpError(502, 'Atlassian API /changelog/bulkfetch failed: 502 bad gateway (x-request-id 404abc)');
      return { issueChangeLogs: (body.issueIdsOrKeys as string[]).map((id) => ({ issueId: id, changeHistories: [history(`h${id}`, 'Done')] })) };
    },
    paginate: async (path) => [history(path.includes('RET-1') ? '9001' : '9002', 'Done')],
  });

  const result = await fetchChangelogs(client, TARGETS, KEPT, true, { chunkSize: 1 });

  assert.equal(result.mode, 'mixed');
  assert.equal(result.issuesRead, 2);
  assert.equal(posts.length, 2, 'the second chunk must still try bulk');
  assert.match(result.errors[0]!, /502/);
});

test('an issue whose fetch failed is NOT recorded as seen', async () => {
  // The rule the whole store depends on: `seen` means "read at this updated",
  // and issuesNeedingChangelog will not come back to a stamped issue until it
  // moves again. Stamping a failure is a permanent hole.
  const { client } = stubClient({
    paginate: async (path) => {
      if (path.includes('RET-2')) throw new Error('Atlassian API failed: 500 server error');
      return [history('9001', 'Done')];
    },
  });

  const result = await fetchChangelogs(client, TARGETS, KEPT, true, { allowBulk: false, chunkSize: 10 });

  assert.equal(result.issuesRead, 1);
  assert.deepEqual(Object.keys(result.seenUpdates), ['RET-1']);
  assert.ok(result.errors.some((e) => e.includes('RET-2')));
  // And the entry that DID come back is kept - one bad issue must not cost the
  // other's history either.
  assert.equal(result.entries.length, 1);
});

test('bulk and per-issue produce the same entries for the same events', async () => {
  const histories = [history('9001', 'In Progress'), history('9002', 'Done')];
  const bulk = await fetchChangelogs(
    stubClient({ post: async () => ({ issueChangeLogs: [{ issueId: '101', changeHistories: histories }] }) }).client,
    [TARGETS[0]!],
    KEPT,
    true,
  );
  const perIssue = await fetchChangelogs(
    stubClient({ paginate: async () => histories }).client,
    [TARGETS[0]!],
    KEPT,
    true,
    { allowBulk: false },
  );
  assert.deepEqual(bulk.entries, perIssue.entries);
  assert.deepEqual(bulk.seenUpdates, perIssue.seenUpdates);
});

test('a bulk response naming an issue that was not asked for is dropped', async () => {
  const { client } = stubClient({
    post: async () => ({
      issueChangeLogs: [
        { issueId: '101', changeHistories: [history('9001', 'Done')] },
        { issueId: '999', changeHistories: [history('9999', 'Done')] },
      ],
    }),
  });
  const result = await fetchChangelogs(client, [TARGETS[0]!], KEPT, true);
  // Writing '999' into issueKey would put a row in the store that no issue can
  // ever be joined to.
  assert.deepEqual(result.entries.map((e) => e.issueKey), ['RET-1']);
});

test('changelogTargets pairs keys back to ids and drops a key it cannot resolve', () => {
  const issues = [
    { id: '101', key: 'RET-1', updated: 'u1' },
    { id: '102', key: 'RET-2', updated: 'u2' },
  ];
  assert.deepEqual(changelogTargets(issues, ['RET-2', 'RET-9', 'RET-1']), [
    { id: '102', key: 'RET-2', updated: 'u2' },
    { id: '101', key: 'RET-1', updated: 'u1' },
  ]);
});

test('no targets is not a request', async () => {
  const { client, posts, paginated } = stubClient({});
  const result = await fetchChangelogs(client, [], KEPT, true);
  assert.equal(result.mode, 'none');
  assert.equal(result.requests, 0);
  assert.equal(posts.length + paginated.length, 0);
});

