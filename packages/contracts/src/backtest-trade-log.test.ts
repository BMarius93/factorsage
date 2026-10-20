import { describe, expect, it } from "vitest";
import {
  BACKTEST_TRADE_ACTIONS,
  BACKTEST_TRADE_DEFAULT_ORDER,
  BACKTEST_TRADE_ORDERS,
  backtestTradesExportFilename,
  type BacktestTradeAction,
} from "./backtests.js";

/**
 * The trade log's filter vocabulary and the export's file name.
 *
 * The file name is shared by the API's `Content-Disposition` header and the browser's download,
 * so what it may contain is a contract rather than a convention: ASCII letters, digits and hyphens,
 * and nothing that would need quoting in a header or escaping on a file system.
 */
describe("the trade log filter vocabulary", () => {
  it("offers every action and nothing else", () => {
    const every: Record<BacktestTradeAction, true> = {
      BUY: true,
      SELL: true,
      FINAL_EXIT: true,
    };
    expect([...BACKTEST_TRADE_ACTIONS].sort()).toEqual(
      Object.keys(every).sort(),
    );
  });

  it("orders newest first by default", () => {
    expect(BACKTEST_TRADE_ORDERS).toContain(BACKTEST_TRADE_DEFAULT_ORDER);
    expect(BACKTEST_TRADE_DEFAULT_ORDER).toBe("desc");
  });
});

describe("backtestTradesExportFilename", () => {
  const runId = "3f2a9c1d-5b7e-4c1a-9e2f-0123456789ab";

  it("names an unfiltered export after the run", () => {
    expect(backtestTradesExportFilename(runId)).toBe(
      "factorsage-trades-3f2a9c1d.csv",
    );
  });

  it("carries the filter and a non-default order in the name", () => {
    expect(
      backtestTradesExportFilename(runId, {
        symbol: "AAPL",
        action: "FINAL_EXIT",
        order: "asc",
      }),
    ).toBe("factorsage-trades-3f2a9c1d-AAPL-final-exit-oldest-first.csv");
    // The default order is not worth a word.
    expect(backtestTradesExportFilename(runId, { order: "desc" })).toBe(
      "factorsage-trades-3f2a9c1d.csv",
    );
  });

  it("reduces any symbol to safe characters", () => {
    expect(backtestTradesExportFilename(runId, { symbol: "BRK.B" })).toBe(
      "factorsage-trades-3f2a9c1d-BRK-B.csv",
    );
    // A hostile value cannot smuggle a quote, a path or a header break into the name.
    const hostile = backtestTradesExportFilename(runId, {
      symbol: '"; filename="../../evil.sh\r\nX-Injected: 1',
    });
    expect(hostile).toMatch(/^[A-Za-z0-9-]+\.csv$/);
    expect(hostile.startsWith("factorsage-trades-3f2a9c1d-")).toBe(true);
    // Nothing safe left in the symbol: the part is dropped rather than left as a dangling hyphen.
    expect(backtestTradesExportFilename(runId, { symbol: "../" })).toBe(
      "factorsage-trades-3f2a9c1d.csv",
    );
  });

  it("bounds the length of every part", () => {
    const name = backtestTradesExportFilename(runId, {
      symbol: "X".repeat(500),
    });
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[A-Za-z0-9-]+\.csv$/);
  });
});
