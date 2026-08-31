import type { Security, SecurityListingCandidate } from "@intrinsic/domain";
import type {
  FmpSecurityCatalogPort,
  MappedFmpSecurityListing,
} from "@intrinsic/fmp";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  PersistedSecurityCatalogEntry,
  SecurityCatalogEntry,
  StockDataStore,
} from "./ports.js";
import { CanonicalSecurityCatalogService } from "./security-catalog.js";

const EXCHANGES = ["NASDAQ", "NYSE"] as const;

function listing(
  symbol: string,
  overrides: Partial<SecurityListingCandidate> = {},
): MappedFmpSecurityListing {
  return {
    providerSymbol: symbol,
    listing: {
      symbol,
      name: `${symbol} Corporation`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      country: "US",
      sector: "Technology",
      industry: "Semiconductors",
      isEtf: false,
      isFund: false,
      isActivelyTrading: true,
      ...overrides,
    },
  };
}

function persisted(
  symbol: string,
  overrides: Partial<Security> = {},
): PersistedSecurityCatalogEntry {
  return {
    providerSymbol: symbol,
    security: {
      id: `id-${symbol}`,
      symbol,
      name: `${symbol} Corporation`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      currency: "USD",
      country: "US",
      sector: "Technology",
      industry: "Semiconductors",
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
      ...overrides,
    },
  };
}

class FakeCatalogProvider implements FmpSecurityCatalogPort {
  readonly requestedExchanges: string[] = [];
  byExchange = new Map<string, MappedFmpSecurityListing[]>();

  async getStockUniverse(
    exchangeCode: string,
  ): Promise<MappedFmpSecurityListing[]> {
    this.requestedExchanges.push(exchangeCode);
    return this.byExchange.get(exchangeCode) ?? [];
  }
}

/**
 * Only the catalog surface of the store is implemented. Every other method throws, which is the
 * assertion that catalog synchronization never touches prices, fundamentals or derived state.
 */
class FakeCatalogStore {
  existing: PersistedSecurityCatalogEntry[] = [];
  readonly created: SecurityCatalogEntry[] = [];
  readonly updated: SecurityCatalogEntry[] = [];
  createFailures = new Set<string>();
  updateFailures = new Set<string>();

  async findSecurityCatalogEntries(providerSymbols: readonly string[]) {
    return this.existing.filter((entry) =>
      providerSymbols.includes(entry.providerSymbol),
    );
  }

  async createSecurityCatalogEntries(entries: readonly SecurityCatalogEntry[]) {
    const bad = entries.find((entry) =>
      this.createFailures.has(entry.providerSymbol),
    );
    if (bad) {
      throw new Error(`create failed for ${bad.providerSymbol}`);
    }
    this.created.push(...entries);
    return entries.length;
  }

  async updateSecurityCatalogEntry(entry: SecurityCatalogEntry) {
    if (this.updateFailures.has(entry.providerSymbol)) {
      throw new Error(`update failed for ${entry.providerSymbol}`);
    }
    this.updated.push(entry);
  }
}

function catalogStore(fake: FakeCatalogStore): StockDataStore {
  return new Proxy(fake as unknown as StockDataStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (value === undefined && typeof property === "string") {
        throw new Error(
          `Catalog synchronization must not call StockDataStore.${property}`,
        );
      }
      return value;
    },
  });
}

let store: FakeCatalogStore;
let provider: FakeCatalogProvider;

function service(): CanonicalSecurityCatalogService {
  return new CanonicalSecurityCatalogService(
    catalogStore(store),
    provider,
    EXCHANGES,
  );
}

beforeEach(() => {
  store = new FakeCatalogStore();
  provider = new FakeCatalogProvider();
});

