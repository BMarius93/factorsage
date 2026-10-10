import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FmpClient, FmpProviderError, type FmpRequestGate } from "./client.js";
import { financialStatementPath } from "./mapping.js";
import {
  FMP_ENDPOINT_CLASSES,
  FMP_SYMBOL_PATTERN,
  FmpRequestBudgetExhaustedError,
  FmpRequestRefusedError,
  FmpSecurityScope,
  normalizeFmpSymbol,
  type FmpRequestBudget,
  type FmpRequestDescriptor,
  type FmpRequestGuard,
} from "./request-guard.js";

/**
 * The provider-boundary guard, proven without a network.
 *
 * Three things are established here, each at the layer that owns it:
 *
 * - **the scope** refuses everything that is not about one approved, resolved security, whoever
 *   asks and however often;
 * - **the client** asks its guard before it reads the key, enters the gate or sends anything, and
 *   spends the budget once per request actually sent;
 * - **a client without a guard** — every production composition — sends exactly what it sent
 *   before the seam existed.
 */

const profile = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  exchange: "NASDAQ",
  currency: "USD",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function config() {
  return {
    apiKey: "test-secret-key",
    timeoutMs: 1_000,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    maxRetryWaitMs: 1_000,
  };
}

const request = (
  path: string,
  query: Record<string, string>,
): FmpRequestDescriptor => ({ path, query });

/** A budget kept in memory: one JavaScript turn per consume, so it is trivially atomic. */
class CountingBudget implements FmpRequestBudget {
  private taken = 0;

  constructor(readonly limit: number) {}

