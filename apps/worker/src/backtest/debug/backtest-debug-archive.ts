import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import type { BenchmarkDailyPrice, LocalDate } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import type {
  BacktestDiagnosticsObserver,
  BacktestExecutionWindow,
  BacktestFundingEvent,
  BacktestResult,
  BacktestStateDiagnostics,
  BacktestWindowClosedDiagnostics,
  BacktestWindowOpenedDiagnostics,
  EvaluationFrame,
} from "@intrinsic/strategy";
import { BacktestDebugArchiveStaging } from "./archive-staging.js";
import {
  archiveDecimal,
  archiveNumber,
  archiveNumbers,
  safeFileId,
  safeFileSymbol,
} from "./encoding.js";
import { readGitMetadata, type ArchiveGitMetadata } from "./git-metadata.js";
import { scrubSecrets } from "./redaction.js";

/**
 * The archive format's own version, independent of everything else in the system.
 *
 * It describes the **diagnostic file layout** — which files exist, what shape they have, how a
 * number is encoded. It is emphatically not a Backtest methodology version: adding a field here
 * cannot change what a run computes, and changing a methodology does not reorganize these files.
 * Bump it whenever a reader written against the previous layout would misread this one.
 */
/**
 * Version 2: monetary and share quantities are canonical decimal **strings**, not numbers.
 *
 * A version-1 archive wrote `"amount": 1234.56`; a version-2 archive writes `"amount": "1234.560000"`.
 * The change exists because float64 cannot carry these values at the magnitudes the product
 * reaches — the validation matrix produced a $334,310,721,745.96 portfolio and a
 * 2,415,434,113.5728870 share count, 18 and 17 significant digits against float64's ~15.95 — so a
 * number in the forensic record discarded exactly the digits the record exists to preserve.
 *
 * Percentages, ratios, the return index and drawdowns are unchanged: they were never ledger values.
 *
 * A reader must branch on `archiveSchemaVersion` rather than sniff the type. Version 1 archives
 * remain readable as what they are — numbers, with the precision they were written at — and must
 * not be reinterpreted as though they carried more.
 */
export const BACKTEST_ARCHIVE_SCHEMA_VERSION = 2;

/** How the attempt ended, from the worker's point of view. */
export type BacktestArchiveStatus = "COMPLETED" | "FAILED" | "INTERRUPTED";

/** What `PREPARING_DATA` did for one list member. */
export type ArchivePreparedSecurity = {
  securityId: string;
  symbol: string;
  requestedFrom: LocalDate;
  requestedTo: LocalDate;
  durationMs: number;
  coverage: { firstDate: string; lastDate: string; tradingDays: number } | null;
  skipped: boolean;
  skipReason: string | null;
};

/** Provider traffic this process made, as a running total the archive takes deltas of. */
export type ProviderRequestCounts = {
  total: number;
  byDataset: Record<string, number>;
  byReason: Record<string, number>;
};

export type BacktestDebugArchiveContext = {
  runId: string;
  jobId: string;
  attempt: number;
  workerId: string;
};

export type BacktestArchiveFailure = {
  code: string;
  phase: string;
  userFacingPhase: string | null;
  name: string;
  message: string;
  stack: string | null;
  /** Sanitized product context the failure already carries, such as which symbols had no data. */
  context: string | null;
  /** The window being simulated when it failed, when the failure happened inside one. */
  window: { year: string; index: number } | null;
};

/**
 * One attempt's forensic capture.
 *
 * Everything here is **observational**. Each method swallows its own failures, reports them once
 * through `@intrinsic/observability`, and disables the rest of the capture for this attempt — a
 * full disk, a read-only directory or a permissions change must never turn a valid backtest into a
 * failed one, and must never turn a failed one into a success. The processor therefore calls these
 * without guarding them, which is the point: there is exactly one place that decides what an
 * archive failure means.
 *
 * The archive holds **raw replay evidence, never engine-generated reasoning**. There is no "bought
 * because price crossed the EMA" anywhere in it, deliberately: the same code produced the decision
 * and would produce the explanation, so the two could only ever agree. What it holds instead is
 * what the engine consumed — the immutable snapshot, the execution calendar, the benchmark input,
 * the frames the day loop was bound to and the funding it applied — plus what it produced, so a
 * reviewer can re-derive the decisions independently and disagree.
 */
