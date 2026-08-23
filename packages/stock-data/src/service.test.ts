import type {
  DailyPrice,
  DailyTechnical,
  DateRange,
  IntrinsicValueBlendPoint,
  IntrinsicValueBlendQuery,
  IntrinsicValuePoint,
  IntrinsicValueQuery,
  Security,
  SecurityProfile,
} from "@intrinsic/domain";
import type { FmpStockProviderPort, MappedFmpProfile } from "@intrinsic/fmp";
import { describe, expect, it } from "vitest";
import { NullStockDataCache, type StockDataCache } from "./cache.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import type {
  PersistedDatasetState,
  PersistedStockDataset,
  StockDataStore,
} from "./ports.js";
import { CanonicalStockDataService } from "./service.js";
import type { WeeklyPrice } from "./weekly.js";

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
  readonly values = new Map<string, unknown>();
  evicted: string[] = [];

  async get<T>(symbol: string, key: string) {
    return (this.values.get(`${symbol}:${key}`) as T | undefined) ?? null;
  }
  async set<T>(symbol: string, key: string, value: T) {
    this.values.set(`${symbol}:${key}`, value);
  }
  async hasResidentSymbol(symbol: string) {
    return [...this.values.keys()].some((key) => key.startsWith(`${symbol}:`));
  }
  async touch(_symbol: string) {}
  async evict(symbol: string) {
    this.evicted.push(symbol);
    for (const key of this.values.keys()) {
      if (key.startsWith(`${symbol}:`)) this.values.delete(key);
    }
  }
}

class FakeProvider implements FmpStockProviderPort {
  profile: MappedFmpProfile | null = null;
  readonly ranges: DateRange[] = [];
  rowsByRange = new Map<string, DailyPrice[]>();
  failRange?: string;

  async getProfile() {
    return this.profile;
  }
  async getDailyPrices(_symbol: string, _securityId: string, range: DateRange) {
    const key = `${range.from}:${range.to}`;
    this.ranges.push(range);
    if (key === this.failRange) throw new Error("upstream failed");
    return this.rowsByRange.get(key) ?? [];
  }
}

class FakeStore implements StockDataStore {
  currentSecurity: Security | null = security;
  profile: SecurityProfile | null = null;
  prices: DailyPrice[] = [];
  technicals: DailyTechnical[] = [];
  intrinsicValues: IntrinsicValuePoint[] = [];
  blends: IntrinsicValueBlendPoint[] = [];
  states = new Map<string, PersistedDatasetState>();
  coverage = new Map<string, Required<DateRange>[]>();
  priceReads = 0;
  priceSaves = 0;
  derivedSaves = 0;

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
  async getDailyPrices(_securityId: string, range: DateRange) {
    this.priceReads += 1;
    return this.prices
      .filter((row) => !range.from || row.date >= range.from)
      .filter((row) => !range.to || row.date <= range.to)
      .sort((left, right) => left.date.localeCompare(right.date));
  }
  async saveDailyPriceSync(input: {
    prices: readonly DailyPrice[];
    successfulCoverage: readonly Required<DateRange>[];
    syncedAt: string;
  }) {
    this.priceSaves += 1;
    this.prices.push(...input.prices);
    if (input.prices.length > 0) {
      this.technicals = [];
      this.states.delete("DAILY_TECHNICAL:1D:v1");
      this.coverage.delete("DAILY_TECHNICAL:1D:v1");
    }
    const from = input.successfulCoverage.map((range) => range.from).sort()[0];
    const to = input.successfulCoverage
      .map((range) => range.to)
      .sort()
      .at(-1);
    if (from && to) {
      const key = "DAILY_PRICE:split-adjusted-eod-full";
      this.coverage.set(key, [
        ...(this.coverage.get(key) ?? []),
        ...input.successfulCoverage,
      ]);
      this.states.set("DAILY_PRICE:split-adjusted-eod-full", {
        securityId: security.id,
        dataset: "DAILY_PRICE",
        variant: "split-adjusted-eod-full",
        earliestDate: from,
        latestDate: to,
        lastSyncedAt: input.syncedAt,
      });
    }
  }
  async getDailyTechnicals(_id: string, range: DateRange, version: number) {
    return this.technicals.filter(
      (row) =>
        row.calculationVersion === version &&
        (!range.from || row.date >= range.from) &&
        (!range.to || row.date <= range.to),
    );
  }
  async saveDerivedTechnicals(input: {
    technicals: readonly DailyTechnical[];
    weeklyPrices: readonly WeeklyPrice[];
    successfulCoverage: Required<DateRange>;
    syncedAt: string;
    calculationVersion: number;
  }) {
    this.derivedSaves += 1;
    this.technicals = [...input.technicals];
    this.states.set(`DAILY_TECHNICAL:1D:v${input.calculationVersion}`, {
      securityId: security.id,
      dataset: "DAILY_TECHNICAL",
      variant: `1D:v${input.calculationVersion}`,
      earliestDate: input.successfulCoverage.from,
      latestDate: input.successfulCoverage.to,
      lastSyncedAt: input.syncedAt,
      calculationVersion: input.calculationVersion,
    });
    this.coverage.set(`DAILY_TECHNICAL:1D:v${input.calculationVersion}`, [
      input.successfulCoverage,
    ]);
  }
  async getIntrinsicValues(_id: string, _query: IntrinsicValueQuery) {
    return this.intrinsicValues;
  }
  async getIntrinsicValueBlends(_id: string, _query: IntrinsicValueBlendQuery) {
    return this.blends;
  }
}

