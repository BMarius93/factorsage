import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type { DailyPrice, DateRange } from "@intrinsic/domain";
import type { FmpStockProviderPort } from "@intrinsic/fmp";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RedisStockDataCache, type StockManifest } from "./cache.js";
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
    "The stock-data concurrency suite requires TEST_REDIS_URL or REDIS_URL; CI must not skip it.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

/**
 * Many callers, several "processes", one canonical stock — on real PostgreSQL, real Redis and real
 * Redlock, with only the provider replaced by a deterministic synthetic market.
 *
 * Each scenario states an invariant that must hold under **any** interleaving, and forces the
 * interleavings that broke it before: a reader meeting another process's live hydration (OPS-06),
 * a lease holder whose READY generation is removed under it, an LRU smaller than the working set,
 * a cache lost entirely, a hydration that fails after writing PostgreSQL, a holder that lost its
 * lease. Values are always checked against PostgreSQL and the synthetic market's own answer, never
 * only against another read of the cache.
 *
 * A "process" here is one `CanonicalStockDataService` with its own Prisma client, its own Redis
 * connection and its own Redlock coordinator — exactly what an API instance or a worker child
 * holds. Synchronization uses barriers and held provider calls; timers appear only where a lease or
 * a TTL is itself the subject.
 *
 * Set `STOCK_DATA_CONCURRENCY_REPORT=<file>` to append each stress scenario's measurements (wall
 * time, provider requests, Redis commands) as JSON lines.
 */

const NOW = new Date("2026-08-24T23:00:00.000Z");
const SESSION = "2026-08-24";
const NEXT_NOW = new Date("2026-08-25T23:00:00.000Z");
const NEXT_SESSION = "2026-08-25";
const LISTED = "2004-01-02";
const REPORT_FILE = process.env.STOCK_DATA_CONCURRENCY_REPORT?.trim();

type PriceRequest = { symbol: string; from: string; to: string };

/** A provider answering every symbol from one deterministic history, and counting what it is asked. */
class SyntheticMarket implements FmpStockProviderPort {
  readonly priceRequests: PriceRequest[] = [];
  readonly profileRequests: string[] = [];
  readonly statementRequests: string[] = [];
  /** Every provider request every process announced, with the loader's own reason for it. */
  readonly events: ProviderRequestEvent[] = [];
  /** The newest bar the market has published. */
  publishedThrough = SESSION;
  /** Awaited before every price answer, when set: how a test holds the provider. */
  beforePrices?: (request: PriceRequest) => Promise<void>;
  /** Symbols whose next statement read fails, once each. */
  readonly failStatementsOnce = new Set<string>();

  async getProfile(symbol: string) {
    this.profileRequests.push(symbol);
    return null;
  }

  async getDailyPrices(symbol: string, securityId: string, range: DateRange) {
    if (!range.from || !range.to) {
      throw new Error("Expected a bounded range");
    }
    const request = { symbol, from: range.from, to: range.to };
    this.priceRequests.push(request);
    await this.beforePrices?.(request);
    return syntheticHistory(securityId, this.publishedThrough).filter(
      (row) => row.date >= range.from! && row.date <= range.to!,
    );
  }

  async getFinancialStatements(symbol: string) {
    this.statementRequests.push(symbol);
    if (this.failStatementsOnce.delete(symbol)) {
      throw new Error(`Synthetic statement outage for ${symbol}`);
    }
    return [];
  }

  priceRequestsFor(symbol: string): PriceRequest[] {
    return this.priceRequests.filter((request) => request.symbol === symbol);
  }

  /** The price ranges downloaded to fill coverage — each date at most once, whoever asked. */
  coverageDownloadsFor(symbol: string): PriceRequest[] {
    return this.events
      .filter(
        (event) =>
          event.symbol === symbol &&
          event.dataset === "DAILY_PRICE" &&
          event.reason === "MISSING_COVERAGE",
      )
      .map((event) => ({ symbol, from: event.from!, to: event.to! }));
  }

  reasonsFor(symbol: string): string[] {
    return this.events
      .filter((event) => event.symbol === symbol)
      .map((event) => `${event.dataset}:${event.reason}`);
  }
}

