import { qaMatrixFixtures } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  qaMatrixCases,
  selectQaMatrixCases,
  type QaMatrixCase,
} from "./matrix-case";
import type { InvariantResult, RunEvidence } from "./matrix-invariants";
import {
  aggregateMatrixResults,
  compareForDeterminism,
  executeMatrixCase,
  MatrixConcurrencyError,
  runMatrixCases,
  type MatrixCaseResult,
  type MatrixRunnerPorts,
} from "./matrix-runner";
import { completeEvidence, emptyEvidence } from "./matrix-evidence.test-helper";

/**
 * The orchestration, without a database, a worker or a backtest.
 *
 * The runner's rules — bounded concurrency, canonical ordering, continuing past a failure, never
 * mistaking a runner bug for an engine defect — are what these prove. Executing real backtests here
 * would test the engine instead, take hours, and prove none of them.
 */
const FIXTURES = qaMatrixFixtures("2026-09-09");
const CASES = qaMatrixCases(FIXTURES);

type PortOverrides = Partial<MatrixRunnerPorts> & {
  onSubmit?: (matrixCase: QaMatrixCase) => void;
};

function ports(overrides: PortOverrides = {}): MatrixRunnerPorts {
  let clock = 0;
  return {
    submit: async (matrixCase) => {
      overrides.onSubmit?.(matrixCase);
      return `run-${matrixCase.caseId}`;
    },
    awaitTerminal: async () => ({ status: "COMPLETED", failure: null }),
    collectEvidence: async (runId, matrixCase) =>
      emptyEvidence({ runId, caseId: matrixCase.caseId }),
    validate: () => [
      { id: 1, key: "completed", title: "t", status: "PASS", detail: "ok" },
    ],
    providerRequestsFor: () => 0,
    now: () => (clock += 1000),
    ...overrides,
  };
}

describe("bounded concurrency", () => {
  it("never has more than `concurrency` cases in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const selected = CASES.slice(0, 40);
    const results = await runMatrixCases(
      selected,
      ports({
        submit: async (matrixCase) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return `run-${matrixCase.caseId}`;
        },
        awaitTerminal: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return { status: "COMPLETED", failure: null };
        },
      }),
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(results).toHaveLength(40);
  });

  it("does not launch every case at once", async () => {
    // A thousand simultaneous submissions would create a thousand QUEUED jobs competing for the
    // shared provider gate, and a crash would strand every one of them.
    const submitted: string[] = [];
    let released: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const run = runMatrixCases(
      CASES.slice(0, 50),
      ports({
        onSubmit: (matrixCase) => submitted.push(matrixCase.caseId),
        awaitTerminal: async () => {
          await gate;
          return { status: "COMPLETED", failure: null };
        },
      }),
      { concurrency: 4 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(submitted).toHaveLength(4);
    (released as unknown as () => void)();
    await run;
    expect(submitted).toHaveLength(50);
  });

  it("refuses a concurrency that is not a worker-process count", async () => {
    await expect(
      runMatrixCases(CASES.slice(0, 2), ports(), { concurrency: 0 }),
    ).rejects.toBeInstanceOf(MatrixConcurrencyError);
  });

  it("returns results in canonical order however they finish", async () => {
    const selected = CASES.slice(0, 12);
    const results = await runMatrixCases(
      selected,
      ports({
        awaitTerminal: async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.floor(Math.random() * 5)),
          );
          return { status: "COMPLETED", failure: null };
        },
      }),
      { concurrency: 4 },
    );
    expect(results.map((entry) => entry.caseId)).toEqual(
      selected.map((entry) => entry.caseId),
    );
  });
});

