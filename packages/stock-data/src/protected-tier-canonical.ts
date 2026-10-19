import type { PrismaClient } from "@intrinsic/database";
import type { StockDataCacheObserver } from "./cache.js";
import { loadProtectedTierSecurityIds } from "./index-membership/prisma-store.js";
import { CanonicalProtectedTierEligibility } from "./protected-tier.js";

/** The structured logger a composition root already has; only what the tiers report through. */
export type StockCacheTierLogger = {
  info(entry: { event: string } & Record<string, unknown>): void;
  warn(entry: { event: string } & Record<string, unknown>): void;
};

/**
 * The protected tier's routing for a composition root (`docs/decisions/stock-cache-tiers-v1.md`):
 * the canonical universe read from PostgreSQL, refreshed in the background, with every reload and
 * failure logged. Every process that writes the product's stock cache passes one to its
 * `RedisStockDataCache`, so every consumer routes a security to the same tier.
 */
export function canonicalProtectedTierEligibility(
  prisma: Pick<PrismaClient, "indexConstituent">,
  logger: StockCacheTierLogger,
  options: { readonly refreshMs?: number } = {},
): CanonicalProtectedTierEligibility {
  return new CanonicalProtectedTierEligibility(
    () => loadProtectedTierSecurityIds(prisma),
    {
      ...(options.refreshMs !== undefined
        ? { refreshMs: options.refreshMs }
        : {}),
      onEvent: (event) => {
        if (event.event === "loaded") {
          if (event.added > 0 || event.removed > 0) {
            logger.info({
              event: "stock-data.protected-tier.eligibility-loaded",
              securities: event.securities,
              added: event.added,
              removed: event.removed,
              durationMs: event.durationMs,
            });
          }
        } else {
          logger.warn({
            event: "stock-data.protected-tier.eligibility-load-failed",
            servingStale: event.servingStale,
            err: event.error,
          });
        }
      },
    },
  );
}

/** The tier events of a `StockDataCacheObserver`, logged the same way in every process. */
export function stockCacheTierObserver(
  logger: StockCacheTierLogger,
): Pick<StockDataCacheObserver, "onLruEviction" | "onDesignationSyncFailed"> {
  return {
    onLruEviction: ({ admitted, victims }) => {
      logger.info({
        event: "stock-data.cache.lru-evicted",
        admitted,
        evicted: victims.length,
        victims,
      });
    },
    onDesignationSyncFailed: ({ securities, error }) => {
      logger.warn({
        event: "stock-data.protected-tier.designation-failed",
        securities,
        err: error,
      });
    },
  };
}