  async consume(): Promise<number> {
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

/** A guard made of a scope and a budget, as a live run composes them. */
function guardOf(
  scope: FmpSecurityScope,
  budget: FmpRequestBudget,
): FmpRequestGuard {
  return {
    authorize: (descriptor) => scope.authorize(descriptor),
    admitAttempt: async () => {
      await budget.consume();
    },
  };
}

function resolvedScope(symbols: readonly string[]): FmpSecurityScope {
  const scope = new FmpSecurityScope(symbols, { maxSecurities: 3 });
  for (const symbol of scope.symbols) {
    scope.bind({ securityId: `security-${symbol}`, providerSymbol: symbol });
  }
  return scope;
}

describe("FMP symbol normalization", () => {
  it("has one spelling per symbol", () => {
    expect(normalizeFmpSymbol(" aapl ")).toBe("AAPL");
    expect(normalizeFmpSymbol("brk-b")).toBe("BRK-B");
    expect(normalizeFmpSymbol("BF.B")).toBe("BF.B");
  });

  it.each(["", " ", "AAPL,MSFT", "AAPL MSFT", "^GSPC", "A/B", "A".repeat(21)])(
    "refuses %j as a symbol",
    (value) => {
      expect(normalizeFmpSymbol(value)).toBeNull();
    },
  );

  it("is the shape the canonical loader accepts", () => {
    // `CanonicalStockDataService.getSecurity` normalizes with this exact expression. If the two
    // drift, a symbol could be approved here that the loader refuses, or the reverse.
    const service = readFileSync(
      join(__dirname, "../../stock-data/src/service.ts"),
      "utf8",
    );
    expect(service).toContain(
      `!${String(FMP_SYMBOL_PATTERN)}.test(normalized)`,
    );
  });
});

describe("FMP endpoint classification", () => {
  it("classifies every endpoint the client asks", () => {
    const source = readFileSync(join(__dirname, "client.ts"), "utf8");
    const literal = [
      ...source.matchAll(/this\.request<[^>]*>\(\s*"([^"]+)"/g),
    ].map((match) => match[1] as string);
    // The statement and congress endpoints are chosen at run time rather than written inline.
    const computed = [
      financialStatementPath("INCOME"),
      financialStatementPath("BALANCE_SHEET"),
      financialStatementPath("CASH_FLOW"),
      "senate-trades",
      "house-trades",
    ];
    expect(literal).toEqual([
      "profile",
      "company-screener",
      "historical-price-eod/full",
      "batch-quote",
      "holidays-by-exchange",
      "splits",
      "insider-trading/search",
    ]);
    // Nine `this.request` calls in the client: the seven above and two with a computed path. A
    // tenth is an endpoint somebody added without deciding what it is about.
    expect(source.match(/this\.request</g)).toHaveLength(9);
    expect([...FMP_ENDPOINT_CLASSES.keys()].sort()).toEqual(
      [...literal, ...computed].sort(),
    );
  });

  it("marks only the single-symbol endpoints as about one security", () => {
    const bySubject = (subject: string) =>
      [...FMP_ENDPOINT_CLASSES]
        .filter(([, endpoint]) => endpoint.subject === subject)
        .map(([path]) => path)
        .sort();
    expect(bySubject("EXCHANGE")).toEqual([
      "company-screener",
      "holidays-by-exchange",
    ]);
    expect(bySubject("SYMBOL_LIST")).toEqual(["batch-quote"]);
    expect(bySubject("SECURITY")).toHaveLength(9);
  });
});

describe("FMP security scope", () => {
  it("accepts one security", () => {
    const scope = resolvedScope(["AAPL"]);
    expect(scope.symbols).toEqual(["AAPL"]);
    expect(() =>
      scope.authorize(request("historical-price-eod/full", { symbol: "AAPL" })),
    ).not.toThrow();
  });

  it("accepts exactly the maximum", () => {
    const scope = resolvedScope(["AAPL", "MSFT", "NVDA"]);
    expect(scope.securities).toHaveLength(3);
    for (const symbol of ["AAPL", "MSFT", "NVDA"]) {
      expect(() =>
        scope.authorize(request("splits", { symbol })),
      ).not.toThrow();
    }
  });

  it("cannot be built for a fourth security, whoever builds it", () => {
    // The limit is the scope's own: no command line is involved in this test at all.
    expect(
      () =>
        new FmpSecurityScope(["AAPL", "MSFT", "NVDA", "GOOGL"], {
          maxSecurities: 3,
        }),
    ).toThrowError(/at most 3 securities; 4 distinct symbols/);
  });

  it("cannot be built for none, or from something that is not a symbol", () => {
    expect(() => new FmpSecurityScope([], { maxSecurities: 3 })).toThrowError(
      FmpRequestRefusedError,
    );
    expect(
      () => new FmpSecurityScope(["AAPL,MSFT"], { maxSecurities: 3 }),
    ).toThrowError(FmpRequestRefusedError);
  });

  it("counts a security once however it is spelled or repeated", () => {
    const scope = new FmpSecurityScope(
      ["AAPL", " aapl", "AAPL ", "msft", "MSFT", "NVDA"],
      { maxSecurities: 3 },
    );
    expect(scope.symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("has no way to approve another security after construction", () => {
    const scope = resolvedScope(["AAPL", "MSFT", "NVDA"]);
    expect(() =>
      scope.bind({ securityId: "security-GOOGL", providerSymbol: "GOOGL" }),
    ).toThrowError(/Only an approved symbol can be bound/);
    expect(scope.symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(() =>
      scope.authorize(request("profile", { symbol: "GOOGL" })),
    ).toThrowError(/GOOGL is not one of the 3 approved securities/);
  });

  it("refuses a fourth security on every per-security endpoint", () => {
    const scope = resolvedScope(["AAPL", "MSFT", "NVDA"]);
    for (const [path, endpoint] of FMP_ENDPOINT_CLASSES) {
      if (endpoint.subject !== "SECURITY") {
        continue;
      }
      let refusal: unknown;
      try {
        scope.authorize(request(path, { symbol: "GOOGL" }));
      } catch (error) {
        refusal = error;
      }
      expect(refusal, path).toBeInstanceOf(FmpRequestRefusedError);
      expect((refusal as FmpRequestRefusedError).reason, path).toBe(
        "SECURITY_NOT_APPROVED",
      );
    }
  });

  it("is governed by the resolved security, not by the ticker string", () => {
    const scope = new FmpSecurityScope(["AAPL"], { maxSecurities: 3 });
    // Approved as a symbol, but not yet a security: nothing but its identity may be asked.
    expect(() =>
      scope.authorize(request("profile", { symbol: "AAPL" })),
    ).not.toThrow();
    for (const path of [
      "historical-price-eod/full",
      "income-statement",
      "splits",
      "insider-trading/search",
      "senate-trades",
    ]) {
      expect(
        () => scope.authorize(request(path, { symbol: "AAPL" })),
        path,
      ).toThrowError(/has not been resolved to a catalog security/);
    }
    expect(scope.securities).toEqual([]);

    scope.bind({ securityId: "security-1", providerSymbol: "aapl" });
    expect(scope.securities).toEqual([
      { securityId: "security-1", providerSymbol: "AAPL" },
    ]);
    expect(() =>
      scope.authorize(request("historical-price-eod/full", { symbol: "AAPL" })),
    ).not.toThrow();
  });

  it("holds one entry per security: a repeat is a no-op and an alias is not a second one", () => {
    const scope = new FmpSecurityScope(["AAPL", "MSFT"], { maxSecurities: 3 });
    scope.bind({ securityId: "security-1", providerSymbol: "AAPL" });
    scope.bind({ securityId: "security-1", providerSymbol: "AAPL" });
    expect(scope.securities).toHaveLength(1);

    // A second approved symbol resolving to the same security does not become a second entry.
    expect(() =>
      scope.bind({ securityId: "security-1", providerSymbol: "MSFT" }),
    ).toThrowError(/resolve to one security; it is approved once, as AAPL/);
    // And a symbol is never re-pointed at another security.
    expect(() =>
      scope.bind({ securityId: "security-2", providerSymbol: "AAPL" }),
    ).toThrowError(/already bound to another security/);
    expect(scope.securities).toEqual([
      { securityId: "security-1", providerSymbol: "AAPL" },
    ]);
  });

  it("uses nothing up: authorizing again changes nothing", () => {
    const scope = resolvedScope(["AAPL", "MSFT", "NVDA"]);
    const before = JSON.stringify(scope.securities);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      scope.authorize(request("historical-price-eod/full", { symbol: "aapl" }));
    }
    expect(JSON.stringify(scope.securities)).toBe(before);
    expect(scope.symbols).toHaveLength(3);
  });

  it.each([
    ["company-screener", { exchange: "NASDAQ", limit: "20000" }],
    ["holidays-by-exchange", { exchange: "NYSE", from: "a", to: "b" }],
    ["batch-quote", { symbols: "AAPL" }],
    ["batch-quote", { symbols: "AAPL,MSFT,NVDA" }],
  ])(
    "refuses %s, which is not about one security, even for approved symbols",
    (path, query) => {
      const scope = resolvedScope(["AAPL", "MSFT", "NVDA"]);
      let refusal: unknown;
      try {
        scope.authorize(request(path, query));
      } catch (error) {
        refusal = error;
      }
      expect((refusal as FmpRequestRefusedError).reason).toBe(
        "NOT_A_SECURITY_ENDPOINT",
      );
    },
  );

  it("refuses an endpoint it does not know", () => {
    const scope = resolvedScope(["AAPL"]);
    for (const path of ["stock-list", "quote", "constructor", "__proto__"]) {
      let refusal: unknown;
      try {
        scope.authorize(request(path, { symbol: "AAPL" }));
      } catch (error) {
        refusal = error;
      }
      expect((refusal as FmpRequestRefusedError).reason, path).toBe(
        "UNKNOWN_ENDPOINT",
      );
    }
  });

  it.each([
    [{}],
    [{ symbol: "" }],
    [{ symbol: "AAPL,MSFT" }],
    [{ symbol: "AAPL", symbols: "MSFT,GOOGL" }],
    [{ symbol: "AAPL", exchange: "NASDAQ" }],
  ])("refuses a per-security request shaped as %j", (query) => {
    const scope = resolvedScope(["AAPL", "MSFT"]);
    let refusal: unknown;
    try {
      scope.authorize(request("historical-price-eod/full", query));
    } catch (error) {
      refusal = error;
    }
    expect((refusal as FmpRequestRefusedError).reason).toBe(
      "MALFORMED_REQUEST",
    );
  });

  it("refuses a benchmark, which is another symbol on a per-security endpoint", () => {
    const scope = resolvedScope(["AAPL", "MSFT", "NVDA"]);
    for (const symbol of ["SPY", "^GSPC"]) {
      expect(() =>
        scope.authorize(request("historical-price-eod/full", { symbol })),
      ).toThrowError(FmpRequestRefusedError);
    }
  });
});

describe("a guarded FMP client", () => {
  it("refuses an unapproved security before the key is read or anything is sent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const getConfig = vi.fn(config);
    const gate: FmpRequestGate = {
      run: vi.fn((work) => work()),
      publishCooldown: vi.fn(async () => {}),
    };
    const budget = new CountingBudget(100);
    const client = new FmpClient(getConfig, fetchMock, {
      gate,
      guard: guardOf(resolvedScope(["AAPL", "MSFT", "NVDA"]), budget),
    });

    await expect(
      client.getDailyPrices("GOOGL", "security-4", {
        from: "2020-01-01",
        to: "2020-12-31",
      }),
    ).rejects.toMatchObject({
      name: "FmpRequestRefusedError",
      reason: "SECURITY_NOT_APPROVED",
    });
    await expect(client.getProfile("googl")).rejects.toBeInstanceOf(
      FmpRequestRefusedError,
    );
    await expect(
      client.getInsiderTrades({ symbol: "GOOGL", page: 0, limit: 100 }),
    ).rejects.toBeInstanceOf(FmpRequestRefusedError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
    expect(await budget.used()).toBe(0);
  });

  it("refuses every operation that could widen the universe, before the network", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const budget = new CountingBudget(100);
    const client = new FmpClient(config, fetchMock, {
      guard: guardOf(resolvedScope(["AAPL", "MSFT", "NVDA"]), budget),
    });

    // The exchange-wide screener behind the catalog synchronization.
    await expect(client.getStockUniverse("NASDAQ")).rejects.toMatchObject({
      reason: "NOT_A_SECURITY_ENDPOINT",
    });
    // A caller-supplied symbol list — refused even when every symbol on it is approved.
    await expect(
      client.getCurrentQuotes(["AAPL", "MSFT", "NVDA"]),
    ).rejects.toMatchObject({ reason: "NOT_A_SECURITY_ENDPOINT" });
    await expect(
      client.getCurrentQuotes(["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"]),
    ).rejects.toMatchObject({ reason: "NOT_A_SECURITY_ENDPOINT" });
    // A venue's calendar.
    await expect(
      client.getExchangeHolidays("NYSE", "2025-12-31", "2026-12-31"),
    ).rejects.toMatchObject({ reason: "NOT_A_SECURITY_ENDPOINT" });
    // A benchmark series: a per-security endpoint, asked about a symbol nobody approved.
    await expect(
      client.getBenchmarkDailyPrices("SPY", "series-1", {
        from: "2020-01-01",
        to: "2020-12-31",
      }),
    ).rejects.toMatchObject({ reason: "SECURITY_NOT_APPROVED" });
    await expect(
      client.getBenchmarkDailyPrices("^GSPC", "series-2", {
        from: "2020-01-01",
        to: "2020-12-31",
      }),
    ).rejects.toBeInstanceOf(FmpRequestRefusedError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await budget.used()).toBe(0);
  });

  it("sends an approved request, with the guard never seeing the key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response([profile]));
    const seen: FmpRequestDescriptor[] = [];
    const scope = resolvedScope(["AAPL"]);
    const client = new FmpClient(config, fetchMock, {
      guard: {
        authorize: (descriptor) => {
          seen.push(descriptor);
          scope.authorize(descriptor);
        },
        admitAttempt: async (descriptor) => {
          seen.push(descriptor);
        },
      },
    });

    await expect(client.getProfile("aapl")).resolves.toMatchObject({
      providerSymbol: "AAPL",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { path: "profile", query: { symbol: "AAPL" } },
      { path: "profile", query: { symbol: "AAPL" } },
    ]);
    expect(JSON.stringify(seen)).not.toContain("test-secret-key");
    // The descriptor is a frozen copy: a guard cannot rewrite the request it was asked about.
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.query)).toBe(true);
  });

  it("spends the budget inside the gate's slot, immediately before sending", async () => {
    const order: string[] = [];
    const gate: FmpRequestGate = {
      run: async (work) => {
        order.push("gate:enter");
        try {
          return await work();
        } finally {
          order.push("gate:leave");
        }
      },
      publishCooldown: async () => {},
    };
    const fetchMock = vi.fn<typeof fetch>(async () => {
      order.push("fetch");
      return response([profile]);
    });
    const client = new FmpClient(config, fetchMock, {
      gate,
      guard: {
        authorize: () => {
          order.push("authorize");
        },
        admitAttempt: async () => {
          order.push("budget");
        },
      },
    });

    await client.getProfile("AAPL");
    expect(order).toEqual([
      "authorize",
      "gate:enter",
      "budget",
      "fetch",
      "gate:leave",
    ]);
  });

  it("stops at the budget: the request after the last unit is never sent", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response([profile]));
    const budget = new CountingBudget(2);
    const client = new FmpClient(config, fetchMock, {
      guard: guardOf(resolvedScope(["AAPL"]), budget),
    });

    await client.getProfile("AAPL");
    await client.getProfile("AAPL");
    await expect(client.getProfile("AAPL")).rejects.toMatchObject({
      name: "FmpRequestBudgetExhaustedError",
      reason: "BUDGET_EXHAUSTED",
      limit: 2,
    });
    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRequestBudgetExhaustedError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await budget.used()).toBe(2);
  });

  it("does not retry a refusal", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response([profile]));
    const admitAttempt = vi.fn(async () => {
      throw new FmpRequestBudgetExhaustedError(1);
    });
    const client = new FmpClient(config, fetchMock, {
      guard: { authorize: () => {}, admitAttempt },
      sleep: async () => {},
    });

    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRequestBudgetExhaustedError,
    );
    // Asked once: a refusal is not a transient failure, and retrying it would only ask again.
    expect(admitAttempt).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("charges a retry as a request and authorizes it once", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response([profile]));
    const authorize = vi.fn();
    const budget = new CountingBudget(10);
    const scope = resolvedScope(["AAPL"]);
    const client = new FmpClient(config, fetchMock, {
      guard: {
        authorize: (descriptor) => {
          authorize(descriptor);
          scope.authorize(descriptor);
        },
        admitAttempt: async () => {
          await budget.consume();
        },
      },
      sleep: async () => {},
      random: () => 0,
    });

    await client.getProfile("AAPL");
    // Three requests reached the network, so three units — and exactly that, every time.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await budget.used()).toBe(3);
    // One logical request: the retries did not ask for authorization again, and the scope still
    // holds one security.
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(scope.securities).toHaveLength(1);
  });

  it("ends a retry loop when the budget runs out mid-request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({}, 503));
    const budget = new CountingBudget(2);
    const client = new FmpClient(config, fetchMock, {
      guard: guardOf(resolvedScope(["AAPL"]), budget),
      sleep: async () => {},
      random: () => 0,
    });

    // Without a budget this request would be sent four times (one attempt and three retries).
    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRequestBudgetExhaustedError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await budget.used()).toBe(2);
  });

  it("cannot overshoot the budget under concurrency", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return response([profile]);
    });
    const budget = new CountingBudget(7);
    const client = new FmpClient(config, fetchMock, {
      guard: guardOf(resolvedScope(["AAPL", "MSFT", "NVDA"]), budget),
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) =>
        client.getProfile(["AAPL", "MSFT", "NVDA"][index % 3] as string),
      ),
    );
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(await budget.used()).toBe(7);
  });

  it("is a provider error, so a loader's handling of an unanswered request applies", () => {
    const refusal = new FmpRequestRefusedError("SECURITY_NOT_APPROVED", "no");
    expect(refusal).toBeInstanceOf(FmpProviderError);
    expect(refusal.retryable).toBe(false);
    expect(new FmpRequestBudgetExhaustedError(5).retryable).toBe(false);
  });
});

