import {
  INTRINSIC_VALUE_BLENDS,
  INTRINSIC_VALUE_BLEND_IDS,
  type DateRange,
  type IntrinsicValueBlendPoint,
  type IntrinsicValueBlendQuery,
  type IntrinsicValuePoint,
  type IntrinsicValueQuery,
  type Security,
  type StockDataService,
  type StockDetails,
} from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import type { StockDataCache } from "./cache.js";
import type { LoadCoordinator } from "./coordination.js";
import { addDays, assertDateRange, missingCoverageRanges } from "./dates.js";
import { calculateBlend } from "./intrinsic-values.js";
import type { StockDataStore } from "./ports.js";
import {
  calculateDailyTechnicals,
  DAILY_TECHNICAL_CALCULATION_VERSION,
} from "./technicals.js";
import { aggregateCompletedWeeks } from "./weekly.js";

const DAILY_PRICE_VARIANT = "split-adjusted-eod-full";

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
  technicalWarmupCalendarDays?: number;
  now?: () => Date;
};

export class CanonicalStockDataService implements StockDataService {
  private readonly defaultHistoryDays: number;
  private readonly technicalWarmupCalendarDays: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: StockDataStore,
    private readonly provider: FmpStockProviderPort,
    private readonly cache: StockDataCache,
    private readonly coordinator: LoadCoordinator,
    options: CanonicalStockDataServiceOptions = {},
  ) {
    this.defaultHistoryDays = options.defaultHistoryDays ?? 365;
    this.technicalWarmupCalendarDays =
      options.technicalWarmupCalendarDays ?? 400;
    this.now = options.now ?? (() => new Date());
  }

  async getSecurity(symbol: string): Promise<Security> {
    const normalized = this.normalizeSymbol(symbol);
    const cached = await this.cache.get<Security>(normalized, "security");
    if (cached) {
      return cached;
    }
    const persisted = await this.store.findSecurityByProviderSymbol(normalized);
    if (persisted) {
      await this.cache.set(normalized, "security", persisted);
      return persisted;
    }

    return this.coordinator.run(`${normalized}:SECURITY_PROFILE`, async () => {
      const afterLock =
        await this.store.findSecurityByProviderSymbol(normalized);
      if (afterLock) {
        await this.cache.set(normalized, "security", afterLock);
        return afterLock;
      }
      const mapped = await this.provider.getProfile(normalized);
      if (!mapped) {
        throw new StockDataNotFoundError(normalized);
      }
      const saved = await this.store.saveSecurityProfile(
        mapped,
        this.now().toISOString(),
      );
      await this.cache.evict(normalized);
      await this.cache.set(normalized, "security", saved.security);
      return saved.security;
    });
  }

  async getStockDetails(
    symbol: string,
    range?: DateRange,
  ): Promise<StockDetails> {
    const bounded = this.defaultRange(range);
    const security = await this.getSecurity(symbol);
    const [profile, prices, technicals, intrinsicValues, intrinsicValueBlends] =
      await Promise.all([
        this.store.getProfile(security.id),
        this.getDailyPrices(symbol, bounded),
        this.getDailyTechnicals(symbol, bounded),
        this.getIntrinsicValues(symbol, { ...bounded, asOf: bounded.to }),
        this.getIntrinsicValueBlends(symbol, { ...bounded, asOf: bounded.to }),
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
    const normalized = this.normalizeSymbol(symbol);
    const security = await this.getSecurity(normalized);
    const cacheKey = this.rangeCacheKey("daily-prices", bounded);
    const cached = await this.cache.get<
      Awaited<ReturnType<StockDataStore["getDailyPrices"]>>
    >(normalized, cacheKey);
    if (cached) {
      return cached;
    }

    return this.coordinator.run(`${normalized}:DAILY_PRICE`, async () => {
      const afterLock = await this.cache.get<
        Awaited<ReturnType<StockDataStore["getDailyPrices"]>>
      >(normalized, cacheKey);
      if (afterLock) {
        return afterLock;
      }
      const coverage = await this.store.getDatasetCoverage(
        security.id,
        "DAILY_PRICE",
        DAILY_PRICE_VARIANT,
        bounded,
      );
      const missing = missingCoverageRanges(bounded, coverage);
      if (missing.length > 0) {
        const requested = missing.map((item) => this.requireBoundedRange(item));
        const loaded = await Promise.all(
          requested.map((delta) =>
            this.provider.getDailyPrices(normalized, security.id, delta),
          ),
        );
        await this.store.saveDailyPriceSync({
          securityId: security.id,
          prices: loaded.flat(),
          successfulCoverage: requested,
          syncedAt: this.now().toISOString(),
        });
        await this.cache.evict(normalized);
      }
      const result = await this.store.getDailyPrices(security.id, bounded);
      await this.cache.set(normalized, cacheKey, result);
      return result;
    });
  }

  async getDailyTechnicals(symbol: string, range: DateRange) {
    const bounded = this.requireBoundedRange(range);
    const normalized = this.normalizeSymbol(symbol);
    const warmupRange = {
      from: addDays(bounded.from, -this.technicalWarmupCalendarDays),
      to: bounded.to,
    };
    await this.getDailyPrices(normalized, warmupRange);
    const security = await this.getSecurity(normalized);
    const cacheKey = this.rangeCacheKey(
      `daily-technicals:v${DAILY_TECHNICAL_CALCULATION_VERSION}`,
      bounded,
    );
    const cached = await this.cache.get<
      Awaited<ReturnType<StockDataStore["getDailyTechnicals"]>>
    >(normalized, cacheKey);
    if (cached) {
      return cached;
    }

    return this.coordinator.run(`${normalized}:DAILY_TECHNICAL`, async () => {
      const state = await this.store.getDatasetState(
        security.id,
        "DAILY_TECHNICAL",
        `1D:v${DAILY_TECHNICAL_CALCULATION_VERSION}`,
      );
      const staleVersion =
        state?.calculationVersion !== DAILY_TECHNICAL_CALCULATION_VERSION;
      const coverage = staleVersion
        ? []
        : await this.store.getDatasetCoverage(
            security.id,
            "DAILY_TECHNICAL",
            `1D:v${DAILY_TECHNICAL_CALCULATION_VERSION}`,
            bounded,
          );
      if (staleVersion || missingCoverageRanges(bounded, coverage).length > 0) {
        const sourcePrices = await this.store.getDailyPrices(security.id, {
          to: bounded.to,
        });
        const technicals = calculateDailyTechnicals(sourcePrices);
        const weeklyPrices = aggregateCompletedWeeks(
          sourcePrices,
          this.now().toISOString().slice(0, 10),
        );
        await this.store.saveDerivedTechnicals({
          securityId: security.id,
          technicals,
          weeklyPrices,
          successfulCoverage: bounded,
          syncedAt: this.now().toISOString(),
          calculationVersion: DAILY_TECHNICAL_CALCULATION_VERSION,
        });
        await this.cache.evict(normalized);
      }
      const result = await this.store.getDailyTechnicals(
        security.id,
        bounded,
        DAILY_TECHNICAL_CALCULATION_VERSION,
      );
      await this.cache.set(normalized, cacheKey, result);
      return result;
    });
  }

  async getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]> {
    assertDateRange(query);
    const normalized = this.normalizeSymbol(symbol);
    const security = await this.getSecurity(normalized);
    const cacheKey = `intrinsic-values:${this.queryKey(query)}`;
    const cached = await this.cache.get<IntrinsicValuePoint[]>(
      normalized,
      cacheKey,
    );
    if (cached) {
      return cached;
    }
    const result = await this.store.getIntrinsicValues(security.id, query);
    await this.cache.set(normalized, cacheKey, result);
    return result;
  }

  async getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]> {
    assertDateRange(query);
    const normalized = this.normalizeSymbol(symbol);
    const security = await this.getSecurity(normalized);
    const cacheKey = `intrinsic-value-blends:${this.queryKey(query)}`;
    const cached = await this.cache.get<IntrinsicValueBlendPoint[]>(
      normalized,
      cacheKey,
    );
    if (cached) {
      return cached;
    }
    const persisted = await this.store.getIntrinsicValueBlends(
      security.id,
      query,
    );
    if (persisted.length > 0) {
      await this.cache.set(normalized, cacheKey, persisted);
      return persisted;
    }

    const points = await this.store.getIntrinsicValues(security.id, {
      to: query.to,
      asOf: query.asOf,
    });
    const dates = [...new Set(points.map((point) => point.valuationDate))]
      .filter((date) => !query.from || date >= query.from)
      .filter((date) => !query.to || date <= query.to)
      .filter((date) => !query.asOf || date <= query.asOf)
      .sort();
    const blendIds = query.blendIds ?? INTRINSIC_VALUE_BLEND_IDS;
    const calculated = blendIds.flatMap((blendId) =>
      dates.flatMap((valuationDate) => {
        const result = calculateBlend(
          INTRINSIC_VALUE_BLENDS[blendId],
          points,
          valuationDate,
        );
        return result.status === "AVAILABLE" ? [result.point] : [];
      }),
    );
    calculated.sort(
      (left, right) =>
        left.valuationDate.localeCompare(right.valuationDate) ||
        left.blendId.localeCompare(right.blendId),
    );
    await this.cache.set(normalized, cacheKey, calculated);
    return calculated;
  }

  private defaultRange(range?: DateRange): Required<DateRange> {
    const today = this.now().toISOString().slice(0, 10);
    const to = range?.to ?? today;
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

  private rangeCacheKey(prefix: string, range: Required<DateRange>): string {
    return `${prefix}:${range.from}:${range.to}`;
  }

  private queryKey(
    query: IntrinsicValueQuery | IntrinsicValueBlendQuery,
  ): string {
    return JSON.stringify(query, Object.keys(query).sort());
  }
}
