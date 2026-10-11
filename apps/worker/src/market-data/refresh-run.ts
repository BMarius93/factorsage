import {
  marketOverviewEtfs,
  type LocalDate,
  type MarketOverviewEtf,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  BenchmarkNotFoundError,
  decideBenchmarkRefresh,
  latestFinalizedSession,
  type BenchmarkDataService,
  type FinalizedSession,
  type TradingCalendar,
} from "@intrinsic/stock-data";

/** The slice of the benchmark loader a refresh run uses. */
export type MarketDataRefreshService = Pick<
  BenchmarkDataService,
  | "getBenchmark"
  | "benchmarkRefreshState"
  | "refreshBenchmarkSeries"
  | "ensureBenchmarkResident"
>;

export type EtfRefreshOutcome = {
  ticker: string;
  benchmarkCode: string;
  outcome:
    | "UP_TO_DATE"
    | "RECENTLY_ASKED"
    | "NOT_BOOTSTRAPPED"
    | "REFRESHED"
    | "AWAITING_PUBLICATION"
    | "REBASED"
    | "REBASE_REFUSED"
    | "FAILED"
    /** Not reached inside the run's budget, or the run was asked to stop; the next run does it. */
    | "DEFERRED"
    /** Skipped: it failed, or its re-base was refused, recently and is waiting out its backoff. */
    | "BACKING_OFF";
  latestBar?: LocalDate;
  basisGeneration?: number;
  providerReads: number;
  /** What the residency check found, for a series that did not need a provider read. */
  residency?: "RESIDENT" | "REPUBLISHED" | "EMPTY" | "UNPUBLISHED";
  durationMs: number;
  error?: string;
};

export type MarketDataRefreshSummary = {
  runSequence: number;
  expectedSession?: LocalDate;
  calendar?: FinalizedSession["calendar"];
  outcomes: EtfRefreshOutcome[];
  providerReads: number;
  failed: number;
  durationMs: number;
};

export type MarketDataRefreshRunOptions = {
  publicationDelayMs: number;
  /** Spacing between repeated reads of a session the provider has not published yet. */
  seriesRetryMs: number;
  /** A run starts no new series after this long; the rest wait for the next run. */
  runBudgetMs: number;
  now?: () => Date;
  /** The universe; the approved twenty unless a test narrows it. */
  etfs?: readonly MarketOverviewEtf[];
};

/**
 * The longest a series waits between attempts while its re-base keeps being refused, or while it
 * alone keeps failing. A refused re-base costs a tail read, an earliest-bars read and a whole-history
 * walk, so it is retried with a doubling delay from `seriesRetryMs` up to this — the stock loader's
 * refresh cadence — rather than on every run.
 */
export const MAX_SERIES_BACKOFF_MS = 6 * 60 * 60_000;

/** Raised when every series a run attempted failed: the run itself failed and is retried with backoff. */
export class MarketDataRefreshFailedError extends Error {
  constructor(readonly summary: MarketDataRefreshSummary) {
    super(
      `Every market-data series attempted in run ${summary.runSequence} failed (${summary.failed})`,
    );
    this.name = "MarketDataRefreshFailedError";
  }
}

/**
 * One pass over the market-overview ETFs (`docs/decisions/etf-market-data-v1.md`).
 *
 * For each series, in display order and one at a time — the provider gate is shared with Stock
 * Details, backtests and the Monitor's quotes, and a sequential pass takes at most one of its
 * concurrency slots:
 *
 * 1. decide from PostgreSQL alone whether the latest finalized session needs a provider read;
 * 2. if it does, refresh one bounded tail (never the history) with the re-base protection;
 * 3. if it does not, verify the Redis projection against PostgreSQL and republish what differs —
 *    which is also how a Redis restart is repaired within one run, without the provider.
 *
 * Each series is isolated: one that fails is logged with its error and retried on the next run, and
 * the others proceed. The run fails as a whole only when every series it attempted failed, which
 * is what an outage of PostgreSQL, Redis or the provider looks like, and backs off then.
 *
 * Bounded: no new series is started after `runBudgetMs`, nor once `aborted()` says the lease was
 * lost or the process is stopping. What is left is `DEFERRED` to the next run, never dropped.
 */
