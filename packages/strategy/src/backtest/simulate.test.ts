import { describe, expect, it } from "vitest";
import {
  benchmarkSeries,
  buyLevel,
  priceCrossesAboveSignal,
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
    expect(result.equity.every((point) => Number(point.cash) >= -1e-9)).toBe(
      true,
    );
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
      (Number(buys[0]?.amount ?? 0) + Number(secondBuy?.amount ?? 0)) /
      (Number(buys[0]?.shares ?? 0) + Number(secondBuy?.shares ?? 0));
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

    const invested = result.equity.map((point) =>
      Number(point.investedCapital),
    );
    expect(invested[0]).toBe(10_000);
    expect(invested[4]).toBe(10_000);
    expect(invested[5]).toBe(10_500);
    expect(invested[9]).toBe(10_500);
    expect(invested[10]).toBe(11_000);
    expect(Number(result.summary.investedCapital)).toBe(11_000);
    expect(Number(result.summary.finalCash)).toBe(11_000);
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
    expect(Number(result.summary.finalValue)).toBe(15_000);
    expect(Number(result.summary.netProfit)).toBe(0);
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

  it("carries a holding forward over a non-positive close instead of marking it to zero", async () => {
    const dates = tradingDates("2020-01-06", 4);
    // A zero close is not a price. Valuing the position at it would drive the portfolio to zero and
    // absorb the growth index there permanently, while the final value never actually changed.
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100, 0, 100] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(50))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    expect(result.equity.map((point) => Number(point.totalValue))).toEqual([
      100_000, 100_000, 100_000, 100_000,
    ]);
    expect(result.summary.portfolioReturnPercent).toBeCloseTo(0, 9);
    expect(result.summary.maxDrawdownPercent).toBeCloseTo(0, 9);
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

/**
 * Monthly contributions add external capital, and a position whose BUY levels have all fired would
 * otherwise be unable to receive any of it. The rule is deliberately narrow: a fired level wakes up
 * **only** on a date that actually deposits a contribution, only while its own Signal is TRUE, and
 * only to buy the shortfall to its recalculated target. It is not a daily rebalance.
 */
describe("contribution-date DCA top-ups", () => {
  // Two calendar months of weekday dates: the second month's first date deposits.
  const dates = [
    ...tradingDates("2020-01-06", 5),
    ...tradingDates("2020-02-03", 5),
  ];
  const contributionDate = dates[5] as string;

  function runWith(input: {
    closes: readonly (number | null)[];
    buyLevels: ReturnType<typeof buyLevel>[];
    monthlyContribution?: number;
    buyWindows?: Parameters<typeof securityInput>[1];
    maximumPositions?: number;
  }) {
    const frame = frameOf({ symbol: "AAA", dates, closes: input.closes });
    return simulateBacktest(
      executionInput({
        definition: definitionOf({ buyLevels: input.buyLevels }),
        securities: [securityInput(frame, input.buyWindows)],
        initialCapital: 100_000,
        monthlyContribution: input.monthlyContribution ?? 50_000,
        maximumPositions: input.maximumPositions ?? 10,
      }),
    );
  }

  /** `Price is above 0` is true every day, so only the firing rule can stop a repeat buy. */
  const alwaysTrue = () => priceAboveSignal(0);

  it("does not repeat a fired BUY level on ordinary following days", async () => {
    const result = await runWith({
      closes: dates.map(() => 100),
      buyLevels: [buyLevel("b25", 25, alwaysTrue())],
      monthlyContribution: 0,
    });

    // The signal is true on all ten days; the level buys once.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.date).toBe(dates[0]);
  });

  it("does not rebalance a position that merely drifted below target", async () => {
    // The price halves after entry, so the position sits far below its 25% target every day — and
    // with no contribution the engine must leave it alone.
    const closes = dates.map((_, index) => (index === 0 ? 100 : 50));
    const result = await runWith({
      closes,
      buyLevels: [buyLevel("b25", 25, alwaysTrue())],
      monthlyContribution: 0,
    });

    expect(result.trades).toHaveLength(1);
  });

  it("tops a fired level up to its recalculated target on a contribution date", async () => {
    const result = await runWith({
      closes: dates.map(() => 100),
      buyLevels: [buyLevel("b25", 25, alwaysTrue())],
    });

    expect(result.trades).toHaveLength(2);
    const [entry, topUp] = result.trades;
    // Day one: 25% of a 10% full position of 100,000.
    expect(entry?.amount).toBeCloseTo(2_500, 6);
    expect(topUp?.date).toBe(contributionDate);
    // The contribution lands before trading, so the budget is measured on 150,000: the level's
    // target becomes 3,750 and only the 1,250 shortfall is bought.
    expect(topUp?.amount).toBeCloseTo(1_250, 6);
    expect(topUp?.levelPercentage).toBe(25);
    expect(topUp?.sharesAfter).toBeCloseTo(37.5, 6);
  });

  it("tops up only once, not on the days after the contribution", async () => {
    const result = await runWith({
      closes: dates.map(() => 100),
      buyLevels: [buyLevel("b25", 25, alwaysTrue())],
    });

    const afterContribution = result.trades.filter(
      (trade) => trade.date > contributionDate,
    );
    expect(afterContribution).toHaveLength(0);
  });

  it("does not top up when the level's Signal is FALSE on the contribution date", async () => {
    // Price is above 95 only in the first month, so the level's Condition is FALSE when the
    // contribution lands.
    const closes = dates.map((_, index) => (index < 5 ? 100 : 90));
    const result = await runWith({
      closes,
      buyLevels: [buyLevel("b25", 25, priceAboveSignal(95))],
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.date).toBe(dates[0]);
  });

  it("does not top up when the buy window closes before the contribution date", async () => {
    const result = await runWith({
      closes: dates.map(() => 100),
      buyLevels: [buyLevel("b25", 25, alwaysTrue())],
      buyWindows: {
        mode: "CUSTOM",
        ranges: [
          { startDate: dates[0] as string, endDate: dates[4] as string },
        ],
      },
    });

    expect(result.trades).toHaveLength(1);
  });

  it("tops up a Trigger level only when the Trigger actually fires that date", async () => {
    // The price crosses 100 on day two — the entry — and again on the contribution date itself.
    // No third crossing happens, so no other day can top up.
    const closes = [90, 110, 110, 110, 90, 130, 130, 130, 130, 130];
    const result = await runWith({
      closes,
      buyLevels: [buyLevel("b25", 25, priceCrossesAboveSignal(100))],
    });

    expect(result.trades.map((trade) => trade.date)).toEqual([
      dates[1],
      contributionDate,
    ]);
  });

  it("does not top up a Trigger level whose Trigger is silent on the contribution date", async () => {
    // One crossing only, well before the deposit. The contribution must not revive the event.
    const closes = [90, 110, 110, 110, 110, 110, 110, 110, 110, 110];
    const result = await runWith({
      closes,
      buyLevels: [buyLevel("b25", 25, priceCrossesAboveSignal(100))],
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.date).toBe(dates[1]);
  });

  it("buys nothing when the position already covers its recalculated target", async () => {
    // The price triples after entry, so 25% of the larger full position is still below what the
    // position is already worth.
    const closes = dates.map((_, index) => (index === 0 ? 100 : 300));
    const result = await runWith({
      closes,
      buyLevels: [buyLevel("b25", 25, alwaysTrue())],
      monthlyContribution: 1_000,
    });

    expect(result.trades).toHaveLength(1);
  });

  it("still lets a higher unused BUY level fire normally on an ordinary day", async () => {
    // The 25% level enters on day one; the 100% level's Condition only becomes true on day three,
    // which is not a contribution date.
    const closes = [100, 100, 80, 80, 80, 80, 80, 80, 80, 80];
    const result = await runWith({
      closes,
      buyLevels: [
        buyLevel("b25", 25, priceAboveSignal(90)),
        buyLevel("b100", 100, priceBelowSignal(90)),
      ],
      monthlyContribution: 0,
    });

    expect(result.trades).toHaveLength(2);
    expect(result.trades[1]?.date).toBe(dates[2]);
    expect(result.trades[1]?.levelPercentage).toBe(100);
  });

  it("caps a top-up at available cash", async () => {
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
    });
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 10_000,
        monthlyContribution: 100,
        // One slot, so the whole portfolio is the position's target and cash is the only limit.
        maximumPositions: 1,
      }),
    );

    expect(result.equity.every((point) => Number(point.cash) >= -1e-9)).toBe(
      true,
    );
    const topUp = result.trades.find(
      (trade) => trade.date === contributionDate,
    );
    expect(topUp?.amount).toBeCloseTo(100, 6);
  });

  it("replays a run containing top-ups identically", async () => {
    const closes = dates.map((_, index) => 100 + Math.sin(index) * 8);
    const build = () =>
      runWith({
        closes,
        buyLevels: [
          buyLevel("b25", 25, priceAboveSignal(95)),
          buyLevel("b100", 100, priceBelowSignal(95)),
        ],
        monthlyContribution: 25_000,
      });

    const [first, second] = await Promise.all([build(), build()]);
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
    expect(first.trades.length).toBeGreaterThan(1);
  });
});

