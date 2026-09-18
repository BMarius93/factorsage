import { getStockDataConfig } from "@intrinsic/config";
import type { PrismaClient } from "@intrinsic/database";
import type { FmpBenchmarkProviderPort } from "@intrinsic/fmp";
import {
  CanonicalBenchmarkDataService,
  PrismaBenchmarkDataStore,
  RedisBenchmarkDataCache,
  type BenchmarkDataService,
  type LoadCoordinator,
  type ProviderRequestEvent,
  type RedisCacheClient,
} from "@intrinsic/stock-data";

/**
 * The API's benchmark loader, built in one place.
 *
 * It is the same composition `apps/worker/src/backtest/composition.ts` makes, from the same pieces
 * and with the same configuration: the same Prisma store, the same Redis projection under
 * `benchmark:v1:*`, the same shared FMP gate on the provider it is handed, and the same Redlock
 * `LoadCoordinator`. That is what makes the API and the worker serialize against each other when
 * both want a series hydrated — the hydration lock only works because both go through this one
 * package.
 *
 * It is a plain function rather than only a Nest provider so the prewarm CLI reaches the identical
 * loader. A second hydration path — a "dashboard market cache", a controller calling FMP itself, a
 * script with its own coverage arithmetic — is exactly what this exists to prevent.
 */
export function createBenchmarkDataService(options: {
  readonly prisma: PrismaClient;
  readonly cache: RedisCacheClient;
  readonly provider: FmpBenchmarkProviderPort;
  readonly coordinator: LoadCoordinator;
  readonly onProviderRequest?: (event: ProviderRequestEvent) => void;
}): BenchmarkDataService {
  const config = getStockDataConfig();
  return new CanonicalBenchmarkDataService(
    new PrismaBenchmarkDataStore(options.prisma),
    options.provider,
    new RedisBenchmarkDataCache(options.cache),
    options.coordinator,
    {
      recentPriceFreshnessMs: config.recentPriceFreshnessMs,
      recentTailCalendarDays: config.recentTailCalendarDays,
      ...(options.onProviderRequest
        ? { onProviderRequest: options.onProviderRequest }
        : {}),
    },
  );
}
