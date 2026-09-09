import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyBuyLevel,
  type StrategyDefinition,
  type StrategyFinalExit,
  type StrategySellLevel,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { BuyWindowConfiguration, LocalDate } from "@intrinsic/domain";
import { createEvaluationFrame, type EvaluationFrame } from "../frame.js";
import { seriesOperand, type OperandKey } from "../operands.js";
import { createBacktestSimulation } from "./simulation.js";
import type {
  BacktestExecutionInput,
  BacktestResult,
  BacktestSecurityInput,
  BacktestSimulationOptions,
  BenchmarkSeriesInput,
} from "./types.js";

/** Consecutive weekday dates, so a fixture reads like a real trading week without a calendar. */
export function tradingDates(start: LocalDate, count: number): LocalDate[] {
  const dates: LocalDate[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function frameOf(input: {
  symbol: string;
  securityId?: string;
  name?: string;
  dates: readonly LocalDate[];
  closes: readonly (number | null)[];
  columns?: Record<OperandKey, readonly (number | null)[]>;
  periodStartIndex?: number;
}): EvaluationFrame {
  const columns = new Map<OperandKey, Float64Array>();
  for (const [key, values] of Object.entries(input.columns ?? {})) {
    columns.set(key, toColumn(values));
  }
  return createEvaluationFrame({
    securityId: input.securityId ?? `security-${input.symbol.toLowerCase()}`,
    symbol: input.symbol,
    name: input.name ?? `${input.symbol} Inc.`,
    dates: [...input.dates],
    closes: toColumn(input.closes),
    columns,
    periodStartIndex: input.periodStartIndex ?? 0,
  });
}

function toColumn(values: readonly (number | null)[]): Float64Array {
  const column = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    column[index] = value === null || value === undefined ? Number.NaN : value;
  }
  return column;
}

export function securityInput(
  frame: EvaluationFrame,
  buyWindows: BuyWindowConfiguration = { mode: "FULL", ranges: [] },
): BacktestSecurityInput {
  return { frame, buyWindows };
}

export function benchmarkSeries(input: {
  dates: readonly LocalDate[];
  closes: readonly number[];
  code?: string;
}): BenchmarkSeriesInput {
  return {
    benchmarkId: "benchmark-test",
    code: input.code ?? "SP500",
    name: "S&P 500",
    dates: [...input.dates],
    closes: toColumn(input.closes),
  };
}

/** `Price is above <value>` as a plain always-decidable Condition for allocation fixtures. */
export function priceAboveSignal(threshold: number): StrategySignal {
  return {
    conditions: [
      {
        id: `price-above-${threshold}`,
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: threshold },
      },
    ],
  };
}

export function priceBelowSignal(threshold: number): StrategySignal {
  return {
    conditions: [
      {
        id: `price-below-${threshold}`,
        metric: { kind: "PRICE" },
        operator: "IS_BELOW",
        value: { kind: "NUMBER", value: threshold },
      },
    ],
  };
}

/** `Price crosses above <threshold>` — an event, so it is TRUE only on the crossing date. */
export function priceCrossesAboveSignal(threshold: number): StrategySignal {
  return {
    conditions: [],
    trigger: {
      id: `price-crosses-above-${threshold}`,
      metric: { kind: "PRICE" },
      operator: "CROSSES_ABOVE",
      value: { kind: "NUMBER", value: threshold },
    },
  };
}

export function gainAboveSignal(percent: number): StrategySignal {
  return {
    conditions: [
      {
        id: `gain-above-${percent}`,
        metric: { kind: "GAIN" },
        operator: "IS_ABOVE",
        value: { kind: "PERCENT", value: percent },
      },
    ],
  };
}

export function lossAboveSignal(percent: number): StrategySignal {
  return {
    conditions: [
      {
        id: `loss-above-${percent}`,
        metric: { kind: "LOSS" },
        operator: "IS_ABOVE",
        value: { kind: "PERCENT", value: percent },
      },
    ],
  };
}

export function buyLevel(
  id: string,
  percentage: StrategyBuyLevel["percentage"],
  signal: StrategySignal,
): StrategyBuyLevel {
  return { id, percentage, signal };
}

export function sellLevel(
  id: string,
  percentage: StrategySellLevel["percentage"],
  signal: StrategySignal,
): StrategySellLevel {
  return { id, percentage, signal };
}

export function finalExit(
  id: string,
  signal: StrategySignal,
): StrategyFinalExit {
  return { id, signal };
}