/**
 * One deterministic ledger that exercises the whole V1 methodology at once, with numbers a reader
 * can verify by hand. It exists because the individual rules are easy to keep true in isolation and
 * easy to break in combination — every amount below is the arithmetic the documented methodology
 * requires, not a snapshot of whatever the engine happened to produce.
 */
describe("end-to-end methodology ledger", () => {
  function weekdays(start: string, months: number): string[] {
    const out: string[] = [];
    const cursor = new Date(`${start}T00:00:00.000Z`);
    const end = new Date(cursor);
    end.setUTCMonth(end.getUTCMonth() + months);
    while (cursor < end) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) {
        out.push(cursor.toISOString().slice(0, 10));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  it("prices a full lifecycle: DCA top-ups, a second level, a partial sell, a final exit and re-entry", async () => {
    const dates = weekdays("2021-01-04", 6);
    // Flat, then a dip that arms the 100% level, then a rally that arms the SELL, then a collapse
    // that arms the FINAL EXIT, then a deeper level for the re-entered position to top up into.
    const closes = dates.map((_, index) => {
      if (index < 40) return 100;
      if (index < 60) return 80;
      if (index < 90) return 150;
      if (index < 100) return 55;
      return 40;
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceAboveSignal(90)),
            buyLevel("b100", 100, priceBelowSignal(90)),
          ],
          sellLevels: [sellLevel("s50", 50, gainAboveSignal(40))],
          finalExit: finalExit("fx", lossAboveSignal(30)),
        }),
        securities: [securityInput(frameOf({ symbol: "AAA", dates, closes }))],
        initialCapital: 100_000,
        monthlyContribution: 20_000,
        maximumPositions: 10,
      }),
    );

    const ledger = result.trades.map((trade) => [
      trade.date,
      trade.action,
      trade.levelPercentage,
      Number(Number(trade.amount).toFixed(2)),
      Number(Number(trade.sharesAfter).toFixed(4)),
    ]);

    expect(ledger).toEqual([
      // Day one is funded by the initial capital alone: 25% of a 10,000 full position.
      ["2021-01-04", "BUY", 25, 2_500, 25],
      // First contribution date. The level has fired, but 20,000 of new capital lifts the portfolio
      // to 120,000, so its target becomes 3,000 and only the 500 shortfall is bought.
      ["2021-02-01", "BUY", 25, 500, 30],
      // The dip arms the 100% level for the first time: a normal firing, not a top-up.
      ["2021-03-01", "BUY", 100, 11_540, 174.25],
      // Gain over the 83.4433 average cost exceeds 40%: half the remaining position is sold.
      ["2021-03-29", "SELL", 50, 13_068.75, 87.125],
      // 1 April and 3 May are contribution dates on which the 25% level's Condition is true, but the
      // position already exceeds its recalculated target, so nothing is bought.
      // Loss against that same basis passes 30%: FINAL EXIT closes the whole remaining position.
      ["2021-05-10", "FINAL_EXIT", null, 4_791.88, 0],
      // The next eligible date, never the same one: a fresh position with fresh level state.
      ["2021-05-11", "BUY", 100, 18_332.06, 333.3102],
      // Two more contribution dates top the re-entered position up to its recalculated target.
      ["2021-06-01", "BUY", 100, 6_499.69, 495.8024],
      ["2021-07-01", "BUY", 100, 2_000, 545.8024],
    ]);

    // Seven calendar months are simulated and six contributions land: the opening month is funded
    // by the initial capital instead.
    expect(Number(result.summary.investedCapital)).toBe(100_000 + 6 * 20_000);
    expect(Number(result.summary.realizedPnl)).toBeCloseTo(3_320.625, 3);
    expect(result.summary.openPositions).toBe(1);

    // A partial sell leaves the basis per share untouched; a top-up blends it.
    const sell = result.trades.find((trade) => trade.action === "SELL");
    const beforeSell = result.trades[2];
    expect(sell?.averageCostAfter).toBeCloseTo(
      Number(beforeSell?.averageCostAfter),
      6,
    );
    expect(result.positions[0]?.averageCost).toBeCloseTo(49.1602, 4);
  });
});

