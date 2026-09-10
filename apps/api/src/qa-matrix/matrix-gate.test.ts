import { qaMatrixFixtures } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { qaMatrixCases } from "./matrix-case";
import { summarizeInvariants, type InvariantResult } from "./matrix-invariants";
import {
  evaluateMatrixGate,
  type MatrixGateInput,
  type MatrixPhaseProviderTraffic,
} from "./matrix-gate";
import { emptyEvidence } from "./matrix-evidence.test-helper";
import {
  aggregateMatrixResults,
  executeMatrixCase,
  type MatrixCaseResult,
  type MatrixRunnerPorts,
} from "./matrix-runner";
import { renderMatrixReport, type MatrixManifest } from "./matrix-report";

/**
 * The gate, condition by condition.
 *
 * A harness that can report GREEN while a mandatory condition is unmet is worse than no harness:
 * it converts an unexamined risk into a recorded assurance. So every condition below is asserted
 * **independently** — one violation at a time against an otherwise perfect sweep — and each has to
 * turn the verdict red on its own. A condition that only fails in company with another is a
 * condition that is not really enforced.
 */

const FIXTURES = qaMatrixFixtures("2026-09-09");
const CASES = qaMatrixCases(FIXTURES);
const SELECTED = CASES.slice(0, 6);
const GOLDEN = SELECTED.slice(0, 2).map((entry) => entry.caseId);

function passing(index: number): MatrixCaseResult {
  const matrixCase = SELECTED[index] as (typeof SELECTED)[number];
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
    durationMs: 1000,
    submittedAt: "2026-09-09T00:00:00.000Z",
    tradeCount: 12,
    equityRowCount: 250,
    finalValue: 1234.56,
    invariantsPassed: 38,
    invariantsFailed: 0,
    invariantsIndeterminate: 0,
    invariantsNeedingArchive: 2,
    providerRequests: 0,
    failure: null,
    failedInvariants: [],
  };
}

const RESULTS = SELECTED.map((_, index) => passing(index));

const quiet = (
  phase: MatrixPhaseProviderTraffic["phase"],
): MatrixPhaseProviderTraffic => ({
  phase,
  total: 0,
  unattributed: 0,
  attributedToCases: 0,
});

function archiveInvariant(status: InvariantResult["status"]): {
  id: number;
  key: string;
  status: string;
  detail: string;
  violations: readonly string[];
} {
  return {
    id: 36,
    key: "trade-signal-evidence",
    status,
    detail: "",
    violations: [],
  };
}

function green(overrides: Partial<MatrixGateInput> = {}): MatrixGateInput {
  return {
    selectedCaseIds: SELECTED.map((entry) => entry.caseId),
    results: RESULTS,
    aggregate: aggregateMatrixResults(RESULTS, SELECTED.length, 60_000),
    provider: {
      warmup: quiet("warmup"),
      main: quiet("main"),
      rerun: quiet("rerun"),
    },
    determinismRequested: true,
    requiredRerunCaseIds: GOLDEN,
    rerunResults: GOLDEN.map((_, index) => passing(index)),
    determinismDifferences: [],
    archives: {
      requested: true,
      expected: 2,
      actual: 2,
      expectedCaseIds: GOLDEN,
      missing: [],
      unreadable: [],
      verification: GOLDEN.map((caseId) => ({
        caseId,
        invariants: [archiveInvariant("PASS")],
      })),
    },
    ...overrides,
  };
}

const codes = (input: MatrixGateInput): readonly string[] =>
  evaluateMatrixGate(input).failures.map((entry) => entry.code);

describe("a sweep that met every condition", () => {
  it("is green, and says so with no reservations", () => {
    const verdict = evaluateMatrixGate(green());
    expect(verdict.failures).toEqual([]);
    expect(verdict.green).toBe(true);
    expect(verdict.exitCode).toBe(0);
  });
});

