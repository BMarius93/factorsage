import {
  FmpClient,
  FmpRequestBudgetExhaustedError,
  FmpRequestRefusedError,
  FmpSecurityScope,
  type FmpRequestBudget,
} from "@intrinsic/fmp";
import { describe, expect, it, vi } from "vitest";
import { LIVE_FMP_MAX_SECURITIES } from "./fmp-live-arguments";
import { LiveFmpRunGuard } from "./fmp-live-guard";

/**
 * The live run's guard, driven through a real `FmpClient` whose network is a function: what the
 * loaders would ask, what reaches the wire, and what the ledger says about both.
 */

class MemoryBudget implements FmpRequestBudget {
  taken = 0;
  failWith: Error | null = null;

  constructor(readonly limit: number) {}

  async consume(): Promise<number> {
    if (this.failWith) {
      throw this.failWith;
    }
    if (this.taken >= this.limit) {
      throw new FmpRequestBudgetExhaustedError(this.limit);
    }
    this.taken += 1;
    return this.taken;
  }

  async used(): Promise<number> {
    return this.taken;
  }
}

function setup(options: { symbols?: string[]; budget?: number } = {}) {
  const scope = new FmpSecurityScope(
    options.symbols ?? ["AAPL", "MSFT", "NVDA"],
    {
      maxSecurities: LIVE_FMP_MAX_SECURITIES,
    },
  );
  for (const symbol of scope.symbols) {
    scope.bind({ securityId: `security-${symbol}`, providerSymbol: symbol });
  }
  const budget = new MemoryBudget(options.budget ?? 100);
  const guard = new LiveFmpRunGuard(scope, budget);
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response("[]", { status: 200 }),
  );
  const client = new FmpClient(
    () => ({
      apiKey: "test-secret-key",
      timeoutMs: 1_000,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    }),
    fetchMock,
    { guard, sleep: async () => {}, random: () => 0 },
  );
  return { scope, budget, guard, fetchMock, client };
}

const RANGE = { from: "2020-01-01", to: "2020-12-31" };