/**
 * A decades-long run's user-visible progression is its years. They are emitted as milestones so a
 * worker can persist every one of them even inside its write throttle, and there are at most about
 * thirty of them in a V1 run.
 */
/**
 * Every canonical string the engine emits carries its declared scale, and only its declared scale.
 *
 * This is the guard that `MoneyString` and `SharesString` do not provide. They are aliases for
 * `string`, so nothing stops `moneyString` being written where `priceString` was meant — and the
 * mistake is invisible at the type level *and* at the value level, because a decimal comparison
 * ignores trailing zeros. It only surfaces when PostgreSQL rounds the extra digits away, at which
 * point a price has silently lost two decimal places in a column that was meant to hold them.
 *
 * Branding the aliases would catch it at the call site, and would also require a cast at every
 * boundary the values cross — Prisma reads, JSON, every fixture in every suite — for a mistake this
 * catches directly, over a real run, in one place. So the aliases stay documentary and this is the
 * property that is actually enforced.
 */
describe("persisted scales", () => {
  const decimals = (value: string): number => value.split(".")[1]?.length ?? 0;

  it("emits six decimals of money, ten of shares and eight of price, everywhere", async () => {
    const dates = ["2021-01-04", "2021-01-05", "2021-01-06", "2021-01-07"];
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceAboveSignal(1))],
          sellLevels: [sellLevel("s50", 50, gainAboveSignal(1))],
        }),
        securities: [
          securityInput(
            frameOf({ symbol: "AAA", dates, closes: [100, 137, 211, 311] }),
          ),
        ],
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 3,
      }),
    );

    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect([trade.action, decimals(trade.amount)]).toEqual([trade.action, 6]);
      expect(decimals(trade.fees)).toBe(6);
      expect(decimals(trade.cashAfter)).toBe(6);
      expect(decimals(trade.shares)).toBe(10);
      expect(decimals(trade.sharesAfter)).toBe(10);
      expect(decimals(trade.price)).toBe(8);
      if (trade.realizedPnl !== null) {
        expect(decimals(trade.realizedPnl)).toBe(6);
      }
      if (trade.averageCostAfter !== null) {
        expect(decimals(trade.averageCostAfter)).toBe(8);
      }
    }

    expect(result.equity.length).toBeGreaterThan(0);
    for (const point of result.equity) {
      for (const value of [
        point.cash,
        point.positionsValue,
        point.totalValue,
        point.investedCapital,
        point.cashBaselineValue,
      ]) {
        expect(decimals(value)).toBe(6);
      }
      if (point.benchmarkValue !== null) {
        expect(decimals(point.benchmarkValue)).toBe(6);
      }
    }

    for (const position of result.positions) {
      expect(decimals(position.shares)).toBe(10);
      expect(decimals(position.averageCost)).toBe(8);
      expect(decimals(position.lastPrice)).toBe(8);
      expect(decimals(position.marketValue)).toBe(6);
      expect(decimals(position.unrealizedPnl)).toBe(6);
    }

    for (const value of [
      result.summary.investedCapital,
      result.summary.finalCash,
      result.summary.finalPositionsValue,
      result.summary.finalValue,
      result.summary.netProfit,
      result.summary.realizedPnl,
      result.summary.unrealizedPnl,
    ]) {
      expect(decimals(value)).toBe(6);
    }
  });
});