describe("each mandatory condition turns the verdict red on its own", () => {
  it("a selected case that was never submitted", () => {
    const results = [...RESULTS];
    results[3] = {
      ...(results[3] as MatrixCaseResult),
      runId: null,
      outcome: "SUBMIT_FAILED",
    };
    expect(
      codes(
        green({
          results,
          aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
        }),
      ),
    ).toContain("CASE_NOT_SUBMITTED");
  });

  it("a selected case with no result at all", () => {
    const results = RESULTS.slice(0, 5);
    expect(
      codes(
        green({
          results,
          aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
        }),
      ),
    ).toContain("CASE_NOT_SUBMITTED");
  });

  it("a completed count below the selected count", () => {
    const results = [...RESULTS];
    results[2] = {
      ...(results[2] as MatrixCaseResult),
      outcome: "FAILED",
      runStatus: "FAILED",
    };
    const failed = codes(
      green({
        results,
        aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
      }),
    );
    expect(failed).toContain("COUNTS_MISMATCH");
    expect(failed).toContain("EXECUTION_FAILED");
  });

  it("an execution that timed out", () => {
    const results = [...RESULTS];
    results[1] = {
      ...(results[1] as MatrixCaseResult),
      outcome: "TIMED_OUT",
      runStatus: "TIMED_OUT",
    };
    expect(
      codes(
        green({
          results,
          aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
        }),
      ),
    ).toContain("EXECUTION_FAILED");
  });

  it("an error inside the runner itself", () => {
    const results = [...RESULTS];
    results[0] = {
      ...(results[0] as MatrixCaseResult),
      outcome: "RUNNER_ERROR",
    };
    expect(
      codes(
        green({
          results,
          aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
        }),
      ),
    ).toContain("RUNNER_ERROR");
  });

  it("a failing invariant", () => {
    const results = [...RESULTS];
    results[4] = {
      ...(results[4] as MatrixCaseResult),
      outcome: "INVARIANT_FAILED",
      invariantsFailed: 1,
    };
    expect(
      codes(
        green({
          results,
          aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
        }),
      ),
    ).toContain("INVARIANT_FAILED");
  });

  it("an unexpected INDETERMINATE invariant", () => {
    const results = [...RESULTS];
    results[4] = {
      ...(results[4] as MatrixCaseResult),
      outcome: "INVARIANT_INDETERMINATE",
      invariantsIndeterminate: 1,
    };
    expect(
      codes(
        green({
          results,
          aggregate: aggregateMatrixResults(results, SELECTED.length, 60_000),
        }),
      ),
    ).toContain("INVARIANT_INDETERMINATE");
  });

  it("a required golden rerun that did not complete", () => {
    const rerunResults = [
      passing(0),
      { ...passing(1), outcome: "FAILED" as const },
    ];
    expect(codes(green({ rerunResults }))).toContain("GOLDEN_RERUN_INCOMPLETE");
  });

  it("a required golden rerun that was never executed", () => {
    expect(codes(green({ rerunResults: [passing(0)] }))).toContain(
      "GOLDEN_RERUN_INCOMPLETE",
    );
  });

  it("a determinism difference", () => {
    expect(
      codes(
        green({
          determinismDifferences: [
            {
              caseId: GOLDEN[0] as string,
              differences: ["trade #3 amount: 1 vs 2"],
            },
          ],
        }),
      ),
    ).toContain("DETERMINISM_DIFFERENCE");
  });

  it("a provider request during warm-up", () => {
    expect(
      codes(
        green({
          provider: {
            warmup: { ...quiet("warmup"), total: 1, unattributed: 1 },
            main: quiet("main"),
            rerun: quiet("rerun"),
          },
        }),
      ),
    ).toContain("PROVIDER_REQUESTS");
  });

  it("a provider request during the main sweep", () => {
    expect(
      codes(
        green({
          provider: {
            warmup: quiet("warmup"),
            main: { ...quiet("main"), total: 1, attributedToCases: 1 },
            rerun: quiet("rerun"),
          },
        }),
      ),
    ).toContain("PROVIDER_REQUESTS");
  });

  it("a provider request during the golden rerun", () => {
    expect(
      codes(
        green({
          provider: {
            warmup: quiet("warmup"),
            main: quiet("main"),
            rerun: { ...quiet("rerun"), total: 1, attributedToCases: 1 },
          },
        }),
      ),
    ).toContain("PROVIDER_REQUESTS");
  });

  it("provider traffic that cannot be attributed to the phase's own cases", () => {
    // Three requests observed, one accounted for: two belong to a run this phase does not know
    // about, so the ledger cannot say the sweep was clean even if the total had been zero.
    expect(
      codes(
        green({
          provider: {
            warmup: quiet("warmup"),
            main: {
              phase: "main",
              total: 3,
              unattributed: 0,
              attributedToCases: 1,
            },
            rerun: quiet("rerun"),
          },
        }),
      ),
    ).toContain("PROVIDER_ACCOUNTING");
  });

  it("an archive count below what was planned", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            actual: 1,
          },
        }),
      ),
    ).toContain("ARCHIVE_COUNT");
  });

  it("an archive count above what was planned", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            actual: 3,
          },
        }),
      ),
    ).toContain("ARCHIVE_COUNT");
  });

  it("a required golden archive that is missing", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            missing: [GOLDEN[1] as string],
          },
        }),
      ),
    ).toContain("ARCHIVE_MISSING");
  });

  it("an archive that cannot be read", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            unreadable: [
              {
                caseId: GOLDEN[0] as string,
                reason: "zip: unexpected end of file",
              },
            ],
          },
        }),
      ),
    ).toContain("ARCHIVE_UNREADABLE");
  });

  it("a failing archive-derived invariant", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            verification: [
              {
                caseId: GOLDEN[0] as string,
                invariants: [archiveInvariant("FAIL")],
              },
              {
                caseId: GOLDEN[1] as string,
                invariants: [archiveInvariant("PASS")],
              },
            ],
          },
        }),
      ),
    ).toContain("ARCHIVE_INVARIANT_FAILED");
  });

  it("an archive-derived invariant that remains unresolved", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            verification: [
              {
                caseId: GOLDEN[0] as string,
                invariants: [archiveInvariant("NEEDS_ARCHIVE")],
              },
              {
                caseId: GOLDEN[1] as string,
                invariants: [archiveInvariant("PASS")],
              },
            ],
          },
        }),
      ),
    ).toContain("ARCHIVE_INVARIANT_UNRESOLVED");
  });

  it("an archived case with no verification at all", () => {
    expect(
      codes(
        green({
          archives: {
            ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
            verification: [
              {
                caseId: GOLDEN[0] as string,
                invariants: [archiveInvariant("PASS")],
              },
            ],
          },
        }),
      ),
    ).toContain("ARCHIVE_UNVERIFIED");
  });
});