describe("live FMP run guard", () => {
  it("lets the approved securities through and counts what was sent", async () => {
    const { client, guard, fetchMock, budget } = setup();

    await client.getProfile("AAPL");
    await client.getDailyPrices("AAPL", "security-AAPL", RANGE);
    await client.getFinancialStatements(
      "AAPL",
      "security-AAPL",
      "INCOME",
      "QUARTERLY",
      4,
    );
    await client.getFinancialStatements(
      "AAPL",
      "security-AAPL",
      "CASH_FLOW",
      "ANNUAL",
      4,
    );
    await client.getStockSplits("MSFT", "security-MSFT");
    await client.getInsiderTrades({ symbol: "NVDA", page: 0, limit: 1000 });
    await client.getCongressTrades({
      chamber: "SENATE",
      symbol: "NVDA",
      page: 0,
      limit: 250,
    });
    await client.getCongressTrades({
      chamber: "HOUSE",
      symbol: "NVDA",
      page: 0,
      limit: 250,
    });

    const ledger = guard.ledger();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(ledger).toMatchObject({
      sent: 8,
      authorized: 8,
      budget: 100,
      refusals: [],
      budgetExhausted: false,
    });
    expect(await budget.used()).toBe(8);
    expect(guard.refused).toBe(false);
    expect(ledger.byRequest).toEqual([
      {
        symbol: "AAPL",
        dataset: "DAILY_PRICE",
        endpoint: "historical-price-eod/full",
        requests: 1,
      },
      {
        symbol: "AAPL",
        dataset: "FINANCIAL_STATEMENTS",
        endpoint: "cash-flow-statement",
        requests: 1,
      },
      {
        symbol: "AAPL",
        dataset: "FINANCIAL_STATEMENTS",
        endpoint: "income-statement",
        requests: 1,
      },
      {
        symbol: "AAPL",
        dataset: "SECURITY_PROFILE",
        endpoint: "profile",
        requests: 1,
      },
      {
        symbol: "MSFT",
        dataset: "STOCK_SPLIT",
        endpoint: "splits",
        requests: 1,
      },
      {
        symbol: "NVDA",
        dataset: "CONGRESS_TRADES",
        endpoint: "house-trades",
        requests: 1,
      },
      {
        symbol: "NVDA",
        dataset: "CONGRESS_TRADES",
        endpoint: "senate-trades",
        requests: 1,
      },
      {
        symbol: "NVDA",
        dataset: "INSIDER_TRANSACTIONS",
        endpoint: "insider-trading/search",
        requests: 1,
      },
    ]);
    // Names and counts only: nothing the ledger holds could carry a key or a payload.
    expect(JSON.stringify(ledger)).not.toContain("test-secret-key");
  });

  it("refuses an internal request for a fourth security before the network, and says so", async () => {
    const { client, guard, fetchMock, budget } = setup();
    await client.getProfile("AAPL");

    // Not the command line: a helper deep inside a loader asking for something it should not.
    await expect(
      client.getDailyPrices("GOOGL", "security-GOOGL", RANGE),
    ).rejects.toMatchObject({ reason: "SECURITY_NOT_APPROVED" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await budget.used()).toBe(1);
    expect(guard.refused).toBe(true);
    expect(guard.ledger().refusals).toEqual([
      {
        reason: "SECURITY_NOT_APPROVED",
        endpoint: "historical-price-eod/full",
        symbol: "GOOGL",
        count: 1,
      },
    ]);
  });

  it("fails closed: after any refusal, approved requests are refused too", async () => {
    const { client, guard, fetchMock } = setup();
    await expect(client.getStockUniverse("NASDAQ")).rejects.toMatchObject({
      reason: "NOT_A_SECURITY_ENDPOINT",
    });

    await expect(client.getProfile("AAPL")).rejects.toMatchObject({
      reason: "GUARD_CLOSED",
    });
    await expect(
      client.getStockSplits("MSFT", "security-MSFT"),
    ).rejects.toBeInstanceOf(FmpRequestRefusedError);
    await expect(client.getProfile("AAPL")).rejects.toMatchObject({
      reason: "GUARD_CLOSED",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(guard.ledger().refusals).toEqual([
      {
        reason: "NOT_A_SECURITY_ENDPOINT",
        endpoint: "company-screener",
        symbol: null,
        count: 1,
      },
      { reason: "GUARD_CLOSED", endpoint: "profile", symbol: "AAPL", count: 2 },
      { reason: "GUARD_CLOSED", endpoint: "splits", symbol: "MSFT", count: 1 },
    ]);
  });

  it.each([
    [
      "the exchange-wide screener",
      (client: FmpClient) => client.getStockUniverse("NYSE"),
    ],
    [
      "a batch of quotes",
      (client: FmpClient) => client.getCurrentQuotes(["AAPL", "MSFT"]),
    ],
    [
      "an exchange calendar",
      (client: FmpClient) =>
        client.getExchangeHolidays("NYSE", "2025-12-31", "2026-12-31"),
    ],
    [
      "a benchmark series",
      (client: FmpClient) =>
        client.getBenchmarkDailyPrices("SPY", "series", RANGE),
    ],
    [
      "an index series",
      (client: FmpClient) =>
        client.getBenchmarkDailyPrices("^GSPC", "series", RANGE),
    ],
  ])("blocks %s before the network", async (_label, attempt) => {
    const { client, guard, fetchMock, budget } = setup();
    await expect(attempt(client)).rejects.toBeInstanceOf(
      FmpRequestRefusedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await budget.used()).toBe(0);
    expect(guard.refused).toBe(true);
  });

  it("stops at the budget, reports it, and sends nothing afterwards", async () => {
    const { client, guard, fetchMock, budget } = setup({ budget: 3 });
    await client.getProfile("AAPL");
    await client.getProfile("MSFT");
    await client.getProfile("NVDA");

    await expect(
      client.getStockSplits("AAPL", "security-AAPL"),
    ).rejects.toBeInstanceOf(FmpRequestBudgetExhaustedError);
    await expect(
      client.getStockSplits("MSFT", "security-MSFT"),
    ).rejects.toMatchObject({
      reason: "GUARD_CLOSED",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await budget.used()).toBe(3);
    expect(guard.exhausted).toBe(true);
    expect(guard.ledger()).toMatchObject({
      sent: 3,
      budget: 3,
      budgetExhausted: true,
    });
    expect(guard.ledger().refusals.map((refusal) => refusal.reason)).toEqual([
      "BUDGET_EXHAUSTED",
      "GUARD_CLOSED",
    ]);
  });

  it("counts retries as requests, deterministically, and authorizes the request once", async () => {
    const run = async () => {
      const { client, guard, fetchMock, scope } = setup({ symbols: ["AAPL"] });
      fetchMock
        .mockResolvedValueOnce(new Response("{}", { status: 503 }))
        .mockResolvedValueOnce(new Response("{}", { status: 502 }))
        .mockResolvedValueOnce(new Response("[]", { status: 200 }));
      await client.getStockSplits("AAPL", "security-AAPL");
      return { ledger: guard.ledger(), securities: scope.securities.length };
    };

    const first = await run();
    expect(first.ledger).toMatchObject({ sent: 3, authorized: 1 });
    expect(first.ledger.byRequest).toEqual([
      {
        symbol: "AAPL",
        dataset: "STOCK_SPLIT",
        endpoint: "splits",
        requests: 3,
      },
    ]);
    // A retry is another request, never another security.
    expect(first.securities).toBe(1);
    // The same failures give the same account, every time.
    expect((await run()).ledger).toEqual(first.ledger);
  });

  it("sends nothing when the budget cannot be consulted", async () => {
    const { client, guard, fetchMock, budget } = setup();
    budget.failWith = new Error("Redis connection lost");

    // The client reports it as a transient provider failure and retries; no attempt is sent,
    // because a request is never made on a guess about what is left.
    await expect(client.getProfile("AAPL")).rejects.toMatchObject({
      name: "FmpTransientError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guard.ledger().sent).toBe(0);
    // Not a refusal: the guard did not decide anything, so it does not close on it.
    expect(guard.refused).toBe(false);
  });

  it("holds the same limit as the command line, from the same constant", () => {
    expect(
      () =>
        new FmpSecurityScope(["AAPL", "MSFT", "NVDA", "GOOGL"], {
          maxSecurities: LIVE_FMP_MAX_SECURITIES,
        }),
    ).toThrowError(/at most 3 securities/);
  });
});
