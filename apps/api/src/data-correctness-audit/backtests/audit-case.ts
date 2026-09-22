import { ComparisonLedger } from "../comparison";
import {
  correctlyRoundedAtScale,
  dec,
  money,
  price,
  storedAtScale,
  ZERO,
  type Dec,
} from "../oracle/decimal";
import type { MarketRow } from "../oracle/predicates";
import {
  referenceAnnualReturns,
  runReferenceBacktest,
  type OracleBacktestResult,
  type OracleSecurity,
} from "../oracle/reference-backtester";
import { parseOracleStrategy } from "../oracle/strategy-model";
import type { BacktestArchive } from "./archive-reader";
import type { PersistedRun } from "./persisted-run";

/**
 * One matrix scenario, audited end to end below the API:
 *
 *   archive inputs ──► independent reference backtester ──► expected ledger
 *   PostgreSQL result (what the API serves)             ──► actual ledger
 *
 * plus a ledger reconstruction from the persisted trades alone, the invariants, and the
 * final-liquidation checks. Nothing here calls the production engine.
 */

export type FrameMergeIssue = {
  securityId: string;
  date: string;
  field: string;
  first: unknown;
  second: unknown;
};

export type CaseAudit = {
  caseId: string;
  index: number;
  runId: string;
  ledger: ComparisonLedger;
  counts: {
    tradesExpected: number;
    tradesActual: number;
    tradesCompared: number;
    equityRowsCompared: number;
    benchmarkRowsCompared: number;
    metricComparisons: number;
    annualReturnYears: number;
    invariantChecks: number;
    invariantViolations: number;
    ledgerSteps: number;
    ledgerViolations: number;
    liquidationChecks: number;
    liquidationFailures: number;
    decisionsEvaluated: number;
    /** Stored ratios whose Prisma 16-digit conversion differs from correct rounding (AUD-01). */
    ratioDoubleRoundings: number;
  };
  invariantViolations: string[];
  ledgerViolations: string[];
  liquidation: { trades: number; failures: string[] };
  frameIssues: FrameMergeIssue[];
  oracle: OracleBacktestResult;
  annualReturns: ReturnType<typeof referenceAnnualReturns>;
  /** The annual returns the API must report: computed from the returnIndex as PostgreSQL stores it. */
  annualReturnsFromStoredIndex: ReturnType<typeof referenceAnnualReturns>;
};

/** Every row a security's frames held, merged across windows; context rows must agree. */
export function mergeSecurityRows(
  archive: BacktestArchive,
  securityId: string,
  issues: FrameMergeIssue[],
): MarketRow[] {
  const byDate = new Map<
    string,
    { close: number; values: Map<string, number> }
  >();
  for (const frame of archive.frames) {
    if (frame.securityId !== securityId) {
      continue;
    }
    for (let index = 0; index < frame.dates.length; index += 1) {
      const date = frame.dates[index]!;
      const close = frame.closes[index];
      const values = new Map<string, number>();
      for (const [key, column] of Object.entries(frame.operands)) {
        const value = column[index];
        if (typeof value === "number") {
          values.set(key, value);
        }
      }
      const existing = byDate.get(date);
      const closeNumber = typeof close === "number" ? close : Number.NaN;
      if (!existing) {
        byDate.set(date, { close: closeNumber, values });
        continue;
      }
      if (!Object.is(existing.close, closeNumber)) {
        issues.push({
          securityId,
          date,
          field: "close",
          first: existing.close,
          second: closeNumber,
        });
      }
      for (const key of new Set([
        ...existing.values.keys(),
        ...values.keys(),
      ])) {
        const left = existing.values.get(key);
        const right = values.get(key);
        if (left !== right) {
          issues.push({
            securityId,
            date,
            field: key,
            first: left ?? null,
            second: right ?? null,
          });
        }
      }
    }
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, row]) => ({ date, close: row.close, values: row.values }));
}

export function oracleSecurities(
  archive: BacktestArchive,
  issues: FrameMergeIssue[],
): OracleSecurity[] {
  const kept = new Set(
    archive.preparation.securities
      .filter((entry) => !entry.skipped)
      .map((entry) => entry.securityId),
  );
  return archive.snapshot.securities
    .filter((security) => kept.has(security.securityId))
    .map((security) => ({
      securityId: security.securityId,
      symbol: security.symbol,
      buyWindowMode: security.buyWindowMode,
      buyWindows: security.buyWindows.map((window) => ({
        startDate: window.startDate,
        endDate: window.endDate ?? null,
      })),
      rows: mergeSecurityRows(archive, security.securityId, issues),
    }));
}

