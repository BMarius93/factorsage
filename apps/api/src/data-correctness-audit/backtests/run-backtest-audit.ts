import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@intrinsic/database";
import { ComparisonLedger } from "../comparison";
import { dec } from "../oracle/decimal";
import type { AuditWriter } from "../artifacts";
import { readBacktestArchive } from "./archive-reader";
import { auditCase, oracleSecurities, type CaseAudit } from "./audit-case";
import {
  lookAheadPoisonProbe,
  strategyGateDifferential,
  type GateTrace,
} from "./engine-probes";
import {
  readCalendarDates,
  readBenchmarkCloses,
  readDailyCloses,
  readPersistedRun,
} from "./persisted-run";

/**
 * The backtest section: every archived matrix case through the independent reference backtester,
 * compared with what PostgreSQL holds for that run.
 */

export type MatrixCaseLine = {
  caseId: string;
  index: number;
  runId: string | null;
  outcome: string;
  strategy: string;
  list: string;
  config: string;
};

export function latestMatrixSweep(root: string): string {
  const base = join(root, ".debug", "qa-matrix");
  const candidates = readdirSync(base)
    .filter(
      (name) =>
        existsSync(join(base, name, "cases.ndjson")) &&
        existsSync(join(base, name, "archives")),
    )
    .sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) {
    throw new Error(
      "no matrix sweep with archives under .debug/qa-matrix — run `pnpm qa:matrix:run --archive-all`",
    );
  }
  return join(base, latest);
}