describe("annual milestone checkpoints", () => {
  function yearsOfWeekdays(startYear: number, years: number): string[] {
    const out: string[] = [];
    const cursor = new Date(Date.UTC(startYear, 0, 1));
    const end = new Date(Date.UTC(startYear + years, 0, 1));
    while (cursor < end) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) {
        out.push(cursor.toISOString().slice(0, 10));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  async function runYears(years: number) {
    const dates = yearsOfWeekdays(1996, years);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map((_, index) => 100 + index * 0.01),
    });
    const seen: BacktestCheckpoint[] = [];
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 25, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        startDate: dates[0] as string,
        endDate: dates[dates.length - 1] as string,
      }),
      {
        checkpointEveryDays: 5,
        onCheckpoint: (checkpoint) => {
          seen.push(checkpoint);
        },
      },
    );
    return { dates, seen, result };
  }

  it("emits one milestone per completed calendar year, in order", async () => {
    const { seen } = await runYears(30);
    const milestones = seen
      .filter((checkpoint) => checkpoint.milestone !== null)
      .map((checkpoint) => checkpoint.milestone);

    // 1996..2024 complete inside the run; 2025 is closed by the final date, which is the result
    // rather than a checkpoint.
    expect(milestones).toEqual(
      Array.from({ length: 29 }, (_, index) => String(1996 + index)),
    );
  });

  it("marks a milestone on the last simulated date of its year, not the first of the next", async () => {
    const { seen } = await runYears(3);
    const first = seen.find((checkpoint) => checkpoint.milestone === "1996");
    expect(first?.simulatedThrough.slice(0, 4)).toBe("1996");
    expect(first?.simulatedThrough).toBe("1996-12-31");
  });

  it("carries real simulated state at each milestone, monotonic in days and curve length", async () => {
    const { seen } = await runYears(5);
    const milestones = seen.filter(
      (checkpoint) => checkpoint.milestone !== null,
    );

    expect(milestones.length).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < milestones.length; index += 1) {
      const previous = milestones[index - 1] as BacktestCheckpoint;
      const current = milestones[index] as BacktestCheckpoint;
      expect(current.simulatedThrough > previous.simulatedThrough).toBe(true);
      expect(current.completedDays).toBeGreaterThan(previous.completedDays);
      expect(current.curve.at(-1)?.date).toBe(current.simulatedThrough);
      expect(current.totalValue).toBeGreaterThan(0);
    }
  });

  it("keeps milestones bounded: a 30-year run produces about one per year", async () => {
    const { seen } = await runYears(30);
    const milestones = seen.filter(
      (checkpoint) => checkpoint.milestone !== null,
    );
    expect(milestones.length).toBeLessThanOrEqual(31);
  });
});

/**
 * A backtest exists from the first day of its period, whatever its securities were doing then. A
 * portfolio that holds nothing but cash has a real, knowable value and a return of exactly zero;
 * a curve that only began at the first BUY would hide years of the decision not to buy.
 */
/**
 * A BUY percentage is an allocation tier, not an independent event.
 *
 * Two behaviours used to fall out of treating levels as unrelated: a smaller tier could resurrect
 * and buy on an ordinary day once a position drifted below it — continuous rebalancing arriving
 * through a multi-level strategy — and whether a level was consumed turned on whether the cash
 * balance happened to be zero or a cent.
 */
