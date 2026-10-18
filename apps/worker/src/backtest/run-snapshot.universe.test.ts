import {
  BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS,
  BACKTEST_MAX_SECURITIES,
  BACKTEST_SNAPSHOT_VERSION,
} from "@intrinsic/contracts";
import { BACKTEST_DATA_REVISIONS } from "@intrinsic/stock-data";
import { BACKTEST_METHODOLOGY } from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { parseRunSnapshot } from "./run-snapshot.js";

/**
 * The engine's ceilings, re-checked where a run executes
 * (`docs/decisions/sp500-historical-pit-v1.md` §5): a snapshot no API build would have written is
 * refused before a single security is prepared.
 */

type Member = {
  buyWindowMode: "FULL" | "CUSTOM";
  buyWindows: { startDate: string; endDate: string | null }[];
};

function member(index: number, window: Member = { buyWindowMode: "FULL", buyWindows: [] }) {
  return {
    securityId: `security-${index}`,
    symbol: `S${String(index).padStart(4, "0")}`,
    name: `Security ${index}`,
    exchangeCode: "NASDAQ",
    currency: "USD",
    ...window,
  };
}

function snapshot(input: {
  securities: ReturnType<typeof member>[];
  universe?: Record<string, unknown>;
}) {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: "2026-10-17T00:00:00.000Z",
    strategy: {
      strategyId: "strategy-1",
      name: "Fixture",
      versionId: "version-1",
      versionNumber: 1,
      definitionHash: "hash",
      definition: { schemaVersion: 1, buyLevels: [], sellLevels: [] },
    },
    stockList: {
      stockListId: "list-1",
      name: "S&P 500 — Historical PIT",
      ...(input.universe ? { universe: input.universe } : {}),
    },
    securities: input.securities,
    period: { startDate: "2008-01-01", endDate: "2008-12-31" },
    capital: { initialCapital: 10_000, monthlyContribution: 0 },
    allocation: { maximumPositions: 5, fullPositionFraction: 0.2 },
    benchmark: {
      benchmarkId: "benchmark-1",
      seriesId: "series-comparison",
      seriesVersion: 1,
      code: "SP500",
      name: "S&P 500",
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
      providerSymbol: "SPY",
      methodologyVersion: 1,
      currency: "USD",
    },
    executionCalendar: {
      referenceCode: "SP500",
      seriesId: "series-calendar",
      seriesVersion: 1,
    },
    methodology: { ...BACKTEST_METHODOLOGY },
    dataRevisions: { ...BACKTEST_DATA_REVISIONS },
  };
}

const universe = (peak: number) => ({
  kind: "POINT_IN_TIME_INDEX",
  indexKey: "SP500",
  peakSimultaneousMembers: peak,
});

// Lehman leaves on 2008-09-15 and a successor joins the next day: two members, never three.
const replacement = [
  member(1),
  member(2, {
    buyWindowMode: "CUSTOM",
    buyWindows: [{ startDate: "1996-01-02", endDate: "2008-09-14" }],
  }),
  member(3, {
    buyWindowMode: "CUSTOM",
    buyWindows: [{ startDate: "2008-09-15", endDate: null }],
  }),
];

describe("the engine's universe ceilings in a run snapshot", () => {
  it("accepts a universe whose recorded peak is what its frozen windows hold", () => {
    expect(
      parseRunSnapshot(snapshot({ securities: replacement, universe: universe(2) }))
        .stockList.universe,
    ).toEqual(universe(2));
  });

  it("refuses a recorded peak its frozen windows contradict", () => {
    expect(() =>
      parseRunSnapshot(snapshot({ securities: replacement, universe: universe(3) })),
    ).toThrow("but its frozen windows hold 2");
  });

  it("refuses more simultaneous members than the engine runs", () => {
    const over = BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS + 1;
    expect(() =>
      parseRunSnapshot(
        snapshot({
          securities: Array.from({ length: over }, (_, index) => member(index)),
          universe: universe(over),
        }),
      ),
    ).toThrow(`above the engine ceiling of ${BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS}`);
  });

  it("keeps the ordinary ceiling for every other List", () => {
    expect(() =>
      parseRunSnapshot(
        snapshot({
          securities: Array.from({ length: BACKTEST_MAX_SECURITIES + 1 }, (_, index) =>
            member(index),
          ),
        }),
      ),
    ).toThrow(`above the engine ceiling of ${BACKTEST_MAX_SECURITIES}`);
  });

  it("refuses a universe kind this engine does not define", () => {
    expect(() =>
      parseRunSnapshot(
        snapshot({
          securities: replacement,
          universe: { ...universe(2), kind: "SOMETHING_ELSE" },
        }),
      ),
    ).toThrow("not a universe kind this engine defines");
  });
});
