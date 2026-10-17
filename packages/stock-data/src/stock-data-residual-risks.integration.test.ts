import { randomUUID } from "node:crypto";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, DateRange, Security } from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { PRICE_OPERAND, seriesOperand } from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { RedisStockDataCache } from "./cache.js";
import { RedlockLoadCoordinator } from "./coordination.js";
import { weekdays } from "./fundamental-metrics.test-helper.js";
import { PrismaStockDataStore } from "./prisma-store.js";
import {
  createStockDataRedisClient,
  IoredisCacheClient,
} from "./redis-client.js";
import { deleteRedisNamespace } from "./redis-namespace.test-helper.js";
import {
  CanonicalStockDataService,
  type ProviderRequestEvent,
} from "./service.js";

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The stock-data residual-risk suite requires TEST_REDIS_URL or REDIS_URL; CI must not skip it.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

/**
 * The residual concurrency risks the stock-data concurrency report left open (§5, §6; the owner's
 * 2026-10-17 list), each forced deterministically on real PostgreSQL, Redis and Redlock:
 *
 * - a backtest whose cache entry is evicted mid-run, after a new session became final and the
 *   provider revised a bar inside the run's period (R5);
 * - a backtest reading its windows while the stock EOD refresh applies that revision;
 * - a writer that lost its lease without noticing, committing after another process replaced the
 *   history (the PostgreSQL stale-writer window);
 * - a connection pool too small for the hydrations sharing it.
 *
 * Each case states what the product guarantees and checks it against PostgreSQL and the synthetic
 * market; where the answer is "the product does not prevent this", the case records the behaviour
 * so a change to it is noticed.
 */

const NOW = new Date("2026-08-24T23:00:00.000Z");
const SESSION = "2026-08-24";
const NEXT_NOW = new Date("2026-08-25T23:00:00.000Z");
const NEXT_SESSION = "2026-08-25";
const LISTED = "2004-01-02";
const OPERANDS = [
  PRICE_OPERAND,
  seriesOperand("SMA_50D"),
  seriesOperand("EMA_20D"),
];

type PriceRequest = { symbol: string; from: string; to: string };

/** One deterministic history for every symbol, which the test can revise or re-base. */
class SyntheticMarket implements FmpStockProviderPort {
  readonly priceRequests: PriceRequest[] = [];
  readonly events: ProviderRequestEvent[] = [];
  publishedThrough = SESSION;
  /** Bars the provider has revised since they were first published. */
  readonly revisions = new Map<string, Partial<DailyPrice>>();
  /** When set, every bar before the date is divided by the ratio: a split re-base. */
  rebase?: { exDate: string; ratio: number };
  /** Awaited before every price answer, when set. */
  beforePrices?: (request: PriceRequest) => Promise<void>;

  async getProfile() {
    return null;
  }

  async getDailyPrices(symbol: string, securityId: string, range: DateRange) {
    const request = { symbol, from: range.from!, to: range.to! };
    this.priceRequests.push(request);
    await this.beforePrices?.(request);
    return this.history(securityId).filter(
      (row) => row.date >= range.from! && row.date <= range.to!,
    );
  }

  async getFinancialStatements() {
    return [];
  }

