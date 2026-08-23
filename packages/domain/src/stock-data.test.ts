import { describe, expect, it } from "vitest";
import {
  DAILY_MOVING_AVERAGES,
  INTRINSIC_VALUE_BLENDS,
  INTRINSIC_VALUE_MODELS,
  TECHNICAL_TIMEFRAMES,
  WEEKLY_TECHNICAL_BACKTEST_POLICY,
} from "./stock-data.js";

describe("stock data foundation", () => {
  it("defines the agreed daily moving-average catalog", () => {
    expect(DAILY_MOVING_AVERAGES).toEqual([
      { type: "SMA", period: 20, timeframe: "1D" },
      { type: "SMA", period: 50, timeframe: "1D" },
      { type: "SMA", period: 100, timeframe: "1D" },
      { type: "SMA", period: 200, timeframe: "1D" },
      { type: "EMA", period: 20, timeframe: "1D" },
      { type: "EMA", period: 50, timeframe: "1D" },
      { type: "EMA", period: 200, timeframe: "1D" },
    ]);
  });

  it("keeps timeframe explicit and reserves weekly indicators", () => {
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
      INTRINSIC_VALUE_BLENDS.BALANCED.components.some(
        (component) => component.model === "DDM",
      ),
    ).toBe(false);
    expect(
      INTRINSIC_VALUE_BLENDS.CONSERVATIVE.components.some(
        (component) => component.model === "DDM",
      ),
    ).toBe(false);
    expect(
      INTRINSIC_VALUE_BLENDS.DIVIDEND.components.some(
        (component) => component.model === "DDM",
      ),
    ).toBe(true);
  });
});
