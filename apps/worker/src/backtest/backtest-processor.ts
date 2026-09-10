import {
  revisionMismatches,
  type BacktestFailureCode,
  type BacktestFailurePhase,
  type BacktestLiveSnapshotResponse,
  type BacktestRunSnapshot,
  type BacktestSnapshotSecurity,
} from "@intrinsic/contracts";
import { BacktestRunStatus } from "@intrinsic/database";
import type {
  BenchmarkSeries,
  BenchmarkDailyPrice,
  DateRange,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  collectOperands,
  createBacktestSimulation,
  methodologyMismatches,
  type BacktestCheckpoint,
  type BacktestExecutionWindow,
  type BacktestResult,
  type BacktestSecuritySetup,
  type BenchmarkSeriesInput,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import type {
  ArchivePreparedSecurity,
  BacktestArchiveStatus,
  BacktestDebugArchive,
  ProviderRequestCounts,
} from "./debug/backtest-debug-archive.js";
import {
  providerRequestsSince,
  type BacktestDebugArchives,
} from "./debug/debug-archives.js";
import {
  BacktestInterruptedError,
  type BacktestJobLease,
} from "./job-lease.js";
import {
  BACKTEST_DATA_REVISIONS,
  type DailyPriceBounds,
} from "@intrinsic/stock-data";
import {
  ABANDONED_FAILURE_MESSAGE,
  type BacktestJobRepository,
  type BacktestMilestoneWrite,
  type ClaimedBacktestJob,
} from "./job-repository.js";
import { toLiveSnapshotResponse } from "./live-snapshot.js";
import { parseRunSnapshot, snapshotBuyWindows } from "./run-snapshot.js";
import type { BacktestSecurityCatalog } from "./securities.js";
import type { BacktestJobProcessor } from "./worker-loop.js";

/**
 * The two-step projection the engine consumes.
 *
 * Declared as the narrow slice the worker needs rather than as the whole `StockDataService`: the
 * worker loads nothing else, and it must never grow its own Redis lookup, coverage reconciliation
 * or provider access — `@intrinsic/stock-data` owns all of that for both processes.
 *
 * The split is the whole point of annual execution. `prepare` runs once per security in
 * `PREPARING_DATA` and is the only step allowed to hydrate: it makes the canonical data for the
 * **whole** period resident under the existing warm-up, freshness, coverage and revision rules.
 * `read` then projects one calendar-year window at a time during `RUNNING`, without re-entering
 * hydration — so a thirty-year run reads thirty windows and still hydrates once.
 */
export interface BacktestFrameLoader {
  /**
   * Makes the whole period's canonical data ready and reports the persisted price coverage inside
   * it, or null when the security has none.
   */
  prepareDailyEvaluationData(
    security: Security,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null>;
  /** Projects one already-prepared window. Must not hydrate. */
  readDailyEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame>;
}

/**
 * The benchmark slice the worker needs; hydration happens inside the loader.
 *
 * Deliberately **only** `getSeries` — resolution by code does not exist here. A run pins the exact
 * immutable series at submission, and execution reads that id back, so a catalog change between
 * queueing and running cannot change what the run compares against or which dates it simulates.
 */
export interface BacktestBenchmarkLoader {
  getSeries(seriesId: string): Promise<BenchmarkSeries>;
  getBenchmarkDailyPrices(
    series: BenchmarkSeries,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[]>;
  /**
   * Ranges inside `period` the pinned series has no durable coverage for; empty means complete.
   *
   * The distinction execution needs is between "this series' own history starts later", which is
   * ordinary, and "the canonical data this run recorded is missing", which must fail the run
   * rather than shorten it.
   */
  missingBenchmarkCoverage(
    series: BenchmarkSeries,
    period: Required<DateRange>,
  ): Promise<Required<DateRange>[]>;
}

/** One run security after `PREPARING_DATA`: its resolved identity and what its history covers. */
type PreparedSecurity = {
  security: Security;
  /** Persisted price coverage inside the requested period. Never null for a kept security. */
  coverage: DailyPriceBounds;
  setup: BacktestSecuritySetup;
};

/** One security's preparation, plus the forensic record of it. */
type PreparedSecurityOutcome = {
  prepared: PreparedSecurity | null;
  record: ArchivePreparedSecurity;
};

/** Everything `RUNNING` needs, with not one security frame resident yet. */
type PreparedRun = {
  securities: PreparedSecurity[];
  operands: readonly OperandKey[];
  benchmark: BenchmarkSeriesInput | null;
  executionCalendar: LocalDate[];
};

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
  /**
   * Opt-in forensic capture, absent unless `BACKTEST_DEBUG_ARCHIVE` asked for it.
   *
   * Deliberately an absent dependency rather than a disabled implementation: with the feature off
   * there is no object to call and therefore no filesystem work to accidentally perform. It is
   * observational in every direction — nothing it records is read back, and a failure inside it
   * cannot change this run's outcome.
   */
  debugArchives?: BacktestDebugArchives;
  /** Provider requests this process has made, when the capture is on. See `ProviderRequestMeter`. */
  providerRequests?: () => ProviderRequestCounts;
};

/**
 * The execution phase a failure happened in.
 *
 * `SNAPSHOT` covers everything before a phase is entered — reading and parsing the submission — and
 * has no product label, because a user cannot act on it. The other three are shown.
 */
type ExecutionPhase = "SNAPSHOT" | BacktestFailurePhase;

/**
 * Names the stocks that produced no usable data, bounded so a 200-security list cannot turn a
 * failure message into a wall of text.
 */
function skippedContext(symbols: readonly string[]): string | undefined {
  if (symbols.length === 0) {
    return undefined;
  }
  const sorted = [...symbols].sort();
  const shown = sorted.slice(0, 5).join(", ");
  return sorted.length > 5
    ? `No market data was found for ${shown} and ${sorted.length - 5} more.`
    : `No market data was found for ${shown}.`;
}

/** The phases a user is told about. `SNAPSHOT` is ours, not theirs. */
function userFacingPhase(phase: ExecutionPhase): BacktestFailurePhase | null {
  return phase === "SNAPSHOT" ? null : phase;
}

/**
 * What a user is told, per failure code. Product prose only: provider names, URLs, credentials and
 * stack traces stay in `failureDetail`, which no API contract exposes.
 */
const FAILURE_MESSAGES: Record<BacktestFailureCode, string> = {
  DATA_UNAVAILABLE:
    "Market data is not available for the stocks in this list over the requested period.",
  EXECUTION_CALENDAR_UNAVAILABLE:
    "The market calendar this backtest runs on could not be loaded, so it was stopped rather " +
    "than run over a different set of trading days. Try again shortly.",
  ENGINE_VERSION_MISMATCH:
    "This backtest was queued under an older execution methodology. Run it again to use the " +
    "current version.",
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
    /**
     * Sanitized product context appended to the user-facing message, such as which stocks could
     * not be prepared. Never a provider name, a URL, a credential or a stack.
     */
    readonly context?: string,
    /**
     * Diagnostics for whoever has to explain the failure later. Merged into `failureDetail`, which
     * no API contract projects, and never into the message a user reads — internal engine revision
     * strings would tell them nothing and are not theirs to see.
     */
    readonly developerDetail?: Record<string, unknown>,
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
    // Opened before anything else so a run that fails while parsing its own snapshot still leaves
    // an archive saying so, and closed in `finally` so no exit path — including an interruption —
    // leaves staging behind. It is null unless the capture is configured on.
    const archive =
      (await this.dependencies.debugArchives?.open({
        runId: claim.runId,
        jobId: claim.jobId,
        attempt: claim.attempt,
        workerId: this.options.workerId,
      })) ?? null;
    let archiveStatus: BacktestArchiveStatus = "INTERRUPTED";

    try {
      const snapshot = parseRunSnapshot(claim.snapshot);
      await archive?.recordSnapshot(snapshot);
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
      this.assertMethodologySupported(claim, snapshot);
      const prepared = await this.prepare(
        claim,
        lease,
        snapshot,
        period,
        archive,
      );

      phase = "RUNNING";
      const runningStartedAt = Date.now();
      const result = await this.simulate(
        claim,
        lease,
        snapshot,
        prepared,
        archive,
      );
      archive?.recordTiming("runningMs", Date.now() - runningStartedAt);

      phase = "FINALIZING";
      const finalizingStartedAt = Date.now();
      await archive?.recordResult(result);
      await this.finalize(claim, lease, result);
      archive?.recordTiming("finalizingMs", Date.now() - finalizingStartedAt);
      archiveStatus = "COMPLETED";

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
      archiveStatus = "FAILED";
      await this.recordFailure(claim, lease, phase, err, startedAt, archive);
    } finally {
      // The archive's own outcome never reaches the run's: `finalize` reports its failures through
      // the logger and returns null rather than throwing.
      await archive?.finalize(archiveStatus);
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
  /**
   * Refuses a run this build cannot execute as recorded.
   *
   * A queued run carries the execution methodology **and the data-interpretation revisions** it
   * was submitted under, and a deploy between queueing and claiming can leave the worker
   * implementing different ones. Executing anyway would
   * produce numbers under today's rules and store them beside yesterday's version stamps, which is
   * precisely the record that exists to make a run reproducible.
   *
   * The refusal is deliberately dumb: no registry of past engines, no rewriting the snapshot to
   * today's versions, no re-submitting on the user's behalf. The run is data, and re-running it
   * under a newer engine is a *new* run — which is exactly what the message asks the user to do.
   *
   * Checked before anything is hydrated: the answer cannot change with effort spent.
   */
  private assertMethodologySupported(
    claim: ClaimedBacktestJob,
    snapshot: BacktestRunSnapshot,
  ): void {
    const mismatches = [
      ...methodologyMismatches(snapshot.methodology).map((mismatch) => ({
        ...mismatch,
        field: `methodology.${mismatch.field}`,
      })),
      // The same class of problem, and the same answer: a build that interprets a price bar or a
      // derived column differently produces different numbers from the same Strategy document,
      // and would store them under the revisions the snapshot recorded. One failure code, because
      // a user cannot act differently on the two — the field name in the developer detail is what
      // distinguishes them for whoever has to explain it.
      ...revisionMismatches(
        snapshot.dataRevisions,
        BACKTEST_DATA_REVISIONS,
      ).map((mismatch) => ({
        ...mismatch,
        field: `dataRevisions.${mismatch.field}`,
      })),
    ];
    if (mismatches.length === 0) {
      return;
    }
    // Which versions disagree is developer detail: it names internal engine revisions and would
    // mean nothing to a user, who only needs to know the run is stale. It reaches the logs and
    // `failureDetail`, never the HTTP contract.
    const described = mismatches.map(
      (mismatch) =>
        `${mismatch.field}: snapshot=${mismatch.actual ?? "<absent>"} ` +
        `worker=${mismatch.expected ?? "<unsupported>"}`,
    );
    this.dependencies.logger.error({
      event: "backtest.runtime.unsupported",
      runId: claim.runId,
      jobId: claim.jobId,
      attempt: claim.attempt,
      mismatches: described,
    });
    throw new BacktestRunFailure(
      "ENGINE_VERSION_MISMATCH",
      FAILURE_MESSAGES.ENGINE_VERSION_MISMATCH,
      undefined,
      {
        failureCode: "ENGINE_VERSION_MISMATCH",
        methodologyMismatches: described,
      },
    );
  }

  private async prepare(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    snapshot: BacktestRunSnapshot,
    period: Required<DateRange>,
    archive: BacktestDebugArchive | null,
  ): Promise<PreparedRun> {
    const startedAt = Date.now();
    const providerRequestsBefore =
      this.dependencies.providerRequests?.() ?? null;
    const operands = collectOperands(snapshot.strategy.definition);
    const catalog = await this.dependencies.securities.findByIds(
      snapshot.securities.map((security) => security.securityId),
    );

    await this.writeProgress(claim, lease, {
      status: BacktestRunStatus.PREPARING_DATA,
      percent: PREPARING_START_PERCENT,
      message: "Preparing market data",
    });

    // Before anything expensive. The calendar is a precondition of the whole run, not one input
    // among many: without it there is no methodology to execute, so discovering that after
    // hydrating thirty securities would only waste minutes to reach the same refusal.
    const executionCalendar = await this.loadExecutionCalendar(
      snapshot,
      period,
      archive,
    );

    const loaded: (PreparedSecurity | null)[] = snapshot.securities.map(
      () => null,
    );
    const preparationRecords: (ArchivePreparedSecurity | null)[] =
      snapshot.securities.map(() => null);
    const total = snapshot.securities.length;
    let completed = 0;
    let skipped = 0;
    const skippedSymbols: string[] = [];
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

        const outcome = await this.prepareSecurity(member, catalog, period);
        preparationRecords[index] = outcome.record;
        if (outcome.prepared) {
          loaded[index] = outcome.prepared;
        } else {
          skipped += 1;
          skippedSymbols.push(member.symbol);
        }

        completed += 1;
        await reportProgress(completed);
      },
    );

    const securities = loaded.filter(
      (entry): entry is PreparedSecurity => entry !== null,
    );

    const preparationMs = Date.now() - startedAt;
    await archive?.recordPreparation({
      securities: preparationRecords.filter(
        (entry): entry is ArchivePreparedSecurity => entry !== null,
      ),
      operands,
      durationMs: preparationMs,
      providerRequests: providerRequestsSince(
        providerRequestsBefore,
        this.dependencies.providerRequests?.() ?? null,
      ),
    });

    this.dependencies.logger.info({
      event: "backtest.frames.loaded",
      durationMs: Date.now() - startedAt,
      securityCount: securities.length,
      skippedCount: skipped,
      ...(skippedSymbols.length > 0
        ? { skippedSymbols: [...skippedSymbols].sort() }
        : {}),
      operandCount: operands.length,
    });

    if (securities.length === 0) {
      throw new BacktestRunFailure(
        "DATA_UNAVAILABLE",
        `No security in the run produced usable daily data between ${period.from} and ${period.to}`,
        // Symbols are the user's own list, so naming them is safe and is what makes the failure
        // actionable: it points at which stocks to check rather than at "try again".
        skippedContext(skippedSymbols),
      );
    }
    // The engine walks the pinned execution calendar, but a period in which not one security ever
    // traded is a period problem rather than a data problem, and the user is told so.
    if (securities.every((entry) => entry.coverage === null)) {
      throw new BacktestRunFailure(
        "NO_TRADING_DAYS",
        `No security has a trading day between ${period.from} and ${period.to}`,
      );
    }

    return {
      securities,
      operands,
      benchmark: await this.loadBenchmark(snapshot, period, archive),
      executionCalendar,
    };
  }

  /**
   * Hydrates one security for the whole period and records what it actually covers.
   *
   * This is the run's only hydration of this security: every calendar-year window afterwards reads
   * the projection it left resident. A security with no usable history is skipped rather than
   * failing the run — a thirty-year period over a list containing a recent listing is a normal
   * backtest, not an error — while losing *every* security is different, and is caught by the
   * caller.
   */
  private async prepareSecurity(
    member: BacktestSnapshotSecurity,
    catalog: Map<string, Security>,
    period: Required<DateRange>,
  ): Promise<PreparedSecurityOutcome> {
    const startedAt = Date.now();
    // The forensic record of this one hydration, built whether it succeeded or not: "this security
    // was skipped, for this reason, after this long" is exactly what a loading investigation needs
    // and is the part a result can never show.
    const record = (
      extra: Partial<ArchivePreparedSecurity> = {},
    ): ArchivePreparedSecurity => ({
      securityId: member.securityId,
      symbol: member.symbol,
      requestedFrom: period.from,
      requestedTo: period.to,
      durationMs: Date.now() - startedAt,
      coverage: null,
      skipped: true,
      skipReason: null,
      ...extra,
    });

    // Identity is the snapshot's, frozen at submission; classification comes from the catalog row
    // it still references, which is what the loader needs to reach the right history.
    const row = catalog.get(member.securityId);
    if (!row) {
      this.dependencies.logger.warn({
        event: "backtest.security.skipped",
        symbol: member.symbol,
        reason: "CATALOG_ROW_MISSING",
      });
      return {
        prepared: null,
        record: record({ skipReason: "CATALOG_ROW_MISSING" }),
      };
    }

    const security: Security = {
      ...row,
      id: member.securityId,
      symbol: member.symbol,
      name: member.name,
      exchangeCode: member.exchangeCode,
      currency: member.currency,
    };

    const coverage =
      await this.dependencies.stockData.prepareDailyEvaluationData(
        security,
        period,
      );
    if (coverage === null) {
      // No persisted price row anywhere in the period. The security stays in the run only if it
      // could still act, and it cannot, so it is skipped exactly as before.
      this.dependencies.logger.warn({
        event: "backtest.security.skipped",
        symbol: member.symbol,
        reason: "NO_DAILY_DATA",
      });
      return {
        prepared: null,
        record: record({ skipReason: "NO_DAILY_DATA" }),
      };
    }

    return {
      prepared: {
        security,
        coverage,
        setup: {
          securityId: member.securityId,
          symbol: member.symbol,
          name: member.name,
          buyWindows: snapshotBuyWindows(member),
        },
      },
      record: record({ coverage, skipped: false }),
    };
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
    archive: BacktestDebugArchive | null,
  ): Promise<BenchmarkSeriesInput | null> {
    const startedAt = Date.now();
    const prices = await this.loadSeriesPrices(
      snapshot.benchmark.seriesId,
      period,
      { role: "comparison", code: snapshot.benchmark.code },
    );
    if (!prices || prices.length === 0) {
      // Recorded even when it is missing: "this run had no comparison series" and "the archive
      // dropped the comparison series" must not look the same to a reviewer.
      await archive?.recordBenchmark({
        benchmark: snapshot.benchmark,
        prices: null,
        durationMs: Date.now() - startedAt,
        unavailableReason: prices === null ? "LOAD_FAILED" : "NO_DAILY_DATA",
      });
      return null;
    }

    const closes = new Float64Array(prices.length);
    const dates: LocalDate[] = [];
    prices.forEach((price, index) => {
      dates.push(price.date);
      closes[index] = price.close;
    });

    // The raw closes, before anything is derived from them: the funded comparison scenario is what
    // a reviewer is checking, so the archive has to carry its input rather than its output.
    await archive?.recordBenchmark({
      benchmark: snapshot.benchmark,
      prices,
      durationMs: Date.now() - startedAt,
      unavailableReason: null,
    });

    this.dependencies.logger.info({
      event: "backtest.benchmark.loaded",
      durationMs: Date.now() - startedAt,
      benchmarkCode: snapshot.benchmark.code,
      benchmarkSeriesId: snapshot.benchmark.seriesId,
      benchmarkSeriesVersion: snapshot.benchmark.seriesVersion,
      pointCount: prices.length,
    });

    return {
      benchmarkId: snapshot.benchmark.benchmarkId,
      code: snapshot.benchmark.code,
      name: snapshot.benchmark.name,
      dates,
      closes,
    };
  }

  /**
   * The market's trading days over the run's period.
   *
   * Read from the reference series the run pinned at submission, **never** from the comparison
   * benchmark above: the dates a run simulates decide when contributions land, so a user's choice
   * of what to compare against must not reach them.
   *
   * There is deliberately **no fallback**. The calendar is part of the snapshotted methodology, and
   * quietly simulating the securities' own union instead would mean a run silently executed a
   * different methodology than the one it recorded — a different set of contribution dates, a
   * different return-index base, different numbers — because an auxiliary series happened to be
   * unreadable during this attempt. A retry against the same pinned series is correct; a different
   * answer is not. So this fails the attempt, and the next one executes the same calendar or fails
   * the same way.
   */
  private async loadExecutionCalendar(
    snapshot: BacktestRunSnapshot,
    period: Required<DateRange>,
    archive: BacktestDebugArchive | null,
  ): Promise<LocalDate[]> {
    const startedAt = Date.now();
    const seriesId = snapshot.executionCalendar?.seriesId;
    const referenceCode = snapshot.executionCalendar?.referenceCode ?? null;
    if (!seriesId) {
      // A run submitted before the calendar became required. It cannot be executed under the
      // methodology it recorded, so it is not executed at all.
      this.dependencies.logger.error({
        event: "backtest.execution-calendar.unavailable",
        reason: "NOT_PINNED",
        referenceCode,
      });
      throw new BacktestRunFailure(
        "EXECUTION_CALENDAR_UNAVAILABLE",
        FAILURE_MESSAGES.EXECUTION_CALENDAR_UNAVAILABLE,
      );
    }
    const prices = await this.loadSeriesPrices(seriesId, period, {
      role: "execution-calendar",
      code: referenceCode ?? seriesId,
    });
    if (!prices || prices.length === 0) {
      this.dependencies.logger.error({
        event: "backtest.execution-calendar.unavailable",
        reason: prices === null ? "LOAD_FAILED" : "NO_TRADING_DAYS",
        referenceCode,
        seriesId,
      });
      throw new BacktestRunFailure(
        "EXECUTION_CALENDAR_UNAVAILABLE",
        FAILURE_MESSAGES.EXECUTION_CALENDAR_UNAVAILABLE,
      );
    }
    // The calendar must span the period the run recorded, not merely return some dates inside it.
    // A run executes exactly its immutable period or fails saying it could not: quietly simulating
    // a shorter one moves the first simulated date, and with it the return-index base, the first
    // contribution and every number chained off them.
    await this.assertCalendarCoversPeriod(seriesId, referenceCode, period);
    this.dependencies.logger.info({
      event: "backtest.execution-calendar.loaded",
      durationMs: Date.now() - startedAt,
      referenceCode,
      seriesId,
      tradingDays: prices.length,
    });
    const dates = prices.map((price) => price.date);
    // Captured from the authoritative series, never re-derived from the security frames: which
    // dates the portfolio has is methodology, and a reviewer checking that a stray security row was
    // correctly ignored needs the two axes side by side.
    await archive?.recordExecutionCalendar({
      referenceCode,
      seriesId,
      seriesVersion: snapshot.executionCalendar?.seriesVersion ?? null,
      methodologyVersion: snapshot.methodology.executionCalendar,
      dates,
      durationMs: Date.now() - startedAt,
    });
    return dates;
  }

  /**
   * Refuses the attempt when the pinned series has no durable coverage for part of the period.
   *
   * Complete coverage means the provider was asked for the whole period with complete requests, so
   * whatever bars came back are all there are — an empty prefix is then the series' own history
   * starting later, which is ordinary and not a failure. An actual coverage gap is the canonical
   * data being unavailable, and the run says so instead of simulating a shorter period.
   *
   * The check is deliberately on coverage rather than on the first bar's distance from the period
   * start: market closures are real and a threshold in days would be a guess, whereas coverage is
   * the durable claim that asking again is pointless.
   */
  private async assertCalendarCoversPeriod(
    seriesId: string,
    referenceCode: string | null,
    period: Required<DateRange>,
  ): Promise<void> {
    let missing: Required<DateRange>[];
    try {
      const series = await this.dependencies.benchmarks.getSeries(seriesId);
      missing = [
        ...(await this.dependencies.benchmarks.missingBenchmarkCoverage(
          series,
          period,
        )),
      ];
    } catch (err) {
      this.dependencies.logger.error({
        event: "backtest.execution-calendar.unavailable",
        reason: "COVERAGE_UNREADABLE",
        referenceCode,
        seriesId,
        err,
      });
      throw new BacktestRunFailure(
        "EXECUTION_CALENDAR_UNAVAILABLE",
        FAILURE_MESSAGES.EXECUTION_CALENDAR_UNAVAILABLE,
      );
    }
    if (missing.length === 0) {
      return;
    }
    this.dependencies.logger.error({
      event: "backtest.execution-calendar.unavailable",
      reason: "PERIOD_NOT_COVERED",
      referenceCode,
      seriesId,
      period,
      missing,
    });
    throw new BacktestRunFailure(
      "EXECUTION_CALENDAR_UNAVAILABLE",
      FAILURE_MESSAGES.EXECUTION_CALENDAR_UNAVAILABLE,
    );
  }

  /** One pinned series' bars, or null when it cannot be loaded. Never fails the run. */
  private async loadSeriesPrices(
    seriesId: string,
    period: Required<DateRange>,
    context: { role: string; code: string },
  ): Promise<BenchmarkDailyPrice[] | null> {
    try {
      const series = await this.dependencies.benchmarks.getSeries(seriesId);
      const prices = await this.dependencies.benchmarks.getBenchmarkDailyPrices(
        series,
        period,
      );
      if (prices.length === 0) {
        this.dependencies.logger.warn({
          event: "backtest.benchmark.unavailable",
          role: context.role,
          benchmarkCode: context.code,
          seriesId,
          reason: "NO_DAILY_DATA",
        });
      }
      return prices;
    } catch (err) {
      this.dependencies.logger.warn({
        event: "backtest.benchmark.unavailable",
        role: context.role,
        benchmarkCode: context.code,
        seriesId,
        err,
      });
      return null;
    }
  }

  /**
   * RUNNING — one continuous deterministic simulation, fed one calendar-year window at a time.
   *
   * ```text
   * 2000-05-10 → 2000-12-31   load, simulate, expose the completed prefix, release
   * 2001-01-01 → 2001-12-31   …
   * 2010-01-01 → 2010-08-15
   * ```
   *
   * The loop is a **data-loading and progress** loop, never a sequence of independent backtests:
   * `BacktestSimulation` carries cash, positions, level state, contribution progression, the
   * accumulators and the comparison scenarios straight across each boundary, and rejects a window
   * that does not continue the run's own calendar. Only the projections are replaced.
   *
   * Nothing here hydrates. `PREPARING_DATA` already made the whole period resident, so each window
   * is a projection read — repaired from PostgreSQL when a Redis year chunk is missing, and
   * reaching the provider only where PostgreSQL genuinely has no coverage.
   *
   * A failure in any window propagates: the run is `FAILED`, never partially `COMPLETED`.
   */
  private async simulate(
    claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
    snapshot: BacktestRunSnapshot,
    prepared: PreparedRun,
    archive: BacktestDebugArchive | null,
  ): Promise<BacktestResult> {
    await this.writeProgress(claim, lease, {
      status: BacktestRunStatus.RUNNING,
      percent: RUNNING_START_PERCENT,
      message: "Running backtest",
    });

    let lastCheckpointAt = 0;

    const simulation = createBacktestSimulation(
      {
        definition: snapshot.strategy.definition,
        securities: prepared.securities.map((entry) => entry.setup),
        benchmark: prepared.benchmark,
        executionCalendar: prepared.executionCalendar,
        startDate: snapshot.period.startDate,
        endDate: snapshot.period.endDate,
        initialCapital: snapshot.capital.initialCapital,
        monthlyContribution: snapshot.capital.monthlyContribution,
        maximumPositions: snapshot.allocation.maximumPositions,
      },
      {
        checkpointEveryDays: this.options.checkpointEveryDays,
        // The frames the day loop is actually bound to — the retained year-boundary context row
        // included — reach the archive only from inside the engine. The observer is read-only and
        // swallows its own failures, so attaching it cannot change or fail this run.
        ...(archive ? { diagnostics: archive.observer() } : {}),
        onCheckpoint: async (checkpoint) => {
          const interruption = lease.interruption();
          if (interruption) {
            throw new BacktestInterruptedError(interruption);
          }

          // A short run can checkpoint hundreds of times a second; the first one always lands, so
          // the running page has something to show immediately, and the rest are throttled.
          //
          // A completed year is never throttled away. It is the progression a user follows on a
          // decades-long run, and it is the boundary at which that year's computed curve becomes
          // visible to the running page. A V1 run has at most about thirty of them, so keeping
          // every one costs a bounded number of small writes even when the simulation outruns the
          // clock.
          const at = this.now().getTime();
          if (
            checkpoint.milestone === null &&
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

    for (const window of simulation.windows) {
      const interruption = lease.interruption();
      if (interruption) {
        throw new BacktestInterruptedError(interruption);
      }
      const startedAt = Date.now();
      const frames = await this.loadWindowFrames(prepared, window);
      const durationMs = Date.now() - startedAt;
      this.dependencies.logger.debug({
        event: "backtest.window.loaded",
        year: window.year,
        from: window.from,
        to: window.to,
        durationMs,
        securityCount: frames.length,
        tradingDays: window.dates.length,
      });
      archive?.recordWindowLoad({ window, durationMs, frames });
      await simulation.consumeWindow(window, { frames });
    }

    return simulation.finish();
  }

  /**
   * Projects every run security for one window, in the run's own order.
   *
   * Every security is projected, including one with no rows that year: the engine needs the full
   * set to tell "this security did not trade in 2003" from "the loader lost a security", and an
   * empty frame is the honest answer to the first.
   *
   * Bounded concurrency for the same reason frame loading always had it — these are I/O reads
   * sharing a connection pool — while the simulation itself stays strictly sequential in time.
   */
  private async loadWindowFrames(
    prepared: PreparedRun,
    window: BacktestExecutionWindow,
  ): Promise<EvaluationFrame[]> {
    const range = { from: window.from, to: window.to } as const;
    const frames: EvaluationFrame[] = new Array(prepared.securities.length);
    await this.mapWithConcurrency(prepared.securities, async (entry, index) => {
      frames[index] =
        await this.dependencies.stockData.readDailyEvaluationFrame(
          entry.security,
          range,
          prepared.operands,
        );
    });
    return frames;
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
      ...(checkpoint.milestone
        ? {
            milestone: {
              year: checkpoint.milestone,
              simulatedThrough: checkpoint.simulatedThrough,
              percent,
              completedDays: checkpoint.completedDays,
              totalDays: checkpoint.totalDays,
              cash: checkpoint.cash,
              totalValue: checkpoint.totalValue,
              investedCapital: checkpoint.investedCapital,
              portfolioReturnPercent: checkpoint.portfolioReturnPercent,
              benchmarkReturnPercent: checkpoint.benchmarkReturnPercent,
              alphaPercent: checkpoint.alphaPercent,
              maxDrawdownPercent: checkpoint.maxDrawdownPercent,
              tradeCount: checkpoint.tradeCount,
              openPositions: checkpoint.openPositions,
            },
          }
        : {}),
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
    archive: BacktestDebugArchive | null,
  ): Promise<void> {
    const code =
      err instanceof BacktestRunFailure ? err.code : "EXECUTION_FAILED";
    const error = err instanceof Error ? err : new Error(String(err));

    // A failed attempt is the most useful archive there is, so it keeps everything captured before
    // the failure plus why it stopped. Recorded before the durable write, so a lost lease cannot
    // also cost the diagnosis.
    await archive?.recordFailure({
      code,
      phase,
      userFacingPhase: userFacingPhase(phase),
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      context:
        err instanceof BacktestRunFailure && err.context ? err.context : null,
      window: null,
    });

    // The original error is logged before it is translated, so its name, message and stack survive
    // even though none of them may reach the user-facing failure message.
    // Everything needed to find this run and this attempt, plus the original error object so its
    // name, message and stack survive the translation into product prose.
    this.dependencies.logger.error({
      event: "backtest.failed",
      durationMs: Date.now() - startedAt,
      runId: claim.runId,
      jobId: claim.jobId,
      workerId: this.options.workerId,
      attempt: claim.attempt,
      failureCode: code,
      phase,
      ...(err instanceof BacktestRunFailure && err.context
        ? { failureContext: err.context }
        : {}),
      err: error,
    });

    const recorded = await this.dependencies.repository.failJob({
      jobId: claim.jobId,
      runId: claim.runId,
      workerId: this.options.workerId,
      now: this.now(),
      code,
      message:
        err instanceof BacktestRunFailure && err.context
          ? `${FAILURE_MESSAGES[code]} ${err.context}`
          : FAILURE_MESSAGES[code],
      phase: userFacingPhase(phase),
      detail: {
        phase,
        name: error.name,
        message: error.message,
        ...(err instanceof BacktestRunFailure && err.developerDetail
          ? err.developerDetail
          : {}),
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
      // Declared so the compiler checks it. A conditional spread at the call site is not subject
      // to excess-property checking, so an undeclared field would be forwarded silently and a
      // rename would go unnoticed here.
      milestone?: BacktestMilestoneWrite;
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
