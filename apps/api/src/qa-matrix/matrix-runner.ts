import {
  summarizeInvariants,
  type InvariantResult,
  type RunEvidence,
} from "./matrix-invariants";
import type { QaMatrixCase } from "./matrix-case";

/**
 * Orchestration for the matrix sweep.
 *
 * Deliberately free of Prisma, Nest, child processes and the filesystem: those are the four things
 * that make a runner impossible to test, and every one of them is behind a port here. What remains
 * is the part with the rules — bounded concurrency, canonical ordering, continuing past a failure,
 * and the shape of a case result — which is exactly the part worth testing without executing a
 * thousand backtests.
 *
 * **Bounded concurrency is not a throttle on submission alone.** Creating a thousand `QUEUED` rows
 * and letting the workers drain them would be cheap for the database and wrong for everything else:
 * a crash halfway would leave 600 orphaned jobs, and a run's `PREPARING_DATA` phase would compete
 * with 999 others for the shared FMP gate. The pipeline instead keeps at most `concurrency` cases
 * in flight at once — submitted, executing and validated — so the queue depth never exceeds what
 * the workers can actually be executing.
 */

export type CaseOutcome =
  | "COMPLETED"
  | "FAILED"
  | "INVARIANT_FAILED"
  | "SUBMIT_FAILED"
  | "TIMED_OUT"
  | "RUNNER_ERROR";

export type MatrixCaseResult = {
  readonly caseId: string;
  readonly label: string;
  readonly index: number;
  readonly strategyId: string;
  readonly strategyName: string;
  readonly listId: string;
  readonly listName: string;
  readonly configId: string;
  readonly configName: string;
  readonly config: {
    readonly startDate: string;
    readonly endDate: string;
    readonly initialCapital: number;
    readonly monthlyContribution: number;
    readonly maximumPositions: number;
    readonly benchmarkCode: string;
  };
  readonly runId: string | null;
  readonly outcome: CaseOutcome;
  readonly runStatus: string | null;
  readonly durationMs: number;
  readonly submittedAt: string;
  readonly tradeCount: number | null;
  readonly equityRowCount: number | null;
  readonly finalValue: number | null;
  readonly invariantsPassed: number;
  readonly invariantsFailed: number;
  readonly invariantsNeedingArchive: number;
  readonly providerRequests: number | null;
  readonly failure: string | null;
  readonly failedInvariants: readonly InvariantResult[];
};

/**
 * Everything the orchestration needs from the world, and nothing more.
 *
 * `submit` creates a real durable run through the application's own submission path; `awaitTerminal`
 * polls the persisted run until it reaches a terminal status; `collectEvidence` reads the persisted
 * result back. None of the three may shortcut the product's lifecycle — the runner's value is
 * entirely that it does not.
 */
export type MatrixRunnerPorts = {
  submit(matrixCase: QaMatrixCase): Promise<string>;
  awaitTerminal(
    runId: string,
    matrixCase: QaMatrixCase,
  ): Promise<{ status: string; failure: string | null }>;
  collectEvidence(runId: string, matrixCase: QaMatrixCase): Promise<RunEvidence>;
  validate(evidence: RunEvidence): readonly InvariantResult[];
  providerRequestsFor(runId: string): number | null;
  /** Called as each case settles, so a long sweep is inspectable while it runs. */
  onCaseSettled?(result: MatrixCaseResult): Promise<void> | void;
  now(): number;
};

export type MatrixRunnerOptions = {
  /** Runs in flight at once. Matches the worker process count; never a second throttle. */
  readonly concurrency: number;
};

export class MatrixConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixConcurrencyError";
  }
}

function failureText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Executes one case end to end and never throws.
 *
 * A sweep that stopped at the first failure would be a worse instrument than one that ran to
 * completion: the point of a thousand combinations is the distribution of failures, and the first
 * one is rarely the most informative. Every failure mode therefore becomes a recorded outcome —
 * including an error inside the runner itself, which is reported as `RUNNER_ERROR` so it can never
 * be mistaken for an engine defect.
 */
