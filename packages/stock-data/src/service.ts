import { randomUUID } from "node:crypto";
import {
  FINANCIAL_STATEMENT_TYPES,
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  type DailyDerivedState,
  type DailyPrice,
  type DailyTechnical,
  type DateRange,
  type FinancialStatement,
  type FinancialStatementCadence,
  type FinancialStatementQuery,
  type FinancialStatementType,
  type IntrinsicValueBlendPoint,
  type IntrinsicValueBlendQuery,
  type IntrinsicValuePoint,
  type IntrinsicValueQuery,
  type Security,
  type StockDataService,
  type StockDetails,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import {
  FINANCIAL_STATEMENT_VERSION,
  PRICE_DATASET_VERSION,
  yearsInRange,
  type StockDataCache,
  type StockManifest,
} from "./cache.js";
import type { LoadLease, LoadCoordinator } from "./coordination.js";
import {
  addDays,
  assertDateRange,
  endOfLocalDate,
  missingCoverageRanges,
} from "./dates.js";
import {
  buildDailyDerivedState,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import {
  DAILY_PRICE_VARIANT,
  type PersistedDatasetState,
  type StockDataStore,
} from "./ports.js";
import { aggregateCompletedWeeks, startOfIsoWeek } from "./weekly.js";

const QUARTERLY_CADENCE = "QUARTERLY" as const;
const ANNUAL_CADENCE = "ANNUAL" as const;
const FUNDAMENTALS_VARIANT_VERSION = 1;
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

export type CanonicalStockDataServiceOptions = {
  defaultHistoryDays?: number;
  historyYears?: number;
  recentPriceFreshnessMs?: number;
  fundamentalsFreshnessMs?: number;
  recentTailCalendarDays?: number;
  now?: () => Date;
};

export class CanonicalStockDataService implements StockDataService {
  private readonly defaultHistoryDays: number;
  private readonly historyYears: number;
  private readonly recentPriceFreshnessMs: number;
  private readonly fundamentalsFreshnessMs: number;
  private readonly recentTailCalendarDays: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: StockDataStore,
    private readonly provider: FmpStockProviderPort,
    private readonly cache: StockDataCache,
    private readonly coordinator: LoadCoordinator,
    options: CanonicalStockDataServiceOptions = {},
  ) {
    this.defaultHistoryDays = options.defaultHistoryDays ?? 365;
    this.historyYears = options.historyYears ?? 30;
    this.recentPriceFreshnessMs =
      options.recentPriceFreshnessMs ?? 6 * 60 * 60 * 1000;
    this.fundamentalsFreshnessMs =
      options.fundamentalsFreshnessMs ?? 6 * 60 * 60 * 1000;
    this.recentTailCalendarDays = options.recentTailCalendarDays ?? 10;
    this.now = options.now ?? (() => new Date());
    for (const [name, value] of Object.entries({
      defaultHistoryDays: this.defaultHistoryDays,
      historyYears: this.historyYears,
      recentPriceFreshnessMs: this.recentPriceFreshnessMs,
      fundamentalsFreshnessMs: this.fundamentalsFreshnessMs,
      recentTailCalendarDays: this.recentTailCalendarDays,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  async getSecurity(symbol: string): Promise<Security> {
    const normalized = this.normalizeSymbol(symbol);
    const cached = await this.cache.getSecurity(normalized);
    if (cached) {
      return cached;
    }
    const persisted = await this.store.findSecurityByProviderSymbol(normalized);
    if (persisted) {
      await this.cache.setSecurity(persisted);
      return persisted;
    }

    return this.coordinator.run(
      `hydrate:symbol:${normalized}`,
      async (lease) => {
        const afterLock =
          await this.store.findSecurityByProviderSymbol(normalized);
        if (afterLock) {
          await this.cache.setSecurity(afterLock);
          return afterLock;
        }
        const mapped = await this.provider.getProfile(normalized);
        if (!mapped) {
          throw new StockDataNotFoundError(normalized);
        }
        lease.assertOwned();
        const saved = await this.store.saveSecurityProfile(
          mapped,
          this.nowInstant(),
        );
        lease.assertOwned();
        await this.cache.setSecurity(saved.security);
        return saved.security;
      },
    );
  }

  async ensureStockHydrated(security: Security): Promise<void> {
    const manifest = await this.cache.getManifest(security.id);
    if (this.isReady(manifest)) {
      return;
    }
    await this.coordinator.run(this.stockResource(security), async (lease) =>
      this.hydrateWithinLease(security, lease),
    );
  }

  async ensureStockFresh(security: Security): Promise<void> {
    let manifest = await this.cache.getManifest(security.id);
    if (!this.isReady(manifest)) {
      await this.ensureStockHydrated(security);
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
      if (!this.isReady(lockedManifest)) {
        await this.hydrateWithinLease(security, lease);
        lockedManifest = await this.cache.getManifest(security.id);
      }
      if (!this.isReady(lockedManifest)) {
        return;
      }
      const refreshPrices = this.isPriceFreshnessStale(lockedManifest);
      const refreshFundamentals = this.isFundamentalsFreshnessStale(lockedManifest);
      if (!refreshPrices && !refreshFundamentals) {
        return;
      }

      lease.assertOwned();
      const hydrating = this.hydratingManifest(security, lockedManifest);
      if (!(await this.cache.beginRefresh(lockedManifest, hydrating))) {
        await this.hydrateWithinLease(security, lease);
        return;
      }

      const target = this.canonicalTarget(security);
      let prices = await this.store.getDailyPrices(security.id, target);
      let lastPriceRefreshAt = lockedManifest.lastPriceRefreshAt;
      if (refreshPrices) {
        const refreshed = await this.refreshPriceWithinLease(
          security,
          target,
          hydrating,
          lease,
        );
        prices = refreshed.prices;
        lastPriceRefreshAt = refreshed.lastPriceRefreshAt;
      }

      let lastFundamentalsRefreshAt = lockedManifest.lastFundamentalsRefreshAt;
      if (refreshFundamentals) {
        lastFundamentalsRefreshAt = await this.refreshFundamentalsWithinLease(
          security,
          target,
          hydrating,
          lease,
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
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    const [profile, prices, dailyState] = await Promise.all([
      this.store.getProfile(security.id),
      this.readDailyPriceProjection(security, bounded),
      this.readDailyDerivedStateProjection(security, bounded),
    ]);
    return {
      security,
      ...(profile ? { profile } : {}),
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

  async getDailyPrices(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.readDailyPriceProjection(security, bounded);
  }

  /** Canonical daily derived read used by Stock Details projections and future backtests. */
  async getDailyDerivedState(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.readDailyDerivedStateProjection(security, bounded);
  }

  async getDailyTechnicals(symbol: string, range: DateRange) {
    return (await this.getDailyDerivedState(symbol, range)).map(
      toDailyTechnical,
    );
  }

  async getFinancialStatements(
    symbol: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    const bounded = this.boundFinancialQuery(security, query);
    if (bounded.from && bounded.to && bounded.from > bounded.to) {
      return [];
    }
    const observedManifest = await this.cache.getManifest(security.id);
    let cached = await this.cache.readFinancialStatements(security.id, bounded);
    if (cached) {
      return cached;
    }
    await this.cache.invalidateManifest(observedManifest);
    await this.ensureStockHydrated(security);
    cached = await this.cache.readFinancialStatements(security.id, bounded);
    return cached ?? this.store.getFinancialStatements(security.id, bounded);
  }

  async getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    const bounded = this.intrinsicReadRange(security, query);
    if (!bounded) {
      return [];
    }
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
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    const bounded = this.intrinsicReadRange(security, query);
    if (!bounded) {
      return [];
    }
    return toIntrinsicValueBlendPoints(
      await this.readDailyDerivedStateProjection(security, bounded),
      query,
    );
  }

  private async hydrateWithinLease(
    security: Security,
    lease: LoadLease,
  ): Promise<void> {
    const afterLock = await this.cache.getManifest(security.id);
    if (this.isReady(afterLock)) {
      return;
    }
    const target = this.canonicalTarget(security);
    const hydrating = this.hydratingManifest(security, afterLock, target);
    lease.assertOwned();
    if (!(await this.cache.beginHydration(afterLock, hydrating))) {
      const current = await this.cache.getManifest(security.id);
      if (this.isReady(current)) {
        return;
      }
      throw new Error("Stock cache hydration generation changed");
    }

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
    const missing = missingCoverageRanges(target, coverage).map((range) =>
      this.requireBoundedRange(range),
    );
    const loaded = [];
    for (const delta of missing) {
      loaded.push(
        ...(await this.provider.getDailyPrices(
          security.symbol,
          security.id,
          delta,
        )),
      );
    }
    lease.assertOwned();
    const priceChange =
      missing.length === 0
        ? {}
        : await this.store.saveDailyPriceSync({
            securityId: security.id,
            prices: loaded,
            successfulCoverage: missing,
            syncedAt: this.nowInstant(),
            tailDate: target.to,
            ...(missing.some(
              (range) => range.from <= target.to && range.to >= target.to,
            )
              ? { freshThrough: target.to }
              : {}),
            assertOwned: lease.assertOwned,
          });
    lease.assertOwned();

    const prices = await this.store.getDailyPrices(security.id, target);
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
    const derivedRecalculationStart =
      derivedRepairStart ??
      (priceChange.earliestChangedDate
        ? this.recalculationStart(
            target,
            previousPriceState,
            priceChange.earliestChangedDate,
            undefined,
          )
        : undefined);
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
    await this.cache.setSecurity(security, hydrating);
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
    const lastFundamentalsRefreshAt =
      await this.hydrateFundamentalsWithinLease(security, target, hydrating, lease);
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
          lastFundamentalsRefreshAt,
        ),
      ))
    ) {
      throw new Error("Stock cache hydration generation changed");
    }
  }

  private async readDailyPriceProjection(
    security: Security,
    requested: Required<DateRange>,
  ) {
    const projection = this.projectionRange(security, requested);
    if (!projection) {
      return [];
    }
    const observedManifest = await this.cache.getManifest(security.id);
    let result = await this.cache.readDailyPrices(security.id, projection);
    if (result) {
      return result;
    }
    await this.cache.invalidateManifest(observedManifest);
    await this.ensureStockHydrated(security);
    result = await this.cache.readDailyPrices(security.id, projection);
    return result ?? this.store.getDailyPrices(security.id, projection);
  }

  private async readDailyDerivedStateProjection(
    security: Security,
    requested: Required<DateRange>,
  ): Promise<DailyDerivedState[]> {
    const projection = this.projectionRange(security, requested);
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
    await this.ensureStockHydrated(security);
    result = await this.cache.readDailyDerivedState(security.id, projection);
    if (result && result.length > 0) {
      return result;
    }
    return this.store.getDailyDerivedState(security.id, projection);
  }

  /**
   * Bounds an intrinsic-value query to a readable range.
   *
   * `asOf` narrows the upper bound: nothing effective after the requested point in time may be
   * returned. Values are materialized only once eligible, so no further look-ahead filter is
   * needed beyond the row's own `intrinsicSourceDataAsOf` guard applied during projection.
   */
  private intrinsicReadRange(
    security: Security,
    query: DateRange & { asOf?: string },
  ): Required<DateRange> | null {
    const target = this.canonicalTarget(security);
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

  private async hydrateFundamentalsWithinLease(
    security: Security,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<string | undefined> {
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
    if (missing.length > 0) {
      await this.runFundamentalsOperationsToSettlement(
        missing,
        (operation) =>
          this.syncFundamentalsOperation({
            security,
            target,
            operation,
            limit: this.fundamentalsBackfillLimit(operation.cadence),
            lease,
          }),
      );
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
      target,
      hydrating,
      lease,
    );
    return this.oldestRequiredSyncAt(states);
  }

  /**
   * Recalculates and replaces the unified daily derived state from `from` through the target end.
   *
   * Full price history is used so moving-average warm-up and completed-week carry-forward are
   * correct, then only the affected trading days are written. Persisting replaces those rows: there
   * is one current methodology per `(securityId, date)` and no version history.
   */
  private async rebuildDailyDerivedState(
    security: Security,
    target: Required<DateRange>,
    prices: readonly DailyPrice[],
    from: string,
    lease: LoadLease,
  ): Promise<DailyDerivedState[]> {
    const weeklyBars = aggregateCompletedWeeks(
      prices,
      target.to,
      this.weeklyHistoryContext(security, target),
    );
    const rows = buildDailyDerivedState({ prices, weeklyBars }).filter(
      (row) => row.date >= from,
    );
    const weeklyDelta = weeklyBars.filter(
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

  private async refreshPriceWithinLease(
    security: Security,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<{ prices: DailyPrice[]; lastPriceRefreshAt: string }> {
    const refreshRange = {
      from: maxDate(addDays(target.to, -this.recentTailCalendarDays), target.from),
      to: target.to,
    };
    const previousState = await this.store.getDatasetState(
      security.id,
      "DAILY_PRICE",
      DAILY_PRICE_VARIANT,
    );
    const loaded = await this.provider.getDailyPrices(
      security.symbol,
      security.id,
      refreshRange,
    );
    const syncedAt = this.nowInstant();
    lease.assertOwned();
    const change = await this.store.saveDailyPriceSync({
      securityId: security.id,
      prices: loaded,
      successfulCoverage: [refreshRange],
      syncedAt,
      tailDate: target.to,
      freshThrough: target.to,
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
    await this.rebuildDailyDerivedState(
      security,
      target,
      allPrices,
      derivedRebuildStart,
      lease,
    );
    lease.assertOwned();

    if (change.earliestChangedDate) {
      const affectedRange = yearBoundedRange(change.earliestChangedDate, target.to);
      await this.cache.writeDailyPriceYears(
        security.id,
        await this.store.getDailyPrices(security.id, affectedRange),
        yearsInRange(affectedRange),
        hydrating,
      );
    }
    await this.publishDailyDerivedStateYears(
      security,
      derivedRebuildStart,
      target,
      hydrating,
    );

    return { prices: allPrices, lastPriceRefreshAt: syncedAt };
  }

  private async refreshFundamentalsWithinLease(
    security: Security,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<string> {
    const operations = this.fundamentalsOperationsForHistory();
    const results = await this.runFundamentalsOperationsToSettlement(
      operations,
      (operation) =>
        this.syncFundamentalsOperation({
          security,
          target,
          operation,
          limit: this.fundamentalsRefreshLimit(operation.cadence),
          lease,
        }),
    );
    lease.assertOwned();

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
    return this.nowInstant();
  }

  private async publishAllFundamentalsYears(
    securityId: string,
    target: Required<DateRange>,
    hydrating: StockManifest,
    lease: LoadLease,
  ): Promise<void> {
    const years = yearsInRange(target);
    for (const operation of this.fundamentalsOperationsForHistory()) {
      const rows = await this.store.getFinancialStatementRevisions({
        securityId,
        statementType: operation.statementType,
        cadence: operation.cadence,
        from: target.from,
        to: target.to,
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
    target: Required<DateRange>;
    operation: FundamentalsOperation;
    limit: number;
    lease: LoadLease;
  }): Promise<{
    operation: FundamentalsOperation;
    changedYears: number[];
  }> {
    const loaded = await this.provider.getFinancialStatements(
      input.security.symbol,
      input.security.id,
      input.operation.statementType,
      input.operation.cadence,
      input.limit,
    );
    const statements = loaded
      .filter((statement) => statement.fiscalDate >= input.target.from)
      .filter((statement) => statement.fiscalDate <= input.target.to);
    const syncedAt = this.nowInstant();
    input.lease.assertOwned();
    const saved = await this.store.saveFinancialStatements({
      securityId: input.security.id,
      statements,
      syncedAt,
    });
    input.lease.assertOwned();
    const sortedFiscalDates = statements.map((statement) => statement.fiscalDate).sort();
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
                statements.map((statement) => Number(statement.fiscalDate.slice(0, 4))),
              ),
            ].sort((left, right) => left - right)
          : [],
    };
  }

  private fundamentalsOperationsForHistory() {
    const cadences: readonly FinancialStatementCadence[] = [
      QUARTERLY_CADENCE,
      ANNUAL_CADENCE,
    ];
    return FINANCIAL_STATEMENT_TYPES.flatMap((statementType) =>
      cadences.map((cadence) => ({
        statementType,
        cadence,
        dataset: FUNDAMENTALS_DATASET_BY_TYPE[statementType],
        variant: this.fundamentalsVariant(cadence),
      })),
    );
  }

  private async runFundamentalsOperationsToSettlement<T>(
    operations: readonly FundamentalsOperation[],
    run: (operation: FundamentalsOperation) => Promise<T>,
  ): Promise<T[]> {
    const settled = await Promise.allSettled(operations.map((operation) => run(operation)));
    const firstRejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (firstRejected) {
      throw toError(firstRejected.reason);
    }
    return settled.map(
      (result) => (result as PromiseFulfilledResult<T>).value,
    );
  }

  private fundamentalsVariant(cadence: FinancialStatementCadence): string {
    const cadenceKey = cadence === QUARTERLY_CADENCE ? "quarter" : "annual";
    return `standard:${cadenceKey}:v${FUNDAMENTALS_VARIANT_VERSION}:h${this.historyYears}`;
  }

  private fundamentalsBackfillLimit(cadence: FinancialStatementCadence): number {
    return cadence === QUARTERLY_CADENCE
      ? this.historyYears * 4 + FUNDAMENTALS_BACKFILL_QUARTERLY_TAIL
      : this.historyYears + FUNDAMENTALS_BACKFILL_ANNUAL_TAIL;
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
    const target = this.canonicalTarget(security);
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
      historyYears: this.historyYears,
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
    };
  }

  private hydratingManifest(
    security: Security,
    previous: StockManifest | null,
    target = this.canonicalTarget(security),
  ): StockManifest {
    return {
      ...(previous ?? {}),
      securityId: security.id,
      status: "HYDRATING",
      historyYears: this.historyYears,
      coverageStart: target.from,
      coverageEnd: target.to,
      hydrationId: randomUUID(),
      hydratingAt: this.nowInstant(),
      priceDatasetVersion: PRICE_DATASET_VERSION,
      financialStatementVersion: FINANCIAL_STATEMENT_VERSION,
      derivedStateRevision: DERIVED_STATE_REVISION,
    };
  }

  private isReady(manifest: StockManifest | null): manifest is StockManifest {
    return (
      manifest?.status === "READY" &&
      manifest.historyYears === this.historyYears &&
      manifest.priceDatasetVersion === PRICE_DATASET_VERSION &&
      manifest.financialStatementVersion === FINANCIAL_STATEMENT_VERSION &&
      manifest.derivedStateRevision === DERIVED_STATE_REVISION
    );
  }

  private isPriceFreshnessStale(manifest: StockManifest | null): boolean {
    if (!this.isReady(manifest) || !manifest.lastPriceRefreshAt) {
      return true;
    }
    const lastRefresh = Date.parse(manifest.lastPriceRefreshAt);
    return (
      !Number.isFinite(lastRefresh) ||
      this.now().valueOf() - lastRefresh >= this.recentPriceFreshnessMs
    );
  }

  private isFundamentalsFreshnessStale(manifest: StockManifest | null): boolean {
    if (!this.isReady(manifest) || !manifest.lastFundamentalsRefreshAt) {
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

  private canonicalTarget(security: Security): Required<DateRange> {
    const today = this.today();
    const horizonStart = subtractYears(today, this.historyYears);
    return {
      from: security.ipoDate
        ? maxDate(horizonStart, security.ipoDate)
        : horizonStart,
      to: today,
    };
  }

  private weeklyHistoryContext(
    security: Security,
    target: Required<DateRange>,
  ) {
    return {
      historyStart: target.from,
      historyStartOrigin:
        security.ipoDate && security.ipoDate >= target.from
          ? ("LISTING" as const)
          : ("HORIZON" as const),
    };
  }

  private projectionRange(
    security: Security,
    requested: Required<DateRange>,
  ): Required<DateRange> | null {
    const target = this.canonicalTarget(security);
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

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private nowInstant(): string {
    return this.now().toISOString();
  }
}

/** Daily technical projection over the unified derived state. */
function toDailyTechnical(row: DailyDerivedState): DailyTechnical {
  return {
    securityId: row.securityId,
    date: row.date,
    ...(row.sma20d === undefined ? {} : { sma20d: row.sma20d }),
    ...(row.sma50d === undefined ? {} : { sma50d: row.sma50d }),
    ...(row.sma100d === undefined ? {} : { sma100d: row.sma100d }),
    ...(row.sma200d === undefined ? {} : { sma200d: row.sma200d }),
    ...(row.ema20d === undefined ? {} : { ema20d: row.ema20d }),
    ...(row.ema50d === undefined ? {} : { ema50d: row.ema50d }),
    ...(row.ema200d === undefined ? {} : { ema200d: row.ema200d }),
  };
}

/**
 * Point-in-time guard shared by both intrinsic projections.
 *
 * Materialization only writes eligible values, so this is a defensive assertion of the
 * no-look-ahead invariant rather than the primary filter.
 */
function isIntrinsicVisible(row: DailyDerivedState, asOf?: string): boolean {
  if (asOf && row.date > asOf) {
    return false;
  }
  if (!row.intrinsicSourceDataAsOf) {
    return false;
  }
  return row.intrinsicSourceDataAsOf <= endOfLocalDate(asOf ?? row.date);
}

function toIntrinsicValuePoints(
  rows: readonly DailyDerivedState[],
  query: IntrinsicValueQuery,
): IntrinsicValuePoint[] {
  const models = query.models ?? INTRINSIC_VALUE_MODELS;
  return rows.flatMap((row) => {
    if (!isIntrinsicVisible(row, query.asOf)) {
      return [];
    }
    return models.flatMap((model) => {
      const valuePerShare = row.intrinsicValues?.[model];
      return valuePerShare === undefined || !row.intrinsicCurrency
        ? []
        : [
            {
              securityId: row.securityId,
              valuationDate: row.date,
              sourceDataAsOf: row.intrinsicSourceDataAsOf as string,
              model,
              valuePerShare,
              currency: row.intrinsicCurrency,
            },
          ];
    });
  });
}

function toIntrinsicValueBlendPoints(
  rows: readonly DailyDerivedState[],
  query: IntrinsicValueBlendQuery,
): IntrinsicValueBlendPoint[] {
  const blendIds = query.blendIds ?? INTRINSIC_VALUE_BLEND_IDS;
  return rows.flatMap((row) => {
    if (!isIntrinsicVisible(row, query.asOf)) {
      return [];
    }
    return blendIds.flatMap((blendId) => {
      const valuePerShare = row.intrinsicValueBlends?.[blendId];
      return valuePerShare === undefined || !row.intrinsicCurrency
        ? []
        : [
            {
              securityId: row.securityId,
              valuationDate: row.date,
              sourceDataAsOf: row.intrinsicSourceDataAsOf as string,
              blendId,
              valuePerShare,
              currency: row.intrinsicCurrency,
            },
          ];
    });
  });
}

function subtractYears(value: string, years: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right;
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
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
