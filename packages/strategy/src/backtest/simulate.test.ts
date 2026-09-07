import { describe, expect, it } from "vitest";
import {
  benchmarkSeries,
  buyLevel,
  definitionOf,
  executionInput,
  finalExit,
  frameOf,
  gainAboveSignal,
  lossAboveSignal,
  priceAboveSignal,
  priceBelowSignal,
  securityInput,
  sellLevel,
  tradingDates,
} from "./backtest.test-helper.js";
import { simulateBacktest, BacktestExecutionError } from "./simulate.js";
import type { BacktestCheckpoint } from "./types.js";

const ALWAYS = 0;

describe("allocation under maximumPositions", () => {
  it("derives the full-position budget as 1 / maximumPositions and scales it by the BUY level", async () => {
    const dates = tradingDates("2020-01-06", 2);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100] });

    for (const [maximumPositions, percentage, expectedValue] of [
      [10, 100, 10_000],
      [10, 25, 2_500],
      [10, 50, 5_000],
      [10, 75, 7_500],
      [5, 25, 5_000],
      [4, 100, 25_000],
    ] as const) {
      const result = await simulateBacktest(
        executionInput({
          definition: definitionOf({
            buyLevels: [buyLevel("b1", percentage, priceAboveSignal(ALWAYS))],
          }),
          securities: [securityInput(frame)],
          initialCapital: 100_000,
          maximumPositions,
        }),
      );

      const buy = result.trades.find((trade) => trade.action === "BUY");
      expect(buy?.amount).toBeCloseTo(expectedValue, 6);
      expect(buy?.shares).toBeCloseTo(expectedValue / 100, 6);
    }
  });

  it("treats a BUY level percentage as a target fill, so a later level tops the position up", async () => {
    const dates = tradingDates("2020-01-06", 3);
    // Day 1 only the 25% level matches (price 100), day 2 the 50% level also matches (price 90).
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 90, 90] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceAboveSignal(95)),
            buyLevel("b50", 50, priceBelowSignal(95)),
          ],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 10,
      }),
    );

    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]?.amount).toBeCloseTo(2_500, 6);
    // Day 2: full position budget is 10% of the portfolio, target 50% of it. The position already
    // holds 25 shares worth 2,250 at 90, so only the shortfall is bought.
    const dayTwoValue = 97_500 + 25 * 90;
    const target = (dayTwoValue * 0.1 * 50) / 100;
    expect(result.trades[1]?.amount).toBeCloseTo(target - 25 * 90, 6);
  });

  it("never opens more than maximumPositions positions and leaves the surplus candidates unbought", async () => {
    const dates = tradingDates("2020-01-06", 2);
    const securities = ["AAA", "BBB", "CCC", "DDD"].map((symbol) =>
      securityInput(frameOf({ symbol, dates, closes: [100, 100] })),
    );

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
        }),
        securities,
        initialCapital: 100_000,
        maximumPositions: 2,
      }),
    );

    expect(result.positions.map((position) => position.symbol)).toEqual([
      "AAA",
      "BBB",
    ]);
    expect(result.summary.openPositions).toBe(2);
  });

  it("stops buying when cash runs out rather than going negative", async () => {
    const dates = tradingDates("2020-01-06", 1);
    const securities = ["AAA", "BBB", "CCC"].map((symbol) =>
      securityInput(frameOf({ symbol, dates, closes: [100] })),
    );

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
        }),
        securities,
        initialCapital: 1_000,
        maximumPositions: 2,
      }),
    );

    // Two slots at 50% of 1,000 each: the whole balance is deployed and nothing overdraws.
    expect(result.summary.finalCash).toBeCloseTo(0, 6);
    expect(result.equity.every((point) => point.cash >= -1e-9)).toBe(true);
  });
});

