import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qaMatrixFixtures } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { countArchives, findArchive } from "./matrix-archive";
import { auditMatrixArchives } from "./matrix-archive-audit";
import { planMatrixArchives } from "./matrix-archive-plan";
import { qaMatrixCases, qaMatrixGoldenCases } from "./matrix-case";
import {
  evaluateMatrixGate,
  type MatrixPhaseProviderTraffic,
} from "./matrix-gate";
import type { InvariantResult } from "./matrix-invariants";
import { aggregateMatrixResults, type MatrixCaseResult } from "./matrix-runner";
import {
  runMatrixSweep,
  type MatrixSweepPool,
  type MatrixSweepPorts,
} from "./matrix-sweep";

/**
 * The archive choreography, end to end, with fake pools over a real directory.
 *
 * A plan-only assertion proves the arithmetic and not the outcome, and the outcome is what a
 * reviewer is being asked to trust. Three separate things had to be true and none of them was
 * checked: a thousand executions must capture nothing, six reruns must capture, and the directory
 * must then hold exactly six files. The sweep that produced **ten** satisfied its plan perfectly.
 *
 * So the pools here are fakes that record what capture setting they were created with and in what
 * order they started and stopped, and the archives are real files in a real temporary directory —
 * which is what makes "exactly six" a measurement of the filesystem rather than of an intention.
 */

const FIXTURES = qaMatrixFixtures("2026-09-09");
const CASES = qaMatrixCases(FIXTURES);
const GOLDEN = qaMatrixGoldenCases(CASES);

type PoolEvent =
  | { kind: "start"; phase: "main" | "rerun"; debugArchive: "off" | "full" }
  | { kind: "stop"; phase: "main" | "rerun" };

/** A pool that executes nothing and remembers only what the choreography did to it. */
function fakePools(events: PoolEvent[]) {
  let live = 0;
  let maxLive = 0;
  return {
    startPool: ({
      debugArchive,
      phase,
    }: {
      debugArchive: "off" | "full";
      phase: "main" | "rerun";
    }): MatrixSweepPool => {
      events.push({ kind: "start", phase, debugArchive });
      live += 1;
      maxLive = Math.max(maxLive, live);
      return {
        providerRequests: () => ({ total: 0, unattributed: 0 }),
        providerRequestsFor: () => 0,
        stop: async () => {
          events.push({ kind: "stop", phase });
          live -= 1;
        },
      };
    },
    get concurrentPools() {
      return maxLive;
    },
  };
}

function completed(matrixCase: (typeof CASES)[number]): MatrixCaseResult {
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
    tradeCount: 10,
    equityRowCount: 100,
    finalValue: 1_000,
    invariantsPassed: 38,
    invariantsFailed: 0,
    invariantsIndeterminate: 0,
    invariantsNeedingArchive: 2,
    providerRequests: 0,
    failure: null,
    failedInvariants: [],
  };
}

function sweepPorts(
  selected: readonly (typeof CASES)[number][],
  rerunnable: readonly (typeof CASES)[number][],
  events: PoolEvent[],
): { ports: MatrixSweepPorts; pools: ReturnType<typeof fakePools> } {
  const pools = fakePools(events);
  return {
    pools,
    ports: {
      startPool: pools.startPool,
      runMain: async () => selected.map(completed),
      rerunnable: () => rerunnable,
      runRerun: async (_pool, cases) => cases.map(completed),
    },
  };
}

const scratch = (): string =>
  mkdtempSync(join(tmpdir(), "qa-matrix-archives-"));

/** Writes a file shaped exactly like a real archive for that run. */
function writeArchive(
  directory: string,
  runId: string,
  suffix = "20260909",
): void {
  writeFileSync(
    join(directory, `backtest-debug-${runId}-${suffix}.zip`),
    "not a real zip",
    "utf8",
  );
}

const PROVEN: readonly InvariantResult[] = [
  {
    id: 36,
    key: "trade-signal-evidence",
    title: "t",
    status: "PASS",
    detail: "",
  },
  {
    id: 37,
    key: "trigger-previous-row",
    title: "t",
    status: "PASS",
    detail: "",
  },
  {
    id: 38,
    key: "buy-window-boundaries",
    title: "t",
    status: "PASS",
    detail: "",
  },
];

const quiet = (
  phase: MatrixPhaseProviderTraffic["phase"],
): MatrixPhaseProviderTraffic => ({
  phase,
  total: 0,
  unattributed: 0,
  attributedToCases: 0,
});

