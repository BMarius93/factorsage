import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  BenchmarkWithSeries,
  DateRange,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import type { BenchmarkDataService } from "@intrinsic/stock-data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_OVERVIEW_LOOKBACK_DAYS } from "./market-overview";
import { MarketService } from "./market.service";

const NOW = new Date("2026-09-17T18:30:00.000Z");

function series(code: string): BenchmarkSeries {
  return {
    id: `series-${code}`,
    benchmarkId: `benchmark-${code}`,
    version: 1,
    sourceKind: "FMP_SYMBOL",
    seriesType: "INDEX",
    providerSymbol: `^${code}`,
    currency: "USD",
    methodologyVersion: 1,
  };
}

function bars(
  seriesId: string,
  closes: readonly number[],
): BenchmarkDailyPrice[] {
  return closes.map((close, index) => ({
    seriesId,
    date: `2026-09-${String(index + 3).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }));
}

type Reads = Record<string, readonly number[] | Error>;

function serviceWith(reads: Reads, logger?: Partial<StructuredLogger>) {
  const requested: { seriesId: string; range: Required<DateRange> }[] = [];
  const benchmarks: BenchmarkDataService = {
    listBenchmarks: vi.fn(),
    getBenchmark: vi.fn(async (code: string): Promise<BenchmarkWithSeries> => {
      if (!(code in reads)) {
        throw new Error(`Benchmark '${code}' was not found`);
      }
      return {
        id: `benchmark-${code}`,
        code,
        name: code,
        isActive: true,
        isBacktestSelectable: false,
        displayOrder: 100,
        series: series(code),
      };
    }),
    getSeries: vi.fn(),
    ensureBenchmarkHydrated: vi.fn(),
    getBenchmarkDailyPrices: vi.fn(
      async (definition: BenchmarkSeries, range: Required<DateRange>) => {
        requested.push({ seriesId: definition.id, range });
        const code = definition.benchmarkId.replace("benchmark-", "");
        const read = reads[code];
        if (read instanceof Error) {
          throw read;
        }
        return bars(definition.id, read ?? []);
      },
    ),
    missingBenchmarkCoverage: vi.fn(),
  } as unknown as BenchmarkDataService;

  const log: StructuredLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    ...logger,
  } as unknown as StructuredLogger;

  return {
    service: new MarketService(benchmarks, log, () => NOW),
    requested,
    log,
  };
}

const HEALTHY: Reads = {
  SP500_INDEX: [7551.81, 7637.05],
  DJIA_INDEX: [51461.9, 51778.04],
  VIX_INDEX: [17.71, 15.43],
};

describe("MarketService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports exactly the three market references, in catalog order", async () => {
    const { service } = serviceWith(HEALTHY);

    const overview = await service.getMarketOverview();

    expect(overview.items.map((item) => item.code)).toEqual([
      "SP500_INDEX",
      "DJIA_INDEX",
      "VIX_INDEX",
    ]);
    expect(overview.items.map((item) => item.label)).toEqual([
      "S&P 500",
      "DJIA",
      "VIX",
    ]);
  });

  it("says out loud that its numbers are end-of-day closes", async () => {
    const { service } = serviceWith(HEALTHY);

    // The one guard against a card that quietly starts reading as a live quote.
    expect((await service.getMarketOverview()).basis).toBe("END_OF_DAY");
  });

  it("asks the canonical loader for the recent window it actually draws", async () => {
    const { service, requested } = serviceWith(HEALTHY);

    await service.getMarketOverview();

    expect(requested).toHaveLength(3);
    for (const read of requested) {
      expect(read.range.to).toBe("2026-09-17");
      // Bounded, so a page read never triggers a decades-deep download. Deeper history is a
      // prewarm decision, not something the Dashboard decides for itself.
      expect(read.range.from).toBe("2026-08-18");
    }
    expect(MARKET_OVERVIEW_LOOKBACK_DAYS).toBe(30);
  });

  it("reads each series under its own immutable series id", async () => {
    const { service, requested } = serviceWith(HEALTHY);

    await service.getMarketOverview();

    expect(requested.map((read) => read.seriesId)).toEqual([
      "series-SP500_INDEX",
      "series-DJIA_INDEX",
      "series-VIX_INDEX",
    ]);
    // No two references can collide in PostgreSQL or Redis, because neither is keyed by code.
    expect(new Set(requested.map((read) => read.seriesId)).size).toBe(3);
  });

  it("keeps the other cards when one provider series fails", async () => {
    const { service, log } = serviceWith({
      ...HEALTHY,
      DJIA_INDEX: new Error("Stock data provider temporarily unavailable"),
    });

    const overview = await service.getMarketOverview();

    expect(overview.items).toHaveLength(3);
    expect(overview.items[0]?.status).toBe("AVAILABLE");
    expect(overview.items[1]).toEqual({
      code: "DJIA_INDEX",
      label: "DJIA",
      status: "UNAVAILABLE",
      sparkline: [],
    });
    expect(overview.items[2]?.status).toBe("AVAILABLE");
    expect(overview.items[2]?.value).toBe(15.43);
    // And the failure is explained server-side rather than swallowed.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "market.overview.reference.failed",
        code: "DJIA_INDEX",
        err: expect.any(Error),
      }),
    );
  });

  it("reports an unregistered reference as unavailable rather than failing the read", async () => {
    const { service } = serviceWith({ SP500_INDEX: [1, 2] });

    const overview = await service.getMarketOverview();

    expect(overview.items.map((item) => item.status)).toEqual([
      "AVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
  });

  it("never invents a market value when everything is unavailable", async () => {
    const { service } = serviceWith({});

    const overview = await service.getMarketOverview();

    for (const item of overview.items) {
      expect(item.status).toBe("UNAVAILABLE");
      expect(item.value).toBeUndefined();
      expect(item.changePercent).toBeUndefined();
      expect(item.sparkline).toEqual([]);
    }
  });

  it("takes no viewer, so there is nothing that could differ between a Guest and a customer", async () => {
    const { service } = serviceWith(HEALTHY);

    const first = await service.getMarketOverview();
    const second = await service.getMarketOverview();

    expect(first.items).toEqual(second.items);
    // The method's arity is the guarantee: it cannot be handed an identity to branch on.
    expect(service.getMarketOverview.length).toBe(0);
  });
});
