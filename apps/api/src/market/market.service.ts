import type {
  MarketOverviewItemResponse,
  MarketOverviewResponse,
} from "@intrinsic/contracts";
import { MARKET_OVERVIEW_BASIS } from "@intrinsic/contracts";
import { MARKET_REFERENCE_SERIES } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { addDays, type BenchmarkDataService } from "@intrinsic/stock-data";
import { Inject, Injectable } from "@nestjs/common";
import { BENCHMARK_DATA_SERVICE } from "../benchmarks/benchmarks.tokens";
import {
  buildMarketOverviewItem,
  unavailableMarketOverviewItem,
  MARKET_OVERVIEW_LOOKBACK_DAYS,
} from "./market-overview";
import { MARKET_CLOCK, MARKET_LOGGER } from "./market.tokens";

/**
 * What the broad market did, for whoever is looking at the Dashboard.
 *
 * No account-specific state and no viewer argument: the S&P 500 closed where it closed, and a Guest
 * and a signed-in customer are shown the identical numbers. That is why this is not part of the
 * Dashboard read model, which is entirely about which monitors the viewer can see.
 *
 * The data path is the ordinary benchmark one, in full: `MARKET_REFERENCE_SERIES` resolves to
 * catalog rows, the canonical loader subtracts durable coverage, takes the shared hydration lock,
 * goes to FMP through the shared gate when something is genuinely missing, writes PostgreSQL and
 * publishes the yearly Redis chunks. There is no market cache here, and this service cannot reach
 * the provider except through that loader.
 */
@Injectable()
export class MarketService {
  constructor(
    @Inject(BENCHMARK_DATA_SERVICE)
    private readonly benchmarks: BenchmarkDataService,
    @Inject(MARKET_LOGGER) private readonly logger: StructuredLogger,
    @Inject(MARKET_CLOCK) private readonly now: () => Date,
  ) {}

  async getMarketOverview(): Promise<MarketOverviewResponse> {
    const today = this.now().toISOString().slice(0, 10);
    const range = {
      from: addDays(today, -MARKET_OVERVIEW_LOOKBACK_DAYS),
      to: today,
    };

    // Sequential, and each series isolated from the next. Sequential because a cold read goes to
    // the provider and three parallel bursts would spend the shared FMP budget faster than Stock
    // Details can recover it; isolated because one unreadable index must cost its own card and
    // nothing else — the Dashboard still has four other cards to draw.
    const items: MarketOverviewItemResponse[] = [];
    for (const reference of MARKET_REFERENCE_SERIES) {
      items.push(
        await this.readReference(reference.code, reference.label, range),
      );
    }

    return {
      generatedAt: this.now().toISOString(),
      basis: MARKET_OVERVIEW_BASIS,
      items,
    };
  }

  private async readReference(
    code: string,
    label: string,
    range: { from: string; to: string },
  ): Promise<MarketOverviewItemResponse> {
    const startedAt = Date.now();
    try {
      const benchmark = await this.benchmarks.getBenchmark(code);
      const rows = await this.benchmarks.getBenchmarkDailyPrices(
        benchmark.series,
        range,
      );
      const item = buildMarketOverviewItem(code, label, rows);
      this.logger.debug({
        event: "market.overview.reference.read",
        code,
        seriesId: benchmark.series.id,
        sessions: rows.length,
        status: item.status,
        sessionDate: item.sessionDate,
        durationMs: Date.now() - startedAt,
      });
      return item;
    } catch (error) {
      // Logged with the original error, then reported as one unavailable card. Failing the whole
      // response would let one provider hiccup take down a page that is mostly about monitors, and
      // substituting a remembered number would be worse than showing none.
      this.logger.warn({
        event: "market.overview.reference.failed",
        code,
        from: range.from,
        to: range.to,
        durationMs: Date.now() - startedAt,
        err: error,
      });
      return unavailableMarketOverviewItem(code, label);
    }
  }
}