describe("exits", () => {
  it("sells the configured fraction of the position remaining at execution time", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 200, 200] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(150))],
          sellLevels: [
            sellLevel("s1", 50, gainAboveSignal(50)),
            sellLevel("s2", 50, gainAboveSignal(60)),
          ],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 10,
      }),
    );

    const sells = result.trades.filter((trade) => trade.action === "SELL");
    // Both SELL levels match on day 2 and execute in definition order against the remaining
    // position: 100 shares -> 50 sold -> 25 sold, leaving 25.
    expect(sells).toHaveLength(2);
    expect(sells[0]?.shares).toBeCloseTo(50, 6);
    expect(sells[1]?.shares).toBeCloseTo(25, 6);
    expect(result.positions[0]?.shares).toBeCloseTo(25, 6);
  });

  it("fires each SELL level at most once per position lifecycle", async () => {
    const dates = tradingDates("2020-01-06", 5);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [100, 200, 200, 200, 200],
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(150))],
          sellLevels: [sellLevel("s1", 50, gainAboveSignal(50))],
        }),
        securities: [securityInput(frame)],
      }),
    );

    expect(
      result.trades.filter((trade) => trade.action === "SELL"),
    ).toHaveLength(1);
  });

  it("closes the whole remaining position on FINAL EXIT and outranks a matching SELL", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 200, 200] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(150))],
          sellLevels: [sellLevel("s1", 50, gainAboveSignal(50))],
          finalExit: finalExit("fx", gainAboveSignal(50)),
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 10,
      }),
    );

    const exits = result.trades.filter(
      (trade) => trade.action === "FINAL_EXIT",
    );
    expect(exits).toHaveLength(1);
    expect(exits[0]?.shares).toBeCloseTo(100, 6);
    expect(result.trades.some((trade) => trade.action === "SELL")).toBe(false);
    expect(result.positions).toHaveLength(0);
    expect(result.summary.realizedPnl).toBeCloseTo(10_000, 6);
  });

  it("never re-enters a security on the date its position closed", async () => {
    const dates = tradingDates("2020-01-06", 3);
    // Day two the FINAL EXIT fires, and the BUY level also matches on that date. Selling and
    // rebuying at the same close would be an economic no-op that fabricates two trades.
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 200, 200] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
          finalExit: finalExit("fx", gainAboveSignal(50)),
        }),
        securities: [securityInput(frame)],
      }),
    );

    expect(result.trades.map((trade) => [trade.date, trade.action])).toEqual([
      [dates[0], "BUY"],
      [dates[1], "FINAL_EXIT"],
      [dates[2], "BUY"],
    ]);
  });

  it("keeps average cost unchanged across a partial sell and updates it on a top-up", async () => {
    const dates = tradingDates("2020-01-06", 4);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [100, 50, 200, 200],
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b50", 50, priceAboveSignal(75)),
            buyLevel("b100", 100, priceBelowSignal(75)),
          ],
          sellLevels: [sellLevel("s1", 50, gainAboveSignal(50))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 10,
      }),
    );

    const buys = result.trades.filter((trade) => trade.action === "BUY");
    expect(buys).toHaveLength(2);
    const secondBuy = buys[1];
    const blended =
      ((buys[0]?.amount ?? 0) + (secondBuy?.amount ?? 0)) /
      ((buys[0]?.shares ?? 0) + (secondBuy?.shares ?? 0));
    expect(secondBuy?.averageCostAfter).toBeCloseTo(blended, 6);

    const sell = result.trades.find((trade) => trade.action === "SELL");
    expect(sell?.averageCostAfter).toBeCloseTo(blended, 6);
  });
});

describe("contributions", () => {
  it("adds the contribution on the first simulated trading day of each month, never on the first day", async () => {
    const dates = [
      ...tradingDates("2020-01-06", 5),
      ...tradingDates("2020-02-03", 5),
      ...tradingDates("2020-03-02", 5),
    ];
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 25, priceBelowSignal(0))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 10_000,
        monthlyContribution: 500,
      }),
    );

    const invested = result.equity.map((point) => point.investedCapital);
    expect(invested[0]).toBe(10_000);
    expect(invested[4]).toBe(10_000);
    expect(invested[5]).toBe(10_500);
    expect(invested[9]).toBe(10_500);
    expect(invested[10]).toBe(11_000);
    expect(result.summary.investedCapital).toBe(11_000);
    expect(result.summary.finalCash).toBe(11_000);
  });

  it("keeps a contribution out of the return, so a pure-cash portfolio reports 0%", async () => {
    const dates = [
      ...tradingDates("2020-01-06", 3),
      ...tradingDates("2020-02-03", 3),
    ];
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 25, priceBelowSignal(0))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 10_000,
        monthlyContribution: 5_000,
      }),
    );

    expect(result.summary.portfolioReturnPercent).toBeCloseTo(0, 9);
    expect(result.summary.finalValue).toBe(15_000);
    expect(result.summary.netProfit).toBe(0);
  });
});

