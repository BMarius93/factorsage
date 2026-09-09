import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  caseLine,
  MatrixReportWriter,
  renderMatrixReport,
  type MatrixManifest,
} from "./matrix-report";
import {
  aggregateMatrixResults,
  type MatrixCaseResult,
} from "./matrix-runner";

/**
 * The artefacts a sweep leaves behind.
 *
 * The property that matters most is that `cases.ndjson` is written **as each case settles**, not at
 * the end: a sweep that dies in its ninth hour must leave behind what it had learned, and a report
 * that only exists on the success path is missing exactly when it is needed.
 */

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "qa-matrix-report-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  directories.length = 0;
});

const MANIFEST: MatrixManifest = {
  matrixExecutionId: "2026-09-09-20260909-231500",
  startedAt: "2026-09-09T23:15:00.000Z",
  asOfDate: "2026-09-09",
  database: "intrinsic_value_matrix",
  redisDb: 3,
  concurrency: 3,
  expectedCases: 1_000,
  selectedCases: 1_000,
  selection: null,
  debugArchive: "off",
  goldenCases: ["S01-L02-C04"],
  dataRevisions: { priceDatasetVersion: 2, derivedStateRevision: 4 },
  methodology: { calendar: "execution-calendar-authoritative@2" },
  git: { commit: "abc1234", branch: "feat/qa-matrix-runner" },
  executionCalendar: { sessions: 7547, from: "1996-09-09", to: "2026-09-08" },
};

function result(
  overrides: Partial<MatrixCaseResult> & { caseId: string },
): MatrixCaseResult {
  return {
    label: `QA-MATRIX-${overrides.caseId}`,
    index: 0,
    strategyId: "S01",
    strategyName: "QA-MATRIX-S01-price-above-sma200-hold",
    listId: "L02",
    listName: "QA-MATRIX-L02-small-old-full",
    configId: "C01",
    configName: "QA-MATRIX-C01-thirty-year-baseline",
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
    durationMs: 42_000,
    submittedAt: "2026-09-09T23:15:00.000Z",
    tradeCount: 128,
    equityRowCount: 7_547,
    finalValue: 812_345.67,
    invariantsPassed: 38,
    invariantsFailed: 0,
    invariantsNeedingArchive: 2,
    providerRequests: 0,
    failure: null,
    failedInvariants: [],
    ...overrides,
  };
}

