import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type { Security, SecurityId } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  EodFinalityPolicy,
  WEEKDAY_TRADING_CALENDAR,
  type FinalizedSession,
  type StockRefreshState,
  type StockTailRefreshResult,
} from "@intrinsic/stock-data";
import type { OperandKey } from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import type { ActiveMonitor } from "../monitor/monitor-repository.js";
import {
  StockEodRefreshFailedError,
  StockEodRefreshRun,
  type StockEodService,
} from "./refresh-run.js";

const logger = createLogger({ service: "worker", level: "silent" });

/** Wednesday 2026-10-14, 16:35 in New York: the session is final. */
const NOW = new Date("2026-10-14T20:35:00.000Z");
const SESSION = "2026-10-14";
const HISTORY_START = "1996-10-14";

function definition(seriesId: string, operator = "IS_ABOVE"): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c-1",
              metric: { kind: "PRICE" },
              operator,
              value: { kind: "SERIES", seriesId },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  } as StrategyDefinition;
}

function activeMonitor(
  monitorId: string,
  symbols: string[],
  strategy: StrategyDefinition = definition("SMA_200D"),
): ActiveMonitor {
  return {
    monitorId,
    name: monitorId,
    ownership: "SYSTEM",
    actorUserId: null,
    strategyId: `s-${monitorId}`,
    configVersion: 0,
    strategyVersionId: `v-${monitorId}`,
    definition: strategy,
    members: symbols.map((symbol) => ({
      securityId: `id-${symbol}`,
      symbol,
      buyWindowMode: "FULL" as const,
      buyWindows: [],
    })),
  };
}

function security(symbol: string): Security {
  return {
    id: `id-${symbol}` as SecurityId,
    symbol,
    name: symbol,
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  } as Security;
}

const READY: StockRefreshState = {
  coverageStart: "1992-10-14",
  latestBar: SESSION,
  latestVerifiedBar: SESSION,
  verifiedThrough: SESSION,
  lastTailSyncAt: "2026-10-14T20:31:00.000Z",
  tailDate: SESSION,
  priceBasisGeneration: 0,
};

const STALE: StockRefreshState = {
  ...READY,
  latestBar: "2026-10-13",
  latestVerifiedBar: "2026-10-13",
  verifiedThrough: "2026-10-13",
  lastTailSyncAt: "2026-10-13T20:40:00.000Z",
  tailDate: "2026-10-13",
};

/** A loader double: per-symbol state and outcome, and a record of every call. */
class FakeStockData implements StockEodService {
  states = new Map<string, StockRefreshState>();
  results = new Map<string, StockTailRefreshResult["status"]>();
  failing = new Set<string>();
  readonly refreshed: {
    symbol: string;
    fundamentals?: string;
    operands?: readonly OperandKey[];
    from: string;
  }[] = [];
  readonly operandPreparations: string[] = [];
  delayMs = 0;
  requests = 0;

  async findSecuritiesByIds(ids: readonly SecurityId[]): Promise<Security[]> {
    return ids.map((id) => security(id.replace(/^id-/, "")));
  }

  evaluationHistoryStart(): string {
    return HISTORY_START;
  }

  async stockRefreshState(target: Security): Promise<StockRefreshState> {
    if (this.failing.has(target.symbol)) {
      throw new Error(`database unavailable for ${target.symbol}`);
    }
    return this.states.get(target.symbol) ?? { priceBasisGeneration: 0 };
  }

  async refreshStockTail(
    target: Security,
    input: Parameters<StockEodService["refreshStockTail"]>[1],
  ): Promise<StockTailRefreshResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.requests += 2;
    this.refreshed.push({
      symbol: target.symbol,
      from: input.from,
      ...(input.fundamentals ? { fundamentals: input.fundamentals } : {}),
      ...(input.operands ? { operands: input.operands } : {}),
    });
    const status = this.results.get(target.symbol) ?? "READY";
    return {
      status,
      state: status === "READY" ? READY : STALE,
    };
  }

  async prepareStockOperands(target: Security): Promise<void> {
    this.operandPreparations.push(target.symbol);
  }
}

function run(
  stockData: FakeStockData,
  monitors: ActiveMonitor[],
  overrides: { runBudgetMs?: number; now?: () => Date } = {},
) {
  const now = overrides.now ?? (() => NOW);
  return new StockEodRefreshRun(
    stockData,
    { listActiveMonitors: async () => monitors },
    logger,
    {
      policy: new EodFinalityPolicy({ calendar: WEEKDAY_TRADING_CALENDAR, now }),
      runBudgetMs: overrides.runBudgetMs ?? 60_000,
      securityConcurrency: 2,
      followUpMs: 30_000,
      providerRequests: () => stockData.requests,
      now,
    },
  );
}

