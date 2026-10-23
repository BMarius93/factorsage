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
 * Service time of a run of `n` securities:
 *
 * - its measured **warm** execution time under four-way concurrency (sizes measured only alone are
 *   scaled by the measured four-way slowdown), plus
 * - for the share `c` of its non-protected members that are not resident in Redis, the measured
 *   rebuild cost of a security under four-way concurrency (from the cold and warm four-way runs).
 *
 * Both are stated in the output beside the numbers they produce.
 */

type Report = {
  label: string;
  distinctOrdinarySecurities: number;
  submissions: { protectedMembers: number }[];
  perRun: {
    securityCount: number;
    status: string;
    executionMs: number | null;
    preparationMs: number | null;
  }[];
};

type Assumptions = {
  servers: number;
  alone: Record<string, string[]>;
  fourWay: string[];
  /** The cold and warm four-way runs of the same lists, for the cost of a cold security. */
  coldRebuild: { coldLabel: string; warmLabels: string[] };
  /** Share of a run's members in the canonical universe (always resident, never cold). */
  protectedShareOfMembers: number;
  /** Shares of the other members that are not resident when the run is prepared. */
  coldOrdinaryShares: number[];
  runsPerActiveUserPerDay: Record<string, number>;
  sizeMix: Record<string, Record<string, number>>;
  mixes: Record<
    string,
    { plans: Record<string, number>; peakHourShare: number; note?: string }
  >;
  dau: number[];
  targets: { maxUtilization: number; maxP95WaitMinutes: number };
  /** The deployment-wide queue bound (`BACKTEST_QUEUE_MAX_QUEUED`). */
  queueBound: number;
};

const round = (value: number, digits = 1) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

