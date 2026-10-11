/**
 * One process-local summary, recomputed at most once per `ttlMs` however many visitors ask.
 *
 * The market overview is identical for everybody, so it is computed once and served to all: a
 * thousand Dashboard loads in a minute cost one read of twenty series, not a thousand. Three rules:
 *
 * - **Single flight.** Concurrent requests that find no fresh value share one computation; nobody
 *   starts a second while one is running.
 * - **Stale while revalidating.** Once the value is older than `ttlMs` but younger than
 *   `maxStaleMs`, it is still served immediately while one background computation replaces it, so a
 *   visitor never waits for the refresh another visitor triggered.
 * - **Bounded staleness.** A value older than `maxStaleMs` is never served: the request waits for a
 *   new one, and a computation that fails then fails the request rather than presenting an old
 *   summary as current.
 *
 * Process memory, deliberately. The summary is a projection of the Redis projection, cheap to
 * rebuild and carrying nothing user-owned, so a shared cache would be a third copy of the same data
 * with an invalidation problem of its own (`AGENTS.md` invariant 16 forbids a second namespace for it
 * anyway). Each API process recomputes it at most once a minute.
 */
export class SnapshotCache<T> {
  private entry: { value: T; at: number } | undefined;
  private inflight: Promise<T> | undefined;

  constructor(
    private readonly options: {
      readonly ttlMs: number;
      readonly maxStaleMs: number;
      readonly now: () => number;
      /** A background refresh failed; the previous value keeps being served until `maxStaleMs`. */
      readonly onBackgroundFailure: (error: unknown) => void;
    },
  ) {}

  /**
   * The current value, computing it with `load` when needed. `load` receives the previous value
   * while it is still within `maxStaleMs`, so it can keep a part it could not recompute.
   */
  async get(load: (previous: T | undefined) => Promise<T>): Promise<T> {
    const entry = this.entry;
    const age = entry === undefined ? Infinity : this.options.now() - entry.at;
    if (entry && age < this.options.ttlMs) {
      return entry.value;
    }
    if (entry && age < this.options.maxStaleMs) {
      this.refresh(load).catch(this.options.onBackgroundFailure);
      return entry.value;
    }
    return this.refresh(load);
  }

  private refresh(load: (previous: T | undefined) => Promise<T>): Promise<T> {
    if (!this.inflight) {
      const entry = this.entry;
      const previous =
        entry && this.options.now() - entry.at < this.options.maxStaleMs
          ? entry.value
          : undefined;
      this.inflight = load(previous)
        .then((value) => {
          this.entry = { value, at: this.options.now() };
          return value;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }
}
