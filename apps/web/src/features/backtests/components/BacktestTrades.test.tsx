import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BacktestTradeLogControls } from "../hooks/use-backtest-trades";
import { testTrade } from "../utils/backtest.test-helper";
import { BacktestTrades } from "./BacktestTrades";

function controls(
  overrides: Partial<BacktestTradeLogControls> = {},
): BacktestTradeLogControls {
  return {
    symbol: null,
    action: null,
    order: "desc",
    symbols: ["AAPL", "MSFT", "NVDA"],
    unfilteredCount: 14_268,
    setSymbol: vi.fn(),
    setAction: vi.fn(),
    setOrder: vi.fn(),
    clearFilters: vi.fn(),
    exportCsv: vi.fn(),
    exporting: false,
    exportError: null,
    ...overrides,
  };
}

function paging(totalCount: number) {
  return {
    page: 1,
    pageSize: 50,
    totalCount,
    onPageChange: vi.fn(),
    onPageSizeChange: vi.fn(),
  };
}

const TRADES = [
  testTrade({ sequence: 3, date: "2026-10-12", symbol: "NVDA" }),
  testTrade({
    sequence: 2,
    date: "2026-10-09",
    symbol: "AAPL",
    action: "SELL",
    levelPercentage: 50,
  }),
  testTrade({
    sequence: 1,
    date: "2026-10-08",
    symbol: "MSFT",
    action: "SELL",
    source: "END_OF_BACKTEST",
    levelPercentage: null,
    reason: { kind: "END_OF_BACKTEST" },
  }),
];

function rowSequences(): string[] {
  return screen
    .getAllByTestId("backtest-trade-row")
    .map(
      (row) => row.querySelector("[data-card='identity']")?.textContent ?? "",
    );
}

describe("BacktestTrades — the running page's recent trades", () => {
  it("stays the bounded list it was: no filters, no export, the date under the symbol", () => {
    render(
      <BacktestTrades
        trades={[...TRADES].reverse()}
        title="Recent trades"
        emptyMessage="No trades have been executed yet."
        truncatedFrom={40}
      />,
    );
    expect(screen.queryByTestId("backtest-trades-toolbar")).toBeNull();
    expect(screen.queryByTestId("backtest-trades-export")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /Date/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "About buy and sell percentages" }),
    ).toBeNull();
    // Newest first, whatever order the snapshot carried them in.
    expect(rowSequences()).toEqual([
      expect.stringContaining("NVDA"),
      expect.stringContaining("AAPL"),
      expect.stringContaining("MSFT"),
    ]);
    expect(rowSequences()[0]).toContain("Oct 12, 2026");
    expect(screen.getByText("3 of 40")).toBeTruthy();
  });
});

