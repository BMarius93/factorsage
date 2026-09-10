import { qaMatrixFixtures } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  qaMatrixCases,
  qaMatrixGoldenCases,
  QA_MATRIX_TOTAL_CASES,
} from "./matrix-case";
import { planMatrixArchives } from "./matrix-archive-plan";
import {
  evaluateMatrixGate,
  type MatrixPhaseProviderTraffic,
} from "./matrix-gate";
import { aggregateMatrixResults, type MatrixCaseResult } from "./matrix-runner";
import {
  runMatrixSweep,
  type MatrixSweepPool,
  type MatrixSweepPorts,
} from "./matrix-sweep";

/**
 * Provider traffic is observed asynchronously, so it may only become visible while the pool is
 * shutting down.
 *
 * A run reaches `COMPLETED` in PostgreSQL before the parent process has necessarily consumed the
 * worker's last structured log lines — the two travel by different routes. So a sweep that samples
 * the ledger *before* stopping the pool can record zero, consume the provider event a moment
 * later, and hand the gate the earlier zero. The measurement that makes the whole matrix
 * trustworthy — "this sweep reached FMP zero times" — is then a statement about when the sample
 * was taken rather than about what happened.
 *
 * Each pool below makes exactly one provider request visible during `stop()`, which is the
 * narrowest possible version of that race.
 */

const FIXTURES = qaMatrixFixtures("2026-09-09");
const CASES = qaMatrixCases(FIXTURES);
const GOLDEN = qaMatrixGoldenCases(CASES);
const SELECTED = CASES.slice(0, 4);

function completed(
  matrixCase: (typeof CASES)[number],
  overrides: Partial<MatrixCaseResult> = {},
): MatrixCaseResult {
  return {
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
    runId: `run-${matrixCase.caseId}`,
    outcome: "COMPLETED",
    runStatus: "COMPLETED",
    durationMs: 1_000,
    submittedAt: "2026-09-09T00:00:00.000Z",
    tradeCount: 5,
    equityRowCount: 100,
    finalValue: 1_000,
    invariantsPassed: 38,
    invariantsFailed: 0,
    invariantsIndeterminate: 0,
    invariantsNeedingArchive: 2,
    // Sampled when the case settled, which is earlier still. Deliberately zero: the point is that
    // the sweep must not trust it.
    providerRequests: 0,
    failure: null,
    failedInvariants: [],
    ...overrides,
  };
}

/**
 * A pool whose ledger only reveals its request while it is being stopped.
 *
 * `lateRequestFor` is the run the request belongs to, so the rebuilt attribution has something
 * real to find.
 */
function latePool(lateRequestFor: string | null): MatrixSweepPool & {
  observedAfterStop: () => number;
} {
  const byRunId = new Map<string, number>();
  let unattributed = 0;
  let drained = false;
  return {
    providerRequests: () => ({
      byRunId: new Map(byRunId),
      unattributed,
      total: unattributed + [...byRunId.values()].reduce((a, b) => a + b, 0),
    }),
    providerRequestsFor: (runId) => (drained ? (byRunId.get(runId) ?? 0) : 0),
    stop: async () => {
      // The line arrives from the worker's stdout as the pipe drains.
      if (lateRequestFor === null) {
        unattributed += 1;
      } else {
        byRunId.set(lateRequestFor, (byRunId.get(lateRequestFor) ?? 0) + 1);
      }
      drained = true;
    },
    observedAfterStop: () =>
      unattributed + [...byRunId.values()].reduce((a, b) => a + b, 0),
  };
}

const quiet = (
  phase: MatrixPhaseProviderTraffic["phase"],
): MatrixPhaseProviderTraffic => ({
  phase,
  total: 0,
  unattributed: 0,
  attributedToCases: 0,
});

const PLAN = planMatrixArchives({
  archiveRequested: false,
  selectedCases: SELECTED.length,
  goldenCases: GOLDEN.length,
  determinismEnabled: false,
});

describe("provider traffic that only becomes visible during shutdown", () => {
  it("is recorded by the main phase, not lost to the earlier sample", async () => {
    const pool = latePool(`run-${SELECTED[0]!.caseId}`);
    const ports: MatrixSweepPorts = {
      startPool: () => pool,
      runMain: async () => SELECTED.map((entry) => completed(entry)),
      rerunnable: () => [],
      runRerun: async () => [],
    };

    const sweep = await runMatrixSweep({
      selected: SELECTED,
      plan: PLAN,
      determinismEnabled: false,
      now: () => 0,
      ports,
    });

    expect(pool.observedAfterStop()).toBe(1);
    expect(sweep.mainTraffic.total).toBe(1);
    expect(sweep.mainTraffic.attributedToCases).toBe(1);
  });

  it("is recorded by the rerun phase too", async () => {
    const main = latePool(null);
    const rerun = latePool(`run-${GOLDEN[0]!.caseId}`);
    let started = 0;
    const ports: MatrixSweepPorts = {
      startPool: ({ phase }) => {
        started += 1;
        return phase === "main" ? main : rerun;
      },
      runMain: async () => SELECTED.map((entry) => completed(entry)),
      rerunnable: () => GOLDEN.slice(0, 1),
      runRerun: async (_pool, cases) => cases.map((entry) => completed(entry)),
    };

    const sweep = await runMatrixSweep({
      selected: SELECTED,
      plan: planMatrixArchives({
        archiveRequested: false,
        selectedCases: SELECTED.length,
        goldenCases: GOLDEN.length,
        determinismEnabled: true,
      }),
      determinismEnabled: true,
      now: () => 0,
      ports,
    });

    expect(started).toBe(2);
    expect(sweep.rerunTraffic.total).toBe(1);
    expect(sweep.rerunTraffic.attributedToCases).toBe(1);
  });

  it("makes the gate NOT GREEN", async () => {
    const pool = latePool(`run-${SELECTED[0]!.caseId}`);
    const sweep = await runMatrixSweep({
      selected: SELECTED,
      plan: PLAN,
      determinismEnabled: false,
      now: () => 0,
      ports: {
        startPool: () => pool,
        runMain: async () => SELECTED.map((entry) => completed(entry)),
        rerunnable: () => [],
        runRerun: async () => [],
      },
    });

    const verdict = evaluateMatrixGate({
      selectedCaseIds: SELECTED.map((entry) => entry.caseId),
      results: sweep.results,
      aggregate: aggregateMatrixResults(sweep.results, SELECTED.length, 1_000),
      provider: {
        warmup: quiet("warmup"),
        main: sweep.mainTraffic,
        rerun: sweep.rerunTraffic,
      },
      determinismRequested: false,
      requiredRerunCaseIds: [],
      rerunResults: [],
      determinismDifferences: [],
      archives: null,
    });

    expect(verdict.green).toBe(false);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.providerRequestsTotal).toBe(1);
    expect(verdict.failures.map((f) => f.code)).toContain("PROVIDER_REQUESTS");
  });
});