export class MarketDataRefreshRun {
  private readonly now: () => Date;
  private readonly etfs: readonly MarketOverviewEtf[];
  /**
   * Per-series backoff, in this process. It does not need to be durable: losing it on a restart
   * costs at most one early attempt per series, and the singleton claim means only one process
   * refreshes at a time.
   */
  private readonly backoff = new Map<
    string,
    { until: number; attempts: number }
  >();
  /**
   * When each series last came back `AWAITING_PUBLICATION`, in this process. A session the
   * provider has not published advances the durable tail watermark, which spaces the next read;
   * one whose newest bars were held at a possible ex-date does not, and would otherwise be read on
   * every run until the hold resolved. Losing this on a restart costs one early read.
   */
  private readonly awaitingSince = new Map<string, number>();

  constructor(
    private readonly benchmarks: MarketDataRefreshService,
    private readonly calendar: TradingCalendar,
    private readonly logger: StructuredLogger,
    private readonly options: MarketDataRefreshRunOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.etfs = options.etfs ?? marketOverviewEtfs();
  }

  async run(
    runSequence: number,
    aborted: () => boolean,
  ): Promise<MarketDataRefreshSummary> {
    const started = Date.now();
    const expected = await latestFinalizedSession({
      now: this.now(),
      calendar: this.calendar,
      publicationDelayMs: this.options.publicationDelayMs,
    });
    if (expected?.calendar === "WEEKDAYS") {
      this.logger.warn({
        event: "market-data.refresh.calendar-unavailable",
        runSequence,
        expectedSession: expected.session,
      });
    }

    const outcomes: EtfRefreshOutcome[] = [];
    for (const etf of this.etfs) {
      if (aborted() || Date.now() - started >= this.options.runBudgetMs) {
        outcomes.push({
          ticker: etf.ticker,
          benchmarkCode: etf.benchmarkCode,
          outcome: "DEFERRED",
          providerReads: 0,
          durationMs: 0,
        });
        continue;
      }
      const waiting = this.backoff.get(etf.benchmarkCode);
      if (waiting && waiting.until > this.now().getTime()) {
        outcomes.push({
          ticker: etf.ticker,
          benchmarkCode: etf.benchmarkCode,
          outcome: "BACKING_OFF",
          providerReads: 0,
          durationMs: 0,
        });
        continue;
      }
      outcomes.push(await this.refreshOne(etf, expected, runSequence));
    }

    const summary: MarketDataRefreshSummary = {
      runSequence,
      ...(expected
        ? { expectedSession: expected.session, calendar: expected.calendar }
        : {}),
      outcomes,
      providerReads: outcomes.reduce(
        (sum, item) => sum + item.providerReads,
        0,
      ),
      failed: outcomes.filter((item) => item.outcome === "FAILED").length,
      durationMs: Date.now() - started,
    };
    const attempted = outcomes.filter(
      (item) => item.outcome !== "DEFERRED" && item.outcome !== "BACKING_OFF",
    );
    const everyAttemptFailed =
      attempted.length > 0 &&
      attempted.every((item) => item.outcome === "FAILED");
    this.updateBackoff(attempted, everyAttemptFailed);
    const notBootstrapped = outcomes
      .filter((item) => item.outcome === "NOT_BOOTSTRAPPED")
      .map((item) => item.ticker);
    if (notBootstrapped.length > 0) {
      // Once per run rather than once per series: before the bootstrap has run this is true of all
      // twenty, every run, and it says one thing — run the bootstrap.
      this.logger.warn({
        event: "market-data.refresh.not-bootstrapped",
        runSequence,
        tickers: notBootstrapped,
      });
    }
    this.logger.info({
      event: "market-data.refresh.run.summary",
      runSequence,
      expectedSession: summary.expectedSession,
      calendar: summary.calendar,
      providerReads: summary.providerReads,
      failed: summary.failed,
      durationMs: summary.durationMs,
      outcomes: countBy(outcomes.map((item) => item.outcome)),
    });
    if (everyAttemptFailed) {
      throw new MarketDataRefreshFailedError(summary);
    }
    return summary;
  }

  /**
   * A refused re-base always backs off. A failure backs off only when other series succeeded in
   * the same run: when every attempt failed, the cause is shared — PostgreSQL, Redis or the provider
   * is down — and the run's own backoff already spaces the retry, so a recovered outage is not then
   * held up per series.
   */
  private updateBackoff(
    attempted: readonly EtfRefreshOutcome[],
    everyAttemptFailed: boolean,
  ): void {
    const now = this.now().getTime();
    for (const item of attempted) {
      const backsOff =
        item.outcome === "REBASE_REFUSED" ||
        (item.outcome === "FAILED" && !everyAttemptFailed);
      if (!backsOff) {
        if (item.outcome !== "FAILED") {
          this.backoff.delete(item.benchmarkCode);
        }
        continue;
      }
      const attempts =
        (this.backoff.get(item.benchmarkCode)?.attempts ?? 0) + 1;
      const delay = Math.min(
        this.options.seriesRetryMs * 2 ** Math.min(attempts - 1, 16),
        MAX_SERIES_BACKOFF_MS,
      );
      this.backoff.set(item.benchmarkCode, { until: now + delay, attempts });
    }
  }

