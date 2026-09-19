import { describe, expect, it } from "vitest";
import { testConfiguration } from "./backtest.test-helper";
import { newBacktestHref, readBacktestPrefill, rerunHref } from "./prefill";

describe("backtest prefill", () => {
  it("round-trips every field through the URL", () => {
    const href = newBacktestHref({
      strategyId: "s-1",
      stockListId: "l-1",
      benchmarkCode: "SP500",
      startDate: "2020-01-02",
      endDate: "2024-12-31",
      initialCapital: 25_000,
      monthlyContribution: 250,
      maximumPositions: 8,
      fromRunId: "run-9",
    });
    const url = new URL(href, "https://x.test");
    expect(url.pathname).toBe("/backtests/new");
    expect(readBacktestPrefill(url.searchParams)).toEqual({
      strategyId: "s-1",
      stockListId: "l-1",
      benchmarkCode: "SP500",
      startDate: "2020-01-02",
      endDate: "2024-12-31",
      initialCapital: 25_000,
      monthlyContribution: 250,
      maximumPositions: 8,
      fromRunId: "run-9",
    });
  });

  it("keeps a bare link bare", () => {
    expect(newBacktestHref()).toBe("/backtests/new");
    expect(newBacktestHref({ strategyId: "s-1" })).toBe(
      "/backtests/new?strategyId=s-1",
    );
  });

  it("drops malformed values instead of half-applying them", () => {
    expect(
      readBacktestPrefill(
        new URLSearchParams("start=yesterday&capital=-5&positions=abc&end=2024-01-31"),
      ),
    ).toEqual({ endDate: "2024-01-31" });
  });

  it("reruns from the snapshot and leaves out an entity deleted since", () => {
    const configuration = { ...testConfiguration(), strategyId: null };
    const prefill = readBacktestPrefill(
      new URL(rerunHref("run-1", configuration), "https://x.test").searchParams,
    );
    expect(prefill.strategyId).toBeUndefined();
    expect(prefill.stockListId).toBe(configuration.stockListId);
    expect(prefill.startDate).toBe(configuration.startDate);
    expect(prefill.initialCapital).toBe(configuration.initialCapital);
    expect(prefill.fromRunId).toBe("run-1");
  });
});
