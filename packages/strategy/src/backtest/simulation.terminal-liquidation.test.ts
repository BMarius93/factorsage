import { describe, expect, it } from "vitest";
import {
  BACKTEST_METHODOLOGY,
  TERMINAL_LIQUIDATION_METHODOLOGY_VERSION,
} from "./methodology.js";
import {
  buyLevel,
  definitionOf,
  executionInput,
  finalExit,
  frameOf,
  gainAboveSignal,
  liquidationTrades,
  priceAboveSignal,
  priceBelowSignal,
  securityInput,
  sellLevel,
  strategyTrades,
  tradingDates,
} from "./backtest.test-helper.js";
import { simulateBacktest } from "./simulate.js";
import type { BacktestResult } from "./types.js";

/**
 * The end of a simulated period is not a strategy decision.
 *
 * `TERMINAL_LIQUIDATION_METHODOLOGY_VERSION` says what happens there: every position still open is
 * sold at the canonical price the final day valued it at, so a completed run reports what the user
 * would actually be holding — cash — rather than a portfolio frozen mid-trade. These cases pin the
 * three properties that make that trustworthy: nothing is left open, nothing is created or
 * destroyed, and the sale is never mistaken for the strategy's own FINAL EXIT.
 */

const ALWAYS = 0;

/** Total of every value the ledger moved, for the reconciliation cases. */
function sum(values: readonly (string | null)[]): number {
  return values.reduce<number>((total, value) => total + Number(value ?? 0), 0);
}

function decimals(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

/** One always-buying security, held to the end of the period. */
async function heldToTheEnd(
  closes: readonly number[],
): Promise<BacktestResult> {
  const dates = tradingDates("2020-01-06", closes.length);
  return simulateBacktest(
    executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b100", 100, priceAboveSignal(ALWAYS))],
      }),
      securities: [securityInput(frameOf({ symbol: "AAA", dates, closes }))],
      initialCapital: 100_000,
      maximumPositions: 1,
    }),
  );
}