describe("an unguarded FMP client", () => {
  it("sends exactly what it sent before the guard existed", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response([]));
    const client = new FmpClient(config, fetchMock);

    await client.getStockUniverse("nasdaq");
    await client.getCurrentQuotes(["msft", "AAPL"]);
    await client.getExchangeHolidays("nyse", "2025-12-31", "2026-12-31");
    await client.getProfile("googl");
    await client.getBenchmarkDailyPrices("^GSPC", "series", {
      from: "2020-01-01",
      to: "2020-12-31",
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://financialmodelingprep.com/stable/company-screener?exchange=NASDAQ&isEtf=false&isFund=false&limit=20000&apikey=test-secret-key",
      "https://financialmodelingprep.com/stable/batch-quote?symbols=AAPL%2CMSFT&apikey=test-secret-key",
      "https://financialmodelingprep.com/stable/holidays-by-exchange?exchange=NYSE&from=2025-12-31&to=2026-12-31&apikey=test-secret-key",
      "https://financialmodelingprep.com/stable/profile?symbol=GOOGL&apikey=test-secret-key",
      "https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=%5EGSPC&from=2020-01-01&to=2020-12-31&apikey=test-secret-key",
    ]);
  });

  it("sends the same URL with a guard that allows the request", async () => {
    const unguarded = vi.fn<typeof fetch>(async () => response([profile]));
    const guarded = vi.fn<typeof fetch>(async () => response([profile]));
    await new FmpClient(config, unguarded).getProfile("AAPL");
    await new FmpClient(config, guarded, {
      guard: guardOf(resolvedScope(["AAPL"]), new CountingBudget(5)),
    }).getProfile("AAPL");

    expect(String(guarded.mock.calls[0]?.[0])).toBe(
      String(unguarded.mock.calls[0]?.[0]),
    );
    expect(guarded.mock.calls[0]?.[1]?.headers).toEqual(
      unguarded.mock.calls[0]?.[1]?.headers,
    );
  });
});
