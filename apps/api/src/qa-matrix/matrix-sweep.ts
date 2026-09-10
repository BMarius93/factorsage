import type { QaMatrixCase } from "./matrix-case";
import type { MatrixArchivePlan } from "./matrix-archive-plan";
import type { MatrixPhaseProviderTraffic } from "./matrix-gate";
import type { MatrixCaseResult } from "./matrix-runner";

/**
 * Which pool captures forensic archives, and which runs each phase actually produced one for.
 *
 * Archives are a **worker-process** setting: a pool either captures every attempt it executes or
 * none of them. So a thousand full archives is a disk-space incident rather than a validation
 * strategy, and the full sweep runs with capture off while the six golden combinations — which are
 * re-executed anyway for determinism — are captured by a second, short-lived pool.
 *
 * The two pools must never be alive together. Both claim from the same PostgreSQL queue, so a
 * still-running sweep pool will happily take some of the rerun's jobs, and if the two disagree
 * about capture the archive count is whatever the race decided. Observed: ten archives where six
 * were planned.
 *
 * Separated from the command because the properties worth asserting — capture off for the sweep,
 * on for the reruns, one archive per selected case under `--case --archive`, and no pool overlap —
 * are properties of this choreography, not of the database or the worker binary. A test drives it
 * with fake pools; the command wires the real ones.
 */

export type MatrixSweepPool = {
  /**
   * The pool's provider ledger.
   *
   * `byRunId` is what makes attribution rebuildable: a phase can ask which of *its own* runs the
   * requests belong to, rather than trusting counters each case sampled when it settled.
   */
  providerRequests(): {
    readonly byRunId: ReadonlyMap<string, number>;
    readonly total: number;
    readonly unattributed: number;
  };
  providerRequestsFor(runId: string): number;
  stop(): Promise<void>;
};

export type MatrixSweepPorts = {
  /** Creates and starts a pool with the given capture setting. */
  startPool(input: {
    readonly debugArchive: "off" | "full";
    readonly phase: "main" | "rerun";
  }): MatrixSweepPool;
  /** Executes the selected cases against the started main pool. */
  runMain(pool: MatrixSweepPool): Promise<readonly MatrixCaseResult[]>;
  /**
   * The golden combinations worth re-executing, decided after the main sweep.
   *
   * A golden case that failed has no first execution to compare a second against, so it is not
   * re-run; the gate reports that as an incomplete rerun rather than as an identical one.
   */
  rerunnable(results: readonly MatrixCaseResult[]): readonly QaMatrixCase[];
  /** Executes those combinations again against the started rerun pool. */
  runRerun(
    pool: MatrixSweepPool,
    cases: readonly QaMatrixCase[],
  ): Promise<readonly MatrixCaseResult[]>;
  /** Called between the phases, so a long sweep stays readable. */
  onPhase?: (line: string) => void;
};

export type MatrixSweepOutcome = {
  readonly results: readonly MatrixCaseResult[];
  readonly rerunResults: readonly MatrixCaseResult[];
  readonly mainTraffic: MatrixPhaseProviderTraffic;
  readonly rerunTraffic: MatrixPhaseProviderTraffic;
  /** `caseId -> runId` for every attempt executed by a pool that was capturing. */
  readonly archivedRuns: ReadonlyMap<string, string>;
  /** The cases the plan says must each hold one archive. */
  readonly expectedArchiveCaseIds: readonly string[];
  /** The golden combinations that were actually re-executed. */
  readonly rerunCaseIds: readonly string[];
  readonly durationMs: number;
};

/**
 * One phase's provider traffic, read from the ledger **after** the pool has been stopped and its
 * log stream drained.
 *
 * Both halves of that sentence were wrong before. The sample was taken before `stop()`, so a
 * request still travelling up the worker's stdout pipe was counted a moment too late to matter —
 * a controlled pool reproduced it as `{"observedAfterStop":1,"recordedBySweep":0}`. And
 * `attributedToCases` was summed from `result.providerRequests`, which each case captured when it
 * settled, earlier still. A phase that reports a zero it sampled before the evidence arrived is
 * not measuring the sweep; it is measuring its own timing.
 *
 * So attribution is rebuilt here from the drained ledger, restricted to the runs this phase
 * actually executed. A request the ledger attributes to some other run is deliberately *not*
 * counted, which leaves `total - unattributed - attributedToCases` non-zero — and the gate refuses
 * that as `PROVIDER_ACCOUNTING`, because a ledger that does not add up cannot support a claim of
 * zero.
 */
