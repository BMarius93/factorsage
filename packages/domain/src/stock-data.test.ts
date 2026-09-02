import { describe, expect, it } from "vitest";
import {
  DAILY_MOVING_AVERAGES,
  INTRINSIC_VALUE_BLENDS,
  INTRINSIC_VALUE_MODELS,
  MATERIALIZED_MOVING_AVERAGES,
  TECHNICAL_TIMEFRAMES,
  WEEKLY_MOVING_AVERAGES,
  WEEKLY_TECHNICAL_BACKTEST_POLICY,
} from "./stock-data.js";

describe("stock data foundation", () => {
  it("defines the agreed daily moving-average catalog", () => {
    expect(DAILY_MOVING_AVERAGES).toEqual([
      { type: "SMA", period: 20, timeframe: "1D", field: "sma20d" },
      { type: "SMA", period: 50, timeframe: "1D", field: "sma50d" },
      { type: "SMA", period: 100, timeframe: "1D", field: "sma100d" },
      { type: "SMA", period: 200, timeframe: "1D", field: "sma200d" },
      { type: "EMA", period: 20, timeframe: "1D", field: "ema20d" },
      { type: "EMA", period: 50, timeframe: "1D", field: "ema50d" },
      { type: "EMA", period: 200, timeframe: "1D", field: "ema200d" },
    ]);
  });

  it("defines the agreed weekly moving-average catalog", () => {
    expect(WEEKLY_MOVING_AVERAGES).toEqual([
      { type: "SMA", period: 20, timeframe: "1W", field: "sma20w" },
      { type: "SMA", period: 50, timeframe: "1W", field: "sma50w" },
      { type: "SMA", period: 100, timeframe: "1W", field: "sma100w" },
      { type: "SMA", period: 200, timeframe: "1W", field: "sma200w" },
      { type: "EMA", period: 20, timeframe: "1W", field: "ema20w" },
      { type: "EMA", period: 50, timeframe: "1W", field: "ema50w" },
      { type: "EMA", period: 200, timeframe: "1W", field: "ema200w" },
    ]);
  });

  it("keeps every materialized moving-average identity and field unique", () => {
    // Counts are derived from the registries above, which are themselves the pinned tables: a new
    // period must be added there and nowhere else in this suite.
    const expectedLength =
      DAILY_MOVING_AVERAGES.length + WEEKLY_MOVING_AVERAGES.length;
    expect(MATERIALIZED_MOVING_AVERAGES).toHaveLength(expectedLength);
    const identities = MATERIALIZED_MOVING_AVERAGES.map(
      (average) => `${average.type}(${average.period},${average.timeframe})`,
    );
    expect(new Set(identities).size).toBe(expectedLength);
    const fields = MATERIALIZED_MOVING_AVERAGES.map((average) => average.field);
    expect(new Set(fields).size).toBe(expectedLength);
  });

  it("materializes the daily registry before the weekly one, in registry order", () => {
    // Ordering is load-bearing: it is the order fields are written onto a derived row and the
    // order the API projects them, so it is asserted rather than assumed.
    expect(MATERIALIZED_MOVING_AVERAGES.map((average) => average.field)).toEqual(
      [...DAILY_MOVING_AVERAGES, ...WEEKLY_MOVING_AVERAGES].map(
        (average) => average.field,
      ),
    );
  });

  it("never lets a daily and a weekly indicator share an ambiguous field name", () => {
    for (const average of MATERIALIZED_MOVING_AVERAGES) {
      const suffix = average.timeframe === "1D" ? "d" : "w";
      expect(average.field).toBe(
        `${average.type.toLowerCase()}${average.period}${suffix}`,
      );
    }
  });

  it("keeps timeframe explicit and locks the weekly backtest policy", () => {
    expect(TECHNICAL_TIMEFRAMES).toEqual(["1D", "1W"]);
    expect(WEEKLY_TECHNICAL_BACKTEST_POLICY).toBe("COMPLETED_PERIODS_ONLY");
  });

  it("defines only the agreed V1 intrinsic-value models", () => {
    expect(INTRINSIC_VALUE_MODELS).toEqual([
      "DCF_FCFF",
      "RESIDUAL_INCOME",
      "DDM",
      "GRAHAM",
    ]);
  });

  it.each(Object.values(INTRINSIC_VALUE_BLENDS))(
    "$id blend weights sum to one",
    (blend) => {
      const total = blend.components.reduce(
        (sum, component) => sum + component.weight,
        0,
      );
      expect(total).toBeCloseTo(1, 10);
      expect(blend.version).toBeGreaterThan(0);
    },
  );

  it("keeps DDM out of non-dividend default blends", () => {
    expect(
      INTRINSIC_VALUE_BLENDS.BALANCED.components.map(
        (component) => component.model,
      ),
    ).not.toContain("DDM");
    expect(
      INTRINSIC_VALUE_BLENDS.CONSERVATIVE.components.map(
        (component) => component.model,
      ),
    ).not.toContain("DDM");
    expect(
      INTRINSIC_VALUE_BLENDS.DIVIDEND.components.map(
        (component) => component.model,
      ),
    ).toContain("DDM");
  });
});
