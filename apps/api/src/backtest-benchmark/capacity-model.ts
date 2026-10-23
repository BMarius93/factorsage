import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "../qa-matrix/matrix-paths";
import { estimateQueue, mixtureMoments } from "./capacity-math";

/**
 * The capacity model (`docs/production/capacity-model.md`), computed from the measured run times in
 * `docs/production/benchmark-results/scale-backtests.jsonl` and the stated assumptions in
 * `docs/production/capacity-assumptions.json` — so every number in the model can be recomputed,
 * and changing an assumption changes it everywhere at once.
 *
 * ```bash
 * pnpm --filter @intrinsic/api exec tsx src/backtest-benchmark/capacity-model.ts
 * ```
 *
 * Service times: a run of `n` securities is served for its measured execution time **under
 * four-way concurrency**. Sizes measured alone are scaled by the four-way slowdown measured on the
 * same sizes (`slowdown` below); that scaling is an assumption the output states.
 */

type Report = {
  label: string;
  scenario: string;
  cache: string;
  mix: string;
  overlap: string;
  strategy: string;
  timedOutRuns?: number;
  perRun: {
    securityCount: number;
    status: string;
    executionMs: number | null;
    queueWaitMs: number | null;
    timedOut?: boolean;
  }[];
};

type Assumptions = {
  servers: number;
  /** Labels whose runs give the service time of each list size alone (`size` → labels). */
  alone: Record<string, string[]>;
  /** Labels of the four-at-once measurements, and the sizes they contain. */
  fourWay: string[];
  /** Runs per active user per day, by plan. */
  runsPerActiveUserPerDay: Record<string, number>;
  /** The list sizes each plan's runs use, as shares. */
  sizeMix: Record<string, Record<string, number>>;
  /** Workload mixes: the share of daily active users on each plan, and the peak-hour share. */
  mixes: Record<
    string,
    { plans: Record<string, number>; peakHourShare: number; note?: string }
  >;
  /** Daily active users to evaluate. */
  dau: number[];
  /** Product targets the capacity is read against. */
  targets: { maxUtilization: number; maxP95WaitMinutes: number };
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function stats(values: readonly number[]) {
  const mean =
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, values.length);
  return {
    samples: values.length,
    mean,
    median: median(values),
    cv: mean > 0 ? Math.sqrt(variance) / mean : 0,
  };
}