function stats(values: readonly number[]) {
  const mean =
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, values.length);
  return {
    samples: values.length,
    mean,
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
  const runsOf = (labels: readonly string[], size?: number) =>
    reports
      .filter((report) => labels.includes(report.label))
      .flatMap((report) => report.perRun)
      .filter(
        (run) =>
          run.status === "COMPLETED" &&
          run.executionMs !== null &&
          (size === undefined || run.securityCount === size),
      );
  const hours = (ms: number) => ms / 3_600_000;

  // Warm execution, alone and four at once, by list size.
  const alone = Object.fromEntries(
    Object.entries(assumptions.alone).map(([size, labels]) => [
      size,
      stats(
        runsOf(labels, Number(size)).map((run) =>
          hours(run.executionMs as number),
        ),
      ),
    ]),
  );
  const fourWaySizes = [
    ...new Set(runsOf(assumptions.fourWay).map((run) => run.securityCount)),
  ];
  const fourWay = Object.fromEntries(
    fourWaySizes.map((size) => [
      String(size),
      stats(
        runsOf(assumptions.fourWay, size).map((run) =>
          hours(run.executionMs as number),
        ),
      ),
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
    slowdowns.reduce((a, b) => a + b, 0) / Math.max(1, slowdowns.length);
  const warmService = (size: string) => {
    const measured = fourWay[size];
    if (measured && measured.samples > 0) {
      return { meanHours: measured.mean, cv: measured.cv, source: "four-way" };
    }
    const base = alone[size];
    if (!base || base.samples === 0) {
      throw new Error(`No measurement for list size ${size}`);
    }
    return {
      meanHours: base.mean * slowdown,
      cv: base.cv,
      source: `alone × ${slowdown.toFixed(2)}`,
    };
  };

  // The slot time one cold security costs, four at once: the cold runs' extra preparation over the
  // warm runs of the same lists, spread over the distinct securities the cold runs rebuilt.
  const coldReport = reports.find(
    (report) => report.label === assumptions.coldRebuild.coldLabel,
  );
  if (!coldReport) {
    throw new Error(`No report labelled ${assumptions.coldRebuild.coldLabel}`);
  }
  const preparation = (labels: readonly string[]) =>
    stats(runsOf(labels).map((run) => (run.preparationMs as number) / 1_000));
  const coldPreparation = preparation([assumptions.coldRebuild.coldLabel]);
  const warmPreparation = preparation(assumptions.coldRebuild.warmLabels);
  const distinctRebuilt =
    Math.max(...coldReport.submissions.map((entry) => entry.protectedMembers)) +
    coldReport.distinctOrdinarySecurities;
  const slotSecondsPerColdSecurity =
    ((coldPreparation.mean - warmPreparation.mean) * coldReport.perRun.length) /
    distinctRebuilt;

  const output: Record<string, unknown> = {
    warmServiceMinutes: Object.fromEntries(
      Object.keys({ ...alone, ...fourWay }).map((size) => [
        size,
        {
          aloneMean: round((alone[size]?.mean ?? Number.NaN) * 60, 2),
          aloneSamples: alone[size]?.samples ?? 0,
          fourWayMean: fourWay[size] ? round(fourWay[size].mean * 60, 2) : null,
          fourWaySamples: fourWay[size]?.samples ?? 0,
          used: round(warmService(size).meanHours * 60, 2),
          source: warmService(size).source,
        },
      ]),
    ),
    fourWaySlowdown: round(slowdown, 3),
    coldSecurity: {
      slotSecondsEach: round(slotSecondsPerColdSecurity, 2),
      from: `${assumptions.coldRebuild.coldLabel}: preparation ${round(coldPreparation.mean)} s vs ${round(warmPreparation.mean)} s warm, ${coldReport.perRun.length} runs, ${distinctRebuilt} distinct securities rebuilt`,
    },
    mixes: {} as Record<string, unknown>,
  };

  for (const [name, mix] of Object.entries(assumptions.mixes)) {
    const byColdShare: Record<string, unknown> = {};
    for (const coldShare of assumptions.coldOrdinaryShares) {
      const kinds: { share: number; meanHours: number; cv: number }[] = [];
      let runsPerDau = 0;
      for (const [plan, share] of Object.entries(mix.plans)) {
        const runs = share * (assumptions.runsPerActiveUserPerDay[plan] ?? 0);
        runsPerDau += runs;
        for (const [size, sizeShare] of Object.entries(
          assumptions.sizeMix[plan] ?? {},
        )) {
          const warm = warmService(size);
          const coldMembers =
            Number(size) *
            (1 - assumptions.protectedShareOfMembers) *
            coldShare;
          kinds.push({
            share: runs * sizeShare,
            meanHours:
              warm.meanHours +
              (coldMembers * slotSecondsPerColdSecurity) / 3_600,
            cv: warm.cv,
          });
        }
      }
      const moments = mixtureMoments(kinds);
      const queueAt = (dau: number) =>
        estimateQueue({
          lambda: dau * runsPerDau * mix.peakHourShare,
          meanServiceHours: moments.meanHours,
          serviceCv: moments.cv,
          servers: assumptions.servers,
        });
      const meets = (dau: number) => {
        const queue = queueAt(dau);
        return (
          !queue.saturated &&
          queue.utilization <= assumptions.targets.maxUtilization &&
          queue.p95WaitHours * 60 <= assumptions.targets.maxP95WaitMinutes
        );
      };
      let low = 0;
      let high = 10_000_000;
      for (let step = 0; step < 80; step += 1) {
        const middle = (low + high) / 2;
        if (meets(middle)) low = middle;
        else high = middle;
      }
      const capacityPerHour = assumptions.servers / moments.meanHours;
      byColdShare[String(coldShare)] = {
        meanServiceMinutes: round(moments.meanHours * 60, 2),
        serviceCv: round(moments.cv, 2),
        slotCapacityRunsPerHour: round(capacityPerHour),
        maxDauWithinTargets: Math.floor(low),
        // All four slots occupied for an extended period: arrivals above capacity fill the
        // bounded queue, after which submissions are refused with 503 until it drains.
        saturation: {
          queueFillsAt125PercentLoadMinutes: round(
            (assumptions.queueBound / (0.25 * capacityPerHour)) * 60,
          ),
          queueFillsAt150PercentLoadMinutes: round(
            (assumptions.queueBound / (0.5 * capacityPerHour)) * 60,
          ),
          waitOfTheLastQueuedRunMinutes: round(
            (assumptions.queueBound / capacityPerHour) * 60,
          ),
        },
        rows: assumptions.dau.map((dau) => {
          const queue = queueAt(dau);
          return {
            dau,
            peakArrivalsPerHour: round(dau * runsPerDau * mix.peakHourShare),
            utilization: round(queue.utilization, 3),
            meanWaitMinutes: queue.saturated
              ? "saturated"
              : round(queue.meanWaitHours * 60),
            p95WaitMinutes: queue.saturated
              ? "saturated"
              : round(queue.p95WaitHours * 60),
            meanQueued: queue.saturated ? "unbounded" : round(queue.meanQueued),
          };
        }),
      };
    }
    (output.mixes as Record<string, unknown>)[name] = {
      note: mix.note,
      runsPerDauPerDay: round(
        Object.entries(mix.plans).reduce(
          (sum, [plan, share]) =>
            sum + share * (assumptions.runsPerActiveUserPerDay[plan] ?? 0),
          0,
        ),
        3,
      ),
      byColdOrdinaryShare: byColdShare,
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
