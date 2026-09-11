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
  /** The run completed, but persisted evidence could not decide at least one invariant. */
  | "INVARIANT_INDETERMINATE"
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
  readonly invariantsIndeterminate: number;
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
  collectEvidence(
    runId: string,
    matrixCase: QaMatrixCase,
  ): Promise<RunEvidence>;
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
    invariantsIndeterminate: 0,
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
      invariantsIndeterminate: 0,
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
    // An invariant the persisted evidence could not settle is an open question about a financial
    // result, and a case carrying one has not been validated. It used to settle as COMPLETED.
    const undecided = invariants.filter(
      (entry) => entry.status === "INDETERMINATE",
    );

    const outcome: CaseOutcome =
      terminal.status === "COMPLETED"
        ? failed.length > 0
          ? "INVARIANT_FAILED"
          : undecided.length > 0
            ? "INVARIANT_INDETERMINATE"
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
        evidence.summary === null ? null : Number(evidence.summary.finalValue),
      invariantsPassed: counts.passed,
      invariantsFailed: counts.failed,
      invariantsIndeterminate: counts.indeterminate,
      invariantsNeedingArchive: counts.needsArchive,
      providerRequests: ports.providerRequestsFor(runId),
      failure:
        terminal.failure ??
        (failed.length > 0
          ? `${failed.length} invariant(s) failed: ${failed
              .map((entry) => `#${entry.id} ${entry.key}`)
              .join(", ")}`
          : undecided.length > 0
            ? `${undecided.length} invariant(s) undecided: ${undecided
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
      invariantsIndeterminate: 0,
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

  return results.filter(
    (entry): entry is MatrixCaseResult => entry !== undefined,
  );
}