describe("buy windows", () => {
  it("only opens a BUY inside a CUSTOM window and never restricts an exit", async () => {
    const dates = tradingDates("2020-01-06", 6);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
    });
    const window = {
      mode: "CUSTOM" as const,
      ranges: [{ startDate: dates[2] as string, endDate: dates[3] as string }],
    };

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
        }),
        securities: [securityInput(frame, window)],
      }),
    );

    const buys = result.trades.filter((trade) => trade.action === "BUY");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.date).toBe(dates[2]);
  });
});

describe("candidate ordering", () => {
  it("funds the strongest signal first and breaks ties by symbol", async () => {
    const dates = tradingDates("2020-01-06", 1);
    const securities = [
      securityInput(frameOf({ symbol: "ZZZ", dates, closes: [100] })),
      securityInput(frameOf({ symbol: "AAA", dates, closes: [100] })),
      securityInput(frameOf({ symbol: "MMM", dates, closes: [50] })),
    ];

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceAboveSignal(75)),
            buyLevel("b100", 100, priceBelowSignal(75)),
          ],
        }),
        securities,
        initialCapital: 100_000,
        maximumPositions: 3,
      }),
    );

    // MMM matches the 100% level, AAA and ZZZ the 25% level; ties order by symbol.
    expect(result.trades.map((trade) => trade.symbol)).toEqual([
      "MMM",
      "AAA",
      "ZZZ",
    ]);
  });

  it("orders a top-up of an existing position before opening a new one", async () => {
    const dates = tradingDates("2020-01-06", 2);
    // ZZZ enters at 25% on day one, then its 100% level matches on day two — a top-up. AAA has no
    // row on day one, so day two is a new entry. Both carry the same level percentage, and without
    // the top-up rule the alphabetical tiebreak would put AAA first.
    const existing = frameOf({ symbol: "ZZZ", dates, closes: [100, 80] });
    const fresh = frameOf({ symbol: "AAA", dates, closes: [null, 80] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceAboveSignal(90)),
            buyLevel("b100", 100, priceBelowSignal(90)),
          ],
        }),
        securities: [securityInput(existing), securityInput(fresh)],
        initialCapital: 100_000,
        maximumPositions: 2,
      }),
    );

    const dayTwo = result.trades.filter((trade) => trade.date === dates[1]);
    expect(dayTwo.map((trade) => trade.symbol)).toEqual(["ZZZ", "AAA"]);
  });
});

describe("unavailable data", () => {
  it("takes no action on a date whose operand is unavailable", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [100, 100, 100],
      columns: { "series:SMA_50D": [null, null, 90] },
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b1", 100, {
              conditions: [
                {
                  id: "c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "SERIES", seriesId: "SMA_50D" },
                },
              ],
            }),
          ],
        }),
        securities: [securityInput(frame)],
      }),
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.date).toBe(dates[2]);
  });

  it("skips a security on a union date it did not trade", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const traded = frameOf({ symbol: "AAA", dates, closes: [100, 100, 100] });
    const gapped = frameOf({
      symbol: "BBB",
      dates: [dates[0] as string, dates[2] as string],
      closes: [100, 100],
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
        }),
        securities: [securityInput(traded), securityInput(gapped)],
        maximumPositions: 10,
      }),
    );

    const bbbTrades = result.trades.filter((trade) => trade.symbol === "BBB");
    expect(bbbTrades.every((trade) => trade.date !== dates[1])).toBe(true);
  });
});