describe("a full sweep captures nothing, and its golden reruns capture everything", () => {
  it("runs a thousand executions with archives off and six reruns with them on", async () => {
    const events: PoolEvent[] = [];
    const { ports, pools } = sweepPorts(CASES, GOLDEN, events);
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: CASES.length,
      goldenCases: GOLDEN.length,
      determinismEnabled: true,
    });
    expect([plan.mainPool, plan.rerunPool, plan.expectedArchives]).toEqual([
      "off",
      "full",
      6,
    ]);

    const sweep = await runMatrixSweep({
      selected: CASES,
      plan,
      determinismEnabled: true,
      now: () => 0,
      ports,
    });

    expect(sweep.results).toHaveLength(1_000);
    expect(sweep.rerunResults).toHaveLength(6);
    expect(events).toEqual([
      { kind: "start", phase: "main", debugArchive: "off" },
      { kind: "stop", phase: "main" },
      { kind: "start", phase: "rerun", debugArchive: "full" },
      { kind: "stop", phase: "rerun" },
    ]);
    // The pools are never alive at the same time. Both claim from the same queue, and a sweep pool
    // still running during the rerun took some of its jobs with capture off — which is how ten
    // archives appeared where six were planned.
    expect(pools.concurrentPools).toBe(1);
    expect([...sweep.archivedRuns.keys()].sort()).toEqual(
      GOLDEN.map((entry) => entry.caseId).sort(),
    );
    expect(sweep.expectedArchiveCaseIds).toHaveLength(6);
  });

  it("finds exactly six archives on disk, and the gate is green", async () => {
    const directory = scratch();
    const events: PoolEvent[] = [];
    const { ports } = sweepPorts(CASES, GOLDEN, events);
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: CASES.length,
      goldenCases: GOLDEN.length,
      determinismEnabled: true,
    });
    const sweep = await runMatrixSweep({
      selected: CASES,
      plan,
      determinismEnabled: true,
      now: () => 0,
      ports,
    });
    for (const runId of sweep.archivedRuns.values()) {
      writeArchive(directory, runId);
    }

    const archives = await auditMatrixArchives({
      directory,
      plan,
      archivedRuns: sweep.archivedRuns,
      expectedCaseIds: sweep.expectedArchiveCaseIds,
      ports: {
        countArchives,
        findArchive,
        verifyArchive: async () => PROVEN,
      },
    });

    expect(await countArchives(directory)).toBe(6);
    expect(archives.actual).toBe(6);
    expect(archives.expected).toBe(6);
    expect(archives.missing).toEqual([]);
    expect(archives.unreadable).toEqual([]);
    expect(archives.verification).toHaveLength(6);
    expect(gateOver(sweep, archives).green).toBe(true);
  });
});

describe("a single reproduction captures exactly one", () => {
  it("runs `--case Sxx-Lxx-Cxx --archive` with the main pool capturing and no rerun pool", async () => {
    // The case deliberately is **not** one of the golden six: the archive used to be produced and
    // then never verified, because only golden cases were recorded as archived.
    const one = CASES.filter(
      (entry) => !GOLDEN.some((golden) => golden.caseId === entry.caseId),
    ).slice(0, 1);
    expect(one).toHaveLength(1);

    const directory = scratch();
    const events: PoolEvent[] = [];
    const { ports } = sweepPorts(one, [], events);
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: 1,
      goldenCases: GOLDEN.length,
      determinismEnabled: true,
    });
    expect([plan.mainPool, plan.rerunPool, plan.expectedArchives]).toEqual([
      "full",
      "off",
      1,
    ]);

    const sweep = await runMatrixSweep({
      selected: one,
      plan,
      determinismEnabled: true,
      now: () => 0,
      ports,
    });
    expect(events).toEqual([
      { kind: "start", phase: "main", debugArchive: "full" },
      { kind: "stop", phase: "main" },
    ]);
    expect([...sweep.archivedRuns.keys()]).toEqual([one[0]!.caseId]);

    for (const runId of sweep.archivedRuns.values()) {
      writeArchive(directory, runId);
    }
    const archives = await auditMatrixArchives({
      directory,
      plan,
      archivedRuns: sweep.archivedRuns,
      expectedCaseIds: sweep.expectedArchiveCaseIds,
      ports: { countArchives, findArchive, verifyArchive: async () => PROVEN },
    });

    expect(archives.actual).toBe(1);
    expect(archives.verification).toHaveLength(1);
    expect(gateOver(sweep, archives, one).green).toBe(true);
  });
});

