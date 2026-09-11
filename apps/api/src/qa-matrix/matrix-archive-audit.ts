import type { MatrixArchiveEvidence } from "./matrix-gate";
import type { MatrixArchivePlan } from "./matrix-archive-plan";
import type { InvariantResult } from "./matrix-invariants";

/**
 * What the archive directory actually holds, checked against what was planned.
 *
 * The plan was printed and never verified. That is how a sweep produced ten archives where six were
 * planned and reported neither number as a problem: `expectedArchives` reached a `console.log` and
 * nothing else, a case whose archive was missing logged "no archive found" and continued, and an
 * archive that could not be read did not exist as a concept at all.
 *
 * Separated from the command so the property can be driven by fake pools over a real directory: an
 * assertion about the *plan* proves the arithmetic and not the outcome, and the outcome is what a
 * reviewer is being asked to trust.
 */

/** The filesystem and archive reader, as ports, so a test can supply a directory it built. */
export type MatrixArchiveAuditPorts = {
  countArchives(directory: string): Promise<number>;
  findArchive(directory: string, runId: string): Promise<string | null>;
  verifyArchive(path: string): Promise<readonly InvariantResult[]>;
};

export type MatrixArchiveAuditInput = {
  readonly directory: string;
  readonly plan: MatrixArchivePlan;
  /**
   * Whether the user asked for archives — not whether the plan happened to switch a pool on.
   *
   * The two came apart exactly where it mattered: `--archive --no-determinism` on a full sweep
   * left both pools off, so deriving `requested` from the plan reported `false`, and every archive
   * condition in the gate became vacuous for a user who had explicitly asked for archives. The
   * combination is refused now, but the field says what it means either way.
   */
  readonly requested: boolean;
  /** The cases that should each hold exactly one archive, and the run that produced each. */
  readonly archivedRuns: ReadonlyMap<string, string>;
  /**
   * The cases the *plan* says must each hold an archive.
   *
   * Deliberately not derived from `archivedRuns`: a case that silently produced nothing would then
   * define itself out of the check, which is the shape of the defect this module exists for.
   */
  readonly expectedCaseIds: readonly string[];
  readonly ports: MatrixArchiveAuditPorts;
  /** Called per case so a long sweep stays readable while it runs. */
  readonly onProgress?: (line: string) => void;
};

/**
 * Audits every archive the sweep was supposed to produce.
 *
 * Three outcomes per case, and all three are recorded rather than logged: the archive is there and
 * verifies, it is there and cannot be read, or it is not there. The directory count is compared
 * with the plan separately, because a *surplus* archive is invisible case by case — it belongs to a
 * run nobody asked to capture, which is exactly the pool race that produced ten where six were
 * planned.
 */
export async function auditMatrixArchives(
  input: MatrixArchiveAuditInput,
): Promise<MatrixArchiveEvidence> {
  const { directory, plan, archivedRuns, ports } = input;
  const log = input.onProgress ?? (() => {});

  const missing: string[] = [];
  const unreadable: { caseId: string; reason: string }[] = [];
  const verification: MatrixArchiveEvidence["verification"][number][] = [];

  for (const [caseId, runId] of archivedRuns) {
    const path = await ports.findArchive(directory, runId);
    if (!path) {
      missing.push(caseId);
      log(`  no archive found for ${caseId}`);
      continue;
    }
    let invariants: readonly InvariantResult[];
    try {
      invariants = await ports.verifyArchive(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      unreadable.push({ caseId, reason });
      log(`  archive ${caseId} could not be read: ${reason}`);
      continue;
    }
    verification.push({
      caseId,
      invariants: invariants.map((entry) => ({
        id: entry.id,
        key: entry.key,
        status: entry.status,
        detail: entry.detail,
        violations: entry.violations ?? [],
      })),
    });
    const failed = invariants.filter((entry) => entry.status === "FAIL");
    log(
      `  archive ${caseId}: ${invariants.length - failed.length}/${invariants.length} ` +
        "frame-level invariants proven" +
        (failed.length > 0
          ? ` — ${failed.map((entry) => `#${entry.id} ${entry.key}`).join(", ")}`
          : ""),
    );
    for (const entry of failed) {
      for (const violation of entry.violations ?? []) {
        log(`      ${violation}`);
      }
    }
  }

  return {
    requested: input.requested,
    expected: plan.expectedArchives,
    actual: await ports.countArchives(directory),
    expectedCaseIds: input.expectedCaseIds,
    missing,
    unreadable,
    verification,
  };
}