describe("benchmark and alpha", () => {
  it("normalizes both curves from the first simulated date and reports the difference as alpha", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 110, 120] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
        benchmark: benchmarkSeries({ dates, closes: [400, 404, 408] }),
      }),
    );

    expect(result.equity[0]?.benchmarkIndex).toBeCloseTo(1, 9);
    expect(result.equity[2]?.benchmarkIndex).toBeCloseTo(408 / 400, 9);
    expect(result.summary.benchmarkReturnPercent).toBeCloseTo(2, 9);
    expect(result.summary.alphaPercent).toBeCloseTo(
      (result.summary.portfolioReturnPercent ?? 0) - 2,
      9,
    );
  });

  it("carries a benchmark forward over a date it did not trade and never fabricates one before its history", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100, 100] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 25, priceBelowSignal(0))],
        }),
        securities: [securityInput(frame)],
        benchmark: benchmarkSeries({
          dates: [dates[1] as string],
          closes: [200],
        }),
      }),
    );

    expect(result.equity[0]?.benchmarkIndex).toBeNull();
    expect(result.equity[1]?.benchmarkIndex).toBeCloseTo(1, 9);
    expect(result.equity[2]?.benchmarkIndex).toBeCloseTo(1, 9);
  });

  it("reports no benchmark return at all when the run has no benchmark series", async () => {
    const dates = tradingDates("2020-01-06", 2);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 25, priceBelowSignal(0))],
        }),
        securities: [securityInput(frame)],
      }),
    );

    expect(result.summary.benchmarkReturnPercent).toBeNull();
    expect(result.summary.alphaPercent).toBeNull();
    expect(result.summary.benchmarkMaxDrawdownPercent).toBeNull();
  });
});

describe("determinism and point-in-time correctness", () => {
  const dates = tradingDates("2020-01-06", 40);
  const closes = dates.map((_, index) => 100 + Math.sin(index / 3) * 20);
  const definition = definitionOf({
    buyLevels: [
      buyLevel("b25", 25, priceBelowSignal(95)),
      buyLevel("b100", 100, priceBelowSignal(85)),
    ],
    sellLevels: [sellLevel("s1", 50, gainAboveSignal(10))],
    finalExit: finalExit("fx", lossAboveSignal(15)),
  });

  function inputFor(endIndex: number) {
    return executionInput({
      definition,
      securities: [
        securityInput(frameOf({ symbol: "AAA", dates, closes })),
        securityInput(
          frameOf({
            symbol: "BBB",
            dates,
            closes: closes.map((close) => close * 1.1),
          }),
        ),
      ],
      startDate: dates[0] as string,
      endDate: dates[endIndex] as string,
      initialCapital: 50_000,
      monthlyContribution: 250,
      maximumPositions: 3,
    });
  }

  it("produces byte-identical output for the same input", async () => {
    const first = await simulateBacktest(inputFor(dates.length - 1));
    const second = await simulateBacktest(inputFor(dates.length - 1));
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it("never lets a later end date change an earlier prefix of the run", async () => {
    const short = await simulateBacktest(inputFor(19));
    const long = await simulateBacktest(inputFor(dates.length - 1));
    const cutoff = dates[19] as string;

    expect(long.trades.filter((trade) => trade.date <= cutoff)).toEqual(
      short.trades,
    );
    expect(long.equity.filter((point) => point.date <= cutoff)).toEqual(
      short.equity,
    );
  });

  it("is unaffected by the checkpoint cadence", async () => {
    const withoutCheckpoints = await simulateBacktest(
      inputFor(dates.length - 1),
    );
    const checkpoints: BacktestCheckpoint[] = [];
    const withCheckpoints = await simulateBacktest(inputFor(dates.length - 1), {
      checkpointEveryDays: 3,
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(JSON.stringify(withCheckpoints)).toEqual(
      JSON.stringify(withoutCheckpoints),
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.at(-1)?.simulatedThrough).not.toBe(
      withoutCheckpoints.summary.lastSimulatedDate,
    );
    for (const checkpoint of checkpoints) {
      expect(checkpoint.curve.at(-1)?.date).toBe(checkpoint.simulatedThrough);
    }
  });
});

describe("guards", () => {
  it("rejects a period with no eligible trading day", async () => {
    const dates = tradingDates("2020-01-06", 2);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100] });

    await expect(
      simulateBacktest(
        executionInput({
          definition: definitionOf({
            buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
          }),
          securities: [securityInput(frame)],
          startDate: "2019-01-01",
          endDate: "2019-01-31",
        }),
      ),
    ).rejects.toBeInstanceOf(BacktestExecutionError);
  });

  it("rejects an invalid maximumPositions", async () => {
    const dates = tradingDates("2020-01-06", 1);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100] });

    await expect(
      simulateBacktest(
        executionInput({
          definition: definitionOf({
            buyLevels: [buyLevel("b1", 100, priceAboveSignal(ALWAYS))],
          }),
          securities: [securityInput(frame)],
          maximumPositions: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(BacktestExecutionError);
  });
});
