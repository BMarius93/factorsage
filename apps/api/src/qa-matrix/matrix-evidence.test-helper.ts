import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import type { RunEvidence } from "./matrix-invariants";

/**
 * A minimal, valid `RunEvidence` the invariant and runner suites build on.
 *
 * Every field is present and internally consistent, so a test states only the one thing it is
 * about. A helper that produced a subtly broken baseline would make every suite that used it prove
 * the helper rather than the subject.
 */
export function emptyEvidence(
  overrides: Partial<RunEvidence> & { runId: string; caseId: string },
): RunEvidence {
  const snapshot = {
    securities: [],
    strategy: { definition: { buyLevels: [], sellLevels: [] } },
  } as unknown as BacktestRunSnapshot;
  return {
    status: "COMPLETED",
    failureCode: null,
    failureMessage: null,
    failurePhase: null,
    snapshot,
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    initialCapital: 100,
    monthlyContribution: 0,
    maximumPositions: 10,
    summary: null,
    equity: [],
    trades: [],
    positions: [],
    executionCalendarDates: [],
    benchmarkCloses: [],
    firstPriceDateBySecurityId: new Map(),
    ...overrides,
  };
}
