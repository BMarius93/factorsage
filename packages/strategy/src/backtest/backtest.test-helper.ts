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
import type { OperandKey } from "../operands.js";
import type {
  BacktestExecutionInput,
  BacktestSecurityInput,
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
    startDate: input.startDate ?? (sorted[0] as LocalDate),
    endDate: input.endDate ?? (sorted[sorted.length - 1] as LocalDate),
    initialCapital: input.initialCapital ?? 100_000,
    monthlyContribution: input.monthlyContribution ?? 0,
    maximumPositions: input.maximumPositions ?? 10,
    ...input,
  };
}
