import type {
  BacktestRunSnapshot,
  StrategyDefinition,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { buildOracleColumns, type OracleBar } from "./matrix-etf-oracle";
import {
  tallySourcedConditions,
  validateEtfInvariants,
  type EtfRunEvidence,
} from "./matrix-etf-invariants";

/**
 * Invariants 41–44 of the data-source dimensions, each shown able to fail on the one fault it
 * exists for: a trade the fund's bars do not justify, a fund pinned without being read (or read
 * without being pinned), a sector frozen onto the wrong fund, and a fund that was not READY.
 */

/** A rising fund from 2026-01-05 for 30 sessions, then falling. */
function fundBars(): OracleBar[] {
  const bars: OracleBar[] = [];
  let date = Date.parse("2026-01-05T00:00:00.000Z");
  for (let index = 0; index < 60; index += 1) {
    const weekday = new Date(date).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const close = index < 30 ? 100 + index : 130 - (index - 30) * 2;
      bars.push({
        date: new Date(date).toISOString().slice(0, 10),
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000,
      });
    }
    date += 86_400_000;
  }
  return bars;
}

const BARS = fundBars();
const RISING = BARS[25]!.date; // close above its 20-session average
const FALLING = BARS.at(-1)!.date; // close below it
const BEFORE_WARMUP = BARS[5]!.date;

/** BUY 100% when the fund's Price is above its SMA 20D; FINAL EXIT on the stock or the fund. */
function definition(source: "ETF" | "STOCK_SECTOR"): StrategyDefinition {
  const metricSource =
    source === "ETF"
      ? { kind: "ETF" as const, code: "ETF_XLK" as const }
      : { kind: "STOCK_SECTOR" as const };
  return {
    schemaVersion: 2,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c1",
              metric: { kind: "PRICE", source: metricSource },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
    finalExit: {
      id: "exit",
      rules: [
        {
          id: "exit",
          signal: {
            conditions: [
              {
                id: "e1",
                metric: { kind: "PRICE", source: metricSource },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_20D" },
              },
            ],
          },
        },
        {
          id: "exit2",
          signal: {
            conditions: [
              {
                id: "e2",
                metric: { kind: "LOSS" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 10 },
              },
            ],
          },
        },
      ],
    },
  } as unknown as StrategyDefinition;
}

function snapshot(
  source: "ETF" | "STOCK_SECTOR",
  overrides: Partial<{
    etfSeries: { code: string; seriesId: string }[];
    sector: { name: string | null; etfCode: string | null } | undefined;
  }> = {},
): BacktestRunSnapshot {
  const sector =
    "sector" in overrides
      ? overrides.sector
      : source === "STOCK_SECTOR"
        ? { name: "Technology", etfCode: "ETF_XLK" }
        : undefined;
  return {
    strategy: { definition: definition(source) },
    securities: [
      {
        securityId: "sec-aapl",
        symbol: "AAPL",
        ...(sector ? { sector } : {}),
      },
    ],
    etfSeries: overrides.etfSeries ?? [
      { code: "ETF_XLK", seriesId: "series-xlk" },
    ],
  } as unknown as BacktestRunSnapshot;
}

function evidence(overrides: Partial<EtfRunEvidence> = {}): EtfRunEvidence {
  return {
    oracleBySeriesId: new Map([
      ["series-xlk", buildOracleColumns(BARS, () => new Set())],
    ]),
    diagnostics: [{ code: "ETF_XLK", status: "READY" }],
    currentSectorBySecurityId: new Map([["sec-aapl", "Technology"]]),
    ...overrides,
  };
}

const trade = (
  date: string,
  action: "BUY" | "SELL" | "FINAL_EXIT",
  levelId: string,
): {
  sequence: number;
  date: string;
  securityId: string;
  symbol: string;
  action: "BUY" | "SELL" | "FINAL_EXIT";
  levelId: string | null;
} => ({
  sequence: 1,
  date,
  securityId: "sec-aapl",
  symbol: "AAPL",
  action,
  levelId,
});

const byId = (results: ReturnType<typeof validateEtfInvariants>, id: number) =>
  results.find((entry) => entry.id === id);

