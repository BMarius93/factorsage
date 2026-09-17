import type { BenchmarkDailyPrice } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  buildMarketOverviewItem,
  unavailableMarketOverviewItem,
} from "./market-overview";

function bar(date: string, close: number): BenchmarkDailyPrice {
  return {
    seriesId: "series-1",
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  };
}

/**
 * The arithmetic behind a market card, with no database, provider or clock in sight.
 *
 * Everything here is a rule that would be invisible if it were wrong: a percentage computed against
 * the wrong bar still looks like a percentage, and a sparkline padded with weekends still looks like
 * a line.
 */
describe("buildMarketOverviewItem", () => {
  const week: BenchmarkDailyPrice[] = [
    bar("2026-09-07", 7400),
    bar("2026-09-08", 7450),
    bar("2026-09-09", 7420),
    bar("2026-09-10", 7480),
    bar("2026-09-11", 7500),
    bar("2026-09-14", 7520),
    bar("2026-09-15", 7510),
    bar("2026-09-16", 7551.81),
    bar("2026-09-17", 7637.05),
  ];

  it("reports the latest session's close and the session it closed on", () => {
    const item = buildMarketOverviewItem("SP500_INDEX", "S&P 500", week);

    expect(item.status).toBe("AVAILABLE");
    expect(item.value).toBe(7637.05);
    expect(item.sessionDate).toBe("2026-09-17");
  });

  it("compares two adjacent sessions, not a wall-clock day", () => {
    const item = buildMarketOverviewItem("SP500_INDEX", "S&P 500", week);

    expect(item.previousClose).toBe(7551.81);
    expect(item.changePercent).toBeCloseTo(1.1287, 4);
  });

  it("compares Friday against Thursday when the latest session is a Friday", () => {
    // The weekend is simply absent from the series. A "24h" change would have compared Friday with
    // a Saturday that does not exist, and a calendar-day lookback would have found nothing at all.
    const throughFriday = week.slice(0, 5);
    const item = buildMarketOverviewItem(
      "SP500_INDEX",
      "S&P 500",
      throughFriday,
    );

    expect(item.sessionDate).toBe("2026-09-11");
    expect(item.previousClose).toBe(7480);
    expect(item.changePercent).toBeCloseTo(((7500 - 7480) / 7480) * 100, 10);
  });

  it("draws the last seven observed sessions, oldest first, with their real dates", () => {
    const item = buildMarketOverviewItem("SP500_INDEX", "S&P 500", week);

    expect(item.sparkline).toHaveLength(7);
    expect(item.sparkline.map((point) => point.date)).toEqual([
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      // The weekend is not padded in: 11th → 14th is one step, exactly as the market moved.
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
    ]);
    expect(item.sparkline.at(-1)?.value).toBe(7637.05);
  });

  it("returns fewer points rather than inventing them when the history is short", () => {
    const item = buildMarketOverviewItem("VIX_INDEX", "VIX", week.slice(-3));

    expect(item.sparkline).toHaveLength(3);
    expect(item.value).toBe(7637.05);
  });

  it("states no percentage at all from a single observation", () => {
    const item = buildMarketOverviewItem("VIX_INDEX", "VIX", [
      bar("2026-09-17", 15.43),
    ]);

    expect(item.status).toBe("AVAILABLE");
    expect(item.value).toBe(15.43);
    // Not zero: zero would claim the market was flat, which one bar cannot support.
    expect(item.changePercent).toBeUndefined();
    expect(item.previousClose).toBeUndefined();
    expect(item.sparkline).toHaveLength(1);
  });

  it("reports a fall as a negative change", () => {
    const item = buildMarketOverviewItem("VIX_INDEX", "VIX", [
      bar("2026-09-16", 17.71),
      bar("2026-09-17", 15.43),
    ]);

    expect(item.changePercent).toBeCloseTo(-12.8741, 4);
  });

  it("orders unsorted provider rows before deciding what 'latest' means", () => {
    const shuffled = [week[8], week[6], week[7]].filter(
      (row): row is BenchmarkDailyPrice => row !== undefined,
    );
    const item = buildMarketOverviewItem("SP500_INDEX", "S&P 500", shuffled);

    expect(item.sessionDate).toBe("2026-09-17");
    expect(item.previousClose).toBe(7551.81);
  });

  it("is unavailable, never fabricated, when there are no sessions", () => {
    const item = buildMarketOverviewItem("DJIA_INDEX", "DJIA", []);

    expect(item).toEqual({
      code: "DJIA_INDEX",
      label: "DJIA",
      status: "UNAVAILABLE",
      sparkline: [],
    });
    expect(item.value).toBeUndefined();
  });

  it("refuses to divide by a zero previous close", () => {
    const item = buildMarketOverviewItem("VIX_INDEX", "VIX", [
      bar("2026-09-16", 0),
      bar("2026-09-17", 15.43),
    ]);

    expect(item.value).toBe(15.43);
    expect(item.changePercent).toBeUndefined();
  });

  it("keeps an unavailable card's identity so the strip keeps its shape", () => {
    expect(unavailableMarketOverviewItem("VIX_INDEX", "VIX")).toEqual({
      code: "VIX_INDEX",
      label: "VIX",
      status: "UNAVAILABLE",
      sparkline: [],
    });
  });
});