export async function executeMatrixCase(
  matrixCase: QaMatrixCase,
  ports: MatrixRunnerPorts,
): Promise<MatrixCaseResult> {
  const startedAt = ports.now();
  const submittedAt = new Date().toISOString();
  const base = {
    caseId: matrixCase.caseId,
    label: matrixCase.label,
    index: matrixCase.index,
    strategyId: matrixCase.strategyId,
    strategyName: matrixCase.combination.strategy.name,
    listId: matrixCase.listId,
    listName: matrixCase.combination.list.name,
    configId: matrixCase.configId,
    configName: matrixCase.combination.config.name,
    config: matrixCase.combination.config.request,
    submittedAt,
    invariantsNeedingArchive: 0,
    failedInvariants: [] as readonly InvariantResult[],
  };

  let runId: string | null = null;
  try {
    runId = await ports.submit(matrixCase);
  } catch (error) {
    return {
      ...base,
      runId: null,
      outcome: "SUBMIT_FAILED",
      runStatus: null,
      durationMs: ports.now() - startedAt,
      tradeCount: null,
      equityRowCount: null,
      finalValue: null,
      invariantsPassed: 0,
      invariantsFailed: 0,
      providerRequests: null,
      failure: failureText(error),
    };
  }

  try {
    const terminal = await ports.awaitTerminal(runId, matrixCase);
    const evidence = await ports.collectEvidence(runId, matrixCase);
    const invariants = ports.validate(evidence);
    const counts = summarizeInvariants(invariants);
    const failed = invariants.filter((entry) => entry.status === "FAIL");

    const outcome: CaseOutcome =
      terminal.status === "COMPLETED"
        ? failed.length > 0
          ? "INVARIANT_FAILED"
          : "COMPLETED"
        : terminal.status === "TIMED_OUT"
          ? "TIMED_OUT"
          : "FAILED";

    return {
      ...base,
      runId,
      outcome,
      runStatus: terminal.status,
      durationMs: ports.now() - startedAt,
      tradeCount: evidence.trades.length,
      equityRowCount: evidence.equity.length,
      finalValue:
        evidence.summary === null
          ? null
          : Number(evidence.summary.finalValue),
      invariantsPassed: counts.passed,
      invariantsFailed: counts.failed,
      invariantsNeedingArchive: counts.needsArchive,
      providerRequests: ports.providerRequestsFor(runId),
      failure:
        terminal.failure ??
        (failed.length > 0
          ? `${failed.length} invariant(s) failed: ${failed
              .map((entry) => `#${entry.id} ${entry.key}`)
              .join(", ")}`
          : null),
      failedInvariants: failed,
    };
  } catch (error) {
    return {
      ...base,
      runId,
      outcome: "RUNNER_ERROR",
      runStatus: null,
      durationMs: ports.now() - startedAt,
      tradeCount: null,
      equityRowCount: null,
      finalValue: null,
      invariantsPassed: 0,
      invariantsFailed: 0,
      providerRequests: ports.providerRequestsFor(runId),
      failure: failureText(error),
    };
  }
}

/**
 * Runs the selected cases with at most `concurrency` in flight, preserving canonical order.
 *
 * Results are returned in enumeration order regardless of the order they finished in, so two sweeps
 * of the same matrix produce comparable files even though a thirty-year case and a one-year case
 * plainly do not finish in the order they started.
 */
export async function runMatrixCases(
  cases: readonly QaMatrixCase[],
  ports: MatrixRunnerPorts,
  options: MatrixRunnerOptions,
): Promise<readonly MatrixCaseResult[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new MatrixConcurrencyError(
      `Concurrency must be a positive integer; received \`${options.concurrency}\`.`,
    );
  }

  const results = new Array<MatrixCaseResult | undefined>(cases.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= cases.length) {
        return;
      }
      const matrixCase = cases[index] as QaMatrixCase;
      const result = await executeMatrixCase(matrixCase, ports);
      results[index] = result;
      await ports.onCaseSettled?.(result);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, cases.length) }, worker),
  );

  return results.filter((entry): entry is MatrixCaseResult => entry !== undefined);
}

export type MatrixAggregate = {
  readonly expected: number;
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly invariantFailures: number;
  readonly runnerErrors: number;
  readonly durationMs: number;
  readonly throughputPerMinute: number;
  readonly slowestCases: readonly { caseId: string; durationMs: number }[];
  readonly zeroTradeCases: readonly string[];
  readonly highestTradeCases: readonly { caseId: string; trades: number }[];
  readonly providerRequests: number;
  readonly providerRequestsByCase: readonly { caseId: string; requests: number }[];
  readonly totalTrades: number;
  readonly totalEquityRows: number;
};

/**
 * The aggregate a reviewer reads first.
 *
 * A strategy producing zero trades is **not** a failure — `S06` is deliberately sparse and `C03` is
 * deliberately short — so zero-trade cases are counted and listed rather than flagged. What is a
 * failure is a run that did not complete, or one whose numbers do not reconcile.
 */
