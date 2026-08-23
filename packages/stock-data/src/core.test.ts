import type {
  DailyPrice,
  IntrinsicValuePoint,
  StockDatasetState,
} from "@intrinsic/domain";
import { INTRINSIC_VALUE_BLENDS } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  addDays,
  advanceDatasetState,
  missingCoverageRanges,
  missingDateRanges,
} from "./dates.js";
import {
  calculateBlend,
  selectIntrinsicValues,
  validateBlendDefinition,
} from "./intrinsic-values.js";
import { calculateDailyTechnicals, movingAverage } from "./technicals.js";
import {
  aggregateCompletedWeeks,
  calculateWeeklyMovingAverage,
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

  it("advances state monotonically and resets derived coverage on version change", () => {
    const advanced = advanceDatasetState(
      state,
      { from: "2005-01-01", to: "2009-12-31" },
      "2026-08-23T10:00:00.000Z",
    );
    expect(advanced).toMatchObject({
      earliestDate: "2005-01-01",
      latestDate: "2026-08-20",
    });

    expect(
      advanceDatasetState(
        { ...state, dataset: "DAILY_TECHNICAL", calculationVersion: 1 },
        { from: "2020-01-01", to: "2020-12-31" },
        "2026-08-23T10:00:00.000Z",
        2,
      ),
    ).toMatchObject({
      earliestDate: "2020-01-01",
      latestDate: "2020-12-31",
      calculationVersion: 2,
    });
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
      calculationVersion: 1,
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
        eligibleDate: "2026-08-17",
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
    expect(aggregateCompletedWeeks(shortened, "2026-08-17")[0]).toMatchObject({
      weekEndDate: "2026-08-13",
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
    const technicals = calculateWeeklyMovingAverage(bars, "SMA", 2, 1);
    expect(technicals).toHaveLength(1);
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
    );

    expect(bars).toEqual([
      expect.objectContaining({
        weekStartDate: "2025-12-29",
        weekEndDate: "2026-01-02",
        eligibleDate: "2026-01-05",
        open: 9,
        close: 12,
      }),
    ]);
  });
});

describe("point-in-time intrinsic values and blends", () => {
  const points: IntrinsicValuePoint[] = [
    {
      securityId: "security-1",
      valuationDate: "2025-01-10",
      sourceDataAsOf: "2025-01-10T15:00:00.000Z",
      model: "DCF_FCFF",
      valuePerShare: 100,
      currency: "USD",
      calculationVersion: 1,
    },
    {
      securityId: "security-1",
      valuationDate: "2025-01-10",
      sourceDataAsOf: "2025-01-10T16:00:00.000Z",
      model: "RESIDUAL_INCOME",
      valuePerShare: 80,
      currency: "USD",
      calculationVersion: 1,
    },
    {
      securityId: "security-1",
      valuationDate: "2025-01-10",
      sourceDataAsOf: "2025-01-11T01:00:00.000Z",
      model: "GRAHAM",
      valuePerShare: 60,
      currency: "USD",
      calculationVersion: 1,
    },
  ];

  it("does not expose source data published after the requested as-of date", () => {
    expect(
      selectIntrinsicValues(points, { asOf: "2025-01-10" }).map(
        (point) => point.model,
      ),
    ).toEqual(["DCF_FCFF", "RESIDUAL_INCOME"]);
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

  it("does not renormalize a missing component, including DDM", () => {
    const dividend = calculateBlend(
      INTRINSIC_VALUE_BLENDS.DIVIDEND,
      points,
      "2025-01-10",
    );
    expect(dividend).toEqual({
      status: "UNAVAILABLE",
      missingModels: ["DDM"],
    });
  });

  it("calculates a versioned blend only when every component is eligible", () => {
    const result = calculateBlend(
      INTRINSIC_VALUE_BLENDS.BALANCED,
      points,
      "2025-01-11",
    );
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.point.valuePerShare).toBe(86);
      expect(result.point.blendVersion).toBe(1);
      expect(result.point.sourceDataAsOf).toBe("2025-01-11T01:00:00.000Z");
    }
  });

  it("selects the highest version shared by every blend component", () => {
    const result = calculateBlend(
      INTRINSIC_VALUE_BLENDS.BALANCED,
      [
        ...points,
        {
          ...points[0]!,
          valuePerShare: 1_000,
          calculationVersion: 2,
        },
      ],
      "2025-01-11",
    );

    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.point.calculationVersion).toBe(1);
      expect(result.point.valuePerShare).toBe(86);
    }
  });
});
