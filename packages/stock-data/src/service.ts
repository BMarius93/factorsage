import { randomUUID } from "node:crypto";
import {
  INTRINSIC_VALUE_BLENDS,
  INTRINSIC_VALUE_BLEND_IDS,
  type DateRange,
  type FinancialStatement,
  type FinancialStatementQuery,
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
  PRICE_DATASET_VERSION,
  yearsInRange,
  type StockDataCache,
  type StockManifest,
} from "./cache.js";
import type { LoadLease, LoadCoordinator } from "./coordination.js";
import { addDays, assertDateRange, missingCoverageRanges } from "./dates.js";
import { calculateBlend } from "./intrinsic-values.js";
import {
  DAILY_PRICE_VARIANT,
  type PersistedDatasetState,
  type StockDataStore,
} from "./ports.js";
import {
  calculateDailyTechnicals,
  DAILY_TECHNICAL_CALCULATION_VERSION,
} from "./technicals.js";
import {
  aggregateCompletedWeeks,
  startOfIsoWeek,
  WEEKLY_AGGREGATION_CALCULATION_VERSION,
} from "./weekly.js";

const DAILY_TECHNICAL_VARIANT = `1D:v${DAILY_TECHNICAL_CALCULATION_VERSION}`;
const WEEKLY_PRICE_VARIANT = `1W:v${WEEKLY_AGGREGATION_CALCULATION_VERSION}`;

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
  recentTailCalendarDays?: number;
  now?: () => Date;
};