export function aggregateMatrixResults(
  results: readonly MatrixCaseResult[],
  expected: number,
  durationMs: number,
): MatrixAggregate {
  const completed = results.filter((r) => r.outcome === "COMPLETED");
  const invariantFailures = results.filter(
    (r) => r.outcome === "INVARIANT_FAILED",
  );
  const failed = results.filter(
    (r) =>
      r.outcome === "FAILED" ||
      r.outcome === "SUBMIT_FAILED" ||
      r.outcome === "TIMED_OUT",
  );
  const runnerErrors = results.filter((r) => r.outcome === "RUNNER_ERROR");

  const withRun = results.filter((r) => r.runId !== null);
  const bySlowest = [...results].sort((a, b) => b.durationMs - a.durationMs);
  const withTrades = results.filter((r) => r.tradeCount !== null);
  const byTrades = [...withTrades].sort(
    (a, b) => (b.tradeCount ?? 0) - (a.tradeCount ?? 0),
  );

  const providerRequests = results.reduce(
    (sum, result) => sum + (result.providerRequests ?? 0),
    0,
  );

  return {
    expected,
    submitted: withRun.length,
    completed: completed.length,
    failed: failed.length,
    invariantFailures: invariantFailures.length,
    runnerErrors: runnerErrors.length,
    durationMs,
    throughputPerMinute:
      durationMs > 0 ? (results.length / durationMs) * 60_000 : 0,
    slowestCases: bySlowest
      .slice(0, 10)
      .map((r) => ({ caseId: r.caseId, durationMs: r.durationMs })),
    zeroTradeCases: withTrades
      .filter((r) => r.tradeCount === 0)
      .map((r) => r.caseId),
    highestTradeCases: byTrades
      .slice(0, 10)
      .map((r) => ({ caseId: r.caseId, trades: r.tradeCount ?? 0 })),
    providerRequests,
    providerRequestsByCase: results
      .filter((r) => (r.providerRequests ?? 0) > 0)
      .map((r) => ({ caseId: r.caseId, requests: r.providerRequests ?? 0 })),
    totalTrades: withTrades.reduce((sum, r) => sum + (r.tradeCount ?? 0), 0),
    totalEquityRows: results.reduce(
      (sum, r) => sum + (r.equityRowCount ?? 0),
      0,
    ),
  };
}

/**
 * Compares two executions of the same case for determinism.
 *
 * Trades, the equity curve, the final positions and the summary must be identical from the same
 * canonical data. Operational facts — the run id, the worker that claimed it, timings — must not be
 * compared: they are legitimately different every time, and a determinism check that flagged them
 * would be noise that trains a reader to ignore it.
 */
export function compareForDeterminism(
  first: RunEvidence,
  second: RunEvidence,
): readonly string[] {
  const differences: string[] = [];

  if (first.trades.length !== second.trades.length) {
    differences.push(
      `trade count ${first.trades.length} vs ${second.trades.length}`,
    );
  } else {
    for (let index = 0; index < first.trades.length; index += 1) {
      const a = first.trades[index] as (typeof first.trades)[number];
      const b = second.trades[index] as (typeof second.trades)[number];
      const fields: (keyof typeof a)[] = [
        "sequence",
        "date",
        "symbol",
        "action",
        "levelId",
        "levelPercentage",
        "shares",
        "price",
        "amount",
        "realizedPnl",
        "cashAfter",
        "sharesAfter",
        "averageCostAfter",
      ];
      for (const field of fields) {
        if (a[field] !== b[field]) {
          differences.push(
            `trade #${index} ${String(field)}: ${String(a[field])} vs ${String(b[field])}`,
          );
        }
      }
      if (differences.length > 20) {
        break;
      }
    }
  }

  if (first.equity.length !== second.equity.length) {
    differences.push(
      `equity rows ${first.equity.length} vs ${second.equity.length}`,
    );
  } else {
    for (let index = 0; index < first.equity.length; index += 1) {
      const a = first.equity[index] as (typeof first.equity)[number];
      const b = second.equity[index] as (typeof second.equity)[number];
      if (
        a.date !== b.date ||
        a.cash !== b.cash ||
        a.positionsValue !== b.positionsValue ||
        a.totalValue !== b.totalValue ||
        a.cashBaselineValue !== b.cashBaselineValue ||
        a.benchmarkValue !== b.benchmarkValue ||
        a.openPositions !== b.openPositions
      ) {
        differences.push(`equity ${a.date} differs`);
        if (differences.length > 20) {
          break;
        }
      }
    }
  }

  const positionKey = (
    position: (typeof first.positions)[number],
  ): string =>
    [
      position.symbol,
      position.openedDate,
      position.shares,
      position.averageCost,
      position.marketValue,
      position.unrealizedPnl,
    ].join("|");
  const firstPositions = first.positions.map(positionKey).sort().join("\n");
  const secondPositions = second.positions.map(positionKey).sort().join("\n");
  if (firstPositions !== secondPositions) {
    differences.push("final positions differ");
  }

  if (JSON.stringify(first.summary) !== JSON.stringify(second.summary)) {
    differences.push("summary differs");
  }

  return differences;
}
