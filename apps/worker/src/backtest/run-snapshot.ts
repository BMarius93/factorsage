import {
  BACKTEST_SNAPSHOT_VERSION,
  CONDITION_OPERATORS,
  TRIGGER_OPERATORS,
  withExecutableStrategyDefinition,
  type BacktestRunSnapshot,
  type BacktestSnapshotSecurity,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { BuyWindowConfiguration } from "@intrinsic/domain";

/** A stored submission snapshot the worker cannot execute. */
export class BacktestSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestSnapshotError";
  }
}

/**
 * Reads the immutable submission document a claimed run carries, and returns the form the engine
 * executes.
 *
 * The API validated this document when it wrote it, so this is not a second validation layer: it
 * is the process boundary refusing to execute something it cannot interpret — a snapshot written
 * by an older version of the product, or a hand-edited row — rather than crashing halfway through
 * a run with an undefined property.
 *
 * It is also the **one** place a snapshot's frozen strategy definition is brought up to the
 * current document schema. A run queued before a release, or recovered or retried after one, still
 * carries the schema that was current at submission: a run submitted before FINAL EXIT gained Exit
 * Rules holds `schemaVersion: 1` with a flat `finalExit.signal`, which the current engine cannot
 * read. Upgrading here rather than at each consumer is what makes every downstream read correct by
 * construction — including consumers added later, which is exactly how this defect arose.
 *
 * The stored row is never touched: `withExecutableStrategyDefinition` returns a new document and
 * nothing writes the result back. `BacktestRun.snapshot` remains byte-for-byte what was submitted,
 * which is what `AGENTS.md` invariant 12 requires of the reproducibility authority.
 *
 * It stays a document *upcast* and not a revalidation. This function's contract is unchanged: the
 * API validated the definition when it wrote it, and re-validating here would let a snapshot the
 * worker has always executed start being refused because a later release tightened a rule — the
 * retroactive reinterpretation invariant 12 exists to prevent. The one thing it reads in a rule is
 * whether the engine still defines its operator (`refuseUndefinedOperators`), because a snapshot
 * whose meaning the engine no longer has cannot be executed faithfully under any reading.
 */
export function parseRunSnapshot(value: unknown): BacktestRunSnapshot {
  const document = record(value, "snapshot");

  if (document.snapshotVersion !== BACKTEST_SNAPSHOT_VERSION) {
    throw new BacktestSnapshotError(
      `Unsupported backtest snapshot version ${String(document.snapshotVersion)}`,
    );
  }

  const strategy = record(document.strategy, "snapshot.strategy");
  record(strategy.definition, "snapshot.strategy.definition");

  const period = record(document.period, "snapshot.period");
  localDate(period.startDate, "snapshot.period.startDate");
  localDate(period.endDate, "snapshot.period.endDate");

  const capital = record(document.capital, "snapshot.capital");
  finiteNumber(capital.initialCapital, "snapshot.capital.initialCapital");
  finiteNumber(
    capital.monthlyContribution,
    "snapshot.capital.monthlyContribution",
  );

  const allocation = record(document.allocation, "snapshot.allocation");
  finiteNumber(
    allocation.maximumPositions,
    "snapshot.allocation.maximumPositions",
  );

  const benchmark = record(document.benchmark, "snapshot.benchmark");
  nonEmptyString(benchmark.code, "snapshot.benchmark.code");
  nonEmptyString(benchmark.seriesId, "snapshot.benchmark.seriesId");

  // Required, and checked here rather than discovered halfway through preparation: the calendar
  // decides which dates are simulated, so a snapshot without it cannot be executed under the
  // methodology it records. Failing at the parse is what makes that a deterministic refusal
  // instead of a silently different run.
  const executionCalendar = record(
    document.executionCalendar,
    "snapshot.executionCalendar",
  );
  nonEmptyString(
    executionCalendar.seriesId,
    "snapshot.executionCalendar.seriesId",
  );

  if (!Array.isArray(document.securities) || document.securities.length === 0) {
    throw new BacktestSnapshotError("snapshot.securities is empty");
  }
  document.securities.forEach((security, index) => {
    const entry = record(security, `snapshot.securities[${index}]`);
    nonEmptyString(
      entry.securityId,
      `snapshot.securities[${index}].securityId`,
    );
    nonEmptyString(entry.symbol, `snapshot.securities[${index}].symbol`);
    if (entry.buyWindowMode !== "FULL" && entry.buyWindowMode !== "CUSTOM") {
      throw new BacktestSnapshotError(
        `snapshot.securities[${index}].buyWindowMode is not a buy-window mode`,
      );
    }
    if (!Array.isArray(entry.buyWindows)) {
      throw new BacktestSnapshotError(
        `snapshot.securities[${index}].buyWindows is not a list`,
      );
    }
  });

  // The returned snapshot is a copy whenever the upcast changed anything: `value` — the document
  // the claim carried, and the shape of the persisted row — is never written through.
  const executable = withExecutableStrategyDefinition(
    value as BacktestRunSnapshot,
  );
  refuseUndefinedOperators(executable.strategy.definition);
  return executable;
}