describe("attribution is rebuilt from the drained ledger", () => {
  it("ignores the per-result counters sampled before the stream drained", async () => {
    // Every result says zero — they were sampled when the case settled. The ledger, drained, says
    // two. The phase must report what the ledger knows.
    const pool = latePool(`run-${SELECTED[0]!.caseId}`);
    await pool.stop();
    const ports: MatrixSweepPorts = {
      startPool: () => pool,
      runMain: async () => SELECTED.map((entry) => completed(entry)),
      rerunnable: () => [],
      runRerun: async () => [],
    };
    const sweep = await runMatrixSweep({
      selected: SELECTED,
      plan: PLAN,
      determinismEnabled: false,
      now: () => 0,
      ports,
    });
    expect(sweep.results.every((r) => r.providerRequests === 0)).toBe(true);
    expect(sweep.mainTraffic.total).toBe(2);
    expect(sweep.mainTraffic.attributedToCases).toBe(2);
  });

  it("leaves a request attributed to a foreign run unaccounted for, which the gate rejects", async () => {
    const pool = latePool("run-belonging-to-another-pool");
    const sweep = await runMatrixSweep({
      selected: SELECTED,
      plan: PLAN,
      determinismEnabled: false,
      now: () => 0,
      ports: {
        startPool: () => pool,
        runMain: async () => SELECTED.map((entry) => completed(entry)),
        rerunnable: () => [],
        runRerun: async () => [],
      },
    });

    expect(sweep.mainTraffic.total).toBe(1);
    expect(sweep.mainTraffic.unattributed).toBe(0);
    // Attributed to a run this phase does not own, so the ledger does not add up.
    expect(sweep.mainTraffic.attributedToCases).toBe(0);

    const verdict = evaluateMatrixGate({
      selectedCaseIds: SELECTED.map((entry) => entry.caseId),
      results: sweep.results,
      aggregate: aggregateMatrixResults(sweep.results, SELECTED.length, 1_000),
      provider: {
        warmup: quiet("warmup"),
        main: sweep.mainTraffic,
        rerun: sweep.rerunTraffic,
      },
      determinismRequested: false,
      requiredRerunCaseIds: [],
      rerunResults: [],
      determinismDifferences: [],
      archives: null,
    });
    expect(verdict.failures.map((f) => f.code)).toContain(
      "PROVIDER_ACCOUNTING",
    );
  });
});

/**
 * A refused plan never reaches a pool.
 *
 * The CLI refuses the combination before cleanup, before any pool starts and before a single case
 * is submitted — but the sweep refuses it again here, because "the caller checked" is the kind of
 * guarantee that survives exactly until someone adds a second caller. A plan that cannot produce
 * the archives the user asked for must not quietly execute a thousand backtests and then report a
 * green sweep with none.
 */
describe("a plan that cannot honour --archive", () => {
  const refused = planMatrixArchives({
    archiveRequested: true,
    selectedCases: QA_MATRIX_TOTAL_CASES,
    goldenCases: GOLDEN.length,
    determinismEnabled: false,
  });

  it("is refused by the planner", () => {
    expect(refused.refusal).toBeTruthy();
  });

  it("starts no pool and submits no case", async () => {
    const events: string[] = [];
    const ports: MatrixSweepPorts = {
      startPool: () => {
        events.push("startPool");
        throw new Error("no pool may be started for a refused plan");
      },
      runMain: async () => {
        events.push("runMain");
        return [];
      },
      rerunnable: () => [],
      runRerun: async () => [],
    };

    await expect(
      runMatrixSweep({
        selected: CASES,
        plan: refused,
        determinismEnabled: false,
        now: () => 0,
        ports,
      }),
    ).rejects.toThrow(/--golden --archive/);
    expect(events).toEqual([]);
  });

  it("lets an acceptable plan through", async () => {
    const events: string[] = [];
    const pool = latePool(null);
    await runMatrixSweep({
      selected: SELECTED,
      plan: planMatrixArchives({
        archiveRequested: true,
        selectedCases: SELECTED.length,
        goldenCases: GOLDEN.length,
        determinismEnabled: false,
      }),
      determinismEnabled: false,
      now: () => 0,
      ports: {
        startPool: () => {
          events.push("startPool");
          return pool;
        },
        runMain: async () => {
          events.push("runMain");
          return SELECTED.map((entry) => completed(entry));
        },
        rerunnable: () => [],
        runRerun: async () => [],
      },
    });
    expect(events).toEqual(["startPool", "runMain"]);
  });
});