describe("invariant 41: every executed trade's ETF Conditions held", () => {
  it("passes a BUY on a session the fund's bars make TRUE", () => {
    const results = validateEtfInvariants({
      snapshot: snapshot("ETF"),
      trades: [trade(RISING, "BUY", "buy-1")],
      etf: evidence(),
    });
    expect(byId(results, 41)?.status).toBe("PASS");
  });

  it("fails a BUY the fund's bars make FALSE, and one before the fund warmed up", () => {
    for (const date of [FALLING, BEFORE_WARMUP]) {
      const results = validateEtfInvariants({
        snapshot: snapshot("ETF"),
        trades: [trade(date, "BUY", "buy-1")],
        etf: evidence(),
      });
      expect(byId(results, 41)?.status, date).toBe("FAIL");
    }
  });

  it("leaves the end-of-period liquidation alone: no level decided it", () => {
    const results = validateEtfInvariants({
      snapshot: snapshot("ETF"),
      trades: [{ ...trade(FALLING, "SELL", "x"), levelId: null }],
      etf: evidence(),
    });
    expect(byId(results, 41)?.status).toBe("PASS");
  });

  it("fails a BUY on a session the fund printed no bar for: nothing is carried forward", () => {
    const results = validateEtfInvariants({
      snapshot: snapshot("ETF"),
      trades: [trade("2026-01-10", "BUY", "buy-1")], // a Saturday
      etf: evidence(),
    });
    expect(byId(results, 41)?.status).toBe("FAIL");
  });

  it("accepts a FINAL EXIT any one Exit Rule could have fired, and refuses one none could", () => {
    // The fund is rising, so the ETF rule is FALSE — but the Loss rule has no ETF Condition and may
    // be the one that fired.
    expect(
      byId(
        validateEtfInvariants({
          snapshot: snapshot("ETF"),
          trades: [trade(RISING, "FINAL_EXIT", "exit")],
          etf: evidence(),
        }),
        41,
      )?.status,
    ).toBe("PASS");
    const onlyEtf = snapshot("ETF");
    const defn = onlyEtf.strategy.definition as unknown as StrategyDefinition;
    defn.finalExit!.rules.pop();
    expect(
      byId(
        validateEtfInvariants({
          snapshot: onlyEtf,
          trades: [trade(RISING, "FINAL_EXIT", "exit")],
          etf: evidence(),
        }),
        41,
      )?.status,
    ).toBe("FAIL");
  });

  it("reads Stock's Sector through the frozen fund, and fails when that fund's bars say no", () => {
    expect(
      byId(
        validateEtfInvariants({
          snapshot: snapshot("STOCK_SECTOR"),
          trades: [trade(RISING, "BUY", "buy-1")],
          etf: evidence(),
        }),
        41,
      )?.status,
    ).toBe("PASS");
    expect(
      byId(
        validateEtfInvariants({
          snapshot: snapshot("STOCK_SECTOR", {
            sector: { name: null, etfCode: null },
          }),
          trades: [trade(RISING, "BUY", "buy-1")],
          etf: evidence({
            currentSectorBySecurityId: new Map([["sec-aapl", null]]),
          }),
        }),
        41,
      )?.status,
    ).toBe("FAIL");
  });
});

describe("invariants 42–44", () => {
  it("42 fails a fund pinned that nothing reads, and a fund read that nothing pins", () => {
    const extra = validateEtfInvariants({
      snapshot: snapshot("ETF", {
        etfSeries: [
          { code: "ETF_XLK", seriesId: "series-xlk" },
          { code: "SP500", seriesId: "series-spy" },
        ],
      }),
      trades: [],
      etf: evidence(),
    });
    expect(byId(extra, 42)?.status).toBe("FAIL");
    const missing = validateEtfInvariants({
      snapshot: snapshot("ETF", { etfSeries: [] }),
      trades: [],
      etf: evidence(),
    });
    expect(byId(missing, 42)?.status).toBe("FAIL");
  });

  it("43 fails a sector frozen onto the wrong fund, or one the catalog no longer agrees with", () => {
    const wrongFund = validateEtfInvariants({
      snapshot: snapshot("STOCK_SECTOR", {
        sector: { name: "Technology", etfCode: "ETF_XLF" },
        etfSeries: [{ code: "ETF_XLF", seriesId: "series-xlk" }],
      }),
      trades: [],
      etf: evidence(),
    });
    expect(byId(wrongFund, 43)?.status).toBe("FAIL");
    const drifted = validateEtfInvariants({
      snapshot: snapshot("STOCK_SECTOR"),
      trades: [],
      etf: evidence({
        currentSectorBySecurityId: new Map([["sec-aapl", "Healthcare"]]),
      }),
    });
    expect(byId(drifted, 43)?.status).toBe("FAIL");
    expect(
      byId(
        validateEtfInvariants({
          snapshot: snapshot("STOCK_SECTOR"),
          trades: [],
          etf: evidence(),
        }),
        43,
      )?.status,
    ).toBe("PASS");
  });

  it("44 fails a pinned fund whose persisted diagnostics are not READY", () => {
    const results = validateEtfInvariants({
      snapshot: snapshot("ETF"),
      trades: [],
      etf: evidence({
        diagnostics: [{ code: "ETF_XLK", status: "NOT_BOOTSTRAPPED" }],
      }),
    });
    expect(byId(results, 44)?.status).toBe("FAIL");
  });
});

describe("condition tallies", () => {
  it("counts TRUE, FALSE and NOT_EVALUABLE over the sessions a run simulated", () => {
    const tallies = tallySourcedConditions({
      strategyId: "E99",
      snapshot: snapshot("ETF"),
      sessions: [BEFORE_WARMUP, RISING, FALLING, "2026-01-10"],
      etf: evidence(),
    });
    const buy = tallies.find((tally) => tally.conditionId === "c1")!;
    expect([buy.TRUE, buy.FALSE, buy.NOT_EVALUABLE]).toEqual([1, 1, 2]);
    expect(buy.fund).toBe("ETF_XLK");
  });
});