/**
 * Refuses a definition naming an operator this engine does not define.
 *
 * The same kind of refusal as an unknown snapshot version, not a product rule judged again: the
 * product removed `is at least` / `is at most` on 2026-09-28, and `>= 2` is not `> 2`, so a snapshot
 * still naming one has no meaning the engine may assume and is never mapped onto a neighbour. The
 * evaluator would refuse it too, but only once it reached the rule; here the run stops before any
 * data is prepared, whatever that data would have been.
 */
function refuseUndefinedOperators(definition: StrategyDefinition): void {
  const signals: [string, StrategySignal][] = [
    ...definition.buyLevels.map((level, index): [string, StrategySignal] => [
      `buyLevels[${index}]`,
      level.signal,
    ]),
    ...definition.sellLevels.map((level, index): [string, StrategySignal] => [
      `sellLevels[${index}]`,
      level.signal,
    ]),
    ...(definition.finalExit?.rules ?? []).map(
      (rule, index): [string, StrategySignal] => [
        `finalExit.rules[${index}]`,
        rule.signal,
      ],
    ),
  ];
  for (const [at, signal] of signals) {
    signal.conditions.forEach((condition, index) =>
      refuseUndefinedOperator(
        CONDITION_OPERATORS,
        condition.operator,
        `${at}.signal.conditions[${index}]`,
      ),
    );
    if (signal.trigger) {
      refuseUndefinedOperator(
        TRIGGER_OPERATORS,
        signal.trigger.operator,
        `${at}.signal.trigger`,
      );
    }
  }
}

function refuseUndefinedOperator(
  defined: readonly string[],
  operator: string,
  at: string,
): void {
  if (!defined.includes(operator)) {
    throw new BacktestSnapshotError(
      `snapshot.strategy.definition.${at}.operator ${operator} is not an operator this engine defines`,
    );
  }
}

/**
 * The stored document, typed but **not** upgraded — what forensics keep.
 *
 * `parseRunSnapshot` returns the executable projection, which is what the engine consumes. The
 * debug archive wants the opposite: the submission document exactly as stored, because that is the
 * reproducibility authority a reviewer re-runs from. The upcast is deterministic, so the executed
 * form is always derivable from the stored one; the reverse is not true.
 *
 * A cast rather than a copy: `parseRunSnapshot` has already proven this document's structure, and
 * this exists to make the stored-versus-executable distinction visible at the call site rather than
 * leaving it an anonymous `as`.
 */
export function storedRunSnapshot(value: unknown): BacktestRunSnapshot {
  return value as BacktestRunSnapshot;
}

/**
 * The frozen buy eligibility of one list member.
 *
 * Read from the snapshot rather than from `StockListBuyWindow`: editing the list after submission
 * must never change what a running or completed backtest was allowed to buy.
 */
export function snapshotBuyWindows(
  security: BacktestSnapshotSecurity,
): BuyWindowConfiguration {
  return {
    mode: security.buyWindowMode,
    ranges: security.buyWindows.map((range) => ({
      startDate: range.startDate,
      endDate: range.endDate,
    })),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BacktestSnapshotError(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BacktestSnapshotError(`${path} is missing`);
  }
}

function finiteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BacktestSnapshotError(`${path} is not a number`);
  }
}

function localDate(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BacktestSnapshotError(`${path} is not a calendar date`);
  }
}
