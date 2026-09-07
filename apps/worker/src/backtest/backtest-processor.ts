import type {
  BacktestFailureCode,
  BacktestLiveSnapshotResponse,
  BacktestRunSnapshot,
  BacktestSnapshotSecurity,
} from "@intrinsic/contracts";
import { BacktestRunStatus } from "@intrinsic/database";
import type {
  Benchmark,
  BenchmarkDailyPrice,
  DateRange,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  collectOperands,
  simulateBacktest,
  type BacktestCheckpoint,
  type BacktestResult,
  type BacktestSecurityInput,
  type BenchmarkSeriesInput,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import {
  BacktestInterruptedError,
  type BacktestJobLease,
} from "./job-lease.js";
import {
  ABANDONED_FAILURE_MESSAGE,
  type BacktestJobRepository,
  type ClaimedBacktestJob,
} from "./job-repository.js";
import { toLiveSnapshotResponse } from "./live-snapshot.js";
import { parseRunSnapshot, snapshotBuyWindows } from "./run-snapshot.js";
import type { BacktestSecurityCatalog } from "./securities.js";
import type { BacktestJobProcessor } from "./worker-loop.js";

/**
 * The columnar projection the engine consumes.
 *
 * Declared as the narrow slice the worker needs rather than as the whole `StockDataService`: the
 * worker loads nothing else, and it must never grow its own Redis lookup, coverage reconciliation
 * or provider access — `@intrinsic/stock-data` owns all of that for both processes.
 */
export interface BacktestFrameLoader {
  getDailyEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame>;
}

/** The benchmark slice the worker needs; hydration happens inside the loader. */
export interface BacktestBenchmarkLoader {
  getBenchmark(code: string): Promise<Benchmark>;
  getBenchmarkDailyPrices(
    benchmark: Benchmark,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]>;
}

export type BacktestProcessorOptions = {
  frameConcurrency: number;
  checkpointEveryDays: number;
  checkpointMinIntervalMs: number;
  leaseMs: number;
  workerId: string;
  now?: () => Date;
};

export type BacktestProcessorDependencies = {
  repository: BacktestJobRepository;
  securities: BacktestSecurityCatalog;
  stockData: BacktestFrameLoader;
  benchmarks: BacktestBenchmarkLoader;
  logger: StructuredLogger;
};

/** The execution phase a failure happened in. Developer diagnostics only. */
type ExecutionPhase = "SNAPSHOT" | "PREPARING_DATA" | "RUNNING" | "FINALIZING";

/**
 * What a user is told, per failure code. Product prose only: provider names, URLs, credentials and
 * stack traces stay in `failureDetail`, which no API contract exposes.
 */
const FAILURE_MESSAGES: Record<BacktestFailureCode, string> = {
  DATA_UNAVAILABLE:
    "Market data is not available for the stocks in this list over the requested period.",
  NO_TRADING_DAYS:
    "The requested period contains no trading day for the stocks in this list.",
  EXECUTION_FAILED:
    "The backtest could not be completed. Please try running it again.",
  ABANDONED: ABANDONED_FAILURE_MESSAGE,
};

/** A failure the processor can name. Anything else is reported as `EXECUTION_FAILED`. */
class BacktestRunFailure extends Error {
  constructor(
    readonly code: BacktestFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "BacktestRunFailure";
  }
}

/** Progress budget per phase. 100 belongs to a persisted result and to nothing else. */
const PREPARING_START_PERCENT = 2;
const RUNNING_START_PERCENT = 20;
const RUNNING_MAX_PERCENT = 94;
const FINALIZING_PERCENT = 95;

/**
 * Executes one claimed backtest.
 *
 * The order is deliberate and observable: hydrate and project every security into an evaluation
 * frame, run the deterministic day loop while publishing bounded checkpoints, then write the
 * durable result. Nothing here reimplements loading or evaluation — the frames come from
 * `@intrinsic/stock-data` and the simulation from `@intrinsic/strategy`, exactly as the API would
 * consume them.
 */
export class BacktestProcessor implements BacktestJobProcessor {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: BacktestProcessorDependencies,
    private readonly options: BacktestProcessorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async process(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
  ): Promise<void> {
    const startedAt = Date.now();
    let phase: ExecutionPhase = "SNAPSHOT";

    try {
      const snapshot = parseRunSnapshot(claim.snapshot);
      const period = {
        from: snapshot.period.startDate,
        to: snapshot.period.endDate,
      } as const;

      this.dependencies.logger.info({
        event: "backtest.started",
        attempt: claim.attempt,
        securityCount: snapshot.securities.length,
        startDate: period.from,
        endDate: period.to,
        maximumPositions: snapshot.allocation.maximumPositions,
      });

      phase = "PREPARING_DATA";
      const prepared = await this.prepare(claim, lease, snapshot, period);

      phase = "RUNNING";
      const result = await this.simulate(claim, lease, snapshot, prepared);

      phase = "FINALIZING";
      await this.finalize(claim, lease, result);

      this.dependencies.logger.info({
        event: "backtest.completed",
        durationMs: Date.now() - startedAt,
        tradeCount: result.summary.totalTrades,
        tradingDays: result.summary.tradingDays,
        openPositions: result.summary.openPositions,
      });
    } catch (err) {
      if (err instanceof BacktestInterruptedError) {
        throw err;
      }
      await this.recordFailure(claim, lease, phase, err, startedAt);
    }
  }

  /**
   * PREPARING_DATA — project every list member into an evaluation frame.
   *
   * Frames are loaded with bounded concurrency because each one may hydrate from the provider, and
   * the FMP budget is shared with the API. A security with no usable history is skipped rather
   * than failing the run: a thirty-year period over a list containing a recent listing is a normal
   * backtest, not an error. Losing *every* security is different — there is nothing to simulate.
   */
  private async prepare(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    snapshot: BacktestRunSnapshot,
    period: Required<DateRange>,
  ): Promise<{
    securities: BacktestSecurityInput[];
    benchmark: BenchmarkSeriesInput | null;
  }> {
    const startedAt = Date.now();
    const operands = collectOperands(snapshot.strategy.definition);
    const catalog = await this.dependencies.securities.findByIds(
      snapshot.securities.map((security) => security.securityId),
    );

    await this.writeProgress(claim, lease, {
      status: BacktestRunStatus.PREPARING_DATA,
      percent: PREPARING_START_PERCENT,
      message: "Preparing market data",
    });

    const loaded: (BacktestSecurityInput | null)[] = snapshot.securities.map(
      () => null,
    );
    const total = snapshot.securities.length;
    let completed = 0;
    let skipped = 0;
    let lastReportAt = 0;

    // Resident frames complete in microseconds, so this is throttled exactly like a checkpoint;
    // the last security always reports, so the phase never ends short of its budget.
    const reportProgress = async (done: number): Promise<void> => {
      const at = this.now().getTime();
      if (
        done < total &&
        at - lastReportAt < this.options.checkpointMinIntervalMs
      ) {
        return;
      }
      lastReportAt = at;
      await this.writeProgress(claim, lease, {
        percent:
          PREPARING_START_PERCENT +
          Math.round(
            (done / Math.max(total, 1)) *
              (RUNNING_START_PERCENT - PREPARING_START_PERCENT),
          ),
        message: `Preparing market data — ${done} of ${total} stocks`,
      });
    };

    await this.mapWithConcurrency(
      snapshot.securities,
      async (member, index) => {
        const interruption = lease.interruption();
        if (interruption) {
          throw new BacktestInterruptedError(interruption);
        }

        const frame = await this.loadFrame(member, catalog, period, operands);
        if (frame) {
          loaded[index] = {
            frame,
            buyWindows: snapshotBuyWindows(member),
          };
        } else {
          skipped += 1;
        }

        completed += 1;
        await reportProgress(completed);
      },
    );

    const securities = loaded.filter(
      (entry): entry is BacktestSecurityInput => entry !== null,
    );

    this.dependencies.logger.info({
      event: "backtest.frames.loaded",
      durationMs: Date.now() - startedAt,
      securityCount: securities.length,
      skippedCount: skipped,
      operandCount: operands.length,
    });

    if (securities.length === 0) {
      throw new BacktestRunFailure(
        "DATA_UNAVAILABLE",
        `No security in the run produced usable daily data between ${period.from} and ${period.to}`,
      );
    }
    // The engine simulates the union of the frames' own trading days inside the period. When no
    // frame has a row in it there is no calendar to walk, which is a period problem rather than a
    // data problem, and the user is told so.
    if (
      securities.every(
        (entry) => entry.frame.periodStartIndex >= entry.frame.dates.length,
      )
    ) {
      throw new BacktestRunFailure(
        "NO_TRADING_DAYS",
        `No security has a trading day between ${period.from} and ${period.to}`,
      );
    }

    return {
      securities,
      benchmark: await this.loadBenchmark(snapshot, period),
    };
  }

  private async loadFrame(
    member: BacktestSnapshotSecurity,
    catalog: Map<string, Security>,
    period: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame | null> {
    // Identity is the snapshot's, frozen at submission; classification comes from the catalog row
    // it still references, which is what the loader needs to reach the right history.
    const row = catalog.get(member.securityId);
    if (!row) {
      this.dependencies.logger.warn({
        event: "backtest.security.skipped",
        symbol: member.symbol,
        reason: "CATALOG_ROW_MISSING",
      });
      return null;
    }

    const security: Security = {
      ...row,
      id: member.securityId,
      symbol: member.symbol,
      name: member.name,
      exchangeCode: member.exchangeCode,
      currency: member.currency,
    };

    const frame = await this.dependencies.stockData.getDailyEvaluationFrame(
      security,
      period,
      operands,
    );
    if (frame.dates.length === 0) {
      this.dependencies.logger.warn({
        event: "backtest.security.skipped",
        symbol: member.symbol,
        reason: "NO_DAILY_DATA",
      });
      return null;
    }
    return frame;
  }

  /**
   * Loads the comparison series the run snapshotted.
   *
   * A benchmark that cannot be loaded degrades the run instead of failing it: the contract already
   * models a missing comparison as a null benchmark return, and a portfolio result the user waited
   * minutes for should not be thrown away because one auxiliary series was unavailable.
   */
  private async loadBenchmark(
    snapshot: BacktestRunSnapshot,
    period: Required<DateRange>,
  ): Promise<BenchmarkSeriesInput | null> {
    const startedAt = Date.now();
    try {
      const benchmark = await this.dependencies.benchmarks.getBenchmark(
        snapshot.benchmark.code,
      );
      const prices = await this.dependencies.benchmarks.getBenchmarkDailyPrices(
        benchmark,
        period,
      );
      if (prices.length === 0) {
        this.dependencies.logger.warn({
          event: "backtest.benchmark.unavailable",
          benchmarkCode: snapshot.benchmark.code,
          reason: "NO_DAILY_DATA",
        });
        return null;
      }

      const closes = new Float64Array(prices.length);
      const dates: LocalDate[] = [];
      prices.forEach((price, index) => {
        dates.push(price.date);
        closes[index] = price.close;
      });

      this.dependencies.logger.info({
        event: "backtest.benchmark.loaded",
        durationMs: Date.now() - startedAt,
        benchmarkCode: benchmark.code,
        pointCount: prices.length,
      });

      return {
        benchmarkId: benchmark.id,
        code: benchmark.code,
        name: benchmark.name,
        dates,
        closes,
      };
    } catch (err) {
      this.dependencies.logger.warn({
        event: "backtest.benchmark.unavailable",
        benchmarkCode: snapshot.benchmark.code,
        durationMs: Date.now() - startedAt,
        err,
      });
      return null;
    }
  }

  /** RUNNING — the deterministic day loop, publishing bounded checkpoints as it advances. */
  private async simulate(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    snapshot: BacktestRunSnapshot,
    prepared: {
      securities: BacktestSecurityInput[];
      benchmark: BenchmarkSeriesInput | null;
    },
  ): Promise<BacktestResult> {
    await this.writeProgress(claim, lease, {
      status: BacktestRunStatus.RUNNING,
      percent: RUNNING_START_PERCENT,
      message: "Running backtest",
    });

    let lastCheckpointAt = 0;

    return simulateBacktest(
      {
        definition: snapshot.strategy.definition,
        securities: prepared.securities,
        benchmark: prepared.benchmark,
        startDate: snapshot.period.startDate,
        endDate: snapshot.period.endDate,
        initialCapital: snapshot.capital.initialCapital,
        monthlyContribution: snapshot.capital.monthlyContribution,
        maximumPositions: snapshot.allocation.maximumPositions,
      },
      {
        checkpointEveryDays: this.options.checkpointEveryDays,
        onCheckpoint: async (checkpoint) => {
          const interruption = lease.interruption();
          if (interruption) {
            throw new BacktestInterruptedError(interruption);
          }

          // A short run can checkpoint hundreds of times a second; the first one always lands, so
          // the running page has something to show immediately, and the rest are throttled.
          const at = this.now().getTime();
          if (
            lastCheckpointAt !== 0 &&
            at - lastCheckpointAt < this.options.checkpointMinIntervalMs
          ) {
            return;
          }
          lastCheckpointAt = at;

          await this.publishCheckpoint(claim, lease, checkpoint);
        },
      },
    );
  }

  private async publishCheckpoint(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    checkpoint: BacktestCheckpoint,
  ): Promise<void> {
    const progressed =
      checkpoint.totalDays > 0
        ? checkpoint.completedDays / checkpoint.totalDays
        : 0;
    const percent = Math.min(
      RUNNING_MAX_PERCENT,
      Math.max(
        RUNNING_START_PERCENT,
        Math.round(
          RUNNING_START_PERCENT +
            progressed * (RUNNING_MAX_PERCENT - RUNNING_START_PERCENT),
        ),
      ),
    );

    this.dependencies.logger.debug({
      event: "backtest.progress",
      percent,
      simulatedThrough: checkpoint.simulatedThrough,
      completedDays: checkpoint.completedDays,
      totalDays: checkpoint.totalDays,
    });

    await this.writeProgress(claim, lease, {
      percent,
      message: `Running backtest — simulated through ${checkpoint.simulatedThrough}`,
      simulatedThrough: checkpoint.simulatedThrough,
      snapshot: toLiveSnapshotResponse(checkpoint),
    });
  }

  /** FINALIZING — the durable result and the terminal transition, in one transaction. */
  private async finalize(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    result: BacktestResult,
  ): Promise<void> {
    await this.writeProgress(claim, lease, {
      status: BacktestRunStatus.FINALIZING,
      percent: FINALIZING_PERCENT,
      message: "Finalizing results",
      simulatedThrough: result.summary.lastSimulatedDate,
    });

    const persisted = await this.dependencies.repository.persistResult({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: this.options.workerId,
      now: this.now(),
      result,
    });
    if (!persisted) {
      lease.markLost();
      throw new BacktestInterruptedError("LEASE_LOST");
    }
  }

  private async recordFailure(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    phase: ExecutionPhase,
    err: unknown,
    startedAt: number,
  ): Promise<void> {
    const code =
      err instanceof BacktestRunFailure ? err.code : "EXECUTION_FAILED";
    const error = err instanceof Error ? err : new Error(String(err));

    // The original error is logged before it is translated, so its name, message and stack survive
    // even though none of them may reach the user-facing failure message.
    this.dependencies.logger.error({
      event: "backtest.failed",
      durationMs: Date.now() - startedAt,
      failureCode: code,
      phase,
      err: error,
    });

    const recorded = await this.dependencies.repository.failJob({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: this.options.workerId,
      now: this.now(),
      code,
      message: FAILURE_MESSAGES[code],
      detail: {
        phase,
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      },
    });
    if (!recorded) {
      lease.markLost();
      throw new BacktestInterruptedError("LEASE_LOST");
    }
  }

  /**
   * Publishes progress and renews the lease in one guarded write.
   *
   * A write that matches no row means this worker no longer owns the run, so it stops immediately
   * rather than continuing to compute a result it may not persist.
   */
  private async writeProgress(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    update: {
      status?: BacktestRunStatus;
      percent: number;
      message: string;
      simulatedThrough?: LocalDate;
      snapshot?: BacktestLiveSnapshotResponse;
    },
  ): Promise<void> {
    const held = await this.dependencies.repository.updateProgress({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: this.options.workerId,
      now: this.now(),
      leaseMs: this.options.leaseMs,
      ...update,
    });
    if (!held) {
      lease.markLost();
      throw new BacktestInterruptedError("LEASE_LOST");
    }
  }

  /** Runs `task` over `items` with at most `frameConcurrency` in flight, preserving order. */
  private async mapWithConcurrency<T>(
    items: readonly T[],
    task: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    const limit = Math.max(
      1,
      Math.min(this.options.frameConcurrency, items.length),
    );
    let next = 0;

    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        await task(item, index);
      }
    });

    await Promise.all(workers);
  }
}
