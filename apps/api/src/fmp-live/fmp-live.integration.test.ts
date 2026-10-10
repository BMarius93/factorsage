import { randomUUID } from "node:crypto";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import {
  FmpRequestRefusedError,
  type FmpSecurityCatalogPort,
} from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  ALTERNATIVE_DATA_DOMAINS,
  CanonicalSecurityCatalogService,
  createStockDataRedisClient,
} from "@intrinsic/stock-data";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLiveFmpArguments } from "./fmp-live-arguments";
import { readLiveFmpStoredCoverage } from "./fmp-live-coverage";
import { admitApprovedSecurities } from "./fmp-live-identity";
import { formatLiveFmpReport } from "./fmp-live-report";
import { executeLiveFmpRun, liveFmpHistoryRange } from "./fmp-live-run";
import { createLiveFmpRuntime, type LiveFmpRuntime } from "./fmp-live-runtime";

/**
 * A whole live run, offline: the real composition (`createLiveFmpRuntime`), the real loaders, the
 * real PostgreSQL and Redis — and a provider that is a function in this file.
 *
 * This is where the guarantees are proven against the code that would actually run, rather than
 * against a recorder: a run hydrates through the canonical loaders and stores what they store; a
 * second run reuses it; and the product's own services, asked for a security or an operation
 * outside the run, are refused at the client before the function standing in for the network is
 * ever called.
 *
 * The securities and every value served for them are synthetic. Nothing here was ever a provider
 * response, and the symbols are random so no fixture or leftover can collide with them.
 */

/** Not a credential: what the offline provider expects, so a real key would be noticed. */
const OFFLINE_KEY = "offline-fmp-live-suite";

// Before `.env` is loaded, so nothing a developer keeps there can replace them: `loadRootEnv`
// never overrides a variable that is already set.
const ENVIRONMENT: Record<string, string> = {
  FMP_API_KEY: OFFLINE_KEY,
  // The gate's lease is twice this. A request that finds the gate full sleeps until the oldest
  // lease expires, so the lease — not the work — sets how long a burst of six statements takes.
  FMP_TIMEOUT_MS: "300",
  FMP_RETRY_BASE_DELAY_MS: "5",
  FMP_MAX_RETRIES: "3",
};
const previousEnvironment = Object.fromEntries(
  Object.keys(ENVIRONMENT).map((name) => [name, process.env[name]]),
);
Object.assign(process.env, ENVIRONMENT);
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The live-FMP run suite requires TEST_REDIS_URL or REDIS_URL. CI must not skip it silently: " +
      "it is the proof that a run is bounded when it goes through the real loaders.",
  );
}
const describeInfrastructure = redisUrl ? describe : describe.skip;

const IPO_DATE = "2019-01-02";
const TODAY = new Date().toISOString().slice(0, 10);

/** Weekdays from the listing date to today, newest first, as the endpoint answers. */
function syntheticBars(symbol: string, from: string, to: string) {
  const bars: Record<string, unknown>[] = [];
  const start = from > IPO_DATE ? from : IPO_DATE;
  const end = to < TODAY ? to : TODAY;
  let session = 0;
  for (
    let day = new Date(`${IPO_DATE}T00:00:00.000Z`);
    day.toISOString().slice(0, 10) <= end;
    day = new Date(day.getTime() + 86_400_000)
  ) {
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    session += 1;
    const date = day.toISOString().slice(0, 10);
    if (date < start) {
      continue;
    }
    const close = 40 + session * 0.05;
    bars.push({
      symbol,
      date,
      open: close - 0.2,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 100_000 + session,
    });
  }
  return bars.reverse();
}

type ProviderCall = { readonly path: string; readonly symbol: string | null };

