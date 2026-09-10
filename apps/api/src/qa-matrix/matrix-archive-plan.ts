import { QA_MATRIX_TOTAL_CASES } from "./matrix-case";

/**
 * Which worker pool captures forensic archives, and how many that produces.
 *
 * `BACKTEST_DEBUG_ARCHIVE` is a worker-process setting, so a pool either archives **every** attempt
 * it executes or none of them. There is deliberately no per-run switch: the archive has no API
 * field and no snapshot flag, and adding one would make it a product feature by accident.
 *
 * That constraint is what the first implementation got wrong. `--archive` on the full matrix set
 * the flag on the only pool there was, so a thousand-case sweep wrote 1,006 archives — 567 MB —
 * when the design called for six. The fix is not a filter but a second pool: the sweep runs with
 * capture off, and the golden combinations are captured when they are re-executed for the
 * determinism check, which happens anyway. One extra short-lived pool instead of 994 extra zips.
 *
 * An explicit selection needs no second pool. `--case S03-L07-C04 --archive` is one run, so that
 * pool captures directly and produces exactly one archive.
 */
export type MatrixArchivePlan = {
  /** Capture mode for the pool that executes the selected cases. */
  readonly mainPool: "off" | "full";
  /** Capture mode for the pool that re-executes the golden set for determinism. */
  readonly rerunPool: "off" | "full";
  /** How many archives the whole run should leave behind. */
  readonly expectedArchives: number;
  readonly reason: string;
  /**
   * Why this combination of flags cannot be honoured, or `null` when it can.
   *
   * A plan that produces no archives for a user who explicitly asked for them is not a plan; it is
   * a request that was ignored. `--archive --no-determinism` on a full sweep planned exactly that:
   * the main pool never captures on a full sweep, the rerun pool is the one that does, and turning
   * the rerun off leaves nowhere for the capture to happen. The sweep then ran to completion,
   * wrote no archives, and the gate skipped every archive condition because no pool had been
   * switched on — so an explicit `--archive` produced a green sweep with nothing to inspect.
   *
   * Refusing is the honest answer, and refusing *before* anything runs is the useful one.
   */
  readonly refusal: string | null;
};

export function planMatrixArchives(input: {
  readonly archiveRequested: boolean;
  readonly selectedCases: number;
  readonly goldenCases: number;
  readonly determinismEnabled: boolean;
  readonly totalCases?: number;
}): MatrixArchivePlan {
  const total = input.totalCases ?? QA_MATRIX_TOTAL_CASES;
  if (!input.archiveRequested) {
    return {
      mainPool: "off",
      rerunPool: "off",
      expectedArchives: 0,
      reason: "no archives were requested",
      refusal: null,
    };
  }
  const isFullSweep = input.selectedCases >= total;
  if (!isFullSweep) {
    return {
      mainPool: "full",
      rerunPool: "off",
      expectedArchives: input.selectedCases,
      reason:
        "an explicit selection is already small, so it is captured directly and the determinism " +
        "rerun does not capture it a second time",
      refusal: null,
    };
  }
  if (!input.determinismEnabled) {
    return {
      mainPool: "off",
      rerunPool: "off",
      expectedArchives: 0,
      reason:
        "a full sweep never captures in the main pool, and with the determinism rerun disabled " +
        "there is no second pool to capture in",
      refusal:
        "`--archive` cannot be honoured together with `--no-determinism` on the full matrix. A " +
        "full sweep never captures in its own pool — a thousand archives is a disk-space incident " +
        "rather than a validation strategy — so the six golden combinations are captured by the " +
        "second pool that re-executes them for the determinism check, and `--no-determinism` " +
        "removes that pool. Run the full sweep with determinism enabled, which produces the six " +
        "archives, or capture the golden set on its own with `--golden --archive`.",
    };
  }
  return {
    mainPool: "off",
    rerunPool: "full",
    expectedArchives: input.goldenCases,
    reason:
      "the full sweep runs with capture off and the golden combinations are captured when the " +
      "determinism check re-executes them",
    refusal: null,
  };
}
