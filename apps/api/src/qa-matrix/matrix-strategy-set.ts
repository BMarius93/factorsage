import {
  qaMatrixAuditStrategies,
  QA_MATRIX_ETF_STRATEGIES,
  QA_MATRIX_FUNDAMENTAL_STRATEGIES,
  QA_MATRIX_SECTOR_STRATEGIES,
  QA_MATRIX_STRATEGIES,
  QA_MATRIX_STRATEGY_SETS,
  type QaMatrixActorScopes,
  type QaMatrixStrategyFixture,
  type QaMatrixStrategySet,
} from "@intrinsic/testing";

/**
 * The fixtures of one strategy dimension, in one place for every command that selects one.
 *
 * The audit dimension is the only one that cannot be resolved without a database — its actor scopes
 * are canonical ids — so its scopes are passed in, and asking for it without them is an error
 * rather than an empty dimension.
 */
export function matrixStrategiesFor(
  set: QaMatrixStrategySet,
  auditScopes: QaMatrixActorScopes | null,
): readonly QaMatrixStrategyFixture[] {
  switch (set) {
    case "CORE":
      return QA_MATRIX_STRATEGIES;
    case "AUDIT":
      if (!auditScopes) {
        throw new Error(
          "The audit strategy dimension needs its actor scopes resolved against the database.",
        );
      }
      return qaMatrixAuditStrategies(auditScopes);
    case "FUNDAMENTALS":
      return QA_MATRIX_FUNDAMENTAL_STRATEGIES;
    case "ETF":
      return QA_MATRIX_ETF_STRATEGIES;
    case "SECTOR":
      return QA_MATRIX_SECTOR_STRATEGIES;
  }
}

/** `--strategies <name>`, case-insensitive, refusing anything that is not a dimension. */
export function parseMatrixStrategySet(raw: string): QaMatrixStrategySet {
  const value = raw.trim().toUpperCase();
  if (!(QA_MATRIX_STRATEGY_SETS as readonly string[]).includes(value)) {
    throw new Error(
      `\`--strategies\` must be one of ${QA_MATRIX_STRATEGY_SETS.join(", ").toLowerCase()}; received \`${raw.trim().toLowerCase()}\``,
    );
  }
  return value as QaMatrixStrategySet;
}
