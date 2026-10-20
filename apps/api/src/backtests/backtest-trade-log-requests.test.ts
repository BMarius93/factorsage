import { describe, expect, it } from "vitest";
import { parseTradeLogQuery, parseTradePageRequest } from "./backtest-requests";

/**
 * `?symbol=`, `?action=` and `?order=` on the trade log and its export.
 *
 * Lenient like the paging parameters: nothing here can change state, and a hand-edited or stale
 * link should land on a real log rather than an error. What must never happen is a malformed value
 * being *honoured* — so each case says what it falls back to, and the page response reports it.
 */
describe("parseTradeLogQuery", () => {
  it("defaults to every stock, every action, newest first", () => {
    expect(parseTradeLogQuery({})).toEqual({ order: "desc" });
  });

  it("reads a symbol, an action and an order", () => {
    expect(
      parseTradeLogQuery({ symbol: "AAPL", action: "SELL", order: "asc" }),
    ).toEqual({ symbol: "AAPL", action: "SELL", order: "asc" });
    expect(parseTradeLogQuery({ action: "FINAL_EXIT" })).toEqual({
      action: "FINAL_EXIT",
      order: "desc",
    });
  });

  it("trims a symbol but keeps it exactly otherwise", () => {
    // A symbol is matched as the log prints it; case is not folded, so `brk.b` cannot match
    // `BRK.B` by accident of normalization.
    expect(parseTradeLogQuery({ symbol: "  BRK.B " })).toEqual({
      symbol: "BRK.B",
      order: "desc",
    });
  });

  it("ignores a blank, repeated, non-string or over-long symbol", () => {
    for (const symbol of ["", "   ", ["A", "B"], { a: 1 }, 7, "X".repeat(33)]) {
      expect(parseTradeLogQuery({ symbol })).toEqual({ order: "desc" });
    }
    expect(parseTradeLogQuery({ symbol: "X".repeat(32) }).symbol).toHaveLength(
      32,
    );
  });

  it("reads an action and an order regardless of case", () => {
    expect(parseTradeLogQuery({ action: "buy", order: "ASC" })).toEqual({
      action: "BUY",
      order: "asc",
    });
  });

  it("ignores an action or an order it does not recognise", () => {
    for (const action of ["HOLD", "SELL_ALL", "", ["BUY", "SELL"], 1]) {
      expect(parseTradeLogQuery({ action })).toEqual({ order: "desc" });
    }
    // The end-of-backtest liquidation is a source, not an action: it is found under SELL.
    expect(parseTradeLogQuery({ action: "END_OF_BACKTEST" })).toEqual({
      order: "desc",
    });
    for (const order of ["newest", "ascending", "", ["asc"]]) {
      expect(parseTradeLogQuery({ order })).toEqual({ order: "desc" });
    }
  });
});

describe("parseTradePageRequest", () => {
  it("carries the filter beside the paging", () => {
    expect(
      parseTradePageRequest({
        page: "3",
        pageSize: "100",
        symbol: "MSFT",
        action: "BUY",
        order: "asc",
      }),
    ).toEqual({
      page: 3,
      pageSize: 100,
      symbol: "MSFT",
      action: "BUY",
      order: "asc",
    });
  });

  it("keeps the paging fallbacks it always had", () => {
    expect(parseTradePageRequest({ page: "0", pageSize: "abc" })).toEqual({
      order: "desc",
    });
  });
});
