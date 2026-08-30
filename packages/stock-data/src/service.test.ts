import {
  FINANCIAL_STATEMENT_TYPES,
  selectFinancialStatements,
  type FinancialStatementCadence,
  FinancialStatement,
  FinancialStatementDraft,
  FinancialStatementQuery,
  DailyPrice,
  DailyDerivedState,
  DateRange,
  Security,
  SecurityProfile,
} from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import { describe, expect, it } from "vitest";
import type { StockDataCache, StockManifest } from "./cache.js";
import {
  InMemoryLoadCoordinator,
  type LoadCoordinator,
} from "./coordination.js";
import type {
  PersistedDatasetState,
  PersistedStockDataset,
  StockDataStore,
} from "./ports.js";
import { WEEKLY_PRICE_VARIANT } from "./ports.js";
import {
  assertOneRowPerTradingDay,
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";
import { CanonicalStockDataService } from "./service.js";
import type { WeeklyPrice } from "./weekly.js";

const NOW = "2026-08-24T12:00:00.000Z";
const CANONICAL_RANGE = { from: "1996-08-24", to: "2026-08-24" };

const security: Security = {
  id: "security-1",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

function price(date: string, close = 100): DailyPrice {
  return {
    securityId: security.id,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  };
}

class MemoryCache implements StockDataCache {
  readonly securities = new Map<string, Security>();
  readonly manifests = new Map<string, StockManifest>();
  readonly prices = new Map<string, DailyPrice[]>();
  readonly dailyState = new Map<string, DailyDerivedState[]>();
  readonly financials = new Map<string, FinancialStatement[]>();
  readonly priceYearWrites: number[][] = [];

  async getSecurity(symbol: string) {
    return this.securities.get(symbol) ?? null;
  }
  async setSecurity(value: Security, _hydrating?: StockManifest) {
    this.securities.set(value.symbol, value);
  }
  async getManifest(securityId: string) {
    return this.manifests.get(securityId) ?? null;
  }
  async setManifest(manifest: StockManifest) {
    this.manifests.set(manifest.securityId, manifest);
  }
  async beginHydration(
    observed: StockManifest | null,
    hydrating: StockManifest,
  ) {
    const current = this.manifests.get(hydrating.securityId) ?? null;
    if (JSON.stringify(current) !== JSON.stringify(observed)) {
      return false;
    }
    this.manifests.set(hydrating.securityId, hydrating);
    this.prices.delete(hydrating.securityId);
    this.dailyState.delete(hydrating.securityId);
    return true;
  }
  async beginRefresh(observed: StockManifest, hydrating: StockManifest) {
    if (
      JSON.stringify(this.manifests.get(observed.securityId)) !==
        JSON.stringify(observed) ||
      observed.status !== "READY"
    ) {
      return false;
    }
    this.manifests.set(observed.securityId, hydrating);
    return true;
  }
  async completeHydration(hydrating: StockManifest, ready: StockManifest) {
    if (
      JSON.stringify(this.manifests.get(hydrating.securityId)) !==
      JSON.stringify(hydrating)
    ) {
      return false;
    }
    this.manifests.set(ready.securityId, ready);
    return true;
  }
  async invalidateManifest(manifest: StockManifest | null) {
    if (!manifest || this.manifests.get(manifest.securityId) !== manifest) {
      return false;
    }
    this.manifests.delete(manifest.securityId);
    return true;
  }
  async readDailyPrices(securityId: string, range: Required<DateRange>) {
    if (this.manifests.get(securityId)?.status !== "READY") return null;
    const rows = this.prices.get(securityId);
    return rows ? slice(rows, range, (row) => row.date) : null;
  }
  async writeDailyPriceYears(
    securityId: string,
    rows: readonly DailyPrice[],
    years: readonly number[],
    _hydrating?: StockManifest,
  ) {
    this.priceYearWrites.push([...years]);
    this.prices.set(
      securityId,
      replaceYears(
        this.prices.get(securityId) ?? [],
        rows,
        years,
        (row) => row.date,
      ),
    );
  }
  async readDailyDerivedState(securityId: string, range: Required<DateRange>) {
    if (this.manifests.get(securityId)?.status !== "READY") return null;
    const rows = this.dailyState.get(securityId);
    return rows ? slice(rows, range, (row) => row.date) : null;
  }
  async writeDailyDerivedStateYears(
    securityId: string,
    rows: readonly DailyDerivedState[],
    years: readonly number[],
    _hydrating?: StockManifest,
  ) {
    this.dailyState.set(
      securityId,
      replaceYears(
        this.dailyState.get(securityId) ?? [],
        rows,
        years,
        (row) => row.date,
      ),
    );
  }
  async readFinancialStatements(
    securityId: string,
    query: FinancialStatementQuery,
  ) {
    const manifest = this.manifests.get(securityId);
    if (manifest?.status !== "READY") return null;
    const from = query.from ?? manifest.coverageStart;
    const to = query.to ?? manifest.coverageEnd;
    if (!from || !to || from > to) return [];
    const statementTypes = query.statementTypes ?? FINANCIAL_STATEMENT_TYPES;
    const cadences: readonly FinancialStatementCadence[] = query.cadence
      ? [query.cadence]
      : ["QUARTERLY", "ANNUAL"];
    const rangeYears = yearSpan(from, to);
    const rows: FinancialStatement[] = [];
    for (const statementType of statementTypes) {
      for (const cadence of cadences) {
        for (const year of rangeYears) {
          const key = `${securityId}:${statementType}:${cadence}:${year}`;
          const chunk = this.financials.get(key);
          if (!chunk) {
            return null;
          }
          rows.push(...chunk);
        }
      }
    }
    return selectFinancialStatements(
      rows.filter((row) => row.fiscalDate >= from && row.fiscalDate <= to),
      query,
    );
  }
  async writeFinancialStatementYears(
    securityId: string,
    rows: readonly FinancialStatement[],
    statementType: FinancialStatement["statementType"],
    cadence: FinancialStatementCadence,
    writeYears: readonly number[],
    _hydrating?: StockManifest,
  ) {
    for (const year of writeYears) {
      const key = `${securityId}:${statementType}:${cadence}:${year}`;
      this.financials.set(
        key,
        rows
          .filter((row) => Number(row.fiscalDate.slice(0, 4)) === year)
          .sort((left, right) => left.fiscalDate.localeCompare(right.fiscalDate)),
      );
    }
  }
  async hasResidentStock(securityId: string) {
    return this.manifests.get(securityId)?.status === "READY";
  }
  async touch(_securityId: string) {}
  async evict(securityId: string) {
    this.manifests.delete(securityId);
    this.prices.delete(securityId);
    this.dailyState.delete(securityId);
    for (const key of [...this.financials.keys()]) {
      if (key.startsWith(`${securityId}:`)) {
        this.financials.delete(key);
      }
    }
  }
}

class FakeProvider implements FmpStockProviderPort {
  profile: MappedFmpProfile | null = null;
  readonly ranges: Required<DateRange>[] = [];
  readonly financialRequests: Array<{
    statementType: FinancialStatementDraft["statementType"];
    cadence: "QUARTERLY" | "ANNUAL";
    limit: number;
  }> = [];
  rowsByRange = new Map<string, DailyPrice[]>();
  financialRows = new Map<string, FinancialStatementDraft[]>();
  financialDelays = new Map<string, Promise<void>>();
  financialStarted: string[] = [];
  financialCompleted: string[] = [];
  failure?: Error;
  financialFailures = new Map<string, Error>();
  beforeReturn?: () => Promise<void>;

  async getProfile() {
    return this.profile;
  }
  async getDailyPrices(_symbol: string, _securityId: string, range: DateRange) {
    if (!range.from || !range.to) throw new Error("Expected bounded range");
    this.ranges.push({ from: range.from, to: range.to });
    if (this.failure) throw this.failure;
    await this.beforeReturn?.();
    return this.rowsByRange.get(`${range.from}:${range.to}`) ?? [];
  }
  async getFinancialStatements(
    _symbol: string,
    _securityId: string,
    statementType: FinancialStatementDraft["statementType"],
    cadence: "QUARTERLY" | "ANNUAL",
    limit: number,
  ): Promise<FinancialStatementDraft[]> {
    this.financialRequests.push({ statementType, cadence, limit });
    const key = `${statementType}:${cadence}:${limit}`;
    this.financialStarted.push(key);
    const error = this.financialFailures.get(key);
    if (error) {
      throw error;
    }
    const delay = this.financialDelays.get(key);
    if (delay) {
      await delay;
    }
    this.financialCompleted.push(key);
    return this.financialRows.get(key) ?? [];
  }
}

class FakeStore implements StockDataStore {
  currentSecurity: Security | null = security;
  profile: SecurityProfile | null = null;
  prices: DailyPrice[] = [];
  dailyState: DailyDerivedState[] = [];
  weekly: WeeklyPrice[] = [];
  financialStatements: FinancialStatement[] = [];
  states = new Map<string, PersistedDatasetState>();
  coverage = new Map<string, Required<DateRange>[]>();
  coverageSyncs = new Map<
    string,
    Array<{ range: Required<DateRange>; syncedAt: string }>
  >();
  priceSaves = 0;
  derivedWrites: Array<{ derivedDates: string[]; weeklyDates: string[] }> =
    [];
  fundamentalsStateUpserts: Array<{
    dataset: PersistedStockDataset;
    variant: string;
    syncedAt: string;
  }> = [];

  async findSecurityByProviderSymbol() {
    return this.currentSecurity;
  }
  async saveSecurityProfile(mapped: MappedFmpProfile) {
    this.currentSecurity = { id: security.id, ...mapped.security };
    return {
      security: this.currentSecurity,
      profile: { securityId: security.id, ...mapped.profile },
    };
  }
  async getProfile() {
    return this.profile;
  }
  async getDatasetState(
    _securityId: string,
    dataset: PersistedStockDataset,
    variant = "",
  ) {
    return this.states.get(`${dataset}:${variant}`) ?? null;
  }
  async getDatasetCoverage(
    _securityId: string,
    dataset: PersistedStockDataset,
    variant: string,
    _range: Required<DateRange>,
  ) {
    return this.coverage.get(`${dataset}:${variant}`) ?? [];
  }
  async getLatestCoverageSyncContainingDate(
    _securityId: string,
    dataset: PersistedStockDataset,
    variant: string,
    date: string,
  ) {
    if (dataset === "DAILY_PRICE" && variant === "split-adjusted-eod-full") {
      const freshness = this.states.get(
        "DAILY_PRICE:split-adjusted-eod-full:recent-tail",
      );
      return freshness?.latestDate && freshness.latestDate >= date
        ? (freshness.lastSyncedAt ?? null)
        : null;
    }
    const key = `${dataset}:${variant}`;
    const explicit = this.coverageSyncs.get(key);
    if (explicit) {
      return (
        explicit
          .filter(({ range }) => range.from <= date && range.to >= date)
          .map(({ syncedAt }) => syncedAt)
          .sort()
          .at(-1) ?? null
      );
    }
    const covered = (this.coverage.get(key) ?? []).some(
      (range) => range.from <= date && range.to >= date,
    );
    return covered ? (this.states.get(key)?.lastSyncedAt ?? null) : null;
  }
  async getDailyPrices(_securityId: string, range: DateRange) {
    return this.prices
      .filter((row) => !range.from || row.date >= range.from)
      .filter((row) => !range.to || row.date <= range.to)
      .sort((left, right) => left.date.localeCompare(right.date));
  }
  async getFinancialStatements(
    _securityId: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]> {
    return selectFinancialStatements(this.financialStatements, query);
  }
  async getFinancialStatementRevisions(input: {
    securityId: string;
    statementType?: FinancialStatement["statementType"];
    cadence?: FinancialStatementCadence;
    from?: string;
    to?: string;
  }): Promise<FinancialStatement[]> {
    return this.financialStatements
      .filter((row) => row.securityId === input.securityId)
      .filter(
        (row) => !input.statementType || row.statementType === input.statementType,
      )
      .filter((row) => !input.from || row.fiscalDate >= input.from)
      .filter((row) => !input.to || row.fiscalDate <= input.to)
      .filter((row) => {
        if (!input.cadence) return true;
        return input.cadence === "ANNUAL" ? row.period === "FY" : row.period !== "FY";
      })
      .sort(
        (left, right) =>
          left.fiscalDate.localeCompare(right.fiscalDate) ||
          left.availableFromDate.localeCompare(right.availableFromDate) ||
          left.observedAt.localeCompare(right.observedAt),
      );
  }
  async saveFinancialStatements(input: {
    securityId: string;
    statements: readonly FinancialStatementDraft[];
    syncedAt: string;
  }) {
    const revisions = input.statements.map((statement) => ({
      securityId: input.securityId,
      statementType: statement.statementType,
      fiscalDate: statement.fiscalDate,
      fiscalYear: statement.fiscalYear,
      period: statement.period,
      reportedCurrency: statement.reportedCurrency,
      filingDate: statement.filingDate,
      availableFromDate: plusDays(statement.filingDate, 1),
      observedAt: input.syncedAt,
      contentHash: JSON.stringify({
        statementType: statement.statementType,
        fiscalDate: statement.fiscalDate,
        fiscalYear: statement.fiscalYear,
        period: statement.period,
        reportedCurrency: statement.reportedCurrency,
        filingDate: statement.filingDate,
        values: statement.values,
      }),
      values: statement.values,
    }));
    const existingKeys = new Set(
      this.financialStatements.map(
        (statement) =>
          `${statement.statementType}:${statement.fiscalDate}:${statement.period}:${statement.filingDate}:${statement.contentHash}`,
      ),
    );
    const uniqueInsertions = revisions.filter((statement) => {
      const key = `${statement.statementType}:${statement.fiscalDate}:${statement.period}:${statement.filingDate}:${statement.contentHash}`;
      if (existingKeys.has(key)) {
        return false;
      }
      existingKeys.add(key);
      return true;
    });
    this.financialStatements = [...this.financialStatements, ...uniqueInsertions].sort(
      (left, right) =>
        left.fiscalDate.localeCompare(right.fiscalDate) ||
        left.statementType.localeCompare(right.statementType) ||
        left.period.localeCompare(right.period) ||
        left.availableFromDate.localeCompare(right.availableFromDate) ||
        left.observedAt.localeCompare(right.observedAt),
    );
    return {
      insertedRevisionCount: uniqueInsertions.length,
      unchangedCount: input.statements.length - uniqueInsertions.length,
    };
  }
  async upsertDatasetState(input: {
    securityId: string;
    dataset: PersistedStockDataset;
    variant: string;
    syncedAt: string;
    earliestDate?: string;
    latestDate?: string;
  }): Promise<void> {
    const key = `${input.dataset}:${input.variant}`;
    const existing = this.states.get(key);
    this.states.set(key, {
      securityId: input.securityId,
      dataset: input.dataset,
      variant: input.variant,
      earliestDate: input.earliestDate ?? existing?.earliestDate,
      latestDate: input.latestDate ?? existing?.latestDate,
      lastSyncedAt: input.syncedAt,
    });
    this.fundamentalsStateUpserts.push({
      dataset: input.dataset,
      variant: input.variant,
      syncedAt: input.syncedAt,
    });
  }
  async saveDailyPriceSync(input: {
    prices: readonly DailyPrice[];
    successfulCoverage: readonly Required<DateRange>[];
    syncedAt: string;
    tailDate: string;
    freshThrough?: string;
    assertOwned?: () => void;
  }) {
    input.assertOwned?.();
    this.priceSaves += 1;
    const existing = new Map(this.prices.map((row) => [row.date, row]));
    const earliestChangedDate = input.prices
      .filter(
        (row) => JSON.stringify(existing.get(row.date)) !== JSON.stringify(row),
      )
      .map((row) => row.date)
      .sort()[0];
    for (const row of input.prices) existing.set(row.date, row);
    this.prices = [...existing.values()].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    const key = "DAILY_PRICE:split-adjusted-eod-full";
    const priorCoverage = this.coverage.get(key) ?? [];
    const priorSyncedAt = this.states.get(key)?.lastSyncedAt;
    this.coverage.set(key, [...priorCoverage, ...input.successfulCoverage]);
    this.coverageSyncs.set(key, [
      ...(this.coverageSyncs.get(key) ??
        (priorSyncedAt
          ? priorCoverage.map((range) => ({
              range,
              syncedAt: priorSyncedAt,
            }))
          : [])),
      ...input.successfulCoverage.map((range) => ({
        range,
        syncedAt: input.syncedAt,
      })),
    ]);
    const allCoverage = this.coverage.get(key) ?? [];
    this.states.set(key, {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: allCoverage.map((range) => range.from).sort()[0],
      latestDate: allCoverage
        .map((range) => range.to)
        .sort()
        .at(-1),
      lastSyncedAt: input.syncedAt,
    });
    if (input.freshThrough && input.freshThrough >= input.tailDate) {
      this.states.set("DAILY_PRICE:split-adjusted-eod-full:recent-tail", {
        securityId: security.id,
        dataset: "DAILY_PRICE",
        variant: "split-adjusted-eod-full:recent-tail",
        earliestDate: input.tailDate,
        latestDate: input.tailDate,
        lastSyncedAt: input.syncedAt,
      });
    }
    return earliestChangedDate ? { earliestChangedDate } : {};
  }
  async getDailyDerivedState(_id: string, range: DateRange) {
    return this.dailyState
      .filter(
        (row) =>
          (!range.from || row.date >= range.from) &&
          (!range.to || row.date <= range.to),
      )
      .sort((left, right) => left.date.localeCompare(right.date));
  }
  async saveDailyDerivedState(input: {
    rows: readonly DailyDerivedState[];
    weeklyPrices: readonly WeeklyPrice[];
    successfulCoverage: Required<DateRange>;
    syncedAt: string;
    assertOwned?: () => void;
  }) {
    input.assertOwned?.();
    assertOneRowPerTradingDay(input.rows);
    this.derivedWrites.push({
      derivedDates: input.rows.map((row) => row.date),
      weeklyDates: input.weeklyPrices.map((row) => row.weekStartDate),
    });
    this.dailyState = upsertBy(
      this.dailyState,
      input.rows,
      (row) => row.date,
    );
    this.weekly = upsertBy(
      this.weekly,
      input.weeklyPrices,
      (row) => row.weekStartDate,
    );
    const derivedKey = `DAILY_DERIVED_STATE:${DAILY_DERIVED_STATE_VARIANT}`;
    this.states.set(derivedKey, {
      securityId: security.id,
      dataset: "DAILY_DERIVED_STATE",
      variant: DAILY_DERIVED_STATE_VARIANT,
      earliestDate: input.successfulCoverage.from,
      latestDate: input.successfulCoverage.to,
      lastSyncedAt: input.syncedAt,
    });
    this.coverage.set(derivedKey, [input.successfulCoverage]);
    this.states.set(`WEEKLY_PRICE:${WEEKLY_PRICE_VARIANT}`, {
      securityId: security.id,
      dataset: "WEEKLY_PRICE",
      variant: WEEKLY_PRICE_VARIANT,
      lastSyncedAt: input.syncedAt,
    });
  }
  async getWeeklyPrices(_id: string, range: DateRange) {
    return this.weekly.filter(
      (row) =>
        (!range.from || row.weekStartDate >= range.from) &&
        (!range.to || row.weekStartDate <= range.to),
    );
  }
}

function createService(
  store: FakeStore,
  provider: FakeProvider,
  cache: StockDataCache,
  coordinator: LoadCoordinator,
  now: () => Date = () => new Date(NOW),
) {
  return new CanonicalStockDataService(store, provider, cache, coordinator, {
    historyYears: 30,
    recentPriceFreshnessMs: 6 * 60 * 60 * 1000,
    fundamentalsFreshnessMs: 6 * 60 * 60 * 1000,
    recentTailCalendarDays: 10,
    now,
  });
}

function yearSpan(from: string, to: string): number[] {
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function setTailFreshness(
  store: FakeStore,
  syncedAt = NOW,
  tailDate = CANONICAL_RANGE.to,
) {
  store.states.set("DAILY_PRICE:split-adjusted-eod-full:recent-tail", {
    securityId: security.id,
    dataset: "DAILY_PRICE",
    variant: "split-adjusted-eod-full:recent-tail",
    earliestDate: tailDate,
    latestDate: tailDate,
    lastSyncedAt: syncedAt,
  });
}

function setFundamentalsStates(
  store: FakeStore,
  syncedAt = NOW,
  historyYears = 30,
) {
  const variants = {
    quarterly: `standard:quarter:v1:h${historyYears}`,
    annual: `standard:annual:v1:h${historyYears}`,
  };
  const datasets: Array<
    "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW"
  > = ["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"];
  for (const dataset of datasets) {
    for (const variant of [variants.quarterly, variants.annual]) {
      store.states.set(`${dataset}:${variant}`, {
        securityId: security.id,
        dataset,
        variant,
        lastSyncedAt: syncedAt,
      });
    }
  }
}

describe("canonical full-stock hydration", () => {
  it("requests the six-source fundamentals initial backfill with expected cadence limits", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setTailFreshness(store, NOW);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    expect(provider.financialRequests).toHaveLength(6);
    expect(
      provider.financialRequests.filter((request) => request.cadence === "QUARTERLY"),
    ).toHaveLength(3);
    expect(
      provider.financialRequests.filter((request) => request.cadence === "ANNUAL"),
    ).toHaveLength(3);
    expect(new Set(provider.financialRequests.map((request) => request.limit))).toEqual(
      new Set([128, 32]),
    );
    expect(
      cache.manifests.get(security.id)?.financialStatementVersion,
    ).toBe(1);
    expect(cache.manifests.get(security.id)?.lastFundamentalsRefreshAt).toBeDefined();
  });

  it("advances fundamentals cadence state on successful empty backfill responses", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    const variants = store.fundamentalsStateUpserts.map((entry) => entry.variant);
    expect(variants).toEqual(
      expect.arrayContaining([
        "standard:quarter:v1:h30",
        "standard:annual:v1:h30",
      ]),
    );
    await expect(
      store.getDatasetState(security.id, "INCOME_STATEMENT", "standard:quarter:v1:h30"),
    ).resolves.not.toBeNull();
    await expect(
      store.getDatasetState(security.id, "INCOME_STATEMENT", "standard:annual:v1:h30"),
    ).resolves.not.toBeNull();
  });

  it("treats old READY manifest without financial statement version as stale and reconstructs", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setTailFreshness(store, NOW);
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: NOW,
      lastPriceRefreshAt: NOW,
      derivedStateRevision: DERIVED_STATE_REVISION,
      priceDatasetVersion: 1,
    } as StockManifest);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    expect(provider.financialRequests).toHaveLength(6);
    expect(cache.manifests.get(security.id)?.financialStatementVersion).toBe(1);
  });
  it("deduplicates identical concurrent requests into one stock hydration", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const coordinator = new InMemoryLoadCoordinator();
    provider.rowsByRange.set(`${CANONICAL_RANGE.from}:${CANONICAL_RANGE.to}`, [
      price("2026-08-20"),
    ]);
    const loader = createService(store, provider, cache, coordinator);
    const requested = { from: "2026-01-01", to: "2026-08-24" };

    const [first, second] = await Promise.all([
      loader.getDailyPrices("AAPL", requested),
      loader.getDailyPrices("AAPL", requested),
    ]);

    expect(second).toEqual(first);
    expect(provider.ranges).toEqual([CANONICAL_RANGE]);
  });

  it("deduplicates different range projections across API-like and worker-like instances", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const coordinator = new InMemoryLoadCoordinator();
    store.prices = [price("2022-01-03", 150)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2015-01-01", to: CANONICAL_RANGE.to },
    ]);
    store.coverageSyncs.set("DAILY_PRICE:split-adjusted-eod-full", [
      {
        range: { from: "2015-01-01", to: CANONICAL_RANGE.to },
        syncedAt: NOW,
      },
    ]);
    setTailFreshness(store);
    provider.rowsByRange.set("1996-08-24:2014-12-31", [
      price("2010-01-04", 30),
    ]);
    const api = createService(store, provider, cache, coordinator);
    const worker = createService(store, provider, cache, coordinator);

    const [older, newer] = await Promise.all([
      api.getDailyPrices("AAPL", { from: "2010-01-01", to: "2020-12-31" }),
      worker.getDailyPrices("AAPL", {
        from: "2021-01-01",
        to: "2025-12-31",
      }),
    ]);

    expect(provider.ranges).toEqual([{ from: "1996-08-24", to: "2014-12-31" }]);
    expect(older.map((row) => row.date)).toEqual(["2010-01-04"]);
    expect(newer.map((row) => row.date)).toEqual(["2022-01-03"]);
    expect(cache.manifests.get(security.id)).toMatchObject({
      status: "READY",
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
    });
    expect(cache.priceYearWrites[0]).toHaveLength(31);

    await api.getDailyPrices("AAPL", {
      from: "2024-01-01",
      to: "2026-01-01",
    });
    expect(provider.ranges).toHaveLength(1);
  });

  it("re-admits a fully durable stock after eviction with zero FMP calls", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setTailFreshness(store);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2025-08-24",
      to: CANONICAL_RANGE.to,
    });
    await cache.evict(security.id);
    const result = await loader.getDailyPrices("AAPL", {
      from: "2025-08-24",
      to: CANONICAL_RANGE.to,
    });

    expect(result).toEqual([price("2026-08-20", 200)]);
    expect(provider.ranges).toEqual([]);
    expect(cache.manifests.get(security.id)?.status).toBe("READY");
  });

  it("rehydrates Redis fundamentals from durable store without FMP calls when cadence states are complete", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setTailFreshness(store, NOW);
    setFundamentalsStates(store, NOW);
    store.financialStatements = [
      financialStatementRow("INCOME", "Q1", "2026-03-31", 100),
      financialStatementRow("INCOME", "FY", "2025-12-31", 300),
    ];
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });
    await cache.evict(security.id);
    const statements = await loader.getFinancialStatements("AAPL", {
      statementTypes: ["INCOME"],
      from: "2025-01-01",
      to: "2026-12-31",
    });

    expect(provider.financialRequests).toEqual([]);
    expect(statements).toHaveLength(2);
    expect(cache.financials.size).toBeGreaterThan(0);
  });

  it("repairs a missing technical suffix without rewriting prior history", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2025-12-31", 199), price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setTailFreshness(store);
    store.states.set(`DAILY_DERIVED_STATE:${DAILY_DERIVED_STATE_VARIANT}`, {
      securityId: security.id,
      dataset: "DAILY_DERIVED_STATE",
      variant: DAILY_DERIVED_STATE_VARIANT,
    });
    store.states.set(`WEEKLY_PRICE:${WEEKLY_PRICE_VARIANT}`, {
      securityId: security.id,
      dataset: "WEEKLY_PRICE",
      variant: WEEKLY_PRICE_VARIANT,
    });
    store.coverage.set(`DAILY_DERIVED_STATE:${DAILY_DERIVED_STATE_VARIANT}`, [
      { from: CANONICAL_RANGE.from, to: "2025-12-31" },
    ]);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: CANONICAL_RANGE.to,
    });

    expect(provider.ranges).toEqual([]);
    expect(store.derivedWrites.at(-1)?.derivedDates).toEqual(["2026-08-20"]);
  });

  it("persists an empty unavailable historical prefix and does not refetch it after eviction", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2010-01-04")];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2010-01-01", to: CANONICAL_RANGE.to },
    ]);
    store.coverageSyncs.set("DAILY_PRICE:split-adjusted-eod-full", [
      {
        range: { from: "2010-01-01", to: CANONICAL_RANGE.to },
        syncedAt: NOW,
      },
    ]);
    setTailFreshness(store);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2010-01-01",
      to: "2011-01-01",
    });
    await cache.evict(security.id);
    await loader.getDailyPrices("AAPL", {
      from: "2010-01-01",
      to: "2011-01-01",
    });

    expect(provider.ranges).toEqual([
      { from: CANONICAL_RANGE.from, to: "2009-12-31" },
    ]);
    expect(store.coverage.get("DAILY_PRICE:split-adjusted-eod-full")).toEqual(
      expect.arrayContaining([
        { from: CANONICAL_RANGE.from, to: "2009-12-31" },
      ]),
    );
  });

  it("does not treat a newly filled historical gap as a fresh recent tail", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const priceKey = "DAILY_PRICE:split-adjusted-eod-full";
    const staleTailSync = "2026-08-23T01:00:00.000Z";
    const prefix = { from: CANONICAL_RANGE.from, to: "2010-12-31" };
    const suffix = { from: "2011-01-02", to: CANONICAL_RANGE.to };
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set(priceKey, [prefix, suffix]);
    store.coverageSyncs.set(priceKey, [
      { range: prefix, syncedAt: staleTailSync },
      { range: suffix, syncedAt: staleTailSync },
    ]);
    store.states.set(priceKey, {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: staleTailSync,
    });
    setTailFreshness(store, staleTailSync);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: CANONICAL_RANGE.to,
    });

    expect(provider.ranges).toEqual([
      { from: "2011-01-01", to: "2011-01-01" },
      { from: "2026-08-14", to: "2026-08-24" },
    ]);
  });

  it("refreshes only a stale recent tail and rewrites only affected years", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: "2026-08-23T01:00:00.000Z",
    });
    setTailFreshness(store, "2026-08-23T01:00:00.000Z");
    await cache.setSecurity(security);
    await cache.writeDailyPriceYears(
      security.id,
      store.prices,
      Array.from({ length: 31 }, (_, index) => 1996 + index),
    );
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      canonicalHistoryStart: "2026-08-20",
      canonicalHistoryEnd: "2026-08-20",
      hydratedAt: "2026-08-23T01:00:00.000Z",
      lastPriceRefreshAt: "2026-08-23T01:00:00.000Z",
      lastFundamentalsRefreshAt: "2026-08-23T01:00:00.000Z",
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    provider.rowsByRange.set("2026-08-14:2026-08-24", [
      price("2026-08-20", 200),
      price("2026-08-21", 201),
    ]);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-08-20",
      to: "2026-08-24",
    });

    expect(provider.ranges).toEqual([{ from: "2026-08-14", to: "2026-08-24" }]);
    expect(cache.priceYearWrites.at(-1)).toEqual([2026]);
    // The rebuild window also covers the completed-week boundary, because a newly completed week
    // changes the carried-forward weekly source on every later trading day.
    expect(store.derivedWrites.at(-1)?.derivedDates).toEqual([
      "2026-08-20",
      "2026-08-21",
    ]);
    expect(cache.manifests.get(security.id)?.lastPriceRefreshAt).toBe(NOW);
  });

  it("republishes the complete affected year after a mid-year derived rebuild", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const januaryDates = ["2026-01-05", "2026-01-06"];
    store.prices = [
      ...januaryDates.map((date, index) => price(date, 100 + index)),
      price("2026-08-20", 200),
    ];
    // January derived rows are already durable and cached from an earlier hydration.
    store.dailyState = store.prices.map((row) => ({
      securityId: security.id,
      date: row.date,
      sma20d: row.close,
    }));
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: "2026-08-23T01:00:00.000Z",
    });
    store.coverage.set(
      `DAILY_DERIVED_STATE:${DAILY_DERIVED_STATE_VARIANT}`,
      [CANONICAL_RANGE],
    );
    setTailFreshness(store, "2026-08-23T01:00:00.000Z");
    const allYears = Array.from({ length: 31 }, (_, index) => 1996 + index);
    await cache.setSecurity(security);
    await cache.writeDailyPriceYears(security.id, store.prices, allYears);
    await cache.writeDailyDerivedStateYears(
      security.id,
      store.dailyState,
      allYears,
    );
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      canonicalHistoryStart: "2026-01-05",
      canonicalHistoryEnd: "2026-08-20",
      hydratedAt: "2026-08-23T01:00:00.000Z",
      lastPriceRefreshAt: "2026-08-23T01:00:00.000Z",
      lastFundamentalsRefreshAt: "2026-08-23T01:00:00.000Z",
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    // The refresh only rebuilds derived rows from August forward.
    provider.rowsByRange.set("2026-08-14:2026-08-24", [
      price("2026-08-20", 200),
      price("2026-08-21", 201),
    ]);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    const refreshed = await loader.getDailyDerivedState("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    expect(store.derivedWrites.at(-1)?.derivedDates).toEqual([
      "2026-08-20",
      "2026-08-21",
    ]);
    // The whole 2026 chunk is republished from PostgreSQL, so January survives the partial rebuild.
    expect(refreshed.map((row) => row.date)).toEqual([
      ...januaryDates,
      "2026-08-20",
      "2026-08-21",
    ]);
    expect(
      cache.dailyState.get(security.id)?.map((row) => row.date),
    ).toEqual([...januaryDates, "2026-08-20", "2026-08-21"]);
  });

  it("does not advance READY freshness when the provider refresh fails", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: "2026-08-23T01:00:00.000Z",
      lastPriceRefreshAt: "2026-08-23T01:00:00.000Z",
      lastFundamentalsRefreshAt: "2026-08-23T01:00:00.000Z",
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    provider.failure = new Error("provider failed");
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await expect(
      loader.getDailyPrices("AAPL", {
        from: "2026-01-01",
        to: "2026-08-24",
      }),
    ).rejects.toThrow("provider failed");
    expect(cache.manifests.get(security.id)?.lastPriceRefreshAt).toBe(
      "2026-08-23T01:00:00.000Z",
    );
  });

  it("refreshes only fundamentals when prices are fresh and fundamentals are stale", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    const staleFundamentals = "2026-08-24T01:00:00.000Z";
    await cache.setSecurity(security);
    await cache.writeDailyPriceYears(
      security.id,
      store.prices,
      yearSpan(CANONICAL_RANGE.from, CANONICAL_RANGE.to),
    );
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      canonicalHistoryStart: "2026-08-20",
      canonicalHistoryEnd: "2026-08-20",
      hydratedAt: staleFundamentals,
      lastPriceRefreshAt: NOW,
      lastFundamentalsRefreshAt: staleFundamentals,
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    setFundamentalsStates(store, NOW);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      () => new Date("2026-08-24T12:30:00.000Z"),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    expect(provider.ranges).toEqual([]);
    expect(provider.financialRequests).toHaveLength(6);
    expect(cache.manifests.get(security.id)?.lastPriceRefreshAt).toBe(NOW);
    expect(cache.manifests.get(security.id)?.lastFundamentalsRefreshAt).toBe(
      "2026-08-24T12:30:00.000Z",
    );
  });

  it("refreshes only prices when fundamentals are fresh and prices are stale", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: "2026-08-23T01:00:00.000Z",
    });
    setTailFreshness(store, "2026-08-23T01:00:00.000Z");
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: NOW,
      lastPriceRefreshAt: "2026-08-23T01:00:00.000Z",
      lastFundamentalsRefreshAt: NOW,
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    provider.rowsByRange.set("2026-08-14:2026-08-24", [
      price("2026-08-20", 200),
      price("2026-08-21", 201),
    ]);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    await loader.getDailyPrices("AAPL", {
      from: "2026-08-20",
      to: "2026-08-24",
    });

    expect(provider.financialRequests).toHaveLength(0);
    expect(provider.ranges).toEqual([{ from: "2026-08-14", to: "2026-08-24" }]);
  });

  it("does not advance fundamentals freshness when one of six operations fails", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: NOW,
      lastPriceRefreshAt: NOW,
      lastFundamentalsRefreshAt: "2026-08-24T01:00:00.000Z",
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    provider.financialFailures.set(
      "INCOME:QUARTERLY:12",
      new Error("fundamentals refresh failed"),
    );
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      () => new Date("2026-08-24T12:30:00.000Z"),
    );

    await expect(
      loader.getDailyPrices("AAPL", {
        from: "2026-01-01",
        to: "2026-08-24",
      }),
    ).rejects.toThrow("fundamentals refresh failed");
    expect(cache.manifests.get(security.id)?.lastFundamentalsRefreshAt).toBe(
      "2026-08-24T01:00:00.000Z",
    );
  });

  it("retries fundamentals refresh after partial failure and uses oldest dataset sync as aggregate freshness", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const staleFundamentalsAt = "2026-08-24T01:00:00.000Z";
    const firstAttemptAt = "2026-08-24T12:30:00.000Z";
    const secondAttemptAt = "2026-08-24T12:31:00.000Z";
    let now = new Date(firstAttemptAt);

    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setFundamentalsStates(store, staleFundamentalsAt);
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: staleFundamentalsAt,
      lastPriceRefreshAt: NOW,
      lastFundamentalsRefreshAt: staleFundamentalsAt,
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    provider.financialFailures.set(
      "INCOME:QUARTERLY:12",
      new Error("fundamentals refresh failed"),
    );
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      () => now,
    );

    await expect(
      loader.getDailyPrices("AAPL", {
        from: "2026-01-01",
        to: "2026-08-24",
      }),
    ).rejects.toThrow("fundamentals refresh failed");

    expect(provider.financialRequests).toHaveLength(6);
    expect(
      store.states.get("INCOME_STATEMENT:standard:quarter:v1:h30")?.lastSyncedAt,
    ).toBe(staleFundamentalsAt);
    expect(
      store.states.get("BALANCE_SHEET:standard:quarter:v1:h30")?.lastSyncedAt,
    ).toBe(firstAttemptAt);

    provider.financialFailures.delete("INCOME:QUARTERLY:12");
    now = new Date(secondAttemptAt);

    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    expect(provider.financialRequests).toHaveLength(12);
    expect(
      store.states.get("INCOME_STATEMENT:standard:quarter:v1:h30")?.lastSyncedAt,
    ).toBe(secondAttemptAt);
    expect(cache.manifests.get(security.id)?.lastFundamentalsRefreshAt).toBe(
      secondAttemptAt,
    );
  });

  it("waits for already-started sibling fundamentals operations to settle before failing", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const staleFundamentalsAt = "2026-08-24T01:00:00.000Z";
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setFundamentalsStates(store, staleFundamentalsAt);
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: staleFundamentalsAt,
      lastPriceRefreshAt: NOW,
      lastFundamentalsRefreshAt: staleFundamentalsAt,
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });

    let releaseSlow = () => {};
    const slowPending = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    provider.financialDelays.set("BALANCE_SHEET:ANNUAL:3", slowPending);
    provider.financialFailures.set(
      "INCOME:QUARTERLY:12",
      new Error("fast fundamentals failure"),
    );

    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      () => new Date("2026-08-24T12:30:00.000Z"),
    );
    let settled = false;
    const request = loader
      .getDailyPrices("AAPL", {
        from: "2026-01-01",
        to: "2026-08-24",
      })
      .finally(() => {
        settled = true;
      });

    await waitFor(
      () => provider.financialStarted.includes("BALANCE_SHEET:ANNUAL:3"),
      2_000,
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSlow();
    await expect(request).rejects.toThrow("fast fundamentals failure");
    expect(provider.financialCompleted).toContain("BALANCE_SHEET:ANNUAL:3");
  });

  it("keeps unchanged fundamentals refresh idempotent", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const baseline = financialStatementRow("INCOME", "Q1", "2026-03-31", 100);
    store.financialStatements = [baseline];
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: NOW,
      lastPriceRefreshAt: NOW,
      lastFundamentalsRefreshAt: "2026-08-24T01:00:00.000Z",
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    provider.financialRows.set("INCOME:QUARTERLY:12", [
      {
        securityId: security.id,
        statementType: "INCOME",
        fiscalDate: "2026-03-31",
        fiscalYear: 2026,
        period: "Q1",
        reportedCurrency: "USD",
        filingDate: "2026-04-20",
        values: { revenue: 100 },
      },
    ]);
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      () => new Date("2026-08-24T12:30:00.000Z"),
    );

    const before = store.financialStatements.length;
    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });
    const afterFirst = store.financialStatements.length;
    await loader.getDailyPrices("AAPL", {
      from: "2026-01-01",
      to: "2026-08-24",
    });

    expect(afterFirst).toBeGreaterThanOrEqual(before);
    expect(store.financialStatements.length).toBe(afterFirst);
  });

  it("serves financial statements from resident cache while preserving asOf revision selection", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.prices = [price("2026-08-20", 200)];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [CANONICAL_RANGE]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: CANONICAL_RANGE.from,
      latestDate: CANONICAL_RANGE.to,
      lastSyncedAt: NOW,
    });
    setTailFreshness(store, NOW);
    setFundamentalsStates(store, NOW);
    const first = {
      ...financialStatementRow("INCOME", "Q1", "2026-03-31", 100),
      filingDate: "2026-04-20",
      availableFromDate: "2026-04-21",
      observedAt: "2026-04-20T12:00:00.000Z",
      contentHash: "rev-1",
    };
    const second = {
      ...financialStatementRow("INCOME", "Q1", "2026-03-31", 200),
      filingDate: "2026-05-20",
      availableFromDate: "2026-05-21",
      observedAt: "2026-05-20T12:00:00.000Z",
      contentHash: "rev-2",
    };
    store.financialStatements = [first, second];
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
    );

    const asOfOld = await loader.getFinancialStatements("AAPL", {
      statementTypes: ["INCOME"],
      cadence: "QUARTERLY",
      from: "2026-01-01",
      to: "2026-12-31",
      asOf: "2026-05-01",
    });
    const latest = await loader.getFinancialStatements("AAPL", {
      statementTypes: ["INCOME"],
      cadence: "QUARTERLY",
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(provider.financialRequests).toHaveLength(0);
    expect(asOfOld).toMatchObject([{ values: { revenue: 100 } }]);
    expect(latest).toMatchObject([{ values: { revenue: 200 } }]);
  });

  it("bounds empty recent-tail refreshes without freezing freshness forever", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    let now = new Date(NOW);
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      lastSyncedAt: "2026-08-23T01:00:00.000Z",
    });
    await cache.setSecurity(security);
    await cache.writeDailyPriceYears(security.id, [], [2026]);
    await cache.setManifest({
      securityId: security.id,
      status: "READY",
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: "2026-08-23T01:00:00.000Z",
      lastPriceRefreshAt: "2026-08-23T01:00:00.000Z",
      lastFundamentalsRefreshAt: "2026-08-23T01:00:00.000Z",
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    });
    const loader = createService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      () => now,
    );
    const requested = { from: "2026-08-20", to: "2026-08-24" };

    await loader.getDailyPrices("AAPL", requested);
    await loader.getDailyPrices("AAPL", requested);
    expect(provider.ranges).toHaveLength(1);

    now = new Date("2026-08-24T19:00:00.000Z");
    await loader.getDailyPrices("AAPL", requested);
    expect(provider.ranges).toHaveLength(2);
    expect(provider.ranges[0]).toEqual({
      from: "2026-08-14",
      to: "2026-08-24",
    });
  });

  it("does not persist or publish READY after definitive lease loss", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    provider.rowsByRange.set(`${CANONICAL_RANGE.from}:${CANONICAL_RANGE.to}`, [
      price("2026-08-20"),
    ]);
    const losingCoordinator: LoadCoordinator = {
      async run(_resource, work) {
        let assertions = 0;
        return work({
          assertOwned() {
            assertions += 1;
            if (assertions >= 2) throw new Error("lease lost");
          },
        });
      },
    };
    const loader = createService(store, provider, cache, losingCoordinator);

    await expect(
      loader.getDailyPrices("AAPL", {
        from: "2026-01-01",
        to: "2026-08-24",
      }),
    ).rejects.toThrow("lease lost");
    expect(store.priceSaves).toBe(0);
    expect(cache.manifests.get(security.id)?.status).toBe("HYDRATING");
  });

  it("does not delete a successor READY manifest after lease handoff", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const successor = {
      securityId: security.id,
      status: "READY" as const,
      historyYears: 30,
      coverageStart: CANONICAL_RANGE.from,
      coverageEnd: CANONICAL_RANGE.to,
      hydratedAt: NOW,
      lastPriceRefreshAt: NOW,
      lastFundamentalsRefreshAt: NOW,
      priceDatasetVersion: 1,
      financialStatementVersion: 1,
      derivedStateRevision: DERIVED_STATE_REVISION,
    };
    provider.beforeReturn = async () => cache.setManifest(successor);
    let ownershipChecks = 0;
    const losingCoordinator: LoadCoordinator = {
      run: async (_resource, work) =>
        work({
          assertOwned: () => {
            ownershipChecks += 1;
            if (ownershipChecks > 1) throw new Error("lease lost");
          },
        }),
    };
    const loader = createService(store, provider, cache, losingCoordinator);

    await expect(
      loader.getDailyPrices("AAPL", {
        from: "2026-01-01",
        to: "2026-08-24",
      }),
    ).rejects.toThrow("lease lost");
    expect(cache.manifests.get(security.id)).toEqual(successor);
  });
});

