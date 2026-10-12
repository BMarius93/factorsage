import type { MarketOverviewResponse } from "@intrinsic/contracts";
import {
  BENCHMARK_CATALOG,
  marketOverviewEtfs,
  type BenchmarkDailyPrice,
  type BenchmarkSeries,
  type BenchmarkWithSeries,
  type DateRange,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import type {
  BenchmarkDataService,
  BenchmarkHistory,
  BenchmarkRefreshState,
} from "@intrinsic/stock-data";
import { describe, expect, it, vi } from "vitest";
import { MarketService } from "./market.service";

/** Saturday 2026-10-10, 18:30 UTC: Friday 2026-10-09 is the latest completed session. */
const NOW = new Date("2026-10-10T18:30:00.000Z");

type Plan =
  | {
      kind: "history";
      through: string;
      from?: string;
      missing?: Required<DateRange>[];
    }
  | { kind: "empty" }
  | { kind: "error" };

function seriesFor(code: string): BenchmarkSeries {
  const entry = BENCHMARK_CATALOG.find((candidate) => candidate.code === code);
  return {
    id: `series-${code}`,
    benchmarkId: `benchmark-${code}`,
    version: 1,
    sourceKind: "FMP_SYMBOL",
    seriesType: "ETF_PROXY",
    providerSymbol: entry?.providerSymbol ?? code,
    currency: "USD",
    methodologyVersion: 1,
  };
}

/** Weekday bars `from`–`through`, a different gentle trend per code so returns differ. */
function weekdayBars(
  seriesId: string,
  from: string,
  through: string,
  slope: number,
): BenchmarkDailyPrice[] {
  const rows: BenchmarkDailyPrice[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${through}T00:00:00.000Z`);
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const close = 100 + rows.length * slope;
      rows.push({
        seriesId,
        date: cursor.toISOString().slice(0, 10),
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

function harness(
  plans: Record<string, Plan> = {},
  options: { tailSyncAt?: string; ttlMs?: number; maxStaleMs?: number } = {},
) {
  let now = NOW;
  const codes = marketOverviewEtfs().map((etf) => etf.benchmarkCode);
  const benchmarks: BenchmarkWithSeries[] = codes.map((code, index) => ({
    id: `benchmark-${code}`,
    code,
    name: code,
    isActive: true,
    isBacktestSelectable: code === "SP500",
    displayOrder: index,
    series: seriesFor(code),
  }));
  const reads: { code: string; range: Required<DateRange> }[] = [];
  const providerPath = vi.fn(() => {
    throw new Error("the market overview must never reach the provider path");
  });
  const data = {
    listBenchmarks: vi.fn(async () => benchmarks),
    readBenchmarkHistory: vi.fn(
      async (
        series: BenchmarkSeries,
        range: Required<DateRange>,
      ): Promise<BenchmarkHistory> => {
        const code = series.benchmarkId.replace("benchmark-", "");
        reads.push({ code, range });
        const plan: Plan = plans[code] ?? {
          kind: "history",
          through: "2026-10-09",
        };
        if (plan.kind === "error") {
          throw new Error(`redis chunk unreadable for ${code}`);
        }
        const rows =
          plan.kind === "empty"
            ? []
            : weekdayBars(
                series.id,
                plan.from ?? range.from,
                plan.through,
                0.05 + (codes.indexOf(code) - 8) * 0.01,
              );
        return {
          seriesId: series.id,
          basisGeneration: 0,
          rows: rows.filter(
            (row) => row.date >= range.from && row.date <= range.to,
          ),
          missing: plan.kind === "history" ? (plan.missing ?? []) : [range],
          source: "REDIS",
        };
      },
    ),
    benchmarkRefreshState: vi.fn(async (): Promise<BenchmarkRefreshState> =>
      options.tailSyncAt ? { lastTailSyncAt: options.tailSyncAt } : {},
    ),
    // Everything below reaches, or may reach, the provider. None of it may be called.
    ensureBenchmarkHydrated: providerPath,
    getBenchmarkDailyPrices: providerPath,
    refreshBenchmarkSeries: providerPath,
    getBenchmark: providerPath,
  } as unknown as BenchmarkDataService;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as StructuredLogger;

  const service = new MarketService(data, logger, () => now, {
    publicationDelayMs: 30 * 60_000,
    cacheTtlMs: options.ttlMs ?? 60_000,
    maxStaleMs: options.maxStaleMs ?? 15 * 60_000,
  });
  return {
    service,
    data,
    logger,
    reads,
    providerPath,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

function instruments(body: MarketOverviewResponse) {
  return body.groups.flatMap((group) => group.instruments);
}

function instrument(body: MarketOverviewResponse, ticker: string) {
  const found = instruments(body).find((one) => one.ticker === ticker);
  if (!found) {
    throw new Error(`no ${ticker}`);
  }
  return found;
}

describe("MarketService", () => {
  it("answers exactly twenty ETFs in three groups, in catalog order, with six returns each", async () => {
    const { service } = harness();
    const body = await service.getMarketOverview();

    expect(body.basis).toBe("END_OF_DAY");
    expect(body.returnBasis).toBe("PRICE_RETURN");
    expect(body.status).toBe("AVAILABLE");
    expect(body.asOf).toBe("2026-10-09");
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(
      body.groups.map((group) => [
        group.id,
        group.label,
        group.shortLabel,
        group.instruments.length,
      ]),
    ).toEqual([
      ["BENCHMARKS", "Benchmarks", "Benchmarks", 5],
      ["US_SECTORS", "Sector Performance", "Sectors", 11],
      ["MACRO_ALTERNATIVES", "Macro & Alternatives", "Macro", 4],
    ]);
    expect(instruments(body).map((one) => one.ticker)).toEqual(
      marketOverviewEtfs().map((etf) => etf.ticker),
    );
    for (const one of instruments(body)) {
      expect(one.status).toBe("AVAILABLE");
      expect(one.sessionDate).toBe("2026-10-09");
      expect(Object.keys(one.returns)).toEqual([
        "1W",
        "1M",
        "3M",
        "6M",
        "YTD",
        "1Y",
      ]);
      expect(
        Object.values(one.returns).every((value) => typeof value === "number"),
      ).toBe(true);
      expect(one.sparkline?.values).toHaveLength(53);
      expect(one.sparkline?.endDate).toBe("2026-10-09");
    }
    expect(instrument(body, "USO").note).toMatch(/futures/i);
    expect(instrument(body, "SPY").name).toBe("S&P 500");
  });

  it("reads SPY from the SP500 series: the backtest benchmark, not a second copy", async () => {
    const { service, reads } = harness();
    await service.getMarketOverview();

    const codes = reads.map((read) => read.code);
    expect(codes).toContain("SP500");
    expect(codes).not.toContain("ETF_SPY");
    expect(new Set(codes).size).toBe(20);
  });

  it("never touches the provider path, and reads a bounded window per series", async () => {
    const { service, providerPath, reads } = harness();
    await service.getMarketOverview();

    expect(providerPath).not.toHaveBeenCalled();
    for (const read of reads) {
      expect(read.range).toEqual({ from: "2025-08-26", to: "2026-10-10" });
    }
  });

  it("carries no provider symbol, no storage detail and no price", async () => {
    const { service } = harness();
    const serialized = JSON.stringify(await service.getMarketOverview());

    for (const forbidden of [
      "series-",
      "benchmark-",
      "ETF_",
      "SP500",
      "providerSymbol",
      "close",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("stays well under the 60 KB payload budget", async () => {
    const { service } = harness();
    const serialized = JSON.stringify(await service.getMarketOverview());

    expect(serialized.length).toBeLessThan(20_000);
  });

  it("marks an ETF behind the reference session stale, with its own data date", async () => {
    const { service } = harness({
      ETF_XLE: { kind: "history", through: "2026-10-07" },
    });
    const body = await service.getMarketOverview();

    expect(body.status).toBe("PARTIAL");
    expect(body.asOf).toBe("2026-10-09");
    expect(instrument(body, "XLE")).toMatchObject({
      status: "STALE",
      sessionDate: "2026-10-07",
    });
    expect(instrument(body, "XLE").sparkline?.endDate).toBe("2026-10-07");
    expect(instrument(body, "XLK").status).toBe("AVAILABLE");
  });

  it("reports insufficient history as unavailable returns, never invented ones", async () => {
    const { service } = harness({
      ETF_XLC: { kind: "history", from: "2026-05-01", through: "2026-10-09" },
    });
    const xlc = instrument(await service.getMarketOverview(), "XLC");

    expect(xlc.status).toBe("AVAILABLE");
    expect(xlc.returns["3M"]).not.toBeNull();
    expect(xlc.returns["6M"]).toBeNull();
    expect(xlc.returns.YTD).toBeNull();
    expect(xlc.returns["1Y"]).toBeNull();
    expect(xlc.sparkline?.startDate).toBe("2026-05-01");
  });

  it("isolates an unreadable series to its own row, and logs the original error", async () => {
    const { service, logger } = harness({ ETF_GLD: { kind: "error" } });
    const body = await service.getMarketOverview();

    expect(instrument(body, "GLD")).toEqual({
      ticker: "GLD",
      name: "Gold",
      status: "UNAVAILABLE",
      returns: {
        "1W": null,
        "1M": null,
        "3M": null,
        "6M": null,
        YTD: null,
        "1Y": null,
      },
      sparkline: null,
    });
    expect(
      instruments(body).filter((one) => one.status === "AVAILABLE"),
    ).toHaveLength(19);
    expect(body.status).toBe("PARTIAL");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "market.overview.instrument.failed",
        ticker: "GLD",
        err: expect.any(Error),
      }),
    );
  });

  it("renders a clean unavailable overview when no ETF history was ever loaded", async () => {
    const plans = Object.fromEntries(
      marketOverviewEtfs().map((etf) => [
        etf.benchmarkCode,
        { kind: "empty" } as Plan,
      ]),
    );
    const { service } = harness(plans);
    const body = await service.getMarketOverview();

    expect(body.status).toBe("UNAVAILABLE");
    expect(body.asOf).toBeUndefined();
    expect(instruments(body)).toHaveLength(20);
    expect(instruments(body).every((one) => one.status === "UNAVAILABLE")).toBe(
      true,
    );
    expect(instruments(body).every((one) => one.sparkline === null)).toBe(true);
  });

  it("does not count a close read before its session finalized", async () => {
    // Friday's close finalizes at 20:30 UTC (16:00 New York + 30 minutes). Read at 19:00 and never
    // again, so Friday's bar is the provider's intraday value and Thursday is the latest close.
    const { service } = harness({}, { tailSyncAt: "2026-10-09T19:00:00.000Z" });
    const body = await service.getMarketOverview();

    expect(body.asOf).toBe("2026-10-08");
    expect(instrument(body, "SPY").sessionDate).toBe("2026-10-08");
  });

  describe("the shared summary", () => {
    it("computes once for many concurrent visitors", async () => {
      const { service, data } = harness();
      const bodies = await Promise.all(
        Array.from({ length: 25 }, () => service.getMarketOverview()),
      );

      expect(data.listBenchmarks).toHaveBeenCalledTimes(1);
      expect(data.readBenchmarkHistory).toHaveBeenCalledTimes(20);
      expect(new Set(bodies).size).toBe(1);
    });

    it("serves the same summary for a minute without reading again", async () => {
      const { service, data, advance } = harness();
      const first = await service.getMarketOverview();
      advance(59_000);
      const second = await service.getMarketOverview();

      expect(second).toBe(first);
      expect(data.listBenchmarks).toHaveBeenCalledTimes(1);
    });

    it("serves the previous summary while one background refresh replaces it", async () => {
      const { service, data, advance } = harness();
      const first = await service.getMarketOverview();
      advance(61_000);

      const served = await service.getMarketOverview();
      expect(served).toBe(first);
      await vi.waitFor(() =>
        expect(data.listBenchmarks).toHaveBeenCalledTimes(2),
      );

      await vi.waitFor(async () => {
        const next = await service.getMarketOverview();
        expect(next.generatedAt).not.toBe(first.generatedAt);
      });
      expect(data.listBenchmarks).toHaveBeenCalledTimes(2);
    });

    it("never serves a summary older than the staleness bound", async () => {
      const { service, data, advance } = harness();
      const first = await service.getMarketOverview();
      advance(16 * 60_000);

      const next = await service.getMarketOverview();
      expect(next).not.toBe(first);
      expect(next.generatedAt).toBe(
        new Date(NOW.getTime() + 16 * 60_000).toISOString(),
      );
      expect(data.listBenchmarks).toHaveBeenCalledTimes(2);
    });

    it("keeps a series' previous answer, dated by its own session, while a read fails", async () => {
      const plans: Record<string, Plan> = {};
      const { service, advance } = harness(plans, { maxStaleMs: 15 * 60_000 });
      const first = await service.getMarketOverview();
      plans.ETF_TLT = { kind: "error" };
      advance(5 * 60_000);
      await service.getMarketOverview(); // stale: triggers the refresh
      await vi.waitFor(async () => {
        const next = await service.getMarketOverview();
        expect(next.generatedAt).not.toBe(first.generatedAt);
      });
      const next = await service.getMarketOverview();

      expect(instrument(next, "TLT")).toEqual(instrument(first, "TLT"));
    });

    it("never lets a failing series outlive the staleness bound by being copied forward", async () => {
      // One ETF fails on every read for twenty minutes while the other nineteen keep succeeding, so
      // every minute produces a fresh, successful summary. The failing ETF's last good answer was
      // read at T0; whatever the summaries around it do, it must be served for at most 15 minutes
      // after T0 and then be reported unavailable — never refreshed by being copied into a newer
      // summary.
      const plans: Record<string, Plan> = {};
      const { service, advance, now } = harness(plans, {
        maxStaleMs: 15 * 60_000,
      });
      const first = await service.getMarketOverview();
      const lastGood = instrument(first, "TLT");
      expect(lastGood.status).toBe("AVAILABLE");
      plans.ETF_TLT = { kind: "error" };

      const seen: { minute: number; status: string; kept: boolean }[] = [];
      for (let minute = 1; minute <= 20; minute += 1) {
        advance(60_000);
        await service.getMarketOverview(); // past the TTL: serves the last summary, refreshes it
        const expected = now().toISOString();
        await vi.waitFor(async () => {
          expect((await service.getMarketOverview()).generatedAt).toBe(
            expected,
          );
        });
        const tlt = instrument(await service.getMarketOverview(), "TLT");
        seen.push({
          minute,
          status: tlt.status,
          kept:
            JSON.stringify(tlt.returns) === JSON.stringify(lastGood.returns),
        });
        // The other nineteen are unaffected throughout.
        const others = (await service.getMarketOverview()).groups
          .flatMap((group) => group.instruments)
          .filter((one) => one.ticker !== "TLT");
        expect(others.every((one) => one.status === "AVAILABLE")).toBe(true);
      }

      // Kept while younger than 15 minutes from its own last successful read …
      for (const entry of seen.filter((one) => one.minute < 15)) {
        expect(entry, `minute ${entry.minute}`).toMatchObject({ kept: true });
      }
      // … and unavailable from then on, for good.
      for (const entry of seen.filter((one) => one.minute >= 15)) {
        expect(entry, `minute ${entry.minute}`).toEqual({
          minute: entry.minute,
          status: "UNAVAILABLE",
          kept: false,
        });
      }
    });

    it("serves a recovered series fresh again, with a new bound from its new read", async () => {
      const plans: Record<string, Plan> = {};
      const { service, advance, now } = harness(plans, {
        maxStaleMs: 15 * 60_000,
      });
      await service.getMarketOverview();
      plans.ETF_TLT = { kind: "error" };
      const refreshAt = async (ms: number) => {
        advance(ms);
        await service.getMarketOverview();
        const expected = now().toISOString();
        await vi.waitFor(async () => {
          expect((await service.getMarketOverview()).generatedAt).toBe(
            expected,
          );
        });
        return instrument(await service.getMarketOverview(), "TLT");
      };

      expect((await refreshAt(16 * 60_000)).status).toBe("UNAVAILABLE");
      delete plans.ETF_TLT; // the series reads again
      expect((await refreshAt(61_000)).status).toBe("AVAILABLE");
      plans.ETF_TLT = { kind: "error" };
      // Fourteen minutes after the recovery read: kept; sixteen: not.
      for (let minute = 1; minute <= 14; minute += 1) {
        expect((await refreshAt(60_000)).status, `minute ${minute}`).toBe(
          "AVAILABLE",
        );
      }
      advance(60_000);
      expect((await refreshAt(61_000)).status).toBe("UNAVAILABLE");
    });

    it("stops serving a cached summary once the oldest answer it carries reaches the bound", async () => {
      // TLT's last good read is at T0. At T0 + 14:30 a summary keeps it; then every computation
      // fails outright. Forty seconds later that summary is still inside its own 60-second TTL, but
      // the TLT answer in it is 15:10 old, so it must not be served.
      const plans: Record<string, Plan> = {};
      const { service, data, advance, now } = harness(plans, {
        maxStaleMs: 15 * 60_000,
      });
      await service.getMarketOverview();
      plans.ETF_TLT = { kind: "error" };
      advance(14 * 60_000 + 30_000);
      await service.getMarketOverview();
      const expected = now().toISOString();
      await vi.waitFor(async () => {
        expect((await service.getMarketOverview()).generatedAt).toBe(expected);
      });
      expect(instrument(await service.getMarketOverview(), "TLT").status).toBe(
        "AVAILABLE",
      );

      vi.mocked(data.listBenchmarks).mockRejectedValue(
        new Error("database down"),
      );
      advance(40_000);

      await expect(service.getMarketOverview()).rejects.toThrow(
        "database down",
      );
    });

    it("fails the request, rather than serving something old, when a recomputation throws", async () => {
      const { service, data, advance } = harness();
      await service.getMarketOverview();
      advance(16 * 60_000);
      vi.mocked(data.listBenchmarks).mockRejectedValueOnce(
        new Error("database down"),
      );

      await expect(service.getMarketOverview()).rejects.toThrow(
        "database down",
      );
    });
  });
});