export function drainedTraffic(
  phase: MatrixPhaseProviderTraffic["phase"],
  pool: MatrixSweepPool | null,
  results: readonly MatrixCaseResult[],
): MatrixPhaseProviderTraffic {
  const ledger = pool?.providerRequests();
  const ownRunIds = new Set(
    results
      .map((result) => result.runId)
      .filter((runId): runId is string => runId !== null),
  );
  let attributedToCases = 0;
  for (const [runId, count] of ledger?.byRunId ?? []) {
    if (ownRunIds.has(runId)) {
      attributedToCases += count;
    }
  }
  return {
    phase,
    total: ledger?.total ?? 0,
    unattributed: ledger?.unattributed ?? 0,
    attributedToCases,
  };
}

/**
 * Runs the main sweep and, when asked, the golden reruns — each against its own pool.
 *
 * `rerunnable` is the golden set the caller could actually collect first-execution evidence for; a
 * golden case that failed has nothing to compare against and is therefore not re-executed, which
 * the gate reports separately as an incomplete rerun rather than as an identical one.
 */
export async function runMatrixSweep(input: {
  readonly selected: readonly QaMatrixCase[];
  readonly plan: MatrixArchivePlan;
  readonly determinismEnabled: boolean;
  readonly now: () => number;
  readonly ports: MatrixSweepPorts;
}): Promise<MatrixSweepOutcome> {
  const { plan, ports } = input;
  const announce = ports.onPhase ?? (() => {});
  const archivedRuns = new Map<string, string>();

  const mainCaptures = plan.mainPool === "full";
  const mainPool = ports.startPool({
    debugArchive: mainCaptures ? "full" : "off",
    phase: "main",
  });

  const startedAt = input.now();
  let results: readonly MatrixCaseResult[] = [];
  let mainTraffic: MatrixPhaseProviderTraffic;
  try {
    results = await ports.runMain(mainPool);
  } finally {
    // The sweep pool is stopped before any rerun pool starts, always — including on the failure
    // path, where a pool left claiming jobs is exactly the race that produced ten archives. And
    // the ledger is read only **after** that, because `stop()` is also what proves the worker's
    // log stream was drained; sampling first records a zero that a late line then contradicts.
    await mainPool.stop();
    mainTraffic = drainedTraffic("main", mainPool, results);
  }
  const durationMs = input.now() - startedAt;

  if (mainCaptures) {
    // Every case this pool executed was captured, so every one of them has an archive — not just
    // the golden subset. A `--case Sxx-Lxx-Cxx --archive` reproduction is the whole point of that
    // mode, and its archive was previously produced and then never verified because the case was
    // not in the golden set.
    for (const result of results) {
      if (result.runId) {
        archivedRuns.set(result.caseId, result.runId);
      }
    }
  }

  const rerunCaptures = plan.rerunPool === "full";
  const rerunnable = ports.rerunnable(results);
  let rerunResults: readonly MatrixCaseResult[] = [];
  let rerunTraffic = drainedTraffic("rerun", null, []);
  if (input.determinismEnabled && rerunnable.length > 0) {
    announce(
      `Re-executing ${rerunnable.length} golden combination(s) to verify determinism…`,
    );
    const rerunPool = ports.startPool({
      debugArchive: rerunCaptures ? "full" : "off",
      phase: "rerun",
    });
    try {
      rerunResults = await ports.runRerun(rerunPool, rerunnable);
    } finally {
      await rerunPool.stop();
      rerunTraffic = drainedTraffic("rerun", rerunPool, rerunResults);
    }
    if (rerunCaptures) {
      for (const result of rerunResults) {
        if (result.runId) {
          archivedRuns.set(result.caseId, result.runId);
        }
      }
    }
  }

  const expectedArchiveCaseIds = mainCaptures
    ? input.selected.map((entry) => entry.caseId)
    : rerunCaptures && input.determinismEnabled
      ? rerunnable.map((entry) => entry.caseId)
      : [];

  return {
    results,
    rerunResults,
    mainTraffic,
    rerunTraffic,
    archivedRuns,
    expectedArchiveCaseIds,
    rerunCaseIds: rerunnable.map((entry) => entry.caseId),
    durationMs,
  };
}