describe("a directory that does not match the plan fails the gate", () => {
  async function sweepWithArchives(
    write: (directory: string, runIds: readonly string[]) => void,
  ) {
    const directory = scratch();
    const events: PoolEvent[] = [];
    const { ports } = sweepPorts(CASES, GOLDEN, events);
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: CASES.length,
      goldenCases: GOLDEN.length,
      determinismEnabled: true,
    });
    const sweep = await runMatrixSweep({
      selected: CASES,
      plan,
      determinismEnabled: true,
      now: () => 0,
      ports,
    });
    write(directory, [...sweep.archivedRuns.values()]);
    const archives = await auditMatrixArchives({
      directory,
      plan,
      archivedRuns: sweep.archivedRuns,
      expectedCaseIds: sweep.expectedArchiveCaseIds,
      ports: { countArchives, findArchive, verifyArchive: async () => PROVEN },
    });
    return { archives, verdict: gateOver(sweep, archives) };
  }

  it("rejects a missing archive", async () => {
    const { archives, verdict } = await sweepWithArchives(
      (directory, runIds) => {
        for (const runId of runIds.slice(0, 5)) {
          writeArchive(directory, runId);
        }
      },
    );
    expect(archives.actual).toBe(5);
    expect(archives.missing).toHaveLength(1);
    expect(verdict.failures.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["ARCHIVE_COUNT", "ARCHIVE_MISSING"]),
    );
  });

  it("rejects an extra archive from a run nobody asked to capture", async () => {
    const { archives, verdict } = await sweepWithArchives(
      (directory, runIds) => {
        for (const runId of runIds) {
          writeArchive(directory, runId);
        }
        // The pool race, reproduced: a seventh file belonging to a run this sweep never planned.
        writeArchive(directory, "run-from-the-other-pool");
      },
    );
    expect(archives.actual).toBe(7);
    expect(archives.missing).toEqual([]);
    expect(verdict.failures.map((entry) => entry.code)).toContain(
      "ARCHIVE_COUNT",
    );
  });

  it("rejects a duplicate archive for the same run", async () => {
    const { archives, verdict } = await sweepWithArchives(
      (directory, runIds) => {
        for (const runId of runIds) {
          writeArchive(directory, runId);
        }
        // Two captures of the same attempt: the case still verifies, and the count still does not.
        writeArchive(directory, runIds[0] as string, "20260910");
      },
    );
    expect(archives.actual).toBe(7);
    expect(archives.verification).toHaveLength(6);
    expect(verdict.failures.map((entry) => entry.code)).toContain(
      "ARCHIVE_COUNT",
    );
  });

  it("rejects an archive that cannot be read", async () => {
    const directory = scratch();
    const events: PoolEvent[] = [];
    const { ports } = sweepPorts(CASES, GOLDEN, events);
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: CASES.length,
      goldenCases: GOLDEN.length,
      determinismEnabled: true,
    });
    const sweep = await runMatrixSweep({
      selected: CASES,
      plan,
      determinismEnabled: true,
      now: () => 0,
      ports,
    });
    for (const runId of sweep.archivedRuns.values()) {
      writeArchive(directory, runId);
    }
    let first = true;
    const archives = await auditMatrixArchives({
      directory,
      plan,
      archivedRuns: sweep.archivedRuns,
      expectedCaseIds: sweep.expectedArchiveCaseIds,
      ports: {
        countArchives,
        findArchive,
        verifyArchive: async () => {
          if (first) {
            first = false;
            throw new Error("zip: unexpected end of file");
          }
          return PROVEN;
        },
      },
    });

    expect(archives.unreadable).toHaveLength(1);
    expect(archives.verification).toHaveLength(5);
    const verdict = gateOver(sweep, archives);
    expect(verdict.failures.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["ARCHIVE_UNREADABLE", "ARCHIVE_UNVERIFIED"]),
    );
  });
});

function gateOver(
  sweep: Awaited<ReturnType<typeof runMatrixSweep>>,
  archives: Awaited<ReturnType<typeof auditMatrixArchives>>,
  selected: readonly (typeof CASES)[number][] = CASES,
) {
  return evaluateMatrixGate({
    selectedCaseIds: selected.map((entry) => entry.caseId),
    results: sweep.results,
    aggregate: aggregateMatrixResults(sweep.results, selected.length, 1_000),
    provider: {
      warmup: quiet("warmup"),
      main: sweep.mainTraffic,
      rerun: sweep.rerunTraffic,
    },
    determinismRequested: sweep.rerunCaseIds.length > 0,
    requiredRerunCaseIds: sweep.rerunCaseIds,
    rerunResults: sweep.rerunResults,
    determinismDifferences: [],
    archives,
  });
}
