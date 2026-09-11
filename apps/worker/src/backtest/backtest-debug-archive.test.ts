import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKTEST_SNAPSHOT_VERSION } from "@intrinsic/contracts";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  BACKTEST_DATA_REVISIONS,
  type DailyPriceBounds,
} from "@intrinsic/stock-data";
import {
  BACKTEST_METHODOLOGY,
  createEvaluationFrame,
  PRICE_OPERAND,
  type BacktestResult,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
  type BacktestFrameLoader,
} from "./backtest-processor.js";
import {
  BacktestDebugArchive,
  type BacktestDebugArchiveContext,
} from "./debug/backtest-debug-archive.js";
import {
  archiveJsonEntry,
  archiveNdjsonEntry,
  readArchiveEntries,
} from "./debug/archive-reader.test-helper.js";
import {
  FilesystemBacktestDebugArchives,
  type BacktestDebugArchives,
} from "./debug/debug-archives.js";
import type { BacktestJobLease } from "./job-lease.js";
import type {
  BacktestFailureWrite,
  BacktestJobRepository,
  BacktestResultWrite,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";

const logger = createLogger({ service: "worker", level: "silent" });

const COMPARISON_SERIES = "series-comparison";
const CALENDAR_SERIES = "series-calendar";
const START = "2019-06-03";
const END = "2021-05-31";

/** Two securities, so "one frame file per security per year" is a real assertion. */
const SECURITIES = [
  { id: "security-aaa", symbol: "AAA", name: "AAA Inc." },
  { id: "security-bbb", symbol: "BBB", name: "BBB Corp." },
] as const;

/** The operand this fixture's Strategy names, so the frames carry a real canonical column. */
const RSI_OPERAND: OperandKey = "series:RSI_14D";

const lease: BacktestJobLease = {
  interruption: () => null,
  markLost: () => {},
} as unknown as BacktestJobLease;

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** The market's trading days: what the pinned execution-calendar series reports. */
const CALENDAR = weekdays("2018-06-01", END);

/**
 * A date the *securities* have a row for and the market calendar does not.
 *
 * A stray provider bar on a closed day is the exact thing the authoritative calendar exists to
 * ignore, so the fixture contains one and the archive has to make it visible.
 */
const NON_CALENDAR_DATE = "2020-07-04";

const SECURITY_DATES = [...CALENDAR, NON_CALENDAR_DATE].sort();

const closeOn = (date: string): number =>
  100 + SECURITY_DATES.indexOf(date) * 0.05;

/**
 * The RSI column: absent for the first year, then a real reading — including exactly `0`.
 *
 * `NaN` and `0` mean opposite things inside the engine, and JSON can represent only one of them
 * natively, so the fixture deliberately contains both.
 */
function rsiOn(date: string): number {
  if (date < "2019-01-01") {
    return Number.NaN;
  }
  if (date === "2020-03-02" || date === "2020-03-03") {
    return 0;
  }
  return 40 + (SECURITY_DATES.indexOf(date) % 20);
}

function snapshotDocument(overrides: Record<string, unknown> = {}) {
  return {
    snapshotVersion: BACKTEST_SNAPSHOT_VERSION,
    submittedAt: "2026-01-01T00:00:00.000Z",
    strategy: {
      strategyId: "strategy-1",
      name: "Fixture",
      versionId: "version-1",
      versionNumber: 1,
      definitionHash: "hash",
      definition: {
        schemaVersion: 1,
        buyLevels: [
          {
            id: "b100",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "rsi-below-90",
                  metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                  operator: "IS_BELOW",
                  value: { kind: "NUMBER", value: 90 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      },
    },
    stockList: { stockListId: "list-1", name: "Fixture list" },
    securities: SECURITIES.map((security) => ({
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      exchangeCode: "NASDAQ",
      currency: "USD",
      buyWindowMode: "FULL",
      buyWindows: [],
    })),
    period: { startDate: START, endDate: END },
    capital: { initialCapital: 100_000, monthlyContribution: 1_000 },
    allocation: { maximumPositions: 5, fullPositionFraction: 0.2 },
    benchmark: {
      benchmarkId: "benchmark-1",
      seriesId: COMPARISON_SERIES,
      seriesVersion: 1,
      code: "SP500",
      name: "S&P 500",
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "SPY",
      methodologyVersion: 1,
      currency: "USD",
    },
    executionCalendar: {
      referenceCode: "SP500",
      seriesId: CALENDAR_SERIES,
      seriesVersion: 1,
    },
    methodology: { ...BACKTEST_METHODOLOGY },
    dataRevisions: { ...BACKTEST_DATA_REVISIONS },
    ...overrides,
  };
}

function claimOf(
  snapshot: unknown,
  overrides: Partial<ClaimedBacktestJob> = {},
): ClaimedBacktestJob {
  return {
    jobId: "job-1",
    runId: "run-1",
    attempt: 1,
    actorUserId: "user-1",
    snapshot,
    ...overrides,
  };
}

class RecordingRepository implements BacktestJobRepository {
  readonly failures: BacktestFailureWrite[] = [];
  readonly results: BacktestResultWrite[] = [];

  async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    return null;
  }
  async heartbeat(): Promise<boolean> {
    return true;
  }
  async recoverStaleJobs(): Promise<StaleJobRecovery> {
    return { requeued: 0, abandoned: 0 };
  }
  async updateProgress(): Promise<boolean> {
    return true;
  }
  async persistResult(write: BacktestResultWrite): Promise<boolean> {
    this.results.push(write);
    return true;
  }
  async failJob(write: BacktestFailureWrite): Promise<boolean> {
    this.failures.push(write);
    return true;
  }
  async releaseJob(): Promise<boolean> {
    return true;
  }
}

/** Projects the fixture's history, and can fail one specific calendar year. */
class FixtureFrameLoader implements BacktestFrameLoader {
  constructor(private readonly failWindowStartingIn?: string) {}

  async prepareDailyEvaluationData(
    _security: Security,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null> {
    const inside = SECURITY_DATES.filter(
      (date) => date >= range.from && date <= range.to,
    );
    return inside.length === 0
      ? null
      : {
          firstDate: inside[0] as string,
          lastDate: inside[inside.length - 1] as string,
          tradingDays: inside.length,
        };
  }

  async readDailyEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame> {
    if (
      this.failWindowStartingIn &&
      range.from.startsWith(this.failWindowStartingIn)
    ) {
      throw new Error(
        "the projection for this window could not be read from https://financialmodelingprep.com/api/v3/x?apikey=super-secret-key",
      );
    }
    // The loader widens a window by its own leading context, exactly as the real one does.
    const context = new Date(`${range.from}T00:00:00.000Z`);
    context.setUTCDate(context.getUTCDate() - 10);
    const from = context.toISOString().slice(0, 10);
    const dates = SECURITY_DATES.filter(
      (date) => date >= from && date <= range.to,
    );
    const closes = Float64Array.from(dates.map(closeOn));
    const columns = new Map<OperandKey, Float64Array>();
    for (const operand of operands) {
      if (operand !== PRICE_OPERAND) {
        columns.set(operand, Float64Array.from(dates.map(rsiOn)));
      }
    }
    let periodStartIndex = dates.length;
    for (let index = 0; index < dates.length; index += 1) {
      if ((dates[index] as string) >= range.from) {
        periodStartIndex = index;
        break;
      }
    }
    return createEvaluationFrame({
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      dates,
      closes,
      columns,
      periodStartIndex,
    });
  }
}

const benchmarkCloseOn = (date: string): number =>
  400 + CALENDAR.indexOf(date) * 0.2;

class FixtureBenchmarks implements BacktestBenchmarkLoader {
  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    return {
      id: seriesId,
      benchmarkId: "benchmark-1",
      version: 1,
      sourceKind: "FMP_SYMBOL",
      providerSymbol: "SPY",
      currency: "USD",
      methodologyVersion: 1,
    };
  }

  async getBenchmarkDailyPrices(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    return CALENDAR.filter(
      (date) => date >= range.from && date <= range.to,
    ).map((date) => ({
      seriesId: series.id,
      date,
      open: benchmarkCloseOn(date),
      high: benchmarkCloseOn(date) + 1,
      low: benchmarkCloseOn(date) - 1,
      close: benchmarkCloseOn(date),
      volume: 5_000,
    }));
  }

  async missingBenchmarkCoverage(): Promise<Required<DateRange>[]> {
    return [];
  }
}

function processorWith(input: {
  stockData?: BacktestFrameLoader;
  debugArchives?: BacktestDebugArchives;
}) {
  const repository = new RecordingRepository();
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () =>
          new Map<string, Security>(
            SECURITIES.map((security) => [
              security.id,
              {
                id: security.id,
                symbol: security.symbol,
                name: security.name,
                exchangeCode: "NASDAQ",
                currency: "USD",
                type: "STOCK",
                isAdr: false,
                isActivelyTrading: true,
              },
            ]),
          ),
      },
      stockData: input.stockData ?? new FixtureFrameLoader(),
      benchmarks: new FixtureBenchmarks(),
      logger,
      ...(input.debugArchives ? { debugArchives: input.debugArchives } : {}),
    },
    {
      frameConcurrency: 2,
      checkpointEveryDays: 5,
      checkpointMinIntervalMs: 0,
      leaseMs: 60_000,
      workerId: "worker-under-test",
    },
  );
  return { processor, repository };
}

