/** What one computation produced, and optionally the instant after which it must not be served. */
export type SnapshotLoad<T> = { value: T; servableUntil?: number };

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
 *   summary as current. A computation may shorten that bound for the value it returns
 *   (`servableUntil`) when it carries data older than itself, so no part of a value is ever served
 *   past its own age limit.
 *
 * Process memory, deliberately. The summary is a projection of the Redis projection, cheap to
 * rebuild and carrying nothing user-owned, so a shared cache would be a third copy of the same data
 * with an invalidation problem of its own (`AGENTS.md` invariant 16 forbids a second namespace for it
 * anyway). Each API process recomputes it at most once a minute.
 */
export class SnapshotCache<T> {
  private entry: { value: T; at: number; servableUntil: number } | undefined;
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
   * The current value, computing it with `load` when needed.
   *
   * `load` deliberately receives nothing from the previous value. Every value this cache stores
   * is stamped with the time it was *computed*, so anything a computation copied out of the
   * previous value would be re-stamped as new and could be carried forward indefinitely. A
   * computation that wants to keep a part it could not refresh must track that part's own age.
   */
  async get(load: () => Promise<SnapshotLoad<T>>): Promise<T> {
    const entry = this.entry;
    const now = this.options.now();
    if (entry && now < entry.servableUntil) {
      if (now - entry.at < this.options.ttlMs) {
        return entry.value;
      }
      this.refresh(load).catch(this.options.onBackgroundFailure);
      return entry.value;
    }
    return this.refresh(load);
  }

  private refresh(load: () => Promise<SnapshotLoad<T>>): Promise<T> {
    if (!this.inflight) {
      this.inflight = load()
        .then(({ value, servableUntil }) => {
          const at = this.options.now();
          this.entry = {
            value,
            at,
            servableUntil: Math.min(
              at + this.options.maxStaleMs,
              servableUntil ?? Infinity,
            ),
          };
          return value;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }
}