export class BacktestDebugArchive {
  private readonly startedAt: Date;
  private readonly fundingEvents: BacktestFundingEvent[] = [];
  private readonly warnings: string[] = [];
  private readonly windowLoads = new Map<
    number,
    { durationMs: number; frameCount: number; frameRows: number }
  >();

  private disabled = false;
  private frameFileCount = 0;
  private windowCount = 0;
  private tradeCount = 0;
  private equityPointCount = 0;
  /** Counted separately: `fundingEvents` is drained on every flush, so its length is not a total. */
  private fundingEventCount = 0;
  private currentWindow: BacktestExecutionWindow | null = null;
  private snapshotDocument: BacktestRunSnapshot | null = null;
  private timings: Record<string, number> = {};

  private constructor(
    private readonly staging: BacktestDebugArchiveStaging,
    private readonly context: BacktestDebugArchiveContext,
    private readonly logger: StructuredLogger,
    private readonly mode: string,
    private readonly now: () => Date,
    private readonly git: ArchiveGitMetadata,
  ) {
    this.startedAt = now();
  }

  /**
   * Opens a capture for one attempt, or returns null when it cannot be opened.
   *
   * A directory that cannot be created is reported and then forgotten: the run proceeds with no
   * archive rather than not proceeding.
   */
  static async open(input: {
    directory: string;
    mode: string;
    context: BacktestDebugArchiveContext;
    logger: StructuredLogger;
    now: () => Date;
  }): Promise<BacktestDebugArchive | null> {
    try {
      const staging = await BacktestDebugArchiveStaging.open(
        input.directory,
        archiveBaseName(input.context),
      );
      const archive = new BacktestDebugArchive(
        staging,
        input.context,
        input.logger,
        input.mode,
        input.now,
        readGitMetadata(process.cwd()),
      );
      input.logger.info({
        event: "backtest.debug-archive.started",
        runId: input.context.runId,
        jobId: input.context.jobId,
        attempt: input.context.attempt,
        archiveMode: input.mode,
        stagingRoot: staging.root,
      });
      return archive;
    } catch (err) {
      input.logger.error({
        event: "backtest.debug-archive.unavailable",
        runId: input.context.runId,
        jobId: input.context.jobId,
        attempt: input.context.attempt,
        archiveDirectory: input.directory,
        err,
      });
      return null;
    }
  }

  /** Where this attempt is staging its files. Exposed for diagnostics and for tests. */
  get stagingRoot(): string {
    return this.staging.root;
  }

  /** The immutable submission document, exactly as stored. The reproducibility authority. */
  async recordSnapshot(snapshot: BacktestRunSnapshot): Promise<void> {
    this.snapshotDocument = snapshot;
    await this.guard("snapshot", () =>
      this.staging.writeJson("snapshot.json", snapshot),
    );
  }

  /** The authoritative execution calendar, as passed to the simulation. */
  async recordExecutionCalendar(input: {
    referenceCode: string | null;
    seriesId: string;
    seriesVersion: number | null;
    methodologyVersion: string;
    dates: readonly LocalDate[];
    durationMs: number;
  }): Promise<void> {
    await this.guard("execution-calendar", () =>
      this.staging.writeJson("inputs/execution-calendar.json", {
        // Deliberately the calendar the engine was handed, not one re-derived from the security
        // frames: a security row outside the calendar takes no action, and a reviewer can only see
        // that by comparing the two.
        source: {
          referenceCode: input.referenceCode,
          seriesId: input.seriesId,
          seriesVersion: input.seriesVersion,
          methodologyVersion: input.methodologyVersion,
        },
        tradingDays: input.dates.length,
        firstDate: input.dates[0] ?? null,
        lastDate: input.dates[input.dates.length - 1] ?? null,
        loadDurationMs: input.durationMs,
        dates: [...input.dates],
      }),
    );
  }