let directory: string;

beforeEach(async () => {
  // Never the real `.debug/backtests`: a test must not write into a developer's own artifacts.
  directory = await mkdtemp(join(tmpdir(), "backtest-debug-archive-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function archives(overrides: { directory?: string } = {}) {
  return new FilesystemBacktestDebugArchives({
    directory: overrides.directory ?? directory,
    mode: "full",
    logger,
  });
}

async function archiveFiles(root = directory): Promise<string[]> {
  try {
    return (await readdir(root)).filter((name) => name.endsWith(".zip")).sort();
  } catch {
    return [];
  }
}

/** Runs one backtest with capture on and returns the single archive it produced. */
async function captureRun(
  input: {
    stockData?: BacktestFrameLoader;
    claim?: ClaimedBacktestJob;
    debugArchives?: BacktestDebugArchives;
  } = {},
) {
  const { processor, repository } = processorWith({
    ...(input.stockData ? { stockData: input.stockData } : {}),
    debugArchives: input.debugArchives ?? archives(),
  });
  await processor.process(input.claim ?? claimOf(snapshotDocument()), lease);
  const files = await archiveFiles();
  const entries =
    files.length === 1
      ? await readArchiveEntries(join(directory, files[0] as string))
      : new Map<string, string>();
  return { repository, files, entries };
}

describe("backtest debug archive — the feature is off unless asked for", () => {
  it("does no filesystem work when the capture is not configured", async () => {
    const target = join(directory, "never-created");
    const { processor, repository } = processorWith({});

    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.results).toHaveLength(1);
    // Not "an empty directory" — no directory. With the feature off the processor has no archive
    // dependency to call, so there is nothing that could have touched the disk.
    await expect(stat(target)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("produces an identical financial result with capture on and off", async () => {
    const off = processorWith({});
    await off.processor.process(claimOf(snapshotDocument()), lease);

    const on = await captureRun();

    const without = off.repository.results[0]?.result as BacktestResult;
    const with_ = on.repository.results[0]?.result as BacktestResult;

    // The whole result, field for field: trades and their order, contribution dates, fills, cash,
    // positions, both comparison curves and every summary metric.
    expect(with_.trades).toEqual(without.trades);
    expect(with_.equity).toEqual(without.equity);
    expect(with_.positions).toEqual(without.positions);
    expect(with_.summary).toEqual(without.summary);
  });
});

describe("backtest debug archive — a completed attempt", () => {
  it("produces exactly one archive holding every required file", async () => {
    const { repository, files, entries } = await captureRun();

    expect(repository.failures).toEqual([]);
    expect(files).toEqual(["backtest-debug-run-1-attempt-1.zip"]);

    for (const required of [
      "manifest.json",
      "snapshot.json",
      "preparation/summary.json",
      "inputs/execution-calendar.json",
      "inputs/benchmark.json",
      "inputs/contributions.ndjson",
      "execution/windows.ndjson",
      "execution/checkpoints.ndjson",
      "result/trades.ndjson",
      "result/equity.ndjson",
      "result/positions.json",
      "result/summary.json",
      "diagnostics/timings.json",
      "README.json",
    ]) {
      expect([...entries.keys()]).toContain(required);
    }
    // A completed run has nothing to explain.
    expect([...entries.keys()]).not.toContain("diagnostics/failure.json");
  });

  it("stamps its own schema version and the run's identity, without dumping the environment", async () => {
    const { entries } = await captureRun();
    const manifest = archiveJsonEntry(entries, "manifest.json");

    // Version 2: money and share quantities are canonical decimal strings. A reader written
    // against version 1 would misread them, which is exactly what the version is for.
    expect(manifest.archiveSchemaVersion).toBe(2);
    expect(manifest.archiveMode).toBe("full");
    expect(manifest.run).toMatchObject({
      runId: "run-1",
      jobId: "job-1",
      attempt: 1,
      status: "COMPLETED",
    });
    expect(manifest.build).toMatchObject({ nodeVersion: process.version });
    // Counted cumulatively, not from a buffer the per-window flush drains.
    expect(manifest.capture).toMatchObject({
      windows: 3,
      frameFiles: 6,
      fundingEvents: archiveNdjsonEntry(entries, "inputs/contributions.ndjson")
        .length,
    });
    // Local git metadata is best-effort and null is a legitimate answer, but it must be *present*.
    expect(manifest.build).toHaveProperty("gitCommit");
    expect(manifest.build).toHaveProperty("gitBranch");
    // The revisions a reviewer checks a run against.
    expect(manifest.revisions).toMatchObject({
      methodology: BACKTEST_METHODOLOGY,
      dataRevisions: BACKTEST_DATA_REVISIONS,
      comparisonScenarios: BACKTEST_METHODOLOGY.comparisonScenarios,
      executionCalendar: BACKTEST_METHODOLOGY.executionCalendar,
    });
    expect(JSON.stringify(manifest)).not.toContain("PATH");
  });

  it("keeps the immutable snapshot, not a reconstruction of it", async () => {
    const { entries } = await captureRun();

    expect(archiveJsonEntry(entries, "snapshot.json")).toEqual(
      snapshotDocument(),
    );
  });

  it("cleans its staging directory up", async () => {
    await captureRun();

    // The finished zip and an empty staging folder — no half-written tree left to be mistaken for
    // an archive.
    expect(await readdir(join(directory, ".staging"))).toEqual([]);
  });
});

describe("backtest debug archive — execution windows and frames", () => {
  it("represents every calendar year once, in order", async () => {
    const { entries } = await captureRun();
    const windows = archiveNdjsonEntry(entries, "execution/windows.ndjson");

    expect(windows.map((window) => window.year)).toEqual([
      "2019",
      "2020",
      "2021",
    ]);
    expect(windows.map((window) => window.ordinal)).toEqual([0, 1, 2]);
    expect(windows[0]).toMatchObject({
      requestedFrom: START,
      requestedTo: "2019-12-31",
      frameCount: 2,
    });
    expect(windows[2]).toMatchObject({ requestedTo: END });
    // Every window reports what it actually simulated, so a reviewer can add them up.
    const simulated = windows.reduce(
      (total, window) => total + (window.simulatedDates as number),
      0,
    );
    expect(simulated).toBe(
      archiveNdjsonEntry(entries, "result/equity.ndjson").length,
    );
  });

  it("captures the actual frame per security per year", async () => {
    const { entries } = await captureRun();

    const frameFiles = [...entries.keys()]
      .filter((name) => name.startsWith("frames/"))
      .sort();
    expect(frameFiles).toEqual([
      "frames/2019/AAA-security-aaa.json",
      "frames/2019/BBB-security-bbb.json",
      "frames/2020/AAA-security-aaa.json",
      "frames/2020/BBB-security-bbb.json",
      "frames/2021/AAA-security-aaa.json",
      "frames/2021/BBB-security-bbb.json",
    ]);

    const frame = archiveJsonEntry(
      entries,
      "frames/2020/AAA-security-aaa.json",
    );
    expect(frame).toMatchObject({
      securityId: "security-aaa",
      symbol: "AAA",
      window: {
        year: "2020",
        requestedFrom: "2020-01-01",
        requestedTo: "2020-12-31",
      },
    });
    // The canonical operand id the Strategy references — never a second naming system.
    expect(frame.operandKeys).toEqual([RSI_OPERAND]);
    const dates = frame.dates as string[];
    const closes = frame.closes as number[];
    expect(dates).toHaveLength(closes.length);
    const rsiColumn = (frame.operands as Record<string, unknown[]>)[
      RSI_OPERAND
    ] as unknown[];
    expect(rsiColumn).toHaveLength(dates.length);
    // The values the engine actually read, not a re-derivation.
    expect(closes[dates.indexOf("2020-06-01")]).toBe(closeOn("2020-06-01"));
  });

  it("keeps the previous year's Trigger context and says which rows it is", async () => {
    const { entries } = await captureRun();
    const frame = archiveJsonEntry(
      entries,
      "frames/2020/AAA-security-aaa.json",
    );

    // Exactly one row precedes 2020: the row the engine carried over, which is what a Trigger reads
    // at `index - 1` on the first eligible date of the year.
    expect(frame.contextRowCount).toBe(1);
    expect(frame.contextRowDates).toEqual(["2019-12-31"]);
    expect((frame.dates as string[])[0]).toBe("2019-12-31");
    expect((frame.dates as string[])[1]).toBe("2020-01-01");
    expect((frame.closes as number[])[0]).toBe(closeOn("2019-12-31"));

    // And the checkpoint names the same row, so continuity is checkable without opening the frames.
    const checkpoints = archiveNdjsonEntry(
      entries,
      "execution/checkpoints.ndjson",
    );
    const retained = (checkpoints[0]?.retainedContextRows ?? []) as {
      symbol: string;
      date: string;
      close: number;
    }[];
    expect(retained.map((row) => row.date)).toEqual([
      "2019-12-31",
      "2019-12-31",
    ]);
    expect(retained[0]?.close).toBe(closeOn("2019-12-31"));
  });

  it("encodes an absent value as null and a real zero as zero", async () => {
    const { entries } = await captureRun();

    // 2019's window starts inside the run, and the fixture's RSI is absent before 2019 — the
    // leading context rows the loader supplies carry that absence.
    const first = archiveJsonEntry(
      entries,
      "frames/2019/AAA-security-aaa.json",
    );
    const firstRsi = (first.operands as Record<string, (number | null)[]>)[
      RSI_OPERAND
    ] as (number | null)[];
    expect(
      firstRsi.every((value) => value === null || typeof value === "number"),
    ).toBe(true);

    const second = archiveJsonEntry(
      entries,
      "frames/2020/AAA-security-aaa.json",
    );
    const dates = second.dates as string[];
    const rsi = (second.operands as Record<string, (number | null)[]>)[
      RSI_OPERAND
    ] as (number | null)[];

    // A real reading of zero survives as zero. This is the case a naive `value || null` breaks.
    expect(rsi[dates.indexOf("2020-03-02")]).toBe(0);
    expect(rsi[dates.indexOf("2020-03-03")]).toBe(0);
    // And no data file contains a bare `NaN` token, which is not valid JSON and would make the
    // whole file unreadable. The two self-describing files are skipped because they say the word
    // on purpose.
    for (const [name, content] of entries) {
      if (name === "README.json" || name === "manifest.json") {
        continue;
      }
      expect(`${name}:${content}`).not.toContain("NaN");
      for (const line of content.split("\n").filter((row) => row.length > 0)) {
        if (name.endsWith(".ndjson")) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    }
    expect(() =>
      JSON.parse(entries.get("frames/2020/AAA-security-aaa.json") as string),
    ).not.toThrow();
  });

  it("captures the state a year boundary carries", async () => {
    const { entries } = await captureRun();
    const checkpoints = archiveNdjsonEntry(
      entries,
      "execution/checkpoints.ndjson",
    );

    expect(
      checkpoints.map((entry) => (entry.afterWindow as { year: string }).year),
    ).toEqual(["2019", "2020", "2021"]);

    const last = checkpoints[2] as Record<string, unknown>;
    const summary = archiveJsonEntry(entries, "result/summary.json");
    const strategy = last.strategy as Record<string, number>;
    expect(strategy.cash).toBeCloseTo(summary.finalCash as number, 6);
    expect(strategy.totalValue).toBeCloseTo(summary.finalValue as number, 6);
    expect(strategy.tradeCount).toBe(summary.totalTrades);

    // Position-level continuation state, allowlisted rather than serialized wholesale.
    const positions = last.positions as Record<string, unknown>[];
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0]).toHaveProperty("epoch");
    expect(positions[0]).toHaveProperty("buyLevelsSettled");
    expect(positions[0]).toHaveProperty("sellLevelsFired");
    expect(positions[0]).toHaveProperty("previousSignedReturnPercent");
    expect(last.comparison).toMatchObject({ benchmarkPendingCapital: 0 });
  });
});

describe("backtest debug archive — inputs a reviewer replays from", () => {
  it("captures the authoritative execution calendar, not the securities' own dates", async () => {
    const { entries } = await captureRun();
    const calendar = archiveJsonEntry(
      entries,
      "inputs/execution-calendar.json",
    );

    expect(calendar.source).toMatchObject({
      referenceCode: "SP500",
      seriesId: CALENDAR_SERIES,
      seriesVersion: 1,
      methodologyVersion: BACKTEST_METHODOLOGY.executionCalendar,
    });

    const dates = calendar.dates as string[];
    expect(dates[0]).toBe(START);
    expect(dates.at(-1)).toBe(END);
    // The stray security bar on a day the market was closed is not a portfolio trading day…
    expect(dates).not.toContain(NON_CALENDAR_DATE);
    // …while the frame does carry it, which is precisely how a reviewer sees it was ignored.
    const frame = archiveJsonEntry(
      entries,
      "frames/2020/AAA-security-aaa.json",
    );
    expect(frame.dates as string[]).toContain(NON_CALENDAR_DATE);
    expect(
      archiveNdjsonEntry(entries, "result/equity.ndjson").map(
        (point) => point.date,
      ),
    ).not.toContain(NON_CALENDAR_DATE);
  });

  it("captures benchmark input prices sufficient to rebuild the comparison curve", async () => {
    const { entries } = await captureRun();
    const benchmark = archiveJsonEntry(entries, "inputs/benchmark.json");

    expect(benchmark.identity).toMatchObject({
      code: "SP500",
      seriesId: COMPARISON_SERIES,
    });

    const prices = benchmark.prices as { date: string; close: number }[];
    const closeAt = (date: string): number | null => {
      let close: number | null = null;
      for (const price of prices) {
        if (price.date <= date) {
          close = price.close;
        }
      }
      return close;
    };

    // Rebuild the funded scenario from the raw closes plus the funding events, exactly as the
    // methodology describes it, and check it against the curve the run persisted.
    let shares = 0;
    for (const event of archiveNdjsonEntry(
      entries,
      "inputs/contributions.ndjson",
    )) {
      const close = closeAt(event.date as string);
      expect(close).not.toBeNull();
      shares += (event.amount as number) / (close as number);
    }
    const equity = archiveNdjsonEntry(entries, "result/equity.ndjson");
    const last = equity.at(-1) as { date: string; benchmarkValue: string };
    // The archive stores the quantized six-decimal value, so the reconstruction is compared at
    // that scale rather than against an unrounded float.
    expect(shares * (closeAt(last.date) as number)).toBeCloseTo(
      Number(last.benchmarkValue),
      5,
    );
  });

  it("captures the funding events the simulation actually applied", async () => {
    const { entries, repository } = await captureRun();
    const events = archiveNdjsonEntry(entries, "inputs/contributions.ndjson");

    const initial = events.filter((event) => event.type === "INITIAL_CAPITAL");
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ date: START, amount: 100_000 });

    const contributions = events.filter(
      (event) => event.type === "MONTHLY_CONTRIBUTION",
    );
    expect(contributions.length).toBeGreaterThan(20);

    // They are the dates the run's own equity curve shows capital arriving on.
    const result = repository.results[0]?.result as BacktestResult;
    const deposits = result.equity
      .filter(
        (point, index) =>
          index > 0 &&
          point.investedCapital >
            (result.equity[index - 1]?.investedCapital ?? 0),
      )
      .map((point) => point.date);
    expect(contributions.map((event) => event.date)).toEqual(deposits);

    // All three comparison scenarios receive exactly this capital, which is what makes them
    // comparable — so the total has to reconcile with both the summary and the Cash baseline.
    const funded = events.reduce(
      (total, event) => total + (event.amount as number),
      0,
    );
    expect(funded).toBeCloseTo(Number(result.summary.investedCapital), 6);
    expect(funded).toBeCloseTo(
      Number(result.equity.at(-1)?.cashBaselineValue ?? 0),
      6,
    );
  });

  it("captures per-security preparation evidence and marks what it cannot attribute", async () => {
    const { entries } = await captureRun();
    const preparation = archiveJsonEntry(entries, "preparation/summary.json");

    expect(preparation.securityCount).toBe(2);
    expect(preparation.keptCount).toBe(2);
    expect(preparation.operands).toContain(RSI_OPERAND);

    const securities = preparation.securities as Record<string, unknown>[];
    expect(securities.map((entry) => entry.symbol).sort()).toEqual([
      "AAA",
      "BBB",
    ]);
    expect(securities[0]).toMatchObject({
      requestedFrom: START,
      requestedTo: END,
      skipped: false,
    });
    expect(securities[0]?.coverage).toMatchObject({ firstDate: START });

    // Honest about the gap rather than inventing a cache-hit number.
    expect(preparation.unattributable).toBeInstanceOf(Array);
    expect(JSON.stringify(preparation.unattributable)).toContain(
      "redisProjectionHitMissRebuild",
    );
  });
});

describe("backtest debug archive — outputs", () => {
  it("captures trades in execution order, with no generated narrative", async () => {
    const { entries, repository } = await captureRun();
    const trades = archiveNdjsonEntry(entries, "result/trades.ndjson");
    const result = repository.results[0]?.result as BacktestResult;

    expect(trades).toHaveLength(result.trades.length);
    expect(trades.map((trade) => trade.sequence)).toEqual(
      result.trades.map((trade) => trade.sequence),
    );
    expect(trades.map((trade) => trade.date)).toEqual(
      result.trades.map((trade) => trade.date),
    );
    expect(trades[0]).toMatchObject({
      action: result.trades[0]?.action,
      levelId: result.trades[0]?.levelId,
    });

    // The archive is evidence, not an explanation: an engine-produced reason would only ever agree
    // with the engine's own decision.
    for (const trade of trades) {
      expect(Object.keys(trade)).not.toContain("reason");
      expect(Object.keys(trade)).not.toContain("explanation");
      expect(Object.keys(trade)).not.toContain("rationale");
    }
  });

  it("captures the equity, positions and summary that were persisted", async () => {
    const { entries, repository } = await captureRun();
    const result = repository.results[0]?.result as BacktestResult;

    const equity = archiveNdjsonEntry(entries, "result/equity.ndjson");
    expect(equity).toHaveLength(result.equity.length);
    expect(equity[0]?.date).toBe(result.summary.firstSimulatedDate);
    expect(equity.at(-1)?.date).toBe(result.summary.lastSimulatedDate);

    // The two identities the curve has to satisfy, checkable from the archive alone.
    for (const point of equity) {
      // Canonical strings: parsed before arithmetic, never concatenated.
      expect(Number(point.cash) + Number(point.positionsValue)).toBeCloseTo(
        Number(point.totalValue),
        6,
      );
    }

    const positions = archiveJsonEntry(entries, "result/positions.json");
    expect(positions.count).toBe(result.positions.length);

    const summary = archiveJsonEntry(entries, "result/summary.json");
    expect(Number(summary.finalValue)).toBeCloseTo(
      Number(result.summary.finalValue),
      6,
    );
    expect(summary.totalTrades).toBe(result.summary.totalTrades);
    expect(summary.maxDrawdownPercent).toBeCloseTo(
      result.summary.maxDrawdownPercent,
      6,
    );
    expect(summary.tradingDays).toBe(result.summary.tradingDays);
  });
});

describe("backtest debug archive — failure and isolation", () => {
  it("archives a failed attempt with everything captured before it failed", async () => {
    // 2019 and 2020 simulate; 2021 cannot be projected.
    const { repository, files, entries } = await captureRun({
      stockData: new FixtureFrameLoader("2021"),
    });

    // The run itself is terminal and failed, exactly as it is without the archive.
    expect(repository.results).toEqual([]);
    expect(repository.failures).toHaveLength(1);
    expect(repository.failures[0]?.code).toBe("EXECUTION_FAILED");
    expect(repository.failures[0]?.phase).toBe("RUNNING");

    expect(files).toHaveLength(1);
    const manifest = archiveJsonEntry(entries, "manifest.json");
    expect((manifest.run as { status: string }).status).toBe("FAILED");

    const failure = archiveJsonEntry(entries, "diagnostics/failure.json");
    expect(failure.failureCode).toBe("EXECUTION_FAILED");
    expect(failure.phase).toBe("RUNNING");
    expect(failure.capturedThrough).toMatchObject({ windows: 2 });

    // The years that did run are still there, with their frames, trades and equity.
    expect(
      archiveNdjsonEntry(entries, "execution/windows.ndjson").map(
        (window) => window.year,
      ),
    ).toEqual(["2019", "2020"]);
    expect([...entries.keys()]).toContain("frames/2020/AAA-security-aaa.json");
    expect(
      archiveNdjsonEntry(entries, "result/equity.ndjson").length,
    ).toBeGreaterThan(0);
    // …and a failed attempt has no result to record.
    expect([...entries.keys()]).not.toContain("result/summary.json");
  });

  it("scrubs credentials out of the failure it records", async () => {
    const { entries } = await captureRun({
      stockData: new FixtureFrameLoader("2021"),
    });

    const raw = entries.get("diagnostics/failure.json") as string;
    expect(raw).not.toContain("super-secret-key");
    expect(raw).not.toContain("financialmodelingprep.com");
    expect(raw).toContain("<redacted-url>");
  });

  it("does not change the run when the archive directory cannot be used", async () => {
    // A file where the archive directory should be: staging cannot be created at all.
    const blocked = join(directory, "blocked");
    await writeFile(blocked, "not a directory", "utf8");

    const { processor, repository } = processorWith({
      debugArchives: archives({ directory: blocked }),
    });
    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);
    expect(await archiveFiles()).toEqual([]);
  });

  it("does not change the run when capture fails mid-flight", async () => {
    // Staging is replaced by a file the moment it is opened, so every later write fails.
    const sabotaged: BacktestDebugArchives = {
      open: async (context: BacktestDebugArchiveContext) => {
        const archive = await BacktestDebugArchive.open({
          directory,
          mode: "full",
          context,
          logger,
          now: () => new Date(),
        });
        if (archive) {
          await rm(archive.stagingRoot, { recursive: true, force: true });
          await writeFile(archive.stagingRoot, "not a directory", "utf8");
        }
        return archive;
      },
    };

    const off = processorWith({});
    await off.processor.process(claimOf(snapshotDocument()), lease);

    const { processor, repository } = processorWith({
      debugArchives: sabotaged,
    });
    await processor.process(claimOf(snapshotDocument()), lease);

    // The backtest completed with exactly the same numbers; the archive simply does not exist.
    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);
    expect(repository.results[0]?.result.summary).toEqual(
      off.repository.results[0]?.result.summary,
    );
    expect(repository.results[0]?.result.trades).toEqual(
      off.repository.results[0]?.result.trades,
    );
    expect(await archiveFiles()).toEqual([]);
  });

  it("carries no secret from the process environment", async () => {
    // Values a real worker genuinely has in scope while it runs.
    const secrets = {
      DATABASE_URL:
        "postgresql://intrinsic:pgpass-not-in-archive@localhost:5432/db",
      REDIS_URL: "redis://:redispass-not-in-archive@localhost:6379",
      FMP_API_KEY: "fmpkey-not-in-archive",
      AUTH_JWT_SECRET: "jwtsecret-not-in-archive",
    };
    const restore = { ...process.env };
    Object.assign(process.env, secrets);

    try {
      const { entries } = await captureRun();
      const whole = [...entries]
        .map(([name, content]) => `${name}\n${content}`)
        .join("\n");

      for (const value of Object.values(secrets)) {
        expect(whole).not.toContain(value);
      }
      // Not a redaction pass over a dump: nothing dumps the environment in the first place.
      for (const name of Object.keys(secrets)) {
        expect(whole).not.toContain(name);
      }
    } finally {
      process.env = restore;
    }
  });

  it("never overwrites another attempt's archive", async () => {
    const first = processorWith({ debugArchives: archives() });
    await first.processor.process(
      claimOf(snapshotDocument(), { attempt: 1 }),
      lease,
    );

    const second = processorWith({ debugArchives: archives() });
    await second.processor.process(
      claimOf(snapshotDocument(), { attempt: 2, jobId: "job-1" }),
      lease,
    );

    const third = processorWith({ debugArchives: archives() });
    await third.processor.process(
      claimOf(snapshotDocument(), { runId: "run-2", jobId: "job-2" }),
      lease,
    );

    expect(await archiveFiles()).toEqual([
      "backtest-debug-run-1-attempt-1.zip",
      "backtest-debug-run-1-attempt-2.zip",
      "backtest-debug-run-2-attempt-1.zip",
    ]);
  });
});
