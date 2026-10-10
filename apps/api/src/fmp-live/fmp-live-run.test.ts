import { VALUATION_RATIO_IDS } from "@intrinsic/contracts";
import type { Security } from "@intrinsic/domain";
import {
  FmpRequestBudgetExhaustedError,
  FmpSecurityScope,
  FmpUnauthorizedError,
  type FmpRequestBudget,
} from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import { StockDataNotFoundError } from "@intrinsic/stock-data";
import { describe, expect, it, vi } from "vitest";
import { parseLiveFmpArguments } from "./fmp-live-arguments";
import { LiveFmpRunGuard } from "./fmp-live-guard";
import type { LiveFmpLoaders } from "./fmp-live-hydration";
import { LIVE_FMP_EXIT_CODES, formatLiveFmpReport } from "./fmp-live-report";
import {
  executeLiveFmpRun,
  liveFmpHistoryRange,
  type LiveFmpRunDependencies,
} from "./fmp-live-run";

/**
 * One run, end to end, with the loaders replaced by recorders: the order things happen in, what
 * stops a run, and — the part that matters most — that a run is never reported as complete when
 * the provider was refused anything, whatever the loaders themselves made of the refusal.
 */

function security(symbol: string): Security {
  return {
    id: `security-${symbol}`,
    symbol,
    name: `${symbol} Inc.`,
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  };
}