export type MatrixAggregate = {
  readonly expected: number;
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly invariantFailures: number;
  readonly invariantIndeterminates: number;
  readonly runnerErrors: number;
  readonly durationMs: number;
  readonly throughputPerMinute: number;
  readonly slowestCases: readonly { caseId: string; durationMs: number }[];
  readonly zeroTradeCases: readonly string[];
  readonly highestTradeCases: readonly { caseId: string; trades: number }[];
  readonly providerRequests: number;
  readonly providerRequestsByCase: readonly {
    caseId: string;
    requests: number;
  }[];
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
  const invariantIndeterminates = results.filter(
    (r) => r.outcome === "INVARIANT_INDETERMINATE",
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
    invariantIndeterminates: invariantIndeterminates.length,
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
 * Proves at compile time that a field list names every key of a type.
 *
 * The determinism comparison exists to say "these two executions are identical", and that is only
 * true of the fields it actually reads. The one this replaced read thirteen of a trade's fifteen
 * columns, seven of an equity row's ten and six of a position's twelve — and nothing anywhere said
 * so. Adding a column to a result table is now a compile error until it is named here.
 */
function everyFieldOf<T>() {
  return <K extends readonly (keyof T)[]>(
    keys: K &
      ([Exclude<keyof T, K[number]>] extends [never]
        ? unknown
        : {
            readonly __missingFields: Exclude<keyof T, K[number]>;
          }),
  ): readonly (keyof T)[] => keys as readonly (keyof T)[];
}

const TRADE_FIELDS = everyFieldOf<RunEvidence["trades"][number]>()([
  "sequence",
  "date",
  "securityId",
  "symbol",
  "name",
  "action",
  "levelId",
  "levelPercentage",
  "shares",
  "price",
  "amount",
  "fees",
  "realizedPnl",
  "realizedPnlPercent",
  "cashAfter",
  "sharesAfter",
  "averageCostAfter",
] as const);

const EQUITY_FIELDS = everyFieldOf<RunEvidence["equity"][number]>()([
  "date",
  "cash",
  "positionsValue",
  "totalValue",
  "investedCapital",
  "returnIndex",
  "benchmarkIndex",
  "benchmarkValue",
  "cashBaselineValue",
  "openPositions",
] as const);

const POSITION_FIELDS = everyFieldOf<RunEvidence["positions"][number]>()([
  "securityId",
  "symbol",
  "name",
  "openedDate",
  "shares",
  "averageCost",
  "lastPrice",
  "lastPriceDate",
  "marketValue",
  "unrealizedPnl",
  "unrealizedPnlPercent",
  "allocationPercent",
] as const);

const SUMMARY_FIELDS = everyFieldOf<NonNullable<RunEvidence["summary"]>>()([
  "firstSimulatedDate",
  "lastSimulatedDate",
  "tradingDays",
  "investedCapital",
  "finalCash",
  "finalPositionsValue",
  "finalValue",
  "netProfit",
  "portfolioReturnPercent",
  "benchmarkReturnPercent",
  "alphaPercent",
  "portfolioCagrPercent",
  "maxDrawdownPercent",
  "benchmarkMaxDrawdownPercent",
  "realizedPnl",
  "unrealizedPnl",
  "totalTrades",
  "buyTrades",
  "sellTrades",
  "finalExitTrades",
  "winningTrades",
  "losingTrades",
  "openPositions",
] as const);

/**
 * The run-level facts two executions of the same case must agree about.
 *
 * Deliberately not every key of `RunEvidence`: `runId` and `caseId` are operational identity,
 * `failureMessage` can carry a run id or a timestamp, and the snapshot, calendar, benchmark bars
 * and listing dates are *inputs* rather than results — the preflight and the pinned dataset are
 * what make those the same, and re-asserting them here would report an environment change as a
 * determinism failure.
 */
const RUN_FIELDS = [
  "status",
  "failureCode",
  "failurePhase",
  "startDate",
  "endDate",
  "initialCapital",
  "monthlyContribution",
  "maximumPositions",
] as const satisfies readonly (keyof RunEvidence)[];

/** Canonical values are compared as the strings they are stored as. Never through a float. */
const show = (value: unknown): string =>
  value === null || value === undefined ? "null" : String(value);

function compareRecords<T>(
  label: string,
  fields: readonly (keyof T)[],
  first: T,
  second: T,
  differences: string[],
): void {
  for (const field of fields) {
    if (first[field] !== second[field]) {
      differences.push(
        `${label} ${String(field)}: ${show(first[field])} vs ${show(second[field])}`,
      );
    }
  }
}

/**
 * Compares two executions of the same case for determinism.
 *
 * Every persisted financial and result field in the trade log, the daily equity curve, the final
 * positions and the summary, compared as the canonical strings they are stored as. Operational
 * facts — the run id, the job, the worker that claimed it, timings — are excluded: they are
 * legitimately different every time, and a check that flagged them would be noise that trains a
 * reader to ignore it.
 *
 * Positions are matched by security rather than by list order, because the persisted rows carry no
 * ordering of their own and a reordering is not a difference in what the run computed.
 */
export function compareForDeterminism(
  first: RunEvidence,
  second: RunEvidence,
): readonly string[] {
  const differences: string[] = [];

  for (const field of RUN_FIELDS) {
    if (first[field] !== second[field]) {
      differences.push(
        `run ${field}: ${show(first[field])} vs ${show(second[field])}`,
      );
    }
  }

  if (first.trades.length !== second.trades.length) {
    differences.push(
      `trade count: ${first.trades.length} vs ${second.trades.length}`,
    );
  } else {
    for (let index = 0; index < first.trades.length; index += 1) {
      compareRecords(
        `trade #${index + 1}`,
        TRADE_FIELDS,
        first.trades[index] as RunEvidence["trades"][number],
        second.trades[index] as RunEvidence["trades"][number],
        differences,
      );
      if (differences.length > 20) {
        break;
      }
    }
  }

  if (first.equity.length !== second.equity.length) {
    differences.push(
      `equity row count: ${first.equity.length} vs ${second.equity.length}`,
    );
  } else {
    for (let index = 0; index < first.equity.length; index += 1) {
      const row = first.equity[index] as RunEvidence["equity"][number];
      compareRecords(
        `equity ${row.date}`,
        EQUITY_FIELDS,
        row,
        second.equity[index] as RunEvidence["equity"][number],
        differences,
      );
      if (differences.length > 20) {
        break;
      }
    }
  }

  const bySecurity = (
    positions: RunEvidence["positions"],
  ): ReadonlyMap<string, RunEvidence["positions"][number]> =>
    new Map(positions.map((position) => [position.securityId, position]));
  const firstPositions = bySecurity(first.positions);
  const secondPositions = bySecurity(second.positions);
  for (const [securityId, position] of firstPositions) {
    const other = secondPositions.get(securityId);
    if (!other) {
      differences.push(
        `position ${position.symbol} securityId ${securityId}: held in the first execution, absent in the second`,
      );
      continue;
    }
    compareRecords(
      `position ${position.symbol}`,
      POSITION_FIELDS,
      position,
      other,
      differences,
    );
  }
  for (const [securityId, position] of secondPositions) {
    if (!firstPositions.has(securityId)) {
      differences.push(
        `position ${position.symbol} securityId ${securityId}: held in the second execution, absent in the first`,
      );
    }
  }

  if ((first.summary === null) !== (second.summary === null)) {
    differences.push(
      `summary: ${first.summary === null ? "absent" : "present"} vs ${
        second.summary === null ? "absent" : "present"
      }`,
    );
  } else if (first.summary && second.summary) {
    compareRecords(
      "summary",
      SUMMARY_FIELDS,
      first.summary,
      second.summary,
      differences,
    );
  }

  return differences;
}
