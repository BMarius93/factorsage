import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import type { EvaluationFrame } from "../frame.js";
import {
  MOVING_AVERAGE_COLUMN,
  benchmarkSeries,
  buyLevel,
  definitionOf,
  executionInput,
  frameOf,
  priceAboveSignal,
  priceCrossesAboveMovingAverageSignal,
  securityInput,
  simulateBacktestByYear,
  tradingDates,
} from "./backtest.test-helper.js";
import type {
  BacktestDiagnosticsObserver,
  BacktestFundingEvent,
  BacktestWindowClosedDiagnostics,
  BacktestWindowOpenedDiagnostics,
} from "./diagnostics.js";
import type { BacktestExecutionInput, BacktestResult } from "./types.js";

/** Two full calendar years of weekdays, so the run has real year boundaries to carry state over. */
const DATES = tradingDates("2019-12-02", 300);
const START = DATES[0] as LocalDate;
const END = DATES[DATES.length - 1] as LocalDate;

function closesOf(): number[] {
  return DATES.map((_, index) => 100 + index * 0.5);
}

/** A run that trades, contributes monthly and crosses two New Years. */
function runInput(): BacktestExecutionInput {
  const closes = closesOf();
  return executionInput({
    definition: definitionOf({
      buyLevels: [buyLevel("b100", 100, priceAboveSignal(0))],
    }),
    securities: [
      securityInput(
        frameOf({
          symbol: "AAA",
          dates: DATES,
          closes,
          columns: { [MOVING_AVERAGE_COLUMN]: closes.map(() => null) },
        }),
      ),
    ],
    benchmark: benchmarkSeries({
      dates: DATES,
      closes: DATES.map((_, index) => 400 + index * 0.25),
    }),
    startDate: START,
    endDate: END,
    initialCapital: 100_000,
    monthlyContribution: 1_000,
    maximumPositions: 4,
  });
}

type Captured = {
  opened: BacktestWindowOpenedDiagnostics[];
  closed: BacktestWindowClosedDiagnostics[];
  funding: BacktestFundingEvent[];
};

function recordingObserver(): {
  observer: BacktestDiagnosticsObserver;
  captured: Captured;
} {
  const captured: Captured = { opened: [], closed: [], funding: [] };
  return {
    captured,
    observer: {
      onWindowOpened: (diagnostics) => {
        captured.opened.push(diagnostics);
      },
      onWindowClosed: (diagnostics) => {
        captured.closed.push(diagnostics);
      },
      onFunding: (event) => {
        captured.funding.push(event);
      },
    },
  };
}

async function observedRun(): Promise<{
  result: BacktestResult;
  captured: Captured;
}> {
  const { observer, captured } = recordingObserver();
  const result = await simulateBacktestByYear(runInput(), {
    diagnostics: observer,
  });
  return { result, captured };
}

/**
 * The diagnostic observer exists so a forensic archive can hold the inputs a run actually consumed.
 * These cases are about the one property that makes it safe to leave in the engine — it observes
 * and nothing else — and about the two things an external reviewer cannot reconstruct without it:
 * the frame rows the simulation was bound to, and the funding that genuinely happened.
 */