describe("BacktestTrades — a completed run's log", () => {
  function renderLog(
    overrides: Partial<BacktestTradeLogControls> = {},
    totalCount = 120,
    trades = TRADES,
  ) {
    const log = controls(overrides);
    render(
      <BacktestTrades
        trades={trades}
        title="Trade log"
        emptyMessage="This run made no trades."
        paging={paging(totalCount)}
        controls={log}
      />,
    );
    return log;
  }

  it("reads the date as its own sortable column, newest first by default", () => {
    const log = renderLog();
    const header = screen.getByRole("columnheader", { name: /Date/ });
    expect(header.getAttribute("aria-sort")).toBe("descending");
    const firstRow = screen.getAllByTestId("backtest-trade-row")[0];
    expect(
      firstRow
        ?.querySelector("[data-testid='backtest-trade-date']")
        ?.getAttribute("dateTime"),
    ).toBe("2026-10-12");
    // The identity reads mark, ticker and company now that the date has a column.
    expect(
      firstRow?.querySelector("[data-card='identity']")?.textContent,
    ).toContain("QA Test One");
    // Where the Date column folds (880–1,279px) the same date reads under the stock instead.
    const folded = firstRow?.querySelector(
      "[data-testid='backtest-trade-folded-date'] time",
    );
    expect(folded?.closest("td")?.getAttribute("data-column")).toBe("stock");
    expect(folded?.getAttribute("dateTime")).toBe("2026-10-12");

    fireEvent.click(within(header).getByRole("button"));
    expect(log.setOrder).toHaveBeenCalledWith("asc");
  });

  it("draws the rows in the server's oldest-first order and says so", () => {
    renderLog({ order: "asc" }, 120, [...TRADES].reverse());
    expect(
      screen
        .getByRole("columnheader", { name: /Date/ })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(
      screen
        .getAllByTestId("backtest-trade-date")
        .map((date) => date.getAttribute("dateTime")),
    ).toEqual(["2026-10-08", "2026-10-09", "2026-10-12"]);
    expect(
      (screen.getByTestId("backtest-trades-order") as HTMLSelectElement).value,
    ).toBe("asc");
  });

  it("filters by action and by stock through the URL-backed controls", () => {
    const log = renderLog();
    const actions = screen.getByTestId("backtest-trades-action-filter");
    fireEvent.click(within(actions).getByRole("button", { name: "Sell" }));
    expect(log.setAction).toHaveBeenCalledWith("SELL");
    fireEvent.click(
      within(actions).getByRole("button", { name: "Final exit" }),
    );
    expect(log.setAction).toHaveBeenCalledWith("FINAL_EXIT");

    const stock = screen.getByTestId(
      "backtest-trades-symbol-filter",
    ) as HTMLSelectElement;
    expect([...stock.options].map((option) => option.textContent)).toEqual([
      "All stocks",
      "AAPL",
      "MSFT",
      "NVDA",
    ]);
    fireEvent.change(stock, { target: { value: "MSFT" } });
    expect(log.setSymbol).toHaveBeenCalledWith("MSFT");

    fireEvent.change(screen.getByTestId("backtest-trades-order"), {
      target: { value: "asc" },
    });
    expect(log.setOrder).toHaveBeenCalledWith("asc");
  });

  it("returns to every action and every stock", () => {
    const log = renderLog({ action: "BUY", symbol: "AAPL" });
    fireEvent.click(
      within(screen.getByTestId("backtest-trades-action-filter")).getByRole(
        "button",
        { name: "All" },
      ),
    );
    expect(log.setAction).toHaveBeenCalledWith(null);
    fireEvent.change(screen.getByTestId("backtest-trades-symbol-filter"), {
      target: { value: "" },
    });
    expect(log.setSymbol).toHaveBeenCalledWith(null);
  });

  it("counts the filtered trades against the run's, and offers the reset", () => {
    const log = renderLog({ action: "SELL", symbol: "AAPL" }, 1_234);
    expect(
      screen.getByTestId("backtest-trades-filter-summary").textContent,
    ).toContain("1,234 of 14,268 trades match");
    expect(screen.getByRole("status").textContent).toBe(
      "1,234 of 14,268 trades match",
    );
    expect(screen.getByTestId("backtest-trades-footer").textContent).toContain(
      "of 1234 trades",
    );
    fireEvent.click(screen.getByTestId("backtest-trades-clear-filters"));
    expect(log.clearFilters).toHaveBeenCalledTimes(1);
  });

  it("says nothing about matches when nothing is filtered", () => {
    renderLog();
    expect(screen.queryByTestId("backtest-trades-filter-summary")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows the filtered-empty state, not 'No trades', when a filter matches nothing", () => {
    const log = renderLog({ symbol: "AAPL", action: "FINAL_EXIT" }, 0, []);
    const empty = screen.getByTestId("backtest-trades-filtered-empty");
    expect(empty.textContent).toContain("No trades match these filters");
    expect(screen.queryByTestId("backtest-trades-empty")).toBeNull();
    expect(screen.queryByTestId("backtest-trades-footer")).toBeNull();
    // One reset, in the empty state.
    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    expect(clear).toHaveLength(1);
    fireEvent.click(clear[0] as HTMLElement);
    expect(log.clearFilters).toHaveBeenCalledTimes(1);
  });

  it("keeps 'No trades' for a run that genuinely traded nothing", () => {
    renderLog({}, 0, []);
    expect(screen.getByTestId("backtest-trades-empty").textContent).toContain(
      "No trades",
    );
    expect(screen.queryByTestId("backtest-trades-filtered-empty")).toBeNull();
  });

  it("asks for the export of the whole filtered log", () => {
    const log = renderLog();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(log.exportCsv).toHaveBeenCalledTimes(1);
  });

  it("disables the export while one is being written", () => {
    renderLog({ exporting: true });
    const button = screen.getByTestId("backtest-trades-export");
    expect(button.textContent).toBe("Exporting…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("announces a failed export", () => {
    renderLog({
      exportError: "Too many requests. Please try again in 2 minutes.",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Too many requests. Please try again in 2 minutes.",
    );
  });

  it("explains what the percentages mean, beside the action filter", () => {
    renderLog();
    fireEvent.click(
      screen.getByRole("button", { name: "About buy and sell percentages" }),
    );
    const tip = screen.getByRole("tooltip").textContent ?? "";
    expect(tip).toContain(
      "Buy 25% fills a position up to a quarter of a full position",
    );
    expect(tip).toContain("divided by the run's maximum positions");
    expect(tip).toContain("Sell 50% sells half of the shares still held");
    // The action badges themselves are unchanged.
    expect(
      screen.getAllByTestId("backtest-trade-row")[1]?.textContent,
    ).toContain("Sell 50%");
    expect(
      screen.getAllByTestId("backtest-trade-row")[2]?.textContent,
    ).toContain("Sell 100%");
  });
});