  private async refreshOne(
    etf: MarketOverviewEtf,
    expected: FinalizedSession | undefined,
    runSequence: number,
  ): Promise<EtfRefreshOutcome> {
    const started = Date.now();
    const base = { ticker: etf.ticker, benchmarkCode: etf.benchmarkCode };
    try {
      const benchmark = await this.benchmarks.getBenchmark(etf.benchmarkCode);
      const series = benchmark.series;
      const state = await this.benchmarks.benchmarkRefreshState(series);
      const decided = decideBenchmarkRefresh({
        state,
        expected,
        now: this.now(),
        retryMs: this.options.seriesRetryMs,
      });
      const awaitingSince = this.awaitingSince.get(etf.benchmarkCode);
      const decision =
        decided.action === "REFRESH" &&
        awaitingSince !== undefined &&
        this.now().getTime() - awaitingSince < this.options.seriesRetryMs
          ? ({ action: "SKIP", reason: "RECENTLY_ASKED" } as const)
          : decided;

      if (decision.action === "SKIP") {
        if (decision.reason === "NOT_BOOTSTRAPPED") {
          // Never loaded: only the bootstrap command loads a history, so this says it is missing
          // rather than quietly downloading decades from inside a scheduled job.
          return {
            ...base,
            outcome: "NOT_BOOTSTRAPPED",
            providerReads: 0,
            durationMs: Date.now() - started,
          };
        }
        const residency = await this.benchmarks.ensureBenchmarkResident(series);
        if (residency.status === "UNPUBLISHED") {
          // Reads still work — they fall back to PostgreSQL — but residency does not hold.
          this.logger.warn({
            event: "market-data.refresh.unpublished",
            runSequence,
            ...base,
          });
        }
        if (residency.status === "REPUBLISHED") {
          this.logger.info({
            event: "market-data.refresh.republished",
            runSequence,
            ...base,
            bars: residency.bars,
            years: residency.years,
          });
        }
        return {
          ...base,
          outcome: decision.reason,
          ...(state.latestBar ? { latestBar: state.latestBar } : {}),
          basisGeneration: residency.basisGeneration,
          providerReads: 0,
          residency: residency.status,
          durationMs: Date.now() - started,
        };
      }

      const result = await this.benchmarks.refreshBenchmarkSeries(series, {
        ...(expected ? { expectedSession: expected.session } : {}),
      });
      if (result.status === "AWAITING_PUBLICATION") {
        this.awaitingSince.set(etf.benchmarkCode, this.now().getTime());
      } else {
        this.awaitingSince.delete(etf.benchmarkCode);
      }
      const outcome: EtfRefreshOutcome = {
        ...base,
        outcome:
          result.status === "NOT_BOOTSTRAPPED"
            ? "NOT_BOOTSTRAPPED"
            : result.status,
        ...(result.latestBar ? { latestBar: result.latestBar } : {}),
        basisGeneration: result.basisGeneration,
        providerReads: result.providerReads,
        durationMs: Date.now() - started,
      };
      const entry = {
        event: "market-data.refresh.series",
        runSequence,
        ...base,
        reason: decision.reason,
        status: result.status,
        latestBar: result.latestBar,
        expectedSession: expected?.session,
        basisGeneration: result.basisGeneration,
        providerReads: result.providerReads,
        durationMs: outcome.durationMs,
      };
      if (result.status === "REBASE_REFUSED") {
        this.logger.warn(entry);
      } else {
        this.logger.info(entry);
      }
      return outcome;
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof BenchmarkNotFoundError) {
        // The catalog row is written when the API boots and by the bootstrap; until one of them has
        // run on this release there is nothing to refresh, which is not a failure to back off from.
        return {
          ...base,
          outcome: "NOT_BOOTSTRAPPED",
          providerReads: 0,
          durationMs,
        };
      }
      this.logger.warn({
        event: "market-data.refresh.series.failed",
        runSequence,
        ...base,
        durationMs,
        err,
      });
      return {
        ...base,
        outcome: "FAILED",
        providerReads: 0,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