  /**
   * The raw benchmark bars the run compared against.
   *
   * The closes themselves, not the `benchmarkValue` curve derived from them: the curve is what is
   * being checked, so an archive that only carried it could not be used to check it. With these
   * plus the funding events a reviewer can rebuild `shares += contribution / close` and
   * `value = shares × close` from scratch.
   */
  async recordBenchmark(input: {
    benchmark: BacktestRunSnapshot["benchmark"] | null;
    prices: readonly BenchmarkDailyPrice[] | null;
    durationMs: number;
    unavailableReason: string | null;
  }): Promise<void> {
    await this.guard("benchmark", () =>
      this.staging.writeJson("inputs/benchmark.json", {
        identity: input.benchmark
          ? {
              benchmarkId: input.benchmark.benchmarkId,
              code: input.benchmark.code,
              name: input.benchmark.name,
              seriesId: input.benchmark.seriesId,
              seriesVersion: input.benchmark.seriesVersion,
              sourceKind: input.benchmark.sourceKind,
              methodologyVersion: input.benchmark.methodologyVersion,
              currency: input.benchmark.currency,
            }
          : null,
        unavailableReason: input.unavailableReason,
        loadDurationMs: input.durationMs,
        pointCount: input.prices?.length ?? 0,
        // The carry-forward rule is part of how these are read: on a simulated date the benchmark
        // did not trade, the most recent close at or before it applies.
        carryForward: "most-recent-close-at-or-before-the-simulated-date",
        prices:
          input.prices?.map((price) => ({
            date: price.date,
            close: archiveNumber(price.close),
          })) ?? [],
      }),
    );
  }

  /** What hydration did per security, plus whatever provider traffic can honestly be attributed. */
  async recordPreparation(input: {
    securities: readonly ArchivePreparedSecurity[];
    operands: readonly string[];
    durationMs: number;
    providerRequests: ProviderRequestCounts | null;
  }): Promise<void> {
    this.timings.preparingDataMs = input.durationMs;
    await this.guard("preparation", () =>
      this.staging.writeJson("preparation/summary.json", {
        durationMs: input.durationMs,
        securityCount: input.securities.length,
        keptCount: input.securities.filter((entry) => !entry.skipped).length,
        skippedCount: input.securities.filter((entry) => entry.skipped).length,
        // The canonical operand ids this Strategy references — the same ids the frame files are
        // keyed by, from the selectable-series catalog. There is no second naming system.
        operands: [...input.operands].sort(),
        providerRequests: input.providerRequests,
        securities: input.securities,
        // Stated rather than omitted: an absent field would read as "nothing happened".
        unattributable: UNATTRIBUTABLE_PREPARATION_DETAIL,
      }),
    );
  }

  /** Records one phase's wall clock for `diagnostics/timings.json`. */
  recordTiming(phase: string, durationMs: number): void {
    this.timings[phase] = durationMs;
  }

  /** How long a window's projections took to load, merged into that window's record when it ends. */
  recordWindowLoad(input: {
    window: BacktestExecutionWindow;
    durationMs: number;
    frames: readonly EvaluationFrame[];
  }): void {
    this.windowLoads.set(input.window.index, {
      durationMs: input.durationMs,
      frameCount: input.frames.length,
      frameRows: input.frames.reduce(
        (total, frame) => total + frame.dates.length,
        0,
      ),
    });
  }

  /**
   * The observer handed to the simulation.
   *
   * Every callback is guarded here rather than at the call site, because these run **inside**
   * `consumeWindow`: an unguarded throw would reach the engine and fail a perfectly valid backtest,
   * which is exactly the outcome the archive must be incapable of causing.
   */
  observer(): BacktestDiagnosticsObserver {
    return {
      onWindowOpened: async (diagnostics) => {
        this.currentWindow = diagnostics.window;
        await this.guard("frames", () => this.writeWindowFrames(diagnostics));
      },
      onWindowClosed: async (diagnostics) => {
        await this.guard("window", () => this.writeWindowClose(diagnostics));
        this.currentWindow = null;
      },
      onFunding: (event) => {
        this.fundingEvents.push(event);
      },
    };
  }

  /** The persisted result: the final positions and the summary they reconcile against. */
  async recordResult(result: BacktestResult): Promise<void> {
    await this.guard("result", async () => {
      await this.staging.writeJson("result/positions.json", {
        count: result.positions.length,
        positions: result.positions.map((position) => ({
          securityId: position.securityId,
          symbol: position.symbol,
          name: position.name,
          openedDate: position.openedDate,
          shares: archiveDecimal(position.shares),
          averageCost: archiveDecimal(position.averageCost),
          lastPrice: archiveDecimal(position.lastPrice),
          lastPriceDate: position.lastPriceDate,
          marketValue: archiveDecimal(position.marketValue),
          unrealizedPnl: archiveDecimal(position.unrealizedPnl),
          unrealizedPnlPercent: archiveNumber(position.unrealizedPnlPercent),
          allocationPercent: archiveNumber(position.allocationPercent),
        })),
      });
      await this.staging.writeJson("result/summary.json", {
        ...result.summary,
        // Restated so the reconciliation a reviewer performs is unambiguous about which numbers
        // are meant to agree.
        reconciliation: {
          finalValue:
            "finalCash + finalPositionsValue, and the last equity row's totalValue",
          cashBaseline:
            "initialCapital + every MONTHLY_CONTRIBUTION in inputs/contributions.ndjson",
          tradeCount: "the number of rows in result/trades.ndjson",
        },
      });
    });
  }

