import {
  BACKTEST_SNAPSHOT_VERSION,
  withExecutableStrategyDefinition,
  type BacktestRunSnapshot,
  type BacktestSnapshotSecurity,
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
 * retroactive reinterpretation invariant 12 exists to prevent.
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
  return withExecutableStrategyDefinition(value as BacktestRunSnapshot);
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