describe("terminal liquidation", () => {
  it("sells a position still open on the final day and ends the run in cash", async () => {
    const result = await heldToTheEnd([100, 100, 125]);

    const closeOut = liquidationTrades(result);
    expect(closeOut).toHaveLength(1);
    expect(closeOut[0]?.action).toBe("SELL");
    expect(closeOut[0]?.source).toBe("END_OF_BACKTEST");
    expect(closeOut[0]?.date).toBe(result.summary.lastSimulatedDate);
    // 1,000 shares bought at 100 with the whole 100,000, marked at 125 on the last day.
    expect(Number(closeOut[0]?.shares)).toBeCloseTo(1_000, 10);
    expect(Number(closeOut[0]?.price)).toBe(125);
    expect(Number(closeOut[0]?.amount)).toBeCloseTo(125_000, 6);
    expect(Number(closeOut[0]?.sharesAfter)).toBe(0);

    expect(result.positions).toHaveLength(0);
    expect(result.summary.openPositions).toBe(0);
    expect(Number(result.summary.finalCash)).toBeCloseTo(125_000, 6);
    expect(Number(result.summary.finalPositionsValue)).toBe(0);
    expect(Number(result.summary.unrealizedPnl)).toBe(0);
  });

  it("liquidates every open position, in the engine's own order, losing no value", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const securities = ["ZZZ", "AAA", "MMM"].map((symbol, index) =>
      securityInput(
        frameOf({
          symbol,
          dates,
          closes: [100, 100, 100 + index * 10],
        }),
      ),
    );

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceAboveSignal(ALWAYS))],
        }),
        securities,
        initialCapital: 90_000,
        maximumPositions: 3,
      }),
    );

    // Deterministic: the canonical position order is symbol, then security id.
    expect(liquidationTrades(result).map((trade) => trade.symbol)).toEqual([
      "AAA",
      "MMM",
      "ZZZ",
    ]);
    expect(result.positions).toHaveLength(0);

    // The value of the last day is unchanged by the liquidation: what the positions were worth
    // became cash, to the cent.
    const last = result.equity[result.equity.length - 1];
    const secondToLast = result.equity[result.equity.length - 2];
    expect(Number(secondToLast?.positionsValue)).toBeGreaterThan(0);
    expect(Number(last?.positionsValue)).toBe(0);
    expect(Number(last?.cash)).toBe(Number(last?.totalValue));
    expect(Number(last?.totalValue)).toBeCloseTo(
      sum(liquidationTrades(result).map((trade) => trade.amount)) +
        Number(secondToLast?.cash),
      6,
    );
  });

  it("realizes the position's whole remaining gain or loss", async () => {
    const gain = await heldToTheEnd([100, 100, 130]);
    const loss = await heldToTheEnd([100, 100, 70]);

    // 1,000 shares at a 100 basis: +30,000 and -30,000 against a 100,000 cost.
    expect(Number(liquidationTrades(gain)[0]?.realizedPnl)).toBeCloseTo(
      30_000,
      6,
    );
    expect(liquidationTrades(gain)[0]?.realizedPnlPercent).toBeCloseTo(30, 8);
    expect(Number(loss && liquidationTrades(loss)[0]?.realizedPnl)).toBeCloseTo(
      -30_000,
      6,
    );
    expect(liquidationTrades(loss)[0]?.realizedPnlPercent).toBeCloseTo(-30, 8);

    // And the summary counts them: realized P&L is the sum of every trade that realized anything.
    expect(Number(gain.summary.realizedPnl)).toBeCloseTo(
      sum(gain.trades.map((trade) => trade.realizedPnl)),
      6,
    );
  });

  it("keeps the fee seam and every persisted scale exactly as an ordinary sell does", async () => {
    // A price and a share count that do not divide cleanly, so a scale mistake cannot hide.
    const result = await heldToTheEnd([137.77, 137.77, 211.31]);
    const closeOut = liquidationTrades(result)[0];

    expect(decimals(closeOut?.amount ?? "")).toBe(6);
    expect(decimals(closeOut?.fees ?? "")).toBe(6);
    expect(decimals(closeOut?.cashAfter ?? "")).toBe(6);
    expect(decimals(closeOut?.shares ?? "")).toBe(10);
    expect(decimals(closeOut?.sharesAfter ?? "")).toBe(10);
    expect(decimals(closeOut?.price ?? "")).toBe(8);
    expect(decimals(closeOut?.realizedPnl ?? "")).toBe(6);
    // V1 executes at zero cost, through the seam rather than around it.
    expect(Number(closeOut?.fees)).toBe(0);
    expect(closeOut?.averageCostAfter).toBeNull();
    // `amount == shares x price`, exactly, as every persisted trade must satisfy.
    expect(Number(closeOut?.amount)).toBeCloseTo(
      Number(closeOut?.shares) * Number(closeOut?.price),
      6,
    );
    // Cash after the sale is the run's whole final value.
    expect(Number(closeOut?.cashAfter)).toBe(Number(result.summary.finalValue));
  });

  it("adds no second sale when an ordinary SELL already closed the position on the last day", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100, 200] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceBelowSignal(150))],
          // 100% of the position remaining, so the last day closes it outright.
          sellLevels: [
            sellLevel("s75", 75, gainAboveSignal(50)),
            sellLevel("s75b", 75, gainAboveSignal(50)),
            sellLevel("s75c", 75, gainAboveSignal(50)),
            sellLevel("s75d", 75, gainAboveSignal(50)),
          ],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    // Whatever the SELL ladder left is what the liquidation takes — and if it left nothing, there
    // is nothing to take. Either way the position is closed exactly once in total.
    const remaining = Number(
      strategyTrades(result)
        .filter((trade) => trade.action === "SELL")
        .at(-1)?.sharesAfter,
    );
    expect(liquidationTrades(result)).toHaveLength(remaining > 0 ? 1 : 0);
    expect(result.positions).toHaveLength(0);
    expect(Number(result.summary.finalPositionsValue)).toBe(0);
  });

  it("adds no second sale when FINAL EXIT closed the position on the last day", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({ symbol: "AAA", dates, closes: [100, 100, 200] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceBelowSignal(150))],
          finalExit: finalExit("fx", gainAboveSignal(50)),
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    expect(
      result.trades.filter((trade) => trade.action === "FINAL_EXIT"),
    ).toHaveLength(1);
    expect(liquidationTrades(result)).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("stays distinguishable from the strategy's own FINAL EXIT", async () => {
    // Two securities: one the strategy exits on the last day, one it never exits at all.
    const dates = tradingDates("2020-01-06", 3);
    const exiting = frameOf({ symbol: "AAA", dates, closes: [100, 100, 200] });
    const holding = frameOf({ symbol: "BBB", dates, closes: [100, 100, 100] });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b100", 100, priceAboveSignal(ALWAYS))],
          finalExit: finalExit("fx", gainAboveSignal(50)),
        }),
        securities: [securityInput(exiting), securityInput(holding)],
        initialCapital: 100_000,
        maximumPositions: 2,
      }),
    );

    const exit = result.trades.find((trade) => trade.action === "FINAL_EXIT");
    expect(exit?.symbol).toBe("AAA");
    expect(exit?.source).toBe("STRATEGY");
    // The strategy's exit names the level and the rule that produced it.
    expect(exit?.levelId).toBe("fx");
    expect(exit?.exitRuleId).toBe("fx");

    const closeOut = liquidationTrades(result);
    expect(closeOut).toHaveLength(1);
    expect(closeOut[0]?.symbol).toBe("BBB");
    // The liquidation names no level, because no level decided it.
    expect(closeOut[0]?.action).toBe("SELL");
    expect(closeOut[0]?.levelId).toBeNull();
    expect(closeOut[0]?.exitRuleId).toBeNull();
    expect(closeOut[0]?.levelPercentage).toBeNull();
  });

  it("counts the liquidation in the run's trade totals", async () => {
    const result = await heldToTheEnd([100, 100, 125]);

    expect(result.summary.totalTrades).toBe(result.trades.length);
    expect(result.summary.totalTrades).toBe(
      strategyTrades(result).length + liquidationTrades(result).length,
    );
    // It is a sale, so it is counted as one — and it is not a FINAL EXIT.
    expect(result.summary.sellTrades).toBe(1);
    expect(result.summary.finalExitTrades).toBe(0);
    // A profitable liquidation is a winning trade like any other realized sale.
    expect(result.summary.winningTrades).toBe(1);
    expect(result.summary.losingTrades).toBe(0);
    // Sequences stay contiguous: the liquidation is the run's last executed order.
    expect(result.trades.map((trade) => trade.sequence)).toEqual(
      result.trades.map((_unused, index) => index + 1),
    );
  });

  it("reconciles the final cash with the final value and with every trade that moved it", async () => {
    const dates = tradingDates("2020-01-06", 24);
    const closes = dates.map((_unused, index) => 100 + Math.sin(index) * 20);
    const securities = ["AAA", "BBB"].map((symbol) =>
      securityInput(frameOf({ symbol, dates, closes })),
    );

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b25", 25, priceAboveSignal(100)),
            buyLevel("b100", 100, priceBelowSignal(100)),
          ],
          sellLevels: [sellLevel("s50", 50, gainAboveSignal(10))],
        }),
        securities,
        initialCapital: 100_000,
        monthlyContribution: 5_000,
        maximumPositions: 2,
      }),
    );

    expect(liquidationTrades(result).length).toBeGreaterThan(0);
    expect(Number(result.summary.finalCash)).toBe(
      Number(result.summary.finalValue),
    );
    expect(Number(result.summary.finalPositionsValue)).toBe(0);
    // Invested capital plus everything realized is the final value: no value appeared or vanished
    // when the period ended.
    expect(Number(result.summary.finalValue)).toBeCloseTo(
      Number(result.summary.investedCapital) +
        Number(result.summary.realizedPnl),
      4,
    );
    expect(Number(result.summary.netProfit)).toBeCloseTo(
      Number(result.summary.realizedPnl),
      4,
    );
  });

  it("records the methodology this rule is versioned under", () => {
    expect(TERMINAL_LIQUIDATION_METHODOLOGY_VERSION).toBe(
      "liquidate-remaining-at-final-close@1",
    );
    expect(BACKTEST_METHODOLOGY.terminalLiquidation).toBe(
      TERMINAL_LIQUIDATION_METHODOLOGY_VERSION,
    );
    // Its own key, not folded into the day's execution rules: a run recorded before it existed is
    // identifiable precisely because the key is absent from its snapshot.
    expect(BACKTEST_METHODOLOGY.execution).not.toContain("liquidat");
  });
});