/** The whole history the market serves: every weekday from the listing, prices drifting gently. */
function syntheticHistory(securityId: string, through: string): DailyPrice[] {
  return weekdays(LISTED, through).map((date, index) => {
    const close =
      Math.round((50 + 10 * Math.sin(index / 40) + index * 0.01) * 100) / 100;
    return {
      securityId,
      date,
      open: close,
      high: Math.round((close + 0.5) * 100) / 100,
      low: Math.round((close - 0.5) * 100) / 100,
      close,
      volume: 1_000 + (index % 17) * 10,
    };
  });
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** A barrier for `parties` arrivals that fails, rather than hangs, after `timeoutMs`. */
function barrier(parties: number, timeoutMs: number) {
  let arrived = 0;
  const all = gate();
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) {
        all.open();
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          all.opened,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Barrier: ${arrived} of ${parties} arrived in ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Deterministic pseudo-random numbers, so a failing interleaving can be rerun with its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Requested ranges must never overlap: an overlap is a date downloaded twice. */
function overlappingRanges(requests: readonly PriceRequest[]): string[] {
  const sorted = [...requests].sort((a, b) => a.from.localeCompare(b.from));
  const overlaps: string[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.from <= previous.to) {
      overlaps.push(
        `${previous.from}:${previous.to} / ${current.from}:${current.to}`,
      );
    }
  }
  return overlaps;
}

describeRedis("stock-data under concurrent callers", () => {
  const redisRoot = redisUrl ?? "redis://localhost:6379";
  const prisma = new PrismaClient();
  const admin = createStockDataRedisClient(redisRoot);
  const securityIds: string[] = [];
  const namespaces: string[] = [];
  const tag = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  let symbolIndex = 0;

  type Process = {
    readonly service: CanonicalStockDataService;
    readonly cache: RedisStockDataCache;
    close(): Promise<void>;
  };

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    for (const namespace of namespaces) {
      await deleteRedisNamespace(admin, namespace);
    }
    admin.disconnect();
    await prisma.$disconnect();
  });

  async function createSecurity(): Promise<{ id: string; symbol: string }> {
    symbolIndex += 1;
    const symbol = `CC${symbolIndex}${tag}`;
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `Concurrency ${symbolIndex}`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityIds.push(row.id);
    return { id: row.id, symbol };
  }

  function newNamespace(): string {
    const namespace = `stock-data:v2:test:concurrency:${randomUUID()}`;
    namespaces.push(namespace);
    return namespace;
  }

  /** One API instance or worker child: its own clients, its own coordinator, a shared market. */
  function startProcess(input: {
    namespace: string;
    market: SyntheticMarket;
    clock: { now: Date };
    maxResidentStocks?: number;
    hydrationTtlMs?: number;
    lockDurationMs?: number;
    observer?: ConstructorParameters<typeof RedisStockDataCache>[4];
  }): Process {
    const processPrisma = new PrismaClient();
    const redis = createStockDataRedisClient(redisRoot);
    const cache = new RedisStockDataCache(
      new IoredisCacheClient(redis),
      input.maxResidentStocks ?? 50,
      input.namespace,
      input.hydrationTtlMs,
      input.observer,
    );
    const service = new CanonicalStockDataService(
      new PrismaStockDataStore(processPrisma),
      input.market,
      cache,
      new RedlockLoadCoordinator(redis, {
        lockDurationMs: input.lockDurationMs ?? 10_000,
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

  async function storedPrices(securityId: string, range: Required<DateRange>) {
    return new PrismaStockDataStore(prisma).getDailyPrices(securityId, range);
  }

  async function storedDerived(securityId: string, range: Required<DateRange>) {
    return new PrismaStockDataStore(prisma).getDailyDerivedState(
      securityId,
      range,
    );
  }

  /** No session stored twice: the row count equals the distinct dates. */
  async function duplicatePriceRows(securityId: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ duplicates: bigint }[]>`
      SELECT count(*) - count(DISTINCT date) AS duplicates
      FROM "DailyPrice" WHERE "securityId" = ${securityId}`;
    return Number(rows[0]?.duplicates ?? 0);
  }

  function withoutSecurity<T extends { securityId: string }>(
    rows: readonly T[],
  ) {
    return rows.map(({ securityId: _ignored, ...rest }) => rest);
  }

  it("cold: many readers through every entry point get PostgreSQL's answer, and no date is downloaded twice", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const processes = Array.from({ length: 3 }, () =>
      startProcess({ namespace, market, clock }),
    );
    const { id, symbol } = await createSecurity();
    // Prices are a pure function of the market at any width; derived rows read here are too,
    // because every load is anchored at the retention start (CONC-01, below).
    const ranges: Required<DateRange>[] = [
      { from: "2025-08-25", to: SESSION },
      { from: "1997-01-01", to: SESSION },
      { from: "1998-03-02", to: "2014-06-30" },
      { from: "2021-01-01", to: "2021-12-31" },
    ];
    try {
      const calls = Array.from({ length: 12 }, (_, index) => {
        const process = processes[index % processes.length]!;
        const range = ranges[index % ranges.length]!;
        switch (index % 3) {
          case 0:
            return process.service
              .getDailyPrices(symbol, range)
              .then((rows) => ({ kind: "prices" as const, range, rows }));
          case 1: {
            const canonical = { from: "1997-01-01", to: range.to };
            return process.service
              .getDailyDerivedState(symbol, canonical)
              .then((rows) => ({
                kind: "derived" as const,
                range: canonical,
                rows,
              }));
          }
          default:
            return process.service
              .getStockDetails(symbol, range)
              .then((details) => ({
                kind: "prices" as const,
                range,
                rows: details.prices,
              }));
        }
      });
      const settled = await Promise.allSettled(calls);
      expect(
        settled.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);

      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const { kind, range, rows } = result.value;
        const stored =
          kind === "prices"
            ? await storedPrices(id, range)
            : await storedDerived(id, range);
        expect(rows).toEqual(stored);
        if (kind === "prices") {
          expect(withoutSecurity(rows as DailyPrice[])).toEqual(
            withoutSecurity(
              syntheticHistory(id, SESSION).filter(
                (row) => row.date >= range.from && row.date <= range.to,
              ),
            ),
          );
        }
      }
      expect(overlappingRanges(market.coverageDownloadsFor(symbol))).toEqual(
        [],
      );
      expect(await duplicatePriceRows(id)).toBe(0);
      const manifest = await processes[0]!.cache.getManifest(id);
      expect(manifest?.status).toBe("READY");
    } finally {
      await Promise.all(processes.map((process) => process.close()));
    }
  }, 120_000);

  it("warm: readers racing a new session's tail refresh see one session or the other, and the tail is read once", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const processes = Array.from({ length: 3 }, () =>
      startProcess({ namespace, market, clock }),
    );
    const { id, symbol } = await createSecurity();
    const control = await createSecurity();
    const range = { from: "2025-01-02", to: NEXT_SESSION };
    try {
      await processes[0]!.service.getDailyPrices(symbol, range);
      await processes[0]!.service.getDailyPrices(control.symbol, range);
      const reasonsBefore = market.reasonsFor(symbol).length;
      const controlBefore = market.reasonsFor(control.symbol).length;

      clock.now = NEXT_NOW;
      market.publishedThrough = NEXT_SESSION;
      // What one caller alone costs the provider for the new session: the yardstick.
      await processes[0]!.service.getDailyPrices(control.symbol, range);
      const serialCost = market.reasonsFor(control.symbol).slice(controlBefore);
      expect(serialCost).toContain("DAILY_PRICE:RECENT_TAIL_STALE");

      const reads = await Promise.allSettled(
        Array.from({ length: 15 }, (_, index) => {
          const service = processes[index % processes.length]!.service;
          return index % 2 === 0
            ? service.getDailyPrices(symbol, range)
            : service.getDailyDerivedState(symbol, range);
        }),
      );
      expect(
        reads.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
      for (const result of reads) {
        if (result.status !== "fulfilled") continue;
        const last = result.value.at(-1)?.date;
        expect([SESSION, NEXT_SESSION]).toContain(last);
      }
      // Fifteen callers cost the provider exactly what one does: one leading-edge read for the
      // new session (and the check of the earliest stored row that goes with it), whoever made it.
      expect(market.reasonsFor(symbol).slice(reasonsBefore).sort()).toEqual(
        [...serialCost].sort(),
      );
      expect(await duplicatePriceRows(id)).toBe(0);
      expect(await processes[1]!.service.getDailyPrices(symbol, range)).toEqual(
        await storedPrices(id, range),
      );
    } finally {
      await Promise.all(processes.map((process) => process.close()));
    }
  }, 120_000);

  it("different securities hydrate side by side rather than one after another", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const processes = Array.from({ length: 2 }, () =>
      startProcess({ namespace, market, clock }),
    );
    const securities = await Promise.all(
      Array.from({ length: 4 }, () => createSecurity()),
    );
    // Every security's first provider read waits until all four are inside the provider at once.
    // A shared lock, queue or gate that serialized them would leave the barrier short and fail it.
    const allInside = barrier(4, 20_000);
    const first = new Set<string>();
    market.beforePrices = async (request) => {
      if (!first.has(request.symbol)) {
        first.add(request.symbol);
        await allInside.arrive();
      }
    };
    try {
      const results = await Promise.allSettled(
        securities.map(({ symbol }, index) =>
          processes[index % 2]!.service.getDailyPrices(symbol, {
            from: "2024-01-02",
            to: SESSION,
          }),
        ),
      );
      expect(
        results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
    } finally {
      market.beforePrices = undefined;
      await Promise.all(processes.map((process) => process.close()));
    }
  }, 60_000);

  it("a hydration that fails after writing PostgreSQL never publishes READY, and the retry converges to the uninterrupted result", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const process = startProcess({ namespace, market, clock });
    const failing = await createSecurity();
    const control = await createSecurity();
    const range = { from: "2018-01-02", to: SESSION };
    try {
      market.failStatementsOnce.add(failing.symbol);
      await expect(
        process.service.getDailyPrices(failing.symbol, range),
      ).rejects.toThrow(/statement outage/);
      // Prices reached PostgreSQL before the statements failed, and nothing claims READY.
      expect((await storedPrices(failing.id, range)).length).toBeGreaterThan(0);
      expect((await process.cache.getManifest(failing.id))?.status).not.toBe(
        "READY",
      );

      const retried = await process.service.getDailyDerivedState(
        failing.symbol,
        range,
      );
      const uninterrupted = await process.service.getDailyDerivedState(
        control.symbol,
        range,
      );
      expect(withoutSecurity(retried)).toEqual(withoutSecurity(uninterrupted));
      expect(retried).toEqual(await storedDerived(failing.id, range));
      expect(
        overlappingRanges(market.coverageDownloadsFor(failing.symbol)),
      ).toEqual([]);
      expect(await duplicatePriceRows(failing.id)).toBe(0);
    } finally {
      await process.close();
    }
  }, 120_000);

  it("a generation abandoned by a crashed holder is taken over by the next caller, not waited out", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const process = startProcess({ namespace, market, clock });
    const { id, symbol } = await createSecurity();
    const range = { from: "2023-01-02", to: SESSION };
    try {
      // What a holder that died mid-hydration leaves: a HYDRATING manifest with most of its
      // fifteen-minute lifetime ahead, a chunk registered to it, and no lock. The chunk's year lies
      // before the retention window, so the successor — which loads the whole window (CONC-01) —
      // never writes that key itself: only the takeover's cleanup can remove it.
      const abandoned: StockManifest = {
        securityId: id,
        status: "HYDRATING",
        productHistoryYears: 30,
        priceRetentionYears: 34,
        coverageStart: "1992-08-24",
        coverageEnd: SESSION,
        hydrationId: "crashed-holder",
        hydratingAt: "2026-08-24T22:59:00.000Z",
        priceDatasetVersion: 0,
        financialStatementVersion: 1,
        derivedStateRevision: 0,
        dailyStateEncodingVersion: 0,
      };
      await process.cache.setManifest(abandoned);
      await process.cache.writeDailyPriceYears(id, [], [1990], abandoned);

      const started = Date.now();
      const rows = await process.service.getDailyPrices(symbol, range);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(rows).toEqual(await storedPrices(id, range));
      const manifest = await process.cache.getManifest(id);
      expect(manifest?.status).toBe("READY");
      expect(manifest?.hydrationId).not.toBe("crashed-holder");
      expect(
        await admin.exists(`${namespace}:security:${id}:prices:1D:1990`),
      ).toBe(0);
    } finally {
      await process.close();
    }
  }, 60_000);

  it("a holder that lost its lease cannot publish over the holder that took the stock over", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    // A short lease, so the stale holder's own Redlock notices the loss quickly.
    const stale = startProcess({
      namespace,
      market,
      clock,
      lockDurationMs: 2_000,
    });
    const successor = startProcess({ namespace, market, clock });
    const { id, symbol } = await createSecurity();
    const range = { from: "2022-01-03", to: SESSION };
    const staleInside = gate();
    const staleReleased = gate();
    let held = false;
    market.beforePrices = async () => {
      if (!held) {
        held = true;
        staleInside.open();
        await staleReleased.opened;
      }
    };
    try {
      const staleRead = stale.service.getDailyPrices(symbol, range);
      await staleInside.opened;
      // The lease is lost — a pause, a Redis failover — and another process takes the stock over
      // and finishes while the first one is still inside the provider.
      const lockKeys = await admin.keys(`stock-data:load:hydrate:${id}`);
      expect(lockKeys.length).toBe(1);
      await admin.del(...lockKeys);
      const fresh = await successor.service.getDailyPrices(symbol, range);
      const published = await successor.cache.getManifest(id);
      expect(published?.status).toBe("READY");

      staleReleased.open();
      // It learns of the loss well inside its own lease — not after redlock has spent the whole
      // acquisition wait (two minutes in production) retrying an extension that cannot succeed.
      const settledWithin = await Promise.race([
        staleRead.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 15_000),
        ),
      ]);
      expect(settledWithin).toBe(true);
      await expect(staleRead).rejects.toThrow(
        /generation changed|lock|lease|aborted|quorum/i,
      );
      // The successor's generation stands, and so do its values.
      expect(await successor.cache.getManifest(id)).toEqual(published);
      expect(fresh).toEqual(await storedPrices(id, range));
      expect(await successor.service.getDailyPrices(symbol, range)).toEqual(
        fresh,
      );
      expect(await duplicatePriceRows(id)).toBe(0);
    } finally {
      staleReleased.open();
      market.beforePrices = undefined;
      await Promise.all([stale.close(), successor.close()]);
    }
  }, 90_000);

  it("a caller that queued longer than a whole lease behind another still gets a lease it can use", async () => {
    // CONC-03: redlock dates a lock's expiry from when its acquisition *began*. A caller that
    // waited longer than one lease got a lock its own process already counted as expired, and its
    // first ownership check failed with "Cannot extend an already-expired lock".
    const redis = createStockDataRedisClient(redisRoot);
    const lockDurationMs = 1_000;
    const holder = new RedlockLoadCoordinator(redis, {
      lockDurationMs,
      lockWaitMs: 10_000,
    });
    const waiter = new RedlockLoadCoordinator(redis, {
      lockDurationMs,
      lockWaitMs: 10_000,
    });
    const resource = `test:conc-03:${randomUUID()}`;
    const holding = gate();
    const release = gate();
    try {
      const held = holder.run(resource, async (lease) => {
        holding.open();
        await release.opened;
        lease.assertOwned();
      });
      await holding.opened;
      const waited = waiter.run(resource, async (lease) => {
        // Real work after the wait, across an extension of the waiter's own lease.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, lockDurationMs),
        );
        lease.assertOwned();
        return "ran";
      });
      // Hold well past one lease, renewed all the while, then let the waiter in.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, lockDurationMs * 2.5),
      );
      release.open();
      await held;
      await expect(waited).resolves.toBe("ran");
    } finally {
      release.open();
      redis.disconnect();
    }
  }, 30_000);

  it("keeps a slow hydration's generation alive between phases that register no key", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const hydrationTtlMs = 12_000;
    const process = startProcess({ namespace, market, clock, hydrationTtlMs });
    const { id, symbol } = await createSecurity();
    const manifestKey = `${namespace}:security:${id}:manifest`;
    const inside = gate();
    const released = gate();
    let held = false;
    market.beforePrices = async () => {
      if (!held) {
        held = true;
        inside.open();
        await released.opened;
      }
    };
    try {
      const range = { from: "1997-01-02", to: SESSION };
      const read = process.service.getDailyPrices(symbol, range);
      await inside.opened;
      // Hold the provider until the generation is close to expiring: the hydration has
      // registered nothing since it began, and saving decades of prices and statements still
      // lies between it and its first registered write. Only a renewal at the end of this phase
      // keeps the generation alive through them.
      while ((await admin.pttl(manifestKey)) > 400) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      released.open();
      const rows = await read;
      expect(rows).toEqual(await storedPrices(id, range));
      expect(rows.length).toBeGreaterThan(5_000);
      expect((await process.cache.getManifest(id))?.status).toBe("READY");
    } finally {
      released.open();
      market.beforePrices = undefined;
      await process.close();
    }
  }, 60_000);

  it("answers an empty derived window from the cache instead of rebuilding the stock", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const process = startProcess({ namespace, market, clock });
    const { id, symbol } = await createSecurity();
    try {
      await process.service.getDailyDerivedState(symbol, {
        from: "2025-01-02",
        to: SESSION,
      });
      const manifest = await process.cache.getManifest(id);
      const hydrations = vi.spyOn(process.cache, "beginHydration");
      const requestsBefore = market.priceRequests.length;

      // A weekend: no session, so no row — an answer, not a miss (OPS-07).
      await expect(
        process.service.getDailyDerivedState(symbol, {
          from: "2026-08-22",
          to: "2026-08-23",
        }),
      ).resolves.toEqual([]);
      expect(hydrations).not.toHaveBeenCalled();
      expect(market.priceRequests.length).toBe(requestsBefore);
      expect(await process.cache.getManifest(id)).toEqual(manifest);
    } finally {
      await process.close();
    }
  }, 60_000);

  it("with fewer resident slots than securities, every reader still gets PostgreSQL's values and the provider is not asked again", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const processes = Array.from({ length: 3 }, () =>
      startProcess({ namespace, market, clock, maxResidentStocks: 2 }),
    );
    const securities = await Promise.all(
      Array.from({ length: 4 }, () => createSecurity()),
    );
    const range = { from: "2020-01-02", to: SESSION };
    try {
      for (const { symbol } of securities) {
        await processes[0]!.service.getDailyDerivedState(symbol, range);
      }
      const requestsAfterWarm = market.priceRequests.length;
      const random = mulberry32(20261016);
      const reads = await Promise.allSettled(
        Array.from({ length: 40 }, (_, index) => {
          const security =
            securities[Math.floor(random() * securities.length)]!;
          const service = processes[index % processes.length]!.service;
          const prices = random() < 0.5;
          return (
            prices
              ? service.getDailyPrices(security.symbol, range)
              : service.getDailyDerivedState(security.symbol, range)
          ).then((rows) => ({ security, rows, prices }));
        }),
      );
      expect(
        reads.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
      for (const result of reads) {
        if (result.status !== "fulfilled") continue;
        const { security, rows, prices } = result.value;
        expect(rows).toEqual(
          prices
            ? await storedPrices(security.id, range)
            : await storedDerived(security.id, range),
        );
      }
      // Evictions are repaired from PostgreSQL alone.
      expect(market.priceRequests.length).toBe(requestsAfterWarm);
      expect(
        await admin.zcard(`${namespace}:resident-stocks`),
      ).toBeLessThanOrEqual(2);
    } finally {
      await Promise.all(processes.map((process) => process.close()));
    }
  }, 180_000);

  it("after losing the whole cache, concurrent readers rebuild identical values with no provider request", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const processes = Array.from({ length: 3 }, () =>
      startProcess({ namespace, market, clock }),
    );
    const { id, symbol } = await createSecurity();
    const range = { from: "1999-01-04", to: SESSION };
    try {
      const prices = await processes[0]!.service.getDailyPrices(symbol, range);
      const derived = await processes[0]!.service.getDailyDerivedState(
        symbol,
        range,
      );
      const requests = market.priceRequests.length;

      await deleteRedisNamespace(admin, namespace);

      const reads = await Promise.all(
        Array.from({ length: 12 }, (_, index) => {
          const service = processes[index % processes.length]!.service;
          return index % 2 === 0
            ? service
                .getDailyPrices(symbol, range)
                .then((rows) => ({ prices: rows }))
            : service
                .getDailyDerivedState(symbol, range)
                .then((rows) => ({ derived: rows }));
        }),
      );
      for (const read of reads) {
        if ("prices" in read) expect(read.prices).toEqual(prices);
        else expect(read.derived).toEqual(derived);
      }
      expect(market.priceRequests.length).toBe(requests);
      expect((await processes[2]!.cache.getManifest(id))?.status).toBe("READY");
    } finally {
      await Promise.all(processes.map((process) => process.close()));
    }
  }, 180_000);

  /**
   * CONC-01 (found by this suite, 2026-10-16). Recursive series — every EMA, Wilder's RSI — are
   * anchored at the earliest stored bar (AUD-02). While a load was scoped to the caller's window, a
   * window whose warm-up ended inside the product horizon loaded only from its own warm-up start,
   * and when a wider caller later widened the stock the derived state was rebuilt from the new
   * first bar: the values of dates already served changed (EMA 200W on this history by about one
   * percent four years in). Every load is now anchored at the retention start, so the first caller's
   * window no longer decides a value.
   */
  it("CONC-01: a date's derived values do not depend on how much history the first caller loaded", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const process = startProcess({ namespace, market, clock });
    const { symbol } = await createSecurity();
    const window = { from: "2016-03-01", to: "2016-03-31" };
    try {
      // A one-year Stock Details view is this stock's first caller...
      await process.service.getDailyDerivedState(symbol, {
        from: "2016-01-04",
        to: "2016-12-30",
      });
      const narrow = await process.service.getDailyDerivedState(symbol, window);
      // ...and a thirty-year backtest its second.
      await process.service.getDailyDerivedState(symbol, {
        from: "1997-01-02",
        to: SESSION,
      });
      const wide = await process.service.getDailyDerivedState(symbol, window);
      expect(wide.map((row) => [row.date, row.ema200w, row.ema200d])).toEqual(
        narrow.map((row) => [row.date, row.ema200w, row.ema200d]),
      );
    } finally {
      await process.close();
    }
  }, 120_000);

  it("CONC-01: narrow then wide, wide then narrow and concurrent first callers give identical derived values", async () => {
    const namespace = newNamespace();
    const market = new SyntheticMarket();
    const clock = { now: NOW };
    const processes = Array.from({ length: 2 }, () =>
      startProcess({ namespace, market, clock }),
    );
    // Three securities over one synthetic market: identical bars, three first-caller orders.
    const [narrowFirst, wideFirst, concurrent] = await Promise.all(
      Array.from({ length: 3 }, () => createSecurity()),
    );
    const narrow = { from: "2016-01-04", to: "2016-12-30" };
    const wide = { from: "1997-01-02", to: SESSION };
    const window = { from: "2014-01-02", to: "2018-12-31" };
    const values = async (symbol: string) =>
      (await processes[0]!.service.getDailyDerivedState(symbol, window)).map(
        ({ securityId: _ignored, ...row }) => row,
      );
    try {
      await processes[0]!.service.getStockDetails(narrowFirst!.symbol, narrow);
      await processes[1]!.service.getDailyDerivedState(
        narrowFirst!.symbol,
        wide,
      );

      await processes[1]!.service.getDailyDerivedState(wideFirst!.symbol, wide);
      await processes[0]!.service.getStockDetails(wideFirst!.symbol, narrow);

      await Promise.all([
        processes[0]!.service.getStockDetails(concurrent!.symbol, narrow),
        processes[1]!.service.getDailyDerivedState(concurrent!.symbol, wide),
      ]);

      const expected = await values(wideFirst!.symbol);
      expect(expected.length).toBeGreaterThan(1_000);
      expect(expected.some((row) => row.ema200w !== undefined)).toBe(true);
      expect(await values(narrowFirst!.symbol)).toEqual(expected);
      expect(await values(concurrent!.symbol)).toEqual(expected);
      // One price download per security, whichever caller came first.
      for (const security of [narrowFirst!, wideFirst!, concurrent!]) {
        expect(market.priceRequestsFor(security.symbol)).toHaveLength(1);
      }
    } finally {
      await Promise.all(processes.map((process) => process.close()));
    }
  }, 180_000);

  describe("bounded stress from a cold cache", () => {
    for (const callers of [2, 10, 25, 50, 100]) {
      it(`${callers} concurrent callers across four processes and three securities`, async () => {
        const namespace = newNamespace();
        const market = new SyntheticMarket();
        const clock = { now: NOW };
        const processes = Array.from({ length: 4 }, () =>
          startProcess({ namespace, market, clock }),
        );
        const securities = await Promise.all(
          Array.from({ length: 3 }, () => createSecurity()),
        );
        const random = mulberry32(callers * 7919);
        // Prices and derived rows at any width: every load is anchored at the retention start, so
        // no caller's window decides a value (CONC-01).
        const starts = ["1997-01-02", "2006-06-01", "2016-03-01", "2025-09-02"];
        const ends = ["2003-12-31", "2015-06-30", SESSION];
        const before = await commandStats();
        const loopDelay = monitorEventLoopDelay({ resolution: 20 });
        loopDelay.enable();
        const startedAt = Date.now();
        try {
          const calls = Array.from({ length: callers }, (_, index) => {
            const security =
              securities[Math.floor(random() * securities.length)]!;
            const choice = random();
            const range =
              choice >= 0.4 && choice < 0.8
                ? {
                    from: starts[Math.floor(random() * starts.length)]!,
                    to: ends[Math.floor(random() * ends.length)]!,
                  }
                : {
                    from: starts[Math.floor(random() * starts.length)]!,
                    to: SESSION,
                  };
            if (range.from > range.to) {
              range.from = "1997-01-02";
            }
            const service = processes[index % processes.length]!.service;
            const call =
              choice < 0.4
                ? service.getDailyPrices(security.symbol, range)
                : choice < 0.8
                  ? service.getDailyDerivedState(security.symbol, range)
                  : service
                      .getStockDetails(security.symbol, range)
                      .then((details) => details.prices);
            return call.then((rows) => ({ security, range, choice, rows }));
          });
          const settled = await Promise.allSettled(calls);
          const wallMs = Date.now() - startedAt;
          loopDelay.disable();
          const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [String(result.reason)] : [],
          );
          expect(failures).toEqual([]);

          for (const result of settled) {
            if (result.status !== "fulfilled") continue;
            const { security, range, choice, rows } = result.value;
            expect(rows).toEqual(
              choice < 0.4 || choice >= 0.8
                ? await storedPrices(security.id, range)
                : await storedDerived(security.id, range),
            );
          }
          for (const security of securities) {
            expect(
              overlappingRanges(market.coverageDownloadsFor(security.symbol)),
            ).toEqual([]);
            expect(await duplicatePriceRows(security.id)).toBe(0);
          }

          const after = await commandStats();
          const measurement = {
            scenario: "cold-stress",
            callers,
            processes: processes.length,
            securities: securities.length,
            wallMs,
            providerPriceRequests: market.priceRequests.length,
            providerStatementRequests: market.statementRequests.length,
            redisCalls: after.total - before.total,
            redisPexpire: after.pexpire - before.pexpire,
            redisEvalsha: after.evalsha - before.evalsha,
            // All four "processes" share this test's one event loop, so this is an upper bound
            // on what one real process would see.
            eventLoopDelayMaxMs: Math.round(loopDelay.max / 1e6),
            eventLoopDelayP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
          };
          if (REPORT_FILE) {
            appendFileSync(REPORT_FILE, `${JSON.stringify(measurement)}\n`);
          }
        } finally {
          await Promise.all(processes.map((process) => process.close()));
        }
      }, 300_000);
    }
  });

  /**
   * Server-wide command counters. Lua-issued commands (`PEXPIRE` inside a script) are counted too,
   * which is what makes the TTL-registration cost visible; another client using the same Redis at
   * the same time would be counted as well, so the numbers are a measurement, never an assertion.
   */
  async function commandStats(): Promise<{
    total: number;
    pexpire: number;
    evalsha: number;
  }> {
    const info = await admin.info("commandstats");
    let total = 0;
    let pexpire = 0;
    let evalsha = 0;
    for (const line of info.split("\n")) {
      const match = /^cmdstat_([a-z|]+):calls=(\d+)/.exec(line.trim());
      if (!match) continue;
      const calls = Number(match[2]);
      total += calls;
      if (match[1] === "pexpire") pexpire = calls;
      if (match[1] === "evalsha" || match[1] === "eval") evalsha += calls;
    }
    return { total, pexpire, evalsha };
  }
});