/** The far end of the wire. Records every request that reaches it. */
function offlineProvider(known: ReadonlySet<string>) {
  const calls: ProviderCall[] = [];
  const fetchImplementation = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.origin !== "https://financialmodelingprep.com") {
      throw new Error(`A live run asked ${url.origin}, not the provider`);
    }
    if (url.searchParams.get("apikey") !== OFFLINE_KEY) {
      throw new Error(
        "The offline provider was sent a key that is not its own",
      );
    }
    const path = url.pathname.replace(/^\/stable\//, "");
    const symbol = url.searchParams.get("symbol");
    calls.push({ path, symbol });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });

    if (symbol === null || !known.has(symbol)) {
      return json([]);
    }
    switch (path) {
      case "profile":
        return json([
          {
            symbol,
            companyName: `Synthetic ${symbol} Corporation`,
            exchange: "NASDAQ",
            exchangeFullName: "NASDAQ Global Select",
            currency: "USD",
            country: "US",
            sector: "Technology",
            industry: "Software",
            ipoDate: IPO_DATE,
            isEtf: false,
            isFund: false,
            isAdr: false,
            isActivelyTrading: true,
          },
        ]);
      case "historical-price-eod/full":
        return json(
          syntheticBars(
            symbol,
            url.searchParams.get("from") ?? IPO_DATE,
            url.searchParams.get("to") ?? TODAY,
          ),
        );
      case "splits":
        return json([
          {
            symbol,
            date: "2021-06-01",
            numerator: 2,
            denominator: 1,
            splitType: "stock-split",
          },
        ]);
      case "insider-trading/search":
        return json(
          url.searchParams.get("page") === "0"
            ? [
                {
                  symbol,
                  filingDate: "2024-03-06",
                  transactionDate: "2024-03-04",
                  reportingCik: "0000000001",
                  companyCik: "0000000002",
                  transactionType: "P-Purchase",
                  securitiesOwned: 1500,
                  reportingName: "Synthetic Director",
                  typeOfOwner: "director",
                  acquisitionOrDisposition: "A",
                  directOrIndirect: "D",
                  formType: "4",
                  securitiesTransacted: 500,
                  price: 52.5,
                  securityName: "Common Stock",
                  url: "",
                },
              ]
            : [],
        );
      default:
        // Statements and congressional trades: the synthetic company has none.
        return json([]);
    }
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

const logger = createLogger({
  service: "api",
  level: "silent",
  environment: "test",
});

