import type { StrategyDefinition } from "@intrinsic/contracts";
import {
  buildStrategyGates,
  createEvaluationFrame,
  simulateBacktest,
  type EvaluationFrame,
} from "@intrinsic/strategy";
import { ComparisonLedger } from "../comparison";
import {
  and,
  marketPredicate,
  signalValue,
  type MarketRow,
  type Tri,
} from "../oracle/predicates";
import {
  isPositionMetric,
  parseOracleStrategy,
  type OracleSignal,
} from "../oracle/strategy-model";
import type { OracleSecurity } from "../oracle/reference-backtester";
import type { BacktestArchive } from "./archive-reader";
import type { PersistedRun } from "./persisted-run";

/**
 * Probes that exercise the **production** engine as the subject, against the oracle or against the
 * run's own persisted result:
 *
 * - strategy evaluation: the production gate for every level, security and simulated date against
 *   the reference evaluation of the same rows;
 * - look-ahead: the production engine re-run with every observation after a cut date replaced by
 *   adversarial values must make exactly the same decisions up to the cut.
 */

const TRI: Record<number, Tri> = { 0: "NOT_EVALUABLE", 1: "FALSE", 2: "TRUE" };

function marketHalf(
  signal: OracleSignal,
  row: MarketRow,
  previous: MarketRow | null,
): Tri {
  const parts: Tri[] = [];
  for (const condition of signal.conditions) {
    if (!isPositionMetric(condition.metric)) {
      parts.push(marketPredicate(condition, false, row, previous));
    }
  }
  if (signal.trigger && !isPositionMetric(signal.trigger.metric)) {
    parts.push(marketPredicate(signal.trigger, true, row, previous));
  }
  return and(parts);
}

function productionFrame(
  frame: BacktestArchive["frames"][number],
  name: string,
): EvaluationFrame {
  const columns = new Map<string, Float64Array>();
  for (const [key, values] of Object.entries(frame.operands)) {
    columns.set(
      key,
      Float64Array.from(
        values.map((value) => (typeof value === "number" ? value : Number.NaN)),
      ),
    );
  }
  return createEvaluationFrame({
    securityId: frame.securityId,
    symbol: frame.symbol,
    name,
    dates: frame.dates,
    closes: Float64Array.from(
      frame.closes.map((value) =>
        typeof value === "number" ? value : Number.NaN,
      ),
    ),
    columns,
    periodStartIndex: frame.contextRowCount,
  });
}

export type GateTrace = {
  symbol: string;
  date: string;
  level: string;
  inputs: Record<string, number | null>;
  expected: Tri;
  actual: Tri;
};

export function strategyGateDifferential(
  archive: BacktestArchive,
  securities: readonly OracleSecurity[],
  ledger: ComparisonLedger,
  traces: GateTrace[],
): { comparisons: number; trueDays: number; notEvaluableDays: number } {
  const definition = archive.snapshot.strategy.definition as StrategyDefinition;
  const oracleStrategy = parseOracleStrategy(definition);
  const rowsBySecurity = new Map(
    securities.map((security) => [
      security.securityId,
      {
        rows: security.rows,
        index: new Map(
          security.rows.map((row, position) => [row.date, position]),
        ),
      },
    ]),
  );
  let comparisons = 0;
  let trueDays = 0;
  let notEvaluableDays = 0;
  for (const frame of archive.frames) {
    const merged = rowsBySecurity.get(frame.securityId);
    if (!merged || frame.dates.length === 0) {
      continue;
    }
    const gates = buildStrategyGates(
      definition,
      productionFrame(frame, frame.symbol),
    );
    const levels: {
      id: string;
      label: string;
      gate: Uint8Array | undefined;
      expected: (row: MarketRow, previous: MarketRow | null) => Tri;
    }[] = [
      ...oracleStrategy.buyLevels.map((level) => ({
        id: level.id,
        label: `BUY ${level.percentage}% ${level.id}`,
        gate: gates.buy.get(level.id),
        expected: (row: MarketRow, previous: MarketRow | null) =>
          signalValue(level.signal, row, previous, null),
      })),
      ...oracleStrategy.sellLevels.map((level) => ({
        id: level.id,
        label: `SELL ${level.percentage}% ${level.id} (market half)`,
        gate: gates.sell.get(level.id),
        expected: (row: MarketRow, previous: MarketRow | null) =>
          marketHalf(level.signal, row, previous),
      })),
      ...(oracleStrategy.finalExit?.rules ?? []).map((rule, ruleIndex) => ({
        id: rule.id,
        label: `FINAL EXIT rule ${ruleIndex + 1} (market half)`,
        gate: gates.finalExit?.[ruleIndex],
        expected: (row: MarketRow, previous: MarketRow | null) =>
          marketHalf(rule.signal, row, previous),
      })),
    ];
    frame.dates.forEach((date, frameIndex) => {
      if (
        date < frame.window.requestedFrom ||
        date > frame.window.requestedTo
      ) {
        return;
      }
      const position = merged.index.get(date);
      if (position === undefined) {
        return;
      }
      const row = merged.rows[position]!;
      const previous = position > 0 ? merged.rows[position - 1]! : null;
      for (const level of levels) {
        const expected = level.expected(row, previous);
        const actual = TRI[level.gate?.[frameIndex] ?? 0]!;
        comparisons += 1;
        if (expected === "TRUE") {
          trueDays += 1;
        } else if (expected === "NOT_EVALUABLE") {
          notEvaluableDays += 1;
        }
        const ok = ledger.check(
          "strategy-evaluation",
          `${frame.symbol} ${date} ${level.label}`,
          expected,
          actual,
          "exact-text",
        );
        if (
          (!ok ||
            (expected === "TRUE" && traces.length < 40) ||
            (expected === "NOT_EVALUABLE" && traces.length < 20)) &&
          traces.length < 60
        ) {
          traces.push({
            symbol: frame.symbol,
            date,
            level: level.label,
            inputs: {
              close: row.close,
              previousClose: previous?.close ?? null,
              ...Object.fromEntries([...row.values.entries()]),
              ...Object.fromEntries(
                [...(previous?.values.entries() ?? [])].map(([key, value]) => [
                  `previous ${key}`,
                  value,
                ]),
              ),
            },
            expected,
            actual,
          });
        }
      }
    });
  }
  return { comparisons, trueDays, notEvaluableDays };
}