export function definitionOf(input: {
  buyLevels: StrategyBuyLevel[];
  sellLevels?: StrategySellLevel[];
  finalExit?: StrategyFinalExit;
}): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: input.buyLevels,
    sellLevels: input.sellLevels ?? [],
    ...(input.finalExit ? { finalExit: input.finalExit } : {}),
  };
}

export function executionInput(
  input: Partial<BacktestExecutionInput> &
    Pick<BacktestExecutionInput, "definition" | "securities">,
): BacktestExecutionInput {
  const dates = input.securities.flatMap((security) => [
    ...security.frame.dates,
  ]);
  const sorted = [...new Set(dates)].sort();
  return {
    benchmark: null,
    // The securities' own dates, so a focused test that does not care about the calendar behaves
    // exactly as it did before the calendar became a separate required input. A test that *is*
    // about the calendar passes its own.
    executionCalendar: sorted,
    startDate: input.startDate ?? (sorted[0] as LocalDate),
    endDate: input.endDate ?? (sorted[sorted.length - 1] as LocalDate),
    initialCapital: input.initialCapital ?? 100_000,
    monthlyContribution: input.monthlyContribution ?? 0,
    maximumPositions: input.maximumPositions ?? 10,
    ...input,
  };
}

/**
 * How many calendar days of leading context a projected window carries.
 *
 * Mirrors `TRIGGER_CONTEXT_CALENDAR_DAYS` in `@intrinsic/stock-data`, which is where the real
 * loader applies it. It is restated rather than imported because `@intrinsic/strategy` is pure and
 * must not depend on the loader — and because the point of the windowed tests is that correctness
 * does **not** rest on this number: the engine carries the preceding eligible row itself.
 */
export const WINDOW_CONTEXT_CALENDAR_DAYS = 10;

function shiftDate(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The rows of `frame` inside `[from, to]`, as the loader would project them for one window.
 *
 * Column values are copied, never recomputed: a derived series is canonically materialized with its
 * own warm-up, and a window read is a read of those persisted values, not a fresh calculation over
 * a year of isolated data.
 */
export function sliceFrame(
  frame: EvaluationFrame,
  from: LocalDate,
  to: LocalDate,
): EvaluationFrame {
  const indices: number[] = [];
  for (let index = 0; index < frame.dates.length; index += 1) {
    const date = frame.dates[index] as LocalDate;
    if (date >= from && date <= to) {
      indices.push(index);
    }
  }
  const closes = new Float64Array(indices.length);
  const columns = new Map<OperandKey, Float64Array>();
  for (const key of frame.columns.keys()) {
    columns.set(key, new Float64Array(indices.length));
  }
  indices.forEach((source, target) => {
    closes[target] = frame.closes[source] ?? Number.NaN;
    for (const [key, column] of columns) {
      column[target] = frame.columns.get(key)?.[source] ?? Number.NaN;
    }
  });
  return createEvaluationFrame({
    securityId: frame.securityId,
    symbol: frame.symbol,
    name: frame.name,
    dates: indices.map((index) => frame.dates[index] as LocalDate),
    closes,
    columns,
    periodStartIndex: 0,
  });
}

/**
 * Executes the same run through consecutive calendar-year windows.
 *
 * Each window receives only its own year's rows plus the loader's small leading context, which is
 * exactly what the worker does — so a difference between this and `simulateBacktest` is a real
 * difference between annual and continuous execution, not a difference between two engines.
 */
export async function simulateBacktestByYear(
  input: BacktestExecutionInput,
  options: BacktestSimulationOptions = {},
): Promise<BacktestResult> {
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
    options,
  );
  for (const window of simulation.windows) {
    await simulation.consumeWindow(window, {
      frames: input.securities.map((security) =>
        sliceFrame(
          security.frame,
          shiftDate(window.from, -WINDOW_CONTEXT_CALENDAR_DAYS),
          window.to,
        ),
      ),
    });
  }
  return simulation.finish();
}

/** `Price crosses above SMA 50D` — the year-boundary Trigger case, series against series. */
export function priceCrossesAboveMovingAverageSignal(): StrategySignal {
  return {
    conditions: [],
    trigger: {
      id: "price-crosses-above-sma50d",
      metric: { kind: "PRICE" },
      operator: "CROSSES_ABOVE",
      value: { kind: "SERIES", seriesId: "SMA_50D" },
    },
  };
}

/** The frame column `priceCrossesAboveMovingAverageSignal` reads. */
export const MOVING_AVERAGE_COLUMN = seriesOperand("SMA_50D");
