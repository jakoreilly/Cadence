import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AtlassianHttpError,
  createJiraClient,
  createRequestGate,
  DEFAULT_PAGE_SIZE,
  JiraNotFound,
} from '../src/jira/client.js';
import type { Secrets } from '../src/types.js';

// ---------------------------------------------------------------------------
// The Atlassian client had no coverage at all, and it now carries two things
// that fail SILENTLY when they are wrong: a shared in-flight ceiling (too high
// reads as a permissions problem, because Jira answers 429), and a pagination
// terminator that decides whether the collector saw every row or only the first
// page of them. Both are asserted here against a stubbed global fetch, so the
// real retry / gate / paginate path runs rather than a re-implementation of it.
// ---------------------------------------------------------------------------

const SECRETS: Secrets = {
  atlassianBaseUrl: 'https://example.atlassian.net',
  atlassianEmail: 'collector@example.com',
  atlassianApiToken: 'not-a-real-token',
};

/** Swap in a fetch, run, and always put the real one back. */
async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const startAtOf = (url: string): number => Number(new URL(url).searchParams.get('startAt') ?? 0);
const maxResultsOf = (url: string): number => Number(new URL(url).searchParams.get('maxResults') ?? 0);

// --- the in-flight ceiling ----------------------------------------------------

test('the request gate never lets more than maxInFlight run at once', async () => {
  const gate = createRequestGate(3);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      gate.run(async () => {
        active++;
        if (active > peak) peak = active;
        await new Promise((r) => setTimeout(r, 1));
        active--;
      })),
  );
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('the gate releases on a throw, or one failure would wedge every request behind it', async () => {
  const gate = createRequestGate(1);
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }));
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('a width below 1 is clamped rather than deadlocking', async () => {
  assert.equal(createRequestGate(0).maxInFlight, 1);
  assert.equal(createRequestGate(-4).maxInFlight, 1);
});

test('one client means one ceiling, shared by every pass that takes it', async () => {
  const client = createJiraClient(SECRETS, { maxInFlight: 2 });
  assert.equal(client.gate.maxInFlight, 2);

  let active = 0;
  let peak = 0;
  const stub = (async () => {
    active++;
    if (active > peak) peak = active;
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return jsonResponse({ values: [], isLast: true });
  }) as unknown as typeof fetch;

  await withFetch(stub, async () => {
    await Promise.all(Array.from({ length: 10 }, () => client.get('/rest/api/3/myself')));
  });
  assert.equal(peak, 2);
});

// --- pagination ---------------------------------------------------------------

test('a capped page is not mistaken for the last page', async () => {
  // The endpoint caps maxResults at 50 and echoes the cap back. The old
  // terminator compared the returned length against the REQUESTED size, so the
  // very first 50-row page read as "short, therefore last" and everything after
  // it was dropped with no error anywhere.
  const total = 120;
  const cap = 50;
  const seen: number[] = [];
  const stub = (async (url: string) => {
    const startAt = startAtOf(url);
    seen.push(maxResultsOf(url));
    const values = Array.from(
      { length: Math.max(0, Math.min(cap, total - startAt)) },
      (_, i) => ({ id: startAt + i }),
    );
    // No isLast, no total - the shape several Agile endpoints actually return.
    return jsonResponse({ values });
  }) as unknown as typeof fetch;

  const client = createJiraClient(SECRETS);
  const out = await withFetch(stub, () => client.paginate('/rest/agile/1.0/board/701/sprint', 'values'));
  assert.equal(out.length, total);
  assert.equal(seen[0], DEFAULT_PAGE_SIZE, 'asks for the full page size, not the cap');
});

test('a genuinely short page still ends the walk', async () => {
  let calls = 0;
  const stub = (async (url: string) => {
    calls++;
    const startAt = startAtOf(url);
    const values = Array.from({ length: startAt === 0 ? 100 : 7 }, (_, i) => ({ id: startAt + i }));
    return jsonResponse({ values });
  }) as unknown as typeof fetch;

  const client = createJiraClient(SECRETS);
  const out = await withFetch(stub, () => client.paginate('/rest/agile/1.0/board/701/epic', 'values'));
  assert.equal(out.length, 107);
  assert.equal(calls, 2);
});

test('isLast is authoritative where the endpoint sends it', async () => {
  let calls = 0;
  const stub = (async () => {
    calls++;
    return jsonResponse({ values: [{ id: calls }], isLast: calls >= 3 });
  }) as unknown as typeof fetch;

  const client = createJiraClient(SECRETS);
  const out = await withFetch(stub, () => client.paginate('/rest/agile/1.0/board/701/sprint', 'values'));
  assert.equal(out.length, 3);
  assert.equal(calls, 3);
});

test('an empty page ends the walk without looping forever', async () => {
  const stub = (async () => jsonResponse({ values: [] })) as unknown as typeof fetch;
  const client = createJiraClient(SECRETS);
  const out = await withFetch(stub, () => client.paginate('/rest/agile/1.0/board/701/sprint', 'values'));
  assert.deepEqual(out, []);
});

// --- errors carry their status ------------------------------------------------

test('a failure carries the status as a number, not only inside its message', async () => {
  const stub = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
  const client = createJiraClient(SECRETS);
  await withFetch(stub, async () => {
    await assert.rejects(client.get('/rest/api/3/changelog/bulkfetch'), (err: unknown) => {
      assert.ok(err instanceof AtlassianHttpError);
      assert.equal((err as AtlassianHttpError).status, 400);
      return true;
    });
  });
});

test('a 404 is still its own class, and still an AtlassianHttpError', async () => {
  const stub = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
  const client = createJiraClient(SECRETS);
  await withFetch(stub, async () => {
    await assert.rejects(client.get('/rest/agile/1.0/board/999'), (err: unknown) => {
      assert.ok(err instanceof JiraNotFound);
      assert.ok(err instanceof AtlassianHttpError);
      assert.equal((err as AtlassianHttpError).status, 404);
      return true;
    });
  });
});

test('post sends a JSON body and a content-type; get sends neither', async () => {
  const calls: Array<{ method: string; body: unknown; contentType: string | null }> = [];
  const stub = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as Record<string, string>);
    calls.push({
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      contentType: headers.get('content-type'),
    });
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const client = createJiraClient(SECRETS);
  await withFetch(stub, async () => {
    await client.post('/rest/api/3/changelog/bulkfetch', { issueIdsOrKeys: ['1', '2'] });
    await client.get('/rest/api/3/myself');
  });

  assert.deepEqual(calls[0], {
    method: 'POST',
    body: { issueIdsOrKeys: ['1', '2'] },
    contentType: 'application/json',
  });
  assert.equal(calls[1]!.method, 'GET');
  assert.equal(calls[1]!.body, undefined);
  assert.equal(calls[1]!.contentType, null);
});