describe("one stock EOD run", () => {
  it("asks PostgreSQL first and enters the loader only for a security that needs the session", async () => {
    const stockData = new FakeStockData();
    stockData.states.set("AAPL", READY);
    stockData.states.set("MSFT", STALE);
    const summary = await run(stockData, [
      activeMonitor("a", ["AAPL", "MSFT"]),
    ]).run(1, () => false);

    expect(summary.expectedSession).toBe(SESSION);
    expect(stockData.refreshed.map((call) => call.symbol)).toEqual(["MSFT"]);
    expect(stockData.refreshed[0]!.from).toBe(HISTORY_START);
    expect(summary.outcomes.map((o) => [o.symbol, o.outcome, o.prepared])).toEqual([
      ["AAPL", "READY", false],
      ["MSFT", "READY", true],
    ]);
    expect(summary.providerReads).toBe(2);
    // Only price and technical operands here: nothing beyond prices to ingest for the skipped one,
    // but the operand inputs are still kept fresh — the cheap check runs.
    expect(stockData.operandPreparations).toEqual(["AAPL"]);
  });

  it("prepares a security watched by many Monitors once, with statements only when one reads them", async () => {
    const stockData = new FakeStockData();
    await run(stockData, [
      activeMonitor("a", ["AAPL", "KO"]),
      activeMonitor("b", ["AAPL"], definition("DCF_FCFF", "IS_BELOW")),
      activeMonitor("c", ["AAPL"]),
    ]).run(1, () => false);

    expect(stockData.refreshed.map((call) => call.symbol)).toEqual(["AAPL", "KO"]);
    expect(stockData.refreshed[0]!.fundamentals).toBe("if-stale");
    expect(stockData.refreshed[1]!.fundamentals).toBe("skip");
    expect(stockData.refreshed[0]!.operands).toContain("series:DCF_FCFF");
  });

  it("loads the full history of a security PostgreSQL holds only part of, even when its tail is current", async () => {
    const stockData = new FakeStockData();
    stockData.states.set("NVDA", { ...READY, coverageStart: "2024-01-02" });
    await run(stockData, [activeMonitor("a", ["NVDA"])]).run(1, () => false);
    expect(stockData.refreshed.map((call) => call.symbol)).toEqual(["NVDA"]);
  });

  it("does not ask again inside the retry spacing for an unpublished session, and stops past the give-up bound", async () => {
    const stockData = new FakeStockData();
    const missing: StockRefreshState = {
      ...READY,
      latestBar: "2026-10-13",
      latestVerifiedBar: "2026-10-13",
      lastTailSyncAt: "2026-10-14T20:32:00.000Z",
    };
    stockData.states.set("HALT", missing);
    const waiting = await run(stockData, [activeMonitor("a", ["HALT"])]).run(
      1,
      () => false,
    );
    expect(waiting.outcomes[0]!.outcome).toBe("AWAITING_PUBLICATION");
    expect(stockData.refreshed).toEqual([]);

    const later = await run(stockData, [activeMonitor("a", ["HALT"])], {
      now: () => new Date("2026-10-15T20:31:00.000Z"),
    }).run(2, () => false);
    // A day on, the next session is final, so HALT is asked for that one — not for the old one.
    expect(later.expectedSession).toBe("2026-10-15");
    expect(stockData.refreshed.map((call) => call.symbol)).toEqual(["HALT"]);
  });

  it("defers what its budget cannot reach and asks to be resumed promptly", async () => {
    const stockData = new FakeStockData();
    stockData.delayMs = 30;
    const work = run(
      stockData,
      [activeMonitor("a", ["A1", "A2", "A3", "A4", "A5", "A6"])],
      { runBudgetMs: 40 },
    );
    const summary = await work.run(1, () => false);
    expect(summary.deferred).toBeGreaterThan(0);
    expect(summary.outcomes.some((o) => o.outcome === "DEFERRED")).toBe(true);
    expect(work.followUpMs(summary)).toBe(30_000);

    const done = await run(stockData, [activeMonitor("a", ["B1"])]).run(
      2,
      () => false,
    );
    expect(run(stockData, []).followUpMs(done)).toBeUndefined();
  });

  it("stops at a security boundary when the lease is lost", async () => {
    const stockData = new FakeStockData();
    const summary = await run(stockData, [
      activeMonitor("a", ["A1", "A2", "A3"]),
    ]).run(1, () => true);
    expect(summary.outcomes.every((o) => o.outcome === "DEFERRED")).toBe(true);
    expect(stockData.refreshed).toEqual([]);
  });

  it("isolates a failing security, backs it off, and keeps the rest of the run", async () => {
    const stockData = new FakeStockData();
    stockData.failing.add("BAD");
    const work = run(stockData, [activeMonitor("a", ["BAD", "GOOD"])]);
    const first = await work.run(1, () => false);
    expect(first.outcomes.find((o) => o.symbol === "BAD")!.outcome).toBe("FAILED");
    expect(first.outcomes.find((o) => o.symbol === "GOOD")!.outcome).toBe("READY");
    expect(first.failed).toBe(1);

    const second = await work.run(2, () => false);
    expect(second.outcomes.find((o) => o.symbol === "BAD")!.outcome).toBe(
      "BACKING_OFF",
    );
  });

  it("fails the run when every security it attempted failed: the cause is shared", async () => {
    const stockData = new FakeStockData();
    stockData.failing.add("A");
    stockData.failing.add("B");
    await expect(
      run(stockData, [activeMonitor("a", ["A", "B"])]).run(1, () => false),
    ).rejects.toBeInstanceOf(StockEodRefreshFailedError);
  });

  it("reports the loader's status for a session the provider has not published", async () => {
    const stockData = new FakeStockData();
    stockData.results.set("LATE", "AWAITING_PUBLICATION");
    const summary = await run(stockData, [activeMonitor("a", ["LATE"])]).run(
      1,
      () => false,
    );
    expect(summary.outcomes[0]).toMatchObject({
      outcome: "AWAITING_PUBLICATION",
      prepared: true,
      latestVerifiedBar: "2026-10-13",
    });
  });

  it("holds every security of a run to the one session it resolved", async () => {
    const expected: FinalizedSession[] = [];
    const stockData = new FakeStockData();
    const original = stockData.refreshStockTail.bind(stockData);
    stockData.refreshStockTail = async (target, input) => {
      expected.push(input.expectedSession);
      return original(target, input);
    };
    await run(stockData, [activeMonitor("a", ["A", "B", "C"])]).run(1, () => false);
    expect(new Set(expected.map((e) => e.session))).toEqual(new Set([SESSION]));
  });
});
