import type {
  DailyDerivedState,
  DailyPrice,
  StockDatasetState,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  addDays,
  advanceDatasetState,
  missingCoverageRanges,
  missingDateRanges,
} from "./dates.js";
import {
  assertOneRowPerTradingDay,
  buildDailyDerivedState,
} from "./derived-state.js";
import { INTRINSIC_VALUE_BLENDS } from "@intrinsic/domain";
import { calculateBlend } from "@intrinsic/valuation";
import { validateBlendDefinition } from "./intrinsic-values.js";
import { calculateDailyTechnicals, movingAverage } from "./technicals.js";
import {
  aggregateCompletedWeeks,
  calculateWeeklyTechnicalValues,
  latestCompletedWeeklyBar,
} from "./weekly.js";

function price(
  date: string,
  close: number,
  overrides: Partial<DailyPrice> = {},
): DailyPrice {
  return {
    securityId: "security-1",
    date,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100,
    ...overrides,
  };
}

describe("range-aware loading", () => {
  const state: StockDatasetState = {
    securityId: "security-1",
    dataset: "DAILY_PRICE",
    earliestDate: "2010-01-01",
    latestDate: "2026-08-20",
    lastSyncedAt: "2026-08-20T20:00:00.000Z",
  };

  it("loads the bounded request for an empty database", () => {
    expect(
      missingDateRanges({ from: "2020-01-01", to: "2020-12-31" }, null),
    ).toEqual([{ from: "2020-01-01", to: "2020-12-31" }]);
  });

  it("returns no delta for a full hit or bounded historical range", () => {
    expect(
      missingDateRanges({ from: "2011-01-01", to: "2020-01-01" }, state),
    ).toEqual([]);
    expect(
      missingDateRanges({ from: "2010-01-01", to: "2026-08-20" }, state),
    ).toEqual([]);
  });

  it("loads only a missing prefix", () => {
    expect(
      missingDateRanges({ from: "2005-01-01", to: "2020-01-01" }, state),
    ).toEqual([{ from: "2005-01-01", to: "2009-12-31" }]);
  });

  it("loads only a missing suffix", () => {
    expect(
      missingDateRanges({ from: "2010-01-01", to: "2026-08-23" }, state),
    ).toEqual([{ from: "2026-08-21", to: "2026-08-23" }]);
  });

  it("finds an internal unfetched interval without expecting trading-day rows", () => {
    expect(
      missingCoverageRanges({ from: "2026-08-01", to: "2026-08-31" }, [
        { from: "2026-08-01", to: "2026-08-10" },
        { from: "2026-08-15", to: "2026-08-31" },
      ]),
    ).toEqual([{ from: "2026-08-11", to: "2026-08-14" }]);
  });

  it("advances state monotonically and never records a methodology version", () => {
    const advanced = advanceDatasetState(
      state,
      { from: "2005-01-01", to: "2009-12-31" },
      "2026-08-23T10:00:00.000Z",
    );
    expect(advanced).toMatchObject({
      earliestDate: "2005-01-01",
      latestDate: "2026-08-20",
    });

    const derived = advanceDatasetState(
      { ...state, dataset: "DAILY_DERIVED_STATE" },
      { from: "2020-01-01", to: "2020-12-31" },
      "2026-08-23T10:00:00.000Z",
    );
    expect(derived).toMatchObject({
      earliestDate: "2010-01-01",
      latestDate: "2026-08-20",
    });
    expect(derived).not.toHaveProperty("calculationVersion");
  });
});