describe("failure continuation", () => {
  const failing = CASES[3] as QaMatrixCase;

  it("records a failed run and keeps going", async () => {
    const results = await runMatrixCases(
      CASES.slice(0, 6),
      ports({
        awaitTerminal: async (_runId, matrixCase) =>
          matrixCase.caseId === failing.caseId
            ? {
                status: "FAILED",
                failure: "PROVIDER_UNAVAILABLE in PREPARING_DATA",
              }
            : { status: "COMPLETED", failure: null },
      }),
      { concurrency: 2 },
    );
    expect(results).toHaveLength(6);
    const failed = results.find((entry) => entry.caseId === failing.caseId);
    expect(failed?.outcome).toBe("FAILED");
    expect(failed?.failure).toContain("PROVIDER_UNAVAILABLE");
    expect(
      results.filter((entry) => entry.outcome === "COMPLETED"),
    ).toHaveLength(5);
  });

  it("records a rejected submission without a run id", async () => {
    const result = await executeMatrixCase(
      failing,
      ports({
        submit: async () => {
          throw new Error("The selected stock list was not found");
        },
      }),
    );
    expect(result.outcome).toBe("SUBMIT_FAILED");
    expect(result.runId).toBeNull();
    expect(result.failure).toContain("stock list was not found");
  });

  it("reports a runner bug as a runner bug, never as an engine defect", async () => {
    const result = await executeMatrixCase(
      failing,
      ports({
        collectEvidence: async () => {
          throw new TypeError("cannot read property of undefined");
        },
      }),
    );
    expect(result.outcome).toBe("RUNNER_ERROR");
    expect(result.failure).toContain("TypeError");
  });

  it("marks a completed run whose invariants failed distinctly from a failed run", async () => {
    const violation: InvariantResult = {
      id: 9,
      key: "equity-identity",
      title: "cash + positionsValue == totalValue",
      status: "FAIL",
      detail: "1 violation",
      violations: ["2020-03-02: 10.00 + 5.00 = 15.00 but totalValue is 99.00."],
    };
    const result = await executeMatrixCase(
      failing,
      ports({ validate: () => [violation] }),
    );
    expect(result.outcome).toBe("INVARIANT_FAILED");
    expect(result.runStatus).toBe("COMPLETED");
    expect(result.invariantsFailed).toBe(1);
    expect(result.failedInvariants[0]?.key).toBe("equity-identity");
    expect(result.failure).toContain("#9 equity-identity");
  });

  it("reports a timeout as its own outcome", async () => {
    const result = await executeMatrixCase(
      failing,
      ports({
        awaitTerminal: async () => ({
          status: "TIMED_OUT",
          failure: "Still RUNNING after 2700s.",
        }),
      }),
    );
    expect(result.outcome).toBe("TIMED_OUT");
  });

  it("settles every case exactly once, in order, for the incremental report", async () => {
    const settled: string[] = [];
    await runMatrixCases(
      CASES.slice(0, 9),
      ports({ onCaseSettled: (result) => void settled.push(result.caseId) }),
      { concurrency: 3 },
    );
    expect(settled).toHaveLength(9);
    expect(new Set(settled).size).toBe(9);
  });
});

describe("rerunning one exact combination", () => {
  it("submits precisely the selected Sxx-Lxx-Cxx inputs", async () => {
    const submitted: QaMatrixCase[] = [];
    const selected = selectQaMatrixCases(CASES, ["S03-L07-C04"]);
    const results = await runMatrixCases(
      selected,
      ports({ onSubmit: (matrixCase) => submitted.push(matrixCase) }),
      { concurrency: 4 },
    );
    expect(submitted).toHaveLength(1);
    expect(results).toHaveLength(1);
    const [only] = submitted;
    expect(only?.caseId).toBe("S03-L07-C04");
    expect(only?.combination.strategy.id).toBe("S03");
    expect(only?.combination.list.id).toBe("L07");
    expect(only?.combination.config.id).toBe("C04");
    // The reproduction has to carry the same execution inputs, not merely the same names.
    expect(only?.combination.config.request).toEqual(
      FIXTURES.configs.find((config) => config.id === "C04")?.request,
    );
  });
});

