/**
 * Which securities belong to the protected tier (`docs/decisions/stock-cache-tiers-v1.md`).
 *
 * The stock cache has two residency rules over one key family: the **protected tier** — every
 * security a built-in point-in-time universe admits, current and former members alike — stays
 * resident outside the LRU and never carries a TTL; every other security lives in the count-bounded
 * LRU. The cache asks this port at every admission (a hydration, a refresh, a publication, the first
 * read of a resident security no tier counts), so the routing is the same in every process and every
 * consumer, and it survives a Redis that lost its own record of the designation.
 *
 * PostgreSQL is the source: `IndexConstituent` rows resolved to a security. Historical membership is
 * enough — a former constituent stays protected after it left the index, because a backtest over its
 * years still reads it.
 */
export interface ProtectedTierEligibility {
  /**
   * The ids the canonical universe admits. The same `Set` instance is returned until the membership
   * changes, so a caller can tell a new snapshot from the one it already acted on by identity.
   */
  eligible(): Promise<ReadonlySet<string>>;
}

const NOTHING: ReadonlySet<string> = new Set<string>();

/**
 * No canonical universe: only the Redis designation (`protectStocks`) decides. For suites, tools that
 * work in a namespace of their own, and processes that never admit a universe security.
 */
export const REDIS_DESIGNATION_ONLY: ProtectedTierEligibility = {
  eligible: async () => NOTHING,
};

/** How often a process re-reads the canonical universe. */
export const DEFAULT_PROTECTED_TIER_REFRESH_MS = 60_000;

export type ProtectedTierEligibilityEvent =
  | {
      event: "loaded";
      securities: number;
      added: number;
      removed: number;
      durationMs: number;
    }
  | { event: "load-failed"; error: unknown; servingStale: boolean };

/**
 * The canonical universe, read from PostgreSQL by `load` and kept in memory.
 *
 * The first call waits for the read; afterwards a snapshot older than `refreshMs` is served while one
 * background read replaces it (stale-while-revalidate), so a cache read never waits for PostgreSQL.
 * A failed refresh keeps serving the last snapshot and is retried at the next call after
 * `refreshMs`; only a process that never loaded one fails, and then only the admission that asked.
 */
export class CanonicalProtectedTierEligibility implements ProtectedTierEligibility {
  private snapshot: ReadonlySet<string> | undefined;
  private loadedAt = 0;
  private pending: Promise<ReadonlySet<string>> | undefined;

  constructor(
    private readonly load: () => Promise<readonly string[]>,
    private readonly options: {
      readonly refreshMs?: number;
      readonly now?: () => number;
      readonly onEvent?: (event: ProtectedTierEligibilityEvent) => void;
    } = {},
  ) {}

  async eligible(): Promise<ReadonlySet<string>> {
    const current = this.snapshot;
    if (current === undefined) {
      return this.refresh();
    }
    if (this.now() - this.loadedAt >= this.refreshMs()) {
      // Errors are reported by `refresh` and never reach the reader of the stale snapshot.
      void this.refresh().catch(() => undefined);
    }
    return current;
  }

  private refresh(): Promise<ReadonlySet<string>> {
    this.pending ??= this.read().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async read(): Promise<ReadonlySet<string>> {
    const startedAt = this.now();
    try {
      const ids = new Set(await this.load());
      const previous = this.snapshot;
      const unchanged =
        previous !== undefined &&
        previous.size === ids.size &&
        [...ids].every((id) => previous.has(id));
      this.loadedAt = this.now();
      if (!unchanged) {
        this.snapshot = ids;
      }
      this.options.onEvent?.({
        event: "loaded",
        securities: ids.size,
        added: previous
          ? [...ids].filter((id) => !previous.has(id)).length
          : ids.size,
        removed: previous
          ? [...previous].filter((id) => !ids.has(id)).length
          : 0,
        durationMs: this.now() - startedAt,
      });
      return this.snapshot as ReadonlySet<string>;
    } catch (error) {
      const stale = this.snapshot;
      this.options.onEvent?.({
        event: "load-failed",
        error,
        servingStale: stale !== undefined,
      });
      if (stale === undefined) {
        throw error;
      }
      // Retried at the next call after another full interval, not on every read.
      this.loadedAt = this.now();
      return stale;
    }
  }

  private refreshMs(): number {
    return this.options.refreshMs ?? DEFAULT_PROTECTED_TIER_REFRESH_MS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
