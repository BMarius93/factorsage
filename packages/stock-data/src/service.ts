import { randomUUID } from "node:crypto";
import {
  isValuationRatioId,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import {
  operandValuationRatioId,
  requiredAlternativeDataLeadingSessions,
  type AlternativeDataFacts,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import {
  alternativeDataDomainsFor,
  type ActorGroupMembershipResolver,
  type CanonicalAlternativeDataService,
} from "./alternative-data-service.js";
import {
  DAILY_MOVING_AVERAGES,
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  FINANCIAL_STATEMENT_TYPES,
  FUNDAMENTAL_METRIC_IDS,
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  DAILY_TECHNICAL_PROJECTION_FIELDS,
  WEEKLY_MOVING_AVERAGES,
  fundamentalMetricDefinition,
  type DailyDerivedState,
  type DailyFundamentalMetricPoint,
  type DailyPrice,
  type DailyTechnical,
  type DateRange,
  type FinancialStatement,
  type FinancialStatementCadence,
  type FinancialStatementQuery,
  type FinancialStatementType,
  type FundamentalMetricField,
  type FundamentalMetricId,
  type IntrinsicValueBlendPoint,
  type IntrinsicValueBlendQuery,
  type IntrinsicValuePoint,
  type IntrinsicValueQuery,
  type LocalDate,
  type Security,
  type SecurityId,
  type SecuritySearchQuery,
  type SecurityWithLogo,
  type StockDataService,
  type StockDetails,
  type StockHistoryBounds,
} from "@intrinsic/domain";
import type {
  FmpCurrentQuoteProviderPort,
  FmpStockSplitPort,
  FmpStockProviderPort,
} from "@intrinsic/fmp";
import {
  FINANCIAL_STATEMENT_VERSION,
  yearsInRange,
  type StockDataCache,
  type StockManifest,
} from "./cache.js";
import { DAILY_STATE_ENCODING_VERSION } from "./daily-state-chunk.js";
import type { LoadLease, LoadCoordinator } from "./coordination.js";
import {
  projectEvaluationFrame,
  TRIGGER_CONTEXT_CALENDAR_DAYS,
} from "./evaluation-frame.js";
import { materializeDailyFundamentals } from "./fundamental-metrics-materializer.js";
import { materializeDailyIntrinsicValues } from "./intrinsic-value-materializer.js";
import {
  blendSourceDataAsOf,
  intrinsicModelSourceAsOf,
} from "./intrinsic-values.js";
import {
  addDays,
  assertDateRange,
  endOfLocalDate,
  maxDate,
  minDate,
  missingCoverageRanges,
  subtractYears,
} from "./dates.js";
import {
  buildDailyDerivedState,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import {
  comparePriceHistories,
  heldFromIndex,
  UNEXPLAINED_SESSION_SHARE,
  closesDiffer,
  type PriceBasisEvent,
  type SecurityPriceBasisState,
} from "./price-basis.js";
import { applyPriceBasisToIntrinsicStates } from "./share-basis.js";
import {
  buildValuationTimeline,
  valuationRatioColumns,
  type ValuationTimeline,
} from "./valuation-ratios.js";
import {
  DAILY_PRICE_FRESHNESS_VARIANT,
  DAILY_PRICE_VARIANT,
  PRICE_DATASET_VERSION,
  type DailyPriceBounds,
  type PersistedDatasetState,
  type StockDataStore,
} from "./ports.js";
import {
  normalizeSearchTerm,
  rankSecurityMatches,
  resolveSecuritySearchLimit,
  SECURITY_SEARCH_CANDIDATE_FACTOR,
} from "./security-search.js";
import {
  monitorWindowCalendarDays,
  projectMonitorEvaluationFrame,
  type CurrentObservation,
  type MonitorEvaluationFrame,
} from "./monitor-frame.js";
import { aggregateCompletedWeeks, startOfIsoWeek } from "./weekly.js";

const QUARTERLY_CADENCE = "QUARTERLY" as const;
const ANNUAL_CADENCE = "ANNUAL" as const;
/**
 * Revision of *which* fundamentals a security materializes and how they are keyed.
 *
 * Exported because it can move a number the backtest engine sees: intrinsic values and their
 * blends are computed from these statements into `DailyDerivedState`, so a security hydrated after
 * a change to this revision can produce different Margin of Safety readings for the same date than
 * one hydrated before it.
 */
export const FUNDAMENTALS_VARIANT_VERSION = 1;

const FUNDAMENTALS_CADENCES: readonly FinancialStatementCadence[] = [
  QUARTERLY_CADENCE,
  ANNUAL_CADENCE,
];
/**
 * Extra fiscal years of financial statements retained before the visible price history.
 *
 * A valuation on the first visible trading day needs a four-quarter TTM window and the exact
 * `N` / `N - 5` annual growth endpoints, all of which must already be point-in-time eligible on
 * that day. Without this warm-up the earliest part of every history would have no intrinsic values
 * and would fall back to default growth. It changes fundamentals retention only: price history,
 * derived rows, cached projections, API output and backtests all stay at the configured horizon.
 */
export const VALUATION_FUNDAMENTALS_WARMUP_YEARS = 7;

const CALENDAR_DAYS_PER_WEEK = 7;
const TRADING_DAYS_PER_WEEK = 5;
/**
 * Weeks kept beyond the exact longest lookback: one for the partial week a requested window can
 * start inside, the rest so a holiday-shortened or untraded week cannot push a warmed-up series
 * back off its first visible day.
 */
const DERIVED_SERIES_WARMUP_MARGIN_WEEKS = 8;

/**
 * Calendar days of price history the loader materializes *before* a requested window so every
 * catalog derived series is already warmed up on its first trading day.
 *
 * The bound is derived from the canonical registries rather than a second copy of the period
 * list: daily moving averages, oscillators and Relative Volume count trading days, weekly moving
 * averages count completed weeks, so both are expressed in weeks and the wider one wins. Today
 * that is `SMA(200, 1W)` / `EMA(200, 1W)` at two hundred completed weeks.
 *
 * This is the only history Stock Details pulls in beyond what the caller asked for. It exists for
 * calculation correctness, not as a retention policy: the configured product horizon stays the
 * outer bound a backtest can explicitly reach for, never an implicit floor for a page view.
 */
export const DERIVED_SERIES_WARMUP_DAYS =
  (Math.max(
    Math.ceil(
      Math.max(
        ...DAILY_MOVING_AVERAGES.map((average) => average.period),
        ...DAILY_OSCILLATORS.map((oscillator) => oscillator.period),
        // `+ 1`: an RVOL period counts the sessions *before* the one being measured, so its first
        // value needs one observation more than its period.
        ...DAILY_RELATIVE_VOLUMES.map((entry) => entry.period + 1),
      ) / TRADING_DAYS_PER_WEEK,
    ),
    ...WEEKLY_MOVING_AVERAGES.map((average) => average.period),
  ) +
    DERIVED_SERIES_WARMUP_MARGIN_WEEKS) *
  CALENDAR_DAYS_PER_WEEK;

const CALENDAR_DAYS_PER_YEAR = 365.25;

/**
 * Extra whole years of raw `DailyPrice` history retained *before* the product horizon.
 *
 * The product horizon is the oldest day a user may select, chart or backtest. It is not the oldest
 * day the loader may hold, because every recursive or long-window series needs closes from before
 * the first visible day to be valid on it: at a two-hundred completed-week lookback, a backtest
 * that starts exactly on the product boundary would otherwise spend its first four years with no
 * `sma200w`/`ema200w` at all.
 *
 * Derived from `DERIVED_SERIES_WARMUP_DAYS` rather than typed as a literal, so registering a
 * longer series widens retention with it instead of silently reintroducing the null warm-up. Today
 * that is four years, on a thirty-year product horizon: thirty-four years of retained prices.
 *
 * It is internal data. Nothing about the product surface widens with it — see
 * {@link CanonicalStockDataService.projectionRange} for the visible bound and
 * {@link VALUATION_FUNDAMENTALS_WARMUP_YEARS} for the separate fundamentals policy, which stays
 * anchored to the product horizon and must never compound with this one.
 */
export const PRICE_RETENTION_WARMUP_YEARS = Math.ceil(
  DERIVED_SERIES_WARMUP_DAYS / CALENDAR_DAYS_PER_YEAR,
);

/**
 * Years of raw price history retained for a given product horizon.
 *
 * One function so the loader, the QA seed and the tests cannot disagree about what "retention"
 * means. Callers that need a *date* must go through `subtractYears`, never their own arithmetic:
 * the 29 February clamp is what keeps the product and retention boundaries on one calendar rule.
 */
export function priceRetentionYears(productHistoryYears: number): number {
  return productHistoryYears + PRICE_RETENTION_WARMUP_YEARS;
}

/**
 * Calendar days the earliest persisted row must lie beyond the permitted Stock Details start
 * before that row is reported as the provider's own boundary.
 *
 * The permitted start is a calendar date; the first trading day at or after it can trail it by a
 * weekend and a holiday, and that gap says nothing about the provider. A gap longer than a week
 * cannot be a market closure, so only then is a verified-empty span reported as `PROVIDER`.
 * Exhaustion is unaffected either way: the chart pins at the first bar it holds.
 */
const PROVIDER_BOUNDARY_MIN_GAP_DAYS = 7;

/**
 * Lower bound for "every bar this security has", used when asking the store for its earliest one.
 *
 * A date rather than an unbounded query, because the store's bounds read takes a range. No equity
 * series this product can hold starts before it.
 */
const EARLIEST_PERSISTED_PRICE_DATE = "1900-01-01";

const FUNDAMENTALS_BACKFILL_QUARTERLY_TAIL = 8;
const FUNDAMENTALS_BACKFILL_ANNUAL_TAIL = 2;
const FUNDAMENTALS_REFRESH_QUARTERLY_LIMIT = 12;
const FUNDAMENTALS_REFRESH_ANNUAL_LIMIT = 3;

const FUNDAMENTALS_DATASET_BY_TYPE: Record<
  FinancialStatementType,
  "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW"
> = {
  INCOME: "INCOME_STATEMENT",
  BALANCE_SHEET: "BALANCE_SHEET",
  CASH_FLOW: "CASH_FLOW",
};

type FundamentalsOperation = {
  statementType: FinancialStatementType;
  cadence: FinancialStatementCadence;
  dataset: "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW";
  variant: string;
};

/**
 * Dataset variant of one persisted fundamentals cadence.
 *
 * The variant encodes the retention policy, not just the horizon: a successful `h30` backfill from
 * before the warm-up existed must not be read as proof that `h30:w7` is already retained. The
 * mapping version is unchanged because the provider mapping itself did not change.
 *
 * Exported so anything that has to recognise an already-satisfied fundamentals dataset — the
 * service itself, and the deterministic QA seed used by browser tests — resolves the same string
 * instead of hard-coding a second copy of it.
 */
export function fundamentalsDatasetVariant(
  cadence: FinancialStatementCadence,
  historyYears: number,
): string {
  const cadenceKey = cadence === QUARTERLY_CADENCE ? "quarter" : "annual";
  return `standard:${cadenceKey}:v${FUNDAMENTALS_VARIANT_VERSION}:h${historyYears}:w${VALUATION_FUNDAMENTALS_WARMUP_YEARS}`;
}

/** Every statement-type/cadence dataset the canonical history expects, with its variant. */
export function fundamentalsDatasetOperations(
  historyYears: number,
): FundamentalsOperation[] {
  return FINANCIAL_STATEMENT_TYPES.flatMap((statementType) =>
    FUNDAMENTALS_CADENCES.map((cadence) => ({
      statementType,
      cadence,
      dataset: FUNDAMENTALS_DATASET_BY_TYPE[statementType],
      variant: fundamentalsDatasetVariant(cadence, historyYears),
    })),
  );
}

export class StockDataNotFoundError extends Error {
  constructor(symbol: string) {
    super(`Stock symbol '${symbol}' was not found`);
    this.name = "StockDataNotFoundError";
  }
}

export class StockDataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockDataValidationError";
  }
}

/**
 * Why the loader reached the provider.
 *
 * Every historical fetch is meant to be explainable: a run that repeats an identical backtest and
 * still sees provider traffic should be able to answer "for what?" from the logs rather than from
 * a packet capture.
 */
export type ProviderRequestReason =
  | "PROFILE_SYNC"
  | "MISSING_COVERAGE"
  | "RECENT_TAIL_STALE"
  | "FUNDAMENTALS_BACKFILL"
  /** The whole stored history, read once to verify it against the provider's (price basis §7). */
  | "PRICE_BASIS_VERIFICATION"
  /** The earliest stored row, re-read before rows are saved beside the stored history. */
  | "PRICE_BASIS_EARLIEST_ROW"
  /** The whole history, re-read to replace it after the earliest row showed a re-base. */
  | "PRICE_REBASE"
  /** One batched current-quote read for a whole Monitor evaluation cycle. */
  | "MONITOR_CURRENT_DATA"
  /** The split list a valuation ratio's price-basis rules read, when the stored one is a day old. */
  | "VALUATION_SPLIT_LIST";

export type ProviderRequestEvent = {
  symbol: string;
  securityId: string;
  dataset:
    | "SECURITY_PROFILE"
    | "DAILY_PRICE"
    | "FINANCIAL_STATEMENTS"
    | "CURRENT_QUOTE"
    | "STOCK_SPLIT";
  reason: ProviderRequestReason;
  from?: string;
  to?: string;
  detail?: string;
};

/**
 * What the re-base detector reports (`docs/decisions/historical-price-basis-v1.md`, §7–§9), for the
 * composition roots to log. Stock data has no logging dependency, as for provider requests.
 */
export type PriceBasisObservation = {
  securityId: string;
  symbol: string;
  outcome:
    /** A first verification found the stored history equal to the provider's. */
    | "VERIFIED"
    /** The stored history was replaced: by a first verification or after a re-base. */
    | "REPLACED"
    /** A replacement failed and changed nothing; the error is rethrown to the read that caused it. */
    | "REPLACEMENT_FAILED"
    /** A replacement would have dropped too many stored sessions; the old history was kept. */
    | "REPLACEMENT_REFUSED"
    /** Rows after a split-sized move were not saved yet (the ex-date hold). */
    | "HELD"
    /** The earliest stored row changed, but the full comparison found nothing to replace. */
    | "EARLIEST_ROW_UNCONFIRMED";
  generation?: number;
  measuredEvents?: number;
  unexplainedEvents?: number;
  heldFrom?: LocalDate;
  storedOnlySessions?: number;
  /** How long a replacement took, completed or failed. */
  durationMs?: number;
  /** Why a replacement failed. */
  err?: unknown;
  detail?: string;
};

/**
 * The composition roots' one way to log `PriceBasisObservation`s, so the event name and level are
 * the same in the API and in every worker: `stock-data.price-basis`, at `error` when a replacement
 * failed, `warn` when a re-base could not be handled and `info` otherwise.
 */
export function logPriceBasisEvent(logger: {
  info(entry: Record<string, unknown>): void;
  warn(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}): (observation: PriceBasisObservation) => void {
  return (observation) => {
    const entry = { event: "stock-data.price-basis", ...observation };
    if (observation.outcome === "REPLACEMENT_FAILED") {
      logger.error(entry);
    } else if (
      observation.outcome === "REPLACEMENT_REFUSED" ||
      observation.outcome === "EARLIEST_ROW_UNCONFIRMED"
    ) {
      logger.warn(entry);
    } else {
      logger.info(entry);
    }
  };
}

export type CanonicalStockDataServiceOptions = {
  defaultHistoryDays?: number;
  /**
   * The product horizon: the oldest day any surface may select, chart, query or backtest.
   *
   * It is deliberately **not** the retention horizon. Raw prices are retained for
   * `priceRetentionYears(productHistoryYears)` so long series are already valid on the first
   * visible day; those extra years never reach a projection, a bound or an API contract.
   */
  productHistoryYears?: number;
  /**
   * Retained years the Stock Details surface may explore, when that is narrower than the
   * product horizon. Defaults to the product horizon, so an unconfigured service reports
   * exactly what it exposes. A backtest names its own period and is unaffected.
   */
  stockDetailsHistoryYears?: number;
  recentPriceFreshnessMs?: number;
  fundamentalsFreshnessMs?: number;
  recentTailCalendarDays?: number;
  now?: () => Date;
  /**
   * Called immediately before each provider request, with the reason for it.
   *
   * An observer rather than a logger: `@intrinsic/stock-data` has no logging dependency and should
   * not grow one. The API and worker composition roots point this at their own structured logger.
   */
  onProviderRequest?: (event: ProviderRequestEvent) => void;
  /** Called on every re-base decision; the composition roots log it at `info`. */
  onPriceBasisEvent?: (event: PriceBasisObservation) => void;
  /**
   * The alternative-data loader, when this composition offers those metrics.
   *
   * Optional so an unrelated composition — a fixture, a narrow script — need not construct it, and
   * **required in practice**: `projectEvaluationFrame` refuses an alternative-data operand with no
   * loaded facts rather than projecting it as absent, so a production root that forgot to wire it
   * fails loudly on the first strategy that names one instead of silently never firing.
   */
  alternativeData?: CanonicalAlternativeDataService;
};

/**
 * Per-read options for an evaluation frame.
 *
 * `resolveGroupMembers` is how a backtest keeps its promise that editing an actor group never changes
 * a run that already exists: the worker passes a resolver reading the **frozen membership in the
 * run's own snapshot**, while a live surface passes nothing and the loader reads the group as it
 * stands.
 */
export type EvaluationFrameOptions = {
  resolveGroupMembers?: ActorGroupMembershipResolver;
  /**
   * The price-basis generation the caller prepared under (`prepareDailyEvaluationData`). When set,
   * a read whose security has been re-based since is refused with `PriceBasisChangedError`, so one
   * backtest never reads two bases (`historical-price-basis-v1.md`, §9).
   */
  priceBasisGeneration?: number;
  /**
   * The valuation inputs the caller prepared (`prepareDailyEvaluationData`), read instead of the
   * stored statements, re-bases and split list. A backtest reads every window through the inputs
   * of the generation it pinned, and reads them once.
   */
  valuation?: ValuationTimeline;
};

/** What `prepareDailyEvaluationData` reports: the period's coverage and its price basis. */
export type PreparedDailyEvaluationData = DailyPriceBounds & {
  /**
   * The price-basis generation the period was prepared under: 0 until the stored history is first
   * replaced. Every later window read of the run must match it.
   */
  priceBasisGeneration: number;
  /**
   * The security's valuation inputs, when the operands name a valuation ratio: computed once while
   * preparing, from the generation above, and passed back with every window read.
   */
  valuation?: ValuationTimeline;
};

/**
 * One trading session of one valuation ratio, as Stock Details reads it: the ratio the canonical
 * calculation gives that session, or no `value` where the ratio is unavailable — never zero, and
 * never an earlier value standing in for the unavailable one.
 */
export type DailyValuationRatioPoint = {
  date: LocalDate;
  value?: number;
};

/**
 * The Stock Details read boundary: every canonical stock-data read, and one whose identity belongs
 * to a product catalog the domain does not know — a valuation ratio's history, projected when read.
 */
export interface StockDetailsDataService extends StockDataService {
  getDailyValuationRatio(
    symbol: string,
    ratioId: ValuationRatioId,
    range: DateRange,
  ): Promise<DailyValuationRatioPoint[]>;
}

/**
 * A security's stored price history was replaced after a re-base between the preparation of a run
 * and one of its window reads. The run cannot continue on one basis, so it fails and may be run
 * again (`historical-price-basis-v1.md`, §9).
 */
/**
 * Calendar days read from the start of the stored history by the earliest-row check: enough
 * sessions that a provider no longer returning the first few still leaves one in common.
 */
const EARLIEST_ROWS_WINDOW_CALENDAR_DAYS = 30;

/**
 * How long a stored split list is trusted before a valuation read asks the provider again. A day is
 * enough: the provider lists an announced event before its date, and an event it has not re-based is
 * withheld from that listing (`valuation-ratios-v1.md`, rule 8).
 */
export const STOCK_SPLIT_LIST_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export class PriceBasisChangedError extends Error {
  constructor(
    readonly securityId: string,
    readonly symbol: string,
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(
      `The price history of ${symbol} was re-based during the read (generation ${expectedGeneration} -> ${actualGeneration})`,
    );
    this.name = "PriceBasisChangedError";
  }
}

export class CanonicalStockDataService implements StockDetailsDataService {
  private readonly defaultHistoryDays: number;
  private readonly productHistoryYears: number;
  private readonly priceRetentionYears: number;
  private readonly stockDetailsHistoryYears: number;
  private readonly recentPriceFreshnessMs: number;
  private readonly fundamentalsFreshnessMs: number;
  private readonly recentTailCalendarDays: number;
  private readonly now: () => Date;
  private readonly onProviderRequest: (event: ProviderRequestEvent) => void;
  private readonly onPriceBasisEvent: (event: PriceBasisObservation) => void;
  private readonly alternativeData?: CanonicalAlternativeDataService;

  constructor(
    private readonly store: StockDataStore,
    private readonly provider: FmpStockProviderPort &
      Partial<FmpCurrentQuoteProviderPort> &
      Partial<FmpStockSplitPort>,
    private readonly cache: StockDataCache,
    private readonly coordinator: LoadCoordinator,
    options: CanonicalStockDataServiceOptions = {},
  ) {
    this.defaultHistoryDays = options.defaultHistoryDays ?? 365;
    this.productHistoryYears = options.productHistoryYears ?? 30;
    this.priceRetentionYears = priceRetentionYears(this.productHistoryYears);
    this.stockDetailsHistoryYears = Math.min(
      this.productHistoryYears,
      options.stockDetailsHistoryYears ?? this.productHistoryYears,
    );
    this.recentPriceFreshnessMs =
      options.recentPriceFreshnessMs ?? 6 * 60 * 60 * 1000;
    this.fundamentalsFreshnessMs =
      options.fundamentalsFreshnessMs ?? 6 * 60 * 60 * 1000;
    this.recentTailCalendarDays = options.recentTailCalendarDays ?? 10;
    this.now = options.now ?? (() => new Date());
    this.onProviderRequest = options.onProviderRequest ?? (() => {});
    this.onPriceBasisEvent = options.onPriceBasisEvent ?? (() => {});
    if (options.alternativeData) {
      this.alternativeData = options.alternativeData;
    }
    for (const [name, value] of Object.entries({
      defaultHistoryDays: this.defaultHistoryDays,
      productHistoryYears: this.productHistoryYears,
      recentPriceFreshnessMs: this.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: this.fundamentalsFreshnessMs,
      recentTailCalendarDays: this.recentTailCalendarDays,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  /**
   * Resolves a symbol against the canonical `Security` catalog.
   *
   * `Security` is the catalog of supported stocks, so this is a pure lookup: cache, then
   * PostgreSQL, then not-found. It deliberately does not discover unknown symbols from the
   * provider — a stock the catalog does not list is a stock this application does not support,
   * and admitting one is an explicit admin synchronization, never a side effect of a page view.
   */
  async getSecurity(symbol: string): Promise<Security> {
    const normalized = this.normalizeSymbol(symbol);
    const cached = await this.cache.getSecurity(normalized);
    // The cached identity is trusted only while its stock generation is READY. Outside that
    // window PostgreSQL decides: hydrating against a security row the durable store no longer
    // has would fail every dependent insert on its foreign key instead of re-resolving.
    if (cached && this.isCurrent(await this.cache.getManifest(cached.id))) {
      return cached;
    }
    const persisted = await this.store.findSecurityByProviderSymbol(normalized);
    if (!persisted) {
      throw new StockDataNotFoundError(normalized);
    }
    await this.cache.setSecurity(persisted);
    return persisted;
  }

  /**
   * Global stock search over the persisted securities universe.
   *
   * Unlike `getSecurity`, this never falls through to the provider and never hydrates: search runs
   * on every debounced keystroke, so an unknown term must resolve to an empty list rather than a
   * paid FMP profile lookup and a speculative hydration.
   */
  async searchSecurities(
    query: SecuritySearchQuery,
  ): Promise<SecurityWithLogo[]> {
    const term = normalizeSearchTerm(query.term);
    if (term === "") {
      return [];
    }
    const limit = resolveSecuritySearchLimit(query.limit);
    const candidates = await this.store.searchSecurities({
      term,
      limit: limit * SECURITY_SEARCH_CANDIDATE_FACTOR,
    });
    return rankSecurityMatches(term, candidates, limit);
  }

  /**
   * Materializes at least `requested` for this security.
   *
   * The range is a parameter, never a default the loader picks for itself: a caller that wants
   * decades of history says so, and a caller that wants one year pays for one year plus the
   * derived warm-up. Anything already resident is kept, so widening is incremental.
   */
  async ensureStockHydrated(
    security: Security,
    required: Required<DateRange>,
  ): Promise<void> {
    const manifest = await this.cache.getManifest(security.id);
    if (this.covers(manifest, required)) {
      return;
    }
    await this.coordinator.run(this.stockResource(security), async (lease) =>
      this.hydrateWithinLease(security, required, lease),
    );
  }

  async ensureStockFresh(
    security: Security,
    required: Required<DateRange>,
  ): Promise<void> {
    let manifest = await this.cache.getManifest(security.id);
    if (!this.covers(manifest, required)) {
      await this.ensureStockHydrated(security, required);
      manifest = await this.cache.getManifest(security.id);
    }
    if (
      !this.isPriceFreshnessStale(manifest) &&
      !this.isFundamentalsFreshnessStale(manifest)
    ) {
      return;
    }

    await this.coordinator.run(this.stockResource(security), async (lease) => {
      let lockedManifest = await this.cache.getManifest(security.id);
      if (!this.covers(lockedManifest, required)) {
        await this.hydrateWithinLease(security, required, lease);
        lockedManifest = await this.cache.getManifest(security.id);
      }
      if (!this.isCurrent(lockedManifest)) {
        return;
      }
      const refreshPrices = this.isPriceFreshnessStale(lockedManifest);
      const refreshFundamentals =
        this.isFundamentalsFreshnessStale(lockedManifest);
      if (!refreshPrices && !refreshFundamentals) {
        return;
      }

      // A refresh maintains exactly what is already resident. It must never narrow the cached
      // range — that would silently drop history a wider caller has already paid to load — and
      // never widen it either, which is what re-reading the configured horizon here used to do.
      const target = this.maintainedTarget(required, lockedManifest);
      lease.assertOwned();
      const hydrating = this.hydratingManifest(
        security,
        lockedManifest,
        target,
      );
      if (!(await this.cache.beginRefresh(lockedManifest, hydrating))) {
        await this.hydrateWithinLease(security, required, lease);
        return;
      }

      let prices = await this.store.getDailyPrices(security.id, target);
      let lastPriceRefreshAt = lockedManifest.lastPriceRefreshAt;
      const rebuildStarts: (string | undefined)[] = [];
      // Years whose derived rows a replacement already rebuilt in its own transaction.
      const republishStarts: (string | undefined)[] = [];
      const verification = await this.verifyPriceBasisWithinLease(
        security,
        target,
        lease,
      );
      if (verification.replacedPrices) {
        // The first verification replaced the whole history, fresh through today: no tail to read.
        prices = verification.replacedPrices;
        lastPriceRefreshAt = this.nowInstant();
        lease.assertOwned();
        await this.cache.writeDailyPriceYears(
          security.id,
          prices,
          yearsInRange(target),
          hydrating,
        );
        republishStarts.push(target.from);
      } else if (refreshPrices) {
        const refreshed = await this.refreshPriceWithinLease(
          security,
          target,
          hydrating,
          lease,
          verification.state === "REFUSED_NOW",
        );
        prices = refreshed.prices;
        lastPriceRefreshAt = refreshed.lastPriceRefreshAt;
        rebuildStarts.push(refreshed.derivedRebuildStart);
        republishStarts.push(refreshed.republishFrom);
      }

      let lastFundamentalsRefreshAt = lockedManifest.lastFundamentalsRefreshAt;
      if (refreshFundamentals) {
        const refreshed = await this.refreshFundamentalsWithinLease(
          security,
          target,
          hydrating,
          lease,
        );
        lastFundamentalsRefreshAt = refreshed.lastFundamentalsRefreshAt;
        rebuildStarts.push(refreshed.derivedRebuildStart);
      }

      // Newly eligible fundamentals change intrinsic values even when prices did not move, so the
      // unified derived state is rebuilt from the earliest cause of this cycle and the affected
      // Redis years are republished once.
      const derivedRebuildStart = this.boundedRebuildStart(
        target,
        rebuildStarts,
      );
      if (derivedRebuildStart) {
        lease.assertOwned();
        await this.rebuildDailyDerivedState(
          security,
          target,
          prices,
          derivedRebuildStart,
          lease,
        );
      }
      const publishFrom = this.boundedRebuildStart(target, [
        derivedRebuildStart,
        ...republishStarts,
      ]);
      if (publishFrom) {
        lease.assertOwned();
        await this.publishDailyDerivedStateYears(
          security,
          publishFrom,
          target,
          hydrating,
        );
      }

      lease.assertOwned();
      if (
        !(await this.cache.completeHydration(
          hydrating,
          this.readyManifest(
            security,
            target,
            prices,
            lockedManifest.hydratedAt ?? this.nowInstant(),
            lastPriceRefreshAt,
            lastFundamentalsRefreshAt,
          ),
        ))
      ) {
        throw new Error("Stock cache hydration generation changed");
      }
    });
  }

  async getStockDetails(
    symbol: string,
    range?: DateRange,
  ): Promise<StockDetails> {
    const bounded = this.defaultRange(range);
    const preHydration = await this.getSecurity(symbol);
    // Stock Details asks for its own window. The one-year fallback below applies only when a
    // caller sends no range at all; neither path may reach for the whole backtest horizon.
    const load = this.loadTarget(preHydration, bounded);
    await this.ensureStockHydrated(preHydration, load);
    await this.ensureStockFresh(preHydration, load);
    // The first hydration enriches the catalog identity with profile-sync fields (CIK, ISIN,
    // IPO date, sector, ...). Re-resolving after hydration keeps the returned security and the
    // freshly read profile consistent; on the common READY path this is a cache read, not a
    // database query.
    const security = await this.getSecurity(symbol);
    const [profile, prices, dailyState, history] = await Promise.all([
      this.store.getProfile(security.id),
      this.readDailyPriceProjection(security, bounded),
      this.readDailyDerivedStateProjection(security, bounded),
      this.stockDetailsHistoryBounds(security),
    ]);
    return {
      security,
      ...(profile ? { profile } : {}),
      history,
      prices,
      technicals: dailyState.map(toDailyTechnical),
      intrinsicValues: toIntrinsicValuePoints(dailyState, {
        ...bounded,
        asOf: bounded.to,
      }),
      intrinsicValueBlends: toIntrinsicValueBlendPoints(dailyState, {
        ...bounded,
        asOf: bounded.to,
      }),
    };
  }

  /**
   * The read window one evaluation frame needs: the requested period plus its leading context.
   *
   * Two things are added ahead of the period. A Trigger needs the immediately preceding eligible
   * value, which {@link TRIGGER_CONTEXT_CALENDAR_DAYS} covers. An alternative-data metric needs its
   * whole lookback **inside the frame**, because the window is counted on the frame's own session
   * axis — so a 60-session lookback that was not widened for would make the first sixty sessions of
   * every calendar-year execution window NOT_EVALUABLE, not just the first sixty of the run.
   *
   * The session-to-calendar conversion is the same one the Monitor window uses, which is deliberately
   * generous: asking for slightly more calendar history costs a wider projection read, while asking
   * for too little silently shortens exactly the window the widening exists to guarantee.
   */
  private evaluationContextRange(
    period: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Required<DateRange> {
    const leadingSessions = requiredAlternativeDataLeadingSessions(operands);
    const calendarDays =
      TRIGGER_CONTEXT_CALENDAR_DAYS +
      (leadingSessions > 0 ? monitorWindowCalendarDays(leadingSessions) : 0);
    return { from: addDays(period.from, -calendarDays), to: period.to };
  }

  /**
   * Ingests the alternative-data domains a set of operands names, or does nothing when it names none.
   *
   * Silent when no loader is composed: a frame that references one of these operands without loaded
   * facts is refused by the projector, which is a much clearer failure than an ingest that quietly
   * did not happen.
   */
  private async ensureAlternativeDataIngested(
    security: Security,
    operands: readonly OperandKey[],
  ): Promise<void> {
    const domains = alternativeDataDomainsFor(operands);
    if (domains.length === 0 || !this.alternativeData) {
      return;
    }
    await this.alternativeData.ensureIngested(security, domains);
  }

  private async loadAlternativeDataFacts(
    security: Security,
    operands: readonly OperandKey[],
    context: Required<DateRange>,
    options: EvaluationFrameOptions,
  ): Promise<ReadonlyMap<OperandKey, AlternativeDataFacts> | undefined> {
    if (!this.alternativeData || alternativeDataDomainsFor(operands).length === 0) {
      return undefined;
    }
    return this.alternativeData.loadFacts({
      security,
      operands,
      from: context.from,
      to: context.to,
      ...(options.resolveGroupMembers
        ? { resolveGroupMembers: options.resolveGroupMembers }
        : {}),
    });
  }

  /**
   * Reads the provider's split list into storage when the operands name a valuation ratio and the
   * stored list is older than {@link STOCK_SPLIT_LIST_FRESHNESS_MS}, or does nothing.
   *
   * Called in the preparation phases only, as alternative data is, so every later read is a
   * projection that reaches no provider.
   */
  private async ensureValuationInputsIngested(
    security: Security,
    operands: readonly OperandKey[],
  ): Promise<void> {
    if (!namesValuationRatio(operands)) {
      return;
    }
    await this.ensureStockSplitListFresh(security);
  }

  /**
   * The provider's split list into storage when the stored one is older than
   * {@link STOCK_SPLIT_LIST_FRESHNESS_MS}, or nothing: one dataset-state read when it is fresh.
   */
  private async ensureStockSplitListFresh(security: Security): Promise<void> {
    const state = await this.store.getDatasetState(
      security.id,
      "STOCK_SPLIT",
      "",
    );
    if (
      state?.lastSyncedAt !== undefined &&
      this.now().getTime() - Date.parse(state.lastSyncedAt) <
        STOCK_SPLIT_LIST_FRESHNESS_MS
    ) {
      return;
    }
    if (!this.provider.getStockSplits) {
      // A composition that offers valuation ratios must serve the list their rules read; projecting
      // them without it would silently mask nothing.
      throw new Error(
        "Valuation ratios need the provider's split list, which this composition does not serve",
      );
    }
    this.onProviderRequest({
      symbol: security.symbol,
      securityId: security.id,
      dataset: "STOCK_SPLIT",
      reason: "VALUATION_SPLIT_LIST",
    });
    const splits = await this.provider.getStockSplits(
      security.symbol,
      security.id,
    );
    await this.store.replaceStockSplits({
      securityId: security.id,
      splits,
      syncedAt: this.nowInstant(),
    });
  }

  /**
   * Everything a valuation ratio reads besides the closes, precomputed: the stored statement
   * revisions, the price basis and its measured re-bases, and the stored split list. Undefined when
   * no operand is a valuation ratio.
   */
  private async loadValuationTimeline(
    security: Security,
    operands: readonly OperandKey[],
  ): Promise<ValuationTimeline | undefined> {
    return namesValuationRatio(operands)
      ? this.readValuationTimeline(security)
      : undefined;
  }

  /** {@link loadValuationTimeline} for a read that names a ratio by its identity, not by operand. */
  private async readValuationTimeline(
    security: Security,
  ): Promise<ValuationTimeline> {
    const retention = this.fundamentalsTarget(security);
    const [statements, basis, events, splits] = await Promise.all([
      // Standalone quarters only: no ratio reads an annual row.
      this.store.getFinancialStatementRevisions({
        securityId: security.id,
        cadence: "QUARTERLY",
        from: retention.from,
        to: retention.to,
      }),
      this.store.getPriceBasis(security.id),
      this.store.getPriceBasisEvents(security.id),
      this.store.getStockSplits(security.id),
    ]);
    return buildValuationTimeline({
      securityId: security.id,
      currency: security.currency,
      statements,
      verifiedAt: basis?.verifiedAt ?? null,
      events,
      splits,
    });
  }

  async getDailyPrices(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    const load = this.loadTarget(security, bounded);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    return this.readDailyPriceProjection(security, bounded);
  }

  /** Canonical daily derived read used by Stock Details projections and future backtests. */
  async getDailyDerivedState(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    const load = this.loadTarget(security, bounded);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    return this.readDailyDerivedStateProjection(security, bounded);
  }

  /**
   * Projects one security into the columnar evaluation frame the backtest engine consumes.
   *
   * `Security`-keyed rather than symbol-keyed: a backtest already holds resolved securities from its
   * immutable snapshot, and re-resolving a symbol per read would be pure overhead — and symbol is
   * never durable identity anyway.
   *
   * The frame starts a few calendar days **before** the requested period so a Trigger has its
   * `t - 1` value on the very first simulated day; `periodStartIndex` marks where the period
   * actually begins, and nothing before it may produce an action. Those context rows cost nothing
   * to materialize because `loadTarget` already widens the load by the derived-series warm-up.
   */
  async getDailyEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
    options: EvaluationFrameOptions = {},
  ): Promise<EvaluationFrame> {
    const period = this.requireBoundedRange(range);
    const context = this.evaluationContextRange(period, operands);
    const load = this.loadTarget(security, context);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    await this.ensureAlternativeDataIngested(security, operands);
    await this.ensureValuationInputsIngested(security, operands);
    const [prices, derived, alternativeData, valuation] = await Promise.all([
      this.readDailyPriceProjection(security, context, "BACKTEST"),
      this.readDailyDerivedStateProjection(security, context, "BACKTEST"),
      this.loadAlternativeDataFacts(security, operands, context, options),
      options.valuation ?? this.loadValuationTimeline(security, operands),
    ]);
    return projectEvaluationFrame({
      security,
      prices,
      derived,
      operands,
      periodStart: period.from,
      alternativeData,
      ...(valuation ? { valuation: { timeline: valuation } } : {}),
    }).frame;
  }

  /**
   * PREPARING_DATA — makes everything a backtest reads over its **whole** period resident, once.
   *
   * Canonical hydration stays deliberately broad here: full price history, fundamentals, intrinsic
   * values, blends and every materialized derived series, under the existing warm-up, PIT,
   * revision, freshness and coverage rules. It is **not** narrowed to one year and **not** narrowed
   * to the operands one Strategy happens to name, because that is durable canonical state shared
   * with Stock Details and with every other run — see
   * `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md`.
   *
   * What the calendar-year windows change is the *read* that follows, not this load. Doing the
   * whole run's hydration and freshness check once is exactly what lets
   * {@link readDailyEvaluationFrame} stay off the provider for every subsequent year: the manifest
   * then already covers each window, so `ensureStockHydrated` short-circuits and the freshness
   * watermark is current.
   *
   * Returns the persisted coverage inside the requested period so a caller can tell a security with
   * no usable history from one that simply has not listed yet — without projecting the period it is
   * trying not to hold in memory.
   */
  async prepareDailyEvaluationData(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[] = [],
  ): Promise<PreparedDailyEvaluationData | null> {
    const period = this.requireBoundedRange(range);
    const context = this.evaluationContextRange(period, operands);
    const load = this.loadTarget(security, context);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    // The alternative-data domains the strategy names are ingested here, in the same phase and for
    // the same reason price history is: once per security per run, so every later window read is a
    // pure projection that reaches no provider. So is the split list a valuation ratio reads.
    await this.ensureAlternativeDataIngested(security, operands);
    await this.ensureValuationInputsIngested(security, operands);
    const projection = this.projectionRange(security, period, "BACKTEST");
    const bounds = projection
      ? await this.store.getDailyPriceBounds(security.id, projection)
      : null;
    if (!bounds) {
      return null;
    }
    // The generation first: inputs computed after a replacement it predates belong to a run that
    // every window read then refuses, never to one that reads them on the old basis.
    const priceBasisGeneration = await this.priceBasisGeneration(security.id);
    // Computed once, from the generation the run pins, and read by every window.
    const valuation = await this.loadValuationTimeline(security, operands);
    return {
      ...bounds,
      priceBasisGeneration,
      ...(valuation ? { valuation } : {}),
    };
  }

  /**
   * RUNNING — projects one already-prepared window without re-entering hydration.
   *
   * The counterpart of {@link prepareDailyEvaluationData}, and the read a calendar-year execution
   * window makes. It deliberately does **not** call `ensureStockHydrated` or `ensureStockFresh`:
   * those were done once for the whole period before the first year was simulated, and calling them
   * per year would make a thirty-year run ask the same freshness question thirty times.
   *
   * Redis is still disposable underneath. A missing year chunk is repaired by the projection reads
   * themselves, which rebuild it from PostgreSQL's durable coverage — and reach the provider only
   * where PostgreSQL genuinely has no coverage, which is the same rule every other read follows.
   *
   * The window is widened by the same leading context every frame gets, so the first date of a
   * window has a `t - 1` value where the security traded recently. Correctness across a year
   * boundary does not depend on it: `@intrinsic/strategy` carries the preceding eligible row itself,
   * which is what makes a Trigger right even when the previous session was months earlier.
   */
  async readDailyEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
    options: EvaluationFrameOptions = {},
  ): Promise<EvaluationFrame> {
    const period = this.requireBoundedRange(range);
    const context = this.evaluationContextRange(period, operands);
    // The generation the rows must belong to: the run's pin, or, for an unpinned read, the one in
    // force as it starts. A replacement commits in PostgreSQL before anything of it is published and
    // generations only grow, so the generation still matching after the reads proves the prices and
    // the derived rows below were read on that one basis.
    const expected =
      options.priceBasisGeneration !== undefined
        ? options.priceBasisGeneration
        : await this.priceBasisGeneration(security.id);
    const [prices, derived, alternativeData, valuation] = await Promise.all([
      this.readDailyPriceProjection(security, context, "BACKTEST"),
      this.readDailyDerivedStateProjection(security, context, "BACKTEST"),
      // Reads only; `prepareDailyEvaluationData` already ingested, exactly as it already hydrated.
      this.loadAlternativeDataFacts(security, operands, context, options),
      // The prepared inputs when the run passes them, so a window never reads the statements again.
      options.valuation ?? this.loadValuationTimeline(security, operands),
    ]);
    const current = await this.priceBasisGeneration(security.id);
    if (current !== expected) {
      throw new PriceBasisChangedError(
        security.id,
        security.symbol,
        expected,
        current,
      );
    }
    return projectEvaluationFrame({
      security,
      prices,
      derived,
      operands,
      periodStart: period.from,
      alternativeData,
      ...(valuation ? { valuation: { timeline: valuation } } : {}),
    }).frame;
  }

  /**
   * Everything one Monitor evaluation cycle needs for one security, read **once**.
   *
   * The cycle calls this per symbol, never per Monitor: `operands` is already the union of every
   * operand the Monitors watching this security reference, so several Monitors sharing NVDA share
   * one hydration, one projection read and one series computation
   * (`ai/architecture/monitor-engine.md`).
   *
   * The window is `observations` closed trading days, derived by the caller from the canonical
   * series definitions of the operands actually required. It is requested in calendar days with a
   * trading-day margin, because durable storage is addressed by date; asking for slightly more
   * calendar history than needed costs a wider projection read and nothing else, while asking for
   * too little would silently shorten a series' warm-up.
   *
   * Hydration and freshness run here exactly as a backtest's PREPARING_DATA phase runs them, so a
   * monitored security's history is loaded and refreshed through the one canonical path rather
   * than by a Monitor-specific loader.
   */
  async prepareMonitorEvaluationData(
    security: Security,
    observations: number,
    asOf: LocalDate,
    operands: readonly OperandKey[] = [],
  ): Promise<void> {
    const window = this.monitorWindowRange(observations, asOf);
    const load = this.loadTarget(security, window);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    // Ingested here, in the cycle's own preparation phase, so the read below reaches no provider and
    // several Monitors sharing a symbol share one ingest.
    await this.ensureAlternativeDataIngested(security, operands);
    await this.ensureValuationInputsIngested(security, operands);
  }

  /**
   * Projects the prepared window without re-entering hydration.
   *
   * The counterpart of {@link prepareMonitorEvaluationData}, and deliberately separate for the same
   * reason {@link readDailyEvaluationFrame} is: the freshness question is asked once per security
   * per cycle, not once per read.
   *
   * Derived state is read only over a short recent tail, anchored on the newest closed trading day.
   * The Monitor evaluates exactly one index, so the only persisted derived row it needs is the
   * newest closed one — whose weekly and intrinsic values are carried forward onto the provisional
   * observation. Reading the whole window of derived rows would cost thousands of rows per security
   * per cycle to supply columns nothing ever reads.
   */
  async readMonitorEvaluationFrame(input: {
    security: Security;
    operands: readonly OperandKey[];
    observations: number;
    asOf: LocalDate;
    observation: CurrentObservation | null;
    observationDate: LocalDate;
  }): Promise<MonitorEvaluationFrame | null> {
    const window = this.monitorWindowRange(input.observations, input.asOf);
    // Prices come from the Redis projection and the derived tail from PostgreSQL. The generation is
    // read on both sides of them: a replacement committed in between would pair one basis's prices
    // with another's indicators, and a Signal from such a frame would be permanent (§9).
    const generationBefore = await this.priceBasisGeneration(input.security.id);
    const prices = (
      await this.readDailyPriceProjection(input.security, window, "BACKTEST")
    ).slice(-input.observations);

    // The derived tail is anchored on the newest CLOSED trading day rather than on today, so a
    // security whose last session was a while ago still carries its weekly and intrinsic state
    // forward instead of silently losing it to an empty window.
    const newestClosed = prices[prices.length - 1]?.date;
    const derived = newestClosed
      ? // Read straight from durable storage rather than through the cached projection.
        // `prepareMonitorEvaluationData` has already hydrated and freshness-checked this window, so
        // the rows are authoritative — and the projection treats an empty result as a cache miss,
        // which on a tail this narrow would invalidate the manifest and re-hydrate the security on
        // every single cycle.
        await this.store.getDailyDerivedState(input.security.id, {
          from: addDays(newestClosed, -this.recentTailCalendarDays),
          to: newestClosed,
        })
      : [];

    const alternativeData = await this.loadAlternativeDataFacts(
      input.security,
      input.operands,
      // The whole projected window, so a lookback that reaches behind the newest closed session is
      // counted from the same rows the frame carries.
      { from: prices[0]?.date ?? input.observationDate, to: input.observationDate },
      {},
    );
    // Read inside the bracket too: the measured re-bases are part of the basis the frame is on.
    const valuation = await this.loadValuationTimeline(
      input.security,
      input.operands,
    );
    if (
      (await this.priceBasisGeneration(input.security.id)) !== generationBefore
    ) {
      return null;
    }

    return projectMonitorEvaluationFrame({
      security: input.security,
      prices,
      derived,
      operands: input.operands,
      observation: input.observation,
      observationDate: input.observationDate,
      ...(alternativeData ? { alternativeData } : {}),
      ...(valuation ? { valuation } : {}),
    });
  }

  /**
   * The first session a backtest of this security could replay: the product horizon, clamped to a
   * known listing date. A Monitor reconstruction whose history read starts here is a replay of the
   * security's whole canonical history.
   */
  evaluationHistoryStart(security: Security): LocalDate {
    return this.productTarget(security).from;
  }

  /** Catalog rows for a set of internal ids. One read for a whole Monitor cycle's universe. */
  async findSecuritiesByIds(
    securityIds: readonly SecurityId[],
  ): Promise<Security[]> {
    return this.store.findSecuritiesByIds(securityIds);
  }

  /**
   * Current market snapshots for many symbols, in as few provider requests as possible.
   *
   * One call per cycle for the whole monitored universe, not one per Monitor and not one per
   * symbol. Results are keyed by the canonical `Security` id, so a caller never carries a provider
   * symbol across a boundary. A symbol the provider could not price is simply absent.
   */
  async getCurrentObservations(
    securities: readonly Security[],
  ): Promise<Map<SecurityId, CurrentObservation>> {
    const observations = new Map<SecurityId, CurrentObservation>();
    if (securities.length === 0) {
      return observations;
    }
    if (!this.provider.getCurrentQuotes) {
      // Current quotes are an optional provider capability, so every existing caller and test
      // double keeps working without one. A Monitor cycle genuinely needs it, and silently
      // returning nothing would make a composition-root mistake look like a quiet market. This is
      // a wiring defect rather than bad caller input, so it is not a StockDataValidationError.
      throw new Error("This stock data provider cannot supply current quotes");
    }
    const bySymbol = new Map<string, Security>();
    for (const security of securities) {
      bySymbol.set(security.symbol.toUpperCase(), security);
    }

    // One batched request covers many securities, so the per-security correlation fields have no
    // value to carry. They are left empty rather than filled with a summary that would read like a
    // symbol and a security id to anything consuming them; the count goes in `detail`.
    this.onProviderRequest({
      dataset: "CURRENT_QUOTE",
      reason: "MONITOR_CURRENT_DATA",
      securityId: "",
      symbol: "",
      detail: `${bySymbol.size} symbols`,
    });
    const quotes = await this.provider.getCurrentQuotes([...bySymbol.keys()]);
    for (const quote of quotes) {
      const security = bySymbol.get(quote.providerSymbol.toUpperCase());
      if (!security) {
        continue;
      }
      observations.set(security.id, {
        price: quote.price,
        ...(quote.open === undefined ? {} : { open: quote.open }),
        ...(quote.dayHigh === undefined ? {} : { dayHigh: quote.dayHigh }),
        ...(quote.dayLow === undefined ? {} : { dayLow: quote.dayLow }),
        ...(quote.volume === undefined ? {} : { volume: quote.volume }),
        ...(quote.quotedAt === undefined ? {} : { quotedAt: quote.quotedAt }),
      });
    }
    return observations;
  }

  /**
   * The calendar range holding at least `observations` trading sessions back from `asOf`.
   *
   * Converted through {@link TRADING_DAYS_PER_YEAR} rather than through weekdays-per-week, because
   * the window is long enough for the holiday difference to matter: the caller trims the projection
   * to the exact observation count, so a range that yields too few sessions does not fail — it
   * quietly hands the calculators a shorter warm-up than they were sized for.
   */
  private monitorWindowRange(
    observations: number,
    asOf: LocalDate,
  ): Required<DateRange> {
    return {
      from: addDays(asOf, -monitorWindowCalendarDays(observations)),
      to: asOf,
    };
  }

  async getDailyTechnicals(symbol: string, range: DateRange) {
    return (await this.getDailyDerivedState(symbol, range)).map(
      toDailyTechnical,
    );
  }

  /**
   * One Fundamental Metric's daily history: its persisted `DailyDerivedState` field on every
   * trading day of the range, and nothing else.
   *
   * The derived state is read through exactly the path every Stock Details projection uses — the
   * canonical hydration and freshness checks, then the cached projection repaired from PostgreSQL —
   * so the value on a session is the value a backtest's evaluation frame reads for that session.
   * The identity is resolved to its storage field through the domain registry before anything is
   * loaded: an unknown identity is refused without touching a security, and no caller-supplied
   * string ever becomes a property name.
   *
   * Nothing is calculated here. No statement is read, no TTM window is assembled and no ratio is
   * formed; a session the metric is unavailable on keeps its point without a value, so absence
   * reaches the caller as absence.
   */
  async getDailyFundamentalMetric(
    symbol: string,
    metricId: FundamentalMetricId,
    range: DateRange,
  ): Promise<DailyFundamentalMetricPoint[]> {
    const field = fundamentalMetricField(metricId);
    return (await this.getDailyDerivedState(symbol, range)).map((row) =>
      toFundamentalMetricPoint(row, field),
    );
  }

  /**
   * One valuation ratio's daily history for the Stock Details chart: the ratio on every trading
   * session of the range, computed when it is read by the calculation a Strategy Condition, a
   * backtest and a Monitor read (`docs/decisions/valuation-ratios-v1.md`). Nothing is stored.
   *
   * The inputs are prepared the way an evaluation frame's are, and by the same helpers: the
   * canonical hydration and freshness checks, the provider's split list when the stored one is a day
   * old, and then — between two reads of the price-basis generation — the stored closes the price
   * chart draws and the valuation timeline built from the stored statements, measured re-bases and
   * split list. A replacement committed in between would pair one basis's closes with another's
   * re-bases, so the read is refused rather than answered from two bases, exactly as an unpinned
   * frame read is (`historical-price-basis-v1.md`, §9).
   *
   * Only the requested ratio is projected. A session it is unavailable on keeps its point without a
   * value, so absence reaches the caller as absence. The newest session is the newest stored bar,
   * read at its own close and statements — the bar the price chart draws and the row a backtest
   * frame reads, which during a session can be the provider's in-progress bar — never a live quote.
   */
  async getDailyValuationRatio(
    symbol: string,
    ratioId: ValuationRatioId,
    range: DateRange,
  ): Promise<DailyValuationRatioPoint[]> {
    // An exact catalog identity or nothing: refused before a security is resolved, so no
    // caller-supplied string reaches the calculation. The input is deliberately not echoed back.
    if (!isValuationRatioId(ratioId)) {
      throw new StockDataValidationError("Unsupported valuation ratio");
    }
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    const load = this.loadTarget(security, bounded);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    await this.ensureStockSplitListFresh(security);
    const expected = await this.priceBasisGeneration(security.id);
    const [prices, timeline] = await Promise.all([
      this.readDailyPriceProjection(security, bounded),
      this.readValuationTimeline(security),
    ]);
    const current = await this.priceBasisGeneration(security.id);
    if (current !== expected) {
      throw new PriceBasisChangedError(
        security.id,
        security.symbol,
        expected,
        current,
      );
    }
    const column = valuationRatioColumns({
      timeline,
      dates: prices.map((price) => price.date),
      closes: prices.map((price) => price.close),
      ratios: [ratioId],
    }).get(ratioId) as Float64Array;
    return prices.map((price, index) => {
      const value = column[index] as number;
      return Number.isFinite(value)
        ? { date: price.date, value }
        : { date: price.date };
    });
  }

  async getFinancialStatements(
    symbol: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    const bounded = this.boundFinancialQuery(security, query);
    if (bounded.from && bounded.to && bounded.from > bounded.to) {
      return [];
    }
    const load = this.loadTarget(security, {
      from: bounded.from ?? this.today(),
      to: bounded.to ?? this.today(),
    });
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    const observedManifest = await this.cache.getManifest(security.id);
    let cached = await this.cache.readFinancialStatements(security.id, bounded);
    if (cached) {
      return cached;
    }
    await this.cache.invalidateManifest(observedManifest);
    await this.ensureStockHydrated(security, load);
    cached = await this.cache.readFinancialStatements(security.id, bounded);
    return cached ?? this.store.getFinancialStatements(security.id, bounded);
  }

  async getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    const bounded = this.intrinsicReadRange(security, query);
    if (!bounded) {
      return [];
    }
    const load = this.loadTarget(security, bounded);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    return toIntrinsicValuePoints(
      await this.readDailyDerivedStateProjection(security, bounded),
      query,
    );
  }

  async getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    const bounded = this.intrinsicReadRange(security, query);
    if (!bounded) {
      return [];
    }
    const load = this.loadTarget(security, bounded);
    await this.ensureStockHydrated(security, load);
    await this.ensureStockFresh(security, load);
    return toIntrinsicValueBlendPoints(
      await this.readDailyDerivedStateProjection(security, bounded),
      query,
    );
  }

  /**
   * Fills in the per-stock profile the first time a catalog entry is hydrated.
   *
   * The bulk catalog synchronization carries identity only, so CIK, ISIN, CUSIP, IPO date, ADR
   * status and the descriptive profile arrive here, lazily, for a stock someone actually opened.
   * It runs once per security: a recorded `SECURITY_PROFILE` sync short-circuits every later
   * hydration.
   *
   * A provider that has no profile for a catalogued symbol is not fatal. The stock is supported
   * because the catalog says so, and its price and fundamental history is independent of whether
   * the descriptive profile happens to resolve.
   */
  private async hydrateSecurityProfileWithinLease(
    security: Security,
    lease: LoadLease,
  ): Promise<Security> {
    const state = await this.store.getDatasetState(
      security.id,
      "SECURITY_PROFILE",
      "",
    );
    if (state?.lastSyncedAt) {
      return security;
    }
    this.onProviderRequest({
      symbol: security.symbol,
      securityId: security.id,
      dataset: "SECURITY_PROFILE",
      reason: "PROFILE_SYNC",
    });
    const mapped = await this.provider.getProfile(security.symbol);
    if (!mapped) {
      return security;
    }
    lease.assertOwned();
    const saved = await this.store.saveSecurityProfile({
      securityId: security.id,
      mapped,
      syncedAt: this.nowInstant(),
    });
    lease.assertOwned();
    await this.cache.setSecurity(saved.security);
    return saved.security;
  }

  private async hydrateWithinLease(
    security: Security,
    required: Required<DateRange>,
    lease: LoadLease,
  ): Promise<void> {
    const afterLock = await this.cache.getManifest(security.id);
    if (this.covers(afterLock, required)) {
      return;
    }
    // Widening is incremental: whatever is already resident stays, and only the prefix the
    // caller newly needs is loaded on top of it.
    const target = this.maintainedTarget(required, afterLock);
    const hydrating = this.hydratingManifest(security, afterLock, target);
    lease.assertOwned();
    if (!(await this.cache.beginHydration(afterLock, hydrating))) {
      const current = await this.cache.getManifest(security.id);
      // Only a competing hydration that already covers this request settles it. One that
      // finished a narrower range leaves the prefix still missing, so this call must fail
      // rather than report a range it did not load.
      if (this.covers(current, required)) {
        return;
      }
      throw new Error("Stock cache hydration generation changed");
    }

    // No unconditional ownership check here: the profile step asserts around its own writes and
    // must not consume a lease check on the far more common path where there is nothing to save.
    // The enriched identity it returns is what this hydration publishes to the cache below; the
    // pre-hydration snapshot must never overwrite it, or every READY read would serve a security
    // that is missing its profile-sync fields.
    const hydratedSecurity = await this.hydrateSecurityProfileWithinLease(
      security,
      lease,
    );
    // Before anything is loaded beside the stored history, it is verified once against the
    // provider's (`historical-price-basis-v1.md`, §7, rule 1). A replacement re-establishes the
    // whole target's coverage, so the gaps read below are then none.
    const verification = await this.verifyPriceBasisWithinLease(
      security,
      target,
      lease,
    );

    const previousPriceState = await this.store.getDatasetState(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
    );
    const coverage = await this.store.getDatasetCoverage(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
      target,
    );
    const unsettledFrom = await this.unsettledTailStart(security, target);
    const missing = missingCoverageRanges(target, coverage).map((range) => {
      const bounded = this.requireBoundedRange(range);
      // A gap that extends the leading edge also re-reads what the previous sync fetched while it
      // was still unsettled; see `unsettledTailStart`.
      return unsettledFrom !== undefined && bounded.to >= target.to
        ? { from: minDate(bounded.from, unsettledFrom), to: bounded.to }
        : bounded;
    });
    const loaded = [];
    for (const delta of missing) {
      this.onProviderRequest({
        symbol: security.symbol,
        securityId: security.id,
        dataset: "DAILY_PRICE",
        reason: "MISSING_COVERAGE",
        from: delta.from,
        to: delta.to,
      });
      loaded.push(
        ...(await this.provider.getDailyPrices(
          security.symbol,
          security.id,
          delta,
        )),
      );
    }
    lease.assertOwned();
    let priceChange: { earliestChangedDate?: string } = {};
    if (missing.length > 0) {
      // Rows loaded beside a stored history are saved only once its earliest row confirms the
      // provider has not re-based it since (§7, rule 2). A widening after a re-base would otherwise
      // put a new-basis prefix beside old-basis rows. A history verified in this very cycle needs
      // no second look; one whose whole read was refused in it gets the look but no second whole
      // read, and nothing is saved when the look finds it re-based.
      const newestStored = await this.newestStoredPrice(security.id, target);
      const loadedDates = loaded.map((row) => row.date).sort();
      const rebased =
        newestStored !== undefined &&
        verification.state !== "VERIFIED_NOW" &&
        loadedDates.length > 0 &&
        changesStoredRows(
          await this.store.getDailyPrices(security.id, {
            from: loadedDates[0] as string,
            to: loadedDates.at(-1) as string,
          }),
          loaded,
        ) &&
        !(await this.earliestStoredRowUnchanged(security));
      const replacement =
        rebased && verification.state === "VERIFIED_EARLIER"
          ? await this.replacePriceHistoryWithinLease(
              security,
              target,
              lease,
              verification.basis,
              "PRICE_REBASE",
            )
          : undefined;
      if (replacement?.outcome === "UNCHANGED") {
        this.onPriceBasisEvent({
          securityId: security.id,
          symbol: security.symbol,
          outcome: "EARLIEST_ROW_UNCONFIRMED",
        });
      }
      const blocked =
        (rebased && verification.state === "REFUSED_NOW") ||
        replacement?.outcome === "REFUSED" ||
        replacement?.outcome === "REPLACED";
      if (!blocked) {
        const hold = this.applyExDateHold(security, newestStored, loaded);
        const successfulCoverage =
          hold.heldFrom === undefined
            ? missing
            : missing
                .filter((range) => range.from < (hold.heldFrom as string))
                .map((range) =>
                  range.to >= (hold.heldFrom as string)
                    ? {
                        from: range.from,
                        to: addDays(hold.heldFrom as string, -1),
                      }
                    : range,
                );
        priceChange = await this.store.saveDailyPriceSync({
          securityId: security.id,
          prices: hold.rows,
          successfulCoverage,
          syncedAt: this.nowInstant(),
          tailDate: target.to,
          ...(hold.heldFrom === undefined &&
          missing.some(
            (range) => range.from <= target.to && range.to >= target.to,
          )
            ? { freshThrough: target.to }
            : {}),
          assertOwned: lease.assertOwned,
        });
      }
    }
    lease.assertOwned();

    const prices = await this.store.getDailyPrices(security.id, target);
    // Fundamentals are hydrated before the derived rebuild so READY always means the persisted
    // derived state already reflects both price history and point-in-time fundamentals. Building
    // intrinsic values first and never rebuilding them would publish a permanently empty
    // intrinsic history.
    const fundamentals = await this.hydrateFundamentalsWithinLease(
      security,
      target,
      hydrating,
      lease,
    );
    lease.assertOwned();
    // A methodology change bumps DERIVED_STATE_REVISION, which changes the dataset variant. The
    // previous variant then reports no coverage, so the whole state is rebuilt and replaced rather
    // than kept alongside the old methodology.
    const derivedCoverage = await this.store.getDatasetCoverage(
      security.id,
      "DAILY_DERIVED_STATE",
      DAILY_DERIVED_STATE_VARIANT,
      target,
    );
    const derivedCoverageGaps = missingCoverageRanges(target, derivedCoverage);
    const derivedRepairStart = derivedCoverageGaps[0]?.from;
    const priceRecalculationStart = priceChange.earliestChangedDate
      ? this.recalculationStart(
          target,
          previousPriceState,
          priceChange.earliestChangedDate,
          undefined,
        )
      : undefined;
    const derivedRecalculationStart = this.boundedRebuildStart(target, [
      derivedRepairStart,
      derivedRepairStart ? undefined : priceRecalculationStart,
      fundamentals.derivedRebuildStart,
    ]);
    if (derivedRecalculationStart) {
      lease.assertOwned();
      await this.rebuildDailyDerivedState(
        security,
        target,
        prices,
        derivedRecalculationStart,
        lease,
      );
    }

    const [persistedDerivedState, tailRefreshAt] = await Promise.all([
      this.store.getDailyDerivedState(security.id, target),
      this.store.getLatestCoverageSyncContainingDate(
        security.id,
        "DAILY_PRICE",
        DAILY_PRICE_VARIANT,
        target.to,
      ),
    ]);
    lease.assertOwned();
    const years = yearsInRange(target);
    await this.cache.setSecurity(hydratedSecurity, hydrating);
    await this.cache.writeDailyPriceYears(
      security.id,
      prices,
      years,
      hydrating,
    );
    await this.cache.writeDailyDerivedStateYears(
      security.id,
      persistedDerivedState,
      years,
      hydrating,
    );
    lease.assertOwned();
    if (
      !(await this.cache.completeHydration(
        hydrating,
        this.readyManifest(
          security,
          target,
          prices,
          this.nowInstant(),
          tailRefreshAt ?? undefined,
          fundamentals.lastFundamentalsRefreshAt,
        ),
      ))
    ) {
      throw new Error("Stock cache hydration generation changed");
    }
  }

  private async readDailyPriceProjection(
    security: Security,
    requested: Required<DateRange>,
    bound: "PRODUCT" | "BACKTEST" = "PRODUCT",
  ) {
    const projection = this.projectionRange(security, requested, bound);
    if (!projection) {
      return [];
    }
    const observedManifest = await this.cache.getManifest(security.id);
    let result = await this.cache.readDailyPrices(security.id, projection);
    if (result) {
      return result;
    }
    await this.cache.invalidateManifest(observedManifest);
    // Repairing a cache miss must not shrink the stock: the range the invalidated manifest was
    // holding is rebuilt alongside the one this read needs.
    await this.ensureStockHydrated(
      security,
      this.maintainedTarget(
        this.loadTarget(security, projection),
        observedManifest,
      ),
    );
    result = await this.cache.readDailyPrices(security.id, projection);
    return result ?? this.store.getDailyPrices(security.id, projection);
  }

  private async readDailyDerivedStateProjection(
    security: Security,
    requested: Required<DateRange>,
    bound: "PRODUCT" | "BACKTEST" = "PRODUCT",
  ): Promise<DailyDerivedState[]> {
    const projection = this.projectionRange(security, requested, bound);
    if (!projection) {
      return [];
    }
    const observedManifest = await this.cache.getManifest(security.id);
    let result = await this.cache.readDailyDerivedState(
      security.id,
      projection,
    );
    if (result && result.length > 0) {
      return result;
    }
    await this.cache.invalidateManifest(observedManifest);
    await this.ensureStockHydrated(
      security,
      this.maintainedTarget(
        this.loadTarget(security, projection),
        observedManifest,
      ),
    );
    result = await this.cache.readDailyDerivedState(security.id, projection);
    if (result && result.length > 0) {
      return result;
    }
    return this.store.getDailyDerivedState(security.id, projection);
  }

  /**
   * Bounds an intrinsic-value query to a readable range.
   *
   * `asOf` narrows the upper bound: no trading day after the requested point in time may be
   * returned. It is only the row-level bound; per-model and per-blend provenance is then applied
   * independently during projection, so a later-sourced model is withheld while an earlier-sourced
   * model on the same row is still returned.
   */
  private intrinsicReadRange(
    security: Security,
    query: DateRange & { asOf?: string },
  ): Required<DateRange> | null {
    const target = this.productTarget(security);
    const to = minOptionalDate(
      minOptionalDate(query.to, query.asOf) ?? target.to,
      target.to,
    );
    const from = query.from ? maxDate(query.from, target.from) : target.from;
    if (!to || from > to) {
      return null;
    }
    return { from, to };
  }

  /**
   * Backfills missing fundamentals datasets and reports whether the derived state must be rebuilt.
   *
   * A first backfill makes statements point-in-time eligible for the whole canonical history, so
   * the intrinsic state has to be rebuilt from the start of the target range rather than only from
   * a price-change boundary.
   */
  private async hydrateFundamentalsWithinLease(
    security: Security,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<{
    lastFundamentalsRefreshAt: string | undefined;
    derivedRebuildStart: string | undefined;
  }> {
    const expected = this.fundamentalsOperationsForHistory();
    const currentStates = await Promise.all(
      expected.map((operation) =>
        this.store.getDatasetState(
          security.id,
          operation.dataset,
          operation.variant,
        ),
      ),
    );
    const missing = expected.filter((_, index) => !currentStates[index]);
    // A first backfill lands the whole persisted statement history at once, so its earliest
    // availability is effectively the start of the canonical range.
    let derivedRebuildStart: string | undefined;
    if (missing.length > 0) {
      const results = await this.runFundamentalsOperationsToSettlement(
        missing,
        (operation) =>
          this.syncFundamentalsOperation({
            security,
            operation,
            limit: this.fundamentalsBackfillLimit(operation.cadence),
            lease,
          }),
      );
      if (results.some((result) => result.changedYears.length > 0)) {
        derivedRebuildStart = target.from;
      }
    }
    lease.assertOwned();
    const states = await Promise.all(
      expected.map((operation) =>
        this.store.getDatasetState(
          security.id,
          operation.dataset,
          operation.variant,
        ),
      ),
    );
    if (states.some((state) => !state)) {
      throw new Error("Fundamentals hydration is incomplete");
    }

    await this.publishAllFundamentalsYears(
      security.id,
      this.fundamentalsTarget(security),
      hydrating,
      lease,
    );
    return {
      lastFundamentalsRefreshAt: this.oldestRequiredSyncAt(states),
      derivedRebuildStart,
    };
  }

  /**
   * Earliest of the supplied rebuild starts, clamped to the canonical target range.
   *
   * Several causes (a coverage gap, changed prices, newly eligible fundamentals) can require a
   * rebuild in the same cycle; the unified state is rebuilt once from the earliest of them.
   */
  private boundedRebuildStart(
    target: Required<DateRange>,
    candidates: readonly (string | undefined)[],
  ): string | undefined {
    let earliest: string | undefined;
    for (const candidate of candidates) {
      if (!candidate || candidate > target.to) {
        continue;
      }
      const clamped = maxDate(candidate, target.from);
      earliest = earliest === undefined ? clamped : minDate(earliest, clamped);
    }
    return earliest;
  }

  /**
   * Recalculates and replaces the unified daily derived state from `from` through the target end.
   *
   * Full price history is used so moving-average warm-up, completed-week carry-forward and
   * intrinsic-value carry-forward are all correct at the rebuild boundary, then only the affected
   * trading days are written. Persisting replaces those rows: there is one current methodology per
   * `(securityId, date)` and no version history.
   */
  private async rebuildDailyDerivedState(
    security: Security,
    target: Required<DateRange>,
    prices: readonly DailyPrice[],
    from: string,
    lease: LoadLease,
  ): Promise<DailyDerivedState[]> {
    // The canonical calculation window: every bar this security has, not the window the caller
    // happened to ask for. `movingAverage` seeds an EMA from the first complete window of the
    // series it is given and Wilder's RSI from the first `period` changes of it, so both carry the
    // start of the series in every later value. Calculating over a load window whose start moves
    // with the clock therefore made consecutive rebuilds disagree about rows they both wrote
    // (AUD-02). Anchoring on the earliest persisted bar makes the stored series a pure function of
    // the stored prices: it moves only when an earlier bar actually arrives, and the backfill that
    // brings one reports it as the earliest changed date, which rebuilds from there.
    const calculation = await this.calculationPrices(security, target, prices);
    const derived = await this.computeDailyDerivedState(
      security,
      target,
      calculation,
      await this.store.getPriceBasisEvents(security.id),
    );
    const rows = derived.rows.filter((row) => row.date >= from);
    const weeklyDelta = derived.weeklyBars.filter(
      (bar) => bar.weekStartDate >= startOfIsoWeek(from),
    );
    if (rows.length === 0 && weeklyDelta.length === 0) {
      return rows;
    }
    lease.assertOwned();
    await this.store.saveDailyDerivedState({
      securityId: security.id,
      rows,
      weeklyPrices: weeklyDelta,
      successfulCoverage: { from, to: target.to },
      syncedAt: this.nowInstant(),
      assertOwned: lease.assertOwned,
    });
    return rows;
  }

  /**
   * The unified daily derived state of a calculation window, in memory: the price indicators, the
   * completed weeks, and the statement-derived families from one read of every retained revision.
   *
   * Intrinsic and Fundamental Metrics materialization deliberately run over the full canonical
   * trading-date history and every retained statement revision: starting either at the rebuild's
   * first date would lose the statement-event and carry-forward context that establishes the
   * correct opening state. Revisions from the fundamentals warm-up years are read as well, so the
   * first visible trading day can already have a TTM window, an eight-quarter growth chain and real
   * growth endpoints — but trading dates still come only from the price history, so no derived row
   * is created before the canonical target.
   *
   * Both statement-derived families come from the one revision read below and land on the same
   * rows, so a newly eligible revision moves intrinsic values and Fundamental Metrics together, on
   * the same session. Intrinsic values are then put on the research scale of these prices by the
   * measured re-bases (`historical-price-basis-v1.md`, §10): unchanged when there are none.
   */
  private async computeDailyDerivedState(
    security: Security,
    target: Required<DateRange>,
    calculation: { prices: readonly DailyPrice[]; range: Required<DateRange> },
    events: readonly PriceBasisEvent[],
  ) {
    const weeklyBars = aggregateCompletedWeeks(
      calculation.prices,
      target.to,
      this.weeklyHistoryContext(
        security,
        calculation.prices[0]?.date ?? calculation.range.from,
      ),
    );
    // One bounded read of immutable revisions, not the latest-revision selector: each materializer
    // needs every revision's own availableFromDate as a distinct evaluation event. The same read
    // feeds both statement-derived families; nothing below reads statements per metric or per day.
    const retention = this.fundamentalsTarget(security);
    const statements = await this.store.getFinancialStatementRevisions({
      securityId: security.id,
      from: retention.from,
      to: retention.to,
    });
    const tradingDates = calculation.prices.map((price) => price.date);
    const fundamentalStates = materializeDailyFundamentals({
      securityId: security.id,
      tradingDates,
      statements,
    });
    const intrinsicStates = applyPriceBasisToIntrinsicStates(
      materializeDailyIntrinsicValues({
        securityId: security.id,
        tradingDates,
        statements,
      }),
      { securityId: security.id, statements, events },
    );
    const rows = buildDailyDerivedState({
      prices: calculation.prices,
      weeklyBars,
      fundamentalStates,
      intrinsicStates,
    });
    return { rows, weeklyBars };
  }

  /**
   * The bars a derived rebuild calculates from, and the range they cover.
   *
   * `prices` is what the caller already loaded for its own window. When the security has older
   * persisted bars than that, they are read as well: the series' start is part of every recursive
   * value, so it must be a property of the stored data rather than of the request that triggered
   * the rebuild. One read of at most the retained history, on a path that is already writing
   * thousands of rows.
   */
  private async calculationPrices(
    security: Security,
    target: Required<DateRange>,
    prices: readonly DailyPrice[],
  ): Promise<{ prices: readonly DailyPrice[]; range: Required<DateRange> }> {
    const bounds = await this.store.getDailyPriceBounds(security.id, {
      from: EARLIEST_PERSISTED_PRICE_DATE,
      to: target.to,
    });
    const earliest = bounds?.firstDate;
    if (!earliest || earliest >= target.from) {
      return { prices, range: target };
    }
    const range = { from: earliest, to: target.to };
    return {
      prices: await this.store.getDailyPrices(security.id, range),
      range,
    };
  }

  /**
   * Republishes every Redis yearly chunk touched by a partial derived rebuild.
   *
   * A rebuild may start mid-year, but a yearly chunk is replaced wholesale. Publishing only the
   * rebuilt tail would silently drop the earlier months of that year from the cache, so the
   * complete affected years are re-read from PostgreSQL — the durable source of truth — after the
   * derived-state write and published in full.
   */
  private async publishDailyDerivedStateYears(
    security: Security,
    from: string,
    target: Required<DateRange>,
    hydrating: StockManifest,
  ): Promise<void> {
    const affectedRange = yearBoundedRange(from, target.to);
    const complete = await this.store.getDailyDerivedState(
      security.id,
      affectedRange,
    );
    await this.cache.writeDailyDerivedStateYears(
      security.id,
      complete,
      yearsInRange(affectedRange),
      hydrating,
    );
  }

  /**
   * The first verification of a security's stored price history
   * (`docs/decisions/historical-price-basis-v1.md`, §7, rule 1).
   *
   * Once per security, the first time it is hydrated or refreshed by this loader. A security with no
   * stored price is verified as it is. Otherwise its whole stored history is read again and compared:
   * equal, it is recorded as verified; different, it is replaced. That also repairs a history mixed
   * before this check existed — a tail refreshed after a split, or a prefix widened after one —
   * which no single-row check can see. A replacement the comparison refuses leaves the security
   * unverified, and the next cycle tries again.
   *
   * Must run under the stock's lease and inside a `HYDRATING` manifest, so a replacement is never
   * visible half-published.
   */
  private async verifyPriceBasisWithinLease(
    security: Security,
    target: Required<DateRange>,
    lease: LoadLease,
  ): Promise<{
    basis: SecurityPriceBasisState | null;
    replacedPrices: DailyPrice[] | null;
    /**
     * `VERIFIED_NOW` when this call compared or created the basis, so nothing in the same cycle
     * checks again; `REFUSED_NOW` when its whole read was refused, so nothing is saved beside the
     * history this cycle unchecked and no second whole read is made; `VERIFIED_EARLIER` otherwise.
     */
    state: "VERIFIED_NOW" | "REFUSED_NOW" | "VERIFIED_EARLIER";
  }> {
    const existing = await this.store.getPriceBasis(security.id);
    if (existing) {
      return {
        basis: existing,
        replacedPrices: null,
        state: "VERIFIED_EARLIER",
      };
    }
    if ((await this.store.getEarliestDailyPriceDate(security.id)) === null) {
      lease.assertOwned();
      return {
        basis: await this.store.createPriceBasis({
          securityId: security.id,
          verifiedAt: this.nowInstant(),
        }),
        replacedPrices: null,
        state: "VERIFIED_NOW",
      };
    }
    const result = await this.replacePriceHistoryWithinLease(
      security,
      target,
      lease,
      null,
      "PRICE_BASIS_VERIFICATION",
    );
    if (result.outcome === "REPLACED") {
      return {
        basis: result.basis,
        replacedPrices: result.prices,
        state: "VERIFIED_NOW",
      };
    }
    if (result.outcome === "REFUSED") {
      return { basis: null, replacedPrices: null, state: "REFUSED_NOW" };
    }
    lease.assertOwned();
    const basis = await this.store.createPriceBasis({
      securityId: security.id,
      verifiedAt: this.nowInstant(),
    });
    this.onPriceBasisEvent({
      securityId: security.id,
      symbol: security.symbol,
      outcome: "VERIFIED",
      generation: basis.generation,
      detail: `${result.comparedSessions} sessions compared`,
    });
    return { basis, replacedPrices: null, state: "VERIFIED_NOW" };
  }

  /**
   * The security's price-basis generation: 0 until its stored history is first replaced, whether it
   * has been verified or not, since a verification that replaces nothing changes no row (§9).
   */
  private async priceBasisGeneration(securityId: string): Promise<number> {
    return (await this.store.getPriceBasis(securityId))?.generation ?? 0;
  }

  /** The newest stored price row up to the target's end, if any. */
  private async newestStoredPrice(
    securityId: string,
    target: Required<DateRange>,
  ): Promise<DailyPrice | undefined> {
    const bounds = await this.store.getDailyPriceBounds(securityId, {
      from: EARLIEST_PERSISTED_PRICE_DATE,
      to: target.to,
    });
    if (!bounds) {
      return undefined;
    }
    const [row] = await this.store.getDailyPrices(securityId, {
      from: bounds.lastDate,
      to: bounds.lastDate,
    });
    return row;
  }

  /**
   * Whether the earliest stored rows still read as they were stored (§7, rule 2).
   *
   * A re-base rescales every row before its ex-date, so the earliest ones change whenever any
   * re-base happened, however long ago. Asked before rows are saved beside the stored history.
   * The earliest stored session the provider still returns is compared, from a short window at the
   * start of the stored history, so a provider that has dropped the very first row cannot blind the
   * check. A window with no session in common confirms nothing, and the caller compares the whole
   * history instead.
   */
  private async earliestStoredRowUnchanged(
    security: Security,
  ): Promise<boolean> {
    const earliest = await this.store.getEarliestDailyPriceDate(security.id);
    if (earliest === null) {
      return true;
    }
    const window = {
      from: earliest,
      to: addDays(earliest, EARLIEST_ROWS_WINDOW_CALENDAR_DAYS),
    };
    const stored = await this.store.getDailyPrices(security.id, window);
    this.onProviderRequest({
      symbol: security.symbol,
      securityId: security.id,
      dataset: "DAILY_PRICE",
      reason: "PRICE_BASIS_EARLIEST_ROW",
      from: window.from,
      to: window.to,
    });
    const fresh = new Map(
      (
        await this.provider.getDailyPrices(security.symbol, security.id, window)
      ).map((row) => [row.date, row.close]),
    );
    const compared = stored.find((row) => fresh.has(row.date));
    if (!compared) {
      return false;
    }
    return !closesDiffer(compared.close, fresh.get(compared.date) as number);
  }

  /**
   * Re-reads the whole history and, when it differs, replaces the stored one in one transaction
   * (§8–§9): prices, derived and weekly rows rebuilt from them, the measured re-bases, the next
   * generation. The caller republishes Redis; it holds a `HYDRATING` manifest throughout.
   *
   * Refused, and nothing written, when the provider no longer returns more than 1 % of the stored
   * sessions: the old history then stays, consistent with itself.
   */
  private async replacePriceHistoryWithinLease(
    security: Security,
    target: Required<DateRange>,
    lease: LoadLease,
    basis: SecurityPriceBasisState | null,
    reason: "PRICE_BASIS_VERIFICATION" | "PRICE_REBASE",
  ): Promise<
    | { outcome: "UNCHANGED"; comparedSessions: number }
    | { outcome: "REFUSED" }
    | {
        outcome: "REPLACED";
        basis: SecurityPriceBasisState;
        prices: DailyPrice[];
      }
  > {
    const started = performance.now();
    try {
      return await this.replacePriceHistoryTimed(
        security,
        target,
        lease,
        basis,
        reason,
        started,
      );
    } catch (err) {
      this.onPriceBasisEvent({
        securityId: security.id,
        symbol: security.symbol,
        outcome: "REPLACEMENT_FAILED",
        durationMs: Math.round(performance.now() - started),
        err,
        detail: reason,
      });
      throw err;
    }
  }

  private async replacePriceHistoryTimed(
    security: Security,
    target: Required<DateRange>,
    lease: LoadLease,
    basis: SecurityPriceBasisState | null,
    reason: "PRICE_BASIS_VERIFICATION" | "PRICE_REBASE",
    started: number,
  ): Promise<
    | { outcome: "UNCHANGED"; comparedSessions: number }
    | { outcome: "REFUSED" }
    | {
        outcome: "REPLACED";
        basis: SecurityPriceBasisState;
        prices: DailyPrice[];
      }
  > {
    const earliest = await this.store.getEarliestDailyPriceDate(security.id);
    const readRange = {
      from: earliest === null ? target.from : minDate(earliest, target.from),
      to: target.to,
    };
    this.onProviderRequest({
      symbol: security.symbol,
      securityId: security.id,
      dataset: "DAILY_PRICE",
      reason,
      from: readRange.from,
      to: readRange.to,
    });
    // Ascending, whatever order the provider answered in: the hold and the split below read it so.
    const fresh = (
      await this.provider.getDailyPrices(
        security.symbol,
        security.id,
        readRange,
      )
    ).sort((left, right) => left.date.localeCompare(right.date));
    const stored = await this.store.getDailyPrices(security.id, readRange);
    const detectedAt = this.nowInstant();
    const comparison = comparePriceHistories({
      securityId: security.id,
      generation: (basis?.generation ?? 0) + 1,
      detectedAt,
      stored,
      fresh,
    });
    // An answer missing more than 1 % of the stored sessions verifies nothing and replaces nothing:
    // the old history stays, consistent with itself, and the next cycle asks again.
    if (
      fresh.length === 0 ||
      comparison.storedOnly.length > stored.length * UNEXPLAINED_SESSION_SHARE
    ) {
      this.onPriceBasisEvent({
        securityId: security.id,
        symbol: security.symbol,
        outcome: "REPLACEMENT_REFUSED",
        storedOnlySessions: comparison.storedOnly.length,
        detail: `${fresh.length} provider sessions against ${stored.length} stored`,
      });
      return { outcome: "REFUSED" };
    }
    if (!comparison.changed) {
      return {
        outcome: "UNCHANGED",
        comparedSessions: comparison.comparedSessions,
      };
    }

    // Rows after the newest stored session follow the same hold as any read (§7, rule 3).
    const newestStored = stored.at(-1)?.date;
    const firstNew =
      newestStored === undefined
        ? 0
        : fresh.findIndex((row) => row.date > newestStored);
    const held = heldFromIndex(
      fresh,
      firstNew === -1 ? fresh.length : firstNew,
    );
    const prices = held === undefined ? [...fresh] : fresh.slice(0, held);
    const heldFrom = held === undefined ? undefined : fresh[held]!.date;

    const events = [
      ...(await this.store.getPriceBasisEvents(security.id)),
      ...comparison.events,
    ];
    const derived = await this.computeDailyDerivedState(
      security,
      target,
      { prices, range: readRange },
      events,
    );
    lease.assertOwned();
    const replaced = await this.store.replaceDailyPriceHistory({
      securityId: security.id,
      expectedGeneration: basis?.generation ?? 0,
      prices,
      derivedRows: derived.rows.filter((row) => row.date >= target.from),
      weeklyPrices: derived.weeklyBars,
      events: comparison.events,
      priceCoverage: {
        from: readRange.from,
        to:
          heldFrom === undefined
            ? readRange.to
            : maxDate(readRange.from, addDays(heldFrom, -1)),
      },
      derivedCoverage: target,
      syncedAt: detectedAt,
      tailDate: target.to,
      ...(heldFrom === undefined ? { freshThrough: target.to } : {}),
      verifiedAt: basis?.verifiedAt ?? detectedAt,
      assertOwned: lease.assertOwned,
    });
    this.onPriceBasisEvent({
      securityId: security.id,
      symbol: security.symbol,
      outcome: "REPLACED",
      generation: replaced.generation,
      measuredEvents: comparison.events.filter(
        (event) => event.kind === "MEASURED",
      ).length,
      unexplainedEvents: comparison.events.filter(
        (event) => event.kind === "UNEXPLAINED",
      ).length,
      storedOnlySessions: comparison.storedOnly.length,
      ...(heldFrom === undefined ? {} : { heldFrom }),
      durationMs: Math.round(performance.now() - started),
      detail: reason,
    });
    return {
      outcome: "REPLACED",
      basis: replaced,
      prices: prices.filter(
        (row) => row.date >= target.from && row.date <= target.to,
      ),
    };
  }

  /**
   * Rows a read would save beside the stored history, minus any held after a split-sized move
   * (§7, rule 3), and the date the hold starts.
   */
  private applyExDateHold(
    security: Security,
    newestStored: DailyPrice | undefined,
    loaded: readonly DailyPrice[],
  ): { rows: DailyPrice[]; heldFrom?: LocalDate } {
    const sorted = [...loaded].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    const series = newestStored
      ? [newestStored, ...sorted.filter((row) => row.date > newestStored.date)]
      : sorted;
    const held = heldFromIndex(series, newestStored ? 1 : 0);
    if (held === undefined) {
      return { rows: [...loaded] };
    }
    const heldFrom = series[held]!.date;
    this.onPriceBasisEvent({
      securityId: security.id,
      symbol: security.symbol,
      outcome: "HELD",
      heldFrom,
    });
    return { rows: loaded.filter((row) => row.date < heldFrom), heldFrom };
  }

  private async refreshPriceWithinLease(
    security: Security,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
    /** The cycle's first verification read the whole history and refused it. */
    wholeReadRefused: boolean,
  ): Promise<{
    prices: DailyPrice[];
    lastPriceRefreshAt: string;
    derivedRebuildStart: string | undefined;
    /** Set when the history was replaced: its derived rows are already rebuilt, only republished. */
    republishFrom?: string;
  }> {
    const unsettledFrom = await this.unsettledTailStart(security, target);
    const tailFrom = maxDate(
      addDays(target.to, -this.recentTailCalendarDays),
      target.from,
    );
    const refreshRange = {
      from:
        unsettledFrom === undefined
          ? tailFrom
          : minDate(tailFrom, unsettledFrom),
      to: target.to,
    };
    const previousState = await this.store.getDatasetState(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
    );
    this.onProviderRequest({
      symbol: security.symbol,
      securityId: security.id,
      dataset: "DAILY_PRICE",
      reason: "RECENT_TAIL_STALE",
      from: refreshRange.from,
      to: refreshRange.to,
    });
    const loaded = await this.provider.getDailyPrices(
      security.symbol,
      security.id,
      refreshRange,
    );
    const syncedAt = this.nowInstant();

    // Nothing is saved beside the stored history until its earliest row confirms the provider has
    // not re-based it (`historical-price-basis-v1.md`, §7, rule 2). A tail read after a re-base
    // returns rescaled rows that would otherwise overwrite the recent stored ones and leave the rest
    // on the old basis.
    const storedTail = await this.store.getDailyPrices(
      security.id,
      refreshRange,
    );
    if (
      changesStoredRows(storedTail, loaded) &&
      !(await this.earliestStoredRowUnchanged(security))
    ) {
      // The whole history was already read and refused in this cycle: a second whole read would be
      // refused the same way, so nothing is saved and the next cycle retries.
      const replacement = wholeReadRefused
        ? ({ outcome: "REFUSED" } as const)
        : await this.replacePriceHistoryWithinLease(
            security,
            target,
            lease,
            await this.store.getPriceBasis(security.id),
            "PRICE_REBASE",
          );
      if (replacement.outcome === "REPLACED") {
        lease.assertOwned();
        await this.cache.writeDailyPriceYears(
          security.id,
          replacement.prices,
          yearsInRange(target),
          hydrating,
        );
        return {
          prices: replacement.prices,
          lastPriceRefreshAt: syncedAt,
          derivedRebuildStart: undefined,
          republishFrom: target.from,
        };
      }
      if (replacement.outcome === "REFUSED") {
        // The provider re-based the history and it cannot be replaced yet: nothing new is saved
        // beside the old one, which stays consistent with itself until the next cycle retries.
        return {
          prices: await this.store.getDailyPrices(security.id, target),
          lastPriceRefreshAt: syncedAt,
          derivedRebuildStart: undefined,
        };
      }
      this.onPriceBasisEvent({
        securityId: security.id,
        symbol: security.symbol,
        outcome: "EARLIEST_ROW_UNCONFIRMED",
      });
    }

    const hold = this.applyExDateHold(
      security,
      storedTail.at(-1) ?? (await this.newestStoredPrice(security.id, target)),
      loaded,
    );
    lease.assertOwned();
    const change = await this.store.saveDailyPriceSync({
      securityId: security.id,
      prices: hold.rows,
      successfulCoverage:
        hold.heldFrom === undefined
          ? [refreshRange]
          : hold.heldFrom > refreshRange.from
            ? [{ from: refreshRange.from, to: addDays(hold.heldFrom, -1) }]
            : [],
      syncedAt,
      tailDate: target.to,
      ...(hold.heldFrom === undefined ? { freshThrough: target.to } : {}),
      assertOwned: lease.assertOwned,
    });
    lease.assertOwned();

    const allPrices = await this.store.getDailyPrices(security.id, target);
    // A newly completed week changes the carried-forward weekly source on every later trading day,
    // so the derived rebuild window starts at the earlier of the price change and the week boundary.
    const weeklyRefreshStart = startOfIsoWeek(addDays(refreshRange.from, -7));
    let priceRecalculationStart: string | undefined;
    if (change.earliestChangedDate) {
      priceRecalculationStart =
        previousState?.earliestDate &&
        change.earliestChangedDate < previousState.earliestDate
          ? target.from
          : change.earliestChangedDate;
    }
    const derivedRebuildStart = priceRecalculationStart
      ? minDate(priceRecalculationStart, weeklyRefreshStart)
      : weeklyRefreshStart;
    lease.assertOwned();

    if (change.earliestChangedDate) {
      const affectedRange = yearBoundedRange(
        change.earliestChangedDate,
        target.to,
      );
      await this.cache.writeDailyPriceYears(
        security.id,
        await this.store.getDailyPrices(security.id, affectedRange),
        yearsInRange(affectedRange),
        hydrating,
      );
    }

    // The derived rebuild is not performed here: prices and fundamentals may both have changed in
    // this cycle, and the unified state is rebuilt and republished exactly once from the earliest
    // required start across every cause.
    return {
      prices: allPrices,
      lastPriceRefreshAt: syncedAt,
      derivedRebuildStart,
    };
  }

  /**
   * Refreshes fundamentals and reports the earliest trading date whose intrinsic values may change.
   *
   * A newly persisted revision changes valuations from its own `availableFromDate` onward, never
   * from its fiscal date, so the bound comes from the availability of the successfully loaded
   * overlap batch. That batch may contain unchanged revisions too; rebuilding from the earliest of
   * them is conservative but bounded, and far cheaper than rebuilding the whole history.
   */
  private async refreshFundamentalsWithinLease(
    security: Security,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<{
    lastFundamentalsRefreshAt: string;
    derivedRebuildStart: string | undefined;
  }> {
    const operations = this.fundamentalsOperationsForHistory();
    const results = await this.runFundamentalsOperationsToSettlement(
      operations,
      (operation) =>
        this.syncFundamentalsOperation({
          security,
          operation,
          limit: this.fundamentalsRefreshLimit(operation.cadence),
          lease,
        }),
    );
    lease.assertOwned();

    let derivedRebuildStart: string | undefined;
    for (const result of results) {
      if (result.changedYears.length === 0) {
        continue;
      }
      const firstYear = result.changedYears[0]!;
      const lastYear = result.changedYears.at(-1)!;
      const rows = await this.store.getFinancialStatementRevisions({
        securityId: security.id,
        statementType: result.operation.statementType,
        cadence: result.operation.cadence,
        from: `${firstYear}-01-01`,
        to: `${lastYear}-12-31`,
      });
      for (const row of rows) {
        derivedRebuildStart =
          derivedRebuildStart === undefined
            ? row.availableFromDate
            : minDate(derivedRebuildStart, row.availableFromDate);
      }
      await this.cache.writeFinancialStatementYears(
        security.id,
        rows,
        result.operation.statementType,
        result.operation.cadence,
        result.changedYears,
        hydrating,
      );
      lease.assertOwned();
    }
    return {
      lastFundamentalsRefreshAt: this.nowInstant(),
      derivedRebuildStart,
    };
  }

  /**
   * Publishes every retained fundamentals year, warm-up years included, under the existing yearly
   * key family. There is no separate warm-up dataset or key.
   */
  private async publishAllFundamentalsYears(
    securityId: string,
    retention: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<void> {
    const years = yearsInRange(retention);
    for (const operation of this.fundamentalsOperationsForHistory()) {
      const rows = await this.store.getFinancialStatementRevisions({
        securityId,
        statementType: operation.statementType,
        cadence: operation.cadence,
        from: retention.from,
        to: retention.to,
      });
      await this.cache.writeFinancialStatementYears(
        securityId,
        rows,
        operation.statementType,
        operation.cadence,
        years,
        hydrating,
      );
      lease.assertOwned();
    }
  }

  private async syncFundamentalsOperation(input: {
    security: Security;
    operation: FundamentalsOperation;
    limit: number;
    lease: LoadLease;
  }): Promise<{
    operation: FundamentalsOperation;
    changedYears: number[];
  }> {
    this.onProviderRequest({
      symbol: input.security.symbol,
      securityId: input.security.id,
      dataset: "FINANCIAL_STATEMENTS",
      reason: "FUNDAMENTALS_BACKFILL",
      detail: `${input.operation.statementType}/${input.operation.cadence}`,
    });
    const loaded = await this.provider.getFinancialStatements(
      input.security.symbol,
      input.security.id,
      input.operation.statementType,
      input.operation.cadence,
      input.limit,
    );
    // Retention, not visibility: statements from the warm-up years are persisted so the first
    // visible trading day already has TTM and growth context. Rows older than the retention bound
    // are still discarded.
    const retention = this.fundamentalsTarget(input.security);
    const statements = loaded
      .filter((statement) => statement.fiscalDate >= retention.from)
      .filter((statement) => statement.fiscalDate <= retention.to);
    const syncedAt = this.nowInstant();
    input.lease.assertOwned();
    const saved = await this.store.saveFinancialStatements({
      securityId: input.security.id,
      statements,
      syncedAt,
    });
    input.lease.assertOwned();
    const sortedFiscalDates = statements
      .map((statement) => statement.fiscalDate)
      .sort();
    await this.store.upsertDatasetState({
      securityId: input.security.id,
      dataset: input.operation.dataset,
      variant: input.operation.variant,
      syncedAt,
      ...(sortedFiscalDates[0] ? { earliestDate: sortedFiscalDates[0] } : {}),
      ...(sortedFiscalDates.at(-1)
        ? { latestDate: sortedFiscalDates.at(-1) }
        : {}),
    });

    return {
      operation: input.operation,
      changedYears:
        saved.insertedRevisionCount > 0
          ? [
              ...new Set(
                statements.map((statement) =>
                  Number(statement.fiscalDate.slice(0, 4)),
                ),
              ),
            ].sort((left, right) => left - right)
          : [],
    };
  }

  /**
   * The fundamentals datasets this deployment expects, keyed by the **product** horizon.
   *
   * The variant string carries that horizon (`h30:w7`). Passing the price-retention horizon here
   * would rename every variant to `h34:w7`, make every already-backfilled dataset look missing and
   * re-download the whole statement history from the provider — for a policy change that never
   * touched a filing.
   */
  private fundamentalsOperationsForHistory() {
    return fundamentalsDatasetOperations(this.productHistoryYears);
  }

  private async runFundamentalsOperationsToSettlement<T>(
    operations: readonly FundamentalsOperation[],
    run: (operation: FundamentalsOperation) => Promise<T>,
  ): Promise<T[]> {
    const settled = await Promise.allSettled(
      operations.map((operation) => run(operation)),
    );
    const firstRejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (firstRejected) {
      throw toError(firstRejected.reason);
    }
    return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
  }

  private fundamentalsVariant(cadence: FinancialStatementCadence): string {
    return fundamentalsDatasetVariant(cadence, this.productHistoryYears);
  }

  /** Request capacity must cover the retained years plus the existing safety tails. */
  private fundamentalsBackfillLimit(
    cadence: FinancialStatementCadence,
  ): number {
    const retainedYears =
      this.productHistoryYears + VALUATION_FUNDAMENTALS_WARMUP_YEARS;
    return cadence === QUARTERLY_CADENCE
      ? retainedYears * 4 + FUNDAMENTALS_BACKFILL_QUARTERLY_TAIL
      : retainedYears + FUNDAMENTALS_BACKFILL_ANNUAL_TAIL;
  }

  private fundamentalsRefreshLimit(cadence: FinancialStatementCadence): number {
    return cadence === QUARTERLY_CADENCE
      ? FUNDAMENTALS_REFRESH_QUARTERLY_LIMIT
      : FUNDAMENTALS_REFRESH_ANNUAL_LIMIT;
  }

  private oldestRequiredSyncAt(
    states: readonly (PersistedDatasetState | null)[],
  ): string | undefined {
    const syncedAtValues = states.map((state) => state?.lastSyncedAt);
    if (syncedAtValues.some((value) => value === undefined)) {
      return undefined;
    }
    return syncedAtValues
      .filter((value): value is string => value !== undefined)
      .sort()[0];
  }

  private boundFinancialQuery(
    security: Security,
    query: FinancialStatementQuery,
  ): FinancialStatementQuery {
    const target = this.productTarget(security);
    const from = query.from ? maxDate(query.from, target.from) : target.from;
    const to = query.to ? minDate(query.to, target.to) : target.to;
    return {
      ...query,
      from,
      to,
      ...(query.asOf ? { asOf: minDate(query.asOf, target.to) } : {}),
    };
  }

  private readyManifest(
    security: Security,
    target: Required<DateRange>,
    prices: readonly { date: string }[],
    hydratedAt: string,
    lastPriceRefreshAt?: string,
    lastFundamentalsRefreshAt?: string,
  ): StockManifest {
    const first = prices[0]?.date;
    const last = prices.at(-1)?.date;
    return {
      securityId: security.id,
      status: "READY",
      productHistoryYears: this.productHistoryYears,
      priceRetentionYears: this.priceRetentionYears,
      coverageStart: target.from,
      coverageEnd: target.to,
      ...(first ? { canonicalHistoryStart: first } : {}),
      ...(last ? { canonicalHistoryEnd: last } : {}),
      hydratedAt,
      ...(lastPriceRefreshAt ? { lastPriceRefreshAt } : {}),
      ...(lastFundamentalsRefreshAt ? { lastFundamentalsRefreshAt } : {}),
      priceDatasetVersion: PRICE_DATASET_VERSION,
      financialStatementVersion: FINANCIAL_STATEMENT_VERSION,
      derivedStateRevision: DERIVED_STATE_REVISION,
      dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
    };
  }

  private hydratingManifest(
    security: Security,
    previous: StockManifest | null,
    target: Required<DateRange>,
  ): StockManifest {
    return {
      ...(previous ?? {}),
      securityId: security.id,
      status: "HYDRATING",
      productHistoryYears: this.productHistoryYears,
      priceRetentionYears: this.priceRetentionYears,
      coverageStart: target.from,
      coverageEnd: target.to,
      hydrationId: randomUUID(),
      hydratingAt: this.nowInstant(),
      priceDatasetVersion: PRICE_DATASET_VERSION,
      financialStatementVersion: FINANCIAL_STATEMENT_VERSION,
      derivedStateRevision: DERIVED_STATE_REVISION,
      dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
    };
  }

  /**
   * Whether a READY manifest was produced by the current configuration and methodology.
   *
   * This says nothing about *how much* history it holds — see `covers` — so it stays the right
   * question for callers that only need the cached identity or the refresh watermarks.
   */
  private isCurrent(manifest: StockManifest | null): manifest is StockManifest {
    return (
      manifest?.status === "READY" &&
      manifest.productHistoryYears === this.productHistoryYears &&
      // Retention is pinned as well as the product horizon, so a READY manifest written under the
      // narrower policy cannot answer for the wider one. Widening retention costs a Redis rebuild
      // and nothing more: the durable coverage under `DAILY_PRICE_VARIANT` is untouched, so the
      // rebuild replays PostgreSQL and reaches the provider only for dates genuinely missing.
      manifest.priceRetentionYears === this.priceRetentionYears &&
      manifest.priceDatasetVersion === PRICE_DATASET_VERSION &&
      manifest.financialStatementVersion === FINANCIAL_STATEMENT_VERSION &&
      manifest.derivedStateRevision === DERIVED_STATE_REVISION &&
      // The Redis encoding of the derived state, not its methodology: a manifest published over
      // chunks of another encoding costs one rebuild of the projection from PostgreSQL. Nothing is
      // recalculated, and the provider is asked only for a tail PostgreSQL has not covered yet —
      // exactly what any hydration of the same range would ask for.
      manifest.dailyStateEncodingVersion === DAILY_STATE_ENCODING_VERSION
    );
  }

  /**
   * Whether a manifest is current in every respect except, possibly, the encoding its `daily-state`
   * chunks were written in.
   *
   * Such a manifest cannot be read from — `covers` still refuses it — but its coverage still
   * describes exactly what this service would materialize, because an encoding moves bytes and never
   * a value. Keeping that coverage is what makes the rebuild that rewrites the chunks republish the
   * whole resident range, rather than narrowing the stock to the window of whichever read found the
   * old encoding first.
   */
  private isCurrentExceptEncoding(
    manifest: StockManifest | null,
  ): manifest is StockManifest {
    return (
      manifest !== null &&
      this.isCurrent({
        ...manifest,
        dailyStateEncodingVersion: DAILY_STATE_ENCODING_VERSION,
      })
    );
  }

  /**
   * Whether the resident state already reaches back far enough for a requested range.
   *
   * Readiness is per range, not global: a stock materialized for a one-year Stock Details window
   * is genuinely ready for that window and genuinely not ready for a twenty-year backtest, which
   * is what makes the wider request load the missing prefix instead of silently reading short.
   *
   * Only the start is a readiness question. How current the tail is stays a freshness question,
   * owned by `ensureStockFresh` and its recent-tail refresh, so a day rollover keeps taking the
   * cheap refresh path instead of re-entering cold hydration.
   */
  private covers(
    manifest: StockManifest | null,
    requested: Required<DateRange>,
  ): manifest is StockManifest {
    return (
      this.isCurrent(manifest) &&
      manifest.coverageStart !== undefined &&
      manifest.coverageStart <= requested.from
    );
  }

  private isPriceFreshnessStale(manifest: StockManifest | null): boolean {
    if (!this.isCurrent(manifest) || !manifest.lastPriceRefreshAt) {
      return true;
    }
    const lastRefresh = Date.parse(manifest.lastPriceRefreshAt);
    return (
      !Number.isFinite(lastRefresh) ||
      this.now().valueOf() - lastRefresh >= this.recentPriceFreshnessMs
    );
  }

  private isFundamentalsFreshnessStale(
    manifest: StockManifest | null,
  ): boolean {
    if (!this.isCurrent(manifest) || !manifest.lastFundamentalsRefreshAt) {
      return true;
    }
    const lastRefresh = Date.parse(manifest.lastFundamentalsRefreshAt);
    return (
      !Number.isFinite(lastRefresh) ||
      this.now().valueOf() - lastRefresh >= this.fundamentalsFreshnessMs
    );
  }

  private recalculationStart(
    target: Required<DateRange>,
    previousPriceState: PersistedDatasetState | null,
    earliestChangedDate: string | undefined,
    derivedRepairStart: string | undefined,
  ): string {
    const priceRepairStart = earliestChangedDate
      ? previousPriceState?.earliestDate &&
        earliestChangedDate < previousPriceState.earliestDate
        ? target.from
        : earliestChangedDate
      : undefined;
    return (
      [derivedRepairStart, priceRepairStart]
        .filter((date): date is string => date !== undefined)
        .sort()[0] ?? target.from
    );
  }

  /**
   * The range the loader materializes to answer a requested read.
   *
   * The caller's window decides the load. Only the derived warm-up is added to it, and the
   * **price retention** horizon clamps it — never the product horizon, which is a bound on what
   * may be *shown*, not on what may be *held*. Clamping the load to the product horizon is what
   * used to leave a maximum-length backtest with no two-hundred-week average on its first years:
   * the warm-up was subtracted and then immediately clamped back onto the boundary it was meant
   * to reach behind.
   *
   * Below the product horizon the boundary stops being caller-scoped and snaps to the retention
   * start. There is no surface down there to scope it to, and one canonical prefix is what makes
   * the second deep caller free: every request that reaches past the product boundary converges on
   * the same range, so it is fetched once, covered once, and never re-requested in ragged slices.
   *
   * The upper bound stays today because a resident stock is only usable while its tail is current:
   * freshness, the recent-tail refresh and the manifest all key off it, and nothing is saved by
   * holding a stale tail.
   */
  private loadTarget(
    security: Security,
    requested: Required<DateRange>,
  ): Required<DateRange> {
    const product = this.productTarget(security);
    const retention = this.priceRetentionTarget(security);
    const warmed = minDate(
      addDays(requested.from, -DERIVED_SERIES_WARMUP_DAYS),
      product.to,
    );
    return {
      from: warmed <= product.from ? retention.from : warmed,
      to: retention.to,
    };
  }

  /**
   * The range one hydration or refresh cycle must leave materialized: the range this caller
   * needs, unioned with what is already resident. Neither operation may narrow the cache.
   *
   * `required` is already a load target — the warm-up belongs to `loadTarget` and is applied
   * exactly once, where the caller's window is translated into a load.
   */
  private maintainedTarget(
    required: Required<DateRange>,
    resident: StockManifest | null,
  ): Required<DateRange> {
    const residentStart = this.isCurrentExceptEncoding(resident)
      ? resident.coverageStart
      : undefined;
    return {
      from: residentStart
        ? minDate(residentStart, required.from)
        : required.from,
      to: required.to,
    };
  }

  /**
   * How far back Stock Details may go for this security, and why it stops there.
   *
   * Computed here rather than at the HTTP edge because this is where the clock, the retained
   * horizon and the durable coverage live: a bound derived from a second clock or a second copy of
   * the horizon would be a bound the loader does not actually honour. The listing date wins when
   * it is later than the horizon, so a client can say "this is where the security starts" instead
   * of implying the limit was reached.
   *
   * The provider's own boundary is reported only when it is proven: every date between the
   * permitted start and the day before the earliest persisted row is covered under the current
   * `PRICE_DATASET_VERSION`, which means the provider was asked for all of it with complete
   * requests and returned nothing. Until then the wider bound is reported and the client keeps
   * asking in bounded windows. Nothing here is inferred from a window that came back empty, and
   * nothing here ever changes the security's listing date.
   */
  private async stockDetailsHistoryBounds(
    security: Security,
  ): Promise<StockHistoryBounds> {
    const today = this.today();
    const horizonStart = subtractYears(today, this.stockDetailsHistoryYears);
    const listing = security.ipoDate;
    const permitted: StockHistoryBounds =
      listing !== undefined && listing > horizonStart
        ? { start: listing, end: today, startOrigin: "LISTING" }
        : { start: horizonStart, end: today, startOrigin: "HORIZON" };
    // Coverage is read before the earliest row, deliberately. A prefix load commits its rows and
    // the coverage describing them in one transaction; if that commit lands between these two
    // reads, coverage read first is still incomplete and the wider bound is reported, whereas the
    // other order could pair a pre-commit earliest row with post-commit coverage and pin the
    // client at a row that persisted history now precedes.
    const coverage = await this.store.getDatasetCoverage(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
      { from: permitted.start, to: permitted.end },
    );
    const earliestRow = await this.store.getEarliestDailyPriceDate(security.id);
    if (
      earliestRow === null ||
      earliestRow <= addDays(permitted.start, PROVIDER_BOUNDARY_MIN_GAP_DAYS)
    ) {
      return permitted;
    }
    const unproven = { from: permitted.start, to: addDays(earliestRow, -1) };
    if (missingCoverageRanges(unproven, coverage).length > 0) {
      return permitted;
    }
    return { start: earliestRow, end: today, startOrigin: "PROVIDER" };
  }

  /**
   * The product horizon for one security: the outer bound of everything a user may see.
   *
   * Every projection, every intrinsic read, every financial-statement query and the Stock Details
   * bound resolve against this range and nothing wider. Raw prices reach further back — see
   * {@link priceRetentionTarget} — but those rows exist to make a calculation valid on the first
   * visible day, and no product surface may return one.
   */
  private productTarget(security: Security): Required<DateRange> {
    return this.horizonTarget(security, this.productHistoryYears);
  }

  /**
   * Internal retention range for raw daily prices: the product horizon plus the derived-series
   * warm-up, clamped to a known listing date.
   *
   * Deliberately separate from {@link productTarget}, exactly as `fundamentalsTarget` is. Only the
   * load target, the durable price coverage it records and the derived state calculated from it
   * use this wider range; widening the product target instead would expose the warm-up years
   * through Stock Details, the price and technical APIs and the backtestable period.
   *
   * The listing clamp is what keeps a recent IPO honest: a security listed inside the retention
   * window retains from its listing date, and no warm-up row is invented before it.
   */
  private priceRetentionTarget(security: Security): Required<DateRange> {
    return this.horizonTarget(security, this.priceRetentionYears);
  }

  /** `[max(today - years, ipoDate), today]` — the one horizon shape, one year-arithmetic rule. */
  private horizonTarget(
    security: Security,
    years: number,
  ): Required<DateRange> {
    const today = this.today();
    const horizonStart = subtractYears(today, years);
    return {
      from: security.ipoDate
        ? maxDate(horizonStart, security.ipoDate)
        : horizonStart,
      to: today,
    };
  }

  /**
   * Internal retention range for financial statements: the **product** horizon plus the valuation
   * warm-up, clamped to a known listing date.
   *
   * Anchored to the product horizon, never to {@link priceRetentionTarget}. The two warm-ups
   * answer different questions — one makes a recursive price series valid on the first visible
   * day, the other makes a TTM window and its growth endpoints point-in-time eligible on it — and
   * compounding them would quietly turn a thirty-seven-year statement retention into forty-one,
   * costing provider quota and storage for filings no valuation can ever read.
   *
   * Only statement backfill, publication and the rebuild's revision read use this range, and no
   * derived row is ever produced for a warm-up year.
   */
  private fundamentalsTarget(security: Security): Required<DateRange> {
    return this.horizonTarget(
      security,
      this.productHistoryYears + VALUATION_FUNDAMENTALS_WARMUP_YEARS,
    );
  }

  /**
   * Whether the first week of a calculation is a real trading week or one the history's start cut
   * in half, given the earliest bar the calculation actually has.
   *
   * Anchored on that bar rather than on the requested range for the same reason the calculation
   * itself is (AUD-02): a partial first week changes every later weekly average, so which week the
   * series starts with must be a property of the stored prices and not of the read that triggered
   * the rebuild.
   */
  private weeklyHistoryContext(security: Security, historyStart: LocalDate) {
    return {
      historyStart,
      historyStartOrigin:
        security.ipoDate && security.ipoDate >= historyStart
          ? ("LISTING" as const)
          : ("HORIZON" as const),
    };
  }

  /**
   * The slice of a requested range a read may return, and which bound applies.
   *
   * `PRODUCT` is the one place the retained warm-up years are cut off: prices, derived state,
   * technicals, intrinsic values and Stock Details are read through it, so a row older than the
   * product horizon physically cannot reach a user however wide the load target was.
   *
   * `BACKTEST` applies **no clock-derived bound at all**, and that distinction is the whole point.
   * A completed run's period is immutable — validated against the selectable horizon at submission
   * and written into the run's own snapshot — so re-deriving any bound for it from the *current*
   * clock silently rewrites what the run executes. The validation matrix measured the first
   * version of that: a run pinned to 1996-09-09 and executed on 2026-09-10 simulated 7,546
   * sessions where its own calendar had 7,547, losing the first simulated date and with it the
   * return-index base, the first contribution date and every number chained off them.
   *
   * Bounding by *retention* instead of by the product horizon only postponed it. Retention is a
   * maintenance horizon, not a deletion one — nothing prunes `DailyPrice` — so a row below it is
   * still there, and a period that survived midnight and a week's retry started a session later
   * again one day past the margin. There is no version of a clock-derived floor that is safe for
   * an immutable period; there is only a version that fails later.
   *
   * The listing clamp stays, because it is not a clock bound. A security participates on the days
   * its own frame has rows for, which is `execution-calendar-authoritative@2` and not a clipped
   * period.
   */
  private projectionRange(
    security: Security,
    requested: Required<DateRange>,
    bound: "PRODUCT" | "BACKTEST" = "PRODUCT",
  ): Required<DateRange> | null {
    if (bound === "BACKTEST") {
      const listing = security.ipoDate;
      const from = listing ? maxDate(requested.from, listing) : requested.from;
      return from <= requested.to ? { from, to: requested.to } : null;
    }
    const target = this.productTarget(security);
    const from = maxDate(requested.from, target.from);
    const to = minDate(requested.to, target.to);
    return from <= to ? { from, to } : null;
  }

  private stockResource(security: Security): string {
    return `hydrate:${security.id}`;
  }

  private defaultRange(range?: DateRange): Required<DateRange> {
    const to = range?.to ?? this.today();
    const from = range?.from ?? addDays(to, -this.defaultHistoryDays);
    return this.requireBoundedRange({ from, to });
  }

  private requireBoundedRange(range: DateRange): Required<DateRange> {
    try {
      assertDateRange(range);
    } catch (error) {
      throw new StockDataValidationError(
        error instanceof Error ? error.message : "Invalid historical range",
      );
    }
    if (!range.from || !range.to) {
      throw new StockDataValidationError(
        "Historical requests must include bounded from and to dates",
      );
    }
    return { from: range.from, to: range.to };
  }

  private normalizeSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,20}$/.test(normalized)) {
      throw new StockDataValidationError("Invalid stock symbol");
    }
    return normalized;
  }

  /**
   * Where the previous leading-edge price sync stopped being trustworthy, or undefined.
   *
   * The provider's EOD feed serves the current session as an in-progress bar, and a request whose
   * `to` is the UTC day can run before the New York session of that date exists. Either way the
   * previous sync's recent tail (`recentTailCalendarDays` behind its tail date) may hold a bar that
   * later changed or a session that was not yet published — while coverage already claims it.
   * Refreshing only the tail behind *today* re-reads that window only if the next sync happens
   * within those days; after a longer pause the provisional bar or the missing session would be
   * permanent (data-correctness audit AUD-04: MRNA 2026-09-04 missing, MRNA 2026-09-09 left at an
   * in-session 137.395 against a final 135.61). So every leading-edge sync reaches back to the
   * previous sync's own tail window as well: each date is fetched again once after it settles.
   */
  private async unsettledTailStart(
    security: Security,
    target: Required<DateRange>,
  ): Promise<string | undefined> {
    const freshness = await this.store.getDatasetState(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_FRESHNESS_VARIANT,
    );
    const previousTail = freshness?.latestDate;
    if (previousTail === undefined || previousTail > target.to) {
      return undefined;
    }
    return maxDate(
      addDays(previousTail, -this.recentTailCalendarDays),
      target.from,
    );
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private nowInstant(): string {
    return this.now().toISOString();
  }
}

/**
 * Daily technical projection over the unified derived state.
 *
 * Weekly values are read straight off the daily row: the materializer already carried the latest
 * completed week forward, so this projection never recalculates, interpolates or looks ahead.
 * Every daily family — both moving-average timeframes, the daily oscillators and Relative Volume —
 * is copied through the same canonical field list, so an unavailable value stays absent instead of
 * becoming zero and a registered series cannot go missing from the projection.
 */
function toDailyTechnical(row: DailyDerivedState): DailyTechnical {
  const values = Object.fromEntries(
    DAILY_TECHNICAL_PROJECTION_FIELDS.flatMap((field) => {
      const value = row[field];
      return value === undefined ? [] : [[field, value] as const];
    }),
  );
  return { securityId: row.securityId, date: row.date, ...values };
}

/**
 * The storage field of a Fundamental Metric identity, or a validation error for anything the
 * registry does not define.
 *
 * The identity is matched against the registry's own list before the lookup, so a stray string —
 * a label, a storage field, `__proto__` — is refused as bad input instead of reaching a property
 * read or surfacing as an internal error. The input is deliberately not echoed back.
 */
function fundamentalMetricField(metricId: string): FundamentalMetricField {
  if (!isRegisteredFundamentalMetric(metricId)) {
    throw new StockDataValidationError("Unsupported fundamental metric");
  }
  return fundamentalMetricDefinition(metricId).field;
}

/** An exact match against the registry's identities: no case folding, no labels, no fields. */
function isRegisteredFundamentalMetric(
  value: string,
): value is FundamentalMetricId {
  return (FUNDAMENTAL_METRIC_IDS as readonly string[]).includes(value);
}

/**
 * One session of one Fundamental Metric: the persisted field as it stands, or no value at all.
 *
 * Read, never recalculated, and never repaired: a finite stored number — zero and negatives
 * included — is the reading, and anything else is the session's absence. The derived state never
 * holds a non-finite fundamental (the store refuses one), so the finiteness check only keeps the
 * wire contract honest: a JSON `null` could otherwise stand where the contract promises omission.
 */
function toFundamentalMetricPoint(
  row: DailyDerivedState,
  field: FundamentalMetricField,
): DailyFundamentalMetricPoint {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value)
    ? { date: row.date, value }
    : { date: row.date };
}

/**
 * Point-in-time eligibility of one already-resolved provenance instant.
 *
 * Provenance is per intrinsic model, so this is applied independently per model and per blend
 * rather than once per row: on the same trading day one model can be eligible at a cutoff while
 * another, whose inputs were published later, is not.
 */
function isSourceVisible(
  row: DailyDerivedState,
  sourceDataAsOf: string | undefined,
  asOf?: string,
): boolean {
  if (asOf && row.date > asOf) {
    return false;
  }
  if (!sourceDataAsOf) {
    return false;
  }
  return sourceDataAsOf <= endOfLocalDate(asOf ?? row.date);
}

function toIntrinsicValuePoints(
  rows: readonly DailyDerivedState[],
  query: IntrinsicValueQuery,
): IntrinsicValuePoint[] {
  const models = query.models ?? INTRINSIC_VALUE_MODELS;
  return rows.flatMap((row) =>
    models.flatMap((model) => {
      const valuePerShare = row.intrinsicValues?.[model];
      // A model's own provenance is mandatory: a value without it is never point-in-time readable.
      const sourceDataAsOf = intrinsicModelSourceAsOf(row, model);
      return valuePerShare === undefined ||
        !row.intrinsicCurrency ||
        !isSourceVisible(row, sourceDataAsOf, query.asOf)
        ? []
        : [
            {
              securityId: row.securityId,
              valuationDate: row.date,
              sourceDataAsOf: sourceDataAsOf as string,
              model,
              valuePerShare,
              currency: row.intrinsicCurrency,
            },
          ];
    }),
  );
}

function toIntrinsicValueBlendPoints(
  rows: readonly DailyDerivedState[],
  query: IntrinsicValueBlendQuery,
): IntrinsicValueBlendPoint[] {
  const blendIds = query.blendIds ?? INTRINSIC_VALUE_BLEND_IDS;
  return rows.flatMap((row) =>
    blendIds.flatMap((blendId) => {
      const valuePerShare = row.intrinsicValueBlends?.[blendId];
      // Derived, not stored: the maximum provenance of the models composing this blend, defined
      // only when every required component value and provenance is present. Never renormalized.
      const sourceDataAsOf = blendSourceDataAsOf(row, blendId);
      return valuePerShare === undefined ||
        !row.intrinsicCurrency ||
        !isSourceVisible(row, sourceDataAsOf, query.asOf)
        ? []
        : [
            {
              securityId: row.securityId,
              valuationDate: row.date,
              sourceDataAsOf: sourceDataAsOf as string,
              blendId,
              valuePerShare,
              currency: row.intrinsicCurrency,
            },
          ];
    }),
  );
}

function minOptionalDate(left?: string, right?: string): string | undefined {
  if (left && right) {
    return minDate(left, right);
  }
  return left ?? right;
}

function yearBoundedRange(from: string, to: string): Required<DateRange> {
  return {
    from: `${from.slice(0, 4)}-01-01`,
    to: `${to.slice(0, 4)}-12-31`,
  };
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Whether saving `loaded` would change the stored history: a session it does not hold yet, or one
 * whose bar differs in any field. Only then must the earliest stored row be checked first.
 */
function changesStoredRows(
  stored: readonly DailyPrice[],
  loaded: readonly DailyPrice[],
): boolean {
  const storedByDate = new Map(stored.map((row) => [row.date, row]));
  return loaded.some((row) => {
    const existing = storedByDate.get(row.date);
    return (
      existing === undefined ||
      !sameStoredValue(existing.open, row.open) ||
      !sameStoredValue(existing.high, row.high) ||
      !sameStoredValue(existing.low, row.low) ||
      !sameStoredValue(existing.close, row.close) ||
      existing.volume !== row.volume ||
      !sameStoredValue(existing.vwap, row.vwap)
    );
  });
}

/**
 * Whether a provider value reads back as the stored one. Prices are stored to eight decimals, so a
 * value carrying more digits never compares equal to what was saved from it.
 */
function sameStoredValue(
  stored: number | undefined,
  loaded: number | undefined,
): boolean {
  return (
    stored === loaded ||
    (stored !== undefined &&
      loaded !== undefined &&
      Math.abs(stored - loaded) <= 5e-9 * (1 + Math.abs(loaded)))
  );
}

/** Whether any operand is a valuation ratio, whose inputs are then ingested and loaded. */
function namesValuationRatio(operands: readonly OperandKey[]): boolean {
  return operands.some((key) => operandValuationRatioId(key) !== null);
}
