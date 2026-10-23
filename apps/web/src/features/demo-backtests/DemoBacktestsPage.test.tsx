import type { DemoBacktestResponse } from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoBacktestsPage } from "./DemoBacktestsPage";

/**
 * The public demonstration shelf (entitlements-v2 §4): what a Guest sees of backtesting. It renders
 * the stored headline of each featured report and links to the report; it has no way to start one.
 */

const DEMO: DemoBacktestResponse = {
  title: "Quality pullbacks over thirty years",
  description: "Price above its 200-day average, bought on RSI recoveries.",
  path: "/share/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  url: "https://factorsage.example.test/share/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  completedAt: "2026-10-20T12:00:00.000Z",
  configuration: {
    startDate: "1996-10-21",
    endDate: "2026-10-16",
    benchmark: { code: "SP500", name: "S&P 500" },
    securityCount: 735,
    strategyRuleCount: 6,
  },
  headline: {
    portfolioCagrPercent: 11.24,
    benchmarkCagrPercent: 8.03,
    portfolioReturnPercent: 2_325.5,
    benchmarkReturnPercent: 902.1,
    maxDrawdownPercent: -38.6,
  },
};

describe("DemoBacktestsPage", () => {
  it("lists each featured report with its stored headline and a link to the report", () => {
    render(<DemoBacktestsPage demos={[DEMO]} />);
    const card = screen.getByTestId("demo-backtest");
    expect(within(card).getByText(DEMO.title)).toBeTruthy();
    expect(within(card).getByText(DEMO.description as string)).toBeTruthy();
    expect(within(card).getByTestId("demo-cagr").textContent).toContain("11.2");
    expect(within(card).getByText("735 stocks")).toBeTruthy();
    expect(within(card).getByTestId("demo-open").getAttribute("href")).toBe(DEMO.path);
  });

  it("says so when nothing is featured, rather than showing an empty grid", () => {
    render(<DemoBacktestsPage demos={[]} />);
    expect(screen.getByTestId("demo-backtests-empty")).toBeTruthy();
    expect(screen.queryByTestId("demo-backtests-list")).toBeNull();
  });

  it("offers no way to run, queue or buy a backtest from the shelf itself", () => {
    render(<DemoBacktestsPage demos={[DEMO]} />);
    expect(screen.queryByRole("button")).toBeNull();
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/pricing", DEMO.path]);
  });
});
