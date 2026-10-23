import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * Prints the interactive-load, browser-journey and submission-probe reports in
 * `docs/production/benchmark-results/` as the Markdown tables `benchmark-results.md` §6 shows, so
 * every number there is a projection of a raw report.
 *
 * ```bash
 * pnpm --filter @intrinsic/api exec tsx src/load-test/summarize-load.ts [--labels a,b]
 * ```
 */

type LoadReport = {
  label: string;
  users: number;
  requests: number;
  throughputPerS: number;
  errors: number;
  errorRate: number;
  loginFailures: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  api: { cpuShareOfOneCore: number; rssPeakBytes: number } | null;
  apiEventLoop: { p99MsMedian: number; p99MsMax: number; maxMs: number } | null;
  backtests: {
    executingMean: number;
    executingMax: number;
    shareAtFour: number;
    queuedMax: number;
  } | null;
  routes: {
    route: string;
    requests: number;
    errors: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  }[];
};

type BrowserReport = {
  label: string;
  users: number;
  rounds: number;
  samples: number;
  failures: number;
  crashes: number;
  pageErrors: number;
  pages: {
    page: string;
    samples: number;
    failures: number;
    readyMs: { p50: number; p95: number };
    ttfbMs: { p50: number; p95: number };
    lcpMs: { p50: number };
    longTasks: number;
    longTaskMsP95: number;
    interactionMs: { p50: number; max: number } | null;
    timeouts: number;
  }[];
};

type ProbeReport = {
  recordedAt: string;
  probes: ({ probe: string; pass: boolean } & Record<string, unknown>)[];
  passed: number;
  failed: number;
  cancelledRuns: number;
};

function readJsonl<T>(name: string): T[] {
  const path = resolve(
    repositoryRoot(),
    "docs/production/benchmark-results",
    name,
  );
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const table = (header: string[], rows: (string | number)[][]) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : String(Math.round(value));

function main(): void {
  const labelsArgument = process.argv.indexOf("--labels");
  const labels =
    labelsArgument >= 0
      ? new Set(
          (process.argv[labelsArgument + 1] ?? "").split(",").filter(Boolean),
        )
      : null;
  const keep = <T extends { label: string }>(reports: T[]) =>
    reports.filter((report) => labels === null || labels.has(report.label));

  const load = keep(readJsonl<LoadReport>("interactive-load.jsonl"));
  const output: string[] = [];
  if (load.length > 0) {
    output.push(
      table(
        [
          "Level",
          "Users",
          "Backtests executing (mean · max · share of time at 4)",
          "Requests",
          "Req/s",
          "Errors",
          "p50 ms",
          "p95 ms",
          "p99 ms",
          "max ms",
          "API CPU (cores)",
          "API RSS MB",
          "API loop p99 ms (median · max)",
        ],
        load.map((report) => [
          report.label,
          report.users,
          report.backtests
            ? `${report.backtests.executingMean} · ${report.backtests.executingMax} · ${Math.round(report.backtests.shareAtFour * 100)} %`
            : "—",
          report.requests,
          report.throughputPerS,
          `${report.errors} (${(report.errorRate * 100).toFixed(2)} %)${report.loginFailures > 0 ? `, ${report.loginFailures} sign-in failures` : ""}`,
          ms(report.latencyMs.p50),
          ms(report.latencyMs.p95),
          ms(report.latencyMs.p99),
          ms(report.latencyMs.max),
          report.api ? report.api.cpuShareOfOneCore.toFixed(2) : "—",
          report.api ? Math.round(report.api.rssPeakBytes / 1e6) : "—",
          report.apiEventLoop
            ? `${ms(report.apiEventLoop.p99MsMedian)} · ${ms(report.apiEventLoop.p99MsMax)}`
            : "—",
        ]),
      ),
    );
    for (const report of load.filter(
      (entry) => entry.users === Math.max(...load.map((other) => other.users)),
    )) {
      output.push(
        "",
        `Slowest routes, ${report.label} (by p95):`,
        "",
        table(
          [
            "Route",
            "Requests",
            "Errors",
            "p50 ms",
            "p95 ms",
            "p99 ms",
            "max ms",
          ],
          [...report.routes]
            .sort((left, right) => right.p95 - left.p95)
            .slice(0, 8)
            .map((route) => [
              `\`${route.route}\``,
              route.requests,
              route.errors,
              ms(route.p50),
              ms(route.p95),
              ms(route.p99),
              ms(route.max),
            ]),
        ),
      );
    }
  }

  const browser = keep(readJsonl<BrowserReport>("browser-journeys.jsonl"));
  for (const report of browser) {
    output.push(
      "",
      `Browser journeys, ${report.label}: ${report.users} browsers × ${report.rounds} rounds, ${report.samples} page loads, ${report.failures} failed, ${report.crashes} crashes, ${report.pageErrors} page errors.`,
      "",
      table(
        [
          "Page",
          "Loads",
          "Failed",
          "Ready p50 · p95 ms",
          "TTFB p50 · p95 ms",
          "LCP p50 ms",
          "Long tasks",
          "Long-task ms p95",
          "Interaction p50 · max ms",
          "Timeouts",
        ],
        report.pages.map((page) => [
          page.page,
          page.samples,
          page.failures,
          `${ms(page.readyMs.p50)} · ${ms(page.readyMs.p95)}`,
          `${ms(page.ttfbMs.p50)} · ${ms(page.ttfbMs.p95)}`,
          ms(page.lcpMs.p50),
          page.longTasks,
          ms(page.longTaskMsP95),
          page.interactionMs
            ? `${ms(page.interactionMs.p50)} · ${ms(page.interactionMs.max)}`
            : "—",
          page.timeouts,
        ]),
      ),
    );
  }

  for (const report of readJsonl<ProbeReport>("submission-probes.jsonl")) {
    output.push(
      "",
      `Submission probes (${report.recordedAt}): ${report.passed} passed, ${report.failed} failed; ${report.cancelledRuns} accepted runs cancelled afterwards.`,
      "",
      table(
        ["Probe", "Pass", "Observed"],
        report.probes.map(({ probe, pass, ...rest }) => [
          probe,
          pass ? "yes" : "**no**",
          `\`${JSON.stringify(rest)}\``,
        ]),
      ),
    );
  }
  process.stdout.write(`${output.join("\n")}\n`);
}

main();