  history(securityId: string): DailyPrice[] {
    return weekdays(LISTED, this.publishedThrough).map((date, index) => {
      const close =
        Math.round((50 + 10 * Math.sin(index / 40) + index * 0.01) * 100) / 100;
      const base: DailyPrice = {
        securityId,
        date,
        open: close,
        high: Math.round((close + 0.5) * 100) / 100,
        low: Math.round((close - 0.5) * 100) / 100,
        close,
        volume: 1_000 + (index % 17) * 10,
      };
      const revised = { ...base, ...this.revisions.get(date) };
      if (this.rebase && date < this.rebase.exDate) {
        const r = this.rebase.ratio;
        return {
          ...revised,
          open: revised.open / r,
          high: revised.high / r,
          low: revised.low / r,
          close: revised.close / r,
          volume: revised.volume * r,
        };
      }
      return revised;
    });
  }
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describeRedis("stock-data residual concurrency risks", () => {
  const redisRoot = redisUrl ?? "redis://localhost:6379";
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const admin = createStockDataRedisClient(redisRoot);
  const securityIds: string[] = [];
  const namespaces: string[] = [];
  const tag = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  let symbolIndex = 0;

  // Full histories and every namespace: the default 10 s hook timeout is too tight under load.
  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    for (const namespace of namespaces) {
      await deleteRedisNamespace(admin, namespace);
    }
    admin.disconnect();
    await prisma.$disconnect();
  }, 60_000);

  async function createSecurity(): Promise<Security> {
    symbolIndex += 1;
    const symbol = `RR${symbolIndex}${tag}`;
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `Residual ${symbolIndex}`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityIds.push(row.id);
    return {
      id: row.id,
      symbol,
      name: row.name,
      exchangeCode: "NASDAQ",
      currency: "USD",
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
    };
  }

