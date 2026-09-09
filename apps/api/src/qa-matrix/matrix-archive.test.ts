import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  verifyArchiveInvariants,
  type ArchiveContents,
  type ArchiveFrame,
  type ArchiveTrade,
} from "./matrix-archive";
import type { InvariantResult } from "./matrix-invariants";

/**
 * The frame-level verification, against frames written by hand.
 *
 * These are the three invariants a database cannot answer, so the checks that answer them are the
 * ones most worth pinning: the evaluator here is an independent re-derivation of the product
 * grammar, and a re-derivation that silently agreed with everything would be worse than no check.
 */

const SECURITY_ID = "sec-1";

function snapshot(
  overrides: {
    buyWindowMode?: "FULL" | "CUSTOM";
    buyWindows?: { startDate: string; endDate: string | null }[];
    condition?: Record<string, unknown>;
    trigger?: Record<string, unknown> | null;
  } = {},
): BacktestRunSnapshot {
  return {
    securities: [
      {
        securityId: SECURITY_ID,
        symbol: "AAPL",
        name: "Apple Inc.",
        exchangeCode: "NASDAQ",
        currency: "USD",
        buyWindowMode: overrides.buyWindowMode ?? "FULL",
        buyWindows: overrides.buyWindows ?? [],
      },
    ],
    strategy: {
      definition: {
        buyLevels: [
          {
            id: "b100",
            percentage: 100,
            signal: {
              conditions: [
                overrides.condition ?? {
                  id: "c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
              trigger: overrides.trigger ?? null,
            },
          },
        ],
        sellLevels: [],
        finalExit: null,
      },
    },
  } as unknown as BacktestRunSnapshot;
}

function frame(
  year: string,
  index: number,
  overrides: Partial<ArchiveFrame> & {
    dates: string[];
    closes: number[];
    sma?: number[];
  },
): ArchiveFrame {
  const { sma, ...rest } = overrides;
  return {
    securityId: SECURITY_ID,
    symbol: "AAPL",
    window: {
      year,
      index,
      firstSimulatedDate: `${year}-01-02`,
      lastSimulatedDate: `${year}-12-31`,
    },
    contextRowCount: 0,
    contextRowDates: [],
    periodStartIndex: 0,
    operandKeys: ["series:SMA_200D"],
    operands: { "series:SMA_200D": sma ?? overrides.closes.map(() => 0) },
    ...rest,
  };
}

function trade(overrides: Partial<ArchiveTrade> = {}): ArchiveTrade {
  return {
    sequence: 1,
    date: "2024-01-03",
    securityId: SECURITY_ID,
    symbol: "AAPL",
    action: "BUY",
    levelId: "b100",
    ...overrides,
  };
}

const byId = (results: readonly InvariantResult[], id: number): InvariantResult =>
  results.find((entry) => entry.id === id) as InvariantResult;

describe("invariant 36 — the Signal behind a BUY", () => {
  const contents = (
    closes: number[],
    sma: number[],
    tradeDate: string,
    snap = snapshot(),
  ): ArchiveContents => ({
    snapshot: snap,
    frames: new Map([
      [
        `${SECURITY_ID}|2024`,
        frame("2024", 0, {
          dates: ["2024-01-02", "2024-01-03", "2024-01-04"],
          closes,
          sma,
        }),
      ],
    ]),
    trades: [trade({ date: tradeDate })],
  });

  it("passes a BUY whose Condition is TRUE in the consumed frame", () => {
    const results = verifyArchiveInvariants(
      contents([100, 110, 120], [105, 105, 105], "2024-01-03"),
    );
    expect(byId(results, 36).status).toBe("PASS");
    expect(byId(results, 36).detail).toContain("1 BUY(s) re-derived TRUE");
  });

  it("fails a BUY whose Condition was FALSE on the date it fired", () => {
    // Price 100 is not above SMA 105. A run that bought here bought without a signal.
    const results = verifyArchiveInvariants(
      contents([100, 100, 120], [105, 105, 105], "2024-01-03"),
    );
    expect(byId(results, 36).status).toBe("FAIL");
    expect(byId(results, 36).violations?.join(" ")).toContain("is FALSE, not TRUE");
  });

  it("fails a BUY whose operand was absent, rather than treating absence as zero", () => {
    const results = verifyArchiveInvariants(
      contents([100, 110, 120], [105, Number.NaN, 105], "2024-01-03"),
    );
    expect(byId(results, 36).status).toBe("FAIL");
    expect(byId(results, 36).violations?.join(" ")).toContain("NOT_EVALUABLE");
  });

  it("applies `is close to` at the fixed 2% product tolerance", () => {
    const close = snapshot({
      condition: {
        id: "c1",
        metric: { kind: "PRICE" },
        operator: "IS_CLOSE_TO",
        value: { kind: "SERIES", seriesId: "EMA_200D" },
      },
    });
    const within: ArchiveContents = {
      snapshot: close,
      frames: new Map([
        [
          `${SECURITY_ID}|2024`,
          {
            ...frame("2024", 0, {
              dates: ["2024-01-02", "2024-01-03"],
              closes: [100, 101],
            }),
            operandKeys: ["series:EMA_200D"],
            operands: { "series:EMA_200D": [100, 100] },
          },
        ],
      ]),
      trades: [trade({ date: "2024-01-03" })],
    };
    expect(byId(verifyArchiveInvariants(within), 36).status).toBe("PASS");

    const outside: ArchiveContents = {
      ...within,
      frames: new Map([
        [
          `${SECURITY_ID}|2024`,
          {
            ...(within.frames.get(`${SECURITY_ID}|2024`) as ArchiveFrame),
            closes: [100, 105],
          },
        ],
      ]),
    };
    expect(byId(verifyArchiveInvariants(outside), 36).status).toBe("FAIL");
  });

  it("requires both halves of a cross, including the previous row", () => {
    const crossing = snapshot({
      condition: {
        id: "c1",
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 0 },
      },
      trigger: {
        id: "t1",
        metric: { kind: "PRICE" },
        operator: "CROSSES_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
    });
    // 2024-01-03: price 110 > SMA 105, and on 01-02 price 100 <= SMA 105. A real crossing.
    expect(
      byId(
        verifyArchiveInvariants(
          contents([100, 110, 120], [105, 105, 105], "2024-01-03", crossing),
        ),
        36,
      ).status,
    ).toBe("PASS");
    // 2024-01-04: price is above on both days, so nothing crossed.
    expect(
      byId(
        verifyArchiveInvariants(
          contents([100, 110, 120], [105, 105, 105], "2024-01-04", crossing),
        ),
        36,
      ).status,
    ).toBe("FAIL");
  });

  it("fails a BUY on a date its own frame does not contain", () => {
    const results = verifyArchiveInvariants(
      contents([100, 110, 120], [105, 105, 105], "2024-01-05"),
    );
    expect(byId(results, 36).status).toBe("FAIL");
    expect(byId(results, 36).violations?.join(" ")).toContain(
      "its evaluation frame does not contain",
    );
  });

  it("leaves SELL and FINAL EXIT out of scope rather than approximating position state", () => {
    const results = verifyArchiveInvariants({
      ...contents([100, 100, 100], [105, 105, 105], "2024-01-03"),
      trades: [trade({ action: "SELL", levelId: "s50" })],
    });
    expect(byId(results, 36).status).toBe("PASS");
    expect(byId(results, 36).detail).toContain("out of scope");
  });
});

describe("invariant 37 — the row retained across a year boundary", () => {
  const twoYears = (
    second: Partial<ArchiveFrame>,
  ): ArchiveContents => ({
    snapshot: snapshot(),
    frames: new Map([
      [
        `${SECURITY_ID}|2023`,
        frame("2023", 0, {
          dates: ["2023-12-28", "2023-12-29"],
          closes: [10, 11],
          sma: [1, 1],
        }),
      ],
      [
        `${SECURITY_ID}|2024`,
        {
          ...frame("2024", 1, {
            dates: ["2023-12-29", "2024-01-02"],
            closes: [11, 12],
            sma: [1, 1],
          }),
          contextRowCount: 1,
          contextRowDates: ["2023-12-29"],
          periodStartIndex: 1,
          ...second,
        },
      ],
    ]),
    trades: [],
  });

  it("passes when the context row is the security's own previous eligible row", () => {
    expect(byId(verifyArchiveInvariants(twoYears({})), 37).status).toBe("PASS");
    expect(byId(verifyArchiveInvariants(twoYears({})), 37).detail).toContain(
      "1 year boundaries",
    );
  });

  it("fails when nothing was retained although the previous year was simulated", () => {
    const results = verifyArchiveInvariants(
      twoYears({
        contextRowCount: 0,
        contextRowDates: [],
        periodStartIndex: 0,
        dates: ["2024-01-02"],
        closes: [12],
        operands: { "series:SMA_200D": [1] },
      }),
    );
    expect(byId(results, 37).status).toBe("FAIL");
    expect(byId(results, 37).violations?.join(" ")).toContain("had no `t - 1`");
  });

  it("fails when the retained row is not the previous window's last eligible row", () => {
    const results = verifyArchiveInvariants(
      twoYears({
        contextRowDates: ["2023-12-28"],
        dates: ["2023-12-28", "2024-01-02"],
      }),
    );
    expect(byId(results, 37).status).toBe("FAIL");
    expect(byId(results, 37).violations?.join(" ")).toContain("not 2023-12-29");
  });

  it("fails when a context row lies inside the window it precedes", () => {
    const results = verifyArchiveInvariants(
      twoYears({
        contextRowDates: ["2024-01-02"],
        dates: ["2024-01-02", "2024-01-03"],
        closes: [12, 13],
        operands: { "series:SMA_200D": [1, 1] },
      }),
    );
    expect(byId(results, 37).status).toBe("FAIL");
    expect(byId(results, 37).violations?.join(" ")).toContain(
      "inside the simulated window",
    );
  });

  it("accepts a later listing whose first window has nothing to carry", () => {
    // `AMZN` first trades in May 1997 in a run that starts in 1996. Its 1996 window is empty and
    // its 1997 window has no earlier row to retain — requiring one would report correct behaviour
    // as a defect.
    const results = verifyArchiveInvariants({
      snapshot: snapshot(),
      frames: new Map([
        [
          `${SECURITY_ID}|1996`,
          frame("1996", 0, { dates: [], closes: [], sma: [] }),
        ],
        [
          `${SECURITY_ID}|1997`,
          frame("1997", 1, {
            dates: ["1997-05-15", "1997-05-16"],
            closes: [10, 11],
            sma: [1, 1],
          }),
        ],
        [
          `${SECURITY_ID}|1998`,
          {
            ...frame("1998", 2, {
              dates: ["1997-05-16", "1998-01-02"],
              closes: [11, 12],
              sma: [1, 1],
            }),
            contextRowCount: 1,
            contextRowDates: ["1997-05-16"],
            periodStartIndex: 1,
          },
        ],
      ]),
      trades: [],
    });
    expect(byId(results, 37).status).toBe("PASS");
  });

  it("fails a window carrying context from before the security had any data", () => {
    const results = verifyArchiveInvariants({
      snapshot: snapshot(),
      frames: new Map([
        [
          `${SECURITY_ID}|1996`,
          frame("1996", 0, { dates: [], closes: [], sma: [] }),
        ],
        [
          `${SECURITY_ID}|1997`,
          {
            ...frame("1997", 1, {
              dates: ["1996-12-31", "1997-05-15"],
              closes: [9, 10],
              sma: [1, 1],
            }),
            contextRowCount: 1,
            contextRowDates: ["1996-12-31"],
            periodStartIndex: 1,
          },
        ],
      ]),
      trades: [],
    });
    expect(byId(results, 37).status).toBe("FAIL");
    expect(byId(results, 37).violations?.join(" ")).toContain(
      "no earlier window held a single eligible row",
    );
  });
});

describe("invariant 38 — buy-window boundaries", () => {
  const withWindow = (
    tradeDate: string,
    windows: { startDate: string; endDate: string | null }[],
  ): ArchiveContents => ({
    snapshot: snapshot({ buyWindowMode: "CUSTOM", buyWindows: windows }),
    frames: new Map([
      [
        `${SECURITY_ID}|2024`,
        frame("2024", 0, {
          dates: ["2024-01-02", "2024-01-03", "2024-01-04"],
          closes: [100, 110, 120],
          sma: [1, 1, 1],
        }),
      ],
    ]),
    trades: [trade({ date: tradeDate })],
  });

  it("counts a BUY on the exact first or last day of a window as inside it", () => {
    const opening = verifyArchiveInvariants(
      withWindow("2024-01-03", [{ startDate: "2024-01-03", endDate: "2024-01-04" }]),
    );
    expect(byId(opening, 38).status).toBe("PASS");
    expect(byId(opening, 38).detail).toContain("1 BUY(s) executed exactly on a window endpoint");

    const closing = verifyArchiveInvariants(
      withWindow("2024-01-03", [{ startDate: "2024-01-02", endDate: "2024-01-03" }]),
    );
    expect(byId(closing, 38).status).toBe("PASS");
  });

  it("fails a BUY one day outside a window", () => {
    const results = verifyArchiveInvariants(
      withWindow("2024-01-04", [{ startDate: "2024-01-02", endDate: "2024-01-03" }]),
    );
    expect(byId(results, 38).status).toBe("FAIL");
    expect(byId(results, 38).violations?.join(" ")).toContain(
      "outside every persisted window",
    );
  });

  it("treats an open-ended window as running to the end of the run", () => {
    expect(
      byId(
        verifyArchiveInvariants(
          withWindow("2024-01-04", [{ startDate: "2024-01-02", endDate: null }]),
        ),
        38,
      ).status,
    ).toBe("PASS");
  });

  it("handles a single-day window", () => {
    expect(
      byId(
        verifyArchiveInvariants(
          withWindow("2024-01-03", [
            { startDate: "2024-01-03", endDate: "2024-01-03" },
          ]),
        ),
        38,
      ).status,
    ).toBe("PASS");
  });
});
