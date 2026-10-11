import type { BenchmarkWithSeries, MarketOverviewEtf } from "@intrinsic/domain";
import { marketOverviewEtfs } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import type {
  BenchmarkRefreshResult,
  BenchmarkRefreshState,
  BenchmarkResidency,
  TradingCalendar,
} from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import { BenchmarkNotFoundError } from "@intrinsic/stock-data";
import {
  MarketDataRefreshFailedError,
  MarketDataRefreshRun,
  type MarketDataRefreshService,
} from "./refresh-run.js";

const logger = createLogger({ service: "worker", level: "silent" });

const calendar: TradingCalendar = {
  async isTradingSession() {
    return true;
  },
};

/** Friday 2026-10-09 22:00 UTC: after the close plus the publication delay. */
const AFTER_CLOSE = new Date("2026-10-09T22:00:00.000Z");
/** Sunday: the latest finalized session is still Friday's. */
const SUNDAY = new Date("2026-10-11T15:00:00.000Z");

const ETFS: readonly MarketOverviewEtf[] = [
  {
    ticker: "SPY",
    label: "S&P 500 ETF",
    benchmarkCode: "SP500",
    listedIn: "1993-01",
  },
  {
    ticker: "QQQ",
    label: "Nasdaq-100 ETF",
    benchmarkCode: "ETF_QQQ",
    listedIn: "1999-03",
  },
  {
    ticker: "GLD",
    label: "Gold",
    benchmarkCode: "ETF_GLD",
    listedIn: "2004-11",
  },
];

/** A loader double: per-code state and outcomes, and a record of every call. */
class FakeBenchmarks implements MarketDataRefreshService {
  readonly refreshed: string[] = [];
  readonly verified: string[] = [];
  states = new Map<string, BenchmarkRefreshState>();
  failing = new Set<string>();
  absent = new Set<string>();
  refused = new Set<string>();
  awaiting = new Set<string>();

  async getBenchmark(code: string): Promise<BenchmarkWithSeries> {
    if (this.failing.has(code)) {
      throw new Error(`database unavailable for ${code}`);
    }
    if (this.absent.has(code)) {
      throw new BenchmarkNotFoundError(code);
    }
    return {
      id: code,
      code,
      name: code,
      isActive: true,
      isBacktestSelectable: code === "SP500",
      displayOrder: 0,
      series: {
        id: `series-${code}`,
        benchmarkId: code,
        version: 1,
        sourceKind: "FMP_SYMBOL",
        seriesType: "ETF_PROXY",
        providerSymbol: code,
        currency: "USD",
        methodologyVersion: 1,
      },
    };
  }

  async benchmarkRefreshState(series: {
    id: string;
  }): Promise<BenchmarkRefreshState> {
    return (
      this.states.get(series.id.replace("series-", "")) ?? {
        coverageEnd: "2026-10-08",
        latestBar: "2026-10-08",
        lastTailSyncAt: "2026-10-08T21:00:00.000Z",
      }
    );
  }

  async refreshBenchmarkSeries(series: {
    id: string;
  }): Promise<BenchmarkRefreshResult> {
    this.refreshed.push(series.id);
    if (this.awaiting.has(series.id.replace("series-", ""))) {
      return {
        status: "AWAITING_PUBLICATION",
        latestBar: "2026-10-08",
        basisGeneration: 0,
        providerReads: 2,
      };
    }
    if (this.refused.has(series.id.replace("series-", ""))) {
      return { status: "REBASE_REFUSED", basisGeneration: 0, providerReads: 3 };
    }
    return {
      status: "REFRESHED",
      latestBar: "2026-10-09",
      basisGeneration: 0,
      providerReads: 1,
    };
  }

  async ensureBenchmarkResident(series: {
    id: string;
  }): Promise<BenchmarkResidency> {
    this.verified.push(series.id);
    return { status: "RESIDENT", bars: 100, years: 1, basisGeneration: 0 };
  }
}

function runWith(
  benchmarks: FakeBenchmarks,
  now: Date,
  overrides: Partial<
    ConstructorParameters<typeof MarketDataRefreshRun>[3]
  > = {},
) {
  return new MarketDataRefreshRun(benchmarks, calendar, logger, {
    publicationDelayMs: 30 * 60_000,
    seriesRetryMs: 30 * 60_000,
    runBudgetMs: 60_000,
    now: () => now,
    etfs: ETFS,
    ...overrides,
  });
}

const current: BenchmarkRefreshState = {
  coverageEnd: "2026-10-09",
  latestBar: "2026-10-09",
  lastTailSyncAt: "2026-10-09T21:00:00.000Z",
};

