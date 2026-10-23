import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * Renders `docs/production/benchmark-results/scale-backtests.jsonl` as the tables in
 * `docs/production/benchmark-results.md`, so every published number is a projection of the raw
 * reports.
 *
 * ```bash
 * pnpm --filter @intrinsic/api exec tsx src/backtest-benchmark/summarize-results.ts [--labels a,b,…]
 * ```
 */

type Summary = {
  samples: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
};
type Report = {
  label: string;
  scenario: string;
  cache: string;
  mix: string;
  overlap: string;
  strategy: string;
  period: { years: number };
  configuration: {
    BACKTEST_NON_RESIDENT_FRAME_READ?: string;
    STOCK_LRU_MAX_SECURITIES?: string;
  };
  submitted: number;
  completed: number;
  failed: number;
  timedOutRuns?: number;
  retries: number;
  wallMs: number;
  identicalResultsPerList: boolean;
  phasesMs: Record<
    | "queueWait"
    | "execution"
    | "endToEnd"
    | "preparation"
    | "frameReads"
    | "compute"
    | "persistence",
    Summary
  >;
  admission: { maxExecutingObserved: number; maxQueuedObserved: number };
  cpu: {
    meanBusyShare: number;
    workerCpuMsPerRun: number;
    postgresCpuMs: number;
  };
  memory: {
    workerRssPerProcessPeakBytes: number;
    workerRssPeakBytes: number;
    redisUsedPeakBytes: number;
  };
  eventLoop: { p99MsMax: number | null; maxMs: number | null };
  cacheTiers: {
    lruEvictions: number;
    lruMaxObserved: number;
    redisHitRate: number | null;
  };
  postgres: { peakConnections: number; tempBytes: number; deadlocks: number };
  providerRequests: { requests?: number } | null;
  chaos?: { kind: string; events: Record<string, unknown>[] } | null;
  perRun: {
    securityCount: number;
    status: string;
    attempts: number | null;
    digest: string | null;
    listHash: string | null;
    executionMs: number | null;
    storeReads?: number;
    timedOut?: boolean;
  }[];
};

const seconds = (ms: number | null | undefined) =>
  ms === null || ms === undefined
    ? "–"
    : (ms / 1_000).toFixed(ms < 10_000 ? 1 : 0);
const minutes = (ms: number) => (ms / 60_000).toFixed(1);
const mb = (bytes: number) => (bytes / 1_048_576).toFixed(0);

function main(): void {
  const argv = process.argv.slice(2).filter((value) => value !== "--");
  const labelsFlag = argv.indexOf("--labels");
  const wanted =
    labelsFlag >= 0 ? new Set((argv[labelsFlag + 1] ?? "").split(",")) : null;
  const reports = readFileSync(
    resolve(
      repositoryRoot(),
      "docs/production/benchmark-results/scale-backtests.jsonl",
    ),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Report)
    .filter((report) => !wanted || wanted.has(report.label));

  const lines: string[] = [];
  lines.push(
    "| Label | Runs × size | Years | Cache · mix · overlap · strategy | Read | Done / failed / timed out | Wall (min) | Execution s (median · p95 · max) | Preparation s | Frame reads s | Compute s | Persistence s | Queue wait s (max) | Worker CPU s/run | RSS/process MB | Redis peak MB | LRU evictions | PG peak conns | Loop p99 max ms | Provider req | Same digests |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const report of reports) {
    const sizes = report.perRun
      .map((run) => run.securityCount)
      .sort((a, b) => a - b)
      .join("+");
    const phases = report.phasesMs;
    lines.push(
      [
        report.label,
        sizes,
        report.period.years,
        `${report.cache} · ${report.mix} · ${report.overlap} · ${report.strategy}`,
        (report.configuration.BACKTEST_NON_RESIDENT_FRAME_READ ?? "").replace(
          " (default)",
          "",
        ) +
          (report.configuration.STOCK_LRU_MAX_SECURITIES &&
          report.configuration.STOCK_LRU_MAX_SECURITIES !== "500"
            ? ` · LRU ${report.configuration.STOCK_LRU_MAX_SECURITIES}`
            : ""),
        `${report.completed} / ${report.failed} / ${report.timedOutRuns ?? 0}`,
        minutes(report.wallMs),
        `${seconds(phases.execution.median)} · ${seconds(phases.execution.p95)} · ${seconds(phases.execution.max)}`,
        seconds(phases.preparation.median),
        seconds(phases.frameReads.median),
        seconds(phases.compute.median),
        seconds(phases.persistence.median),
        seconds(phases.queueWait.max),
        seconds(report.cpu.workerCpuMsPerRun),
        mb(report.memory.workerRssPerProcessPeakBytes),
        mb(report.memory.redisUsedPeakBytes),
        report.cacheTiers.lruEvictions,
        report.postgres.peakConnections,
        report.eventLoop.p99MsMax ?? "–",
        report.providerRequests?.requests ?? 0,
        report.identicalResultsPerList ? "yes" : "**no**",
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .concat(" |"),
    );
  }

  // Identical inputs across invocations: the same list over the same period must give one digest.
  const byInput = new Map<string, Map<string, Set<string>>>();
  for (const report of reports) {
    for (const run of report.perRun) {
      if (!run.listHash || run.status !== "COMPLETED") continue;
      const key = `${run.listHash} · ${report.strategy} · ${report.period.years}y`;
      const labels = byInput.get(key) ?? new Map<string, Set<string>>();
      const digests = labels.get(run.digest ?? "none") ?? new Set<string>();
      digests.add(report.label);
      labels.set(run.digest ?? "none", digests);
      byInput.set(key, labels);
    }
  }
  lines.push(
    "",
    "| Input (list · strategy · period) | Invocations | Distinct digests |",
    "| --- | --- | --- |",
  );
  for (const [key, digests] of byInput) {
    const labels = [
      ...new Set([...digests.values()].flatMap((set) => [...set])),
    ];
    if (labels.length < 2) continue;
    lines.push(
      `| ${key} | ${labels.join(", ")} | ${digests.size === 1 ? "1 (identical)" : `**${digests.size}**`} |`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