describe("BUY allocation tiers", () => {
  it("funds the highest matching tier and settles every smaller one with it", async () => {
    const dates = tradingDates("2020-01-06", 6);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceBelowSignal(1_000)),
            buyLevel("b50", 50, priceBelowSignal(1_000)),
            buyLevel("b100", 100, priceBelowSignal(1_000)),
          ],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    expect(
      result.trades.map((trade) => [trade.levelId, Number(trade.amount)]),
    ).toEqual([["b100", 100_000]]);
  });

  it("does not resurrect a smaller tier when the position falls below it", async () => {
    const dates = tradingDates("2020-01-06", 8);
    // Filled at 100 on day 0, then the price collapses to a tenth — far below the 25% target.
    const closes = dates.map((_unused, index) => (index === 0 ? 100 : 10));
    const frame = frameOf({ symbol: "AAA", dates, closes });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceBelowSignal(1_000)),
            buyLevel("b100", 100, priceBelowSignal(1_000)),
          ],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 4,
      }),
    );

    // One trade, on the first day. No contribution was made, so nothing may buy again: reaching
    // the 100% tier satisfied the 25% one by definition.
    expect(result.trades.map((trade) => [trade.date, trade.levelId])).toEqual([
      [dates[0], "b100"],
    ]);
  });

  it("settles a tier that could only be filled as far as the cash went", async () => {
    const dates = tradingDates("2020-01-06", 8);
    // AAA fills first and then multiplies, inflating every later target while the cash left behind
    // stays where it was.
    const aaa = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map((_unused, index) => (index === 0 ? 100 : 1_000)),
    });
    const ccc = frameOf({
      symbol: "CCC",
      dates: dates.slice(1),
      closes: dates.slice(1).map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceBelowSignal(5_000))],
        }),
        securities: [securityInput(aaa), securityInput(ccc)],
        startDate: dates[0] as string,
        endDate: dates[dates.length - 1] as string,
        executionCalendar: dates,
        initialCapital: 1_000,
        maximumPositions: 3,
      }),
    );

    const cccTrades = result.trades.filter((trade) => trade.symbol === "CCC");
    expect(cccTrades).toHaveLength(1);
    expect(cccTrades[0]?.amount).toBeCloseTo(666.67, 2);
    expect(result.summary.finalCash).toBeCloseTo(0, 8);
  });

  it("settles an existing position's tier even with no cash at all", async () => {
    const dates = tradingDates("2020-01-06", 10);
    // AAA opens on day 0 and spends everything. On day 1 its 100% tier is reconsidered — it is not
    // settled for CCC's sake — but there is nothing left to spend.
    const aaa = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map((_unused, index) => (index === 0 ? 100 : 50)),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b50", 50, priceBelowSignal(1_000)),
            buyLevel("b100", 100, priceBelowSignal(1_000)),
          ],
        }),
        securities: [securityInput(aaa)],
        initialCapital: 1_000,
        maximumPositions: 1,
      }),
    );

    // Exactly one entry. Zero cash consumed the opportunity just as a cent would have.
    expect(result.trades).toHaveLength(1);
    expect(result.summary.finalCash).toBeCloseTo(0, 8);
  });

  it("opens no position, and consumes nothing, when there is no cash to open one with", async () => {
    const dates = tradingDates("2020-01-06", 10);
    const aaa = frameOf({
      symbol: "AAA",
      dates,
      // Flat, then above the SELL threshold so the position closes and releases its cash.
      closes: dates.map((_unused, index) => (index < 4 ? 100 : 200)),
    });
    // BBB becomes eligible on day 1, by which time AAA has spent the lot. Later, AAA's exit frees
    // the cash and BBB must still be able to enter.
    const bbb = frameOf({
      symbol: "BBB",
      dates: dates.slice(1),
      closes: dates.slice(1).map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceBelowSignal(1_000))],
          // AAA exits completely once it has risen, freeing the cash BBB could not find earlier.
          finalExit: finalExit("x1", priceAboveSignal(150)),
        }),
        securities: [securityInput(aaa), securityInput(bbb)],
        startDate: dates[0] as string,
        endDate: dates[dates.length - 1] as string,
        executionCalendar: dates,
        initialCapital: 1_000,
        maximumPositions: 2,
      }),
    );

    // No zero-share BBB position was ever created, and BBB's opportunity was not consumed by the
    // day it could not afford: it enters once cash exists again.
    const bbbTrades = result.trades.filter((trade) => trade.symbol === "BBB");
    expect(bbbTrades.length).toBeGreaterThan(0);
    expect(Number(bbbTrades[0]?.shares)).toBeGreaterThan(0);
    expect(result.trades.every((trade) => Number(trade.shares) > 0)).toBe(true);
  });
});

