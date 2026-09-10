import { execFileSync } from "node:child_process";
import { getQaPersonaConfig, loadRootEnv } from "@intrinsic/config";
import { isLocalDate } from "@intrinsic/contracts";
import { BACKTEST_DATA_REVISIONS } from "@intrinsic/stock-data";
import { BACKTEST_METHODOLOGY } from "@intrinsic/strategy";
import { currentAsOfDate, qaMatrixFixtures } from "@intrinsic/testing";
import { loadQaMatrixExecutionCalendar } from "./qa-matrix/seed-qa-matrix";
import {
  qaMatrixCases,
  qaMatrixGoldenCases,
  qaMatrixWarmupCases,
  selectQaMatrixCases,
  QA_MATRIX_TOTAL_CASES,
  type QaMatrixCase,
} from "./qa-matrix/matrix-case";
import { findArchive, readArchive, verifyArchiveInvariants } from "./qa-matrix/matrix-archive";
import { planMatrixArchives } from "./qa-matrix/matrix-archive-plan";
import { cleanupMatrixRuns } from "./qa-matrix/matrix-cleanup";
import { resolveMatrixConcurrency } from "./qa-matrix/matrix-concurrency";
import { useMatrixDatabase } from "./qa-matrix/matrix-environment";
import {
  awaitTerminalRun,
  collectRunEvidence,
  createMatrixExecutionContext,
  MatrixSeriesCache,
  resolveMatrixFixtureIds,
  submitMatrixCase,
} from "./qa-matrix/matrix-execution";
import {
  validateRunInvariants,
  type InvariantResult,
  type RunEvidence,
} from "./qa-matrix/matrix-invariants";
import { matrixReportRoot, repositoryRoot } from "./qa-matrix/matrix-paths";
import {
  formatPreflightReport,
  runQaMatrixPreflight,
} from "./qa-matrix/matrix-preflight";
import {
  MatrixReportWriter,
  renderMatrixReport,
  type MatrixManifest,
} from "./qa-matrix/matrix-report";
import {
  aggregateMatrixResults,
  compareForDeterminism,
  runMatrixCases,
  type MatrixCaseResult,
  type MatrixRunnerPorts,
} from "./qa-matrix/matrix-runner";
import { MatrixWorkerPool } from "./qa-matrix/matrix-worker-pool";

/**
 * `pnpm qa:matrix:run` — executes the Backtest V1 validation matrix.
 *
 * ```bash
 * pnpm qa:matrix:run                        # all 1,000 combinations
 * pnpm qa:matrix:run --case S03-L07-C04     # exactly one, reproducing a failure
 * pnpm qa:matrix:run --golden --archive     # the golden set with forensic archives
 * pnpm qa:matrix:run --concurrency 2        # override the machine-derived default
 * ```
 *
 * The preflight runs first and is not bypassable: nothing is submitted if it fails. Previous
 * QA-MATRIX runs belonging to the QA persona are deleted **before** execution, never after, so a
 * failed sweep stays inspectable until its report is written.
 */

type Flags = {
  readonly cases: readonly string[];
  readonly concurrency: string | undefined;
  readonly archive: boolean;
  readonly golden: boolean;
  readonly determinism: boolean;
  readonly cleanup: boolean;
  readonly warmup: boolean;
  readonly timeoutSeconds: number;
};

function parseFlags(argv: readonly string[]): Flags {
  const cases: string[] = [];
  let concurrency: string | undefined;
  let archive = false;
  let golden = false;
  let determinism = true;
  let cleanup = true;
  let warmup = true;
  let timeoutSeconds = 45 * 60;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`\`${arg}\` needs a value.`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--case":
        cases.push(...next().split(",").map((entry) => entry.trim()).filter(Boolean));
        break;
      case "--concurrency":
        concurrency = next();
        break;
      case "--archive":
        archive = true;
        break;
      case "--golden":
        golden = true;
        break;
      case "--no-determinism":
        determinism = false;
        break;
      case "--no-cleanup":
        cleanup = false;
        break;
      case "--no-warmup":
        warmup = false;
        break;
      case "--timeout":
        timeoutSeconds = Number(next());
        break;
      default:
        throw new Error(
          `Unknown option \`${arg}\`. Supported: --case, --concurrency, --archive, --golden, ` +
            "--no-determinism, --no-cleanup, --no-warmup, --timeout.",
        );
    }
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  return {
    cases,
    concurrency,
    archive,
    golden,
    determinism,
    cleanup,
    warmup,
    timeoutSeconds,
  };
}

