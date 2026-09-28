import {
  BACKTEST_SNAPSHOT_VERSION,
  type BacktestLiveSnapshotResponse,
} from "@intrinsic/contracts";
import {
  BACKTEST_DATA_REVISIONS,
  type DailyPriceBounds,
} from "@intrinsic/stock-data";
import {
  BACKTEST_METHODOLOGY,
  createEvaluationFrame,
  PRICE_OPERAND,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import type {
  BenchmarkDailyPrice,
  BenchmarkSeries,
  DateRange,
  Security,
} from "@intrinsic/domain";
import { BacktestRunStatus } from "@intrinsic/database";
import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import {
  BacktestProcessor,
  type BacktestBenchmarkLoader,
  type BacktestFrameLoader,
} from "./backtest-processor.js";
import type { BacktestJobLease } from "./job-lease.js";
import type {
  BacktestFailureWrite,
  BacktestJobRepository,
  BacktestMilestoneWrite,
  BacktestProgressWrite,
  BacktestResultWrite,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";

const logger = createLogger({ service: "worker", level: "silent" });

const COMPARISON_SERIES = "series-comparison";
const CALENDAR_SERIES = "series-calendar";
const SYMBOL = "AAA";
const SECURITY_ID = "security-1";
const START = "2019-06-03";
const END = "2021-05-31";

const lease: BacktestJobLease = {
  interruption: () => null,
  markLost: () => {},
} as unknown as BacktestJobLease;

/** A lease that remembers being told the claim is gone, so a test can prove the run noticed. */
function recordingLease(): BacktestJobLease & { readonly lost: () => boolean } {
  let lost = false;
  return {
    jobId: "job-1",
    runId: "run-1",
    interruption: () => null,
    markLost: () => {
      lost = true;
    },
    lost: () => lost,
  };
}

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

/** Every trading day of the fixture, from a year before the run so context reads are realistic. */
const HISTORY = weekdays("2018-06-01", END);
const closeOn = (date: string): number => 100 + HISTORY.indexOf(date) * 0.05;

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
                  id: "price-above-0",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 0 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      },
    },
    stockList: { stockListId: "list-1", name: "Fixture list" },
    securities: [
      {
        securityId: SECURITY_ID,
        symbol: SYMBOL,
        name: "AAA Inc.",
        exchangeCode: "NASDAQ",
        currency: "USD",
        buyWindowMode: "FULL",
        buyWindows: [],
      },
    ],
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
      seriesType: "ETF_PROXY",
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

function claimOf(snapshot: unknown): ClaimedBacktestJob {
  return {
    jobId: "job-1",
    runId: "run-1",
    attempt: 1,
    actorUserId: "user-1",
    snapshot,
  };
}

type ProgressWrite = {
  percent: number;
  status?: BacktestRunStatus;
  snapshot?: BacktestLiveSnapshotResponse;
  milestone?: BacktestMilestoneWrite;
};

/**
 * How a seeded repository answers one progress write.
 *
 * `THROW` is the case F-06 is about: the write reached the database and the database did not
 * answer in time. `DENY` is the ownership answer — the write executed and matched no row.
 */
type ProgressFault = "THROW" | "DENY";

/**
 * The exact error the audit observed, reproduced without waiting for a slow machine.
 *
 * `updateProgress` runs inside Prisma's **default** five-second interactive-transaction timeout,
 * and under the product's own supported concurrency a checkpoint upserting a JSON live-snapshot
 * document can exceed it. Constructing the error directly is what makes this deterministic:
 * nothing here sleeps, and the case does not depend on how loaded the machine running it is.
 */
function transactionExpired(): Error {
  const err = new Error(
    "Transaction API error: Transaction already closed: A query cannot be executed on an " +
      "expired transaction. The timeout for this transaction was 5000 ms, however 5576 ms " +
      "passed since the start of the transaction.",
  );
  err.name = "PrismaClientKnownRequestError";
  (err as Error & { code: string }).code = "P2028";
  return err;
}