describe("daily moving averages", () => {
  const closes = Array.from({ length: 220 }, (_, index) => index + 1);

  it.each([20, 50, 100, 200])(
    "calculates SMA%d with unavailable warm-up",
    (period) => {
      const values = movingAverage(closes, "SMA", period);
      expect(values[period - 2]).toBeUndefined();
      expect(values[period - 1]).toBe((1 + period) / 2);
      expect(values.at(-1)).toBe((221 - period + 220) / 2);
    },
  );

  it.each([20, 50, 200])(
    "seeds EMA%d with the first complete-window SMA",
    (period) => {
      const values = movingAverage(closes, "EMA", period);
      expect(values[period - 2]).toBeUndefined();
      expect(values[period - 1]).toBe((1 + period) / 2);
      expect(values[period]).toBeCloseTo((period + 3) / 2);
    },
  );

  it("serializes only timeframe-explicit daily names and never zero warm-up", () => {
    const rows = calculateDailyTechnicals(
      closes.map((close, index) =>
        price(
          `2020-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
          close,
        ),
      ),
    );
    expect(rows[0]).toEqual({
      securityId: "security-1",
      date: "2020-01-01",
    });
    expect(rows[19]?.sma20d).toBe(10.5);
    expect(rows[19]).not.toHaveProperty("sma20");
  });

  it("produces identical canonical history regardless of price delta order", () => {
    const ascending = closes.map((close, index) =>
      price(
        `2020-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        close,
      ),
    );
    const shuffled = [
      ...ascending.filter((_, index) => index % 2 === 1),
      ...ascending.filter((_, index) => index % 2 === 0),
    ];

    expect(calculateDailyTechnicals(shuffled)).toEqual(
      calculateDailyTechnicals(ascending),
    );
  });
});

describe("weekly semantics", () => {
  const normalWeek = [
    price("2026-08-10", 11, { open: 10, high: 12, low: 9, volume: 100 }),
    price("2026-08-11", 12, { open: 11, high: 14, low: 10, volume: 200 }),
    price("2026-08-12", 13, { open: 12, high: 15, low: 11, volume: 300 }),
    price("2026-08-13", 14, { open: 13, high: 16, low: 12, volume: 400 }),
    price("2026-08-14", 15, { open: 14, high: 17, low: 13, volume: 500 }),
  ];

  it("aggregates OHLCV and excludes the unfinished current week", () => {
    const bars = aggregateCompletedWeeks(
      [...normalWeek, price("2026-08-17", 99)],
      "2026-08-20",
    );
    expect(bars).toEqual([
      expect.objectContaining({
        weekStartDate: "2026-08-10",
        weekEndDate: "2026-08-14",
        // End-of-day state: the week becomes effective on its own final trading day's close.
        eligibleDate: "2026-08-14",
        open: 10,
        high: 17,
        low: 9,
        close: 15,
        volume: 1500,
      }),
    ]);
  });

  it("treats a holiday-shortened week as complete only in the following week", () => {
    const shortened = normalWeek.slice(0, 4);
    expect(aggregateCompletedWeeks(shortened, "2026-08-13")).toEqual([]);
    // The actual final trading day is Thursday, so that is when the week becomes effective.
    expect(aggregateCompletedWeeks(shortened, "2026-08-17")[0]).toMatchObject({
      weekEndDate: "2026-08-13",
      eligibleDate: "2026-08-13",
      close: 14,
      volume: 1000,
    });
  });

  it("calculates weekly averages from weekly closes and enforces no-look-ahead", () => {
    const bars = aggregateCompletedWeeks(
      [
        ...normalWeek.map((row) => ({ ...row, date: addDays(row.date, -7) })),
        ...normalWeek,
      ],
      "2026-08-17",
    );
    // The production path calculates every registered weekly series over the weekly closes; with
    // two completed bars only the shortest catalog period could ever warm up, and it does not.
    const values = calculateWeeklyTechnicalValues(bars);
    expect(bars).toHaveLength(2);
    expect(values.get("2026-08-03")).toEqual({});
    expect(values.get("2026-08-10")).toEqual({});

    expect(latestCompletedWeeklyBar(bars, "2026-08-13")?.weekStartDate).toBe(
      "2026-08-03",
    );
    expect(latestCompletedWeeklyBar(bars, "2026-08-17")?.weekStartDate).toBe(
      "2026-08-10",
    );
  });

  it("handles an IPO mid-week and a week crossing calendar years", () => {
    const bars = aggregateCompletedWeeks(
      [
        price("2025-12-30", 10, { open: 9 }),
        price("2025-12-31", 11),
        price("2026-01-02", 12),
      ],
      "2026-01-05",
      { historyStart: "2025-12-30", historyStartOrigin: "LISTING" },
    );

    expect(bars).toEqual([
      expect.objectContaining({
        weekStartDate: "2025-12-29",
        weekEndDate: "2026-01-02",
        eligibleDate: "2026-01-02",
        open: 9,
        close: 12,
      }),
    ]);
  });

  it("drops only the artificial partial first week at the history horizon", () => {
    const prices = [
      price("2026-08-12", 10),
      price("2026-08-13", 11),
      price("2026-08-14", 12),
      ...normalWeek.map((row) => ({ ...row, date: addDays(row.date, 7) })),
    ];

    expect(
      aggregateCompletedWeeks(prices, "2026-08-24", {
        historyStart: "2026-08-12",
        historyStartOrigin: "HORIZON",
      }).map((bar) => bar.weekStartDate),
    ).toEqual(["2026-08-17"]);
    expect(
      aggregateCompletedWeeks(prices.slice(0, 3), "2026-08-17", {
        historyStart: "2026-08-12",
        historyStartOrigin: "LISTING",
      }).map((bar) => bar.weekStartDate),
    ).toEqual(["2026-08-10"]);
  });
});

describe("unified daily derived state", () => {
  const week1 = [
    price("2026-08-10", 11, { open: 10, high: 12, low: 9, volume: 100 }),
    price("2026-08-11", 12),
    price("2026-08-12", 13),
    price("2026-08-13", 14),
    price("2026-08-14", 15),
  ];
  const week2 = [
    price("2026-08-17", 16),
    price("2026-08-18", 17),
    price("2026-08-19", 18),
    price("2026-08-20", 19),
    price("2026-08-21", 20),
  ];
  const week3 = [price("2026-08-24", 21), price("2026-08-25", 22)];
  const prices = [...week1, ...week2, ...week3];

  it("materializes exactly one row per trading day, ascending", () => {
    const rows = buildDailyDerivedState({
      prices,
      weeklyBars: aggregateCompletedWeeks(prices, "2026-08-25"),
    });

    expect(rows.map((row) => row.date)).toEqual(
      prices.map((row) => row.date).sort(),
    );
    expect(new Set(rows.map((row) => row.date)).size).toBe(rows.length);
    expect(() => assertOneRowPerTradingDay(rows)).not.toThrow();
  });

  it("rejects duplicate methodology rows for the same trading day", () => {
    const rows = buildDailyDerivedState({ prices: week1 });
    expect(() =>
      assertOneRowPerTradingDay([...rows, { ...rows[0]! }]),
    ).toThrow("exactly one row per trading day");
  });

  it("repeats the completed-week source on each later trading day until a newer week completes", () => {
    const rows = buildDailyDerivedState({
      prices,
      weeklyBars: aggregateCompletedWeeks(prices, "2026-08-25"),
    });
    const sources = Object.fromEntries(
      rows.map((row) => [row.date, row.weeklySourceWeekStart]),
    );

    // Monday-Thursday cannot see the close that completes their own week.
    expect(sources["2026-08-10"]).toBeUndefined();
    expect(sources["2026-08-13"]).toBeUndefined();
    // The week becomes effective at its own final trading day's close.
    expect(sources["2026-08-14"]).toBe("2026-08-10");
    // It then repeats until a newer week completes; repetition is intentional materialization.
    expect(sources["2026-08-17"]).toBe("2026-08-10");
    expect(sources["2026-08-20"]).toBe("2026-08-10");
    expect(sources["2026-08-21"]).toBe("2026-08-17");
    expect(sources["2026-08-24"]).toBe("2026-08-17");
    expect(sources["2026-08-25"]).toBe("2026-08-17");
  });

  it("carries a holiday-shortened week from its actual final trading day", async () => {
    // Week 2 ends on Thursday; Friday is a holiday.
    const shortened = [...week1, ...week2.slice(0, 4), price("2026-08-24", 21)];
    const rows = buildDailyDerivedState({
      prices: shortened,
      weeklyBars: aggregateCompletedWeeks(shortened, "2026-08-24"),
    });
    const sources = Object.fromEntries(
      rows.map((row) => [row.date, row.weeklySourceWeekStart]),
    );

    expect(sources["2026-08-19"]).toBe("2026-08-10");
    // Thursday is the final trading day of the shortened week, so it becomes effective there.
    expect(sources["2026-08-20"]).toBe("2026-08-17");
    expect(sources["2026-08-24"]).toBe("2026-08-17");
  });

  it("never exposes a value from a week that is still in progress", () => {
    const rows = buildDailyDerivedState({
      prices: week1,
      weeklyBars: aggregateCompletedWeeks(week1, "2026-08-14"),
    });
    expect(
      rows.every((row) => row.weeklySourceWeekStart === undefined),
    ).toBe(true);
  });

  it("leaves intrinsic values absent until a valuation methodology materializes them", () => {
    const rows = buildDailyDerivedState({ prices });
    expect(
      rows.every(
        (row) =>
          row.intrinsicValues === undefined &&
          row.intrinsicValueBlends === undefined &&
          row.dcfFcffSourceAsOf === undefined &&
          row.residualIncomeSourceAsOf === undefined &&
          row.ddmSourceAsOf === undefined &&
          row.grahamSourceAsOf === undefined,
      ),
    ).toBe(true);
  });

  it("keeps (securityId, date) as the only identity when models are sourced separately", () => {
    // Per-model provenance is column data, never an identity or history dimension.
    const row: DailyDerivedState = {
      securityId: "security-1",
      date: "2026-05-05",
      intrinsicValues: { DCF_FCFF: 120, GRAHAM: 60 },
      dcfFcffSourceAsOf: "2026-05-02T20:00:00.000Z",
      grahamSourceAsOf: "2026-04-21T20:00:00.000Z",
      intrinsicCurrency: "USD",
    };

    expect(() => assertOneRowPerTradingDay([row])).not.toThrow();
    expect(() =>
      assertOneRowPerTradingDay([
        row,
        { ...row, grahamSourceAsOf: "2026-05-04T20:00:00.000Z" },
      ]),
    ).toThrow("exactly one row per trading day");
  });

  it("merges materialized intrinsic state by exact trading date", () => {
    const intrinsicStates = [
      {
        date: "2026-08-11",
        intrinsicValues: { DCF_FCFF: 180, GRAHAM: 148 },
        intrinsicValueBlends: { BALANCED: 160 },
        dcfFcffSourceAsOf: "2026-08-10T00:00:00.000Z",
        grahamSourceAsOf: "2026-06-01T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
      // No DailyPrice exists for this date, so it must not create a derived row.
      {
        date: "2026-08-15",
        intrinsicValues: { DCF_FCFF: 999 },
        dcfFcffSourceAsOf: "2026-08-15T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
    ];

    const rows = buildDailyDerivedState({ prices, intrinsicStates });

    expect(rows.map((row) => row.date)).toEqual(prices.map((row) => row.date));
    expect(rows.find((row) => row.date === "2026-08-11")).toMatchObject({
      intrinsicValues: { DCF_FCFF: 180, GRAHAM: 148 },
      intrinsicValueBlends: { BALANCED: 160 },
      dcfFcffSourceAsOf: "2026-08-10T00:00:00.000Z",
      grahamSourceAsOf: "2026-06-01T00:00:00.000Z",
      intrinsicCurrency: "USD",
    });
    // Only the matching trading day carries intrinsic fields, and the merge key is not a field.
    expect(rows.find((row) => row.date === "2026-08-11")).not.toHaveProperty(
      "residualIncomeSourceAsOf",
    );
    expect(
      rows.find((row) => row.date === "2026-08-12")?.intrinsicValues,
    ).toBeUndefined();
  });

  it("does not let intrinsic merging change technicals or weekly eligibility", () => {
    const weeklyBars = aggregateCompletedWeeks(prices, "2026-08-25");
    const withoutIntrinsic = buildDailyDerivedState({ prices, weeklyBars });
    const withIntrinsic = buildDailyDerivedState({
      prices,
      weeklyBars,
      intrinsicStates: [
        {
          date: "2026-08-11",
          intrinsicValues: { DCF_FCFF: 180 },
          dcfFcffSourceAsOf: "2026-08-10T00:00:00.000Z",
          intrinsicCurrency: "USD",
        },
      ],
    });

    expect(
      withIntrinsic.map(({ intrinsicValues: _values, ...row }) => ({
        ...row,
        dcfFcffSourceAsOf: undefined,
        intrinsicCurrency: undefined,
      })),
    ).toEqual(
      withoutIntrinsic.map((row) => ({
        ...row,
        dcfFcffSourceAsOf: undefined,
        intrinsicCurrency: undefined,
      })),
    );
  });

  it("carries no calculation version on any derived row", () => {
    for (const row of buildDailyDerivedState({ prices })) {
      expect(row).not.toHaveProperty("calculationVersion");
    }
  });

  it("keeps securityId, never symbol, as the derived historical identity", () => {
    const rows = buildDailyDerivedState({ prices });
    expect(rows.every((row) => row.securityId === "security-1")).toBe(true);
    expect(rows[0]).not.toHaveProperty("symbol");
  });

  /**
   * The canonical blend definitions live in `@intrinsic/domain` and the pure weighted-sum lives in
   * `@intrinsic/valuation`; neither package restates the other's part. This is the one place both
   * meet, so it proves the real definitions are structurally consumable and reproduce the locked
   * golden blend values from `docs/decisions/intrinsic-value-engine.md`.
   */
  it("feeds the canonical domain blend definitions straight into the pure calculator", () => {
    const components = {
      DCF_FCFF: 178.8977101328,
      RESIDUAL_INCOME: 99.1837933641,
      GRAHAM: 148,
      DDM: 27.3333333333,
    };

    for (const [blendId, expected] of [
      ["BALANCED", 148.8039930756],
      ["CONSERVATIVE", 145.7142220623],
      ["DIVIDEND", 102.3291760593],
    ] as const) {
      const blend = calculateBlend(INTRINSIC_VALUE_BLENDS[blendId], components);

      expect(blend.status).toBe("CALCULATED");
      expect(blend.status === "CALCULATED" && blend.value.valuePerShare).toBeCloseTo(
        expected,
        9,
      );
    }
  });

  it("validates blend weights", () => {
    expect(() =>
      validateBlendDefinition({
        id: "BALANCED",
        version: 2,
        components: [{ model: "DCF_FCFF", weight: 0.9 }],
      }),
    ).toThrow("weights must sum to 1");
  });
});
