import type { StructuredLogger } from "@intrinsic/observability";
import type {
  SecurityCatalogService,
  SecurityCatalogSyncResult,
} from "@intrinsic/stock-data";

/**
 * Individual row failures logged before collapsing into a count.
 *
 * A universe-wide provider or database problem can fail thousands of rows; enough detail to
 * diagnose the cause is worth logging, an unbounded flood is not.
 */
const MAX_LOGGED_FAILURES = 20;

/**
 * Observability decorator for catalog synchronization, mirroring `LoggedStockDataService`.
 *
 * Keeps `@intrinsic/stock-data` free of a logger dependency while still emitting stable
 * started/completed/failed events with aggregate counts and elapsed time.
 */
export class LoggedSecurityCatalogService implements SecurityCatalogService {
  constructor(
    private readonly delegate: SecurityCatalogService,
    private readonly logger: StructuredLogger,
  ) {}

  async sync(): Promise<SecurityCatalogSyncResult> {
    const startedAt = Date.now();
    this.logger.info({ event: "security.catalog.sync.started" });

    try {
      const result = await this.delegate.sync();
      const durationMs = Date.now() - startedAt;

      for (const failure of result.failures.slice(0, MAX_LOGGED_FAILURES)) {
        // The original error is logged intact so its name, message and stack survive.
        this.logger.warn({
          event: "security.catalog.sync.entry.failed",
          symbol: failure.providerSymbol,
          err: failure.error,
        });
      }
      if (result.failures.length > MAX_LOGGED_FAILURES) {
        this.logger.warn({
          event: "security.catalog.sync.entry.failures.truncated",
          failed: result.failures.length,
          logged: MAX_LOGGED_FAILURES,
        });
      }

      this.logger.info({
        event: "security.catalog.sync.completed",
        durationMs,
        ...result.summary,
        skippedByReason: result.skippedByReason,
      });
      return result;
    } catch (err) {
      this.logger.error({
        event: "security.catalog.sync.failed",
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    }
  }
}
