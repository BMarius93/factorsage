import type { DailyPriceResponse } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { summarizePrices } from "./price-summary";

function bar(
  date: string,
  close: number,
  overrides: Partial<DailyPriceResponse> = {},
): DailyPriceResponse {
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
    ...overrides,
  };
}

describe("summarizePrices", () => {
  it("derives the latest close and the change against the previous trading day", () => {
    const summary = summarizePrices([
      bar("2026-08-26", 100),
      bar("2026-08-27", 200),
      bar("2026-08-28", 205, { volume: 41_237_500 }),
    ]);

    expect(summary).toMatchObject({
      latestClose: 205,
      latestDate: "2026-08-28",
      latestVolume: 41_237_500,
      dayHigh: 206,
      dayLow: 204,
    });
    expect(summary?.change).toEqual({
      absolute: 5,
      fraction: 0.025,
      previousClose: 200,
      previousDate: "2026-08-27",
    });
  });

  it("tracks the window high and low across all supplied rows", () => {
    const summary = summarizePrices([
      bar("2026-01-05", 90, { high: 120, low: 80 }),
      bar("2026-08-28", 100),
    ]);

    expect(summary?.windowHigh).toBe(120);
    expect(summary?.windowLow).toBe(80);
  });

  it("omits the change when only one trading day is available", () => {
    const summary = summarizePrices([bar("2026-08-28", 100)]);

    expect(summary?.latestClose).toBe(100);
    expect(summary?.change).toBeUndefined();
  });

  it("returns undefined for an empty window", () => {
    expect(summarizePrices([])).toBeUndefined();
  });
});
