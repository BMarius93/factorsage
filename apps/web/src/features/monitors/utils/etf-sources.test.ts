import type { MonitorEtfSourceStatusResponse } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { etfSourceLines } from "./etf-sources";

describe("etfSourceLines", () => {
  it("says nothing for a Monitor whose strategy reads no ETF", () => {
    expect(etfSourceLines(undefined)).toBeNull();
    expect(etfSourceLines([])).toBeNull();
  });

  it("names each fund's own state: a completed session, a wait, or data that is not there", () => {
    expect(
      etfSourceLines([
        {
          code: "ETF_XLK",
          ticker: "XLK",
          status: "READY",
          latestSession: "2026-10-13",
        },
        { code: "SP500", ticker: "SPY", status: "AWAITING_SESSION" },
        { code: "ETF_GLD", ticker: "GLD", status: "NOT_SYNCHRONIZED" },
        { code: "ETF_TLT", ticker: "TLT", status: "NOT_BOOTSTRAPPED" },
      ]),
    ).toEqual([
      {
        code: "ETF_XLK",
        ticker: "XLK",
        ready: true,
        text: "latest completed session Oct 13, 2026",
      },
      {
        code: "SP500",
        ticker: "SPY",
        ready: false,
        text: "its newest session is not final yet",
      },
      {
        code: "ETF_GLD",
        ticker: "GLD",
        ready: false,
        text: "its market data has not completed a refresh yet, so its rules cannot be evaluated",
      },
      {
        code: "ETF_TLT",
        ticker: "TLT",
        ready: false,
        text: "its market history has not been loaded yet, so its rules cannot be evaluated",
      },
    ]);
  });

  it("reads a status it does not know as unavailable, never as ready", () => {
    expect(
      etfSourceLines([
        {
          code: "ETF_XLF",
          ticker: "XLF",
          status: "SOMETHING_NEW",
        } as unknown as MonitorEtfSourceStatusResponse,
      ]),
    ).toEqual([
      {
        code: "ETF_XLF",
        ticker: "XLF",
        ready: false,
        text: "its market data is not available",
      },
    ]);
  });
});