describe("incremental case output", () => {
  it("appends one NDJSON line per case as it settles", () => {
    const writer = new MatrixReportWriter(scratch(), MANIFEST.matrixExecutionId);
    writer.appendCase(result({ caseId: "S01-L01-C01" }));
    writer.appendCase(result({ caseId: "S01-L01-C02", tradeCount: 0 }));

    const lines = readFileSync(join(writer.directory, "cases.ndjson"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]?.caseId).toBe("S01-L01-C01");
    expect(parsed[1]?.trades).toBe(0);
    expect(parsed[0]?.runId).toBe("run-S01-L01-C01");
  });

  it("writes a document per failing case, so each one is inspectable on its own", () => {
    const writer = new MatrixReportWriter(scratch(), MANIFEST.matrixExecutionId);
    writer.appendCase(result({ caseId: "S01-L01-C01" }));
    writer.appendCase(
      result({
        caseId: "S04-L09-C06",
        outcome: "INVARIANT_FAILED",
        invariantsFailed: 1,
        failure: "1 invariant(s) failed: #18 buy-sizing",
        failedInvariants: [
          {
            id: 18,
            key: "buy-sizing",
            title: "BUY sizing",
            status: "FAIL",
            detail: "1 violation",
            violations: ["#3 AAPL 2004-02-02 level 50%: spent 1.00 …"],
          },
        ],
      }),
    );

    const failures = readdirSync(join(writer.directory, "failures"));
    expect(failures).toEqual(["S04-L09-C06.json"]);
    const document = JSON.parse(
      readFileSync(join(writer.directory, "failures", "S04-L09-C06.json"), "utf8"),
    ) as MatrixCaseResult;
    expect(document.failedInvariants[0]?.key).toBe("buy-sizing");
    expect(document.config.startDate).toBe("1996-09-09");
  });

  it("writes a failure document for a timed-out case too", () => {
    const writer = new MatrixReportWriter(scratch(), MANIFEST.matrixExecutionId);
    writer.appendCase(
      result({ caseId: "S10-L08-C10", outcome: "TIMED_OUT", failure: "Still RUNNING" }),
    );
    expect(existsSync(join(writer.directory, "failures", "S10-L08-C10.json"))).toBe(true);
  });

  it("writes the manifest, preflight, summary and report to their own files", () => {
    const writer = new MatrixReportWriter(scratch(), MANIFEST.matrixExecutionId);
    writer.writeManifest(MANIFEST);
    writer.writePreflight(
      {
        ok: true,
        generatedAt: "2026-09-09T23:15:00.000Z",
        asOfDate: "2026-09-09",
        database: "intrinsic_value_matrix",
        redis: "db 3",
        checks: [],
        failed: 0,
        warned: 0,
      },
      "PREFLIGHT GREEN",
    );
    writer.writeSummary({ completed: 1 });
    writer.writeReport("# report\n");
    for (const file of [
      "manifest.json",
      "preflight.json",
      "preflight.txt",
      "summary.json",
      "report.md",
    ]) {
      expect(existsSync(join(writer.directory, file))).toBe(true);
    }
    const manifest = JSON.parse(
      readFileSync(join(writer.directory, "manifest.json"), "utf8"),
    ) as MatrixManifest;
    expect(manifest.matrixExecutionId).toBe(MANIFEST.matrixExecutionId);
    expect(manifest.executionCalendar.sessions).toBe(7_547);
  });
});

describe("the per-case record", () => {
  it("is flat, so it can be grepped and loaded into a table", () => {
    const line = caseLine(result({ caseId: "S03-L07-C04" }));
    expect(Object.values(line).every((value) => typeof value !== "object" || value === null || Array.isArray(value))).toBe(true);
    expect(line).toMatchObject({
      caseId: "S03-L07-C04",
      strategy: "QA-MATRIX-S01-price-above-sma200-hold",
      finalValue: 812_345.67,
      providerRequests: 0,
    });
  });
});

