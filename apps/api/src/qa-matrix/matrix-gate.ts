import type { MatrixAggregate, MatrixCaseResult } from "./matrix-runner";

/**
 * The single place that decides whether a sweep passed.
 *
 * Before this existed the decision was spread across three: an expression at the bottom of
 * `qa-matrix-run.ts` that set the exit code, a boolean inside `renderMatrixReport` that printed
 * GREEN, and a handful of `console.log` lines that reported conditions nobody checked. They did not
 * agree. A sweep could print **GREEN**, exit zero, and have reached the provider four hundred
 * times, produced ten archives where six were planned, silently skipped a golden rerun, and
 * classified a run whose invariants could not be decided as COMPLETED.
 *
 * That is the specific failure this module exists to make impossible: a harness that can report a
 * pass without enforcing what the pass is supposed to mean. Every mandatory condition is one entry
 * here, each with a stable code, and the report, the machine-readable summary and the process exit
 * code all read the same verdict.
 *
 * Deliberately pure — no filesystem, no database, no worker pool — so every condition can be
 * asserted independently, one violation at a time against an otherwise perfect sweep.
 */

/**
 * Provider traffic for one phase of the sweep.
 *
 * Kept per phase because the three mean different things when they are not zero. Warm-up traffic
 * says the pinned dataset was incomplete *before* the sweep began, which invalidates the sweep
 * rather than a case in it. Main-sweep traffic says a specific run depended on live data. Rerun
 * traffic says the determinism comparison was not against the same data twice.
 *
 * `attributedToCases` is what the phase's own case results account for. The pool attributes a
 * request to a run by the worker that made it, so a total the phase's cases cannot explain means
 * some request belongs to a run this phase does not know about — and then "zero provider requests"
 * is not something the ledger can honestly claim, whatever the number says.
 */
export type MatrixPhaseProviderTraffic = {
  readonly phase: "warmup" | "main" | "rerun";
  readonly total: number;
  /** Observed while the worker held no claim, so attributable to no run. */
  readonly unattributed: number;
  /** The sum over this phase's own case results. */
  readonly attributedToCases: number;
};

export type MatrixArchiveEvidence = {
  /** Whether archives were requested at all. When false, archive conditions do not apply. */
  readonly requested: boolean;
  /** What `planMatrixArchives` said would be produced. */
  readonly expected: number;
  /** Archive files actually present in the sweep's archive directory. */
  readonly actual: number;
  /** The cases that should each have produced one archive. */
  readonly expectedCaseIds: readonly string[];
  /** Cases that should have produced an archive and did not. */
  readonly missing: readonly string[];
  /** Archives found but not readable or not verifiable, with why. */
  readonly unreadable: readonly {
    readonly caseId: string;
    readonly reason: string;
  }[];
  readonly verification: readonly {
    readonly caseId: string;
    readonly invariants: readonly {
      readonly id: number;
      readonly key: string;
      readonly status: string;
      readonly detail: string;
      readonly violations: readonly string[];
    }[];
  }[];
};

export type MatrixGateInput = {
  readonly selectedCaseIds: readonly string[];
  readonly results: readonly MatrixCaseResult[];
  readonly aggregate: MatrixAggregate;
  readonly provider: {
    readonly warmup: MatrixPhaseProviderTraffic;
    readonly main: MatrixPhaseProviderTraffic;
    readonly rerun: MatrixPhaseProviderTraffic;
  };
  /** Whether determinism reruns were asked for. When false, rerun conditions do not apply. */
  readonly determinismRequested: boolean;
  /** The golden cases that must each have re-executed successfully. */
  readonly requiredRerunCaseIds: readonly string[];
  readonly rerunResults: readonly MatrixCaseResult[];
  readonly determinismDifferences: readonly {
    readonly caseId: string;
    readonly differences: readonly string[];
  }[];
  readonly archives: MatrixArchiveEvidence | null;
};

/** One unmet condition. The code is stable; the detail is for a person. */
export type MatrixGateFailure = {
  readonly code: string;
  readonly detail: string;
};

export type MatrixGateVerdict = {
  readonly green: boolean;
  readonly exitCode: 0 | 1;
  readonly failures: readonly MatrixGateFailure[];
  /** Warm-up + main + rerun. The number the gate actually tests. */
  readonly providerRequestsTotal: number;
};

/** Warm-up, main and rerun combined — reported separately, gated together. */
export function combinedProviderRequests(
  provider: MatrixGateInput["provider"],
): number {
  return provider.warmup.total + provider.main.total + provider.rerun.total;
}

/**
 * Whether a phase's ledger adds up.
 *
 * Every request is either attributed to one of the phase's own cases or explicitly unattributed.
 * Anything left over was attributed to a run id the phase's results do not contain, which means the
 * accounting is incomplete — a different statement from "there was traffic", and a separate failure.
 */