  /** What went wrong, sanitized, and where in the run it happened. */
  async recordFailure(failure: BacktestArchiveFailure): Promise<void> {
    await this.guard("failure", () =>
      this.staging.writeJson("diagnostics/failure.json", {
        failureCode: failure.code,
        phase: failure.phase,
        userFacingPhase: failure.userFacingPhase,
        // Scrubbed, not raw: a provider or database error can carry a URL with a credential in it,
        // and this file is meant to be handed to somebody outside the project.
        error: {
          name: failure.name,
          message: scrubSecrets(failure.message),
          stack: failure.stack === null ? null : scrubSecrets(failure.stack),
        },
        context: failure.context,
        window: failure.window ?? this.currentWindowDescriptor(),
        capturedThrough: {
          windows: this.windowCount,
          trades: this.tradeCount,
          equityPoints: this.equityPointCount,
        },
      }),
    );
  }

  /**
   * Flushes the remaining capture, packs it and returns where the archive landed.
   *
   * Returns null when capture was disabled by an earlier failure or when packing itself failed —
   * in both cases the run's own outcome is already decided and unaffected.
   */
  async finalize(status: BacktestArchiveStatus): Promise<string | null> {
    if (this.disabled) {
      await this.staging.discard().catch(() => undefined);
      return null;
    }

    const finalizedAt = this.now();
    try {
      this.fundingEventCount += this.fundingEvents.length;
      await this.staging.appendNdjson(
        "inputs/contributions.ndjson",
        this.fundingEvents.map((event) => ({
          date: event.date,
          type: event.type,
          amount: archiveNumber(event.amount),
          cashAfter: archiveNumber(event.cashAfter),
          investedCapitalAfter: archiveNumber(event.investedCapitalAfter),
        })),
      );
      await this.staging.writeJson("diagnostics/timings.json", {
        archiveStartedAt: this.startedAt.toISOString(),
        archiveFinalizedAt: finalizedAt.toISOString(),
        archiveWallClockMs: finalizedAt.getTime() - this.startedAt.getTime(),
        phases: this.timings,
      });
      await this.staging.writeJson(
        "manifest.json",
        this.manifest(status, finalizedAt),
      );
      await this.writeReadme();

      const { path, bytes } = await this.staging.pack(
        `${archiveBaseName(this.context)}.zip`,
      );
      await this.staging.discard();

      this.logger.info({
        event: "backtest.debug-archive.completed",
        runId: this.context.runId,
        jobId: this.context.jobId,
        attempt: this.context.attempt,
        archivePath: path,
        archiveBytes: bytes,
        archiveStatus: status,
        durationMs: finalizedAt.getTime() - this.startedAt.getTime(),
      });
      return path;
    } catch (err) {
      this.reportFailure("finalize", err);
      await this.staging.discard().catch(() => undefined);
      return null;
    }
  }