/**
 * Re-runs the production engine with every observation after `cut` replaced by adversarial values,
 * and requires every decision up to `cut` to match the persisted run exactly.
 */
export async function lookAheadPoisonProbe(
  archive: BacktestArchive,
  securities: readonly OracleSecurity[],
  persisted: PersistedRun,
  ledger: ComparisonLedger,
): Promise<{ cut: string; tradesCompared: number; equityCompared: number }> {
  const calendar = archive.calendar;
  const cut = calendar[Math.floor(calendar.length / 2)]!;
  const poison = (value: number, index: number): number =>
    Number.isFinite(value)
      ? index % 3 === 0
        ? value * 7
        : index % 3 === 1
          ? value / 9
          : Number.NaN
      : 42;
  const inputs = securities.map((security) => {
    const keys = new Set<string>();
    for (const row of security.rows) {
      for (const key of row.values.keys()) {
        keys.add(key);
      }
    }
    const rows = security.rows;
    const columns = new Map<string, Float64Array>();
    for (const key of keys) {
      columns.set(
        key,
        Float64Array.from(
          rows.map((row, index) => {
            const value = row.values.get(key) ?? Number.NaN;
            return row.date > cut ? poison(value, index + 1) : value;
          }),
        ),
      );
    }
    const frame = createEvaluationFrame({
      securityId: security.securityId,
      symbol: security.symbol,
      name: security.symbol,
      dates: rows.map((row) => row.date),
      closes: Float64Array.from(
        rows.map((row, index) =>
          row.date > cut ? Math.abs(poison(row.close, index)) || 1 : row.close,
        ),
      ),
      columns,
      periodStartIndex: 0,
    });
    return {
      frame,
      buyWindows: {
        mode: security.buyWindowMode,
        ranges: security.buyWindows.map((window) => ({
          startDate: window.startDate,
          endDate: window.endDate,
        })),
      },
    };
  });
  const benchmark = archive.benchmark
    ? {
        benchmarkId: "audit",
        code: "SP500",
        name: "S&P 500",
        dates: archive.benchmark.dates,
        closes: Float64Array.from(
          archive.benchmark.dates.map((date, index) =>
            date > cut
              ? archive.benchmark!.closes[index]! * 5
              : archive.benchmark!.closes[index]!,
          ),
        ),
      }
    : null;
  const result = await simulateBacktest({
    definition: archive.snapshot.strategy.definition as StrategyDefinition,
    securities: inputs,
    benchmark,
    executionCalendar: calendar,
    startDate: archive.snapshot.period.startDate,
    endDate: archive.snapshot.period.endDate,
    initialCapital: archive.snapshot.capital.initialCapital,
    monthlyContribution: archive.snapshot.capital.monthlyContribution,
    maximumPositions: archive.snapshot.allocation.maximumPositions,
  });
  const expectedTrades = persisted.trades.filter((trade) => trade.date <= cut);
  const actualTrades = result.trades.filter((trade) => trade.date <= cut);
  ledger.check(
    "look-ahead",
    `poisoned after ${cut}: trade count up to the cut`,
    expectedTrades.length,
    actualTrades.length,
    "exact-number",
  );
  expectedTrades.forEach((trade, index) => {
    const actual = actualTrades[index];
    const signature = (
      value:
        | {
            date: string;
            securityId: string;
            action: string;
            shares: string;
            price: string;
            cashAfter: string;
          }
        | undefined,
    ): string =>
      value
        ? `${value.date}|${value.securityId}|${value.action}|${Number(value.shares)}|${Number(value.price)}|${Number(value.cashAfter)}`
        : "missing";
    ledger.check(
      "look-ahead",
      `poisoned after ${cut}: trade ${trade.sequence}`,
      signature(trade),
      signature(actual),
      "exact-text",
    );
  });
  const expectedEquity = persisted.equity.filter((row) => row.date <= cut);
  let equityCompared = 0;
  expectedEquity.forEach((row, index) => {
    const actual = result.equity[index];
    equityCompared += 1;
    ledger.check(
      "look-ahead",
      `poisoned after ${cut}: equity ${row.date}`,
      `${row.date}|${Number(row.totalValue)}|${Number(row.cash)}|${row.benchmarkValue === null ? null : Number(row.benchmarkValue)}`,
      actual
        ? `${actual.date}|${Number(actual.totalValue)}|${Number(actual.cash)}|${actual.benchmarkValue === null ? null : Number(actual.benchmarkValue)}`
        : "missing",
      "exact-text",
    );
  });
  return { cut, tradesCompared: expectedTrades.length, equityCompared };
}