function service(
  store: FakeStore,
  provider: FakeProvider,
  cache: StockDataCache = new NullStockDataCache(),
) {
  return new CanonicalStockDataService(
    store,
    provider,
    cache,
    new InMemoryLoadCoordinator(),
    { now: () => new Date("2026-08-23T12:00:00.000Z") },
  );
}

describe("canonical stock-data loader", () => {
  it("serves a cache hit without a database price read or FMP call", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const expected = [price("2026-08-20")];
    await cache.set("AAPL", "daily-prices:2026-08-20:2026-08-20", expected);

    await expect(
      service(store, provider, cache).getDailyPrices("AAPL", {
        from: "2026-08-20",
        to: "2026-08-20",
      }),
    ).resolves.toEqual(expected);
    expect(store.priceReads).toBe(0);
    expect(provider.ranges).toEqual([]);
  });

  it("serves a full database hit without FMP", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    store.prices = [price("2026-08-20")];
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: "2026-08-20",
      latestDate: "2026-08-20",
    });
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2026-08-20", to: "2026-08-20" },
    ]);

    await expect(
      service(store, provider).getDailyPrices("AAPL", {
        from: "2026-08-20",
        to: "2026-08-20",
      }),
    ).resolves.toEqual(store.prices);
    expect(provider.ranges).toEqual([]);
  });

  it("loads only a missing provider prefix and returns ascending canonical rows", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    store.prices = [price("2010-01-01", 20)];
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: "2010-01-01",
      latestDate: "2026-08-20",
    });
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2010-01-01", to: "2026-08-20" },
    ]);
    provider.rowsByRange.set("2005-01-01:2009-12-31", [
      price("2005-01-03", 10),
    ]);

    const result = await service(store, provider).getDailyPrices("AAPL", {
      from: "2005-01-01",
      to: "2020-01-01",
    });

    expect(provider.ranges).toEqual([{ from: "2005-01-01", to: "2009-12-31" }]);
    expect(result.map((row) => row.date)).toEqual(["2005-01-03", "2010-01-01"]);
  });

  it("returns equivalent data on upstream, database, and cache paths", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const range = { from: "2026-08-20", to: "2026-08-20" };
    provider.rowsByRange.set("2026-08-20:2026-08-20", [
      price("2026-08-20", 123),
    ]);
    const loader = service(store, provider, cache);

    const upstream = await loader.getDailyPrices("AAPL", range);
    await cache.evict("AAPL");
    const database = await loader.getDailyPrices("AAPL", range);
    const cached = await loader.getDailyPrices("AAPL", range);

    expect(database).toEqual(upstream);
    expect(cached).toEqual(upstream);
    expect(provider.ranges).toHaveLength(1);
  });

  it("does not persist or advance state when one delta request fails", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: "2010-01-01",
      latestDate: "2020-01-01",
    });
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2010-01-01", to: "2020-01-01" },
    ]);
    provider.rowsByRange.set("2005-01-01:2009-12-31", [price("2005-01-03")]);
    provider.failRange = "2020-01-02:2025-01-01";

    await expect(
      service(store, provider).getDailyPrices("AAPL", {
        from: "2005-01-01",
        to: "2025-01-01",
      }),
    ).rejects.toThrow("upstream failed");
    expect(store.priceSaves).toBe(0);
    expect(
      store.states.get("DAILY_PRICE:split-adjusted-eod-full"),
    ).toMatchObject({
      earliestDate: "2010-01-01",
      latestDate: "2020-01-01",
    });
  });

  it("deduplicates concurrent provider work after the second caller rechecks state", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    provider.rowsByRange.set("2026-08-20:2026-08-20", [price("2026-08-20")]);
    const loader = service(store, provider);
    const requested = { from: "2026-08-20", to: "2026-08-20" };

    const [first, second] = await Promise.all([
      loader.getDailyPrices("AAPL", requested),
      loader.getDailyPrices("AAPL", requested),
    ]);

    expect(second).toEqual(first);
    expect(provider.ranges).toHaveLength(1);
  });

  it("invalidates derived persistence when canonical price coverage changes", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    store.technicals = [
      {
        securityId: security.id,
        date: "2026-08-20",
        sma20d: 100,
        calculationVersion: 1,
      },
    ];
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2026-08-20", to: "2026-08-20" },
    ]);
    store.states.set("DAILY_TECHNICAL:1D:v1", {
      securityId: security.id,
      dataset: "DAILY_TECHNICAL",
      variant: "1D:v1",
      earliestDate: "2026-08-20",
      latestDate: "2026-08-20",
      calculationVersion: 1,
    });
    store.coverage.set("DAILY_TECHNICAL:1D:v1", [
      { from: "2026-08-20", to: "2026-08-20" },
    ]);
    provider.rowsByRange.set("2026-08-19:2026-08-19", [
      price("2026-08-19", 99),
    ]);

    await service(store, provider).getDailyPrices("AAPL", {
      from: "2026-08-19",
      to: "2026-08-20",
    });

    expect(store.technicals).toEqual([]);
    expect(store.states.has("DAILY_TECHNICAL:1D:v1")).toBe(false);
  });

  it("uses eligible pre-range components when calculating blend points", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    store.intrinsicValues = [
      {
        securityId: security.id,
        valuationDate: "2025-01-01",
        sourceDataAsOf: "2025-01-01T12:00:00.000Z",
        model: "DCF_FCFF",
        valuePerShare: 100,
        currency: "USD",
        calculationVersion: 1,
      },
      {
        securityId: security.id,
        valuationDate: "2025-01-01",
        sourceDataAsOf: "2025-01-01T12:00:00.000Z",
        model: "RESIDUAL_INCOME",
        valuePerShare: 80,
        currency: "USD",
        calculationVersion: 1,
      },
      {
        securityId: security.id,
        valuationDate: "2025-02-01",
        sourceDataAsOf: "2025-02-01T12:00:00.000Z",
        model: "GRAHAM",
        valuePerShare: 60,
        currency: "USD",
        calculationVersion: 1,
      },
    ];

    const result = await service(store, provider).getIntrinsicValueBlends(
      "AAPL",
      {
        from: "2025-02-01",
        to: "2025-02-01",
        blendIds: ["BALANCED"],
      },
    );

    expect(result).toEqual([
      expect.objectContaining({
        valuationDate: "2025-02-01",
        blendId: "BALANCED",
        valuePerShare: 86,
      }),
    ]);
  });

  it("recalculates derived rows when the calculation version is stale", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    store.prices = Array.from({ length: 220 }, (_, index) =>
      price(
        `2025-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        index + 1,
      ),
    );
    store.states.set("DAILY_PRICE:split-adjusted-eod-full", {
      securityId: security.id,
      dataset: "DAILY_PRICE",
      variant: "split-adjusted-eod-full",
      earliestDate: "2024-01-01",
      latestDate: "2026-08-20",
    });
    store.coverage.set("DAILY_PRICE:split-adjusted-eod-full", [
      { from: "2024-01-01", to: "2026-08-20" },
    ]);
    store.states.set("DAILY_TECHNICAL:1D:v1", {
      securityId: security.id,
      dataset: "DAILY_TECHNICAL",
      variant: "1D:v1",
      earliestDate: "2025-01-01",
      latestDate: "2025-08-24",
      calculationVersion: 0,
    });

    await service(store, provider).getDailyTechnicals("AAPL", {
      from: "2025-01-01",
      to: "2025-08-24",
    });

    expect(store.derivedSaves).toBe(1);
    expect(store.technicals.at(-1)?.calculationVersion).toBe(1);
  });
});
