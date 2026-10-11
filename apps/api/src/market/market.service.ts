import type {
  MarketOverviewGroupResponse,
  MarketOverviewInstrumentResponse,
  MarketOverviewResponse,
} from "@intrinsic/contracts";
import {
  MARKET_OVERVIEW_BASIS,
  MARKET_OVERVIEW_RETURN_BASIS,
} from "@intrinsic/contracts";
import {
  MARKET_OVERVIEW_ETF_GROUPS,
  marketOverviewEtfs,
  type BenchmarkWithSeries,
  type DateRange,
  type MarketOverviewEtf,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import type { BenchmarkDataService } from "@intrinsic/stock-data";
import { Inject, Injectable } from "@nestjs/common";
import { BENCHMARK_DATA_SERVICE } from "../benchmarks/benchmarks.tokens";
import {
  classifyInstruments,
  computeInstrumentPerformance,
  marketOverviewReadRange,
  unavailableInstrument,
} from "./market-overview";
import {
  MARKET_CLOCK,
  MARKET_LOGGER,
  MARKET_OVERVIEW_OPTIONS,
  type MarketOverviewOptions,
} from "./market.tokens";
import { SnapshotCache, type SnapshotLoad } from "./snapshot-cache";

/**
 * Everything the overview may ask of the benchmark subsystem, and nothing that reaches the
 * provider.
 *
 * `readBenchmarkHistory` is the `BenchmarkHistoryReader` boundary: the resident Redis projection,
 * rebuilt from PostgreSQL when Redis lost it, PostgreSQL when Redis cannot answer — never FMP.
 * `listBenchmarks` and `benchmarkRefreshState` read PostgreSQL only. Hydration methods are not in
 * this type, so a Dashboard visit cannot start a provider read however this service changes.
 */
export type MarketOverviewDataPort = Pick<
  BenchmarkDataService,
  "listBenchmarks" | "readBenchmarkHistory" | "benchmarkRefreshState"
>;

/** Series read at once: the history reader's own batch size. */
const READ_CONCURRENCY = 4;

type InstrumentAnswer = Omit<MarketOverviewInstrumentResponse, "status">;

type ComputedInstrument = {
  instrument: InstrumentAnswer;
  source: "REDIS" | "POSTGRESQL" | "PREVIOUS" | "NONE";
  /** For `PREVIOUS`: when the read it came from ran. */
  readAt?: number;
};

/** An instrument's last answer that came from a read that succeeded, and when that read ran. */
type SuccessfulRead = { instrument: InstrumentAnswer; readAt: number };

/**
 * How the twenty market-overview ETFs have performed, for whoever is looking at the Dashboard.
 *
 * No account-specific state and no viewer argument: a fund closed where it closed, and a Guest and
 * a signed-in customer are served the identical summary. That is why this is not part of the
 * Dashboard read model, which is entirely about which monitors the viewer can see.
 *
 * **It never asks the provider.** `docs/decisions/etf-market-data-v1.md` made PostgreSQL canonical,
 * the Redis projection fully resident and the worker's `market-data` child responsible for keeping
 * both current; this service only reads what they hold, through {@link MarketOverviewDataPort}. A
 * series that was never bootstrapped is reported unavailable, not fetched.
 *
 * **It is computed once and served to everyone** (`SnapshotCache`): at most one read of twenty
 * series per `cacheTtlMs` per process, a bounded window per series (a year and a few weeks), and the
 * arithmetic in `market-overview.ts`. The browser receives returns and a fifty-three-point line,
 * never a history.
 */
@Injectable()
export class MarketService {
  private readonly cache: SnapshotCache<MarketOverviewResponse>;
  /**
   * Each instrument's last successful read, by ticker. Written only when a read succeeds, so its
   * `readAt` is the age of the data itself — never the age of a summary that happened to carry it
   * forward. Twenty entries at most; one computation runs at a time (`SnapshotCache`), so nothing
   * else writes it concurrently.
   */
  private readonly lastSuccessful = new Map<string, SuccessfulRead>();

  constructor(
    @Inject(BENCHMARK_DATA_SERVICE)
    private readonly data: MarketOverviewDataPort,
    @Inject(MARKET_LOGGER) private readonly logger: StructuredLogger,
    @Inject(MARKET_CLOCK) private readonly now: () => Date,
    @Inject(MARKET_OVERVIEW_OPTIONS)
    private readonly options: MarketOverviewOptions,
  ) {
    this.cache = new SnapshotCache({
      ttlMs: options.cacheTtlMs,
      maxStaleMs: options.maxStaleMs,
      now: () => this.now().getTime(),
      onBackgroundFailure: (err) => {
        this.logger.error({ event: "market.overview.refresh.failed", err });
      },
    });
  }

  async getMarketOverview(): Promise<MarketOverviewResponse> {
    return this.cache.get(() => this.compute());
  }

  private async compute(): Promise<SnapshotLoad<MarketOverviewResponse>> {
    const startedAt = Date.now();
    const now = this.now();
    const range = marketOverviewReadRange(now.toISOString().slice(0, 10));
    this.logger.debug({
      event: "market.overview.compute.started",
      from: range.from,
      to: range.to,
    });

    try {
      // One PostgreSQL read resolves all twenty codes to the series currently in force.
      const benchmarks = new Map(
        (await this.data.listBenchmarks()).map((benchmark) => [
          benchmark.code,
          benchmark,
        ]),
      );
      const etfs = marketOverviewEtfs();
      const computed = await mapWithConcurrency(etfs, READ_CONCURRENCY, (etf) =>
        this.readInstrument(etf, benchmarks.get(etf.benchmarkCode), range, now),
      );

      const { asOf, statuses, status } = classifyInstruments(
        computed.map((one) => one.instrument.sessionDate),
      );
      let cursor = 0;
      const groups: MarketOverviewGroupResponse[] =
        MARKET_OVERVIEW_ETF_GROUPS.map((group) => ({
          id: group.id,
          label: group.label,
          shortLabel: group.shortLabel,
          instruments: group.etfs.map(() => {
            const index = cursor;
            cursor += 1;
            return {
              ...(computed[index] as ComputedInstrument).instrument,
              status: statuses[index] ?? "UNAVAILABLE",
            };
          }),
        }));

      const response: MarketOverviewResponse = {
        generatedAt: now.toISOString(),
        basis: MARKET_OVERVIEW_BASIS,
        returnBasis: MARKET_OVERVIEW_RETURN_BASIS,
        status,
        ...(asOf ? { asOf } : {}),
        groups,
      };
      this.logger.debug({
        event: "market.overview.compute.completed",
        status,
        asOf,
        available: statuses.filter((one) => one === "AVAILABLE").length,
        stale: statuses.filter((one) => one === "STALE").length,
        unavailable: statuses.filter((one) => one === "UNAVAILABLE").length,
        fromRedis: computed.filter((one) => one.source === "REDIS").length,
        fromPostgres: computed.filter((one) => one.source === "POSTGRESQL")
          .length,
        fromPrevious: computed.filter((one) => one.source === "PREVIOUS")
          .length,
        durationMs: Date.now() - startedAt,
      });
      // A kept answer is as old as the read it came from, not as new as this summary: the summary
      // stops being servable when its oldest kept read reaches the staleness bound.
      const keptReads = computed
        .map((one) => one.readAt)
        .filter((readAt): readAt is number => readAt !== undefined);
      return keptReads.length === 0
        ? { value: response }
        : {
            value: response,
            servableUntil: Math.min(...keptReads) + this.options.maxStaleMs,
          };
    } catch (err) {
      this.logger.error({
        event: "market.overview.compute.failed",
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    }
  }

  private async readInstrument(
    etf: MarketOverviewEtf,
    benchmark: BenchmarkWithSeries | undefined,
    range: Required<DateRange>,
    now: Date,
  ): Promise<ComputedInstrument> {
    const unavailable = unavailableInstrument(etf.ticker, etf.label, etf.note);
    if (!benchmark) {
      // The catalog is reconciled at every API boot, so this is a database the boot has not
      // reached yet. Nothing to read; nothing to fetch.
      this.logger.warn({
        event: "market.overview.instrument.unavailable",
        ticker: etf.ticker,
        code: etf.benchmarkCode,
        reason: "NOT_IN_CATALOG",
      });
      return { instrument: unavailable, source: "NONE" };
    }

    try {
      const [history, refresh] = await Promise.all([
        this.data.readBenchmarkHistory(benchmark.series, range),
        this.data.benchmarkRefreshState(benchmark.series),
      ]);
      const performance = computeInstrumentPerformance({
        bars: history.rows,
        missing: history.missing,
        now,
        publicationDelayMs: this.options.publicationDelayMs,
        ...(refresh.lastTailSyncAt
          ? { lastTailSyncAt: refresh.lastTailSyncAt }
          : {}),
      });
      const instrument: InstrumentAnswer = {
        ticker: etf.ticker,
        name: etf.label,
        ...(etf.note ? { note: etf.note } : {}),
        ...(performance.sessionDate
          ? { sessionDate: performance.sessionDate }
          : {}),
        returns: performance.returns,
        sparkline: performance.sparkline,
      };
      this.lastSuccessful.set(etf.ticker, {
        instrument,
        readAt: now.getTime(),
      });
      return { instrument, source: history.source };
    } catch (err) {
      // Logged with the original error, then isolated to this one instrument: a series that cannot
      // be read must not take down a page that has nineteen others to show. Its last successful
      // read is still a correct answer, dated by its own session, so it is kept while that *read*
      // is younger than the staleness bound — measured from when the read ran, never from the
      // summary that last carried it, so repeated failures cannot keep an old answer alive.
      // Afterwards the instrument has no numbers until a read succeeds again.
      const kept = this.lastSuccessful.get(etf.ticker);
      const keptAgeMs = kept ? now.getTime() - kept.readAt : undefined;
      const usable =
        kept !== undefined &&
        keptAgeMs !== undefined &&
        keptAgeMs < this.options.maxStaleMs &&
        kept.instrument.sessionDate !== undefined
          ? kept
          : undefined;
      if (kept !== undefined && usable === undefined) {
        this.lastSuccessful.delete(etf.ticker);
      }
      this.logger.warn({
        event: "market.overview.instrument.failed",
        ticker: etf.ticker,
        code: etf.benchmarkCode,
        seriesId: benchmark.series.id,
        keptPrevious: usable !== undefined,
        ...(keptAgeMs !== undefined
          ? { lastSuccessfulReadAgeMs: keptAgeMs }
          : {}),
        err,
      });
      if (usable) {
        return {
          instrument: usable.instrument,
          source: "PREVIOUS",
          readAt: usable.readAt,
        };
      }
      return { instrument: unavailable, source: "NONE" };
    }
  }
}

/** `work` over `items`, at most `limit` at a time, results in input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index] as T);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