class MemoryBudget implements FmpRequestBudget {
  taken = 0;

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

const logger = createLogger({
  service: "api",
  level: "silent",
  environment: "test",
});

type Harness = {
  dependencies: LiveFmpRunDependencies;
  guard: LiveFmpRunGuard;
  calls: string[];
  admit: ReturnType<typeof vi.fn>;
};

function harness(options: {
  symbols: string[];
  catalogued?: string[];
  budget?: number;
  loaders?: Partial<{
    core: (symbol: string, guard: LiveFmpRunGuard) => Promise<void>;
    ratio: (symbol: string, guard: LiveFmpRunGuard) => Promise<void>;
    alternative: (symbol: string, guard: LiveFmpRunGuard) => Promise<void>;
  }>;
}): Harness {
  const scope = new FmpSecurityScope(options.symbols, { maxSecurities: 3 });
  const budget = new MemoryBudget(options.budget ?? 200);
  const guard = new LiveFmpRunGuard(scope, budget);
  const calls: string[] = [];
  const rows = new Map(
    (options.catalogued ?? options.symbols).map((symbol) => [
      symbol,
      security(symbol),
    ]),
  );
  const admit = vi.fn(async (symbols: readonly string[]) =>
    symbols.map((symbol) => {
      if (symbol.startsWith("NOPE")) {
        return { symbol, outcome: "UNKNOWN_TO_PROVIDER" as const };
      }
      rows.set(symbol, security(symbol));
      return { symbol, outcome: "LISTED" as const };
    }),
  );
  const loaders: LiveFmpLoaders = {
    stockData: {
      getDailyDerivedState: async (symbol) => {
        calls.push(`core:${symbol}`);
        await options.loaders?.core?.(symbol, guard);
        return [];
      },
      getDailyValuationRatio: async (symbol, ratio) => {
        calls.push(`ratio:${symbol}:${ratio}`);
        await options.loaders?.ratio?.(symbol, guard);
        return [
          { date: "2024-01-02" },
          { date: "2024-01-03", value: 21.5 },
          { date: "2024-01-04", value: 22 },
        ];
      },
    },
    alternativeData: {
      ensureIngested: async (target, domains) => {
        calls.push(`alternative:${target.symbol}:${domains.join("+")}`);
        await options.loaders?.alternative?.(target.symbol, guard);
      },
    },
  };
  return {
    guard,
    calls,
    admit,
    dependencies: {
      readStoredCoverage: async () => [
        {
          dataset: "DAILY_PRICE",
          rows: 7540,
          earliest: "1996-10-10",
          latest: "2026-10-09",
          lastSyncedAt: "2026-10-10T09:00:00.000Z",
        },
      ],
      scope,
      budget,
      guard,
      loaders,
      getSecurity: async (symbol) => {
        const row = rows.get(symbol);
        if (!row) {
          throw new StockDataNotFoundError(symbol);
        }
        return row;
      },
      admit,
      productHistoryYears: 30,
      alternativeDataMaxPages: 12,
      maxRetries: 3,
      logger,
      now: () => Date.UTC(2026, 9, 10, 9, 0, 0),
    },
  };
}

function run(harnessed: Harness, ...argv: string[]) {
  return executeLiveFmpRun({
    arguments: parseLiveFmpArguments(argv),
    runId: "6f2c1d3e-0000-4000-8000-000000000001",
    databaseName: "intrinsic_value",
    databaseHost: "localhost",
    dependencies: harnessed.dependencies,
  });
}

/** A request through the guard, as a loader's provider call would make it. */
async function ask(guard: LiveFmpRunGuard, path: string, symbol: string) {
  const request = { path, query: { symbol } };
  guard.authorize(request);
  await guard.admitAttempt(request);
}

describe("a live FMP run", () => {
  it("asks for the whole product horizon", () => {
    expect(liveFmpHistoryRange(30, "2026-10-10")).toEqual({
      from: "1996-10-10",
      to: "2026-10-10",
    });
    // The loaders' own year arithmetic, 29 February included.
    expect(liveFmpHistoryRange(30, "2024-02-29").from).toBe("1994-02-28");
  });

  it("hydrates each security through the three canonical steps, in order", async () => {
    const h = harness({
      symbols: ["AAPL", "MSFT"],
      loaders: {
        core: (symbol, guard) =>
          ask(guard, "historical-price-eod/full", symbol),
        alternative: (symbol, guard) =>
          ask(guard, "insider-trading/search", symbol),
      },
    });
    const report = await run(h, "--symbols", "AAPL,MSFT", "--full-history");

    const ratios = (symbol: string) =>
      VALUATION_RATIO_IDS.map((ratio) => `ratio:${symbol}:${ratio}`);
    expect(h.calls).toEqual([
      "core:AAPL",
      ...ratios("AAPL"),
      "alternative:AAPL:INSIDER+CONGRESS",
      "core:MSFT",
      ...ratios("MSFT"),
      "alternative:MSFT:INSIDER+CONGRESS",
    ]);
    expect(h.admit).not.toHaveBeenCalled();
    expect(report.outcome).toBe("SUCCEEDED");
    expect(report.resolved.map((entry) => entry.security.id)).toEqual([
      "security-AAPL",
      "security-MSFT",
    ]);
    expect(report.ledger).toMatchObject({
      sent: 4,
      authorized: 4,
      budget: 200,
    });
    expect(report.budgetUsed).toBe(4);
    expect(report.securities[0]?.ratios[0]).toEqual({
      ratio: VALUATION_RATIO_IDS[0],
      sessions: 3,
      sessionsWithValue: 2,
      earliest: "2024-01-03",
      latest: "2024-01-04",
    });
  });

  it("admits a symbol the catalog lacks before hydrating anything", async () => {
    const h = harness({ symbols: ["AAPL", "MSFT"], catalogued: ["AAPL"] });
    const report = await run(h, "--symbols", "AAPL,MSFT", "--full-history");

    expect(h.admit).toHaveBeenCalledWith(["MSFT"]);
    expect(
      report.resolved.map((entry) => [entry.symbol, entry.origin]),
    ).toEqual([
      ["AAPL", "CATALOG"],
      ["MSFT", "ADMITTED"],
    ]);
    expect(report.outcome).toBe("SUCCEEDED");
  });

  it("hydrates nothing when a symbol names no supported security", async () => {
    const h = harness({ symbols: ["AAPL", "NOPE1"], catalogued: ["AAPL"] });
    const report = await run(h, "--symbols", "AAPL,NOPE1", "--full-history");

    expect(h.calls).toEqual([]);
    expect(report.outcome).toBe("FAILED");
    expect(report.unresolved).toEqual([
      {
        symbol: "NOPE1",
        reason: "the provider has no security under this symbol",
      },
    ]);
    expect(LIVE_FMP_EXIT_CODES[report.outcome]).toBe(1);
  });

  it("is a failure when a step fails, and still runs the independent ones", async () => {
    const h = harness({
      symbols: ["AAPL"],
      loaders: {
        core: async () => {
          throw new Error("Stock data provider is temporarily unavailable");
        },
      },
    });
    const report = await run(h, "--symbols", "AAPL", "--full-history");

    expect(report.outcome).toBe("FAILED");
    expect(
      report.securities[0]?.steps.map((step) => [step.step, step.status]),
    ).toEqual([
      ["CORE_HISTORY", "FAILED"],
      // A ratio is read from the prices and statements that did not arrive.
      ["VALUATION_INPUTS", "NOT_RUN"],
      // An ingest reads its own endpoints into its own tables.
      ["ALTERNATIVE_DATA", "COMPLETED"],
    ]);
    expect(h.calls).toEqual(["core:AAPL", "alternative:AAPL:INSIDER+CONGRESS"]);
  });

  it("stops at budget exhaustion and never calls the result a success", async () => {
    // The loader here does what a real one may: it treats a provider error as something to
    // degrade around and returns normally. The run must not take its word for it.
    const h = harness({
      symbols: ["AAPL", "MSFT"],
      budget: 2,
      loaders: {
        core: async (symbol, guard) => {
          for (let request = 0; request < 3; request += 1) {
            try {
              await ask(guard, "income-statement", symbol);
            } catch {
              return;
            }
          }
        },
      },
    });
    const report = await run(
      h,
      "--symbols",
      "AAPL,MSFT",
      "--full-history",
      "--budget",
      "2",
    );

    expect(report.outcome).toBe("BUDGET_EXHAUSTED");
    expect(LIVE_FMP_EXIT_CODES[report.outcome]).toBe(3);
    expect(report.ledger).toMatchObject({
      sent: 2,
      budget: 2,
      budgetExhausted: true,
    });
    expect(report.budgetUsed).toBe(2);
    // Nothing was started after the budget ran out: not the rest of AAPL, not MSFT.
    expect(h.calls).toEqual(["core:AAPL"]);
    expect(
      report.securities.flatMap((entry) =>
        entry.steps.map((step) => step.status),
      ),
    ).toEqual([
      "COMPLETED",
      "NOT_RUN",
      "NOT_RUN",
      "NOT_RUN",
      "NOT_RUN",
      "NOT_RUN",
    ]);

    const text = formatLiveFmpReport(report);
    expect(text).toMatch(
      /^Live FMP hydration: FAILED — the request budget of 2 was exhausted/,
    );
    expect(text).toContain("What is stored is INCOMPLETE");
    expect(text).toContain("BUDGET_EXHAUSTED: income-statement for AAPL × 1");
  });

  it("is a failure when anything outside the scope was asked for, even if every step returned", async () => {
    const h = harness({
      symbols: ["AAPL"],
      loaders: {
        alternative: async (_symbol, guard) => {
          try {
            await ask(guard, "insider-trading/search", "GOOGL");
          } catch {
            // Swallowed, as a loader that tolerates a missing dataset would.
          }
        },
      },
    });
    const report = await run(h, "--symbols", "AAPL", "--full-history");

    expect(
      report.securities[0]?.steps.every((step) => step.status === "COMPLETED"),
    ).toBe(true);
    expect(report.outcome).toBe("FAILED");
    expect(report.ledger.refusals).toEqual([
      {
        reason: "SECURITY_NOT_APPROVED",
        endpoint: "insider-trading/search",
        symbol: "GOOGL",
        count: 1,
      },
    ]);
    expect(report.ledger.sent).toBe(0);
  });

  it("reports a run whose budget ran out while it was still resolving identities", async () => {
    const h = harness({ symbols: ["AAPL", "MSFT"], catalogued: [], budget: 1 });
    h.admit.mockImplementation(async (symbols: readonly string[]) => {
      for (const symbol of symbols) {
        await ask(h.guard, "profile", symbol);
      }
      return [];
    });
    const report = await run(
      h,
      "--symbols",
      "AAPL,MSFT",
      "--full-history",
      "--budget",
      "1",
    );

    expect(report.outcome).toBe("BUDGET_EXHAUSTED");
    expect(report.ledger).toMatchObject({ sent: 1, budgetExhausted: true });
    expect(report.resolved).toEqual([]);
    expect(report.unresolved.map((entry) => entry.symbol)).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(h.calls).toEqual([]);
    expect(formatLiveFmpReport(report)).toContain(
      "BUDGET_EXHAUSTED: profile for MSFT × 1",
    );
  });

  it("reports a rejected key as a failed run, not as a crash", async () => {
    const h = harness({ symbols: ["AAPL"], catalogued: [] });
    h.admit.mockRejectedValue(new FmpUnauthorizedError(401));
    const report = await run(h, "--symbols", "AAPL", "--full-history");

    expect(report.outcome).toBe("FAILED");
    expect(report.unresolved).toEqual([
      {
        symbol: "AAPL",
        reason:
          "resolution stopped before it was complete (FmpUnauthorizedError: Stock data provider authentication failed)",
      },
    ]);
    expect(h.calls).toEqual([]);
  });

  it("still fails loudly on anything that is not the provider", async () => {
    const h = harness({ symbols: ["AAPL"], catalogued: [] });
    h.admit.mockRejectedValue(new Error("connection refused"));
    await expect(
      run(h, "--symbols", "AAPL", "--full-history"),
    ).rejects.toThrowError("connection refused");
  });

  it("plans without admitting, hydrating or spending anything", async () => {
    const h = harness({ symbols: ["AAPL", "MSFT"], catalogued: ["AAPL"] });
    const report = await run(
      h,
      "--symbols",
      "AAPL,MSFT",
      "--full-history",
      "--plan",
    );

    expect(h.admit).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(report.outcome).toBe("PLANNED");
    expect(report.ledger.sent).toBe(0);
    expect(report.budgetUsed).toBe(0);
    const text = formatLiveFmpReport(report);
    expect(text).toContain("PLAN ONLY — nothing was asked of the provider");
    expect(text).toContain(
      "MSFT  not in the security catalog — a run would ask the provider",
    );
    expect(text).toContain("Cold ceiling for 2 securities: 94 without a retry");
  });
});

describe("the live FMP report", () => {
  it("says what was approved, asked, reused, stored and left out", async () => {
    const h = harness({
      symbols: ["AAPL"],
      loaders: {
        core: async (symbol, guard) => {
          await ask(guard, "profile", symbol);
          await ask(guard, "historical-price-eod/full", symbol);
          await ask(guard, "historical-price-eod/full", symbol);
        },
      },
    });
    const text = formatLiveFmpReport(
      await run(h, "--symbols", "aapl", "--full-history"),
    );

    expect(text).toContain("Live FMP hydration: SUCCEEDED");
    expect(text).toContain("database intrinsic_value on localhost");
    expect(text).toContain("Approved securities: 1 of at most 3 (AAPL)");
    expect(text).toContain(
      "security security-AAPL · resolved from the security catalog",
    );
    expect(text).toContain(
      "Provider requests: 3 sent of a budget of 200 (3 distinct, 0 retried; budget counter 3).",
    );
    expect(text).toMatch(/DAILY_PRICE\s+2 {2}\(historical-price-eod\/full 2\)/);
    // A dataset nothing was asked for is shown as reused rather than left out.
    expect(text).toMatch(
      /INSIDER_TRANSACTIONS\s+0 {2}\(nothing asked: stored data was fresh/,
    );
    expect(text).toContain("Refused requests: none.");
    expect(text).toMatch(
      /DAILY_PRICE\s+7,540 row\(s\) {2}1996-10-10 → 2026-10-09/,
    );
    expect(text).toMatch(
      /ratio PRICE_TO_EARNINGS_TTM \(computed on read\)\s+2 of 3 session\(s\)/,
    );
    expect(text).toContain("Never hydrated by this command:");
    expect(text).toContain("Benchmark series");
  });
});