describe("market-data refresh run", () => {
  it("covers the twenty approved ETFs, in display order, by default", async () => {
    const benchmarks = new FakeBenchmarks();
    const summary = await new MarketDataRefreshRun(
      benchmarks,
      calendar,
      logger,
      {
        publicationDelayMs: 30 * 60_000,
        seriesRetryMs: 30 * 60_000,
        runBudgetMs: 60_000,
        now: () => AFTER_CLOSE,
      },
    ).run(1, () => false);
    expect(summary.outcomes.map((outcome) => outcome.ticker)).toEqual(
      marketOverviewEtfs().map((etf) => etf.ticker),
    );
  });

  it("asks the provider for nothing over a weekend once every series holds Friday", async () => {
    const benchmarks = new FakeBenchmarks();
    for (const etf of ETFS) {
      benchmarks.states.set(etf.benchmarkCode, current);
    }
    const summary = await runWith(benchmarks, SUNDAY).run(7, () => false);

    expect(summary.expectedSession).toBe("2026-10-09");
    expect(summary.providerReads).toBe(0);
    expect(benchmarks.refreshed).toEqual([]);
    // Residency is still verified, which is how a Redis restart is repaired without the provider.
    expect(benchmarks.verified).toEqual(
      ETFS.map((etf) => `series-${etf.benchmarkCode}`),
    );
    expect(
      summary.outcomes.every((outcome) => outcome.outcome === "UP_TO_DATE"),
    ).toBe(true);
  });

  it("refreshes after the close only the series that do not hold the finalized session", async () => {
    const benchmarks = new FakeBenchmarks();
    benchmarks.states.set("ETF_QQQ", current);
    const summary = await runWith(benchmarks, AFTER_CLOSE).run(8, () => false);

    expect(benchmarks.refreshed).toEqual(["series-SP500", "series-ETF_GLD"]);
    expect(summary.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "REFRESHED",
      "UP_TO_DATE",
      "REFRESHED",
    ]);
    expect(summary.providerReads).toBe(2);
  });

  it("never bootstraps a series that was never loaded", async () => {
    const benchmarks = new FakeBenchmarks();
    benchmarks.states.set("ETF_GLD", {});
    const summary = await runWith(benchmarks, AFTER_CLOSE).run(9, () => false);

    expect(
      summary.outcomes.find((outcome) => outcome.ticker === "GLD")?.outcome,
    ).toBe("NOT_BOOTSTRAPPED");
    expect(benchmarks.refreshed).not.toContain("series-ETF_GLD");
  });

  it("treats a catalog row this release has not written yet as not bootstrapped, never as a failure", async () => {
    const benchmarks = new FakeBenchmarks();
    for (const etf of ETFS) {
      benchmarks.absent.add(etf.benchmarkCode);
    }
    // Every series is absent and the run still completes: no backoff, no error-level noise.
    const summary = await runWith(benchmarks, AFTER_CLOSE).run(14, () => false);

    expect(summary.failed).toBe(0);
    expect(
      summary.outcomes.every(
        (outcome) => outcome.outcome === "NOT_BOOTSTRAPPED",
      ),
    ).toBe(true);
    expect(benchmarks.refreshed).toEqual([]);
  });

  it("isolates a failing series: the others are refreshed and the run completes", async () => {
    const benchmarks = new FakeBenchmarks();
    benchmarks.failing.add("ETF_QQQ");
    const summary = await runWith(benchmarks, AFTER_CLOSE).run(10, () => false);

    expect(summary.failed).toBe(1);
    expect(
      summary.outcomes.find((outcome) => outcome.ticker === "QQQ"),
    ).toMatchObject({
      outcome: "FAILED",
      error: expect.stringContaining("database unavailable"),
    });
    expect(benchmarks.refreshed).toEqual(["series-SP500", "series-ETF_GLD"]);
  });

  it("fails the run, so it backs off, only when every series it attempted failed", async () => {
    const benchmarks = new FakeBenchmarks();
    for (const etf of ETFS) {
      benchmarks.failing.add(etf.benchmarkCode);
    }
    await expect(
      runWith(benchmarks, AFTER_CLOSE).run(11, () => false),
    ).rejects.toBeInstanceOf(MarketDataRefreshFailedError);
  });

  it("starts no series past its budget and defers the rest to the next run", async () => {
    const benchmarks = new FakeBenchmarks();
    const summary = await runWith(benchmarks, AFTER_CLOSE, {
      runBudgetMs: 0,
    }).run(12, () => false);
    expect(
      summary.outcomes.every((outcome) => outcome.outcome === "DEFERRED"),
    ).toBe(true);
    expect(benchmarks.refreshed).toEqual([]);
  });

  it("stops at the next series once its lease is lost or the process is stopping", async () => {
    const benchmarks = new FakeBenchmarks();
    let calls = 0;
    const summary = await runWith(benchmarks, AFTER_CLOSE).run(13, () => {
      calls += 1;
      return calls > 1;
    });
    expect(summary.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "REFRESHED",
      "DEFERRED",
      "DEFERRED",
    ]);
  });

  describe("per-series backoff", () => {
    /** A run that shares one clock the test moves. */
    function clockedRun(benchmarks: FakeBenchmarks) {
      let now = AFTER_CLOSE;
      const run = new MarketDataRefreshRun(benchmarks, calendar, logger, {
        publicationDelayMs: 30 * 60_000,
        seriesRetryMs: 30 * 60_000,
        runBudgetMs: 60_000,
        now: () => now,
        etfs: ETFS,
      });
      return {
        run,
        at(minutes: number) {
          now = new Date(AFTER_CLOSE.getTime() + minutes * 60_000);
        },
      };
    }

    it("retries a refused re-base on a doubling delay, not on every run", async () => {
      const benchmarks = new FakeBenchmarks();
      benchmarks.refused.add("ETF_GLD");
      const { run, at } = clockedRun(benchmarks);
      const gld = (summary: {
        outcomes: { ticker: string; outcome: string }[];
      }) =>
        summary.outcomes.find((outcome) => outcome.ticker === "GLD")?.outcome;

      expect(gld(await run.run(20, () => false))).toBe("REBASE_REFUSED");
      at(10);
      expect(gld(await run.run(21, () => false))).toBe("BACKING_OFF");
      at(31);
      expect(gld(await run.run(22, () => false))).toBe("REBASE_REFUSED");
      // Second refusal: the delay doubled to an hour from 31 minutes.
      at(80);
      expect(gld(await run.run(23, () => false))).toBe("BACKING_OFF");
      at(92);
      benchmarks.refused.delete("ETF_GLD");
      expect(gld(await run.run(24, () => false))).toBe("REFRESHED");
      // Recovered: no backoff remains.
      at(95);
      expect(gld(await run.run(25, () => false))).not.toBe("BACKING_OFF");
    });

    it("asks again for a session the provider has not published no more often than the retry spacing", async () => {
      // A series whose newest bars were held advances no tail watermark, so the durable state
      // alone would have it read on every run.
      const benchmarks = new FakeBenchmarks();
      benchmarks.awaiting.add("ETF_GLD");
      const { run, at } = clockedRun(benchmarks);
      const gld = (summary: {
        outcomes: { ticker: string; outcome: string }[];
      }) =>
        summary.outcomes.find((outcome) => outcome.ticker === "GLD")?.outcome;

      expect(gld(await run.run(50, () => false))).toBe("AWAITING_PUBLICATION");
      at(10);
      expect(gld(await run.run(51, () => false))).toBe("RECENTLY_ASKED");
      expect(
        benchmarks.refreshed.filter((id) => id === "series-ETF_GLD"),
      ).toHaveLength(1);
      at(31);
      benchmarks.awaiting.delete("ETF_GLD");
      expect(gld(await run.run(52, () => false))).toBe("REFRESHED");
    });

    it("backs off a series that fails alone, but not when every series fails together", async () => {
      const benchmarks = new FakeBenchmarks();
      benchmarks.failing.add("ETF_QQQ");
      const { run, at } = clockedRun(benchmarks);

      await run.run(30, () => false);
      at(10);
      const isolated = await run.run(31, () => false);
      expect(
        isolated.outcomes.find((outcome) => outcome.ticker === "QQQ")?.outcome,
      ).toBe("BACKING_OFF");

      // An outage: every series fails. The run's own backoff spaces the retry, and none of them is
      // held back once it recovers.
      const outage = new FakeBenchmarks();
      for (const etf of ETFS) {
        outage.failing.add(etf.benchmarkCode);
      }
      const shared = clockedRun(outage);
      await expect(shared.run.run(40, () => false)).rejects.toBeInstanceOf(
        MarketDataRefreshFailedError,
      );
      outage.failing.clear();
      shared.at(2);
      const recovered = await shared.run.run(41, () => false);
      expect(
        recovered.outcomes.every((outcome) => outcome.outcome === "REFRESHED"),
      ).toBe(true);
    });
  });
});
