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
    };
  }
  if (!input.determinismEnabled) {
    return {
      mainPool: "off",
      rerunPool: "off",
      expectedArchives: 0,
      reason:
        "a full sweep never captures in the main pool, and with the determinism rerun disabled " +
        "there is no second pool to capture in; rerun the golden set with --golden --archive",
    };
  }
  return {
    mainPool: "off",
    rerunPool: "full",
    expectedArchives: input.goldenCases,
    reason:
      "the full sweep runs with capture off and the golden combinations are captured when the " +
      "determinism check re-executes them",
  };
}
