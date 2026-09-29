import type {
  ConditionOperator,
  FundamentalMetricId,
  StrategyCondition,
  StrategyDefinition,
  StrategySignal,
  StrategyValue,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  buyLevel,
  definitionOf,
  executionInput,
  finalExitRules,
  frameOf,
  securityInput,
  sellLevel,
  strategyTrades,
  tradingDates,
} from "./backtest/backtest.test-helper.js";
import { simulateBacktest } from "./backtest/simulate.js";
import { Evaluability } from "./evaluability.js";
import type { EvaluationFrame } from "./frame.js";
import { buildStrategyGates, readGate } from "./gates.js";
import {
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  observeMonitorLevel,
  stepMonitorLevel,
  type MonitorLevelLifecycle,
} from "./monitor-lifecycle.js";
import {
  evaluateSignalWithoutPosition,
  monitorStrategyLevels,
} from "./monitor.js";
import {
  collectOperands,
  fundamentalMetricOperand,
  PRICE_OPERAND,
  relativeVolumeOperand,
  seriesOperand,
  type OperandKey,
} from "./operands.js";

/**
 * Fundamental Conditions through the real engine: the backtest day loop and the Monitor lifecycle.
 *
 * The frames carry exactly what the projector produces — one column per requested metric, `NaN`
 * where the metric was unavailable — and nothing else: no statements, no TTM inputs, nothing a
 * day loop could calculate a ratio from. Every trade date below follows the V1 execution rule that
 * a signal fills at the close of the session it holds on.
 */

const ROIC = fundamentalMetricOperand("ROIC_TTM");
const DEBT_TO_EQUITY = fundamentalMetricOperand("DEBT_TO_EQUITY");
const NET_MARGIN = fundamentalMetricOperand("NET_MARGIN_TTM");
const REVENUE_GROWTH = fundamentalMetricOperand("REVENUE_GROWTH_TTM_YOY");

function fundamental(
  metricId: FundamentalMetricId,
  operator: ConditionOperator,
  value: StrategyValue,
): StrategyCondition {
  return {
    id: `${metricId.toLowerCase()}-${operator.toLowerCase()}-${value.kind === "SERIES" ? value.seriesId : value.value}`,
    metric: { kind: "FUNDAMENTAL", metricId },
    operator,
    value,
  };
}

const percent = (value: number): StrategyValue => ({ kind: "PERCENT", value });
const multiple = (value: number): StrategyValue => ({
  kind: "MULTIPLE",
  value,
});

const ROIC_ABOVE_15: StrategySignal = {
  conditions: [fundamental("ROIC_TTM", "IS_ABOVE", percent(15))],
};
const DEBT_TO_EQUITY_BELOW_1: StrategySignal = {
  conditions: [fundamental("DEBT_TO_EQUITY", "IS_BELOW", multiple(1))],
};
/** Always true on a positive close, so a position exists for the SELL and FINAL EXIT cases. */
const ALWAYS: StrategySignal = {
  conditions: [
    {
      id: "price-above-0",
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 0 },
    },
  ],
};

function oneSecurity(
  columns: Record<OperandKey, readonly (number | null)[]>,
  closes?: readonly number[],
): { dates: string[]; frame: EvaluationFrame } {
  const length = Object.values(columns)[0]!.length;
  const dates = tradingDates("2026-01-05", length);
  return {
    dates,
    frame: frameOf({
      symbol: "FUND",
      dates,
      closes: closes ?? dates.map(() => 100),
      columns,
    }),
  };
}

async function run(definition: StrategyDefinition, frame: EvaluationFrame) {
  return simulateBacktest(
    executionInput({
      definition,
      securities: [securityInput(frame)],
      initialCapital: 100_000,
      maximumPositions: 1,
    }),
  );
}