  function startProcess(input: {
    namespace: string;
    market: SyntheticMarket;
    clock: { now: Date };
    prismaUrl?: string;
  }) {
    const processPrisma = input.prismaUrl
      ? new PrismaClient({ datasources: { db: { url: input.prismaUrl } } })
      : new PrismaClient();
    const redis = createStockDataRedisClient(redisRoot);
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      50,
      input.namespace,
    );
    const service = new CanonicalStockDataService(
      new PrismaStockDataStore(processPrisma),
      input.market,
      cache,
      new RedlockLoadCoordinator(redis, {
        lockDurationMs: 10_000,
        lockWaitMs: 60_000,
      }),
      {
        productHistoryYears: 30,
        fundamentalsFreshnessMs: 30 * 24 * 60 * 60 * 1000,
        now: () => input.clock.now,
        onProviderRequest: (event) => {
          input.market.events.push(event);
        },
      },
    );
    return {
      service,
      cache,
      async close() {
        redis.disconnect();
        await processPrisma.$disconnect();
      },
    };
  }

  function newNamespace(): string {
    const namespace = `stock-data:v2:test:residual:${randomUUID()}`;
    namespaces.push(namespace);
    return namespace;
  }

  /** A frame as plain data: dates, closes and every operand column. */
  function frameValues(frame: {
    dates: readonly string[];
    closes: Float64Array;
    columns: ReadonlyMap<string, Float64Array>;
  }) {
    return frame.dates.map(
      (date, index): Record<string, number | string | undefined> => ({
        date,
        close: frame.closes[index],
        ...Object.fromEntries(
          [...frame.columns].map(([key, column]) => [key, column[index]]),
        ),
      }),
    );
  }

  /**
   * R5. A backtest prepared on Monday reads its last window on Tuesday evening, after Tuesday's
   * session became final and after the provider revised Monday's bar, Monday being inside the
   * run's period.
   *
   * While the stock stays resident, nothing changes: a window read on a ready entry does not
   * refresh, and the run reads what it started with. After its entry is evicted, the miss
   * re-hydrates to the new "today". It re-reads the ten-day tail from the provider, mid-run, and so
   * brings the revision of the in-period bar into the run's last window. Recorded, not endorsed: the
   * run stays consistent with PostgreSQL, and only the revised session and the sessions after it
   * move, but the run is no longer hermetic. The stock EOD refresh can bring the same revision in
   * without any eviction (next case).
   */
  it("records that a mid-run cache miss after the next session finalizes re-reads the tail and brings the provider's revision of an in-period bar into the run (R5)", async () => {
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const process = startProcess({ namespace: newNamespace(), market, clock });
    const security = await createSecurity();
    const period = { from: "2025-01-02", to: SESSION };
    const lastWindow = { from: "2026-01-02", to: SESSION };
    try {
      const prepared = await process.service.prepareDailyEvaluationData(
        security,
        period,
        OPERANDS,
      );
      const options = { priceBasisGeneration: prepared!.priceBasisGeneration };
      const read = async () =>
        frameValues(
          await process.service.readDailyEvaluationFrame(
            security,
            lastWindow,
            OPERANDS,
            options,
          ),
        );
      const before = await read();
      const requestsBefore = market.priceRequests.length;

      clock.now = NEXT_NOW;
      market.publishedThrough = NEXT_SESSION;
      market.revisions.set(SESSION, { close: 70, volume: 99_999 });

      // Resident: no request, no change.
      expect(await read()).toEqual(before);
      expect(market.priceRequests.length).toBe(requestsBefore);

      await process.cache.evict(security.id);
      const after = await read();
      const midRun = market.priceRequests.slice(requestsBefore);
      // The miss re-read the tail, which reaches back into the period.
      expect(
        midRun.some(
          (request) => request.from <= SESSION && request.to === NEXT_SESSION,
        ),
      ).toBe(true);
      const changed = after
        .filter(
          (row, index) => JSON.stringify(row) !== JSON.stringify(before[index]),
        )
        .map((row) => row.date);
      expect(changed).toEqual([SESSION]);
      expect(after.find((row) => row.date === SESSION)!.close).toBe(70);
      const stored = await store.getDailyDerivedState(security.id, {
        from: SESSION,
        to: SESSION,
      });
      expect(
        after.find((row) => row.date === SESSION)![seriesOperand("SMA_50D")],
      ).toBe(stored[0]!.sma50d);
    } finally {
      await process.close();
    }
  }, 120_000);

  /**
   * The stock EOD refresh re-reads the recent tail, so it does apply the provider's revision of
   * Monday's bar — that is how stored history self-corrects (DATA-04). A backtest reading its last
   * window while that refresh runs sees either the whole old version or the whole new one: never
   * prices from one and derived values from the other.
   */
  it("a window read racing the EOD refresh that applies a revision is all old or all new, never mixed", async () => {
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const namespace = newNamespace();
    const backtest = startProcess({ namespace, market, clock });
    const eod = startProcess({ namespace, market, clock });
    const security = await createSecurity();
    const lastWindow = { from: "2026-06-01", to: SESSION };
    try {
      const prepared = await backtest.service.prepareDailyEvaluationData(
        security,
        { from: "2025-01-02", to: SESSION },
        OPERANDS,
      );
      const options = { priceBasisGeneration: prepared!.priceBasisGeneration };
      const old = frameValues(
        await backtest.service.readDailyEvaluationFrame(
          security,
          lastWindow,
          OPERANDS,
          options,
        ),
      );

      clock.now = NEXT_NOW;
      market.publishedThrough = NEXT_SESSION;
      market.revisions.set(SESSION, { close: 70, high: 70.5, low: 69.5 });
      const requestsAtRefresh = market.priceRequests.length;
      const inside = gate();
      const release = gate();
      market.beforePrices = async () => {
        market.beforePrices = undefined;
        inside.open();
        await release.opened;
      };
      const refresh = eod.service.refreshStockTail(security, {
        expectedSession: {
          session: NEXT_SESSION,
          finalizedAt: "2026-08-25T20:30:00.000Z",
          calendar: "WEEKDAYS",
        },
        from: "2026-01-02",
      });
      await inside.opened;
      const duringRead = backtest.service.readDailyEvaluationFrame(
        security,
        lastWindow,
        OPERANDS,
        options,
      );
      // The refresh holds the stock's lease while it reads the provider. Let the read start against
      // it, then let the refresh finish: the read either waits for it or reads around it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The read made no request of its own: it waited for the refresh, or read around it.
      expect(market.priceRequests.length).toBe(requestsAtRefresh + 1);
      release.open();
      await refresh;
      const during = frameValues(await duringRead);
      const fresh = frameValues(
        await backtest.service.readDailyEvaluationFrame(
          security,
          lastWindow,
          OPERANDS,
          options,
        ),
      );

      // Never mixed: the read is wholly the version before the refresh or wholly the one after.
      expect([JSON.stringify(old), JSON.stringify(fresh)]).toContain(
        JSON.stringify(during),
      );
      // The refresh applied the revision, and every derived column moved with the price.
      const monday = (rows: typeof old) =>
        rows.find((row) => row.date === SESSION)!;
      expect(monday(fresh).close).toBe(70);
      expect(monday(fresh)).not.toEqual(monday(old));
      const stored = await store.getDailyDerivedState(security.id, {
        from: SESSION,
        to: SESSION,
      });
      expect(monday(fresh)[seriesOperand("SMA_50D")]).toBe(stored[0]!.sma50d);
    } finally {
      await backtest.close();
      await eod.close();
    }
  }, 120_000);

  /**
   * The PostgreSQL stale-writer window, reached with a real lease. Holder A computed derived rows on
   * the old basis; then its Redis connection went silent — bytes stop, nothing closes, as on a
   * partition that sends no RST or a failover that strands the old primary's connections. Its
   * automatic extension never answers, so its abort signal never fires and `assertOwned()` keeps
   * passing after the lease has expired in Redis. Meanwhile process B takes the stock over and
   * re-bases its history for a split. A then writes, and PostgreSQL accepts it: it holds no fencing
   * token, and the per-stock advisory lock only orders the two writes, it does not refuse the
   * stale one.
   *
   * Recorded, not endorsed. A stalled event loop does not get here: on resuming, redlock's next
   * extension refuses an expired lock locally and aborts the signal before the write's last
   * ownership check (measured with a blocked child process: 6 of 6 refused). A silent connection
   * does (6 of 6 committed). A stale write is harmless when both holders wrote the same provider
   * data; across a re-base it leaves derived rows on the old basis beside re-based prices, which
   * nothing rebuilds until the next revision bump.
   */
  it("records that a holder whose Redis connection goes silent keeps its ownership check, and its stale write lands after a successor's re-base", async () => {
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const successor = startProcess({
      namespace: newNamespace(),
      market,
      clock,
    });
    const security = await createSecurity();
    const range = { from: "2025-01-02", to: SESSION };

    // A's Redis connection runs through a proxy the test can silence.
    const target = new URL(redisRoot);
    let silent = false;
    const sockets = new Set<Socket>();
    const proxy = createServer((client) => {
      const upstream = connect(Number(target.port || 6379), target.hostname);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
      }
      client.on("data", (chunk) => {
        if (!silent) upstream.write(chunk);
      });
      upstream.on("data", (chunk) => {
        if (!silent) client.write(chunk);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const viaProxy = new URL(redisRoot);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String((proxy.address() as AddressInfo).port);
    const holderRedis = createStockDataRedisClient(viaProxy.toString());
    holderRedis.on("error", () => {});
    const holder = new RedlockLoadCoordinator(holderRedis, {
      lockDurationMs: 2_000,
      lockWaitMs: 10_000,
    });
    try {
      await successor.service.getDailyDerivedState(security.symbol, range);
      const generationBefore =
        (await store.getPriceBasis(security.id))?.generation ?? 0;
      let rebased: Promise<unknown> | undefined;
      let staleWrite: "COMMITTED" | "REFUSED" | undefined;
      const holding = holder
        .run(`hydrate:${security.id}`, async (lease) => {
          const stale = await store.getDailyDerivedState(security.id, range);
          silent = true;
          // While A is silent, the provider re-bases for a 4:1 split and B replaces the history. B
          // waits for A's lease to expire in Redis, then takes the stock over.
          clock.now = NEXT_NOW;
          market.publishedThrough = NEXT_SESSION;
          market.rebase = { exDate: NEXT_SESSION, ratio: 4 };
          rebased = successor.service.getDailyPrices(security.symbol, {
            from: "2026-08-01",
            to: NEXT_SESSION,
          });
          await rebased;
          try {
            await store.saveDailyDerivedState({
              securityId: security.id,
              rows: stale,
              weeklyPrices: [],
              successfulCoverage: range,
              syncedAt: new Date().toISOString(),
              assertOwned: lease.assertOwned,
            });
            staleWrite = "COMMITTED";
          } catch {
            staleWrite = "REFUSED";
          }
          // End the silence so the holder's pending extension and release can fail and return.
          silent = false;
          for (const socket of sockets) socket.destroy();
        })
        .catch(() => {});
      await holding;

      expect(staleWrite).toBe("COMMITTED");
      expect(
        (await store.getPriceBasis(security.id))?.generation,
      ).toBeGreaterThan(generationBefore);
      const prices = await store.getDailyPrices(security.id, range);
      const derived = await store.getDailyDerivedState(security.id, range);
      const closes = new Map(prices.map((price) => [price.date, price.close]));
      const offBasis = derived.filter(
        (row) =>
          row.sma50d !== undefined && row.sma50d / closes.get(row.date)! > 2,
      );
      // Every stale row now sits on the old basis beside re-based prices.
      expect(offBasis.length).toBeGreaterThan(100);
    } finally {
      silent = false;
      for (const socket of sockets) socket.destroy();
      holderRedis.disconnect();
      proxy.close();
      await successor.close();
    }
  }, 120_000);

  /**
   * Hydrations sharing a connection pool too small for them. With one connection and a one-second
   * pool timeout, concurrent cold hydrations queue on PostgreSQL; the question is whether a refused
   * connection leaves anything half-done behind. Whatever fails must fail cleanly — no READY
   * manifest without its rows, no duplicate row — and a retry with a normal pool must converge.
   */
  it("a saturated connection pool fails hydrations cleanly, and a retry converges", async () => {
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const namespace = newNamespace();
    const base = new URL(
      process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
    );
    base.searchParams.set("connection_limit", "1");
    base.searchParams.set("pool_timeout", "1");
    const starved = startProcess({
      namespace,
      market,
      clock,
      prismaUrl: base.toString(),
    });
    const securities = await Promise.all(
      Array.from({ length: 6 }, () => createSecurity()),
    );
    const range = { from: "2025-01-02", to: SESSION };
    try {
      const settled = await Promise.allSettled(
        securities.map((security) =>
          starved.service.getDailyDerivedState(security.symbol, range),
        ),
      );
      const failures = settled.flatMap((result) =>
        result.status === "rejected"
          ? [String(result.reason).slice(0, 200)]
          : [],
      );
      console.log(
        JSON.stringify({
          scenario: "pool-saturation",
          hydrations: securities.length,
          failed: failures.length,
          firstFailure: failures[0] ?? null,
        }),
      );
      for (const [index, result] of settled.entries()) {
        const security = securities[index]!;
        const manifest = await starved.cache.getManifest(security.id);
        if (result.status === "rejected") {
          expect(manifest?.status).not.toBe("READY");
        } else {
          expect(result.value).toEqual(
            await store.getDailyDerivedState(security.id, range),
          );
        }
        const duplicates = await prisma.$queryRaw<{ duplicates: bigint }[]>`
          SELECT count(*) - count(DISTINCT date) AS duplicates
          FROM "DailyPrice" WHERE "securityId" = ${security.id}`;
        expect(Number(duplicates[0]!.duplicates)).toBe(0);
      }
      const healthy = startProcess({ namespace, market, clock });
      try {
        for (const security of securities) {
          expect(
            await healthy.service.getDailyDerivedState(security.symbol, range),
          ).toEqual(await store.getDailyDerivedState(security.id, range));
        }
      } finally {
        await healthy.close();
      }
    } finally {
      await starved.close();
    }
  }, 300_000);
});
