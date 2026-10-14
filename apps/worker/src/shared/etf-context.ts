import {
  findStrategyEtfSource,
  type BacktestEtfConditionDiagnosticsResponse,
  type StrategyEtfSourceCode,
} from "@intrinsic/contracts";
import type {
  BenchmarkHistory,
  BenchmarkRefreshState,
} from "@intrinsic/stock-data";
import {
  buildBenchmarkTechnicalContext,
  MARKET_OVERVIEW_HISTORY_FLOOR,
  type BenchmarkTechnicalSnapshot,
} from "@intrinsic/stock-data";
import type {
  BenchmarkSeries,
  DateRange,
  LocalDate,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";

/**
 * The provider-free reads one ETF technical context needs (owner decision 2, 2026-10-13).
 *
 * Deliberately only the `BenchmarkHistoryReader` slice plus the two PostgreSQL state reads: no
 * hydration method is in the port, so evaluating a Strategy's ETF conditions **cannot** reach FMP.
 * The bootstrap and the market-data refresh child own provider reads; an ETF they have not
 * maintained is reported unavailable here, with its reason, never fetched.
 */
export interface EtfContextLoader {
  getSeries(seriesId: string): Promise<BenchmarkSeries>;
  readFullBenchmarkHistory(
    series: BenchmarkSeries,
    through?: LocalDate,
  ): Promise<BenchmarkHistory>;
  benchmarkRefreshState(
    series: BenchmarkSeries,
  ): Promise<BenchmarkRefreshState>;
  missingBenchmarkCoverage(
    series: BenchmarkSeries,
    period: Required<DateRange>,
  ): Promise<Required<DateRange>[]>;
}

/**
 * Why one ETF's conditions could or could not evaluate, in the aggregate, user-visible vocabulary
 * of owner decision 9. The shape is the contract's own
 * (`BacktestEtfConditionDiagnosticsResponse`), because a backtest run persists these rows and its
 * result response serves them; the Monitor cycle logs the same shape.
 */
export type EtfConditionDiagnostic = BacktestEtfConditionDiagnosticsResponse;

export type EtfTechnicalSnapshots = ReadonlyMap<
  StrategyEtfSourceCode,
  BenchmarkTechnicalSnapshot
>;

/**
 * Loads and computes the technical context of the given ETF series — **once per distinct ETF**,
 * however many securities, conditions or Monitors read it. A failed or unavailable series degrades
 * exactly the conditions naming it (their columns join as NaN, so they are `NOT_EVALUABLE`) and
 * nothing else: an ETF problem is never a run or cycle failure, because it invalidates only the
 * rules that read it.
 */
export async function loadEtfTechnicalSnapshots(input: {
  /** Each named code with the immutable series id it resolves by. */
  series: readonly { code: StrategyEtfSourceCode; seriesId: string }[];
  loader: EtfContextLoader;
  now: Date;
  publicationDelayMs: number;
  logger: StructuredLogger;
  /** Correlation fields stamped onto every event. */
  logContext?: Record<string, string>;
}): Promise<{
  snapshots: EtfTechnicalSnapshots;
  diagnostics: EtfConditionDiagnostic[];
}> {
  const snapshots = new Map<StrategyEtfSourceCode, BenchmarkTechnicalSnapshot>();
  const diagnostics: EtfConditionDiagnostic[] = [];
  for (const { code, seriesId } of input.series) {
    const ticker = findStrategyEtfSource(code)?.ticker ?? code;
    const startedAt = Date.now();
    try {
      const series = await input.loader.getSeries(seriesId);
      const [history, refreshState] = await Promise.all([
        input.loader.readFullBenchmarkHistory(series),
        input.loader.benchmarkRefreshState(series),
      ]);
      const missingFromFloor = await input.loader.missingBenchmarkCoverage(
        series,
        {
          from: MARKET_OVERVIEW_HISTORY_FLOOR,
          to: refreshState.coverageEnd ?? MARKET_OVERVIEW_HISTORY_FLOOR,
        },
      );
      const context = buildBenchmarkTechnicalContext({
        seriesId,
        history,
        refreshState,
        missingFromFloor,
        now: input.now,
        publicationDelayMs: input.publicationDelayMs,
      });
      if (context.status === "READY") {
        snapshots.set(code, context.snapshot);
        diagnostics.push({
          code,
          ticker,
          status: "READY",
          ...(context.snapshot.dates[0] === undefined
            ? {}
            : { firstSession: context.snapshot.dates[0] }),
          ...(context.snapshot.latestSession === undefined
            ? {}
            : { latestSession: context.snapshot.latestSession }),
          basisGeneration: context.snapshot.basisGeneration,
        });
      } else {
        diagnostics.push({
          code,
          ticker,
          status:
            context.status === "NOT_ANCHORED"
              ? "NOT_BOOTSTRAPPED"
              : context.status === "NOT_SYNCHRONIZED"
                ? "NOT_SYNCHRONIZED"
                : "NO_FINALIZED_SESSIONS",
        });
      }
      input.logger.info({
        event: "etf-context.series.loaded",
        ...input.logContext,
        code,
        seriesId,
        status: diagnostics[diagnostics.length - 1]?.status,
        bars: context.status === "READY" ? context.snapshot.dates.length : 0,
        basisGeneration: history.basisGeneration,
        source: history.source,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      diagnostics.push({ code, ticker, status: "LOAD_FAILED" });
      input.logger.warn({
        event: "etf-context.series.failed",
        ...input.logContext,
        code,
        seriesId,
        durationMs: Date.now() - startedAt,
        err,
      });
    }
  }
  return { snapshots, diagnostics };
}