describe("a Fundamental BUY Condition in a backtest", () => {
  it("buys on the first session the materialized reading holds, and not one session earlier", async () => {
    // Unavailable, then 12, then 18 from the fourth session: ROIC TTM is above 15%.
    const { dates, frame } = oneSecurity({
      [ROIC]: [null, 12, 12, 18, 18, 18],
    });
    const result = await run(
      definitionOf({ buyLevels: [buyLevel("b1", 100, ROIC_ABOVE_15)] }),
      frame,
    );
    const buys = strategyTrades(result).filter(
      (trade) => trade.action === "BUY",
    );
    expect(buys.map((trade) => trade.date)).toEqual([dates[3]]);
    // Filled at that session's own close: no look-ahead and no lag.
    expect(Number(buys[0]?.price)).toBe(100);
  });

  it("never buys on an unavailable Debt / Equity, which is not a zero (regression)", async () => {
    const { dates, frame } = oneSecurity({
      [DEBT_TO_EQUITY]: [null, null, null, 1.2, 0.8, 0.8],
    });
    const result = await run(
      definitionOf({
        buyLevels: [buyLevel("b1", 100, DEBT_TO_EQUITY_BELOW_1)],
      }),
      frame,
    );
    const buys = strategyTrades(result).filter(
      (trade) => trade.action === "BUY",
    );
    // Read as zero, the first unavailable session would already be "below 1x".
    expect(buys.map((trade) => trade.date)).toEqual([dates[4]]);

    const neverAvailable = oneSecurity({
      [DEBT_TO_EQUITY]: [null, null, null],
    });
    const idle = await run(
      definitionOf({
        buyLevels: [buyLevel("b1", 100, DEBT_TO_EQUITY_BELOW_1)],
      }),
      neverAvailable.frame,
    );
    expect(idle.trades).toEqual([]);
  });

  it("requires every Fundamental Condition, and lets no unavailable one through", async () => {
    const signal: StrategySignal = {
      conditions: [
        fundamental("ROIC_TTM", "IS_ABOVE", percent(15)),
        fundamental("DEBT_TO_EQUITY", "IS_BELOW", multiple(1)),
        fundamental("REVENUE_GROWTH_TTM_YOY", "IS_ABOVE", percent(5)),
      ],
    };
    // Session 0: growth too low. 1-2: Debt / Equity unavailable. 3: all three hold.
    const { dates, frame } = oneSecurity({
      [ROIC]: [18, 18, 18, 18, 18],
      [DEBT_TO_EQUITY]: [0.8, null, null, 0.8, 0.8],
      [REVENUE_GROWTH]: [2, 8, 8, 8, 8],
    });
    const result = await run(
      definitionOf({ buyLevels: [buyLevel("b1", 100, signal)] }),
      frame,
    );
    expect(
      strategyTrades(result)
        .filter((trade) => trade.action === "BUY")
        .map((trade) => trade.date),
    ).toEqual([dates[3]]);
    // Exactly three fundamental columns are projected for it, plus the close.
    expect(
      collectOperands(
        definitionOf({ buyLevels: [buyLevel("b1", 100, signal)] }),
      ),
    ).toEqual([DEBT_TO_EQUITY, REVENUE_GROWTH, ROIC, PRICE_OPERAND].sort());
  });

  it("combines with Price above SMA 200D and RVOL 20 above 1.5x exactly as Conditions do", async () => {
    const signal: StrategySignal = {
      conditions: [
        {
          id: "price-above-sma200",
          metric: { kind: "PRICE" },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
        fundamental("ROIC_TTM", "IS_ABOVE", percent(15)),
        {
          id: "rvol20-above-1.5",
          metric: { kind: "RELATIVE_VOLUME", period: 20 },
          operator: "IS_ABOVE",
          value: { kind: "MULTIPLE", value: 1.5 },
        },
      ],
    };
    // 0: below the average. 1: ROIC short. 2: RVOL short. 3: all hold.
    const { dates, frame } = oneSecurity(
      {
        [seriesOperand("SMA_200D")]: [100, 100, 100, 100],
        [ROIC]: [18, 12, 18, 18],
        [relativeVolumeOperand(20)]: [2, 2, 1.2, 2],
      },
      [95, 105, 105, 105],
    );
    const result = await run(
      definitionOf({ buyLevels: [buyLevel("b1", 100, signal)] }),
      frame,
    );
    expect(
      strategyTrades(result)
        .filter((trade) => trade.action === "BUY")
        .map((trade) => trade.date),
    ).toEqual([dates[3]]);
  });
});

describe("a Fundamental Condition in SELL and FINAL EXIT", () => {
  it("sells part of the position once when a Fundamental SELL Condition first holds", async () => {
    const { dates, frame } = oneSecurity({
      [DEBT_TO_EQUITY]: [1, 1, 2.5, 2.5, 2.5],
    });
    const result = await run(
      definitionOf({
        buyLevels: [buyLevel("b1", 100, ALWAYS)],
        sellLevels: [
          sellLevel("s1", 50, {
            conditions: [
              fundamental("DEBT_TO_EQUITY", "IS_ABOVE", multiple(2)),
            ],
          }),
        ],
      }),
      frame,
    );
    const trades = strategyTrades(result);
    expect(trades.map((trade) => [trade.date, trade.action])).toEqual([
      [dates[0], "BUY"],
      [dates[2], "SELL"],
    ]);
  });

  it("does not sell while the SELL reading is unavailable", async () => {
    const { frame } = oneSecurity({ [DEBT_TO_EQUITY]: [null, null, null] });
    const result = await run(
      definitionOf({
        buyLevels: [buyLevel("b1", 100, ALWAYS)],
        sellLevels: [
          sellLevel("s1", 50, {
            conditions: [
              fundamental("DEBT_TO_EQUITY", "IS_ABOVE", multiple(2)),
            ],
          }),
        ],
      }),
      frame,
    );
    expect(
      strategyTrades(result).filter((trade) => trade.action === "SELL"),
    ).toEqual([]);
  });

  it("closes the position once through either Fundamental Exit Rule", async () => {
    // Rule 1: ROIC TTM is below 5%. Rule 2: Net Margin TTM is below 0%.
    const exit = finalExitRules(
      "x1",
      { conditions: [fundamental("ROIC_TTM", "IS_BELOW", percent(5))] },
      { conditions: [fundamental("NET_MARGIN_TTM", "IS_BELOW", percent(0))] },
    );
    // Rule 2 matches on session 2; rule 1 on session 3 as well; both on session 4.
    const { dates, frame } = oneSecurity({
      [ROIC]: [10, 10, 10, 3, 3],
      [NET_MARGIN]: [5, 5, -1, 5, -1],
    });
    const result = await run(
      definitionOf({
        buyLevels: [buyLevel("b1", 100, ROIC_ABOVE_15)],
        finalExit: exit,
      }),
      frame,
    );
    // ROIC never exceeds 15, so nothing is bought and nothing can exit.
    expect(strategyTrades(result)).toEqual([]);

    const bought = await run(
      definitionOf({
        buyLevels: [buyLevel("b1", 100, ALWAYS)],
        finalExit: exit,
      }),
      frame,
    );
    const exits = strategyTrades(bought).filter(
      (trade) => trade.action === "FINAL_EXIT",
    );
    // The first exit is rule 2's, one trade however many rules matched; the position then
    // re-enters on the next session (same-date re-entry is forbidden) and exits again.
    expect(exits[0]?.date).toBe(dates[2]);
    expect(exits.map((trade) => trade.date)).toEqual([
      ...new Set(exits.map((trade) => trade.date)),
    ]);
    expect(exits.filter((trade) => trade.date === dates[4])).toHaveLength(1);
  });
});

describe("a backtest of Fundamental Conditions is deterministic", () => {
  it("produces identical trades, equity and results on every run", async () => {
    const { frame } = oneSecurity(
      {
        [ROIC]: [null, 12, 18, 18, 18, null, 18, 18],
        [DEBT_TO_EQUITY]: [null, 1.2, 0.8, 0.8, 2.5, 2.5, 0.8, 0.8],
        [NET_MARGIN]: [5, 5, 5, 5, 5, -2, 5, 5],
      },
      [100, 101, 102, 103, 104, 105, 106, 107],
    );
    const definition = definitionOf({
      buyLevels: [
        buyLevel("b1", 100, {
          conditions: [
            fundamental("ROIC_TTM", "IS_ABOVE", percent(15)),
            fundamental("DEBT_TO_EQUITY", "IS_BELOW", multiple(1)),
          ],
        }),
      ],
      sellLevels: [
        sellLevel("s1", 50, {
          conditions: [fundamental("DEBT_TO_EQUITY", "IS_ABOVE", multiple(2))],
        }),
      ],
      finalExit: finalExitRules("x1", {
        conditions: [fundamental("NET_MARGIN_TTM", "IS_BELOW", percent(0))],
      }),
    });
    const runs = await Promise.all([
      run(definition, frame),
      run(definition, frame),
      run(definition, frame),
    ]);
    const serialized = runs.map((result) => JSON.stringify(result));
    expect(serialized[1]).toBe(serialized[0]);
    expect(serialized[2]).toBe(serialized[0]);
    expect(strategyTrades(runs[0]!).map((trade) => trade.action)).toEqual([
      "BUY",
      "SELL",
      "FINAL_EXIT",
      "BUY",
    ]);
  });
});

describe("the same Fundamental Condition in a Monitor", () => {
  const readings = [12, 18, 18, null, 18, 12] as const;

  it("decides every session exactly as the backtest's own gate does", () => {
    const { frame } = oneSecurity({ [ROIC]: [...readings] });
    const definition = definitionOf({
      buyLevels: [buyLevel("b1", 100, ROIC_ABOVE_15)],
    });
    const gate = buildStrategyGates(definition, frame).buy.get("b1");
    const backtest = readings.map((_unused, index) => readGate(gate, index));
    const monitor = readings.map((_unused, index) =>
      evaluateSignalWithoutPosition(ROIC_ABOVE_15, frame, index),
    );
    expect(monitor).toEqual(backtest);
    expect(monitor).toEqual([
      Evaluability.FALSE,
      Evaluability.TRUE,
      Evaluability.TRUE,
      Evaluability.NOT_EVALUABLE,
      Evaluability.TRUE,
      Evaluability.FALSE,
    ]);
  });

  it("opens one occurrence on not-matched -> matched, and an unavailable session does not end it", () => {
    const { dates, frame } = oneSecurity({ [ROIC]: [...readings] });
    const level = monitorStrategyLevels(
      definitionOf({ buyLevels: [buyLevel("b1", 100, ROIC_ABOVE_15)] }),
    ).find((candidate) => candidate.id === "b1")!;

    let lifecycle: MonitorLevelLifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE;
    const states: string[] = [];
    const opened: string[] = [];
    const closed: string[] = [];
    dates.forEach((date, index) => {
      const result = stepMonitorLevel(lifecycle, {
        date,
        eligible: true,
        rules: observeMonitorLevel(level, frame, index),
      });
      lifecycle = result.next;
      states.push(lifecycle.state);
      if (result.opened) {
        opened.push(date);
      }
      if (result.closed) {
        closed.push(date);
      }
    });

    expect(states).toEqual([
      "INACTIVE",
      "ACTIVE",
      "ACTIVE",
      // A statement gap is NOT_EVALUABLE, not FALSE: the occurrence stays open.
      "ACTIVE",
      "ACTIVE",
      "RESOLVED",
    ]);
    expect(opened).toEqual([dates[1]]);
    expect(closed).toEqual([dates[5]]);
  });

  it("gives two metrics under one rule two different level fingerprints", () => {
    const roe: StrategySignal = {
      conditions: [fundamental("ROE_TTM", "IS_ABOVE", percent(15))],
    };
    const [roicLevel] = monitorStrategyLevels(
      definitionOf({ buyLevels: [buyLevel("b1", 100, ROIC_ABOVE_15)] }),
    );
    const [roeLevel] = monitorStrategyLevels(
      definitionOf({ buyLevels: [buyLevel("b1", 100, roe)] }),
    );
    // The durable Monitor state is keyed by this: a switch from ROIC to ROE resets the latch.
    expect(roicLevel?.fingerprint).not.toBe(roeLevel?.fingerprint);
  });
});