describe("backtest diagnostics observer", () => {
  it("cannot change a result", async () => {
    const withoutObserver = await simulateBacktestByYear(runInput());
    const { result: withObserver } = await observedRun();

    // Every financial output, not a sampled few: trades and their order, the daily curve, the
    // final positions and every summary metric.
    expect(withObserver.trades).toEqual(withoutObserver.trades);
    expect(withObserver.equity).toEqual(withoutObserver.equity);
    expect(withObserver.positions).toEqual(withoutObserver.positions);
    expect(withObserver.summary).toEqual(withoutObserver.summary);
  });

  it("reports every window once, in order", async () => {
    const { captured } = await observedRun();

    expect(captured.opened.map((entry) => entry.window.year)).toEqual([
      "2019",
      "2020",
      "2021",
    ]);
    expect(captured.closed.map((entry) => entry.window.year)).toEqual([
      "2019",
      "2020",
      "2021",
    ]);
    expect(captured.opened.map((entry) => entry.window.index)).toEqual([
      0, 1, 2,
    ]);
  });

  it("hands over the bound frame, with the retained context row in front of it", async () => {
    const { captured } = await observedRun();

    const second = captured.opened[1] as BacktestWindowOpenedDiagnostics;
    const frame = second.frames[0] as EvaluationFrame;

    // Exactly one row precedes the window: the row the engine retained from 2019, which is what a
    // Trigger reads at `index - 1` on the first eligible date of 2020. The count is read off the
    // dates rather than off `periodStartIndex`, which is whatever the loader reported.
    expect(
      frame.dates.filter((date) => date < second.window.from),
    ).toEqual(["2019-12-31"]);
    expect(frame.dates[1]).toBe("2020-01-01");
    expect(frame.dates[1]).toBe(second.window.dates[0]);

    // And it is the value that actually held on that date, not a re-projection.
    const index = DATES.indexOf("2019-12-31");
    expect(frame.closes[0]).toBe(closesOf()[index]);
  });

  it("reports the funding the simulation applied, typed and dated", async () => {
    const { result, captured } = await observedRun();

    const initial = captured.funding.filter(
      (event) => event.type === "INITIAL_CAPITAL",
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]?.date).toBe(result.summary.firstSimulatedDate);
    expect(initial[0]?.amount).toBe(100_000);

    const contributions = captured.funding.filter(
      (event) => event.type === "MONTHLY_CONTRIBUTION",
    );
    // One per month after the first, and never twice in the same month.
    expect(
      new Set(contributions.map((event) => event.date.slice(0, 7))).size,
    ).toBe(contributions.length);
    expect(contributions.every((event) => event.amount === 1_000)).toBe(true);

    // Together they are exactly the capital the run reports having received.
    const funded = captured.funding.reduce(
      (total, event) => total + event.amount,
      0,
    );
    expect(funded).toBeCloseTo(result.summary.investedCapital, 6);

    // And they land on the dates the equity curve shows capital arriving on.
    const deposits = result.equity
      .filter(
        (point, index) =>
          index > 0 &&
          point.investedCapital > (result.equity[index - 1]?.investedCapital ?? 0),
      )
      .map((point) => point.date);
    expect(contributions.map((event) => event.date)).toEqual(deposits);
  });

  it("describes the state a boundary carries, not the arithmetic behind it", async () => {
    const { result, captured } = await observedRun();

    const first = captured.closed[0] as BacktestWindowClosedDiagnostics;
    const last = captured.closed[2] as BacktestWindowClosedDiagnostics;

    // Continuity: the trade sequence, the invested capital and the equity count all keep counting.
    expect(last.state.tradeSequence).toBeGreaterThanOrEqual(
      first.state.tradeSequence,
    );
    expect(last.state.investedCapital).toBeGreaterThan(
      first.state.investedCapital,
    );
    expect(last.state.equityPointCount).toBe(result.equity.length);
    expect(last.state.completedDays).toBe(result.summary.tradingDays);

    // The final boundary reconciles with the run's own result.
    expect(last.state.cash).toBeCloseTo(result.summary.finalCash, 6);
    expect(last.state.totalValue).toBeCloseTo(result.summary.finalValue, 6);
    expect(last.state.comparison.cashBaselineValue).toBeCloseTo(
      result.summary.investedCapital,
      6,
    );
    expect(last.state.comparison.benchmarkShares).toBeGreaterThan(0);
    expect(last.state.comparison.benchmarkPendingCapital).toBe(0);

    // The position carried across both New Years is one lifecycle, at epoch 1.
    expect(last.state.positions).toHaveLength(1);
    expect(last.state.positions[0]?.epoch).toBe(1);
    expect(last.state.positions[0]?.buyLevelsSettled).toEqual(["b100"]);

    // The retained Trigger context row is named, so a reviewer can check the next year's crossing.
    expect(first.state.contextRows).toHaveLength(1);
    expect(first.state.contextRows[0]?.date).toBe("2019-12-31");
    expect(
      first.state.contextRows[0]?.values.has(MOVING_AVERAGE_COLUMN),
    ).toBe(true);
  });

  it("slices each window's own trades and equity, covering the run exactly once", async () => {
    const { result, captured } = await observedRun();

    expect(captured.closed.flatMap((entry) => [...entry.equity])).toEqual(
      result.equity,
    );
    expect(captured.closed.flatMap((entry) => [...entry.trades])).toEqual(
      result.trades,
    );
  });

  it("keeps NOT_EVALUABLE as NaN in the rows it hands over", async () => {
    const { captured } = await observedRun();

    const frame = (captured.opened[0] as BacktestWindowOpenedDiagnostics)
      .frames[0] as EvaluationFrame;
    const column = frame.columns.get(MOVING_AVERAGE_COLUMN);

    // The fixture's moving average is absent throughout, and absence stays absent: the engine has
    // no serializer, so encoding it is the archive's decision rather than a silent zero here.
    expect(column).toBeDefined();
    expect(Number.isNaN(column?.[0] ?? 0)).toBe(true);
  });

  it("also observes the continuous reference path", async () => {
    // The whole-period path is the equivalence reference, so an observer must see one window
    // spanning the run rather than nothing at all.
    const { observer, captured } = recordingObserver();
    const input = runInput();
    const { createBacktestSimulation } = await import("./simulation.js");
    const simulation = createBacktestSimulation(
      {
        ...input,
        securities: input.securities.map((security) => ({
          securityId: security.frame.securityId,
          symbol: security.frame.symbol,
          name: security.frame.name,
          buyWindows: security.buyWindows,
        })),
      },
      { diagnostics: observer },
    );
    await simulation.consumeWholePeriod(
      input.securities.map((security) => security.frame),
    );
    const result = simulation.finish();

    expect(captured.opened).toHaveLength(1);
    expect(captured.closed).toHaveLength(1);
    expect(captured.closed[0]?.equity).toEqual(result.equity);
    expect(
      captured.funding.filter((event) => event.type === "INITIAL_CAPITAL"),
    ).toHaveLength(1);
  });

  it("cross-checks the trigger crossing the year boundary against the carried row", async () => {
    // `Price crosses above SMA 50D` on the first eligible date of a year is the case the retained
    // row exists for, and the archive has to be able to show the `t - 1` value it used.
    const closes = DATES.map((date, index) =>
      date < "2020-01-01" ? 90 : 110 + index * 0.1,
    );
    const averages = DATES.map(() => 100);
    const { observer, captured } = recordingObserver();

    await simulateBacktestByYear(
      executionInput({
        definition: definitionOf({
          buyLevels: [
            buyLevel("b100", 100, priceCrossesAboveMovingAverageSignal()),
          ],
        }),
        securities: [
          securityInput(
            frameOf({
              symbol: "AAA",
              dates: DATES,
              closes,
              columns: { [MOVING_AVERAGE_COLUMN]: averages },
            }),
          ),
        ],
        startDate: START,
        endDate: END,
        monthlyContribution: 0,
      }),
      { diagnostics: observer },
    );

    const second = captured.opened[1] as BacktestWindowOpenedDiagnostics;
    const frame = second.frames[0] as EvaluationFrame;

    // Row 0 is 2019's last close, below the average; row 1 is the crossing. A reviewer can verify
    // the crossing from these two rows alone.
    expect(frame.dates.filter((date) => date < second.window.from)).toEqual([
      "2019-12-31",
    ]);
    expect(frame.closes[0]).toBe(90);
    expect(frame.columns.get(MOVING_AVERAGE_COLUMN)?.[0]).toBe(100);
    expect(frame.closes[1]).toBeGreaterThan(100);
  });
});
