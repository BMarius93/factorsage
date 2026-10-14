import { MARKET_OVERVIEW_HISTORY_FLOOR, marketOverviewEtfs } from "@intrinsic/domain";
import {
  BENCHMARK_TECHNICAL_FIELDS,
  benchmarkTechnicalValueOn,
  buildBenchmarkTechnicalContext,
} from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import {
  MARKET_OVERVIEW_ETF_WEEKS,
  qaBenchmarkTradingDays,
  qaMarketOverviewEtfTradingDays,
  qaMarketReferenceTradingDays,
  seedQaBenchmarkDataWith,
  seedQaMarketOverviewEtfDataWith,
  seedQaMarketReferenceDataWith,
} from "./seed-qa-benchmark-data";
import { qaTradingDays } from "../stocks/seed-qa-stock-data";

const BENCHMARK_ID = "qa-benchmark";
const SECURITY_ID = "qa-security";
const TODAY = "2026-08-28";

/**
 * The Playwright backtest journey asserts that Portfolio and S&P 500 are two visibly different
 * curves and that alpha is a real number. Both are properties of this seed, so they are proven here
 * rather than only in a browser run CI does not perform.
 */
describe("QA benchmark seed", () => {
  const rows = qaBenchmarkTradingDays(BENCHMARK_ID, TODAY);

  it("produces a deterministic Monday-Friday history that reruns identically", () => {
    expect(qaBenchmarkTradingDays(BENCHMARK_ID, TODAY)).toEqual(rows);
    expect(rows.length % 5).toBe(0);
    for (const row of rows) {
      const weekday = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
  });

  it("covers exactly the same trading days as the QA security", () => {
    // Both series must span the same window, or a seeded backtest would have dates on which the
    // benchmark simply has no value and the comparison would be less useful than it looks.
    const securityDates = qaTradingDays(SECURITY_ID, TODAY).map(
      (row) => row.date,
    );
    expect(rows.map((row) => row.date)).toEqual(securityDates);
  });

  it("diverges from the QA security's prices, so return, benchmark return and alpha differ", () => {
    const securityCloses = qaTradingDays(SECURITY_ID, TODAY).map(
      (row) => row.close,
    );
    const benchmarkCloses = rows.map((row) => row.close);
    const securityGrowth =
      (securityCloses.at(-1) as number) / (securityCloses[0] as number);
    const benchmarkGrowth =
      (benchmarkCloses.at(-1) as number) / (benchmarkCloses[0] as number);
    expect(Math.abs(securityGrowth - benchmarkGrowth)).toBeGreaterThan(0.05);
  });

  it("never claims coverage outside the interval it actually generated", async () => {
    // The invariant a coverage row asserts is "the provider was asked for every date in here and
    // everything it returned is persisted". A seed that wrote three years and claimed thirty would
    // make every earlier date permanently unfetchable, and a real thirty-year backtest would then
    // compare against synthetic history without anyone being told. So the claim is captured at the
    // store boundary and checked against the rows the seed actually produced.
    const claimed: { from: string; to: string }[] = [];
    const store = {
      reconcileBenchmarkCatalog: async () => [
        { code: "SP500", series: { id: "series-1" } },
      ],
      saveDailyPriceSync: async (input: {
        successfulCoverage: readonly { from: string; to: string }[];
      }) => {
        claimed.push(
          ...input.successfulCoverage.map((range) => ({ ...range })),
        );
      },
    };

    await seedQaBenchmarkDataWith(store as never, TODAY);

    const earliest = rows[0]?.date as string;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.from).toBe(earliest);
    // Ending at today is the same claim a real sync makes about a weekend: asked for, nothing to
    // store. Starting before the first generated row would not be.
    expect(claimed[0]?.to).toBe(TODAY);
    expect((claimed[0]?.from ?? "") >= earliest).toBe(true);
  });

  it("keeps every bar internally consistent and positive", () => {
    for (const row of rows) {
      expect(row.close).toBeGreaterThan(0);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.close);
      expect(row.volume).toBeGreaterThan(0);
    }
  });
});

/**
 * The Dashboard's market cards are asserted on exact values in unit tests, Playwright and
 * screenshots, so the fixture behind them has to be a fact rather than a tendency.
 */