const stored = (value: number | null, scale: number): string | null =>
  value === null || !Number.isFinite(value)
    ? null
    : storedAtScale(value, scale);

export function auditCase(input: {
  caseId: string;
  index: number;
  archive: BacktestArchive;
  persisted: PersistedRun;
}): CaseAudit {
  const { archive, persisted } = input;
  const ledger = new ComparisonLedger(300);
  const frameIssues: FrameMergeIssue[] = [];
  const securities = oracleSecurities(archive, frameIssues);
  const snapshot = archive.snapshot;
  const oracle = runReferenceBacktest({
    strategy: parseOracleStrategy(snapshot.strategy.definition),
    securities,
    calendar: archive.calendar,
    startDate: snapshot.period.startDate,
    endDate: snapshot.period.endDate,
    initialCapital: snapshot.capital.initialCapital,
    monthlyContribution: snapshot.capital.monthlyContribution,
    maximumPositions: snapshot.allocation.maximumPositions,
    benchmark: archive.benchmark,
  });

  ledger.check("run", "status", "COMPLETED", persisted.status, "exact-text");
  ledger.check(
    "run",
    "fullPositionFraction",
    1 / snapshot.allocation.maximumPositions,
    snapshot.allocation.fullPositionFraction,
    "exact-number",
  );

  // ---- Trades ---------------------------------------------------------------------------------
  ledger.check(
    "trades",
    "trades.count",
    oracle.trades.length,
    persisted.trades.length,
    "exact-number",
  );
  const tradeCount = Math.max(oracle.trades.length, persisted.trades.length);
  let tradesCompared = 0;
  for (let index = 0; index < tradeCount; index += 1) {
    const expected = oracle.trades[index];
    const actual = persisted.trades[index];
    const path = `trades[${index + 1}]`;
    if (!expected || !actual) {
      ledger.check(
        "trades",
        `${path}.present`,
        expected ? "present" : "absent",
        actual ? "present" : "absent",
        "exact-text",
      );
      continue;
    }
    tradesCompared += 1;
    const label = `${path} ${expected.date} ${expected.symbol} ${expected.action}`;
    ledger.check(
      "trades",
      `${label}.sequence`,
      expected.sequence,
      actual.sequence,
      "exact-number",
    );
    ledger.check(
      "trades",
      `${label}.date`,
      expected.date,
      actual.date,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.securityId`,
      expected.securityId,
      actual.securityId,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.symbol`,
      expected.symbol,
      actual.symbol,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.action`,
      expected.action,
      actual.action,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.source`,
      expected.source,
      actual.source,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.levelId`,
      expected.levelId,
      actual.levelId,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.exitRuleId`,
      expected.exitRuleId,
      actual.exitRuleId,
      "exact-text",
    );
    ledger.check(
      "trades",
      `${label}.levelPercentage`,
      expected.levelPercentage,
      actual.levelPercentage,
      "exact-number",
    );
    ledger.check(
      "trades",
      `${label}.shares`,
      expected.shares,
      actual.shares,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.price`,
      expected.price,
      actual.price,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.amount`,
      expected.amount,
      actual.amount,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.fees`,
      expected.fees,
      actual.fees,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.realizedPnl`,
      expected.realizedPnl,
      actual.realizedPnl,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.realizedPnlPercent`,
      stored(expected.realizedPnlPercent, 8),
      actual.realizedPnlPercent,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.cashAfter`,
      expected.cashAfter,
      actual.cashAfter,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.sharesAfter`,
      expected.sharesAfter,
      actual.sharesAfter,
      "exact-decimal",
    );
    ledger.check(
      "trades",
      `${label}.averageCostAfter`,
      expected.averageCostAfter,
      actual.averageCostAfter,
      "exact-decimal",
    );
  }

  // ---- Equity and benchmark rows ----------------------------------------------------------------
  ledger.check(
    "equity",
    "equity.count",
    oracle.equity.length,
    persisted.equity.length,
    "exact-number",
  );
  let equityRowsCompared = 0;
  let ratioDoubleRoundings = 0;
  let benchmarkRowsCompared = 0;
  const rows = Math.min(oracle.equity.length, persisted.equity.length);
  for (let index = 0; index < rows; index += 1) {
    const expected = oracle.equity[index]!;
    const actual = persisted.equity[index]!;
    const path = `equity[${expected.date}]`;
    equityRowsCompared += 1;
    if (
      storedAtScale(expected.returnIndex, 10) !==
      correctlyRoundedAtScale(expected.returnIndex, 10)
    ) {
      ratioDoubleRoundings += 1;
    }
    ledger.check(
      "equity",
      `${path}.date`,
      expected.date,
      actual.date,
      "exact-text",
    );
    ledger.check(
      "equity",
      `${path}.cash`,
      expected.cash,
      actual.cash,
      "exact-decimal",
    );
    ledger.check(
      "equity",
      `${path}.positionsValue`,
      expected.positionsValue,
      actual.positionsValue,
      "exact-decimal",
    );
    ledger.check(
      "equity",
      `${path}.totalValue`,
      expected.totalValue,
      actual.totalValue,
      "exact-decimal",
    );
    ledger.check(
      "equity",
      `${path}.investedCapital`,
      expected.investedCapital,
      actual.investedCapital,
      "exact-decimal",
    );
    ledger.check(
      "equity",
      `${path}.returnIndex`,
      stored(expected.returnIndex, 10),
      actual.returnIndex,
      "exact-decimal",
    );
    ledger.check(
      "equity",
      `${path}.cashBaselineValue`,
      expected.cashBaselineValue,
      actual.cashBaselineValue,
      "exact-decimal",
    );
    ledger.check(
      "equity",
      `${path}.openPositions`,
      expected.openPositions,
      actual.openPositions,
      "exact-number",
    );
    benchmarkRowsCompared += 1;
    ledger.check(
      "benchmark",
      `${path}.benchmarkIndex`,
      stored(expected.benchmarkIndex, 10),
      actual.benchmarkIndex,
      "exact-decimal",
    );
    ledger.check(
      "benchmark",
      `${path}.benchmarkValue`,
      expected.benchmarkValue,
      actual.benchmarkValue,
      "exact-decimal",
    );
  }

  // ---- Summary and metrics ------------------------------------------------------------------------
  let metricComparisons = 0;
  const summary = persisted.summary;
  if (!summary) {
    ledger.check(
      "metrics",
      "summary.present",
      "present",
      "absent",
      "exact-text",
    );
  } else {
    const e = oracle.summary;
    const metric = (
      field: string,
      expected: unknown,
      rule: "exact-decimal" | "exact-number" | "exact-text",
      scale?: number,
    ): void => {
      metricComparisons += 1;
      const value =
        scale !== undefined
          ? stored(expected as number | null, scale)
          : expected;
      ledger.check(
        "metrics",
        `summary.${field}`,
        value,
        summary[field] ?? null,
        rule,
      );
    };
    metric("firstSimulatedDate", e.firstSimulatedDate, "exact-text");
    metric("lastSimulatedDate", e.lastSimulatedDate, "exact-text");
    metric("tradingDays", e.tradingDays, "exact-number");
    metric("investedCapital", e.investedCapital, "exact-decimal");
    metric("finalCash", e.finalCash, "exact-decimal");
    metric("finalPositionsValue", e.finalPositionsValue, "exact-decimal");
    metric("finalValue", e.finalValue, "exact-decimal");
    metric("netProfit", e.netProfit, "exact-decimal");
    metric(
      "portfolioReturnPercent",
      e.portfolioReturnPercent,
      "exact-decimal",
      8,
    );
    metric(
      "benchmarkReturnPercent",
      e.benchmarkReturnPercent,
      "exact-decimal",
      8,
    );
    metric("alphaPercent", e.alphaPercent, "exact-decimal", 8);
    metric("portfolioCagrPercent", e.portfolioCagrPercent, "exact-decimal", 8);
    metric("maxDrawdownPercent", e.maxDrawdownPercent, "exact-decimal", 8);
    metric(
      "benchmarkMaxDrawdownPercent",
      e.benchmarkMaxDrawdownPercent,
      "exact-decimal",
      8,
    );
    metric("realizedPnl", e.realizedPnl, "exact-decimal");
    metric("unrealizedPnl", e.unrealizedPnl, "exact-decimal");
    for (const field of [
      "totalTrades",
      "buyTrades",
      "sellTrades",
      "finalExitTrades",
      "winningTrades",
      "losingTrades",
      "openPositions",
    ] as const) {
      metric(field, e[field], "exact-number");
    }
  }

  // ---- Annual returns -----------------------------------------------------------------------------
  const period = {
    startDate: snapshot.period.startDate,
    endDate: snapshot.period.endDate,
  };
  const annualReturns = referenceAnnualReturns(
    oracle.equity.map((row) => ({
      date: row.date,
      returnIndex: row.returnIndex,
    })),
    period,
  );
  const annualReturnsFromStoredIndex = referenceAnnualReturns(
    oracle.equity.map((row) => ({
      date: row.date,
      returnIndex: Number(storedAtScale(row.returnIndex, 10)),
    })),
    period,
  );
  // The chained yearly figures must multiply back to the total return (backtests.md).
  if (annualReturns.length > 0) {
    const chained = annualReturns.reduce(
      (product, year) => product * (1 + year.returnPercent / 100),
      1,
    );
    ledger.check(
      "annual-returns",
      "annualReturns.chain == totalReturn",
      oracle.summary.portfolioReturnPercent,
      (chained - 1) * 100,
      {
        tolerance:
          1e-9 * Math.max(1, Math.abs(oracle.summary.portfolioReturnPercent)),
        justification:
          "float64 product of up to 31 yearly ratios; relative 1e-9 of the total",
      },
    );
  }

  // ---- Ledger reconstruction from the persisted rows alone ----------------------------------------
  const ledgerViolations: string[] = [];
  let ledgerSteps = 0;
  const tradesByDate = new Map<string, typeof persisted.trades>();
  for (const trade of persisted.trades) {
    const list = tradesByDate.get(trade.date) ?? [];
    list.push(trade);
    tradesByDate.set(trade.date, list);
  }
  const lastClose = new Map<string, number>();
  const closesBySecurity = new Map(
    securities.map((security) => [
      security.securityId,
      new Map(security.rows.map((row) => [row.date, row.close])),
    ]),
  );
  const held = new Map<string, Dec>();
  let cash: Dec | null = null;
  let previousInvested: Dec | null = null;
  const invariantViolations: string[] = [];
  let invariantChecks = 0;
  const invariant = (condition: boolean, message: string): void => {
    invariantChecks += 1;
    if (!condition && invariantViolations.length < 200) {
      invariantViolations.push(message);
    }
    if (!condition && invariantViolations.length >= 200) {
      invariantViolations.length = 200;
    }
  };
  const calendarSet = new Set(oracle.calendar);
  const eligible = new Map(
    securities.map((security) => [security.securityId, security]),
  );
  for (const row of persisted.equity) {
    const invested = dec(row.investedCapital);
    const contribution =
      previousInvested === null ? ZERO : invested.minus(previousInvested);
    if (cash === null) {
      cash = dec(snapshot.capital.initialCapital);
    } else {
      cash = cash.plus(contribution);
    }
    previousInvested = invested;
    for (const security of securities) {
      const close = closesBySecurity.get(security.securityId)!.get(row.date);
      if (close !== undefined && Number.isFinite(close) && close > 0) {
        lastClose.set(security.securityId, close);
      }
    }
    const closedToday = new Set<string>();
    for (const trade of tradesByDate.get(row.date) ?? []) {
      ledgerSteps += 1;
      const shares = dec(trade.shares);
      const amount = dec(trade.amount);
      const before = held.get(trade.securityId) ?? ZERO;
      invariant(
        calendarSet.has(trade.date),
        `trade ${trade.sequence} on ${trade.date} is not an execution date`,
      );
      invariant(
        shares.gt(0),
        `trade ${trade.sequence} trades a non-positive quantity ${trade.shares}`,
      );
      invariant(
        dec(trade.fees).eq(0),
        `trade ${trade.sequence} carries a fee under zero-fees@1`,
      );
      invariant(
        money(shares.times(dec(trade.price))).eq(amount),
        `trade ${trade.sequence} amount ${trade.amount} != shares x price`,
      );
      const close = closesBySecurity.get(trade.securityId)?.get(trade.date);
      if (trade.source === "END_OF_BACKTEST") {
        const mark = lastClose.get(trade.securityId);
        invariant(
          mark !== undefined && price(mark).eq(dec(trade.price)),
          `liquidation ${trade.sequence} ${trade.symbol} price ${trade.price} is not the last observed close ${mark}`,
        );
      } else {
        invariant(
          close !== undefined && price(close).eq(dec(trade.price)),
          `trade ${trade.sequence} ${trade.symbol} price ${trade.price} is not the ${trade.date} close ${close}`,
        );
      }
      if (trade.action === "BUY") {
        const security = eligible.get(trade.securityId);
        const windowOpen =
          security !== undefined &&
          (security.buyWindowMode === "FULL" ||
            security.buyWindows.some(
              (window) =>
                window.startDate <= trade.date &&
                (window.endDate === null || trade.date <= window.endDate),
            ));
        invariant(
          windowOpen,
          `BUY ${trade.sequence} ${trade.symbol} on ${trade.date} is outside its buy window`,
        );
        invariant(
          !closedToday.has(trade.securityId),
          `BUY ${trade.sequence} re-enters ${trade.symbol} on the date it closed`,
        );
        cash = cash.minus(amount);
        held.set(trade.securityId, before.plus(shares));
      } else {
        invariant(
          before.gt(0),
          `${trade.action} ${trade.sequence} ${trade.symbol} sells a position that is not open (orphan sell)`,
        );
        invariant(
          shares.lte(before),
          `${trade.action} ${trade.sequence} sells ${trade.shares} of ${before.toFixed(10)} held`,
        );
        cash = cash.plus(amount);
        const after = before.minus(shares);
        held.set(trade.securityId, after);
        if (after.eq(0)) {
          closedToday.add(trade.securityId);
          held.delete(trade.securityId);
        }
        if (
          trade.action === "FINAL_EXIT" ||
          trade.source === "END_OF_BACKTEST"
        ) {
          invariant(
            after.eq(0),
            `${trade.action} ${trade.sequence} leaves ${after.toFixed(10)} shares`,
          );
        }
      }
      if (!cash.eq(dec(trade.cashAfter))) {
        ledgerViolations.push(
          `trade ${trade.sequence}: reconstructed cash ${cash.toFixed(6)} != cashAfter ${trade.cashAfter}`,
        );
      }
      invariant(
        dec(trade.cashAfter).gte(0),
        `trade ${trade.sequence} leaves negative cash ${trade.cashAfter}`,
      );
      invariant(
        dec(trade.sharesAfter).eq(held.get(trade.securityId) ?? ZERO),
        `trade ${trade.sequence} sharesAfter ${trade.sharesAfter} != reconstructed ${(held.get(trade.securityId) ?? ZERO).toFixed(10)}`,
      );
    }
    ledgerSteps += 1;
    if (!cash.eq(dec(row.cash))) {
      ledgerViolations.push(
        `${row.date}: reconstructed cash ${cash.toFixed(6)} != equity cash ${row.cash}`,
      );
      cash = dec(row.cash);
    }
    let marked = ZERO;
    for (const [securityId, shares] of held) {
      const mark = lastClose.get(securityId);
      if (mark === undefined) {
        ledgerViolations.push(
          `${row.date}: holding ${securityId} has no observed close to mark at`,
        );
        continue;
      }
      marked = marked.plus(money(shares.times(price(mark))));
    }
    marked = money(marked);
    if (!marked.eq(dec(row.positionsValue))) {
      ledgerViolations.push(
        `${row.date}: reconstructed positions ${marked.toFixed(6)} != equity ${row.positionsValue}`,
      );
    }
    invariant(
      money(dec(row.cash).plus(dec(row.positionsValue))).eq(
        dec(row.totalValue),
      ),
      `${row.date}: cash + positionsValue != totalValue`,
    );
    invariant(dec(row.cash).gte(0), `${row.date}: negative cash ${row.cash}`);
    invariant(
      row.openPositions === held.size,
      `${row.date}: openPositions ${row.openPositions} != ${held.size} held`,
    );
    invariant(
      row.openPositions <= snapshot.allocation.maximumPositions,
      `${row.date}: ${row.openPositions} open positions exceed maximumPositions`,
    );
    invariant(
      calendarSet.has(row.date),
      `${row.date}: equity row on a date outside the execution calendar`,
    );
  }
  for (let index = 1; index < persisted.equity.length; index += 1) {
    invariant(
      persisted.equity[index - 1]!.date < persisted.equity[index]!.date,
      `equity dates not strictly ascending at ${persisted.equity[index]!.date}`,
    );
  }

  // ---- Final liquidation --------------------------------------------------------------------------
  const liquidationFailures: string[] = [];
  let liquidationChecks = 0;
  const liquidationCheck = (condition: boolean, message: string): void => {
    liquidationChecks += 1;
    if (!condition) {
      liquidationFailures.push(message);
    }
  };
  const lastDate = oracle.calendar[oracle.calendar.length - 1]!;
  const liquidations = persisted.trades.filter(
    (trade) => trade.source === "END_OF_BACKTEST",
  );
  liquidationCheck(
    liquidations.every((trade) => trade.date === lastDate),
    "an END_OF_BACKTEST sale is not on the final date",
  );
  liquidationCheck(
    liquidations.every((trade) => trade.action === "SELL"),
    "an END_OF_BACKTEST trade is not a SELL",
  );
  liquidationCheck(
    liquidations.every(
      (trade) =>
        trade.levelId === null &&
        trade.exitRuleId === null &&
        trade.levelPercentage === null,
    ),
    "an END_OF_BACKTEST sale names a strategy level",
  );
  if (summary) {
    liquidationCheck(
      dec(String(summary.finalCash)).eq(dec(String(summary.finalValue))),
      "finalCash != finalValue",
    );
    liquidationCheck(
      dec(String(summary.finalPositionsValue)).eq(0),
      "finalPositionsValue != 0",
    );
    liquidationCheck(
      dec(String(summary.unrealizedPnl)).eq(0),
      "unrealizedPnl != 0",
    );
    liquidationCheck(
      Number(summary.openPositions) === 0,
      "summary.openPositions != 0",
    );
    liquidationCheck(
      dec(String(summary.finalValue)).eq(
        dec(String(summary.investedCapital)).plus(
          dec(String(summary.realizedPnl)),
        ),
      ),
      "finalValue != investedCapital + realizedPnl",
    );
  }
  liquidationCheck(
    persisted.positions === 0,
    `${persisted.positions} BacktestPosition rows persisted for a liquidated run`,
  );
  liquidationCheck(
    held.size === 0,
    `${held.size} positions still open after the final date in the reconstructed ledger`,
  );
  const lastEquity = persisted.equity[persisted.equity.length - 1];
  liquidationCheck(
    lastEquity !== undefined && lastEquity.openPositions === 0,
    "the final equity row reports open positions",
  );
  // Every position the oracle still held after the final date's own execution is sold, and nothing else.
  const expectedLiquidations = oracle.trades.filter(
    (trade) => trade.source === "END_OF_BACKTEST",
  ).length;
  liquidationCheck(
    expectedLiquidations === liquidations.length,
    `expected ${expectedLiquidations} liquidation sales, found ${liquidations.length}`,
  );

  const invariantsFailed = invariantViolations.length;
  return {
    caseId: input.caseId,
    index: input.index,
    runId: persisted.runId,
    ledger,
    counts: {
      tradesExpected: oracle.trades.length,
      tradesActual: persisted.trades.length,
      tradesCompared,
      equityRowsCompared,
      benchmarkRowsCompared,
      metricComparisons,
      annualReturnYears: annualReturns.length,
      invariantChecks,
      invariantViolations: invariantsFailed,
      ledgerSteps,
      ledgerViolations: ledgerViolations.length,
      liquidationChecks,
      liquidationFailures: liquidationFailures.length,
      decisionsEvaluated: oracle.decisionsEvaluated,
      ratioDoubleRoundings,
    },
    invariantViolations,
    ledgerViolations: ledgerViolations.slice(0, 200),
    liquidation: { trades: liquidations.length, failures: liquidationFailures },
    frameIssues: frameIssues.slice(0, 100),
    oracle,
    annualReturns,
    annualReturnsFromStoredIndex,
  };
}
