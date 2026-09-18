// In-process, per-key serialisation. Two webhook deliveries for the same order
// routinely arrive within the same second (Shopee's status push and its
// tracking-number push, for instance); each one independently reads "no row
// yet", creates a Sales Order, and the loser's INSERT fails on the primary key —
// leaving an orphan SO in Accurate that nothing references. Chaining work per
// order id means the second delivery runs after the first has committed and
// sees the row it wrote.
//
// Single-process only, which is all this app is: one container, one Node
// process. The chain for a key is dropped once nothing is queued on it, so the
// map doesn't grow with every order ever seen.
const chains = new Map<string, Promise<unknown>>();

export async function withOrderLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // Wait for whatever is ahead of us, but don't let *its* failure become ours —
  // each delivery handles its own errors.
  const run = previous.catch(() => undefined).then(fn);
  chains.set(key, run);
  try {
    return await run;
  } finally {
    if (chains.get(key) === run) {
      chains.delete(key);
    }
  }
}