function providerAccountingGap(phase: MatrixPhaseProviderTraffic): number {
  return phase.total - phase.unattributed - phase.attributedToCases;
}

const OUTCOMES_THAT_DID_NOT_COMPLETE = new Set([
  "FAILED",
  "SUBMIT_FAILED",
  "TIMED_OUT",
]);

/**
 * Evaluates every mandatory condition, in the order a reader would want them.
 *
 * Every condition is checked; none short-circuits. A sweep with four problems should report four,
 * because the second one is often the one that explains the first.
 */
export function evaluateMatrixGate(input: MatrixGateInput): MatrixGateVerdict {
  const failures: MatrixGateFailure[] = [];
  const fail = (code: string, detail: string): void => {
    failures.push({ code, detail });
  };

  // ---- Submission and counts ---------------------------------------------------------------
  if (input.selectedCaseIds.length === 0) {
    // A sweep that validated nothing is not a sweep that passed. Every condition below is
    // satisfied by an empty run — no case failed, no invariant failed, no archive is missing — so
    // without this, "green" could mean "nothing happened".
    fail(
      "NO_CASES_SELECTED",
      "No cases were selected, so nothing was validated. A green verdict must mean a sweep " +
        "happened, not that an empty one had nothing to fail.",
    );
  }
  const byCaseId = new Map(
    input.results.map((result) => [result.caseId, result]),
  );
  const notSubmitted = input.selectedCaseIds.filter((caseId) => {
    const result = byCaseId.get(caseId);
    return result === undefined || result.runId === null;
  });
  if (notSubmitted.length > 0) {
    fail(
      "CASE_NOT_SUBMITTED",
      `${notSubmitted.length} selected case(s) were never submitted: ${notSubmitted
        .slice(0, 10)
        .join(", ")}${notSubmitted.length > 10 ? ", …" : ""}.`,
    );
  }
  if (
    input.aggregate.submitted !== input.selectedCaseIds.length ||
    input.aggregate.completed !== input.selectedCaseIds.length
  ) {
    fail(
      "COUNTS_MISMATCH",
      `${input.selectedCaseIds.length} case(s) were selected but ${input.aggregate.submitted} were ` +
        `submitted and ${input.aggregate.completed} completed.`,
    );
  }

  // ---- Execution ---------------------------------------------------------------------------
  const didNotComplete = input.results.filter((result) =>
    OUTCOMES_THAT_DID_NOT_COMPLETE.has(result.outcome),
  );
  if (didNotComplete.length > 0) {
    fail(
      "EXECUTION_FAILED",
      `${didNotComplete.length} execution(s) failed or timed out: ${didNotComplete
        .slice(0, 10)
        .map((result) => `${result.caseId} ${result.outcome}`)
        .join(", ")}${didNotComplete.length > 10 ? ", …" : ""}.`,
    );
  }
  const runnerErrors = input.results.filter(
    (result) => result.outcome === "RUNNER_ERROR",
  );
  if (runnerErrors.length > 0) {
    fail(
      "RUNNER_ERROR",
      `${runnerErrors.length} case(s) hit an error inside the runner: ${runnerErrors
        .slice(0, 10)
        .map((result) => result.caseId)
        .join(", ")}.`,
    );
  }

  // ---- Invariants --------------------------------------------------------------------------
  const invariantFailed = input.results.filter(
    (result) =>
      result.invariantsFailed > 0 || result.outcome === "INVARIANT_FAILED",
  );
  if (invariantFailed.length > 0) {
    fail(
      "INVARIANT_FAILED",
      `${invariantFailed.length} case(s) failed at least one invariant: ${invariantFailed
        .slice(0, 10)
        .map((result) => result.caseId)
        .join(", ")}${invariantFailed.length > 10 ? ", …" : ""}.`,
    );
  }
  const indeterminate = input.results.filter(
    (result) =>
      result.invariantsIndeterminate > 0 ||
      result.outcome === "INVARIANT_INDETERMINATE",
  );
  if (indeterminate.length > 0) {
    fail(
      "INVARIANT_INDETERMINATE",
      `${indeterminate.length} case(s) left an invariant undecided: ${indeterminate
        .slice(0, 10)
        .map((result) => result.caseId)
        .join(
          ", ",
        )}. Persisted evidence must be able to settle every invariant it owns.`,
    );
  }

  // ---- Determinism -------------------------------------------------------------------------
  if (input.determinismRequested) {
    const rerunByCaseId = new Map(
      input.rerunResults.map((result) => [result.caseId, result]),
    );
    const incomplete = input.requiredRerunCaseIds.filter((caseId) => {
      const result = rerunByCaseId.get(caseId);
      return result === undefined || result.outcome !== "COMPLETED";
    });
    if (incomplete.length > 0) {
      fail(
        "GOLDEN_RERUN_INCOMPLETE",
        `${incomplete.length} required golden rerun(s) did not complete: ${incomplete.join(", ")}.`,
      );
    }
  }
  if (input.determinismDifferences.length > 0) {
    const total = input.determinismDifferences.reduce(
      (sum, entry) => sum + entry.differences.length,
      0,
    );
    fail(
      "DETERMINISM_DIFFERENCE",
      `${total} field difference(s) across ${input.determinismDifferences.length} case(s): ` +
        `${input.determinismDifferences.map((entry) => entry.caseId).join(", ")}.`,
    );
  }

  // ---- Provider traffic --------------------------------------------------------------------
  const phases = [
    input.provider.warmup,
    input.provider.main,
    input.provider.rerun,
  ];
  const providerRequestsTotal = combinedProviderRequests(input.provider);
  if (providerRequestsTotal > 0) {
    fail(
      "PROVIDER_REQUESTS",
      `${providerRequestsTotal} provider request(s) — ` +
        phases.map((phase) => `${phase.phase} ${phase.total}`).join(", ") +
        ". The matrix runs against a pinned copy of canonical data and must reach FMP zero times.",
    );
  }
  const unaccounted = phases.filter(
    (phase) => providerAccountingGap(phase) !== 0,
  );
  if (unaccounted.length > 0) {
    fail(
      "PROVIDER_ACCOUNTING",
      unaccounted
        .map(
          (phase) =>
            `${phase.phase}: ${phase.total} observed, ${phase.attributedToCases} attributed to ` +
            `this phase's cases and ${phase.unattributed} explicitly unattributed, leaving ` +
            `${providerAccountingGap(phase)} unaccounted for`,
        )
        .join("; ") + ".",
    );
  }

  // ---- Archives ----------------------------------------------------------------------------
  const archives = input.archives;
  if (archives && archives.requested) {
    if (archives.actual !== archives.expected) {
      fail(
        "ARCHIVE_COUNT",
        `${archives.expected} archive(s) were planned but ${archives.actual} exist.`,
      );
    }
    if (archives.missing.length > 0) {
      fail(
        "ARCHIVE_MISSING",
        `no archive was produced for ${archives.missing.join(", ")}.`,
      );
    }
    if (archives.unreadable.length > 0) {
      fail(
        "ARCHIVE_UNREADABLE",
        archives.unreadable
          .map((entry) => `${entry.caseId}: ${entry.reason}`)
          .join("; ") + ".",
      );
    }
    const verifiedCaseIds = new Set(
      archives.verification.map((entry) => entry.caseId),
    );
    const unverified = archives.expectedCaseIds.filter(
      (caseId) => !verifiedCaseIds.has(caseId),
    );
    if (unverified.length > 0) {
      fail(
        "ARCHIVE_UNVERIFIED",
        `${unverified.join(", ")} produced no archive verdict, so the frame-level invariants were ` +
          "never proven.",
      );
    }
    const archiveFailed = archives.verification.filter((entry) =>
      entry.invariants.some((invariant) => invariant.status === "FAIL"),
    );
    if (archiveFailed.length > 0) {
      fail(
        "ARCHIVE_INVARIANT_FAILED",
        archiveFailed
          .map(
            (entry) =>
              `${entry.caseId}: ${entry.invariants
                .filter((invariant) => invariant.status === "FAIL")
                .map((invariant) => `#${invariant.id} ${invariant.key}`)
                .join(", ")}`,
          )
          .join("; ") + ".",
      );
    }
    // An archive-derived invariant that is still `NEEDS_ARCHIVE` after the archive was read has
    // not been answered by anything: the persisted evidence deferred it and the archive did not
    // take it up.
    const unresolved = archives.verification.filter((entry) =>
      entry.invariants.some(
        (invariant) =>
          invariant.status === "NEEDS_ARCHIVE" ||
          invariant.status === "INDETERMINATE",
      ),
    );
    if (unresolved.length > 0) {
      fail(
        "ARCHIVE_INVARIANT_UNRESOLVED",
        unresolved
          .map(
            (entry) =>
              `${entry.caseId}: ${entry.invariants
                .filter(
                  (invariant) =>
                    invariant.status === "NEEDS_ARCHIVE" ||
                    invariant.status === "INDETERMINATE",
                )
                .map(
                  (invariant) =>
                    `#${invariant.id} ${invariant.key} ${invariant.status}`,
                )
                .join(", ")}`,
          )
          .join("; ") + ".",
      );
    }
  }

  return {
    green: failures.length === 0,
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    providerRequestsTotal,
  };
}
