import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, DateRange } from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { RedisStockDataCache } from "./cache.js";
import { InMemoryLoadCoordinator } from "./coordination.js";
import { addDays } from "./dates.js";
import { latestFinalizedSession } from "./market-data-refresh.js";
import { WEEKDAY_TRADING_CALENDAR } from "./eod-finality.js";
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

/**
 * End-of-day finality against PostgreSQL and Redis (`docs/decisions/eod-finality-v1.md`).
 *
 * The decision table is pinned by `eod-finality.test.ts` and the loader's choices by
 * `service.test.ts`. These cases prove, on the real stores, the one invariant every price consumer
 * relies on: no bar for a session that was still trading is ever stored or returned as final, a bar
 * an earlier loader stored provisionally is re-read once its session is final, and a session the
 * provider publishes late is picked up on the retry spacing — never on every read.
 */

loadRootEnv();
useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error("EOD finality integration tests require TEST_REDIS_URL or REDIS_URL.");
}
const describeWithRedis = redisUrl ? describe : describe.skip;

/** Wednesday 14 October 2026 (EDT): closes 20:00Z, final at 20:30Z. */
const SESSION = "2026-10-14";
const MID_SESSION = new Date("2026-10-14T15:00:00.000Z");
const INSIDE_DELAY = new Date("2026-10-14T20:15:00.000Z");
const JUST_FINAL = new Date("2026-10-14T20:35:00.000Z");

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(date);
    }
  }
  return dates;
}

function bar(securityId: string, date: string, close: number): DailyPrice {
  return {
    securityId,
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  };
}

/**
 * The provider as FMP behaves: its EOD endpoint lists the current session while it is trading,
 * with an in-progress reading, and replaces it with the final bar once published.
 */
class MarketProvider implements FmpStockProviderPort {
  readonly ranges: Required<DateRange>[] = [];
  /** Final bars by date. */
  readonly final = new Map<string, number>();
  /** In-progress readings by date, listed until the date is in `final`. */
  readonly provisional = new Map<string, number>();

  async getProfile() {
    return null;
  }

  async getDailyPrices(_symbol: string, securityId: string, range: DateRange) {
    if (!range.from || !range.to) throw new Error("Expected bounded range");
    this.ranges.push({ from: range.from, to: range.to });
    const dates = new Set([...this.final.keys(), ...this.provisional.keys()]);
    return [...dates]
      .filter((date) => date >= range.from! && date <= range.to!)
      .sort()
      .map((date) =>
        bar(securityId, date, this.final.get(date) ?? this.provisional.get(date)!),
      );
  }

  async getFinancialStatements() {
    return [];
  }
}