describe("security catalog synchronization", () => {
  it("reads the universe in bulk, once per supported exchange", async () => {
    provider.byExchange.set("NASDAQ", [listing("AAPL")]);
    provider.byExchange.set("NYSE", [
      listing("KO", {
        exchangeCode: "NYSE",
        exchangeName: "New York Stock Exchange",
      }),
    ]);

    const { summary } = await service().sync();

    expect(provider.requestedExchanges).toEqual(["NASDAQ", "NYSE"]);
    expect(summary.received).toBe(2);
    expect(summary.created).toBe(2);
  });

  it("inserts supported records with their catalog identity", async () => {
    provider.byExchange.set("NASDAQ", [listing("NVDA")]);

    const { summary } = await service().sync();

    expect(store.created).toEqual([
      {
        providerSymbol: "NVDA",
        security: {
          symbol: "NVDA",
          name: "NVDA Corporation",
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          country: "US",
          sector: "Technology",
          industry: "Semiconductors",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
      },
    ]);
    expect(summary).toMatchObject({
      received: 1,
      created: 1,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("is idempotent: a repeat sync of unchanged data writes nothing", async () => {
    provider.byExchange.set("NASDAQ", [listing("AAPL")]);
    store.existing = [persisted("AAPL")];

    const { summary } = await service().sync();

    expect(store.created).toEqual([]);
    expect(store.updated).toEqual([]);
    expect(summary).toMatchObject({
      received: 1,
      created: 0,
      updated: 0,
      unchanged: 1,
      failed: 0,
    });
  });

  it("updates an existing row when lightweight metadata changes upstream", async () => {
    provider.byExchange.set("NASDAQ", [
      listing("AAPL", { name: "Apple Inc.", sector: "Consumer Electronics" }),
    ]);
    store.existing = [persisted("AAPL")];

    const { summary } = await service().sync();

    expect(store.updated).toHaveLength(1);
    expect(store.updated[0]?.security).toMatchObject({
      name: "Apple Inc.",
      sector: "Consumer Electronics",
    });
    expect(summary).toMatchObject({ updated: 1, unchanged: 0, created: 0 });
  });

  it("skips non-equity and unsupported-exchange records", async () => {
    provider.byExchange.set("NASDAQ", [
      listing("SPY", { isEtf: true }),
      listing("VTSAX", { isFund: true }),
      listing("SHEL.L", { exchangeCode: "LSE" }),
      listing("BROKEN", { name: "   " }),
      listing("MSFT"),
    ]);

    const { summary, skippedByReason } = await service().sync();

    expect(store.created.map((entry) => entry.providerSymbol)).toEqual([
      "MSFT",
    ]);
    expect(summary).toMatchObject({ received: 5, skipped: 4, created: 1 });
    expect(skippedByReason).toEqual({
      NON_EQUITY: 2,
      UNSUPPORTED_EXCHANGE: 1,
      INCOMPLETE: 1,
    });
  });

  it("synchronizes an upstream deactivation and counts it inside updated", async () => {
    provider.byExchange.set("NASDAQ", [
      listing("DEAD", { isActivelyTrading: false }),
    ]);
    store.existing = [persisted("DEAD")];

    const { summary } = await service().sync();

    expect(store.updated[0]?.security.isActivelyTrading).toBe(false);
    expect(summary).toMatchObject({ updated: 1, deactivated: 1 });
  });

  it("leaves a security that disappeared from the response untouched", async () => {
    provider.byExchange.set("NASDAQ", [listing("AAPL")]);
    store.existing = [persisted("AAPL"), persisted("GONE")];

    const { summary } = await service().sync();

    // Absence from one response is not evidence of anything, so the row is neither deleted nor
    // deactivated; it simply is not part of this synchronization.
    expect(store.updated).toEqual([]);
    expect(store.created).toEqual([]);
    expect(summary).toMatchObject({
      received: 1,
      unchanged: 1,
      deactivated: 0,
    });
  });

  it("does not hydrate prices, fundamentals or derived state", async () => {
    provider.byExchange.set("NASDAQ", [listing("AAPL"), listing("MSFT")]);

    // The store proxy throws on any non-catalog method, so completing the sync is the assertion.
    await expect(service().sync()).resolves.toMatchObject({
      summary: { created: 2 },
    });
  });

  it("isolates a failing row instead of losing the whole batch", async () => {
    provider.byExchange.set("NASDAQ", [
      listing("GOOD1"),
      listing("BAD"),
      listing("GOOD2"),
    ]);
    store.createFailures.add("BAD");

    const { summary, failures } = await service().sync();

    expect(store.created.map((entry) => entry.providerSymbol)).toEqual([
      "GOOD1",
      "GOOD2",
    ]);
    expect(summary).toMatchObject({ created: 2, failed: 1 });
    expect(failures.map((failure) => failure.providerSymbol)).toEqual(["BAD"]);
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });

  it("reports an update failure without aborting the remaining updates", async () => {
    provider.byExchange.set("NASDAQ", [
      listing("A", { name: "A Renamed" }),
      listing("B", { name: "B Renamed" }),
    ]);
    store.existing = [persisted("A"), persisted("B")];
    store.updateFailures.add("A");

    const { summary, failures } = await service().sync();

    expect(store.updated.map((entry) => entry.providerSymbol)).toEqual(["B"]);
    expect(summary).toMatchObject({ updated: 1, failed: 1 });
    expect(failures.map((failure) => failure.providerSymbol)).toEqual(["A"]);
  });

  it("collapses a symbol the provider lists twice into one catalog entry", async () => {
    provider.byExchange.set("NASDAQ", [listing("DUP"), listing("DUP")]);

    const { summary } = await service().sync();

    expect(store.created).toHaveLength(1);
    expect(summary).toMatchObject({ received: 2, created: 1 });
  });
});
