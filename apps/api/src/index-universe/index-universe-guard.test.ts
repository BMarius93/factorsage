import { FmpRequestRefusedError, type FmpRequestBudget } from "@intrinsic/fmp";
import { describe, expect, it } from "vitest";
import {
  directoryEndpointsFor,
  IndexUniverseRequestGuard,
} from "./index-universe-guard.js";

const budget: FmpRequestBudget = {
  consume: async () => undefined,
} as unknown as FmpRequestBudget;

const directory = (path: string) => ({ path, query: {} });

describe("index universe request guard", () => {
  it("admits the run's own index directories and never another index's", () => {
    expect([...directoryEndpointsFor("DOW30")].sort()).toEqual([
      "delisted-companies",
      "dowjones-constituent",
      "historical-dowjones-constituent",
      "symbol-change",
    ]);
    const dow = new IndexUniverseRequestGuard([], budget, "DOW30");
    expect(() =>
      dow.authorize(directory("historical-dowjones-constituent")),
    ).not.toThrow();
    expect(() =>
      dow.authorize(directory("historical-sp500-constituent")),
    ).toThrow(FmpRequestRefusedError);
    const sp500 = new IndexUniverseRequestGuard([], budget);
    expect(() => sp500.authorize(directory("sp500-constituent"))).not.toThrow();
    expect(() => sp500.authorize(directory("nasdaq-constituent"))).toThrow(
      FmpRequestRefusedError,
    );
  });

  it("admits a dividend history only for a symbol in scope", () => {
    const guard = new IndexUniverseRequestGuard(["AAPL"], budget, "SP500");
    expect(() =>
      guard.authorize({ path: "dividends", query: { symbol: "AAPL" } }),
    ).not.toThrow();
    expect(() =>
      guard.authorize({ path: "dividends", query: { symbol: "MSFT" } }),
    ).toThrow(FmpRequestRefusedError);
  });
});