export function readMatrixCases(sweep: string): MatrixCaseLine[] {
  return readFileSync(join(sweep, "cases.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as MatrixCaseLine)
    .sort((left, right) => left.index - right.index);
}

function archivePath(sweep: string, runId: string): string | null {
  const directory = join(sweep, "archives");
  const name = readdirSync(directory).find(
    (entry) =>
      entry.startsWith(`backtest-debug-${runId}-attempt-`) &&
      entry.endsWith(".zip"),
  );
  return name ? join(directory, name) : null;
}

/** The oracle's expectation for one run, kept for the API and UI reconciliation stages. */
export type BacktestExpectation = {
  runId: string;
  summary: CaseAudit["oracle"]["summary"];
  annualReturns: CaseAudit["annualReturns"];
  annualReturnsFromStoredIndex: CaseAudit["annualReturnsFromStoredIndex"];
  tradeCount: number;
  newestTrades: CaseAudit["oracle"]["trades"];
  configuration: {
    period: { startDate: string; endDate: string };
    initialCapital: number;
    monthlyContribution: number;
    maximumPositions: number;
    securities: number;
    equityRows: number;
    firstDate: string;
    lastDate: string;
  };
};

export type BacktestSectionTotals = {
  sweep: string;
  scenariosExpected: number;
  scenariosExecuted: number;
  scenariosPassed: number;
  scenariosFailed: number;
  scenariosSkipped: number;
  tradesCompared: number;
  tradesExpected: number;
  tradesActual: number;
  tradeMismatches: number;
  equityRowsCompared: number;
  equityMismatches: number;
  benchmarkRowsCompared: number;
  benchmarkMismatches: number;
  metricComparisons: number;
  metricMismatches: number;
  annualReturnYears: number;
  invariantChecks: number;
  invariantViolations: number;
  ledgerSteps: number;
  ledgerViolations: number;
  liquidationChecks: number;
  liquidationFailures: number;
  liquidationTrades: number;
  inputChecks: number;
  inputFailures: number;
  frameIssues: number;
  archiveFidelityChecks: number;
  archiveFidelityFailures: number;
  zeroTradeScenarios: number;
  ratioDoubleRoundings: number;
  strategyEvaluation: {
    cases: number;
    comparisons: number;
    failed: number;
    trueDays: number;
    notEvaluableDays: number;
  };
  lookAhead: {
    cases: number;
    tradesCompared: number;
    equityCompared: number;
    failed: number;
    cuts: string[];
  };
  failedScenarioIds: string[];
  comparisons: ReturnType<ComparisonLedger["totals"]>;
  byCategory: ReturnType<ComparisonLedger["byCategory"]>;
};

/**
 * Checks of the inputs themselves against PostgreSQL, so the oracle is not merely agreeing with an
 * archive the engine wrote: the calendar is the pinned series' own bars, the benchmark closes are
 * that series' closes, every frame close is the security's persisted close, and a security was
 * skipped only when it had no price row in the period.
 */
async function auditInputs(
  prisma: PrismaClient,
  archive: Awaited<ReturnType<typeof readBacktestArchive>>,
  ledger: ComparisonLedger,
  cache: Map<string, Map<string, string>>,
): Promise<void> {
  const { startDate, endDate } = archive.snapshot.period;
  const calendar = await readCalendarDates(
    prisma,
    archive.snapshot.executionCalendar.seriesId,
    startDate,
    endDate,
  );
  ledger.check(
    "inputs",
    "calendar.length",
    calendar.length,
    archive.calendar.length,
    "exact-number",
  );
  ledger.check(
    "inputs",
    "calendar.dates",
    calendar.join(","),
    archive.calendar.join(","),
    "exact-text",
  );
  if (archive.benchmark) {
    const closes = await readBenchmarkCloses(
      prisma,
      archive.snapshot.benchmark.seriesId,
      startDate,
      endDate,
    );
    ledger.check(
      "inputs",
      "benchmark.length",
      closes.length,
      archive.benchmark.dates.length,
      "exact-number",
    );
    let mismatches = 0;
    closes.forEach((row, index) => {
      if (
        row.date !== archive.benchmark!.dates[index] ||
        !dec(row.close).eq(dec(archive.benchmark!.closes[index]!))
      ) {
        mismatches += 1;
      }
    });
    ledger.check("inputs", "benchmark.closes", 0, mismatches, "exact-number");
  } else {
    ledger.skip(
      "inputs",
      "benchmark.closes",
      "the run recorded no benchmark series",
    );
  }
  for (const entry of archive.preparation.securities) {
    const key = `${entry.securityId}|${startDate}|${endDate}`;
    let closes = cache.get(key);
    if (!closes) {
      closes = new Map(
        (
          await readDailyCloses(prisma, entry.securityId, startDate, endDate)
        ).map((row) => [row.date, row.close]),
      );
      cache.set(key, closes);
    }
    ledger.check(
      "inputs",
      `security ${entry.symbol} skipped iff no price row in the period`,
      closes.size === 0,
      entry.skipped,
      "exact-number",
    );
  }
  // Every frame close inside the period is the persisted DailyPrice close for that date, and every
  // persisted row inside the period reached the frame.
  const frameCloses = new Map<string, Map<string, number | null>>();
  for (const frame of archive.frames) {
    const map =
      frameCloses.get(frame.securityId) ?? new Map<string, number | null>();
    frame.dates.forEach((date, index) =>
      map.set(date, frame.closes[index] ?? null),
    );
    frameCloses.set(frame.securityId, map);
  }
  for (const [securityId, closesInFrame] of frameCloses) {
    const persisted = cache.get(`${securityId}|${startDate}|${endDate}`);
    if (!persisted) {
      continue;
    }
    let mismatched = 0;
    let missing = 0;
    for (const [date, close] of persisted) {
      const framed = closesInFrame.get(date);
      if (framed === undefined) {
        missing += 1;
      } else if (framed === null || !dec(close).eq(dec(framed))) {
        mismatched += 1;
      }
    }
    ledger.check(
      "inputs",
      `frames ${securityId} closes == DailyPrice.close`,
      0,
      mismatched,
      "exact-number",
    );
    ledger.check(
      "inputs",
      `frames ${securityId} rows cover every DailyPrice row in the period`,
      0,
      missing,
      "exact-number",
    );
  }
}

/** The engine's in-memory result (archive) against the persisted rows: persistence fidelity. */
function auditArchiveFidelity(
  archive: Awaited<ReturnType<typeof readBacktestArchive>>,
  persisted: Awaited<ReturnType<typeof readPersistedRun>>,
  ledger: ComparisonLedger,
): void {
  ledger.check(
    "persistence",
    "archive.trades == db.trades (count)",
    archive.result.trades.length,
    persisted.trades.length,
    "exact-number",
  );
  const decimalFields = [
    "shares",
    "price",
    "amount",
    "fees",
    "realizedPnl",
    "cashAfter",
    "sharesAfter",
    "averageCostAfter",
  ];
  let tradeMismatches = 0;
  archive.result.trades.forEach((trade, index) => {
    const row = persisted.trades[index] as unknown as
      Record<string, unknown> | undefined;
    if (!row) {
      tradeMismatches += 1;
      return;
    }
    for (const field of decimalFields) {
      const left = trade[field];
      const right = row[field];
      if (
        (left === null) !== (right === null) ||
        (left !== null && !dec(String(left)).eq(dec(String(right))))
      ) {
        tradeMismatches += 1;
      }
    }
  });
  ledger.check(
    "persistence",
    "archive.trades == db.trades (fields)",
    0,
    tradeMismatches,
    "exact-number",
  );
  let equityMismatches = 0;
  archive.result.equity.forEach((row, index) => {
    const persistedRow = persisted.equity[index] as unknown as
      Record<string, unknown> | undefined;
    if (!persistedRow) {
      equityMismatches += 1;
      return;
    }
    for (const field of [
      "cash",
      "positionsValue",
      "totalValue",
      "investedCapital",
      "benchmarkValue",
      "cashBaselineValue",
    ]) {
      const left = row[field];
      const right = persistedRow[field];
      if (
        (left === null) !== (right === null) ||
        (left !== null && !dec(String(left)).eq(dec(String(right))))
      ) {
        equityMismatches += 1;
      }
    }
  });
  ledger.check(
    "persistence",
    "archive.equity == db.equity (money fields)",
    0,
    equityMismatches,
    "exact-number",
  );
}

export async function runBacktestSection(input: {
  prisma: PrismaClient;
  sweep: string;
  writer: AuditWriter;
  only?: readonly string[];
  log: (line: string) => void;
  /** Called with every archive read, for sections that consume the same evidence. */
  onArchive?: (
    archive: Awaited<ReturnType<typeof readBacktestArchive>>,
  ) => void;
}): Promise<{
  totals: BacktestSectionTotals;
  audits: Map<string, BacktestExpectation>;
}> {
  const { prisma, sweep, writer } = input;
  const cases = readMatrixCases(sweep).filter(
    (entry) => !input.only || input.only.includes(entry.caseId),
  );
  const overall = new ComparisonLedger(0);
  const totals: BacktestSectionTotals = {
    sweep,
    scenariosExpected: input.only ? input.only.length : 1000,
    scenariosExecuted: 0,
    scenariosPassed: 0,
    scenariosFailed: 0,
    scenariosSkipped: 0,
    tradesCompared: 0,
    tradesExpected: 0,
    tradesActual: 0,
    tradeMismatches: 0,
    equityRowsCompared: 0,
    equityMismatches: 0,
    benchmarkRowsCompared: 0,
    benchmarkMismatches: 0,
    metricComparisons: 0,
    metricMismatches: 0,
    annualReturnYears: 0,
    invariantChecks: 0,
    invariantViolations: 0,
    ledgerSteps: 0,
    ledgerViolations: 0,
    liquidationChecks: 0,
    liquidationFailures: 0,
    liquidationTrades: 0,
    inputChecks: 0,
    inputFailures: 0,
    frameIssues: 0,
    archiveFidelityChecks: 0,
    archiveFidelityFailures: 0,
    zeroTradeScenarios: 0,
    ratioDoubleRoundings: 0,
    strategyEvaluation: {
      cases: 0,
      comparisons: 0,
      failed: 0,
      trueDays: 0,
      notEvaluableDays: 0,
    },
    lookAhead: {
      cases: 0,
      tradesCompared: 0,
      equityCompared: 0,
      failed: 0,
      cuts: [],
    },
    failedScenarioIds: [],
    comparisons: overall.totals(),
    byCategory: {},
  };
  const kept = new Map<string, BacktestExpectation>();
  const gateLedger = new ComparisonLedger(200);
  const gateTraces: GateTrace[] = [];
  const lookAheadLedger = new ComparisonLedger(200);
  const gateCase = (caseId: string): boolean => caseId.endsWith("-C01");
  const poisonCase = (caseId: string): boolean =>
    /-L0[258]-C(05|10)$/.test(caseId);
  const closeCache = new Map<string, Map<string, string>>();
  const index: Record<string, unknown>[] = [];
  let done = 0;

  for (const matrixCase of cases) {
    done += 1;
    const scenarioName = `scenario-${String(matrixCase.index + 1).padStart(4, "0")}-${matrixCase.caseId}`;
    if (!matrixCase.runId || matrixCase.outcome !== "COMPLETED") {
      totals.scenariosSkipped += 1;
      totals.failedScenarioIds.push(matrixCase.caseId);
      index.push({
        caseId: matrixCase.caseId,
        status: "FAIL",
        reason: `run outcome ${matrixCase.outcome}`,
      });
      continue;
    }
    const path = archivePath(sweep, matrixCase.runId);
    if (!path) {
      totals.scenariosSkipped += 1;
      totals.failedScenarioIds.push(matrixCase.caseId);
      index.push({
        caseId: matrixCase.caseId,
        status: "SKIPPED",
        reason: "no forensic archive",
      });
      continue;
    }
    const archive = await readBacktestArchive(path);
    input.onArchive?.(archive);
    const persisted = await readPersistedRun(prisma, matrixCase.runId);
    const caseAudit = auditCase({
      caseId: matrixCase.caseId,
      index: matrixCase.index,
      archive,
      persisted,
    });
    const inputLedger = new ComparisonLedger(50);
    await auditInputs(prisma, archive, inputLedger, closeCache);
    const fidelity = new ComparisonLedger(50);
    auditArchiveFidelity(archive, persisted, fidelity);
    let probeFailed = false;
    if (gateCase(matrixCase.caseId) || poisonCase(matrixCase.caseId)) {
      const securities = oracleSecurities(archive, []);
      if (gateCase(matrixCase.caseId)) {
        const before = gateLedger.failed;
        const probe = strategyGateDifferential(
          archive,
          securities,
          gateLedger,
          gateTraces,
        );
        totals.strategyEvaluation.cases += 1;
        totals.strategyEvaluation.comparisons += probe.comparisons;
        totals.strategyEvaluation.trueDays += probe.trueDays;
        totals.strategyEvaluation.notEvaluableDays += probe.notEvaluableDays;
        probeFailed ||= gateLedger.failed > before;
      }
      if (poisonCase(matrixCase.caseId)) {
        const before = lookAheadLedger.failed;
        const probe = await lookAheadPoisonProbe(
          archive,
          securities,
          persisted,
          lookAheadLedger,
        );
        totals.lookAhead.cases += 1;
        totals.lookAhead.tradesCompared += probe.tradesCompared;
        totals.lookAhead.equityCompared += probe.equityCompared;
        totals.lookAhead.cuts.push(`${matrixCase.caseId}@${probe.cut}`);
        probeFailed ||= lookAheadLedger.failed > before;
      }
    }
    if (closeCache.size > 400) {
      closeCache.clear();
    }

    const categories = caseAudit.ledger.byCategory();
    const failed =
      caseAudit.ledger.failed > 0 ||
      caseAudit.counts.invariantViolations > 0 ||
      caseAudit.counts.ledgerViolations > 0 ||
      caseAudit.counts.liquidationFailures > 0 ||
      inputLedger.failed > 0 ||
      fidelity.failed > 0 ||
      probeFailed ||
      caseAudit.frameIssues.length > 0;

    totals.scenariosExecuted += 1;
    if (failed) {
      totals.scenariosFailed += 1;
      totals.failedScenarioIds.push(matrixCase.caseId);
    } else {
      totals.scenariosPassed += 1;
    }
    totals.tradesCompared += caseAudit.counts.tradesCompared;
    totals.tradesExpected += caseAudit.counts.tradesExpected;
    totals.tradesActual += caseAudit.counts.tradesActual;
    totals.tradeMismatches += categories.trades?.failed ?? 0;
    totals.equityRowsCompared += caseAudit.counts.equityRowsCompared;
    totals.equityMismatches += categories.equity?.failed ?? 0;
    totals.benchmarkRowsCompared += caseAudit.counts.benchmarkRowsCompared;
    totals.benchmarkMismatches += categories.benchmark?.failed ?? 0;
    totals.metricComparisons += caseAudit.counts.metricComparisons;
    totals.metricMismatches += categories.metrics?.failed ?? 0;
    totals.annualReturnYears += caseAudit.counts.annualReturnYears;
    totals.invariantChecks += caseAudit.counts.invariantChecks;
    totals.invariantViolations += caseAudit.counts.invariantViolations;
    totals.ledgerSteps += caseAudit.counts.ledgerSteps;
    totals.ledgerViolations += caseAudit.counts.ledgerViolations;
    totals.liquidationChecks += caseAudit.counts.liquidationChecks;
    totals.liquidationFailures += caseAudit.counts.liquidationFailures;
    totals.liquidationTrades += caseAudit.liquidation.trades;
    totals.inputChecks += inputLedger.compared;
    totals.inputFailures += inputLedger.failed;
    totals.frameIssues += caseAudit.frameIssues.length;
    totals.archiveFidelityChecks += fidelity.compared;
    totals.archiveFidelityFailures += fidelity.failed;
    totals.ratioDoubleRoundings += caseAudit.counts.ratioDoubleRoundings;
    if (caseAudit.counts.tradesActual === 0) {
      totals.zeroTradeScenarios += 1;
    }
    overall.merge(caseAudit.ledger);
    overall.merge(inputLedger);
    overall.merge(fidelity);

    writer.writeJson(
      `backtests/${scenarioName}.json`,
      scenarioArtifact(
        matrixCase,
        archive.snapshot,
        caseAudit,
        persisted,
        inputLedger,
        fidelity,
        failed,
      ),
    );
    if (failed) {
      writer.writeJson(`failures/backtests/${scenarioName}.json`, {
        caseId: matrixCase.caseId,
        runId: matrixCase.runId,
        differences: caseAudit.ledger.differences,
        invariantViolations: caseAudit.invariantViolations,
        ledgerViolations: caseAudit.ledgerViolations,
        liquidationFailures: caseAudit.liquidation.failures,
        inputDifferences: inputLedger.differences,
        fidelityDifferences: fidelity.differences,
        frameIssues: caseAudit.frameIssues,
      });
    }
    index.push({
      caseId: matrixCase.caseId,
      index: matrixCase.index,
      runId: matrixCase.runId,
      status: failed ? "FAIL" : "PASS",
      trades: caseAudit.counts.tradesActual,
      equityRows: caseAudit.counts.equityRowsCompared,
      comparisons:
        caseAudit.ledger.compared + inputLedger.compared + fidelity.compared,
      failedComparisons:
        caseAudit.ledger.failed + inputLedger.failed + fidelity.failed,
      invariantViolations: caseAudit.counts.invariantViolations,
      ledgerViolations: caseAudit.counts.ledgerViolations,
      finalValueExpected: caseAudit.oracle.summary.finalValue,
      finalValueActual: persisted.summary?.finalValue ?? null,
    });
    // Only what the API and UI stages need survives the case, so memory stays bounded.
    kept.set(matrixCase.caseId, {
      runId: matrixCase.runId,
      summary: caseAudit.oracle.summary,
      annualReturns: caseAudit.annualReturns,
      annualReturnsFromStoredIndex: caseAudit.annualReturnsFromStoredIndex,
      tradeCount: caseAudit.oracle.trades.length,
      newestTrades: caseAudit.oracle.trades.slice(-5).reverse(),
      configuration: {
        period: archive.snapshot.period,
        initialCapital: archive.snapshot.capital.initialCapital,
        monthlyContribution: archive.snapshot.capital.monthlyContribution,
        maximumPositions: archive.snapshot.allocation.maximumPositions,
        securities: archive.snapshot.securities.length,
        equityRows: caseAudit.oracle.equity.length,
        firstDate: caseAudit.oracle.calendar[0]!,
        lastDate:
          caseAudit.oracle.calendar[caseAudit.oracle.calendar.length - 1]!,
      },
    });
    if (done % 25 === 0 || failed) {
      input.log(
        `  backtests ${done}/${cases.length} ${matrixCase.caseId} ${failed ? "FAIL" : "ok"} ` +
          `trades=${caseAudit.counts.tradesActual} comparisons=${caseAudit.ledger.compared}`,
      );
    }
  }
  totals.strategyEvaluation.failed = gateLedger.failed;
  totals.lookAhead.failed = lookAheadLedger.failed;
  overall.merge(gateLedger);
  overall.merge(lookAheadLedger);
  totals.comparisons = overall.totals();
  totals.byCategory = overall.byCategory();
  writer.writeJson("strategies/real-frame-evaluation.json", {
    description:
      "Production buildStrategyGates versus the reference evaluator, every level x security x simulated date of the C01 (30-year) matrix runs.",
    ...totals.strategyEvaluation,
    differences: gateLedger.differences,
    traces: gateTraces,
  });
  writer.writeJson("lookahead/poisoned-future-probe.json", {
    description:
      "Production engine re-run with every observation after the cut replaced by adversarial values; decisions up to the cut must equal the persisted run.",
    ...totals.lookAhead,
    differences: lookAheadLedger.differences,
  });
  writer.writeJson("backtests/index.json", index);
  writer.writeJson("backtests/summary.json", totals);
  return { totals, audits: kept };
}

function scenarioArtifact(
  matrixCase: MatrixCaseLine,
  snapshot: Awaited<ReturnType<typeof readBacktestArchive>>["snapshot"],
  caseAudit: CaseAudit,
  persisted: Awaited<ReturnType<typeof readPersistedRun>>,
  inputLedger: ComparisonLedger,
  fidelity: ComparisonLedger,
  failed: boolean,
): Record<string, unknown> {
  const oracle = caseAudit.oracle;
  const TRADE_LIMIT = 400;
  const tradeRows = oracle.trades.map((expected, position) => {
    const actual = persisted.trades[position];
    const evidence = oracle.evidence[position];
    return {
      sequence: expected.sequence,
      date: expected.date,
      symbol: expected.symbol,
      action: expected.action,
      source: expected.source,
      reason: evidence?.reason ?? null,
      executionPrice: {
        expected: expected.price,
        actual: actual?.price ?? null,
      },
      cashBefore: evidence?.cashBefore ?? null,
      shares: { expected: expected.shares, actual: actual?.shares ?? null },
      amount: { expected: expected.amount, actual: actual?.amount ?? null },
      cashAfter: {
        expected: expected.cashAfter,
        actual: actual?.cashAfter ?? null,
      },
      realizedPnl: {
        expected: expected.realizedPnl,
        actual: actual?.realizedPnl ?? null,
      },
      sizing: evidence?.sizing,
      match:
        actual !== undefined &&
        actual.date === expected.date &&
        actual.securityId === expected.securityId &&
        actual.action === expected.action &&
        dec(actual.shares).eq(dec(expected.shares)) &&
        dec(actual.price).eq(dec(expected.price)) &&
        dec(actual.cashAfter).eq(dec(expected.cashAfter)),
    };
  });
  const yearEnds = oracle.equity.filter(
    (row, position) =>
      position === 0 ||
      position === oracle.equity.length - 1 ||
      oracle.equity[position + 1]!.date.slice(0, 4) !== row.date.slice(0, 4),
  );
  const persistedByDate = new Map(
    persisted.equity.map((row) => [row.date, row]),
  );
  const s = oracle.summary;
  const p = persisted.summary ?? {};
  return {
    scenario: matrixCase.caseId,
    index: matrixCase.index + 1,
    runId: matrixCase.runId,
    status: failed ? "FAIL" : "PASS",
    inputs: {
      strategy: matrixCase.strategy,
      list: matrixCase.list,
      config: matrixCase.config,
      period: snapshot.period,
      capital: snapshot.capital,
      maximumPositions: snapshot.allocation.maximumPositions,
      securities: snapshot.securities.map((security) => ({
        symbol: security.symbol,
        buyWindowMode: security.buyWindowMode,
        buyWindows: security.buyWindows,
      })),
      executionDates: oracle.calendar.length,
      contributionDates: oracle.contributionDates.length,
    },
    result: {
      finalValue: { expected: s.finalValue, actual: p.finalValue ?? null },
      finalCash: { expected: s.finalCash, actual: p.finalCash ?? null },
      investedCapital: {
        expected: s.investedCapital,
        actual: p.investedCapital ?? null,
      },
      netProfit: { expected: s.netProfit, actual: p.netProfit ?? null },
      realizedPnl: { expected: s.realizedPnl, actual: p.realizedPnl ?? null },
      portfolioReturnPercent: {
        expected: s.portfolioReturnPercent,
        actual: p.portfolioReturnPercent ?? null,
      },
      benchmarkReturnPercent: {
        expected: s.benchmarkReturnPercent,
        actual: p.benchmarkReturnPercent ?? null,
      },
      alphaPercent: {
        expected: s.alphaPercent,
        actual: p.alphaPercent ?? null,
      },
      cagrPercent: {
        expected: s.portfolioCagrPercent,
        actual: p.portfolioCagrPercent ?? null,
      },
      maxDrawdownPercent: {
        expected: s.maxDrawdownPercent,
        actual: p.maxDrawdownPercent ?? null,
      },
      benchmarkMaxDrawdownPercent: {
        expected: s.benchmarkMaxDrawdownPercent,
        actual: p.benchmarkMaxDrawdownPercent ?? null,
      },
      trades: { expected: s.totalTrades, actual: p.totalTrades ?? null },
    },
    annualReturns: caseAudit.annualReturns,
    comparisons: {
      ...caseAudit.ledger.totals(),
      byCategory: caseAudit.ledger.byCategory(),
      inputs: inputLedger.totals(),
      persistenceFidelity: fidelity.totals(),
    },
    counts: caseAudit.counts,
    differences: caseAudit.ledger.differences.slice(0, 50),
    invariantViolations: caseAudit.invariantViolations.slice(0, 50),
    ledgerViolations: caseAudit.ledgerViolations.slice(0, 50),
    finalLiquidation: caseAudit.liquidation,
    trades:
      tradeRows.length <= TRADE_LIMIT
        ? tradeRows
        : [
            ...tradeRows.slice(0, TRADE_LIMIT / 2),
            ...tradeRows.slice(-TRADE_LIMIT / 2),
            ...tradeRows
              .slice(TRADE_LIMIT / 2, -TRADE_LIMIT / 2)
              .filter((row) => !row.match),
          ],
    tradesTruncated:
      tradeRows.length > TRADE_LIMIT
        ? `${tradeRows.length} trades; first and last ${TRADE_LIMIT / 2} shown plus every mismatch — all ${tradeRows.length} were compared`
        : null,
    equityYearEnds: yearEnds.map((row) => ({
      date: row.date,
      expected: {
        cash: row.cash,
        positionsValue: row.positionsValue,
        totalValue: row.totalValue,
        returnIndex: row.returnIndex,
        benchmarkValue: row.benchmarkValue,
      },
      actual: persistedByDate.get(row.date) ?? null,
    })),
  };
}
