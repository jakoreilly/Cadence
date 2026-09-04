// ---------------------------------------------------------------------------
// A bounded worker pool, for the one place in this tool where wall-clock time
// is actually felt: the per-merge-request review pass.
//
// WHY THIS EXISTS. `collectTeamMergeRequests` makes at least one request per
// merge request (approvals, which nothing in the list payload can substitute
// for) plus a notes page for every merge request that has comments. On this
// estate that is 1,141 merge requests across four teams, so a fully sequential
// pass is 1,141+ round trips in series - minutes of the daily scheduled run,
// spent waiting rather than computing. The progress callback in
// CollectMergeRequestOptions exists precisely because of how long it takes.
//
// WHY NOT Promise.all. The sequential loop was deliberate and its reason still
// holds: "a parallel burst across hundreds of merge requests is what gets a
// token rate-limited". `Promise.all` over 1,141 requests IS that burst. The
// answer is not to choose between one at a time and all at once - it is to keep
// a small, fixed number in flight, which is a steady low request rate rather
// than a spike, and to leave the existing 429/Retry-After backoff in
// `gitlabGet` underneath it as the safety net it already is.
//
// DETERMINISM IS THE CONSTRAINT, not a nice-to-have. Snapshots are the product
// and are compared day to day, so a collection run must not produce a different
// file because two requests completed in a different order. Two properties
// guarantee that here:
//   - results are returned in INPUT order, never completion order, and
//   - `onProgress` reports a count, never an index, so it cannot imply an
//     ordering it does not have.
// ---------------------------------------------------------------------------

/** Runs `worker` over every item with at most `limit` in flight, returning the
 *  results in INPUT order.
 *
 *  `limit` is clamped to at least 1, so a bad configuration degrades to the
 *  sequential behaviour this replaces rather than to doing nothing. A limit at
 *  or above `items.length` is simply "all of them", which is why the caller -
 *  not this function - decides what a safe ceiling is.
 *
 *  Rejections propagate, and the runners still in flight are NOT cancelled -
 *  they finish the queue, and their results are discarded along with everything
 *  else when the returned promise has already rejected. There is no unhandled
 *  rejection either way: `Promise.all` attaches a handler to every runner up
 *  front, so a second failure after the first is still observed.
 *
 *  That is the right shape for this codebase rather than a gap: the one caller
 *  wraps its own per-item work in a try/catch and records the failure ON the
 *  item (see collectReviewDetail), precisely so that one unreadable merge
 *  request cannot lose the other 599. Nothing is therefore expected to reach
 *  here, and anything that does is a programming error where finishing the
 *  remaining work is harmless. A future caller that DOES throw per item, and
 *  that wants the pass to stop early, needs an abort signal rather than a
 *  reliance on this. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (total === 0) return results;

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let next = 0;
  let done = 0;

  // Each runner pulls the next index off a shared counter rather than taking a
  // pre-sliced chunk. Chunking is simpler and is wrong here: merge requests
  // differ by an order of magnitude in how many notes pages they carry, so a
  // runner handed the chunk containing the busy ones finishes long after the
  // others and the pass degrades towards sequential for its whole tail.
  async function runner(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      results[index] = await worker(items[index]!, index);
      onProgress?.(++done, total);
    }
  }

  await Promise.all(Array.from({ length: width }, () => runner()));
  return results;
}
