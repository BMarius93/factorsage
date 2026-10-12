import type { DashboardRowResponse } from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardOverview } from "./DashboardOverview";

function row(
  overrides: Partial<DashboardRowResponse> = {},
): DashboardRowResponse {
  return {
    id: `row-${Math.random()}`,
    state: "ACTIVE",
    security: {
      id: "sec-1",
      symbol: "QATEST1",
      name: "QA Test One",
      exchangeCode: "NASDAQ",
    },
    levelKind: "BUY",
    reasons: [],
    monitor: { id: "m-1", name: "Monitor", ownership: "SYSTEM" },
    strategy: { id: "s-1", name: "Strategy" },
    stockList: { id: "l-1", name: "List" },
    since: "2026-09-16T12:00:00.000Z",
    reconstructed: false,
    ...overrides,
  };
}

function renderOverview(rows: DashboardRowResponse[] = [], rowsReady = true) {
  render(<DashboardOverview rows={rows} rowsReady={rowsReady} />);
}

/**
 * The Dashboard's opening strip.
 *
 * What it holds is asserted literally, because it is the product decision: one card, the current
 * match count. The market lives in the market overview below and a backtest is started from the
 * Backtests area, so a market card or a `Run Backtest` action creeping back into this strip is
 * exactly the failure these tests exist to catch.
 */
describe("DashboardOverview", () => {
  it("holds exactly one card: the current match count", () => {
    renderOverview();

    const card = screen.getByTestId("dashboard-matches-card");
    const grid = card.parentElement as HTMLElement;
    expect([...grid.children]).toEqual([card]);
    expect(card.textContent).toContain("Current matches");
  });

  it("offers no Run Backtest action: backtests start from the Backtests area", () => {
    renderOverview();

    const strip = screen.getByTestId("dashboard-overview");
    expect(screen.queryByTestId("dashboard-run-backtest")).toBeNull();
    expect(within(strip).queryByText(/backtest/i)).toBeNull();
    expect(within(strip).queryAllByRole("button")).toHaveLength(0);
    // The one link in the strip stays on the Dashboard.
    expect(
      within(strip)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["#signals"]);
  });

  it("carries no market card: the market overview below replaced them", () => {
    renderOverview();

    const strip = screen.getByTestId("dashboard-overview");
    for (const forbidden of [/S&P 500/, /DJIA/, /VIX/, /nasdaq/i, /fear/i, /greed/i]) {
      expect(within(strip).queryByText(forbidden)).toBeNull();
    }
    expect(screen.queryByTestId(/^dashboard-market-card-/)).toBeNull();
  });

  it("counts every current row the viewer's dashboard returned", () => {
    renderOverview([
      row({ id: "a", state: "ACTIVE" }),
      row({ id: "b", state: "ACTIVE" }),
      row({ id: "c", state: "PENDING_TRIGGER" }),
      row({ id: "d", state: "PENDING_TRIGGER" }),
      row({ id: "e", state: "PENDING_TRIGGER" }),
    ]);

    expect(screen.getByTestId("dashboard-matches-total").textContent).toBe("5");
    expect(screen.getByTestId("dashboard-matches-breakdown").textContent).toBe(
      "2 active · 3 waiting",
    );
  });

  it("holds the count back until the dashboard has actually answered", () => {
    renderOverview([], false);

    // A premature 0 reads as "nothing is matching", which is a different statement from "not known
    // yet" and the one thing a count must never say by accident.
    expect(screen.queryByTestId("dashboard-matches-total")).toBeNull();
  });

  it("points at the signals section rather than navigating away", () => {
    renderOverview([row()]);

    expect(
      screen.getByTestId("dashboard-matches-card").getAttribute("href"),
    ).toBe("#signals");
  });
});