describe("the report and the exit code follow the same verdict", () => {
  const MANIFEST: MatrixManifest = {
    matrixExecutionId: "2026-09-09-20260909-120000",
    startedAt: "2026-09-09T12:00:00.000Z",
    asOfDate: "2026-09-09",
    database: "intrinsic_value_matrix",
    redisDb: 3,
    concurrency: 3,
    expectedCases: 1000,
    selectedCases: SELECTED.length,
    selection: SELECTED.map((entry) => entry.caseId),
    debugArchive: "full",
    goldenCases: GOLDEN,
    dataRevisions: {},
    methodology: {},
    git: { commit: "abc1234", branch: "feat/backtest-matrix-runner" },
    executionCalendar: { sessions: 7547, from: "1996-09-09", to: "2026-09-09" },
  };

  const render = (input: MatrixGateInput): string =>
    renderMatrixReport({
      manifest: MANIFEST,
      aggregate: input.aggregate,
      results: input.results,
      determinism: {
        cases: input.requiredRerunCaseIds,
        differences: input.determinismDifferences,
      },
      coverageWarnings: [],
      archiveVerification: input.archives?.verification ?? [],
      gate: evaluateMatrixGate(input),
    });

  it("says GREEN only when the gate is green", () => {
    expect(render(green())).toContain("**GREEN.**");
  });

  it("says NOT GREEN and names the condition when a provider request occurred", () => {
    const input = green({
      provider: {
        warmup: quiet("warmup"),
        main: { ...quiet("main"), total: 4, attributedToCases: 4 },
        rerun: quiet("rerun"),
      },
    });
    const report = render(input);
    expect(report).toContain("**NOT GREEN.**");
    expect(report).toContain("PROVIDER_REQUESTS");
    expect(evaluateMatrixGate(input).exitCode).toBe(1);
  });

  it("says NOT GREEN when the archive count is wrong, even with every case perfect", () => {
    const input = green({
      archives: {
        ...(green().archives as NonNullable<MatrixGateInput["archives"]>),
        actual: 10,
      },
    });
    const report = render(input);
    expect(report).toContain("**NOT GREEN.**");
    expect(report).toContain("ARCHIVE_COUNT");
  });
});

describe("INDETERMINATE evidence never settles as a completed case", () => {
  it("is counted by summarizeInvariants", () => {
    const results: InvariantResult[] = [
      { id: 1, key: "a", title: "a", status: "PASS", detail: "" },
      { id: 2, key: "b", title: "b", status: "INDETERMINATE", detail: "" },
    ];
    expect(summarizeInvariants(results).indeterminate).toBe(1);
  });

  it("makes the case outcome INVARIANT_INDETERMINATE rather than COMPLETED", async () => {
    const matrixCase = SELECTED[0] as (typeof SELECTED)[number];
    const ports: MatrixRunnerPorts = {
      submit: async () => "run-1",
      awaitTerminal: async () => ({ status: "COMPLETED", failure: null }),
      collectEvidence: async () =>
        emptyEvidence({ runId: "run-1", caseId: matrixCase.caseId }),
      validate: () => [
        { id: 1, key: "a", title: "a", status: "PASS", detail: "" },
        {
          id: 2,
          key: "b",
          title: "b",
          status: "INDETERMINATE",
          detail: "cannot decide",
        },
      ],
      providerRequestsFor: () => 0,
      now: () => 0,
    };
    const result = await executeMatrixCase(matrixCase, ports);
    expect(result.outcome).toBe("INVARIANT_INDETERMINATE");
    expect(result.invariantsIndeterminate).toBe(1);
    expect(result.failure).toContain("#2 b");
  });
});