describe("daily materialized intrinsic projections", () => {
  function withDailyState(rows: DailyDerivedState[]) {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      CANONICAL_RANGE,
    ]);
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      lastSyncedAt: NOW,
    });
    store.dailyState = rows;
    return {
      store,
      loader: createService(
        store,
        provider,
        cache,
        new InMemoryLoadCoordinator(),
      ),
    };
  }

  const carriedForward: DailyDerivedState[] = [
    "2025-02-03",
    "2025-02-04",
    "2025-02-05",
  ].map((date) => ({
    securityId: security.id,
    date,
    intrinsicValues: { DCF_FCFF: 100, RESIDUAL_INCOME: 80, GRAHAM: 60 },
    intrinsicValueBlends: { BALANCED: 86 },
    dcfFcffSourceAsOf: "2025-02-03T12:00:00.000Z",
    residualIncomeSourceAsOf: "2025-02-03T12:00:00.000Z",
    grahamSourceAsOf: "2025-02-03T12:00:00.000Z",
    intrinsicCurrency: "USD",
  }));

  /**
   * One daily row whose models were sourced at different instants. Provenance is per model, so
   * DCF's later financial-statement revision must not delay Graham, and Graham must not make DCF
   * look older than it is.
   */
  const perModelSources: DailyDerivedState = {
    securityId: security.id,
    date: "2026-05-05",
    intrinsicValues: { DCF_FCFF: 120, RESIDUAL_INCOME: 90, DDM: 70, GRAHAM: 60 },
    intrinsicValueBlends: { BALANCED: 100, CONSERVATIVE: 95, DIVIDEND: 94 },
    dcfFcffSourceAsOf: "2026-05-02T20:00:00.000Z",
    residualIncomeSourceAsOf: "2026-04-28T20:00:00.000Z",
    ddmSourceAsOf: "2026-05-04T20:00:00.000Z",
    grahamSourceAsOf: "2026-04-21T20:00:00.000Z",
    intrinsicCurrency: "USD",
  };

  it("returns one value per model per trading day, ascending, with no version metadata", async () => {
    const { loader } = withDailyState(carriedForward);

    const result = await loader.getIntrinsicValues("AAPL", {
      from: "2025-02-03",
      to: "2025-02-05",
      models: ["DCF_FCFF"],
    });

    expect(result.map((point) => point.valuationDate)).toEqual([
      "2025-02-03",
      "2025-02-04",
      "2025-02-05",
    ]);
    // Repetition of an unchanged valuation across trading days is intentional materialization.
    expect(result.map((point) => point.valuePerShare)).toEqual([100, 100, 100]);
    expect(result[0]).not.toHaveProperty("calculationVersion");
    expect(result.every((point) => point.securityId === security.id)).toBe(
      true,
    );
  });

  it("reads blends straight from the materialized state without recomputing components", async () => {
    const { loader } = withDailyState(carriedForward);

    const result = await loader.getIntrinsicValueBlends("AAPL", {
      from: "2025-02-03",
      to: "2025-02-05",
      blendIds: ["BALANCED"],
    });

    expect(result.map((point) => point.valuePerShare)).toEqual([86, 86, 86]);
    expect(result[0]).not.toHaveProperty("blendVersion");
    expect(result[0]).not.toHaveProperty("calculationVersion");
  });

  it("omits a blend that was never materialized rather than renormalizing components", async () => {
    const { loader } = withDailyState(carriedForward);

    await expect(
      loader.getIntrinsicValueBlends("AAPL", {
        from: "2025-02-03",
        to: "2025-02-05",
        blendIds: ["DIVIDEND"],
      }),
    ).resolves.toEqual([]);
  });

  it("excludes trading days after asOf and rows whose inputs were not yet public", async () => {
    const { loader } = withDailyState([
      ...carriedForward,
      {
        securityId: security.id,
        date: "2025-02-06",
        intrinsicValues: { DCF_FCFF: 120 },
        // Deliberately inconsistent audit field: it must never become visible at this asOf.
        dcfFcffSourceAsOf: "2025-02-07T12:00:00.000Z",
        intrinsicCurrency: "USD",
      },
    ]);

    const result = await loader.getIntrinsicValues("AAPL", {
      from: "2025-02-03",
      to: "2025-02-06",
      asOf: "2025-02-06",
      models: ["DCF_FCFF"],
    });

    expect(result.map((point) => point.valuationDate)).toEqual([
      "2025-02-03",
      "2025-02-04",
      "2025-02-05",
    ]);
  });

  it("carries an independent sourceDataAsOf per model on the same daily row", async () => {
    const { loader } = withDailyState([perModelSources]);

    const result = await loader.getIntrinsicValues("AAPL", {
      from: "2026-05-05",
      to: "2026-05-05",
      models: ["DCF_FCFF", "GRAHAM"],
    });

    // Two models, one (securityId, date) row, two different provenance instants.
    expect(
      result.map((point) => [point.model, point.sourceDataAsOf]),
    ).toEqual([
      ["DCF_FCFF", "2026-05-02T20:00:00.000Z"],
      ["GRAHAM", "2026-04-21T20:00:00.000Z"],
    ]);
  });

  it("applies the asOf cutoff independently per model", async () => {
    const { loader } = withDailyState([
      {
        securityId: security.id,
        date: "2026-04-22",
        intrinsicValues: { DCF_FCFF: 120, GRAHAM: 60 },
        grahamSourceAsOf: "2026-04-21T20:00:00.000Z",
        // Deliberately inconsistent DCF stamp: its inputs were not public by this asOf.
        dcfFcffSourceAsOf: "2026-05-02T20:00:00.000Z",
        intrinsicCurrency: "USD",
      },
    ]);

    const result = await loader.getIntrinsicValues("AAPL", {
      from: "2026-04-20",
      to: "2026-04-22",
      asOf: "2026-04-25",
    });

    // Graham is eligible at this cutoff; DCF on the same row is not, and no model is delayed to
    // the newest instant on the row.
    expect(result.map((point) => point.model)).toEqual(["GRAHAM"]);
    expect(result[0]?.sourceDataAsOf).toBe("2026-04-21T20:00:00.000Z");
  });

  it("omits a model value whose own provenance is missing", async () => {
    const { loader } = withDailyState([
      {
        securityId: security.id,
        date: "2026-05-05",
        intrinsicValues: { DCF_FCFF: 120, RESIDUAL_INCOME: 90 },
        dcfFcffSourceAsOf: "2026-05-02T20:00:00.000Z",
        // No residualIncomeSourceAsOf: the value cannot be proven point-in-time eligible.
        intrinsicCurrency: "USD",
      },
    ]);

    const result = await loader.getIntrinsicValues("AAPL", {
      from: "2026-05-05",
      to: "2026-05-05",
    });

    expect(result.map((point) => point.model)).toEqual(["DCF_FCFF"]);
  });

  it("derives BALANCED and CONSERVATIVE provenance from their own components only", async () => {
    const { loader } = withDailyState([perModelSources]);

    const result = await loader.getIntrinsicValueBlends("AAPL", {
      from: "2026-05-05",
      to: "2026-05-05",
      blendIds: ["BALANCED", "CONSERVATIVE"],
    });

    // max(DCF 05-02, RI 04-28, Graham 04-21); the later DDM instant is not a component.
    expect(
      result.map((point) => [point.blendId, point.sourceDataAsOf]),
    ).toEqual([
      ["BALANCED", "2026-05-02T20:00:00.000Z"],
      ["CONSERVATIVE", "2026-05-02T20:00:00.000Z"],
    ]);
  });

  it("includes DDM provenance in the DIVIDEND blend", async () => {
    const { loader } = withDailyState([perModelSources]);

    const result = await loader.getIntrinsicValueBlends("AAPL", {
      from: "2026-05-05",
      to: "2026-05-05",
      blendIds: ["DIVIDEND"],
    });

    // max(DCF 05-02, DDM 05-04, RI 04-28): DDM is the newest required component.
    expect(result.map((point) => point.sourceDataAsOf)).toEqual([
      "2026-05-04T20:00:00.000Z",
    ]);
  });

  it("omits a blend when any required component value or provenance is unavailable", async () => {
    const missingValue = withDailyState([
      {
        ...perModelSources,
        intrinsicValues: { DCF_FCFF: 120, RESIDUAL_INCOME: 90, GRAHAM: 60 },
      },
    ]);
    const missingProvenance = withDailyState([
      {
        ...perModelSources,
        ddmSourceAsOf: undefined,
      },
    ]);
    const query = {
      from: "2026-05-05",
      to: "2026-05-05",
      blendIds: ["DIVIDEND"],
    } as const;

    // Neither case renormalizes the remaining weights onto a partial blend.
    await expect(
      missingValue.loader.getIntrinsicValueBlends("AAPL", query),
    ).resolves.toEqual([]);
    await expect(
      missingProvenance.loader.getIntrinsicValueBlends("AAPL", query),
    ).resolves.toEqual([]);
    // The models that are complete on that row remain readable.
    await expect(
      missingProvenance.loader.getIntrinsicValueBlends("AAPL", {
        ...query,
        blendIds: ["BALANCED"],
      }),
    ).resolves.toHaveLength(1);
  });

  it("never leaks a later-sourced component into an earlier asOf query", async () => {
    const { loader } = withDailyState([
      {
        securityId: security.id,
        date: "2026-04-22",
        intrinsicValues: { GRAHAM: 60 },
        grahamSourceAsOf: "2026-04-21T20:00:00.000Z",
        intrinsicCurrency: "USD",
      },
      perModelSources,
    ]);

    const [values, blends] = await Promise.all([
      loader.getIntrinsicValues("AAPL", {
        from: "2026-04-20",
        to: "2026-05-10",
        asOf: "2026-04-25",
      }),
      loader.getIntrinsicValueBlends("AAPL", {
        from: "2026-04-20",
        to: "2026-05-10",
        asOf: "2026-04-25",
      }),
    ]);

    // Only the trading day and the model eligible at the cutoff; nothing from 2026-05-05.
    expect(values.map((point) => [point.valuationDate, point.model])).toEqual([
      ["2026-04-22", "GRAHAM"],
    ]);
    expect(blends).toEqual([]);
  });

  it("omits days before the first eligible valuation instead of back-filling them", async () => {
    const { loader } = withDailyState([
      { securityId: security.id, date: "2025-02-03", sma20d: 10 },
      ...carriedForward.slice(1),
    ]);

    const result = await loader.getIntrinsicValues("AAPL", {
      from: "2025-02-03",
      to: "2025-02-05",
      models: ["DCF_FCFF"],
    });

    expect(result.map((point) => point.valuationDate)).toEqual([
      "2025-02-04",
      "2025-02-05",
    ]);
  });
});