describe("the execution calendar is authoritative", () => {
  const market = tradingDates("2020-01-02", 60);

  it("A: a security's date that the market never traded cannot become a simulated date", async () => {
    // A bar on New Year's Day, when the exchange was shut.
    const rogue = ["2020-01-01", ...market];
    const frame = frameOf({
      symbol: "AAA",
      dates: rogue,
      closes: rogue.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(1_000))],
        }),
        securities: [securityInput(frame)],
        startDate: "2020-01-01",
        endDate: market[market.length - 1] as string,
        executionCalendar: market,
        initialCapital: 10_000,
        maximumPositions: 1,
      }),
    );

    expect(result.summary.firstSimulatedDate).toBe(market[0]);
    expect(result.summary.tradingDays).toBe(market.length);
    expect(result.equity.some((point) => point.date === "2020-01-01")).toBe(
      false,
    );
    expect(result.trades[0]?.date).toBe(market[0]);
  });

  it("B: a security missing a real trading day simply does nothing that day", async () => {
    // AAA is absent for a stretch in the middle; the market kept trading.
    const gapped = [...market.slice(0, 10), ...market.slice(20)];
    const frame = frameOf({
      symbol: "AAA",
      dates: gapped,
      closes: gapped.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(1_000))],
        }),
        securities: [securityInput(frame)],
        startDate: market[0] as string,
        endDate: market[market.length - 1] as string,
        executionCalendar: market,
        initialCapital: 10_000,
        maximumPositions: 1,
      }),
    );

    // Every market day is simulated, and the holding is carried through the gap at its last close.
    expect(result.summary.tradingDays).toBe(market.length);
    const inGap = result.equity.filter(
      (point) =>
        point.date > (market[9] as string) &&
        point.date < (market[20] as string),
    );
    expect(inGap.length).toBeGreaterThan(0);
    expect(inGap.every((point) => point.openPositions === 1)).toBe(true);
    expect(result.trades.every((trade) => market.includes(trade.date))).toBe(
      true,
    );
  });

  it("C: contribution dates come only from the authoritative calendar", async () => {
    // The security carries an extra bar on a Saturday the market never opened. If it could reach
    // the axis it would steal that month's first eligible date from the market's.
    const rogue = [...market, "2020-03-28"].sort();
    const frame = frameOf({
      symbol: "AAA",
      dates: rogue,
      closes: rogue.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        // Nothing ever matches, so cash simply accumulates and every step in invested capital is
        // a contribution rather than a trade.
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(1))],
        }),
        securities: [securityInput(frame)],
        startDate: market[0] as string,
        endDate: market[market.length - 1] as string,
        executionCalendar: market,
        initialCapital: 10_000,
        monthlyContribution: 1_000,
        maximumPositions: 1,
      }),
    );

    const contributions = result.equity
      .filter(
        (point, index) =>
          index > 0 &&
          point.investedCapital !==
            (result.equity[index - 1]?.investedCapital ?? 0),
      )
      .map((point) => point.date);
    expect(contributions.length).toBeGreaterThan(0);
    expect(contributions.every((date) => market.includes(date))).toBe(true);
    expect(contributions).not.toContain("2020-03-28");
  });

  it("E: a security listing mid-period still joins on its own first market day", async () => {
    const late = market.slice(30);
    const frame = frameOf({
      symbol: "IPO",
      dates: late,
      closes: late.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        startDate: market[0] as string,
        endDate: market[market.length - 1] as string,
        executionCalendar: market,
        initialCapital: 10_000,
        maximumPositions: 1,
      }),
    );

    // The run exists from the market's first day; the security participates from its own.
    expect(result.summary.firstSimulatedDate).toBe(market[0]);
    expect(result.summary.tradingDays).toBe(market.length);
    expect(result.trades[0]?.date).toBe(late[0]);
  });
});

describe("the comparison benchmark is passive", () => {
  const MARKET_DATES = tradingDates("2020-01-06", 200);

  /**
   * Dates the market never traded on: every market day shifted by one, so a Friday becomes a
   * Saturday, plus a month that starts earlier than any market date.
   *
   * The point is that these dates are *not* a subset of the execution calendar. A benchmark whose
   * days merely overlapped the market's could join the union unnoticed; one that trades on days the
   * market did not would change the axis, the first simulated date and the first trading date of a
   * month the moment it were allowed to.
   */
  const OFF_CALENDAR_DATES = [
    "2020-01-01",
    ...MARKET_DATES.map((date) => {
      const shifted = new Date(`${date}T00:00:00.000Z`);
      shifted.setUTCDate(shifted.getUTCDate() + 1);
      return shifted.toISOString().slice(0, 10);
    }),
  ];

  /**
   * Two runs identical but for what they are compared against.
   *
   * The benchmarks deliberately trade on *different* calendars — one on the market's days, one on
   * a sparse subset shifted off them — because the failure this guards against is not a wrong
   * number, it is the benchmark quietly joining the execution calendar and moving the dates a
   * contribution lands on.
   */
  async function comparedAgainst(
    benchmarkDates: readonly string[],
    closeStep = 3,
  ) {
    const marketDates = tradingDates("2020-01-06", 200);
    const closes = marketDates.map((_, index) => (index < 60 ? 100 : 80));
    const frame = frameOf({ symbol: "AAA", dates: marketDates, closes });

    return simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 50, priceBelowSignal(90))],
        }),
        securities: [securityInput(frame)],
        startDate: marketDates[0] as string,
        endDate: marketDates[marketDates.length - 1] as string,
        initialCapital: 10_000,
        monthlyContribution: 1_000,
        maximumPositions: 2,
        executionCalendar: marketDates,
        benchmark: benchmarkSeries({
          dates: [...benchmarkDates],
          closes: benchmarkDates.map((_, index) => 400 + index * closeStep),
        }),
      }),
    );
  }

  it("cannot change the portfolio's trades or its return", async () => {
    const dense = await comparedAgainst(MARKET_DATES);
    const offCalendar = await comparedAgainst(OFF_CALENDAR_DATES);
    const sparse = offCalendar;

    expect(
      sparse.trades.map((trade) => [trade.date, trade.action, trade.shares]),
    ).toEqual(
      dense.trades.map((trade) => [trade.date, trade.action, trade.shares]),
    );
    expect(sparse.summary.portfolioReturnPercent).toBe(
      dense.summary.portfolioReturnPercent,
    );
    expect(sparse.summary.finalValue).toBe(dense.summary.finalValue);
    expect(sparse.summary.investedCapital).toBe(dense.summary.investedCapital);
    expect(sparse.summary.maxDrawdownPercent).toBe(
      dense.summary.maxDrawdownPercent,
    );
  });

  it("cannot change which dates a monthly contribution lands on", async () => {
    const dense = await comparedAgainst(MARKET_DATES);
    const sparse = await comparedAgainst(OFF_CALENDAR_DATES);

    // Invested capital rises only on a contribution date, so the dates it steps on are the
    // contribution dates — read off the curve rather than asserted from the rule under test.
    const contributionDates = (
      result: Awaited<ReturnType<typeof comparedAgainst>>,
    ) =>
      result.equity
        .filter(
          (point, index) =>
            index > 0 &&
            point.investedCapital !==
              (result.equity[index - 1]?.investedCapital ?? 0),
        )
        .map((point) => point.date);

    expect(contributionDates(sparse)).toEqual(contributionDates(dense));
    expect(contributionDates(dense).length).toBeGreaterThan(1);
    expect(sparse.equity.map((point) => point.date)).toEqual(
      dense.equity.map((point) => point.date),
    );
  });

  it("does change the benchmark return and the alpha", async () => {
    const dense = await comparedAgainst(MARKET_DATES);
    const sparse = await comparedAgainst(OFF_CALENDAR_DATES, 7);

    // The comparison is the one thing that may differ, and here it must: the two series have
    // different closes on the run's last day.
    expect(sparse.summary.benchmarkReturnPercent).not.toBe(
      dense.summary.benchmarkReturnPercent,
    );
    expect(sparse.summary.alphaPercent).not.toBe(dense.summary.alphaPercent);
  });

  it("cannot extend a run past the days the market and its securities traded", async () => {
    const marketDates = tradingDates("2020-01-06", 40);
    const frame = frameOf({
      symbol: "AAA",
      dates: marketDates,
      closes: marketDates.map(() => 100),
    });
    // The benchmark keeps quoting long after the run's own calendar ends.
    const benchmarkDates = tradingDates("2020-01-06", 400);

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        startDate: marketDates[0] as string,
        endDate: benchmarkDates[benchmarkDates.length - 1] as string,
        executionCalendar: marketDates,
        benchmark: benchmarkSeries({
          dates: benchmarkDates,
          closes: benchmarkDates.map((_, index) => 400 + index),
        }),
      }),
    );

    expect(result.summary.lastSimulatedDate).toBe(
      marketDates[marketDates.length - 1],
    );
    expect(result.equity).toHaveLength(marketDates.length);
  });
});