class RecordingRepository implements BacktestJobRepository {
  readonly failures: BacktestFailureWrite[] = [];
  readonly results: BacktestResultWrite[] = [];
  readonly progress: ProgressWrite[] = [];
  /** Every write attempted, faulted ones included, so a test can prove one was tried. */
  readonly attempted: BacktestProgressWrite[] = [];

  constructor(
    /** Decides each write's fate from the write itself; absent means every write succeeds. */
    private readonly fault?: (
      write: BacktestProgressWrite,
    ) => ProgressFault | null,
  ) {}

  async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    return null;
  }
  async heartbeat(): Promise<boolean> {
    return true;
  }
  async recoverStaleJobs(): Promise<StaleJobRecovery> {
    return { requeued: 0, abandoned: 0 };
  }
  async updateProgress(write: BacktestProgressWrite): Promise<boolean> {
    this.attempted.push(write);
    const fault = this.fault?.(write) ?? null;
    if (fault === "THROW") {
      throw transactionExpired();
    }
    if (fault === "DENY") {
      return false;
    }
    this.progress.push({
      percent: write.percent,
      ...(write.status ? { status: write.status } : {}),
      ...(write.snapshot ? { snapshot: write.snapshot } : {}),
      ...(write.milestone ? { milestone: write.milestone } : {}),
    });
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

/** Reports every range the two phases asked for, and can fail one specific window. */
class RecordingFrameLoader implements BacktestFrameLoader {
  readonly prepared: Required<DateRange>[] = [];
  readonly windows: Required<DateRange>[] = [];

  constructor(private readonly failWindowStartingIn?: string) {}

  async prepareDailyEvaluationData(
    _security: Security,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null> {
    this.prepared.push(range);
    const inside = HISTORY.filter(
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
    this.windows.push(range);
    if (
      this.failWindowStartingIn &&
      range.from.startsWith(this.failWindowStartingIn)
    ) {
      throw new Error("the projection for this window could not be read");
    }
    // The loader widens a window by its own leading context, exactly as the real one does.
    const context = new Date(`${range.from}T00:00:00.000Z`);
    context.setUTCDate(context.getUTCDate() - 10);
    const from = context.toISOString().slice(0, 10);
    const dates = HISTORY.filter((date) => date >= from && date <= range.to);
    const closes = Float64Array.from(dates.map(closeOn));
    const columns = new Map<OperandKey, Float64Array>();
    for (const operand of operands) {
      if (operand !== PRICE_OPERAND) {
        columns.set(operand, closes.slice());
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

class FixtureBenchmarks implements BacktestBenchmarkLoader {
  async getSeries(seriesId: string): Promise<BenchmarkSeries> {
    return {
      id: seriesId,
      benchmarkId: "benchmark-1",
      version: 1,
      sourceKind: "FMP_SYMBOL",
      seriesType: "ETF_PROXY",
      providerSymbol: "SPY",
      currency: "USD",
      methodologyVersion: 1,
    };
  }

  async getBenchmarkDailyPrices(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]> {
    return weekdays(range.from, range.to).map((date, index) => ({
      seriesId: series.id,
      date,
      open: 400 + index * 0.2,
      high: 401 + index * 0.2,
      low: 399 + index * 0.2,
      close: 400 + index * 0.2,
      volume: 5_000,
    }));
  }

  async missingBenchmarkCoverage(): Promise<Required<DateRange>[]> {
    return [];
  }
}

function processorWith(
  stockData: BacktestFrameLoader,
  repository: RecordingRepository = new RecordingRepository(),
) {
  const processor = new BacktestProcessor(
    {
      repository,
      securities: {
        findByIds: async () =>
          new Map<string, Security>([
            [
              SECURITY_ID,
              {
                id: SECURITY_ID,
                symbol: SYMBOL,
                name: "AAA Inc.",
                exchangeCode: "NASDAQ",
                currency: "USD",
                type: "STOCK",
                isAdr: false,
                isActivelyTrading: true,
              },
            ],
          ]),
      },
      stockData,
      benchmarks: new FixtureBenchmarks(),
      logger,
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

/**
 * A long backtest is executed as consecutive calendar-year windows and is still one run.
 *
 * These cases are about the seam between the worker and the loader — which ranges are asked for,
 * when, and what a failure in a later year means — rather than about the arithmetic, which
 * `@intrinsic/strategy` proves against a continuous reference execution.
 */
describe("annual execution windows", () => {
  it("hydrates the whole period once and then reads one window per calendar year", async () => {
    const loader = new RecordingFrameLoader();
    const { processor, repository } = processorWith(loader);

    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);

    // PREPARING_DATA asks once, for the run's whole period. It is the only step that may hydrate.
    expect(loader.prepared).toEqual([{ from: START, to: END }]);

    // RUNNING asks per calendar year, clamped to the run at both ends.
    expect(loader.windows).toEqual([
      { from: START, to: "2019-12-31" },
      { from: "2020-01-01", to: "2020-12-31" },
      { from: "2021-01-01", to: END },
    ]);
  });

  it("produces one continuous result across the year boundaries", async () => {
    const { processor, repository } = processorWith(new RecordingFrameLoader());

    await processor.process(claimOf(snapshotDocument()), lease);

    const result = repository.results[0]?.result;
    expect(result).toBeDefined();
    const equity = result?.equity ?? [];
    const dates = equity.map((point) => point.date);

    // One equity point per simulated date, nothing duplicated at a boundary, strictly ascending.
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
    expect(dates[0]).toBe(START);
    expect(dates.at(-1)).toBe(END);
    expect(result?.summary.tradingDays).toBe(dates.length);

    // The position opened in 2019 is the same position at the end: one BUY, no re-entry, and the
    // cost basis carried across two New Years. The run then ends and liquidates it, which is what
    // makes the final state cash — so the proof that one lifecycle survived both boundaries is the
    // single terminal sale, dated the run's last simulated day.
    const trades = result?.trades ?? [];
    // Nothing exited before the end, so nothing re-entered: one lifecycle across both boundaries.
    expect(
      trades.filter(
        (trade) => trade.source === "STRATEGY" && trade.action !== "BUY",
      ),
    ).toHaveLength(0);
    const closeOut = trades.filter(
      (trade) => trade.source === "END_OF_BACKTEST",
    );
    expect(closeOut).toHaveLength(1);
    expect(closeOut[0]?.date).toBe(END);
    expect(result?.positions).toHaveLength(0);
    expect(result?.summary.openPositions).toBe(0);

    // Contributions kept landing once a month across both boundaries.
    const deposits = equity.filter(
      (point, index) =>
        index > 0 &&
        point.investedCapital > (equity[index - 1]?.investedCapital ?? 0),
    );
    expect(new Set(deposits.map((point) => point.date.slice(0, 7))).size).toBe(
      deposits.length,
    );
    expect(deposits.some((point) => point.date.startsWith("2020-01"))).toBe(
      true,
    );
    expect(deposits.some((point) => point.date.startsWith("2021-01"))).toBe(
      true,
    );

    // All three scenarios received the same external capital.
    const last = equity.at(-1);
    expect(last?.cashBaselineValue).toBe(result?.summary.investedCapital);
    expect(last?.benchmarkValue).not.toBeNull();
  });

  it("exposes each completed year's computed prefix to the running page", async () => {
    const { processor, repository } = processorWith(new RecordingFrameLoader());

    await processor.process(claimOf(snapshotDocument()), lease);

    const milestones = repository.progress.filter(
      (write) => write.milestone !== undefined,
    );
    expect(milestones.map((write) => write.milestone?.year)).toEqual([
      "2019",
      "2020",
    ]);

    // Each year's checkpoint carries the whole curve computed so far, in absolute currency, so a
    // page polling mid-run extends its chart instead of waiting for the run to finish.
    const first = milestones[0]?.snapshot;
    expect(first?.simulatedThrough.startsWith("2019-12")).toBe(true);
    expect(first?.curve[0]?.date).toBe(START);
    expect(first?.curve.at(-1)?.date).toBe(first?.simulatedThrough);
    expect(first?.curve.every((point) => point.strategyValue > 0)).toBe(true);
    expect(first?.curve.every((point) => point.cashBaselineValue > 0)).toBe(
      true,
    );
    expect(first?.cashBaselineValue).toBeGreaterThan(0);
    expect(first?.benchmarkValue).not.toBeNull();

    // 2020's checkpoint extends the same curve rather than restarting it.
    const second = milestones[1]?.snapshot;
    expect(second?.curve[0]?.date).toBe(START);
    expect(second?.completedDays).toBeGreaterThan(first?.completedDays ?? 0);
    // And it is a prefix of the run, not the whole of it: the last year is still to come.
    expect(second?.completedDays).toBeLessThan(second?.totalDays ?? 0);
  });

  it("fails the whole run when a later window cannot be read, never partially completing it", async () => {
    // 2019 and 2020 simulate; 2021 cannot be projected.
    const loader = new RecordingFrameLoader("2021");
    const { processor, repository } = processorWith(loader);

    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.results).toEqual([]);
    expect(repository.failures).toHaveLength(1);
    expect(repository.failures[0]?.code).toBe("EXECUTION_FAILED");
    expect(repository.failures[0]?.phase).toBe("RUNNING");

    // The earlier years genuinely ran — which is exactly why the run must be terminal rather than
    // reported as a shorter completed backtest.
    expect(
      repository.progress.filter((write) => write.milestone !== undefined),
    ).toHaveLength(2);
    expect(loader.windows).toHaveLength(3);
  });
});

/**
 * A bookkeeping write must not be able to fail a simulation it cannot influence.
 *
 * These cases are about the seam between the worker and the **repository** — what a progress write
 * is allowed to decide about a run — rather than the loader seam the cases above cover. They share
 * the fixture because the property only means anything on a run that really executes: the proof is
 * that a faulted run and a clean run produce the same numbers, which needs both to be real.
 *
 * The defect they pin (audit F-06): `updateProgress` runs inside Prisma's default five-second
 * interactive-transaction timeout, and a checkpoint that exceeded it aborted the whole run with
 * `EXECUTION_FAILED`. The engine had computed the window correctly; a progress bar killed it.
 *
 * Nothing here moves a timeout, and no case depends on wall-clock timing.
 */
describe("progress checkpoint durability", () => {
  /** Written by `PREPARING_DATA` / `RUNNING` / `FINALIZING`, and by nothing else. */
  const isPhaseTransition = (write: BacktestProgressWrite): boolean =>
    write.status !== undefined;

  it("completes the run, unchanged, when every checkpoint write expires", async () => {
    const clean = processorWith(new RecordingFrameLoader());
    await clean.processor.process(claimOf(snapshotDocument()), lease);
    const expected = clean.repository.results[0]?.result;
    expect(expected).toBeDefined();

    // Every observation write fails the way the audit observed. The three phase transitions still
    // succeed: this is a slow bookkeeping write, not an unreachable database.
    const faulted = processorWith(
      new RecordingFrameLoader(),
      new RecordingRepository((write) =>
        isPhaseTransition(write) ? null : "THROW",
      ),
    );
    await faulted.processor.process(claimOf(snapshotDocument()), lease);

    // The run survived, and it is the same run.
    expect(faulted.repository.failures).toEqual([]);
    expect(faulted.repository.results).toHaveLength(1);
    const actual = faulted.repository.results[0]?.result;
    expect(actual?.summary).toEqual(expected?.summary);
    expect(actual?.trades).toEqual(expected?.trades);
    expect(actual?.equity).toEqual(expected?.equity);
    expect(actual?.positions).toEqual(expected?.positions);

    // The checkpoints really were attempted and really did fail, so the case proves tolerance
    // rather than a fixture that happens to checkpoint nothing.
    const observations = faulted.repository.attempted.filter(
      (write) => !isPhaseTransition(write),
    );
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.some((write) => write.milestone)).toBe(true);
    // Not one of them landed: the run's three phase transitions are all that reached the row.
    expect(faulted.repository.progress.map((write) => write.percent)).toEqual([
      2, 20, 95,
    ]);
  });

  it("persists one result, once, after its checkpoints failed", async () => {
    const { processor, repository } = processorWith(
      new RecordingFrameLoader(),
      new RecordingRepository((write) =>
        isPhaseTransition(write) ? null : "THROW",
      ),
    );

    await processor.process(claimOf(snapshotDocument()), lease);

    // A tolerated checkpoint must not turn into a retry of anything durable: one result write,
    // one set of trades, no duplicated terminal sale.
    expect(repository.results).toHaveLength(1);
    const trades = repository.results[0]?.result.trades ?? [];
    expect(
      trades.filter((trade) => trade.source === "END_OF_BACKTEST"),
    ).toHaveLength(1);
    expect(
      new Set(trades.map((trade) => `${trade.date}:${trade.action}`)).size,
    ).toBe(trades.length);
  });

  it("stops at once when a checkpoint reports the claim is gone", async () => {
    const claimLost = recordingLease();
    const { processor, repository } = processorWith(
      new RecordingFrameLoader(),
      new RecordingRepository((write) =>
        isPhaseTransition(write) ? null : "DENY",
      ),
    );

    // A write that executed and matched no row is the ownership answer, and it is unaffected by
    // the tolerance above: another worker holds this run, so this one must write nothing more.
    await expect(
      processor.process(claimOf(snapshotDocument()), claimLost),
    ).rejects.toMatchObject({
      name: "BacktestInterruptedError",
      reason: "LEASE_LOST",
    });
    expect(claimLost.lost()).toBe(true);
    expect(repository.results).toEqual([]);
    expect(repository.failures).toEqual([]);
  });

  it("re-sends a phase transition that never landed, and completes", async () => {
    // Only the *first* attempt at the transition into RUNNING fails, which is what a stalled
    // bookkeeping transaction looks like: the database is busy for a moment, not gone.
    let refused = false;
    const { processor, repository } = processorWith(
      new RecordingFrameLoader(),
      new RecordingRepository((write) => {
        if (write.status === "RUNNING" && !refused) {
          refused = true;
          return "THROW";
        }
        return null;
      }),
    );

    await processor.process(claimOf(snapshotDocument()), lease);

    expect(refused).toBe(true);
    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);

    // The status was carried to the next checkpoint rather than abandoned, so a poller sees the
    // right phase within seconds instead of a run that is running while the row says otherwise.
    const landed = repository.progress.filter(
      (write) => write.status === "RUNNING",
    );
    expect(landed).toHaveLength(1);
    // And it was repaired once, not re-sent on every checkpoint afterwards.
    expect(
      repository.attempted.filter((write) => write.status === "RUNNING"),
    ).toHaveLength(2);
  });

  it("completes even when no phase transition can be written at all", async () => {
    const { processor, repository } = processorWith(
      new RecordingFrameLoader(),
      new RecordingRepository(() => "THROW"),
    );

    // The strongest form: not one progress write of any kind reaches the database for the whole
    // run. Nothing the day loop computes depends on one, so the run still produces its result —
    // `persistResult` is a different, ownership-guarded write with its own budget.
    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);
    expect(repository.progress).toEqual([]);
  });

  it("loses only the milestone when a year-boundary write expires", async () => {
    const { processor, repository } = processorWith(
      new RecordingFrameLoader(),
      new RecordingRepository((write) =>
        write.milestone?.year === "2020" ? "THROW" : null,
      ),
    );

    await processor.process(claimOf(snapshotDocument()), lease);

    expect(repository.failures).toEqual([]);
    expect(repository.results).toHaveLength(1);

    // 2020's milestone is gone — that is the whole cost — and 2019's still landed. A milestone is
    // a record of progress the day loop never reads, and a requeue discards the lot anyway.
    const years = repository.progress
      .map((write) => write.milestone?.year)
      .filter((year): year is string => year !== undefined);
    expect(years).not.toContain("2020");
    expect(years).toContain("2019");
  });
});