describe("load coordination", () => {
  it("releases ownership after an exception", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    await expect(
      coordinator.run("hydrate:security-1", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      coordinator.run("hydrate:security-1", async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});

function financialStatementRow(
  statementType: FinancialStatement["statementType"],
  period: FinancialStatement["period"],
  fiscalDate: string,
  revenue: number,
): FinancialStatement {
  const filingDate = plusDays(fiscalDate, 20);
  return {
    securityId: security.id,
    statementType,
    fiscalDate,
    fiscalYear: Number(fiscalDate.slice(0, 4)),
    period,
    reportedCurrency: "USD",
    filingDate,
    availableFromDate: plusDays(filingDate, 1),
    observedAt: NOW,
    contentHash: JSON.stringify({ statementType, period, fiscalDate, revenue }),
    values:
      statementType === "INCOME"
        ? { revenue }
        : statementType === "BALANCE_SHEET"
          ? { totalAssets: revenue }
          : { netIncome: revenue },
  };
}

function plusDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function slice<T>(
  rows: readonly T[],
  range: Required<DateRange>,
  dateOf: (row: T) => string,
): T[] {
  return rows
    .filter((row) => dateOf(row) >= range.from && dateOf(row) <= range.to)
    .sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
}

function replaceYears<T>(
  existing: readonly T[],
  incoming: readonly T[],
  years: readonly number[],
  dateOf: (row: T) => string,
): T[] {
  const selected = new Set(years.map(String));
  return [
    ...existing.filter((row) => !selected.has(dateOf(row).slice(0, 4))),
    ...incoming.filter((row) => selected.has(dateOf(row).slice(0, 4))),
  ].sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
}

function upsertBy<T>(
  existing: readonly T[],
  incoming: readonly T[],
  identity: (row: T) => string,
): T[] {
  const values = new Map(existing.map((row) => [identity(row), row]));
  for (const row of incoming) values.set(identity(row), row);
  return [...values.values()];
}