describe("the period, not the data, defines the run", () => {
  it("reports a flat 0% for the months before the first trade", async () => {
    const dates = tradingDates("2020-01-06", 60);
    // Nothing satisfies the BUY rule until the price finally drops on day 41.
    const closes = dates.map((_, index) => (index < 40 ? 100 : 80));
    const frame = frameOf({ symbol: "AAA", dates, closes });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceBelowSignal(90))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
      }),
    );

    const firstTrade = result.trades[0]?.date as string;
    const beforeTrading = result.equity.filter(
      (point) => point.date < firstTrade,
    );
    expect(beforeTrading).toHaveLength(40);
    expect(beforeTrading.every((point) => point.returnIndex === 1)).toBe(true);
    expect(
      beforeTrading.every((point) => Number(point.totalValue) === 100_000),
    ).toBe(true);
    expect(result.equity[0]?.date).toBe(dates[0]);
  });

  it("simulates from the period start even when every security lists years later", async () => {
    // The securities begin trading in the third year; the market traded the whole period.
    const marketDates = tradingDates("2020-01-06", 780);
    const lateDates = marketDates.slice(520);
    const frame = frameOf({
      symbol: "IPO",
      dates: lateDates,
      closes: lateDates.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        startDate: marketDates[0] as string,
        endDate: marketDates[marketDates.length - 1] as string,
        initialCapital: 100_000,
        executionCalendar: marketDates,
      }),
    );

    // The run exists from its first day: cash only, 0%, no position, no fabricated price.
    expect(result.equity[0]?.date).toBe(marketDates[0]);
    expect(Number(result.equity[0]?.totalValue)).toBe(100_000);
    expect(result.summary.firstSimulatedDate).toBe(marketDates[0]);
    const beforeListing = result.equity.filter(
      (point) => point.date < (lateDates[0] as string),
    );
    expect(beforeListing.length).toBeGreaterThan(400);
    expect(beforeListing.every((point) => point.openPositions === 0)).toBe(
      true,
    );
    expect(beforeListing.every((point) => point.returnIndex === 1)).toBe(true);
    // And the security participates from its first real price, never before it.
    expect(result.trades[0]?.date).toBe(lateDates[0]);
  });

  it("keeps the securities' own axis when the run has no execution calendar", async () => {
    const dates = tradingDates("2020-01-06", 10);
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
      }),
    );

    expect(result.equity).toHaveLength(dates.length);
  });

  it("begins on the first eligible trading day when the requested start is a weekend", async () => {
    const dates = tradingDates("2020-01-06", 10);
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
        // Saturday. No market data exists for it, so the first financial point is the Monday.
        startDate: "2020-01-04",
        endDate: dates[dates.length - 1] as string,
      }),
    );

    expect(result.summary.firstSimulatedDate).toBe("2020-01-06");
    expect(result.equity[0]?.date).toBe("2020-01-06");
  });
});

