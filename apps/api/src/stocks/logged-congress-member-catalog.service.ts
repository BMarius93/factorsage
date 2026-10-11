import type { StructuredLogger } from "@intrinsic/observability";
import type {
  CongressMemberCatalogService,
  CongressMemberCatalogSyncOptions,
  CongressMemberCatalogSyncResult,
  CongressMemberCatalogSyncState,
} from "@intrinsic/stock-data";

/**
 * Observability decorator for the member catalog's synchronization, mirroring
 * `LoggedSecurityCatalogService`.
 *
 * One stable event per outcome, with counts and elapsed time. Nothing a provider sent is logged:
 * a declined row appears as its bioguide id and the reason, and a failed run as its code, its
 * sentence and the original error for its stack.
 */
export class LoggedCongressMemberCatalogService implements CongressMemberCatalogService {
  constructor(
    private readonly delegate: CongressMemberCatalogService,
    private readonly logger: StructuredLogger,
  ) {}

  state(): Promise<CongressMemberCatalogSyncState | null> {
    return this.delegate.state();
  }

  async sync(
    options?: CongressMemberCatalogSyncOptions,
  ): Promise<CongressMemberCatalogSyncResult> {
    const startedAt = Date.now();
    this.logger.info({ event: "congress-member.catalog.sync.started" });

    let result: CongressMemberCatalogSyncResult;
    try {
      result = await this.delegate.sync(options);
    } catch (err) {
      this.logger.error({
        event: "congress-member.catalog.sync.failed",
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    }
    const durationMs = Date.now() - startedAt;

    switch (result.outcome) {
      case "COMPLETED":
        for (const declined of result.declined) {
          this.logger.warn({
            event: "congress-member.catalog.sync.member.declined",
            externalId: declined.externalId,
            reason: declined.reason,
            ...(declined.position ? { position: declined.position } : {}),
          });
        }
        this.logger.info({
          event: "congress-member.catalog.sync.completed",
          durationMs,
          runSequence: result.runSequence,
          ...result.summary,
        });
        break;
      case "UP_TO_DATE":
        this.logger.info({
          event: "congress-member.catalog.sync.skipped",
          reason: "UP_TO_DATE",
          lastCompletedAt: result.lastCompletedAt,
          durationMs,
        });
        break;
      case "ALREADY_RUNNING":
        this.logger.warn({
          event: "congress-member.catalog.sync.skipped",
          reason: "ALREADY_RUNNING",
          durationMs,
        });
        break;
      case "FAILED":
        this.logger.error({
          event: "congress-member.catalog.sync.failed",
          durationMs,
          runSequence: result.runSequence,
          code: result.code,
          reason: result.message,
          providerRequests: result.providerRequests,
          ...(result.cause === undefined ? {} : { err: result.cause }),
        });
        break;
    }
    return result;
  }
}