function gitMetadata(root: string): { commit: string | null; branch: string | null } {
  const read = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: read(["rev-parse", "--short", "HEAD"]),
    branch: read(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

function matrixExecutionId(asOfDate: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  return `${asOfDate}-${stamp}`;
}

/**
 * Ports for the warm-up phase: the same real submission and execution path, with the results
 * deliberately unexamined. Warming is about what ends up in Redis, not about what the runs computed.
 */
function warmupPorts(
  context: Awaited<ReturnType<typeof createMatrixExecutionContext>>,
  ids: Awaited<ReturnType<typeof resolveMatrixFixtureIds>>,
  prisma: (typeof context)["prisma"],
  series: MatrixSeriesCache,
  timeoutSeconds: number,
): MatrixRunnerPorts {
  return {
    submit: (matrixCase) => submitMatrixCase(context, ids, matrixCase),
    awaitTerminal: (runId) =>
      awaitTerminalRun(prisma, runId, {
        timeoutMs: timeoutSeconds * 1000,
        pollIntervalMs: 500,
      }),
    collectEvidence: (runId, matrixCase) =>
      collectRunEvidence(prisma, series, runId, matrixCase.caseId),
    validate: () => [],
    providerRequestsFor: () => null,
    onCaseSettled: (result) => {
      console.log(
        `  warm ${result.caseId} ${result.outcome} ${Math.round(result.durationMs / 1000)}s`,
      );
    },
    now: () => Date.now(),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  loadRootEnv();
  const environment = useMatrixDatabase();
  const root = repositoryRoot();

  const pinned = process.env.QA_MATRIX_AS_OF_DATE?.trim();
  if (pinned && !isLocalDate(pinned)) {
    throw new Error(
      `QA_MATRIX_AS_OF_DATE must be a valid YYYY-MM-DD date; received \`${pinned}\``,
    );
  }
  const asOfDate = pinned || currentAsOfDate();
  const concurrency = resolveMatrixConcurrency(flags.concurrency);

  const context = await createMatrixExecutionContext();
  const prisma = context.prisma;
  const ownerEmail = getQaPersonaConfig().user.email;

  const executionId = matrixExecutionId(asOfDate);
  const writer = new MatrixReportWriter(matrixReportRoot(root), executionId);

  let pool: MatrixWorkerPool | null = null;
  let sweepProviderRequests: ReturnType<MatrixWorkerPool["providerRequests"]> | null =
    null;
  try {
    const calendarDates = await loadQaMatrixExecutionCalendar(prisma).catch(
      () => [] as string[],
    );
    const fixtures = qaMatrixFixtures(
      asOfDate,
      calendarDates.length > 0 ? calendarDates : undefined,
    );

    // ---- Preflight. Nothing is submitted if it is not green. -------------------------------
    const preflight = await runQaMatrixPreflight({
      prisma,
      environment,
      fixtures,
      asOfDate,
      ownerEmail,
      today: currentAsOfDate(),
      repositoryRoot: root,
    });
    const preflightText = formatPreflightReport(preflight);
    console.log(preflightText);
    writer.writePreflight(preflight, preflightText);
    if (!preflight.ok) {
      console.error(
        "\nRefusing to start the matrix: preflight failed. No backtest was submitted.",
      );
      process.exitCode = 1;
      return;
    }

    // ---- Selection ---------------------------------------------------------------------------
    const allCases = qaMatrixCases(fixtures);
    const golden = qaMatrixGoldenCases(allCases);
    const selected: readonly QaMatrixCase[] = flags.golden
      ? golden
      : selectQaMatrixCases(allCases, flags.cases);

    const ids = await resolveMatrixFixtureIds(prisma, ownerEmail, fixtures);
    const series = new MatrixSeriesCache(prisma);

    // ---- Warm-up: move first-touch hydration out of the timed sweep -------------------------
    // Serial on purpose. Several processes hydrating overlapping universes from an empty cache can
    // expire a Redlock lease mid-hydration, which surfaces as EXECUTION_FAILED in PREPARING_DATA on
    // a run that has nothing wrong with it. One process cannot race itself.
    if (flags.warmup && selected.length > 1 && concurrency > 1) {
      const warmupCases = qaMatrixWarmupCases(allCases);
      console.log(
        `Warming canonical data with ${warmupCases.length} serial run(s) over ` +
          `${warmupCases.map((entry) => entry.listId).join(", ")}…`,
      );
      const warmPool = new MatrixWorkerPool({
        environment,
        repositoryRoot: root,
        processes: 1,
        debugArchive: "off",
      });
      warmPool.start();
      try {
        await runMatrixCases(
          warmupCases,
          warmupPorts(context, ids, prisma, series, flags.timeoutSeconds),
          { concurrency: 1 },
        );
      } finally {
        await warmPool.stop();
      }
      console.log(
        `Warm-up complete; ${warmPool.providerRequests().total} provider request(s).\n`,
      );
    }

    // ---- Retention: clean before executing, never after -------------------------------------
    // After the warm-up, so its runs — which are not this sweep's output — are removed with the
    // previous sweep's rather than lingering in the QA account.
    if (flags.cleanup) {
      const cleaned = await cleanupMatrixRuns(prisma, ids.ownerUserId);
      console.log(
        `Cleaned ${cleaned.deleted} previous QA-MATRIX run(s) from the QA account.\n`,
      );
    }

    const manifest: MatrixManifest = {
      matrixExecutionId: executionId,
      startedAt: new Date().toISOString(),
      asOfDate,
      database: environment.databaseName,
      redisDb: environment.redisDb,
      concurrency,
      expectedCases: QA_MATRIX_TOTAL_CASES,
      selectedCases: selected.length,
      selection: flags.cases.length > 0 || flags.golden
        ? selected.map((entry) => entry.caseId)
        : null,
      debugArchive: flags.archive ? "full" : "off",
      goldenCases: golden.map((entry) => entry.caseId),
      dataRevisions: { ...BACKTEST_DATA_REVISIONS },
      methodology: { ...BACKTEST_METHODOLOGY },
      git: gitMetadata(root),
      executionCalendar: {
        sessions: fixtures.calendar.length,
        from: fixtures.calendar.first ?? null,
        to: fixtures.calendar.last ?? null,
      },
    };
    writer.writeManifest(manifest);

    // ---- Execution -----------------------------------------------------------------------------
    // Archives are a worker-process setting, so a pool either captures every attempt it executes
    // or none. A thousand full archives is a disk-space incident rather than a validation
    // strategy, so the full sweep runs with capture off and the golden set is captured by a
    // second, short-lived pool below. An explicit selection — `--case` or `--golden` — is already
    // small, so that pool captures directly and a single case yields exactly one archive.
    const archivePlan = planMatrixArchives({
      archiveRequested: flags.archive,
      selectedCases: selected.length,
      goldenCases: golden.length,
      determinismEnabled: flags.determinism,
    });
    const mainPoolArchives = archivePlan.mainPool === "full";
    if (flags.archive) {
      console.log(
        `Archives: expecting ${archivePlan.expectedArchives} — ${archivePlan.reason}.\n`,
      );
    }
    pool = new MatrixWorkerPool({
      environment,
      repositoryRoot: root,
      processes: concurrency,
      debugArchive: mainPoolArchives ? "full" : "off",
      debugArchiveDir: `${writer.directory}/archives`,
      onLogRecord: (record) => writer.writeWorkerLogLine(JSON.stringify(record)),
    });
    pool.start();

    const goldenIds = new Set(golden.map((entry) => entry.caseId));
    const goldenEvidence = new Map<string, RunEvidence>();
    let settled = 0;

    const ports: MatrixRunnerPorts = {
      submit: (matrixCase) => submitMatrixCase(context, ids, matrixCase),
      awaitTerminal: (runId) =>
        awaitTerminalRun(prisma, runId, {
          timeoutMs: flags.timeoutSeconds * 1000,
          pollIntervalMs: 500,
        }),
      collectEvidence: async (runId, matrixCase) => {
        const evidence = await collectRunEvidence(
          prisma,
          series,
          runId,
          matrixCase.caseId,
        );
        if (goldenIds.has(matrixCase.caseId)) {
          goldenEvidence.set(matrixCase.caseId, evidence);
        }
        return evidence;
      },
      validate: validateRunInvariants,
      providerRequestsFor: (runId) => pool?.providerRequestsFor(runId) ?? null,
      onCaseSettled: (result) => {
        writer.appendCase(result);
        settled += 1;
        const status = result.outcome === "COMPLETED" ? "ok" : result.outcome;
        console.log(
          `[${String(settled).padStart(4)}/${selected.length}] ${result.caseId} ${status} ` +
            `${Math.round(result.durationMs / 1000)}s trades=${result.tradeCount ?? "—"} ` +
            `equity=${result.equityRowCount ?? "—"}` +
            (result.failure ? ` :: ${result.failure.slice(0, 160)}` : ""),
        );
      },
      now: () => Date.now(),
    };

    const startedAt = Date.now();
    const results = await runMatrixCases(selected, ports, { concurrency });
    const durationMs = Date.now() - startedAt;

    // ---- Determinism: re-execute the golden subset from the same canonical data --------------
    // This is also where forensic capture happens for a full sweep: the same six combinations are
    // re-executed anyway, so archiving them here costs one extra pool rather than 994 extra zips.
    let determinism: {
      cases: string[];
      differences: { caseId: string; differences: readonly string[] }[];
    } | null = null;
    const archivedRuns = new Map<string, string>();
    if (mainPoolArchives) {
      for (const result of results) {
        if (result.runId && goldenIds.has(result.caseId)) {
          archivedRuns.set(result.caseId, result.runId);
        }
      }
    }

    const rerunnable = golden.filter((entry) => goldenEvidence.has(entry.caseId));
    if (flags.determinism && rerunnable.length > 0) {
      console.log(
        `\nRe-executing ${rerunnable.length} golden combination(s) to verify determinism…`,
      );
      // The sweep pool must be stopped first. Both pools claim from the same PostgreSQL queue, so
      // a still-running sweep pool will happily take some of the rerun's jobs — and if the two
      // disagree about capture, the archive count is whatever the race decided. Observed: ten
      // archives where six were planned.
      sweepProviderRequests = pool.providerRequests();
      await pool.stop();
      pool = null;
      const rerunArchives = archivePlan.rerunPool === "full";
      const rerunPool = new MatrixWorkerPool({
        environment,
        repositoryRoot: root,
        processes: concurrency,
        debugArchive: rerunArchives ? "full" : "off",
        debugArchiveDir: `${writer.directory}/archives`,
        onLogRecord: (record) => writer.writeWorkerLogLine(JSON.stringify(record)),
      });
      rerunPool.start();
      const second = new Map<string, RunEvidence>();
      const rerunPorts: MatrixRunnerPorts = {
        ...ports,
        providerRequestsFor: (runId) => rerunPool.providerRequestsFor(runId),
        collectEvidence: async (runId, matrixCase) => {
          const evidence = await collectRunEvidence(
            prisma,
            series,
            runId,
            matrixCase.caseId,
          );
          second.set(matrixCase.caseId, evidence);
          return evidence;
        },
        onCaseSettled: (result) => {
          if (rerunArchives && result.runId) {
            archivedRuns.set(result.caseId, result.runId);
          }
          console.log(`  rerun ${result.caseId} ${result.outcome}`);
        },
      };
      try {
        await runMatrixCases(rerunnable, rerunPorts, { concurrency });
      } finally {
        await rerunPool.stop();
      }
      determinism = {
        cases: rerunnable.map((entry) => entry.caseId),
        differences: rerunnable
          .map((entry) => ({
            caseId: entry.caseId,
            differences: compareForDeterminism(
              goldenEvidence.get(entry.caseId) as RunEvidence,
              second.get(entry.caseId) as RunEvidence,
            ),
          }))
          .filter((entry) => entry.differences.length > 0),
      };
    }

    // ---- Forensic verification of the archived combinations ----------------------------------
    // The three invariants persisted results cannot settle — whether each BUY's Signal was actually
    // TRUE in the frame the day loop consumed, whether the row retained across a year boundary is
    // the one a Trigger read as `t - 1`, and whether every BUY fell inside a persisted window.
    const archiveResults = new Map<string, readonly InvariantResult[]>();
    for (const [caseId, runId] of archivedRuns) {
      const path = await findArchive(`${writer.directory}/archives`, runId);
      if (!path) {
        console.log(`  no archive found for ${caseId}`);
        continue;
      }
      const verified = verifyArchiveInvariants(await readArchive(path));
      archiveResults.set(caseId, verified);
      const failedHere = verified.filter((entry) => entry.status === "FAIL");
      console.log(
        `  archive ${caseId}: ${verified.length - failedHere.length}/${verified.length} ` +
          `frame-level invariants proven` +
          (failedHere.length > 0
            ? ` — ${failedHere.map((entry) => `#${entry.id} ${entry.key}`).join(", ")}`
            : ""),
      );
      for (const entry of failedHere) {
        for (const violation of entry.violations ?? []) {
          console.log(`      ${violation}`);
        }
      }
    }

    // ---- Reporting ------------------------------------------------------------------------------
    const aggregate = aggregateMatrixResults(
      results,
      selected.length,
      durationMs,
    );
    const coverageWarnings = preflight.checks
      .filter((entry) => entry.status === "WARN")
      .flatMap((entry) => entry.problems ?? [entry.detail]);

    const archiveVerification = [...archiveResults.entries()].map(
      ([caseId, invariants]) => ({
        caseId,
        invariants: invariants.map((entry) => ({
          id: entry.id,
          key: entry.key,
          status: entry.status,
          detail: entry.detail,
          violations: entry.violations ?? [],
        })),
      }),
    );

    writer.writeSummary({
      matrixExecutionId: executionId,
      ...aggregate,
      archiveVerification,
      determinism,
      coverageWarnings,
      providerRequestLedger: {
        total: sweepProviderRequests?.total ?? pool?.providerRequests().total ?? 0,
        unattributed:
          sweepProviderRequests?.unattributed ??
          pool?.providerRequests().unattributed ??
          0,
      },
    });
    writer.writeReport(
      renderMatrixReport({
        manifest,
        aggregate,
        results,
        determinism,
        coverageWarnings,
        archiveVerification,
      }),
    );

    const archiveFailures = archiveVerification.filter((entry) =>
      entry.invariants.some((invariant) => invariant.status === "FAIL"),
    ).length;

    reportToConsole(executionId, writer.directory, aggregate, results, determinism);
    if (archiveVerification.length > 0) {
      console.log(
        `archive-verified     ${archiveVerification.length} golden case(s), ${archiveFailures} with failures`,
      );
    }
    if (
      archiveFailures > 0 ||
      aggregate.failed > 0 ||
      aggregate.invariantFailures > 0 ||
      aggregate.runnerErrors > 0 ||
      (determinism?.differences.length ?? 0) > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool?.stop();
    await context.close();
  }
}

function reportToConsole(
  executionId: string,
  directory: string,
  aggregate: ReturnType<typeof aggregateMatrixResults>,
  results: readonly MatrixCaseResult[],
  determinism: { differences: { caseId: string }[] } | null,
): void {
  console.log("");
  console.log(`QA MATRIX ${executionId}`);
  console.log("=".repeat(40));
  console.log(`expected            ${aggregate.expected}`);
  console.log(`submitted           ${aggregate.submitted}`);
  console.log(`completed           ${aggregate.completed}`);
  console.log(`failed              ${aggregate.failed}`);
  console.log(`invariant failures  ${aggregate.invariantFailures}`);
  console.log(`runner errors       ${aggregate.runnerErrors}`);
  console.log(`duration            ${Math.round(aggregate.durationMs / 1000)}s`);
  console.log(
    `throughput          ${aggregate.throughputPerMinute.toFixed(2)} runs/min`,
  );
  console.log(`provider requests   ${aggregate.providerRequests}`);
  console.log(`zero-trade cases    ${aggregate.zeroTradeCases.length}`);
  if (determinism) {
    console.log(`determinism         ${determinism.differences.length} difference(s)`);
  }
  console.log("");
  const failures = results.filter((result) => result.outcome !== "COMPLETED");
  for (const failure of failures.slice(0, 20)) {
    console.log(`  FAIL ${failure.caseId} — ${failure.failure ?? failure.outcome}`);
  }
  if (failures.length > 20) {
    console.log(`  … ${failures.length - 20} more`);
  }
  console.log(`\nReport: ${directory}/report.md`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`\nQA matrix run failed: ${message}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