/**
 * Securities whose history does not span the run.
 *
 * These are pinned rather than designed: what a security's missing trailing history *means* —
 * delisting, a suspension, or a provider gap — is not something the available data can tell us,
 * so the engine's behaviour is documented and tested exactly as it is.
 */
describe("securities whose history does not span the run", () => {
  it("cannot buy, hold or price a security before its first trading day", async () => {
    const full = tradingDates("2020-01-06", 40);
    const late = full.slice(20);
    const older = frameOf({
      symbol: "OLD",
      dates: full,
      closes: full.map(() => 100),
    });
    const listedLater = frameOf({
      symbol: "NEW",
      dates: late,
      closes: late.map(() => 50),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(older), securityInput(listedLater)],
        startDate: full[0] as string,
        endDate: full[full.length - 1] as string,
        maximumPositions: 2,
      }),
    );

    const newTrades = result.trades.filter((trade) => trade.symbol === "NEW");
    expect(newTrades[0]?.date).toBe(late[0]);
    // Before its listing it occupies no slot and contributes no value: the equity points in that
    // window hold exactly one position, the older security's.
    const beforeListing = result.equity.filter(
      (point) => point.date < (late[0] as string),
    );
    expect(beforeListing.every((point) => point.openPositions === 1)).toBe(
      true,
    );
  });

  it("never lets a Trigger use a fabricated previous value on a security's first day", async () => {
    const full = tradingDates("2020-01-06", 20);
    const late = full.slice(10);
    const frame = frameOf({
      symbol: "NEW",
      dates: late,
      closes: late.map(() => 120),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          // A crossing needs a previous eligible value; the security's first day has none.
          buyLevels: [buyLevel("b1", 100, priceCrossesAboveSignal(100))],
        }),
        securities: [securityInput(frame)],
        startDate: full[0] as string,
        endDate: full[full.length - 1] as string,
      }),
    );

    expect(result.trades).toHaveLength(0);
  });

  it("carries a position at its last known close when the security stops reporting", async () => {
    // PINNED, NOT DESIGNED. The provider gives a current `isActivelyTrading` flag and a listing
    // date, but no point-in-time delisting date — and today's flag says nothing about a simulated
    // 2008. A missing trailing price is therefore indistinguishable from a suspension or a data
    // gap, so the engine carries the last real close forward and reports the date it came from.
    // Neither a forced liquidation nor a write-down may be invented from absence.
    const full = tradingDates("2020-01-06", 40);
    const truncated = full.slice(0, 20);
    const frame = frameOf({
      symbol: "GONE",
      dates: truncated,
      closes: truncated.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        startDate: full[0] as string,
        endDate: full[full.length - 1] as string,
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    const position = result.positions[0];
    expect(position?.symbol).toBe("GONE");
    // The value is held at the last real close, and the date that close came from is reported, so
    // a stale holding is visible rather than silent.
    expect(Number(position?.lastPrice)).toBe(100);
    expect(position?.lastPriceDate).toBe(truncated[truncated.length - 1]);
    // With no benchmark and no other security still reporting, there are no market dates left to
    // simulate, so the run ends where its data ends rather than inventing days to fill the period.
    expect(result.summary.lastSimulatedDate).toBe(
      truncated[truncated.length - 1],
    );
    // No trade is invented after the data ends.
    expect(
      result.trades.every(
        (trade) => trade.date <= (truncated[truncated.length - 1] as string),
      ),
    ).toBe(true);
  });

  it("keeps valuing a stale holding to the end of the period while the market still trades", async () => {
    const full = tradingDates("2020-01-06", 40);
    const truncated = full.slice(0, 20);
    const frame = frameOf({
      symbol: "GONE",
      dates: truncated,
      closes: truncated.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, priceAboveSignal(0))],
        }),
        securities: [securityInput(frame)],
        startDate: full[0] as string,
        endDate: full[full.length - 1] as string,
        initialCapital: 100_000,
        maximumPositions: 1,
        executionCalendar: full,
      }),
    );

    // The market calendar continues, so the run does too — and the holding is carried at the last
    // close it actually had, with the date that close came from reported alongside it.
    expect(result.summary.lastSimulatedDate).toBe(full[full.length - 1]);
    expect(Number(result.positions[0]?.lastPrice)).toBe(100);
    expect(result.positions[0]?.lastPriceDate).toBe(
      truncated[truncated.length - 1],
    );
    const afterData = result.equity.filter(
      (point) => point.date > (truncated[truncated.length - 1] as string),
    );
    expect(afterData.length).toBeGreaterThan(0);
    expect(
      afterData.every((point) => point.totalValue === afterData[0]?.totalValue),
    ).toBe(true);
  });

  it("takes no action for a security on the dates it has no price", async () => {
    const full = tradingDates("2020-01-06", 30);
    const gapped = [...full.slice(0, 10), ...full.slice(20)];
    const frame = frameOf({
      symbol: "GAP",
      dates: gapped,
      closes: gapped.map(() => 100),
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 25, priceAboveSignal(0))],
          sellLevels: [sellLevel("s1", 25, gainAboveSignal(-1000))],
        }),
        securities: [securityInput(frame)],
        startDate: full[0] as string,
        endDate: full[full.length - 1] as string,
      }),
    );

    const inGap = new Set(full.slice(10, 20));
    expect(result.trades.every((trade) => !inGap.has(trade.date))).toBe(true);
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