describeInfrastructure("a live FMP run through the real loaders", () => {
  const tag = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const A = `LV${tag}A`;
  const B = `LV${tag}B`;
  const C = `LV${tag}C`;
  const OUTSIDER = `LV${tag}X`;
  const UNKNOWN = `LV${tag}N`;
  const ALL = [A, B, C, OUTSIDER, UNKNOWN];
  const namespace = `stock-data:v2:test:fmp-live:${tag}`;
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const runtimes: LiveFmpRuntime[] = [];

  function runtimeFor(
    symbols: readonly string[],
    provider: ReturnType<typeof offlineProvider>,
    budget = 200,
  ): LiveFmpRuntime & { runId: string } {
    const runId = randomUUID();
    const runtime = createLiveFmpRuntime({
      symbols,
      budget,
      runId,
      logger,
      fetchImplementation: provider.fetchImplementation,
      redisNamespace: namespace,
    });
    runtimes.push(runtime);
    return Object.assign(runtime, { runId });
  }

  function execute(
    runtime: LiveFmpRuntime & { runId: string },
    ...argv: string[]
  ) {
    return executeLiveFmpRun({
      arguments: parseLiveFmpArguments(argv),
      runId: runtime.runId,
      databaseName: "test",
      databaseHost: "localhost",
      dependencies: {
        readStoredCoverage: (securityId) =>
          readLiveFmpStoredCoverage(runtime.prisma, securityId),
        scope: runtime.scope,
        budget: runtime.budget,
        guard: runtime.guard,
        loaders: {
          stockData: runtime.stockData,
          alternativeData: runtime.alternativeData,
        },
        getSecurity: (symbol) => runtime.stockData.getSecurity(symbol),
        admit: (symbols) =>
          admitApprovedSecurities({
            store: runtime.store,
            cache: runtime.cache,
            provider: runtime.provider,
            symbols,
          }),
        productHistoryYears: runtime.productHistoryYears,
        alternativeDataMaxPages: runtime.alternativeDataMaxPages,
        maxRetries: runtime.maxRetries,
        logger,
      },
    });
  }

  async function removeSecurities(): Promise<void> {
    await prisma.security.deleteMany({
      where: { providerSymbol: { in: ALL } },
    });
  }

  beforeAll(async () => {
    await redis.ping();
    await removeSecurities();
  });

  afterAll(async () => {
    for (const runtime of runtimes) {
      await runtime.close();
    }
    await removeSecurities();
    await prisma.$disconnect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${namespace}*`,
        "COUNT",
        500,
      );
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
    redis.disconnect();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("hydrates two securities the catalog has never seen, through the canonical paths", async () => {
    const provider = offlineProvider(new Set([A, B]));
    const runtime = runtimeFor([A, B], provider);

    const report = await execute(
      runtime,
      "--symbols",
      `${A.toLowerCase()},${B}, ${A}`,
      "--full-history",
    );

    expect(report.outcome).toBe("SUCCEEDED");
    expect(report.approved).toEqual([A, B]);
    expect(report.resolved.map((entry) => entry.origin)).toEqual([
      "ADMITTED",
      "ADMITTED",
    ]);

    // Identity is the catalog's: one `Security` each, admitted by the catalog service with its
    // own classification, then enriched by the loader's profile sync.
    const securities = await prisma.security.findMany({
      where: { providerSymbol: { in: [A, B] } },
      orderBy: { providerSymbol: "asc" },
    });
    expect(securities.map((row) => row.providerSymbol)).toEqual([A, B]);
    for (const row of securities) {
      expect(row).toMatchObject({
        type: SecurityType.STOCK,
        exchangeCode: "NASDAQ",
        currency: "USD",
        isActivelyTrading: true,
      });
      expect(row.ipoDate?.toISOString().slice(0, 10)).toBe(IPO_DATE);
    }
    expect(report.resolved.map((entry) => entry.security.id)).toEqual(
      securities.map((row) => row.id),
    );

    // Nothing but the two approved securities ever reached the provider…
    expect(new Set(provider.calls.map((call) => call.symbol))).toEqual(
      new Set([A, B]),
    );
    // …and exactly these requests did, per security: identity, the loader's profile sync, one
    // page of prices, six statement histories, the split list, one insider page and one page per
    // chamber. Thirteen, and the ledger, the budget counter and the wire all agree.
    const perSecurity = (symbol: string) =>
      provider.calls
        .filter((call) => call.symbol === symbol)
        .map((call) => call.path)
        .sort();
    expect(perSecurity(A)).toEqual(
      [
        "profile",
        "profile",
        "historical-price-eod/full",
        "income-statement",
        "income-statement",
        "balance-sheet-statement",
        "balance-sheet-statement",
        "cash-flow-statement",
        "cash-flow-statement",
        "splits",
        "insider-trading/search",
        "senate-trades",
        "house-trades",
      ].sort(),
    );
    expect(perSecurity(B)).toEqual(perSecurity(A));
    expect(provider.calls).toHaveLength(26);
    expect(report.ledger).toMatchObject({
      sent: 26,
      authorized: 26,
      refusals: [],
      budgetExhausted: false,
    });
    expect(report.budgetUsed).toBe(26);
    expect(report.ledger.sent).toBeLessThanOrEqual(report.ceiling.total);

    // What the loaders stored, read back from PostgreSQL.
    for (const symbol of [A, B]) {
      const stored = new Map(
        (report.stored.get(symbol) ?? []).map((dataset) => [
          dataset.dataset,
          dataset,
        ]),
      );
      const prices = stored.get("DAILY_PRICE");
      expect(prices?.rows).toBeGreaterThan(1_900);
      expect(prices?.earliest).toBe(IPO_DATE);
      expect(prices?.latest).toBe(
        syntheticBars(symbol, IPO_DATE, TODAY)[0]?.date,
      );
      // The derived state is calculated by the loader for every stored session.
      expect(stored.get("DAILY_DERIVED_STATE")?.rows).toBe(prices?.rows);
      expect(stored.get("SECURITY_PROFILE")?.rows).toBe(1);
      expect(stored.get("STOCK_SPLIT")).toMatchObject({
        rows: 1,
        earliest: "2021-06-01",
      });
      expect(stored.get("INSIDER_TRADE (available from)")?.rows).toBe(1);
      expect(stored.get("CONGRESS_TRADE (available from)")?.rows).toBe(0);
      for (const dataset of [
        "DAILY_PRICE",
        "STOCK_SPLIT",
        "INSIDER_TRADE (available from)",
        "CONGRESS_TRADE (available from)",
        "INCOME_STATEMENT quarterly (fiscal period end)",
        "CASH_FLOW annual (fiscal period end)",
      ]) {
        expect(stored.get(dataset)?.lastSyncedAt, dataset).not.toBeNull();
      }
    }

    // Every step ran, and the ratios were read through the Stock Details path.
    for (const security of report.securities) {
      expect(security.steps.map((step) => step.status)).toEqual([
        "COMPLETED",
        "COMPLETED",
        "COMPLETED",
      ]);
      expect(security.ratios).toHaveLength(5);
      expect(security.ratios[0]?.sessions).toBeGreaterThan(1_900);
    }

    const text = formatLiveFmpReport(report);
    expect(text).toContain("Live FMP hydration: SUCCEEDED");
    expect(text).toContain(
      "admitted to the security catalog from its provider profile",
    );
    expect(text).toContain("Provider requests: 26 sent of a budget of 200");
    // A report is names, counts and dates: no key, and nothing a response carried.
    expect(text).not.toContain(OFFLINE_KEY);
    expect(text).not.toContain("Synthetic Director");
    expect(text).not.toContain("52.5");
  }, 120_000);

  it("reuses what is stored: a second run asks the provider for nothing", async () => {
    const provider = offlineProvider(new Set([A, B]));
    const runtime = runtimeFor([A, B], provider);

    const report = await execute(
      runtime,
      "--symbols",
      `${A},${B}`,
      "--full-history",
    );

    expect(report.outcome).toBe("SUCCEEDED");
    expect(report.resolved.map((entry) => entry.origin)).toEqual([
      "CATALOG",
      "CATALOG",
    ]);
    // Coverage, the profile, the statements, the split list and both alternative-data domains are
    // inside their freshness windows, so the loaders had no reason to ask.
    expect(provider.calls).toEqual([]);
    expect(report.ledger.sent).toBe(0);
    expect(report.budgetUsed).toBe(0);
    expect(formatLiveFmpReport(report)).toContain(
      "0  (nothing asked: stored data was fresh or already covered)",
    );
  }, 120_000);

  it("refuses the product's own loaders a security outside the run, before the network", async () => {
    // A catalog security the run was not approved for — exactly what a list, a Monitor or a
    // helper holding a wider set would hand the loader.
    const outsider = await prisma.security.create({
      data: {
        providerSymbol: OUTSIDER,
        symbol: OUTSIDER,
        name: "Outside The Run Inc.",
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    const range = liveFmpHistoryRange(30, TODAY);

    const viaStockData = offlineProvider(new Set([A, B, OUTSIDER]));
    const first = runtimeFor([A, B], viaStockData);
    for (const symbol of [A, B]) {
      first.scope.bind({
        securityId: (await first.stockData.getSecurity(symbol)).id,
        providerSymbol: symbol,
      });
    }
    await expect(
      first.stockData.getDailyDerivedState(OUTSIDER, range),
    ).rejects.toMatchObject({
      name: "FmpRequestRefusedError",
      reason: "SECURITY_NOT_APPROVED",
    });
    expect(viaStockData.calls).toEqual([]);
    expect(first.guard.ledger().refusals[0]).toMatchObject({
      reason: "SECURITY_NOT_APPROVED",
      symbol: OUTSIDER,
    });
    expect(await first.budget.used()).toBe(0);

    const viaAlternativeData = offlineProvider(new Set([A, B, OUTSIDER]));
    const second = runtimeFor([A, B], viaAlternativeData);
    await expect(
      second.alternativeData.ensureIngested(
        await second.stockData.getSecurity(OUTSIDER),
        ALTERNATIVE_DATA_DOMAINS,
      ),
    ).rejects.toBeInstanceOf(FmpRequestRefusedError);
    expect(viaAlternativeData.calls).toEqual([]);

    // Nothing was stored for it either.
    expect(
      await prisma.dailyPrice.count({ where: { securityId: outsider.id } }),
    ).toBe(0);
    expect(
      await prisma.insiderTransaction.count({
        where: { securityId: outsider.id },
      }),
    ).toBe(0);
  }, 120_000);

  it("refuses the real catalog synchronization its exchange-wide request", async () => {
    const provider = offlineProvider(new Set([A]));
    const runtime = runtimeFor([A], provider);
    const before = await prisma.security.count();

    // The admin sync's own service, handed the run's client as its provider.
    const sync = new CanonicalSecurityCatalogService(
      runtime.store,
      runtime.provider as FmpSecurityCatalogPort,
    ).sync();

    await expect(sync).rejects.toMatchObject({
      reason: "NOT_A_SECURITY_ENDPOINT",
    });
    expect(provider.calls).toEqual([]);
    expect(await prisma.security.count()).toBe(before);
  }, 60_000);

  it("stops at the budget, sends exactly that many requests, and reports an incomplete run", async () => {
    const provider = offlineProvider(new Set([C]));
    const runtime = runtimeFor([C], provider, 5);

    const report = await execute(
      runtime,
      "--symbols",
      C,
      "--full-history",
      "--budget",
      "5",
    );

    expect(report.outcome).toBe("BUDGET_EXHAUSTED");
    // Five and not six: the request that would have been one too many never left.
    expect(provider.calls).toHaveLength(5);
    expect(report.budgetUsed).toBe(5);
    expect(report.ledger).toMatchObject({
      sent: 5,
      budget: 5,
      budgetExhausted: true,
    });
    expect(
      report.ledger.refusals.some(
        (refusal) => refusal.reason === "BUDGET_EXHAUSTED",
      ),
    ).toBe(true);
    expect(report.securities[0]?.steps.map((step) => step.status)).not.toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(formatLiveFmpReport(report)).toContain(
      "What is stored is INCOMPLETE",
    );

    // A later run with a real budget finishes the job from where the loaders left it.
    const resumed = offlineProvider(new Set([C]));
    const completed = await execute(
      runtimeFor([C], resumed),
      "--symbols",
      C,
      "--full-history",
    );
    expect(completed.outcome).toBe("SUCCEEDED");
    expect(resumed.calls.length).toBeGreaterThan(0);
    expect(resumed.calls.length).toBeLessThan(13);
  }, 120_000);

  it("spends one request on a symbol that names nothing, and creates nothing", async () => {
    const provider = offlineProvider(new Set());
    const runtime = runtimeFor([UNKNOWN], provider);

    const report = await execute(
      runtime,
      "--symbols",
      UNKNOWN,
      "--full-history",
    );

    expect(report.outcome).toBe("FAILED");
    expect(report.unresolved).toEqual([
      {
        symbol: UNKNOWN,
        reason: "the provider has no security under this symbol",
      },
    ]);
    expect(provider.calls).toEqual([{ path: "profile", symbol: UNKNOWN }]);
    expect(report.securities).toEqual([]);
    expect(
      await prisma.security.count({ where: { providerSymbol: UNKNOWN } }),
    ).toBe(0);
  }, 60_000);

  it("cannot be composed for a fourth security", () => {
    const provider = offlineProvider(new Set());
    expect(() =>
      createLiveFmpRuntime({
        symbols: [A, B, C, OUTSIDER],
        budget: 200,
        runId: randomUUID(),
        logger,
        fetchImplementation: provider.fetchImplementation,
        redisNamespace: namespace,
      }),
    ).toThrowError(/at most 3 securities; 4 distinct symbols/);
    expect(provider.calls).toEqual([]);
  });
});
