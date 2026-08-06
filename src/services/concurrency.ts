export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  // Minimum gap (ms) between successive request starts, shared across all workers —
  // caps concurrency alone doesn't bound requests/sec when responses come back fast.
  // Needed for Accurate's dual limit (8 parallel AND 8/sec per token); 0 disables it
  // for callers that don't talk to Accurate.
  minIntervalMs = 0
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let lastStart = 0;

  async function run() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      if (minIntervalMs > 0) {
        const wait = lastStart + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastStart = Date.now();
      }
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}