function main(): void {
  const root = repositoryRoot();
  const reports = readFileSync(
    resolve(root, "docs/production/benchmark-results/scale-backtests.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Report);
  const assumptions = JSON.parse(
    readFileSync(
      resolve(root, "docs/production/capacity-assumptions.json"),
      "utf8",
    ),
  ) as Assumptions;
  const completed = (labels: readonly string[], size?: number) =>
    reports
      .filter((report) => labels.includes(report.label))
      .flatMap((report) => report.perRun)
      .filter(
        (run) =>
          run.status === "COMPLETED" &&
          run.executionMs !== null &&
          (size === undefined || run.securityCount === size),
      )
      .map((run) => (run.executionMs as number) / 3_600_000);

  // Execution time alone, and under four at once, by list size.
  const alone = Object.fromEntries(
    Object.entries(assumptions.alone).map(([size, labels]) => [
      size,
      stats(completed(labels, Number(size))),
    ]),
  );
  const fourWaySizes = [
    ...new Set(
      reports
        .filter((r) => assumptions.fourWay.includes(r.label))
        .flatMap((r) => r.perRun.map((run) => run.securityCount)),
    ),
  ];
  const fourWay = Object.fromEntries(
    fourWaySizes.map((size) => [
      String(size),
      stats(completed(assumptions.fourWay, size)),
    ]),
  );
  const slowdowns = fourWaySizes
    .map(
      (size) =>
        (fourWay[String(size)]?.mean ?? Number.NaN) /
        (alone[String(size)]?.mean ?? Number.NaN),
    )
    .filter((value) => Number.isFinite(value));
  const slowdown =
    slowdowns.length > 0
      ? slowdowns.reduce((a, b) => a + b, 0) / slowdowns.length
      : Number.NaN;
  const serviceOf = (size: string) => {
    const measured = fourWay[size];
    if (measured && measured.samples > 0)
      return { meanHours: measured.mean, cv: measured.cv, source: "four-way" };
    const base = alone[size];
    if (!base || base.samples === 0)
      throw new Error(`No measurement for list size ${size}`);
    return {
      meanHours: base.mean * slowdown,
      cv: base.cv,
      source: `alone × ${slowdown.toFixed(2)}`,
    };
  };

  const output: Record<string, unknown> = {
    serviceHours: Object.fromEntries(
      Object.keys({ ...alone, ...fourWay }).map((size) => [
        size,
        { alone: alone[size], fourWay: fourWay[size], used: serviceOf(size) },
      ]),
    ),
    fourWaySlowdown: slowdown,
    mixes: {} as Record<string, unknown>,
  };

  for (const [name, mix] of Object.entries(assumptions.mixes)) {
    // Runs per DAU per day, and the service-time mixture of one run.
    const kinds: { share: number; meanHours: number; cv: number }[] = [];
    let runsPerDau = 0;
    for (const [plan, share] of Object.entries(mix.plans)) {
      const runs = share * (assumptions.runsPerActiveUserPerDay[plan] ?? 0);
      runsPerDau += runs;
      for (const [size, sizeShare] of Object.entries(
        assumptions.sizeMix[plan] ?? {},
      )) {
        const service = serviceOf(size);
        kinds.push({
          share: runs * sizeShare,
          meanHours: service.meanHours,
          cv: service.cv,
        });
      }
    }
    const moments = mixtureMoments(kinds);
    const rows = assumptions.dau.map((dau) => {
      const lambda = dau * runsPerDau * mix.peakHourShare;
      const queue = estimateQueue({
        lambda,
        meanServiceHours: moments.meanHours,
        serviceCv: moments.cv,
        servers: assumptions.servers,
      });
      return {
        dau,
        peakArrivalsPerHour: Math.round(lambda * 10) / 10,
        utilization: Math.round(queue.utilization * 1000) / 1000,
        meanWaitMinutes: queue.saturated
          ? "saturated"
          : Math.round(queue.meanWaitHours * 600) / 10,
        p95WaitMinutes: queue.saturated
          ? "saturated"
          : Math.round(queue.p95WaitHours * 600) / 10,
        meanQueued: queue.saturated
          ? "unbounded"
          : Math.round(queue.meanQueued * 10) / 10,
        completedPerHour: Math.round(queue.throughputPerHour * 10) / 10,
      };
    });
    // The largest DAU that meets both targets, by bisection on the continuous model.
    const meets = (dau: number) => {
      const lambda = dau * runsPerDau * mix.peakHourShare;
      const queue = estimateQueue({
        lambda,
        meanServiceHours: moments.meanHours,
        serviceCv: moments.cv,
        servers: assumptions.servers,
      });
      return (
        !queue.saturated &&
        queue.utilization <= assumptions.targets.maxUtilization &&
        queue.p95WaitHours * 60 <= assumptions.targets.maxP95WaitMinutes
      );
    };
    let low = 0;
    let high = 1_000_000;
    for (let step = 0; step < 60; step += 1) {
      const middle = (low + high) / 2;
      if (meets(middle)) low = middle;
      else high = middle;
    }
    (output.mixes as Record<string, unknown>)[name] = {
      note: mix.note,
      runsPerDauPerDay: Math.round(runsPerDau * 1000) / 1000,
      meanServiceMinutes: Math.round(moments.meanHours * 600) / 10,
      serviceCv: Math.round(moments.cv * 100) / 100,
      slotCapacityRunsPerHour:
        Math.round((assumptions.servers / moments.meanHours) * 10) / 10,
      maxDauWithinTargets: Math.floor(low),
      rows,
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