export class CanonicalStockDataService implements StockDataService {
  private readonly defaultHistoryDays: number;
  private readonly historyYears: number;
  private readonly recentPriceFreshnessMs: number;
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
    this.recentTailCalendarDays = options.recentTailCalendarDays ?? 10;
    this.now = options.now ?? (() => new Date());
    for (const [name, value] of Object.entries({
      defaultHistoryDays: this.defaultHistoryDays,
      historyYears: this.historyYears,
      recentPriceFreshnessMs: this.recentPriceFreshnessMs,
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
    if (!this.isFreshnessStale(manifest)) {
      return;
    }

    await this.coordinator.run(this.stockResource(security), async (lease) => {
      let lockedManifest = await this.cache.getManifest(security.id);
      if (!this.isReady(lockedManifest)) {
        await this.hydrateWithinLease(security, lease);
        lockedManifest = await this.cache.getManifest(security.id);
      }
      if (
        !this.isReady(lockedManifest) ||
        !this.isFreshnessStale(lockedManifest)
      ) {
        return;
      }
      lease.assertOwned();
      const hydrating = this.hydratingManifest(security, lockedManifest);
      if (!(await this.cache.beginRefresh(lockedManifest, hydrating))) {
        await this.hydrateWithinLease(security, lease);
        return;
      }

      const target = this.canonicalTarget(security);
      const refreshRange = {
        from: maxDate(
          addDays(target.to, -this.recentTailCalendarDays),
          target.from,
        ),
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
      lease.assertOwned();
      const change = await this.store.saveDailyPriceSync({
        securityId: security.id,
        prices: loaded,
        successfulCoverage: [refreshRange],
        syncedAt: this.nowInstant(),
        tailDate: target.to,
        freshThrough: target.to,
        assertOwned: lease.assertOwned,
      });
      lease.assertOwned();

      const allPrices = await this.store.getDailyPrices(security.id, target);
      const weeklyPrices = aggregateCompletedWeeks(
        allPrices,
        target.to,
        WEEKLY_AGGREGATION_CALCULATION_VERSION,
        this.weeklyHistoryContext(security, target),
      );
      const weeklyRefreshStart = startOfIsoWeek(addDays(refreshRange.from, -7));
      let recalculationStart: string | undefined;
      if (change.earliestChangedDate) {
        recalculationStart =
          previousState?.earliestDate &&
          change.earliestChangedDate < previousState.earliestDate
            ? target.from
            : change.earliestChangedDate;
      }
      const technicals = recalculationStart
        ? calculateDailyTechnicals(allPrices).filter(
            (row) => row.date >= recalculationStart,
          )
        : [];
      const weeklyDelta = weeklyPrices.filter(
        (row) => row.weekStartDate >= weeklyRefreshStart,
      );
      if (technicals.length > 0 || weeklyDelta.length > 0) {
        lease.assertOwned();
        await this.store.saveDerivedTechnicals({
          securityId: security.id,
          technicals,
          weeklyPrices: weeklyDelta,
          successfulCoverage: {
            from: recalculationStart ?? weeklyRefreshStart,
            to: target.to,
          },
          syncedAt: this.nowInstant(),
          dailyTechnicalCalculationVersion: DAILY_TECHNICAL_CALCULATION_VERSION,
          weeklyCalculationVersion: WEEKLY_AGGREGATION_CALCULATION_VERSION,
          assertOwned: lease.assertOwned,
        });
      }
      lease.assertOwned();

      if (change.earliestChangedDate) {
        const affectedRange = yearBoundedRange(
          change.earliestChangedDate,
          target.to,
        );
        const affectedYears = yearsInRange(affectedRange);
        await this.cache.writeDailyPriceYears(
          security.id,
          await this.store.getDailyPrices(security.id, affectedRange),
          affectedYears,
          hydrating,
        );
        await this.cache.writeDailyTechnicalYears(
          security.id,
          await this.store.getDailyTechnicals(
            security.id,
            affectedRange,
            DAILY_TECHNICAL_CALCULATION_VERSION,
          ),
          affectedYears,
          DAILY_TECHNICAL_CALCULATION_VERSION,
          hydrating,
        );
      }
      const affectedWeeklyYears = yearsInRange(
        yearBoundedRange(weeklyRefreshStart, target.to),
      );
      await this.cache.writeWeeklyPriceYears(
        security.id,
        weeklyPrices,
        affectedWeeklyYears,
        WEEKLY_AGGREGATION_CALCULATION_VERSION,
        hydrating,
      );
      lease.assertOwned();
      if (
        !(await this.cache.completeHydration(
          hydrating,
          this.readyManifest(
            security,
            target,
            allPrices,
            lockedManifest.hydratedAt ?? this.nowInstant(),
            this.nowInstant(),
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
    const [profile, prices, technicals, intrinsicValues, intrinsicValueBlends] =
      await Promise.all([
        this.store.getProfile(security.id),
        this.readDailyPriceProjection(security, bounded),
        this.readDailyTechnicalProjection(security, bounded),
        this.store.getIntrinsicValues(security.id, {
          ...bounded,
          asOf: bounded.to,
        }),
        this.completeIntrinsicValueBlends(security, {
          ...bounded,
          asOf: bounded.to,
        }),
      ]);
    return {
      security,
      ...(profile ? { profile } : {}),
      prices,
      technicals,
      intrinsicValues,
      intrinsicValueBlends,
    };
  }

  async getDailyPrices(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.readDailyPriceProjection(security, bounded);
  }

  async getDailyTechnicals(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.readDailyTechnicalProjection(security, bounded);
  }

  async getFinancialStatements(
    symbol: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.store.getFinancialStatements(security.id, query);
  }

  async getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.store.getIntrinsicValues(security.id, query);
  }

  async getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]> {
    assertDateRange(query);
    const security = await this.getSecurity(symbol);
    await this.ensureStockHydrated(security);
    await this.ensureStockFresh(security);
    return this.completeIntrinsicValueBlends(security, query);
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
    const technicalState = await this.store.getDatasetState(
      security.id,
      "DAILY_TECHNICAL",
      DAILY_TECHNICAL_VARIANT,
    );
    const weeklyState = await this.store.getDatasetState(
      security.id,
      "WEEKLY_PRICE",
      WEEKLY_PRICE_VARIANT,
    );
    const technicalCoverage =
      technicalState?.calculationVersion === DAILY_TECHNICAL_CALCULATION_VERSION
        ? await this.store.getDatasetCoverage(
            security.id,
            "DAILY_TECHNICAL",
            DAILY_TECHNICAL_VARIANT,
            target,
          )
        : [];
    const technicalCoverageGaps = missingCoverageRanges(
      target,
      technicalCoverage,
    );
    const firstTechnicalGapStart = technicalCoverageGaps[0]?.from ?? target.from;
    const technicalRepairStart =
      technicalState?.calculationVersion !==
        DAILY_TECHNICAL_CALCULATION_VERSION ||
      technicalCoverageGaps.length > 0
        ? firstTechnicalGapStart
        : undefined;
    const weeklyRepairStart =
      weeklyState?.calculationVersion !== WEEKLY_AGGREGATION_CALCULATION_VERSION
        ? target.from
        : undefined;
    const technicalRecalculationStart =
      technicalRepairStart ??
      (priceChange.earliestChangedDate
        ? this.recalculationStart(
            target,
            previousPriceState,
            priceChange.earliestChangedDate,
            undefined,
          )
        : undefined);
    const weeklyRecalculationStart =
      weeklyRepairStart ??
      (priceChange.earliestChangedDate
        ? this.recalculationStart(
            target,
            previousPriceState,
            priceChange.earliestChangedDate,
            undefined,
          )
        : undefined);
    const recalculatedTechnicals = technicalRecalculationStart
      ? calculateDailyTechnicals(prices).filter(
          (row) => row.date >= technicalRecalculationStart,
        )
      : [];
    const recalculatedWeeklyPrices = weeklyRecalculationStart
      ? aggregateCompletedWeeks(
          prices,
          target.to,
          WEEKLY_AGGREGATION_CALCULATION_VERSION,
          this.weeklyHistoryContext(security, target),
        ).filter(
          (row) => row.weekStartDate >= startOfIsoWeek(weeklyRecalculationStart),
        )
      : [];
    if (recalculatedTechnicals.length > 0 || recalculatedWeeklyPrices.length > 0) {
      lease.assertOwned();
      await this.store.saveDerivedTechnicals({
        securityId: security.id,
        technicals: recalculatedTechnicals,
        weeklyPrices: recalculatedWeeklyPrices,
        successfulCoverage: {
          from: minDate(
            technicalRecalculationStart ?? target.from,
            weeklyRecalculationStart ?? target.from,
          ),
          to: target.to,
        },
        syncedAt: this.nowInstant(),
        dailyTechnicalCalculationVersion: DAILY_TECHNICAL_CALCULATION_VERSION,
        weeklyCalculationVersion: WEEKLY_AGGREGATION_CALCULATION_VERSION,
        assertOwned: lease.assertOwned,
      });
    }

    const [persistedTechnicals, persistedWeeklyPrices, tailRefreshAt] =
      await Promise.all([
        this.store.getDailyTechnicals(
          security.id,
          target,
          DAILY_TECHNICAL_CALCULATION_VERSION,
        ),
        this.store.getWeeklyPrices(
          security.id,
          target,
          WEEKLY_AGGREGATION_CALCULATION_VERSION,
        ),
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
    await this.cache.writeDailyTechnicalYears(
      security.id,
      persistedTechnicals,
      years,
      DAILY_TECHNICAL_CALCULATION_VERSION,
      hydrating,
    );
    await this.cache.writeWeeklyPriceYears(
      security.id,
      persistedWeeklyPrices,
      years,
      WEEKLY_AGGREGATION_CALCULATION_VERSION,
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

  private async readDailyTechnicalProjection(
    security: Security,
    requested: Required<DateRange>,
  ) {
    const projection = this.projectionRange(security, requested);
    if (!projection) {
      return [];
    }
    const observedManifest = await this.cache.getManifest(security.id);
    let result = await this.cache.readDailyTechnicals(
      security.id,
      projection,
      DAILY_TECHNICAL_CALCULATION_VERSION,
    );
    if (
      result &&
      result.some((row) =>
        [
          row.sma20d,
          row.sma50d,
          row.sma100d,
          row.sma200d,
          row.ema20d,
          row.ema50d,
          row.ema200d,
        ].some((value) => value !== undefined),
      )
    ) {
      return result;
    }
    await this.cache.invalidateManifest(observedManifest);
    await this.ensureStockHydrated(security);
    result = await this.cache.readDailyTechnicals(
      security.id,
      projection,
      DAILY_TECHNICAL_CALCULATION_VERSION,
    );
    if (
      result &&
      result.some((row) =>
        [
          row.sma20d,
          row.sma50d,
          row.sma100d,
          row.sma200d,
          row.ema20d,
          row.ema50d,
          row.ema200d,
        ].some((value) => value !== undefined),
      )
    ) {
      return result;
    }
    return this.store.getDailyTechnicals(
      security.id,
      projection,
      DAILY_TECHNICAL_CALCULATION_VERSION,
    );
  }

  private async completeIntrinsicValueBlends(
    security: Security,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]> {
    const persisted = await this.store.getIntrinsicValueBlends(
      security.id,
      query,
    );
    const effectiveTo = minOptionalDate(query.to, query.asOf);
    const points = await this.store.getIntrinsicValuesForBlend(security.id, {
      ...(effectiveTo ? { to: effectiveTo } : {}),
      ...(query.asOf ? { asOf: query.asOf } : {}),
    });
    const dates = [
      ...new Set([
        ...persisted.map((point) => point.valuationDate),
        ...points.map((point) => point.valuationDate),
      ]),
    ]
      .filter((date) => !query.from || date >= query.from)
      .filter((date) => !effectiveTo || date <= effectiveTo)
      .sort();
    const blendIds = query.blendIds ?? INTRINSIC_VALUE_BLEND_IDS;
    const byIdentity = new Map<string, IntrinsicValueBlendPoint>();
    for (const point of persisted) {
      byIdentity.set(`${point.valuationDate}:${point.blendId}`, point);
    }
    for (const blendId of blendIds) {
      for (const valuationDate of dates) {
        const identity = `${valuationDate}:${blendId}`;
        if (byIdentity.has(identity)) {
          continue;
        }
        const result = calculateBlend(
          INTRINSIC_VALUE_BLENDS[blendId],
          points,
          valuationDate,
        );
        if (result.status === "AVAILABLE") {
          byIdentity.set(identity, result.point);
        }
      }
    }
    return [...byIdentity.values()]
      .filter((point) => blendIds.includes(point.blendId))
      .sort(
        (left, right) =>
          left.valuationDate.localeCompare(right.valuationDate) ||
          left.blendId.localeCompare(right.blendId),
      );
  }

  private readyManifest(
    security: Security,
    target: Required<DateRange>,
    prices: readonly { date: string }[],
    hydratedAt: string,
    lastPriceRefreshAt?: string,
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
      priceDatasetVersion: PRICE_DATASET_VERSION,
      dailyTechnicalVersion: DAILY_TECHNICAL_CALCULATION_VERSION,
      weeklyVersion: WEEKLY_AGGREGATION_CALCULATION_VERSION,
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
      dailyTechnicalVersion: DAILY_TECHNICAL_CALCULATION_VERSION,
      weeklyVersion: WEEKLY_AGGREGATION_CALCULATION_VERSION,
    };
  }

  private isReady(manifest: StockManifest | null): manifest is StockManifest {
    return (
      manifest?.status === "READY" &&
      manifest.historyYears === this.historyYears &&
      manifest.priceDatasetVersion === PRICE_DATASET_VERSION &&
      manifest.dailyTechnicalVersion === DAILY_TECHNICAL_CALCULATION_VERSION &&
      manifest.weeklyVersion === WEEKLY_AGGREGATION_CALCULATION_VERSION
    );
  }

  private isFreshnessStale(manifest: StockManifest | null): boolean {
    if (!this.isReady(manifest) || !manifest.lastPriceRefreshAt) {
      return true;
    }
    const lastRefresh = Date.parse(manifest.lastPriceRefreshAt);
    return (
      !Number.isFinite(lastRefresh) ||
      this.now().valueOf() - lastRefresh >= this.recentPriceFreshnessMs
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
