import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/concurrency.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The property the snapshot depends on. Snapshots are the product and are diffed
// day to day, so a collection run must not write a different file because two
// HTTP requests came back in a different order. The pool therefore returns INPUT
// order, and this test makes the completion order deliberately the reverse of it.
test('results come back in input order, not completion order', async () => {
  const out = await mapWithConcurrency([0, 1, 2, 3, 4], 5, async (n) => {
    await tick((5 - n) * 10); // item 0 finishes last, item 4 first
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
});

test('never exceeds the limit, and does use it', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await tick(5);
    inFlight--;
    return n;
  });
  assert.equal(peak, 4, 'should saturate the pool');
});

// A misconfigured limit must degrade to the sequential behaviour this replaced,
// never to doing nothing at all - a collection run that silently collected no
// review detail would look exactly like a clean board.
for (const bad of [0, -3, Number.NaN]) {
  test(`a limit of ${bad} runs everything, one at a time`, async () => {
    let peak = 0;
    let inFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3], bad, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await tick(1);
      inFlight--;
      return n;
    });
    assert.deepEqual(out, [1, 2, 3]);
    assert.equal(peak, 1);
  });
}

test('a limit above the item count does not over-spawn or drop work', async () => {
  let started = 0;
  const out = await mapWithConcurrency([1, 2], 500, async (n) => {
    started++;
    return n;
  });
  assert.deepEqual(out, [1, 2]);
  assert.equal(started, 2);
});

test('an empty input does no work and returns nothing', async () => {
  let called = 0;
  const out = await mapWithConcurrency([], 4, async () => {
    called++;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

// The progress callback drives a \r-rewritten stderr line during collection.
// It has to count every item exactly once and end on the total, or the run
// appears to stall short of finishing.
test('progress reports every item once and finishes on the total', async () => {
  const seen: Array<[number, number]> = [];
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    await tick(n % 3);
    return n;
  }, (done, total) => seen.push([done, total]));

  assert.equal(seen.length, 7);
  assert.deepEqual(seen.map(([d]) => d), [1, 2, 3, 4, 5, 6, 7], 'monotonic, no gaps, no repeats');
  assert.ok(seen.every(([, t]) => t === 7));
});

test('the index passed to the worker is the item\'s own position', async () => {
  const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => {
    await tick(3 - index);
    return `${index}:${item}`;
  });
  assert.deepEqual(out, ['0:a', '1:b', '2:c']);
});

test('a rejection propagates rather than being swallowed', async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});
