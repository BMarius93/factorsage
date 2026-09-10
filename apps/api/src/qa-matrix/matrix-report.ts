import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MatrixGateVerdict } from "./matrix-gate";
import type { QaMatrixPreflightReport } from "./matrix-preflight";
import type { MatrixAggregate, MatrixCaseResult } from "./matrix-runner";

/**
 * The sweep's output: machine-readable first, human-readable second.
 *
 * A thousand results are not something anyone reads; they are something a tool queries and a person
 * skims. So the artefacts are split by how they are consumed — one JSON document for the identity
 * of the sweep, one NDJSON line per case for anything that wants to filter or count, one directory
 * of full detail for the failures a person will actually open, and one Markdown page that says what
 * happened.
 *
 * ```text
 * .debug/qa-matrix/<matrixExecutionId>/
 *   manifest.json      what this sweep was: clock, database, revisions, concurrency, selection
 *   cases.ndjson       one line per combination, written as it settles
 *   failures/          one JSON document per failing combination, with its invariant violations
 *   summary.json       the aggregate
 *   report.md          the page a reviewer reads
 *   worker.log         the worker's own structured stream, for provider-traffic forensics
 * ```
 *
 * `cases.ndjson` is appended **as each case settles**, not written at the end. A sweep that dies in
 * its ninth hour must leave behind what it had learned by then; a report that only exists on the
 * success path is a report that is missing exactly when it is most needed.
 */

export type MatrixManifest = {
  readonly matrixExecutionId: string;
  readonly startedAt: string;
  readonly asOfDate: string;
  readonly database: string;
  readonly redisDb: number;
  readonly concurrency: number;
  readonly expectedCases: number;
  readonly selectedCases: number;
  readonly selection: readonly string[] | null;
  readonly debugArchive: "off" | "full";
  readonly goldenCases: readonly string[];
  readonly dataRevisions: Record<string, unknown>;
  readonly methodology: Record<string, unknown>;
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
  };
  readonly executionCalendar: {
    readonly sessions: number;
    readonly from: string | null;
    readonly to: string | null;
  };
};

export class MatrixReportWriter {
  readonly directory: string;
  private casesStarted = false;

  constructor(baseDirectory: string, matrixExecutionId: string) {
    this.directory = join(baseDirectory, matrixExecutionId);
    mkdirSync(join(this.directory, "failures"), { recursive: true });
  }

