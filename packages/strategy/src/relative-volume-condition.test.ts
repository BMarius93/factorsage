import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  benchmarkSeries,
  buyLevel,
  definitionOf,
  executionInput,
  frameOf,
  securityInput,
  sellLevel,
  strategyTrades,
  tradingDates,
} from "./backtest/backtest.test-helper.js";
import { simulateBacktest } from "./backtest/simulate.js";
import { Evaluability } from "./evaluability.js";
import { createEvaluationFrame, type EvaluationFrame } from "./frame.js";
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
  relativeVolumeOperand,
  PRICE_OPERAND,
} from "./operands.js";

/**
 * One RVOL Condition, evaluated by a backtest and by a Monitor.
 *
 * The point of the suite is that there is exactly one implementation to test. `RVOL 20 is above
 * 2.0x` is an ordinary numeric Condition: the engine reads a precomputed column, the backtest day
 * loop and the Monitor cycle call the same evaluator, and the Monitor's existing
 * not-matched -> matched transition is what turns a run of readings into a Signal. Nothing here
 * computes a relative volume, and nothing may need to.
 */

const RVOL20 = relativeVolumeOperand(20);

/** `RVOL <period> is above <threshold>x`. */
function rvolAboveSignal(
  period: 10 | 20 | 50,
  threshold: number,
): StrategySignal {
  return {
    conditions: [
      {
        id: `rvol-${period}-above-${threshold}`,
        metric: { kind: "RELATIVE_VOLUME", period },
        operator: "IS_ABOVE",
        value: { kind: "MULTIPLE", value: threshold },
      },
    ],
  };
}

function monitorFrame(
  dates: readonly string[],
  readings: readonly (number | null)[],
): EvaluationFrame {
  return createEvaluationFrame({
    securityId: "sec-1",
    symbol: "TEST",
    name: "Test Security",
    dates: [...dates],
    closes: Float64Array.from(dates.map(() => 100)),
    columns: new Map([
      [RVOL20, Float64Array.from(readings.map((value) => value ?? Number.NaN))],
    ]),
    periodStartIndex: 0,
  });
}

/** The product brief's worked sequence for `RVOL20 >= 2`. */
const READINGS = [1.2, 1.8, 2.3, 2.1, 1.4, 2.2] as const;
const EXPECTED_MATCHES = [false, false, true, true, false, true] as const;

describe("a Relative Volume condition in a backtest", () => {
  it("reads the precomputed column and never the raw volume history", async () => {
    const dates = tradingDates("2020-01-06", 4);
    // The frame carries no volume at all — only the materialized RVOL column. A day loop that
    // wanted to compute the ratio itself could not: the inputs are simply not there.
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [100, 100, 100, 100],
      columns: { [RVOL20]: [1.1, 2.4, 1.0, 1.0] },
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, rvolAboveSignal(20, 2))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    const bought = strategyTrades(result).filter(
      (trade) => trade.action === "BUY",
    );
    expect(bought).toHaveLength(1);
    // The second session is the only one above 2.0x, so that is the session it executes on.
    expect(bought[0]?.date).toBe(dates[1]);
  });

  it("is deterministic: the same frame produces the same trades every run", async () => {
    const dates = tradingDates("2020-01-06", READINGS.length);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: dates.map(() => 100),
      columns: { [RVOL20]: [...READINGS] },
    });
    const input = () =>
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, rvolAboveSignal(20, 2))],
          sellLevels: [sellLevel("s1", 25, rvolAboveSignal(20, 2.25))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
      });

    const first = await simulateBacktest(input());
    const second = await simulateBacktest(input());

    expect(strategyTrades(second)).toEqual(strategyTrades(first));
  });

  it("is NOT_EVALUABLE during warm-up rather than matching on a substituted value", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const frame = frameOf({
      symbol: "AAA",
      dates,
      closes: [100, 100, 100],
      // The first two sessions are inside the twenty-session warm-up.
      columns: { [RVOL20]: [null, null, 2.5] },
    });

    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, rvolAboveSignal(20, 2))],
        }),
        securities: [securityInput(frame)],
        initialCapital: 100_000,
        maximumPositions: 1,
        benchmark: benchmarkSeries({ dates, closes: [100, 100, 100] }),
      }),
    );

    const bought = strategyTrades(result).filter(
      (trade) => trade.action === "BUY",
    );
    expect(bought).toHaveLength(1);
    expect(bought[0]?.date).toBe(dates[2]);
  });

  it("projects only the column the strategy names", () => {
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        { id: "b1", percentage: 100, signal: rvolAboveSignal(20, 2) },
      ],
      sellLevels: [],
    };

    expect(collectOperands(definition)).toEqual([PRICE_OPERAND, RVOL20].sort());
  });
});

describe("the same condition in a Monitor", () => {
  const dates = READINGS.map(
    (_unused, index) => `2026-03-${String(index + 2).padStart(2, "0")}`,
  );

  it("evaluates identically to the backtest, session by session", () => {
    const frame = monitorFrame(dates, READINGS);
    const signal = rvolAboveSignal(20, 2);

    const evaluated = READINGS.map((_unused, index) =>
      evaluateSignalWithoutPosition(signal, frame, index),
    );

    expect(evaluated).toEqual(
      EXPECTED_MATCHES.map((matched) =>
        matched ? Evaluability.TRUE : Evaluability.FALSE,
      ),
    );
  });

  it("is a level a Monitor evaluates at all: it needs no position state", () => {
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        { id: "b1", percentage: 100, signal: rvolAboveSignal(20, 2) },
      ],
      sellLevels: [],
    };

    const levels = monitorStrategyLevels(definition);
    expect(levels.map((level) => level.id)).toContain("b1");
  });

  it("emits a Signal on the existing not-matched -> matched transition, and no other", () => {
    // 1.2 -> 1.8 -> 2.3 -> 2.1 -> 1.4 -> 2.2 against `is above 2.0x`.
    // Two occurrences: one opening on 2.3 and resolving on 1.4, another opening on 2.2. Nothing
    // about Relative Volume is special here — this is the ordinary Condition lifecycle, which is
    // why there is no `crosses above` operator for it.
    const frame = monitorFrame(dates, READINGS);
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        { id: "b1", percentage: 100, signal: rvolAboveSignal(20, 2) },
      ],
      sellLevels: [],
    };
    const level = monitorStrategyLevels(definition).find(
      (candidate) => candidate.id === "b1",
    )!;

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
      "INACTIVE",
      "ACTIVE",
      "ACTIVE",
      "RESOLVED",
      "ACTIVE",
    ]);
    // A Signal is created on entering ACTIVE — not on every session the condition holds, so the
    // second consecutive match (2.1) does not re-emit.
    expect(opened).toEqual([dates[2], dates[5]]);
    expect(closed).toEqual([dates[4]]);
  });

  it("does not resolve an active occurrence merely because a reading went missing", () => {
    // NOT_EVALUABLE is not FALSE. A session whose RVOL could not be computed — a provider quote
    // with no volume, say — must not read as "the condition stopped holding".
    const frame = monitorFrame(dates.slice(0, 3), [2.4, 2.5, null]);

    expect(
      evaluateSignalWithoutPosition(rvolAboveSignal(20, 2), frame, 2),
    ).toBe(Evaluability.NOT_EVALUABLE);
  });
});
