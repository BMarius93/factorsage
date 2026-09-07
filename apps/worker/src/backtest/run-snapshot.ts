import {
  BACKTEST_SNAPSHOT_VERSION,
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
 * Reads the immutable submission document a claimed run carries.
 *
 * The API validated this document when it wrote it, so this is not a second validation layer: it
 * is the process boundary refusing to execute something it cannot interpret — a snapshot written
 * by an older version of the product, or a hand-edited row — rather than crashing halfway through
 * a run with an undefined property.
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
