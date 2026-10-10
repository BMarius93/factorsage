import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  FmpClient,
  FmpRequestBudgetExhaustedError,
  FmpSecurityScope,
} from "@intrinsic/fmp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RedisFmpRequestGate } from "./fmp-gate.js";
import { RedisFmpRequestBudget } from "./fmp-request-budget.js";
import { createStockDataRedisClient } from "./redis-client.js";

loadRootEnv();

/**
 * The request budget against a real Redis, because atomicity is a property of the script running
 * there and nothing a fake can demonstrate.
 *
 * The same Redis requirement as `redis.integration.test.ts`, stated the same way: a developer
 * without `pnpm infra:up` skips it, CI may not.
 */
const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "The FMP request-budget tests require TEST_REDIS_URL or REDIS_URL. CI must not skip them " +
      "silently: they are the only proof that concurrent callers cannot overshoot a budget.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("Redis FMP request budget", () => {
  const namespace = `stock-data:v2:test:${randomUUID()}:fmp`;
  const redisA = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const redisB = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );
  const runIds: string[] = [];

  const newRun = (): string => {
    const runId = randomUUID();
    runIds.push(runId);
    return runId;
  };

  beforeAll(async () => {
    await redisA.ping();
    await redisB.ping();
  });

  afterAll(async () => {
    await redisA.del(
      ...runIds.map((runId) => `${namespace}:budget:${runId}`),
      `${namespace}:concurrent`,
      `${namespace}:rate-window`,
      `${namespace}:cooldown-until`,
    );
    redisA.disconnect();
    redisB.disconnect();
  });

  it("takes one unit at a time and refuses the request after the last", async () => {
    const budget = new RedisFmpRequestBudget(redisA, {
      runId: newRun(),
      limit: 3,
      namespace,
    });
    expect(await budget.used()).toBe(0);
    expect(await budget.consume()).toBe(1);
    expect(await budget.consume()).toBe(2);
    expect(await budget.consume()).toBe(3);
    await expect(budget.consume()).rejects.toBeInstanceOf(
      FmpRequestBudgetExhaustedError,
    );
    await expect(budget.consume()).rejects.toMatchObject({ limit: 3 });
    // A refusal takes nothing: the counter stops at the limit however often it is asked.
    expect(await budget.used()).toBe(3);
  });

  it("cannot be overshot by concurrent callers on separate connections", async () => {
    const runId = newRun();
    const limit = 25;
    const budgets = [redisA, redisB].map(
      (redis) => new RedisFmpRequestBudget(redis, { runId, limit, namespace }),
    );

    const settled = await Promise.allSettled(
      Array.from({ length: 200 }, (_, index) =>
        (budgets[index % 2] as RedisFmpRequestBudget).consume(),
      ),
    );
    const granted = settled
      .filter(
        (result): result is PromiseFulfilledResult<number> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    const refused = settled.filter((result) => result.status === "rejected");

    expect(granted).toHaveLength(limit);
    // Every unit was handed out exactly once: 1..limit with no number repeated.
    expect([...granted].sort((left, right) => left - right)).toEqual(
      Array.from({ length: limit }, (_, index) => index + 1),
    );
    expect(refused).toHaveLength(200 - limit);
    for (const result of refused) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        FmpRequestBudgetExhaustedError,
      );
    }
    expect(await budgets[0]?.used()).toBe(limit);
  });

  it("keeps one budget per run", async () => {
    const first = new RedisFmpRequestBudget(redisA, {
      runId: newRun(),
      limit: 1,
      namespace,
    });
    const second = new RedisFmpRequestBudget(redisA, {
      runId: newRun(),
      limit: 1,
      namespace,
    });
    await first.consume();
    await expect(first.consume()).rejects.toBeInstanceOf(
      FmpRequestBudgetExhaustedError,
    );
    // Another run's budget is untouched by the first one's exhaustion.
    expect(await second.consume()).toBe(1);
  });

  it("expires on its own and can be removed", async () => {
    const runId = newRun();
    const budget = new RedisFmpRequestBudget(redisA, {
      runId,
      limit: 5,
      ttlMs: 60_000,
      namespace,
    });
    await budget.consume();
    const ttl = await redisA.pttl(`${namespace}:budget:${runId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);

    await budget.dispose();
    expect(await redisA.exists(`${namespace}:budget:${runId}`)).toBe(0);
    expect(await budget.used()).toBe(0);
  });

  it("lives under the provider gate's namespace", async () => {
    const runId = newRun();
    await new RedisFmpRequestBudget(redisA, { runId, limit: 1 }).consume();
    // The default, as a live run uses it: beside the gate's own keys, not in a namespace of its own.
    expect(await redisA.exists(`stock-data:v2:fmp:budget:${runId}`)).toBe(1);
    await redisA.del(`stock-data:v2:fmp:budget:${runId}`);
  });

  it.each([
    [{ runId: "short", limit: 5 }, /runId/],
    [{ runId: "has spaces in it", limit: 5 }, /runId/],
    [{ runId: randomUUID(), limit: 0 }, /limit/],
    [{ runId: randomUUID(), limit: 1.5 }, /limit/],
    [{ runId: randomUUID(), limit: 5, ttlMs: 0 }, /ttlMs/],
  ])("refuses to be built from %j", (options, message) => {
    expect(() => new RedisFmpRequestBudget(redisA, options)).toThrowError(
      message,
    );
  });

  it("bounds a real client through the shared gate: exactly the budget is sent", async () => {
    // The whole provider path a live run uses — client, shared Redis gate, guard — with the far
    // end of the wire a function. Sixty requests, all in flight at once, race for twelve units.
    const limit = 12;
    const requests = 60;
    const budget = new RedisFmpRequestBudget(redisB, {
      runId: newRun(),
      limit,
      namespace,
    });
    const scope = new FmpSecurityScope(["AAPL", "MSFT", "NVDA"], {
      maxSecurities: 3,
    });
    for (const symbol of scope.symbols) {
      scope.bind({ securityId: `security-${symbol}`, providerSymbol: symbol });
    }
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return new Response("[]", { status: 200 });
    });
    const client = new FmpClient(
      () => ({ apiKey: "test-secret-key", timeoutMs: 1_000, maxRetries: 0 }),
      fetchMock,
      {
        // Wide enough that nothing queues: every request holds a slot at the same moment, which
        // is the hardest case for the budget. A window that outlives the test, so the gate's own
        // count of what it admitted can be read afterwards.
        gate: new RedisFmpRequestGate(redisA, {
          maxConcurrentRequests: requests,
          rateLimitPerWindow: 1_000,
          rateWindowMs: 60_000,
          maxQueueDepth: 1_000,
          maxQueueWaitMs: 20_000,
          requestLeaseMs: 5_000,
          namespace,
        }),
        guard: {
          authorize: (request) => scope.authorize(request),
          admitAttempt: async () => {
            await budget.consume();
          },
        },
      },
    );

    const settled = await Promise.allSettled(
      Array.from({ length: requests }, (_, index) =>
        client.getStockSplits(
          ["AAPL", "MSFT", "NVDA"][index % 3] as string,
          "security",
        ),
      ),
    );

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(limit);
    expect(fetchMock).toHaveBeenCalledTimes(limit);
    expect(await budget.used()).toBe(limit);
    for (const result of settled) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(FmpRequestBudgetExhaustedError);
      }
    }
    // The budget sits on top of the shared gate, not beside it: every one of the sixty requests
    // was admitted by the gate and counted against its rate window, the forty-eight the budget
    // then refused included.
    expect(Number(await redisA.get(`${namespace}:rate-window`))).toBe(requests);
    expect(await redisA.zcard(`${namespace}:concurrent`)).toBe(0);
  }, 30_000);
});
