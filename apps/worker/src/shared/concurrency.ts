/**
 * Bounded fan-out, shared by the two worker paths that load several securities at once.
 *
 * Both a backtest's frame preparation and a Monitor evaluation cycle need the same thing: run a
 * task over many securities with a fixed number in flight, so one run cannot open an unbounded
 * number of provider and database operations at once. The limit is the caller's, because the two
 * paths budget differently — a backtest has one run's worth of provider allowance, a Monitor cycle
 * has the whole monitored universe's.
 *
 * This is the one copy. It lives here rather than in either feature folder because a second
 * implementation of "run N at a time" is exactly the kind of drift the repository's no-duplicate
 * rule exists to prevent; it is deliberately not a general-purpose utilities module.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        await task(item, index);
      }
    }),
  );
}