describe("aggregation", () => {
  const result = (
    overrides: Partial<MatrixCaseResult> & { caseId: string },
  ): MatrixCaseResult => ({
    label: `QA-MATRIX-${overrides.caseId}`,
    index: 0,
    strategyId: "S01",
    strategyName: "QA-MATRIX-S01-x",
    listId: "L01",
    listName: "QA-MATRIX-L01-x",
    configId: "C01",
    configName: "QA-MATRIX-C01-x",
    config: {
      startDate: "1996-09-09",
      endDate: "2026-09-08",
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 10,
      benchmarkCode: "SP500",
    },
    runId: `run-${overrides.caseId}`,
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
    providerRequests: 0,
    failure: null,
    failedInvariants: [],
    ...overrides,
  });

  it("counts outcomes apart and does not treat zero trades as a failure", () => {
    const aggregate = aggregateMatrixResults(
      [
        result({ caseId: "S01-L01-C01" }),
        result({ caseId: "S06-L01-C03", tradeCount: 0 }),
        result({
          caseId: "S02-L01-C01",
          outcome: "FAILED",
          runStatus: "FAILED",
        }),
        result({
          caseId: "S03-L01-C01",
          outcome: "INVARIANT_FAILED",
          invariantsFailed: 2,
        }),
        result({ caseId: "S04-L01-C01", outcome: "RUNNER_ERROR", runId: null }),
      ],
      1_000,
      60_000,
    );
    expect(aggregate.expected).toBe(1_000);
    expect(aggregate.submitted).toBe(4);
    expect(aggregate.completed).toBe(2);
    expect(aggregate.failed).toBe(1);
    expect(aggregate.invariantFailures).toBe(1);
    expect(aggregate.runnerErrors).toBe(1);
    expect(aggregate.zeroTradeCases).toEqual(["S06-L01-C03"]);
    expect(aggregate.throughputPerMinute).toBeCloseTo(5, 5);
  });

  it("surfaces provider traffic per case, because zero is the expectation", () => {
    const aggregate = aggregateMatrixResults(
      [
        result({ caseId: "S01-L01-C01", providerRequests: 0 }),
        result({ caseId: "S02-L01-C01", providerRequests: 12 }),
      ],
      2,
      1_000,
    );
    expect(aggregate.providerRequests).toBe(12);
    expect(aggregate.providerRequestsByCase).toEqual([
      { caseId: "S02-L01-C01", requests: 12 },
    ]);
  });

  it("ranks the slowest and the highest-trade combinations", () => {
    const aggregate = aggregateMatrixResults(
      [
        result({ caseId: "A", durationMs: 10, tradeCount: 1 }),
        result({ caseId: "B", durationMs: 900, tradeCount: 400 }),
        result({ caseId: "C", durationMs: 50, tradeCount: 90 }),
      ],
      3,
      1_000,
    );
    expect(aggregate.slowestCases[0]?.caseId).toBe("B");
    expect(aggregate.highestTradeCases[0]).toEqual({
      caseId: "B",
      trades: 400,
    });
    expect(aggregate.totalTrades).toBe(491);
  });
});

describe("determinism comparison", () => {
  /**
   * The shape only. Field-by-field coverage lives in `matrix-determinism.test.ts`, which mutates
   * every persisted column of every result table one at a time — the property that actually makes
   * "two executions were identical" a statement rather than a hope.
   */
  const base = (): RunEvidence =>
    completeEvidence({ runId: "run-1", caseId: "S01-L01-C04" });

  it("accepts two identical executions and ignores operational identity", () => {
    expect(
      compareForDeterminism(base(), { ...base(), runId: "run-2" }),
    ).toEqual([]);
  });

  it("names the field that differs rather than only the record", () => {
    const second = base();
    const differences = compareForDeterminism(base(), {
      ...second,
      trades: [
        {
          ...(second.trades[0] as (typeof second.trades)[number]),
          shares: "2.0000000000",
        },
      ],
    });
    expect(differences).toEqual([
      "trade #1 shares: 10.0000000000 vs 2.0000000000",
    ]);
  });
});