  private manifest(
    status: BacktestArchiveStatus,
    finalizedAt: Date,
  ): Record<string, unknown> {
    const snapshot = this.snapshotDocument;
    return {
      archiveSchemaVersion: BACKTEST_ARCHIVE_SCHEMA_VERSION,
      archiveMode: this.mode,
      archiveStartedAt: this.startedAt.toISOString(),
      archiveFinalizedAt: finalizedAt.toISOString(),
      run: {
        runId: this.context.runId,
        // The job row is one per run, so the attempt counter it carries — incremented on every
        // claim — is the canonical attempt identity. The job id is recorded beside it because it is
        // what a log search keys on, not because it distinguishes attempts.
        jobId: this.context.jobId,
        attempt: this.context.attempt,
        workerId: this.context.workerId,
        status,
      },
      build: {
        gitCommit: this.git.commit,
        gitBranch: this.git.branch,
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      revisions: snapshot
        ? {
            snapshotVersion: snapshot.snapshotVersion,
            submittedAt: snapshot.submittedAt,
            methodology: snapshot.methodology,
            dataRevisions: snapshot.dataRevisions,
            // Surfaced individually because they are the ones a reviewer checks first.
            comparisonScenarios: snapshot.methodology.comparisonScenarios,
            executionCalendar: snapshot.methodology.executionCalendar,
            strategyEvaluation: snapshot.methodology.strategyEvaluation,
          }
        : null,
      capture: {
        windows: this.windowCount,
        frameFiles: this.frameFileCount,
        trades: this.tradeCount,
        equityPoints: this.equityPointCount,
        fundingEvents: this.fundingEventCount,
        warnings: this.warnings,
      },
      encoding: {
        numbers:
          "An absent / NOT_EVALUABLE value is null. A real numeric zero is 0. NaN is never written.",
        dates:
          "Calendar dates as YYYY-MM-DD, in the market's own trading calendar.",
      },
    };
  }

  /** One file per security per calendar year: the rows the day loop was actually bound to. */
  private async writeWindowFrames(
    diagnostics: BacktestWindowOpenedDiagnostics,
  ): Promise<void> {
    const { window } = diagnostics;
    const firstSimulated = window.dates[0] ?? null;
    const lastSimulated = window.dates[window.dates.length - 1] ?? null;

    for (const frame of diagnostics.frames) {
      const dates = [...frame.dates];
      // Rows before the window's first requested date are read-only Trigger context: the window's
      // execution-calendar dates all lie after them, so they are never simulated, never funded and
      // never produce an equity point. Counted from the dates rather than trusted from
      // `periodStartIndex`, which is whatever the loader reported before the engine spliced its
      // own retained row in front.
      const contextRowCount = dates.filter((date) => date < window.from).length;
      const operands: Record<string, (number | null)[]> = {};
      for (const key of [...frame.columns.keys()].sort()) {
        operands[key] = archiveNumbers(frame.columns.get(key) as Float64Array);
      }

      await this.staging.writeJson(
        `frames/${window.year}/${safeFileSymbol(frame.symbol)}-${safeFileId(frame.securityId)}.json`,
        {
          securityId: frame.securityId,
          symbol: frame.symbol,
          name: frame.name,
          window: {
            year: window.year,
            index: window.index,
            requestedFrom: window.from,
            requestedTo: window.to,
            firstSimulatedDate: firstSimulated,
            lastSimulatedDate: lastSimulated,
            simulatedDates: window.dates.length,
          },
          rowCount: dates.length,
          /**
           * Rows `[0, contextRowCount)` are the read-only context described above; the simulated
           * rows start at `contextRowCount`.
           */
          contextRowCount,
          contextRowDates: dates.slice(0, contextRowCount),
          periodStartIndex: frame.periodStartIndex,
          dates,
          closes: archiveNumbers(frame.closes),
          operandKeys: Object.keys(operands),
          operands,
        },
      );
      this.frameFileCount += 1;
    }
  }

  /** A finished window: its operational record, the rows it produced, and the state it carries. */
  private async writeWindowClose(
    diagnostics: BacktestWindowClosedDiagnostics,
  ): Promise<void> {
    const { window, state } = diagnostics;
    const load = this.windowLoads.get(window.index) ?? null;
    this.windowLoads.delete(window.index);

    await this.staging.appendNdjson("execution/windows.ndjson", [
      {
        ordinal: window.index,
        year: window.year,
        requestedFrom: window.from,
        requestedTo: window.to,
        calendarFirstDate: window.dates[0] ?? null,
        calendarLastDate: window.dates[window.dates.length - 1] ?? null,
        simulatedDates: window.dates.length,
        frameCount: load?.frameCount ?? null,
        loadDurationMs: load?.durationMs ?? null,
        loadedRows: load?.frameRows ?? null,
        completedThrough: state.simulatedThrough,
        tradesInWindow: diagnostics.trades.length,
        equityPointsInWindow: diagnostics.equity.length,
        cumulativeTrades: state.tradeCount,
        cumulativeEquityPoints: state.equityPointCount,
      },
    ]);

    await this.staging.appendNdjson("execution/checkpoints.ndjson", [
      this.checkpointOf(window, state),
    ]);

    await this.staging.appendNdjson(
      "result/trades.ndjson",
      diagnostics.trades.map((trade) => ({
        sequence: trade.sequence,
        date: trade.date,
        securityId: trade.securityId,
        symbol: trade.symbol,
        action: trade.action,
        levelId: trade.levelId,
        levelPercentage: archiveNumber(trade.levelPercentage),
        shares: archiveDecimal(trade.shares),
        price: archiveDecimal(trade.price),
        amount: archiveDecimal(trade.amount),
        fees: archiveDecimal(trade.fees),
        realizedPnl: archiveDecimal(trade.realizedPnl),
        realizedPnlPercent: archiveNumber(trade.realizedPnlPercent),
        cashAfter: archiveDecimal(trade.cashAfter),
        sharesAfter: archiveDecimal(trade.sharesAfter),
        averageCostAfter: archiveDecimal(trade.averageCostAfter),
        // There is deliberately no `reason` here. See the class comment.
      })),
    );

    await this.staging.appendNdjson(
      "result/equity.ndjson",
      diagnostics.equity.map((point) => ({
        date: point.date,
        cash: archiveDecimal(point.cash),
        positionsValue: archiveDecimal(point.positionsValue),
        totalValue: archiveDecimal(point.totalValue),
        investedCapital: archiveDecimal(point.investedCapital),
        returnIndex: archiveNumber(point.returnIndex),
        benchmarkIndex: archiveNumber(point.benchmarkIndex),
        benchmarkValue: archiveDecimal(point.benchmarkValue),
        cashBaselineValue: archiveDecimal(point.cashBaselineValue),
        openPositions: point.openPositions,
      })),
    );

    // Flushed per window so a run killed in year 20 still has 19 years of funding on disk.
    const pending = this.fundingEvents.splice(0, this.fundingEvents.length);
    this.fundingEventCount += pending.length;
    await this.staging.appendNdjson(
      "inputs/contributions.ndjson",
      pending.map((event) => ({
        date: event.date,
        type: event.type,
        amount: archiveNumber(event.amount),
        cashAfter: archiveNumber(event.cashAfter),
        investedCapitalAfter: archiveNumber(event.investedCapitalAfter),
      })),
    );

    this.windowCount += 1;
    this.tradeCount += diagnostics.trades.length;
    this.equityPointCount += diagnostics.equity.length;
  }

  /** The continuation state a boundary carries — a cross-check, never an execution input. */
  private checkpointOf(
    window: BacktestExecutionWindow,
    state: BacktestStateDiagnostics,
  ): Record<string, unknown> {
    return {
      afterWindow: { ordinal: window.index, year: window.year },
      simulatedThrough: state.simulatedThrough,
      completedDays: state.completedDays,
      totalDays: state.totalDays,
      strategy: {
        cash: archiveNumber(state.cash),
        positionsValue: archiveNumber(state.positionsValue),
        totalValue: archiveNumber(state.totalValue),
        investedCapital: archiveNumber(state.investedCapital),
        realizedPnl: archiveNumber(state.realizedPnl),
        returnIndex: archiveNumber(state.returnIndex),
        previousTotalValue: archiveNumber(state.previousTotalValue),
        maxDrawdownPercent: archiveNumber(state.maxDrawdownPercent),
        benchmarkMaxDrawdownPercent: archiveNumber(
          state.benchmarkMaxDrawdownPercent,
        ),
        tradeSequence: state.tradeSequence,
        tradeCount: state.tradeCount,
        equityPointCount: state.equityPointCount,
      },
      positions: state.positions.map((position) => ({
        securityId: position.securityId,
        symbol: position.symbol,
        epoch: position.epoch,
        openedDate: position.openedDate,
        shares: archiveNumber(position.shares),
        costTotal: archiveNumber(position.costTotal),
        averageCost: archiveNumber(position.averageCost),
        lastPrice: archiveNumber(position.lastPrice),
        lastPriceDate: position.lastPriceDate,
        realizedPnl: archiveNumber(position.realizedPnl),
        buyLevelsSettled: position.buyLevelsSettled,
        sellLevelsFired: position.sellLevelsFired,
        previousSignedReturnPercent: archiveNumber(
          position.previousSignedReturnPercent,
        ),
        previousValueDate: position.previousValueDate,
      })),
      positionEpochs: state.positionEpochs,
      comparison: {
        benchmarkShares: archiveNumber(state.comparison.benchmarkShares),
        benchmarkPendingCapital: archiveNumber(
          state.comparison.benchmarkPendingCapital,
        ),
        cashBaselineValue: archiveNumber(state.comparison.cashBaselineValue),
      },
      // The row spliced in front of the next window, so continuity across the boundary is checkable
      // without opening the next year's frame files.
      retainedContextRows: state.contextRows.map((row) => ({
        securityId: row.securityId,
        symbol: row.symbol,
        date: row.date,
        close: archiveNumber(row.close),
      })),
    };
  }

  private currentWindowDescriptor(): { year: string; index: number } | null {
    return this.currentWindow
      ? { year: this.currentWindow.year, index: this.currentWindow.index }
      : null;
  }

  private async writeReadme(): Promise<void> {
    await this.staging.writeJson("README.json", {
      what: "A forensic replay package for one backtest attempt. Raw inputs, state and outputs — never engine-generated reasoning.",
      layout: ARCHIVE_LAYOUT,
      numberEncoding:
        "null means the engine had no value (NOT_EVALUABLE); 0 is a real reading. NaN is never written.",
      triggerContext:
        "In frames/<year>/*.json, rows [0, contextRowCount) precede the window and are read-only Trigger context. The first simulated row is at index contextRowCount.",
      documentation: "docs/development/backtest-debug-archive.md",
    });
  }

  /**
   * Runs one capture step, and takes the whole capture down rather than the run if it throws.
   *
   * "Disable further capture for this attempt" is deliberate: the second failure is almost always
   * the same failure, and a half-written archive that keeps trying would bury the one log line that
   * says what actually went wrong.
   */
  private async guard(step: string, work: () => Promise<void>): Promise<void> {
    if (this.disabled) {
      return;
    }
    try {
      await work();
    } catch (err) {
      this.reportFailure(step, err);
    }
  }

  private reportFailure(step: string, err: unknown): void {
    this.disabled = true;
    this.warnings.push(step);
    this.logger.error({
      event: "backtest.debug-archive.failed",
      runId: this.context.runId,
      jobId: this.context.jobId,
      attempt: this.context.attempt,
      archiveStep: step,
      err,
    });
  }
}

/** `backtest-debug-<runId>-attempt-<n>` — unique per attempt, and sortable per run. */
export function archiveBaseName(context: BacktestDebugArchiveContext): string {
  return `backtest-debug-${safeFileId(context.runId)}-attempt-${context.attempt}`;
}

/**
 * What this architecture genuinely cannot attribute to one run, stated inside the archive.
 *
 * Named rather than omitted, and never guessed: a fabricated cache-hit number would be worse than
 * no number, because a reviewer would trust it. Getting these would mean the projection read
 * reporting its own outcome to its caller, which is a change to `@intrinsic/stock-data`'s contract
 * rather than to a debug capture.
 */
const UNATTRIBUTABLE_PREPARATION_DETAIL = [
  "redisProjectionHitMissRebuild: the canonical projection read repairs a missing Redis year chunk from PostgreSQL internally and reports nothing back to its caller.",
  "postgresRepairOrFallback: same read, same reason.",
] as const;

const ARCHIVE_LAYOUT = {
  "manifest.json":
    "Archive schema version, run/attempt identity, build, snapshot revisions, capture counts.",
  "snapshot.json": "The immutable BacktestRunSnapshot the attempt executed.",
  "preparation/summary.json":
    "Per-security hydration ranges, coverage, durations and provider traffic.",
  "inputs/execution-calendar.json":
    "The authoritative execution calendar handed to the simulation.",
  "inputs/benchmark.json":
    "The raw benchmark closes the comparison scenario was built from.",
  "inputs/contributions.ndjson":
    "Every external cash flow the simulation applied, typed and dated.",
  "frames/<year>/<SYMBOL>-<securityId>.json":
    "The EvaluationFrame the day loop was bound to, per security per calendar year.",
  "execution/windows.ndjson":
    "One record per calendar-year window: ranges, dates, load timing.",
  "execution/checkpoints.ndjson":
    "The continuation state carried across each year boundary.",
  "result/trades.ndjson": "Every trade, in execution order.",
  "result/equity.ndjson": "Every simulated day's equity point.",
  "result/positions.json": "Final open positions.",
  "result/summary.json": "Final summary metrics.",
  "diagnostics/timings.json": "Phase durations and archive wall clock.",
  "diagnostics/failure.json": "Present only for a failed attempt.",
} as const;