describe("QA market-reference seed", () => {
  const sp500 = qaMarketReferenceTradingDays(
    "SP500_INDEX",
    "series-sp500-index",
    TODAY,
  );
  const vix = qaMarketReferenceTradingDays("VIX_INDEX", "series-vix", TODAY);

  it("pins the latest session, the previous close and the seven-session trend", () => {
    // These are the numbers a screenshot records and a Playwright assertion reads. They must not
    // depend on what the real S&P 500 did today.
    expect(sp500.at(-1)?.close).toBe(7637.05);
    expect(sp500.at(-2)?.close).toBe(7551.81);
    expect(sp500.slice(-7).map((row) => row.close)).toEqual([
      7521.35, 7588.02, 7612.3, 7604.77, 7599.18, 7551.81, 7637.05,
    ]);
    expect(
      qaMarketReferenceTradingDays("DJIA_INDEX", "series-djia", TODAY).at(-1)
        ?.close,
    ).toBe(51778.04);
  });

  it("gives VIX a fall, so the negative treatment is covered by data", () => {
    const latest = vix.at(-1)?.close as number;
    const previous = vix.at(-2)?.close as number;
    expect(latest).toBe(15.43);
    expect(previous).toBe(17.71);
    expect(latest).toBeLessThan(previous);
  });

  it("produces weekday sessions only, none in the future, and reruns identically", () => {
    expect(
      qaMarketReferenceTradingDays("SP500_INDEX", "series-sp500-index", TODAY),
    ).toEqual(sp500);
    for (const row of sp500) {
      const weekday = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
      expect(row.date <= TODAY).toBe(true);
    }
    // Ascending and unique, so "the latest session" is unambiguous.
    const dates = sp500.map((row) => row.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("holds the same values whichever weekday it is generated on", () => {
    // The dates slide with the calendar; the closes must not, or every screenshot would differ by
    // the day of the week it was taken on.
    for (const day of [
      "2026-09-14",
      "2026-09-17",
      "2026-09-19",
      "2026-09-20",
    ]) {
      const generated = qaMarketReferenceTradingDays(
        "SP500_INDEX",
        "series-sp500-index",
        day,
      );
      expect(generated.slice(-7).map((row) => row.close)).toEqual(
        sp500.slice(-7).map((row) => row.close),
      );
    }
  });

  it("says VIX has no traded volume rather than inventing one", () => {
    for (const row of vix) {
      expect(row.volume).toBe(0);
      expect(row.close).toBeGreaterThan(0);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.close);
    }
  });

  it("claims coverage over exactly what it generated, for each series independently", async () => {
    const claimed: { seriesId: string; from: string; to: string }[] = [];
    const store = {
      reconcileBenchmarkCatalog: async (entries: readonly { code: string }[]) =>
        entries.map((entry) => ({
          code: entry.code,
          series: { id: `series-${entry.code}` },
        })),
      saveDailyPriceSync: async (input: {
        seriesId: string;
        successfulCoverage: readonly { from: string; to: string }[];
      }) => {
        claimed.push(
          ...input.successfulCoverage.map((range) => ({
            seriesId: input.seriesId,
            ...range,
          })),
        );
      },
    };

    const seeded = await seedQaMarketReferenceDataWith(store as never, TODAY);

    expect(seeded.map((entry) => entry.code)).toEqual([
      "SP500_INDEX",
      "DJIA_INDEX",
      "VIX_INDEX",
    ]);
    expect(claimed).toHaveLength(3);
    // One claim per series, each keyed by its own series id: no seed can write into another's rows.
    expect(new Set(claimed.map((range) => range.seriesId)).size).toBe(3);
    for (const range of claimed) {
      expect(range.to).toBe(TODAY);
      expect(range.from <= TODAY).toBe(true);
    }
    // And never into the backtest benchmark's series.
    expect(claimed.map((range) => range.seriesId)).not.toContain(
      "series-SP500",
    );
  });
});

/**
 * The nineteen ETF fixtures are read twice: by the Dashboard's market overview, and by Strategy
 * Conditions that name an ETF as their data source. The second reader is the demanding one — it
 * refuses a series whose coverage does not reach the history floor, and its longest metrics need
 * two hundred completed weeks — so what it needs of the fixture is proven here, not discovered in a
 * browser run.
 */
describe("QA market-overview ETF seed", () => {
  const xlk = qaMarketOverviewEtfTradingDays("XLK", "series-xlk", TODAY);

  it("writes a weekday history long enough for the 200-week metrics", () => {
    expect(MARKET_OVERVIEW_ETF_WEEKS).toBeGreaterThanOrEqual(208);
    expect(xlk).toHaveLength(MARKET_OVERVIEW_ETF_WEEKS * 5);
    for (const row of xlk) {
      const weekday = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
      expect(row.date < TODAY).toBe(true);
      expect(row.close).toBeGreaterThan(0);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.close);
      expect(row.volume).toBeGreaterThan(0);
    }
    const dates = xlk.map((row) => row.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("holds the same close for a date whichever day it is seeded on", () => {
    // A close is a function of the ticker and the calendar date, so a reseed a week later writes
    // the same bar for every session both runs cover — a screenshot or a pinned backtest result
    // cannot drift with the day the seed ran.
    const later = qaMarketOverviewEtfTradingDays("XLK", "series-xlk", "2026-09-04");
    const byDate = new Map(later.map((row) => [row.date, row.close]));
    const shared = xlk.filter((row) => byDate.has(row.date));
    expect(shared.length).toBeGreaterThan(MARKET_OVERVIEW_ETF_WEEKS * 5 - 10);
    for (const row of shared) {
      expect(byDate.get(row.date)).toBe(row.close);
    }
    expect(qaMarketOverviewEtfTradingDays("XLK", "series-xlk", TODAY)).toEqual(xlk);
  });

  it("claims coverage from the history floor for the nineteen, and never touches SP500", async () => {
    const claimed: { seriesId: string; from: string; to: string }[] = [];
    const tails: { seriesId: string; tailDate: unknown; freshThrough: unknown }[] = [];
    const store = {
      reconcileBenchmarkCatalog: async (entries: readonly { code: string }[]) =>
        entries.map((entry) => ({
          code: entry.code,
          series: { id: `series-${entry.code}` },
        })),
      saveDailyPriceSync: async (input: {
        seriesId: string;
        successfulCoverage: readonly { from: string; to: string }[];
        tailDate?: string;
        freshThrough?: string;
      }) => {
        claimed.push(
          ...input.successfulCoverage.map((range) => ({
            seriesId: input.seriesId,
            ...range,
          })),
        );
        tails.push({
          seriesId: input.seriesId,
          tailDate: input.tailDate,
          freshThrough: input.freshThrough,
        });
      },
    };

    const seeded = await seedQaMarketOverviewEtfDataWith(store as never, TODAY);

    const expected = marketOverviewEtfs()
      .map((etf) => etf.benchmarkCode)
      .filter((code) => code !== "SP500");
    expect(expected).toHaveLength(19);
    expect(seeded.map((entry) => entry.code)).toEqual(expected);
    // One claim a series: from the floor — what an ETF Condition requires before it computes
    // anything, and what the product's own bootstrap establishes — through today.
    expect(claimed).toHaveLength(19);
    expect(new Set(claimed.map((range) => range.seriesId)).size).toBe(19);
    for (const range of claimed) {
      expect(range.from).toBe(MARKET_OVERVIEW_HISTORY_FLOOR);
      expect(range.to).toBe(TODAY);
    }
    // The tail watermark is what proves every stored session was read after it closed.
    for (const tail of tails) {
      expect(tail.tailDate).toBe(TODAY);
      expect(tail.freshThrough).toBe(TODAY);
    }
    // SP500 keeps its own seed and its own, exact claim: it is the backtest benchmark, hydrated on
    // demand, and a floor claim there would hide real history from a real run.
    expect(claimed.map((range) => range.seriesId)).not.toContain("series-SP500");
  });

  it("is evaluable by a Strategy Condition: every one of the twenty technicals has a value at the end", () => {
    // The fixture is fed through the product's own context builder with the state the seed leaves
    // behind: floor-anchored coverage and a tail read after the last session closed.
    const context = buildBenchmarkTechnicalContext({
      seriesId: "series-xlk",
      history: {
        seriesId: "series-xlk",
        rows: xlk,
        basisGeneration: 0,
        source: "POSTGRES",
      } as never,
      refreshState: { lastTailSyncAt: `${TODAY}T12:00:00.000Z` } as never,
      missingFromFloor: [],
      now: new Date(`${TODAY}T12:00:00.000Z`),
      publicationDelayMs: 0,
    });
    expect(context.status).toBe("READY");
    if (context.status !== "READY") {
      return;
    }
    const last = context.snapshot.latestSession as string;
    expect(last).toBe(xlk.at(-1)?.date);
    expect(BENCHMARK_TECHNICAL_FIELDS).toHaveLength(20);
    for (const field of BENCHMARK_TECHNICAL_FIELDS) {
      expect(
        Number.isFinite(benchmarkTechnicalValueOn(context.snapshot, last, field)),
        `${field} on ${last}`,
      ).toBe(true);
    }
    // The two 200-week averages exist for months, not for a single session: a seeded backtest has
    // a real stretch to evaluate them over.
    const with200w = context.snapshot.dates.filter((date) =>
      Number.isFinite(benchmarkTechnicalValueOn(context.snapshot, date, "sma200w")),
    );
    expect(with200w.length).toBeGreaterThanOrEqual(150);
    // And before two hundred completed weeks there is honestly nothing.
    expect(
      Number.isNaN(
        benchmarkTechnicalValueOn(context.snapshot, xlk[199 * 5]!.date, "sma200w"),
      ),
    ).toBe(true);
  });

  it("would be refused without the floor claim, which is exactly what the claim is for", () => {
    const context = buildBenchmarkTechnicalContext({
      seriesId: "series-xlk",
      history: {
        seriesId: "series-xlk",
        rows: xlk,
        basisGeneration: 0,
        source: "POSTGRES",
      } as never,
      refreshState: { lastTailSyncAt: `${TODAY}T12:00:00.000Z` } as never,
      // What `missingBenchmarkCoverage` answers for a series claimed only from its first bar.
      missingFromFloor: [
        { from: MARKET_OVERVIEW_HISTORY_FLOOR, to: "2021-12-31" },
      ],
      now: new Date(`${TODAY}T12:00:00.000Z`),
      publicationDelayMs: 0,
    });
    expect(context.status).toBe("NOT_ANCHORED");
  });
});