describeWithRedis("end-of-day finality on PostgreSQL and Redis", () => {
  const prisma = new PrismaClient();
  const store = new PrismaStockDataStore(prisma);
  const redis = createStockDataRedisClient(redisUrl ?? "redis://localhost:6379");
  const namespace = `stock-data:v2:test:eod-finality:${randomUUID()}`;
  const securityIds: string[] = [];

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    await deleteRedisNamespace(redis, namespace);
    await prisma.$disconnect();
    await redis.quit();
  });

  async function fixture(options: { frozenTails?: boolean } = {}) {
    const symbol = `EOD${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const security = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `${symbol} Corp`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
        ipoDate: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    securityIds.push(security.id);
    const provider = new MarketProvider();
    for (const date of weekdays("2026-07-01", "2026-10-13")) {
      provider.final.set(date, 100);
    }
    const clock = { now: MID_SESSION };
    const requests: ProviderRequestEvent[] = [];
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      10,
      namespace,
    );
    const service = new CanonicalStockDataService(
      store,
      provider,
      cache,
      new InMemoryLoadCoordinator(),
      {
        productHistoryYears: 30,
        fundamentalsFreshnessMs: 30 * 24 * 60 * 60 * 1000,
        now: () => clock.now,
        onProviderRequest: (event) => requests.push(event),
        eod: { frozenTails: options.frozenTails === true },
      },
    );
    const resolved = await service.getSecurity(symbol);
    const priceRequests = () =>
      requests.filter((event) => event.dataset === "DAILY_PRICE").length;
    return { security: resolved, symbol, provider, clock, service, cache, priceRequests };
  }

  const window = { from: "2026-09-01", to: SESSION };

  it("never stores the in-progress bar, and stores the final one once its session is final", async () => {
    const { security, symbol, provider, clock, service, priceRequests } =
      await fixture();
    provider.provisional.set(SESSION, 99);

    // 11:00 in New York: the session is trading. Nothing reaches past the previous one.
    const during = await service.getDailyPrices(symbol, window);
    expect(during.at(-1)?.date).toBe("2026-10-13");
    expect(provider.ranges.every((range) => range.to <= "2026-10-13")).toBe(true);
    expect(
      await prisma.dailyPrice.count({
        where: { securityId: security.id, date: new Date(`${SESSION}T00:00:00.000Z`) },
      }),
    ).toBe(0);
    expect(await service.stockRefreshState(security)).toMatchObject({
      latestBar: "2026-10-13",
      verifiedThrough: "2026-10-13",
      latestVerifiedBar: "2026-10-13",
    });

    // Inside the publication delay the session is still not final: nothing new is asked for.
    clock.now = INSIDE_DELAY;
    const requestsBefore = priceRequests();
    expect((await service.getDailyPrices(symbol, window)).at(-1)?.date).toBe(
      "2026-10-13",
    );
    expect(priceRequests()).toBe(requestsBefore);

    // Published and final: one tail read stores the final bar — with the short look at the
    // earliest stored sessions any read that adds a row makes first (`historical-price-basis-v1.md`
    // §7, rule 2) — and a second read asks for nothing.
    clock.now = JUST_FINAL;
    provider.final.set(SESSION, 101);
    const after = await service.getDailyPrices(symbol, window);
    expect(after.at(-1)).toMatchObject({ date: SESSION, close: 101 });
    expect(priceRequests()).toBe(requestsBefore + 2);
    await service.getDailyPrices(symbol, window);
    expect(priceRequests()).toBe(requestsBefore + 2);
    expect(await service.stockRefreshState(security)).toMatchObject({
      latestBar: SESSION,
      verifiedThrough: SESSION,
      latestVerifiedBar: SESSION,
    });
  });

  it("hides a bar an earlier loader stored before its session closed, then re-reads it once final", async () => {
    const { security, symbol, provider, clock, service, priceRequests } =
      await fixture();
    // The history as the previous loader left it: through the session's in-progress reading,
    // read at 11:00 and claimed fresh through the day.
    await store.saveDailyPriceSync({
      securityId: security.id,
      prices: [
        ...weekdays("2026-07-01", "2026-10-13").map((date) =>
          bar(security.id, date, 100),
        ),
        bar(security.id, SESSION, 99),
      ],
      successfulCoverage: [{ from: "1992-10-14", to: SESSION }],
      syncedAt: MID_SESSION.toISOString(),
      tailDate: SESSION,
      freshThrough: SESSION,
    });
    await store.createPriceBasis({
      securityId: security.id,
      verifiedAt: MID_SESSION.toISOString(),
    });

    // Still before finalization: the provisional row is in storage but never returned.
    clock.now = new Date("2026-10-14T18:00:00.000Z");
    const hidden = await service.getDailyPrices(symbol, window);
    expect(hidden.at(-1)?.date).toBe("2026-10-13");
    expect(await service.stockRefreshState(security)).toMatchObject({
      latestBar: SESSION,
      verifiedThrough: "2026-10-13",
      latestVerifiedBar: "2026-10-13",
    });

    // Final: the watermark does not prove a post-final read of the stored bar, so it is re-read.
    clock.now = JUST_FINAL;
    provider.final.set(SESSION, 101);
    const before = priceRequests();
    const repaired = await service.getDailyPrices(symbol, window);
    expect(repaired.at(-1)).toMatchObject({ date: SESSION, close: 101 });
    expect(priceRequests()).toBeGreaterThan(before);
    const stored = await prisma.dailyPrice.findFirst({
      where: { securityId: security.id, date: new Date(`${SESSION}T00:00:00.000Z`) },
    });
    expect(Number(stored?.close)).toBe(101);
  });

  it("waits for a late publication on the retry spacing, then reports the session READY", async () => {
    const { security, provider, clock, service, priceRequests } = await fixture();
    const expected = await latestFinalizedSession({
      now: JUST_FINAL,
      calendar: WEEKDAY_TRADING_CALENDAR,
      publicationDelayMs: 30 * 60_000,
    });
    expect(expected?.session).toBe(SESSION);
    clock.now = JUST_FINAL;

    // Final by the clock, but the provider has not published the bar yet.
    const first = await service.refreshStockTail(security, {
      expectedSession: expected!,
      from: "2026-09-01",
    });
    expect(first.status).toBe("AWAITING_PUBLICATION");
    expect(first.state.latestVerifiedBar).toBe("2026-10-13");
    const afterFirst = priceRequests();

    // Inside the retry spacing nothing is asked.
    clock.now = new Date("2026-10-14T20:50:00.000Z");
    const second = await service.refreshStockTail(security, {
      expectedSession: expected!,
      from: "2026-09-01",
    });
    expect(second.status).toBe("AWAITING_PUBLICATION");
    expect(priceRequests()).toBe(afterFirst);

    // Published; past the spacing, one read makes it READY.
    clock.now = new Date("2026-10-14T21:10:00.000Z");
    provider.final.set(SESSION, 102);
    const third = await service.refreshStockTail(security, {
      expectedSession: expected!,
      from: "2026-09-01",
    });
    expect(third.status).toBe("READY");
    expect(third.state).toMatchObject({
      latestBar: SESSION,
      latestVerifiedBar: SESSION,
      verifiedThrough: SESSION,
      derivedThrough: SESSION,
    });
    // The tail and the earliest-rows confirmation a read adding a row makes.
    expect(priceRequests()).toBe(afterFirst + 2);
  });

  it("gives up on a session the security never prints, and asks for nothing more", async () => {
    const { security, clock, service, priceRequests } = await fixture();
    const expected = (await latestFinalizedSession({
      now: JUST_FINAL,
      calendar: WEEKDAY_TRADING_CALENDAR,
      publicationDelayMs: 30 * 60_000,
    }))!;
    clock.now = JUST_FINAL;
    await service.refreshStockTail(security, { expectedSession: expected, from: "2026-09-01" });
    // A day after the session became final, still nothing: the security is taken not to trade it.
    clock.now = new Date("2026-10-15T20:31:00.000Z");
    const before = priceRequests();
    const result = await service.refreshStockTail(security, {
      expectedSession: expected,
      from: "2026-09-01",
    });
    expect(result.status).toBe("NOT_PUBLISHED");
    expect(priceRequests()).toBe(before);
  });

  it("rebuilds an evicted stock from PostgreSQL alone, with no provider request", async () => {
    const { security, symbol, provider, clock, service, cache, priceRequests } =
      await fixture();
    clock.now = JUST_FINAL;
    provider.final.set(SESSION, 101);
    const resident = await service.getDailyPrices(symbol, window);
    const before = priceRequests();

    await cache.evict(security.id);
    const rebuilt = await service.getDailyPrices(symbol, window);
    expect(rebuilt).toEqual(resident);
    expect(priceRequests()).toBe(before);
  });

  it("never re-reads a stored tail when tails are frozen, and says the session is missing", async () => {
    const { security, symbol, provider, clock, service, priceRequests } =
      await fixture({ frozenTails: true });
    await service.getDailyPrices(symbol, window);
    const before = priceRequests();
    clock.now = JUST_FINAL;
    provider.final.set(SESSION, 101);
    const rows = await service.getDailyPrices(symbol, window);
    expect(rows.at(-1)?.date).toBe("2026-10-13");
    expect(priceRequests()).toBe(before);
    const expected = (await latestFinalizedSession({
      now: JUST_FINAL,
      calendar: WEEKDAY_TRADING_CALENDAR,
      publicationDelayMs: 30 * 60_000,
    }))!;
    const result = await service.refreshStockTail(security, {
      expectedSession: expected,
      from: "2026-09-01",
    });
    expect(result.status).toBe("FROZEN");
    expect(priceRequests()).toBe(before);
  });
});