  writeManifest(manifest: MatrixManifest): void {
    writeFileSync(
      join(this.directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  writePreflight(report: QaMatrixPreflightReport, text: string): void {
    writeFileSync(
      join(this.directory, "preflight.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(this.directory, "preflight.txt"), `${text}\n`, "utf8");
  }

  /** One line per case, appended the moment it settles. */
  appendCase(result: MatrixCaseResult): void {
    const path = join(this.directory, "cases.ndjson");
    if (!this.casesStarted) {
      writeFileSync(path, "", "utf8");
      this.casesStarted = true;
    }
    appendFileSync(path, `${JSON.stringify(caseLine(result))}\n`, "utf8");
    if (
      result.outcome !== "COMPLETED" &&
      result.outcome !== "TIMED_OUT" // a timeout writes its own detail below too
    ) {
      this.writeFailure(result);
    }
    if (result.outcome === "TIMED_OUT") {
      this.writeFailure(result);
    }
  }

  /**
   * The whole of a failing case, including the reproduction command.
   *
   * A failure that cannot be re-run is an anecdote. Every file here names the exact
   * `Sxx-Lxx-Cxx` and the command that re-executes precisely it, with the same pinned clock, so the
   * next step after reading is never "work out how to reproduce this".
   */
  writeFailure(result: MatrixCaseResult): void {
    writeFileSync(
      join(this.directory, "failures", `${result.caseId}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
  }

  writeWorkerLogLine(line: string): void {
    appendFileSync(join(this.directory, "worker.log"), `${line}\n`, "utf8");
  }

  writeSummary(summary: unknown): void {
    writeFileSync(
      join(this.directory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  }

  writeReport(markdown: string): void {
    writeFileSync(join(this.directory, "report.md"), markdown, "utf8");
  }
}

/** The per-case NDJSON record. Flat on purpose: it is meant to be grepped and loaded into a table. */
export function caseLine(result: MatrixCaseResult): Record<string, unknown> {
  return {
    caseId: result.caseId,
    label: result.label,
    index: result.index,
    runId: result.runId,
    strategy: result.strategyName,
    list: result.listName,
    config: result.configName,
    startDate: result.config.startDate,
    endDate: result.config.endDate,
    initialCapital: result.config.initialCapital,
    monthlyContribution: result.config.monthlyContribution,
    maximumPositions: result.config.maximumPositions,
    outcome: result.outcome,
    runStatus: result.runStatus,
    durationMs: result.durationMs,
    trades: result.tradeCount,
    equityRows: result.equityRowCount,
    finalValue: result.finalValue,
    invariantsPassed: result.invariantsPassed,
    invariantsFailed: result.invariantsFailed,
    invariantsIndeterminate: result.invariantsIndeterminate,
    invariantsNeedingArchive: result.invariantsNeedingArchive,
    providerRequests: result.providerRequests,
    failure: result.failure,
    failedInvariants: result.failedInvariants.map((entry) => ({
      id: entry.id,
      key: entry.key,
      violations: entry.violations ?? [],
    })),
  };
}

const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const money = (value: number | null): string =>
  value === null
    ? "—"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

/**
 * The human report.
 *
 * Ordered by what a reader needs in the order they need it: whether the sweep is green, what failed,
 * what the failures were, and only then the distribution. A zero-trade case is presented as an
 * observation and never as a failure, because a sparse strategy over a short period legitimately
 * does nothing — and reporting that as red would train a reader to ignore red.
 */
export function renderMatrixReport(input: {
  readonly manifest: MatrixManifest;
  readonly aggregate: MatrixAggregate;
  readonly results: readonly MatrixCaseResult[];
  readonly determinism: {
    readonly cases: readonly string[];
    readonly differences: readonly {
      caseId: string;
      differences: readonly string[];
    }[];
  } | null;
  readonly coverageWarnings: readonly string[];
  /** Frame-level verdicts for the archived golden combinations, when archives were captured. */
  readonly archiveVerification?: readonly {
    readonly caseId: string;
    readonly invariants: readonly {
      readonly id: number;
      readonly key: string;
      readonly status: string;
      readonly detail: string;
      readonly violations: readonly string[];
    }[];
  }[];
  /**
   * The verdict, decided by `evaluateMatrixGate` and never recomputed here.
   *
   * The report used to decide for itself, with a shorter list of conditions than the exit code
   * used — so a sweep could print GREEN and exit non-zero, or worse, print GREEN over four hundred
   * provider requests and ten unplanned archives. There is one verdict now and this renders it.
   */
  readonly gate: MatrixGateVerdict;
}): string {
  const {
    manifest,
    aggregate,
    results,
    determinism,
    coverageWarnings,
    archiveVerification = [],
    gate,
  } = input;
  const failures = results.filter((result) => result.outcome !== "COMPLETED");

  const lines: string[] = [];
  lines.push(`# QA Matrix — ${manifest.matrixExecutionId}`);
  lines.push("");
  lines.push(
    gate.green
      ? `**GREEN.** ${aggregate.completed} of ${aggregate.expected} combinations completed, every ` +
          "invariant reconciled, and every mandatory gate condition was enforced and met."
      : `**NOT GREEN.** ${gate.failures.length} mandatory condition(s) were not met.`,
  );
  lines.push("");
  if (!gate.green) {
    lines.push("| Condition | Detail |");
    lines.push("| --- | --- |");
    for (const failure of gate.failures) {
      lines.push(
        `| \`${failure.code}\` | ${failure.detail.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| Clock | \`${manifest.asOfDate}\` |`);
  lines.push(`| Database | \`${manifest.database}\` |`);
  lines.push(`| Redis | database ${manifest.redisDb} |`);
  lines.push(`| Concurrency | ${manifest.concurrency} worker processes |`);
  lines.push(
    `| Commit | \`${manifest.git.commit ?? "—"}\`${manifest.git.branch ? ` (${manifest.git.branch})` : ""} |`,
  );
  lines.push(
    `| Execution calendar | ${manifest.executionCalendar.sessions} sessions, ${manifest.executionCalendar.from ?? "—"} → ${manifest.executionCalendar.to ?? "—"} |`,
  );
  lines.push("");

  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Total expected | ${aggregate.expected} |`);
  lines.push(`| Submitted | ${aggregate.submitted} |`);
  lines.push(`| Completed | ${aggregate.completed} |`);
  lines.push(`| Failed | ${aggregate.failed} |`);
  lines.push(`| Invariant failures | ${aggregate.invariantFailures} |`);
  lines.push(`| Invariants undecided | ${aggregate.invariantIndeterminates} |`);
  lines.push(`| Runner errors | ${aggregate.runnerErrors} |`);
  lines.push(`| Duration | ${duration(aggregate.durationMs)} |`);
  lines.push(
    `| Throughput | ${aggregate.throughputPerMinute.toFixed(2)} runs/minute |`,
  );
  lines.push(
    `| Trades persisted | ${aggregate.totalTrades.toLocaleString("en-US")} |`,
  );
  lines.push(
    `| Equity rows persisted | ${aggregate.totalEquityRows.toLocaleString("en-US")} |`,
  );
  lines.push(
    `| Provider requests (warm-up + main + rerun) | ${gate.providerRequestsTotal} |`,
  );
  lines.push("");

  if (gate.providerRequestsTotal > 0) {
    lines.push(
      "> **Provider traffic during execution.** The matrix runs against a pinned copy of canonical " +
        "data and should reach FMP zero times. Any request here means a coverage gap the preflight " +
        "did not see, and it makes the affected runs dependent on live data.",
    );
    lines.push("");
    for (const entry of aggregate.providerRequestsByCase.slice(0, 20)) {
      lines.push(`- \`${entry.caseId}\` — ${entry.requests} request(s)`);
    }
    lines.push("");
  }

  if (coverageWarnings.length > 0) {
    lines.push("## Data-coverage warnings");
    lines.push("");
    for (const warning of coverageWarnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  if (failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    lines.push(
      "Every failing combination is reproducible on its own. `failures/<case>.json` holds the whole record.",
    );
    lines.push("");
    lines.push("| Case | Run | Outcome | Detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const failure of failures.slice(0, 60)) {
      lines.push(
        `| \`${failure.caseId}\` | \`${failure.runId ?? "—"}\` | ${failure.outcome} | ${(
          failure.failure ?? ""
        )
          .replace(/\|/g, "\\|")
          .slice(0, 180)} |`,
      );
    }
    if (failures.length > 60) {
      lines.push(`| … | | | ${failures.length - 60} more |`);
    }
    lines.push("");
    lines.push("Reproduce one:");
    lines.push("");
    lines.push("```bash");
    lines.push(
      `QA_MATRIX_AS_OF_DATE=${manifest.asOfDate} pnpm qa:matrix:run --case ${
        failures[0]?.caseId ?? "S01-L01-C01"
      } --archive`,
    );
    lines.push("```");
    lines.push("");
  }

  if (archiveVerification.length > 0) {
    lines.push("## Frame-level verification (golden combinations)");
    lines.push("");
    lines.push(
      "Three invariants cannot be settled from persisted results: whether each BUY's Signal was " +
        "actually TRUE in the evaluation frame the day loop consumed, whether the row retained " +
        "across a year boundary is the one a Trigger read as `t - 1`, and whether every BUY fell " +
        "inside a persisted buy window. The frames are released at the end of each calendar-year " +
        "window and persisted nowhere, so these are proven from the forensic archive, for the " +
        "golden combinations only — and by re-deriving the product grammar rather than by calling " +
        "the evaluator, which would agree with every bug it exists to find.",
    );
    lines.push("");
    lines.push("| Case | #36 Signal | #37 `t - 1` | #38 Buy window |");
    lines.push("| --- | --- | --- | --- |");
    for (const entry of archiveVerification) {
      const cell = (id: number): string => {
        const invariant = entry.invariants.find((value) => value.id === id);
        if (!invariant) {
          return "—";
        }
        return invariant.status === "PASS"
          ? `pass — ${invariant.detail.replace(/\|/g, "\\|").slice(0, 90)}`
          : `**FAIL** — ${invariant.violations[0]?.replace(/\|/g, "\\|").slice(0, 90) ?? ""}`;
      };
      lines.push(
        `| \`${entry.caseId}\` | ${cell(36)} | ${cell(37)} | ${cell(38)} |`,
      );
    }
    lines.push("");
  }

  if (determinism) {
    lines.push("## Determinism");
    lines.push("");
    if (determinism.differences.length === 0) {
      lines.push(
        `Re-executed ${determinism.cases.length} representative combinations from the same canonical ` +
          "data. Trades, equity, final positions and summary were identical in every one; run ids, " +
          "worker assignment and timings were not compared.",
      );
    } else {
      lines.push(
        `**${determinism.differences.length} of ${determinism.cases.length} re-executed combinations ` +
          "did not reproduce.**",
      );
      lines.push("");
      for (const entry of determinism.differences) {
        lines.push(`- \`${entry.caseId}\`: ${entry.differences.join("; ")}`);
      }
    }
    lines.push("");
  }

  lines.push("## Distribution");
  lines.push("");
  lines.push(
    `${aggregate.zeroTradeCases.length} combination(s) produced no trades. That is not a failure: ` +
      "`S06` is a deliberately sparse confluence strategy and `C03`/`C04` are short periods, so a " +
      "run with nothing to do is the expected outcome and is reported rather than flagged.",
  );
  lines.push("");
  if (aggregate.zeroTradeCases.length > 0) {
    lines.push(
      `<details><summary>Zero-trade combinations (${aggregate.zeroTradeCases.length})</summary>`,
    );
    lines.push("");
    lines.push(aggregate.zeroTradeCases.map((id) => `\`${id}\``).join(", "));
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("### Highest trade counts");
  lines.push("");
  lines.push("| Case | Trades |");
  lines.push("| --- | --- |");
  for (const entry of aggregate.highestTradeCases) {
    lines.push(
      `| \`${entry.caseId}\` | ${entry.trades.toLocaleString("en-US")} |`,
    );
  }
  lines.push("");

  lines.push("### Slowest combinations");
  lines.push("");
  lines.push("| Case | Duration |");
  lines.push("| --- | --- |");
  for (const entry of aggregate.slowestCases) {
    lines.push(`| \`${entry.caseId}\` | ${duration(entry.durationMs)} |`);
  }
  lines.push("");

  const completed = results.filter((result) => result.outcome === "COMPLETED");
  if (completed.length > 0) {
    lines.push("### Sample of completed combinations");
    lines.push("");
    lines.push(
      "| Case | Run | Trades | Equity rows | Final value | Invariants |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const result of completed.slice(0, 15)) {
      lines.push(
        `| \`${result.caseId}\` | \`${(result.runId ?? "").slice(0, 8)}\` | ${
          result.tradeCount ?? "—"
        } | ${result.equityRowCount ?? "—"} | ${money(result.finalValue)} | ${
          result.invariantsPassed
        } passed, ${result.invariantsNeedingArchive} archive-only |`,
      );
    }
    lines.push("");
  }

  lines.push("## Artefacts");
  lines.push("");
  lines.push("```text");
  lines.push(`.debug/qa-matrix/${manifest.matrixExecutionId}/`);
  lines.push("  manifest.json    the identity of this sweep");
  lines.push(
    "  preflight.json   the gate that had to be green before anything ran",
  );
  lines.push(
    "  cases.ndjson     one line per combination, appended as it settled",
  );
  lines.push("  failures/        one document per failing combination");
  lines.push("  summary.json     the aggregate above, machine-readable");
  lines.push("  report.md        this page");
  lines.push("  worker.log       the worker's structured stream");
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