describe("the human report", () => {
  const render = (results: readonly MatrixCaseResult[], determinism = null) =>
    renderMatrixReport({
      manifest: MANIFEST,
      aggregate: aggregateMatrixResults(results, 1_000, 3_600_000),
      results,
      determinism,
      coverageWarnings: [],
    });

  it("declares a clean sweep green and names the environment", () => {
    const markdown = render([result({ caseId: "S01-L01-C01" })]);
    expect(markdown).toContain("**GREEN.**");
    expect(markdown).toContain("intrinsic_value_matrix");
    expect(markdown).toContain("| Total expected | 1000 |");
    expect(markdown).toContain("abc1234");
  });

  it("does not call a zero-trade run a failure", () => {
    const markdown = render([
      result({ caseId: "S06-L01-C03", tradeCount: 0 }),
      result({ caseId: "S01-L01-C01" }),
    ]);
    expect(markdown).toContain("**GREEN.**");
    expect(markdown).toContain("That is not a failure");
    expect(markdown).toContain("`S06-L01-C03`");
  });

  it("lists failures with a command that reproduces one exactly", () => {
    const markdown = render([
      result({
        caseId: "S04-L09-C06",
        outcome: "FAILED",
        runStatus: "FAILED",
        failure: "PROVIDER_UNAVAILABLE in PREPARING_DATA",
      }),
    ]);
    expect(markdown).toContain("**NOT GREEN.**");
    expect(markdown).toContain("PROVIDER_UNAVAILABLE");
    expect(markdown).toContain(
      "QA_MATRIX_AS_OF_DATE=2026-09-09 pnpm qa:matrix:run --case S04-L09-C06 --archive",
    );
  });

  it("flags any provider traffic, because zero is the expectation", () => {
    const markdown = render([
      result({ caseId: "S01-L01-C01", providerRequests: 7 }),
    ]);
    expect(markdown).toContain("Provider traffic during execution");
    expect(markdown).toContain("`S01-L01-C01` — 7 request(s)");
  });

  it("reports determinism as a separate verdict", () => {
    const clean = renderMatrixReport({
      manifest: MANIFEST,
      aggregate: aggregateMatrixResults([result({ caseId: "A" })], 1, 1_000),
      results: [result({ caseId: "A" })],
      determinism: { cases: ["S01-L02-C04"], differences: [] },
      coverageWarnings: [],
    });
    expect(clean).toContain("were identical in every one");
    expect(clean).toContain("**GREEN.**");

    const drifted = renderMatrixReport({
      manifest: MANIFEST,
      aggregate: aggregateMatrixResults([result({ caseId: "A" })], 1, 1_000),
      results: [result({ caseId: "A" })],
      determinism: {
        cases: ["S01-L02-C04"],
        differences: [{ caseId: "S01-L02-C04", differences: ["trade #4 shares: 1 vs 2"] }],
      },
      coverageWarnings: [],
    });
    expect(drifted).toContain("did not reproduce");
    expect(drifted).toContain("**NOT GREEN.**");
  });

  it("carries data-coverage warnings through from the preflight", () => {
    const markdown = renderMatrixReport({
      manifest: MANIFEST,
      aggregate: aggregateMatrixResults([result({ caseId: "A" })], 1, 1_000),
      results: [result({ caseId: "A" })],
      determinism: null,
      coverageWarnings: ["2 securities carry no financial statements (MRNA, V)"],
    });
    expect(markdown).toContain("## Data-coverage warnings");
    expect(markdown).toContain("MRNA, V");
  });
});

describe("frame-level verification in the report", () => {
  type ArchiveVerification = NonNullable<
    Parameters<typeof renderMatrixReport>[0]["archiveVerification"]
  >;
  const passing: ArchiveVerification = [
    {
      caseId: "S01-L02-C04",
      invariants: [
        { id: 36, key: "trade-signal-evidence", status: "PASS", detail: "3 BUY(s) re-derived TRUE", violations: [] },
        { id: 37, key: "trigger-previous-row", status: "PASS", detail: "0 year boundaries", violations: [] },
        { id: 38, key: "buy-window-boundaries", status: "PASS", detail: "0 BUY(s) on an endpoint", violations: [] },
      ],
    },
  ];

  const render = (archiveVerification: ArchiveVerification): string =>
    renderMatrixReport({
      manifest: MANIFEST,
      aggregate: aggregateMatrixResults([result({ caseId: "S01-L02-C04" })], 1, 1_000),
      results: [result({ caseId: "S01-L02-C04" })],
      determinism: null,
      coverageWarnings: [],
      archiveVerification,
    });

  it("says what the archive proved that the database could not", () => {
    const markdown = render(passing);
    expect(markdown).toContain("## Frame-level verification");
    expect(markdown).toContain("rather than by calling the evaluator");
    expect(markdown).toContain("3 BUY(s) re-derived TRUE");
    expect(markdown).toContain("**GREEN.**");
  });

  it("is not green when a frame-level invariant failed, even if every run completed", () => {
    const markdown = render([
      {
        caseId: "S01-L02-C04",
        invariants: [
          {
            id: 36,
            key: "trade-signal-evidence",
            status: "FAIL",
            detail: "1 violation",
            violations: ["#4 AAPL 2024-03-01 level 100%: the Signal re-derived is FALSE, not TRUE."],
          },
          ...(passing[0] as ArchiveVerification[number]).invariants.slice(1),
        ],
      },
    ]);
    expect(markdown).toContain("**NOT GREEN.**");
    expect(markdown).toContain("**FAIL**");
  });
});
