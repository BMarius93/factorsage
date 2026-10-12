import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStockDataRedisClient } from "./redis-client.js";
import {
  assertSuiteRedisNamespace,
  deleteRedisNamespace,
  describeLeakedRedisKeys,
  isProductRedisKey,
  leakedRedisKeys,
  redisKeysUnder,
  suiteRedisKeys,
} from "./redis-namespace.test-helper.js";

/**
 * The teardown every Redis-backed suite relies on, and the check that fails a run which skipped it.
 *
 * Both run against a Redis that, on a developer's machine, also holds the development stack's
 * data. What matters most here is therefore what they refuse to touch.
 */

loadRootEnv();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Redis namespace tests require TEST_REDIS_URL or REDIS_URL: they prove the suites' teardown " +
      "deletes its own keys and nothing else.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

describe("suite namespaces", () => {
  it("accepts the namespaces the suites use", () => {
    for (const namespace of [
      "benchmark:retention:3f0c1c9e-6f0e-4a0b-9d39-1f9f1f6f2a11",
      "benchmark:test:1A2B3C4D",
      "stock-data:v2:test:service:3f0c1c9e-6f0e-4a0b-9d39-1f9f1f6f2a11",
      "stock-data:v2:retention:3f0c1c9e",
      "rate-limit:test:3f0c1c9e",
    ]) {
      expect(() => assertSuiteRedisNamespace(namespace)).not.toThrow();
    }
  });

  it("refuses the product's own key roots, and anything above or below them", () => {
    for (const namespace of [
      // The roots themselves.
      "benchmark:v1",
      "stock-data:v2:security",
      "stock-data:load",
      "rate-limit:v1",
      // Below a root: one security's keys, one series' projection, one lock.
      "stock-data:v2:security:9b2f",
      "benchmark:v1:benchmark:9b2f",
      "stock-data:load:hydrate:9b2f",
      // Above a root: deleting these would take the root with them.
      "stock-data:v2",
      "benchmark",
      "stock-data",
      "rate-limit",
    ]) {
      expect(() => assertSuiteRedisNamespace(namespace)).toThrow();
    }
  });

  it("refuses a namespace too vague to belong to one suite", () => {
    for (const namespace of ["", "test", "suite:", ":suite", "a::b"]) {
      expect(() => assertSuiteRedisNamespace(namespace)).toThrow(
        "is not a suite namespace",
      );
    }
  });

  it("tells a product key from a suite key", () => {
    expect(isProductRedisKey("benchmark:v1:benchmark:9b2f:head")).toBe(true);
    expect(isProductRedisKey("stock-data:v2:security:9b2f:keys")).toBe(true);
    expect(isProductRedisKey("stock-data:v2:resident-stocks")).toBe(true);
    expect(isProductRedisKey("stock-data:v2:fmp:concurrent")).toBe(true);
    expect(isProductRedisKey("stock-data:load:hydrate:9b2f")).toBe(true);
    expect(isProductRedisKey("rate-limit:e2e:auth-sensitive:ip:::1")).toBe(
      true,
    );
    expect(isProductRedisKey("benchmark:retention:9b2f:benchmark:1:head")).toBe(
      false,
    );
    expect(isProductRedisKey("stock-data:v2:test:service:9b2f:keys")).toBe(
      false,
    );
    // A spelling that only begins like a root is not under it.
    expect(isProductRedisKey("benchmark:v10:head")).toBe(false);
    expect(isProductRedisKey("stock-data:v2:security-audit:1")).toBe(false);
  });

  it("names what leaked by namespace, largest first", () => {
    expect(
      describeLeakedRedisKeys([
        "benchmark:retention:3f0c1c9e-6f0e-4a0b-9d39-1f9f1f6f2a11:benchmark:1:head",
        "benchmark:retention:3f0c1c9e-6f0e-4a0b-9d39-1f9f1f6f2a11:benchmark:1:chunks",
        "stock-data:v2:test:service:1:access-sequence",
      ]),
    ).toBe("benchmark:retention:<id> (2), stock-data:v2:test (1)");
  });
});

describeRedis("Redis namespace teardown", () => {
  const suffix = randomUUID();
  const root = `stock-data:v2:test:namespace-teardown:${suffix}`;
  const redis = createStockDataRedisClient(
    redisUrl ?? "redis://localhost:6379",
  );

  beforeAll(async () => {
    await redis.ping();
  });

  afterAll(async () => {
    try {
      await deleteRedisNamespace(redis, root);
      expect(await redisKeysUnder(redis, root)).toEqual([]);
    } finally {
      redis.disconnect();
    }
  });

  it("deletes every key at or below a namespace, whatever its type, and nothing beside it", async () => {
    const namespace = `${root}:own`;
    // Shares the namespace's spelling without being below it.
    const sibling = `${root}:own-and-more`;
    await redis.set(namespace, "the namespace itself");
    await redis.set(`${namespace}:head`, "{}");
    await redis.set(`${namespace}:benchmark:1:daily-price:v1:2026:abc`, "{}");
    await redis.sadd(`${namespace}:chunks`, "a", "b");
    await redis.zadd(`${namespace}:resident-stocks`, 1, "security");
    await redis.set(`${sibling}:head`, "{}");

    expect(await redisKeysUnder(redis, namespace)).toEqual(
      [
        namespace,
        `${namespace}:benchmark:1:daily-price:v1:2026:abc`,
        `${namespace}:chunks`,
        `${namespace}:head`,
        `${namespace}:resident-stocks`,
      ].sort(),
    );
    await expect(deleteRedisNamespace(redis, namespace)).resolves.toBe(5);

    expect(await redisKeysUnder(redis, namespace)).toEqual([]);
    expect(await redis.get(`${sibling}:head`)).toBe("{}");
    // Nothing left to delete is not an error.
    await expect(deleteRedisNamespace(redis, namespace)).resolves.toBe(0);
  });

  it("reads a namespace literally when it holds pattern characters", async () => {
    const namespace = `${root}:a*b[c]?`;
    // What that spelling would match as a pattern.
    const decoy = `${root}:aXXbcZ`;
    await redis.set(`${namespace}:head`, "{}");
    await redis.set(`${decoy}:head`, "{}");

    await expect(deleteRedisNamespace(redis, namespace)).resolves.toBe(1);

    expect(await redis.exists(`${namespace}:head`)).toBe(0);
    expect(await redis.get(`${decoy}:head`)).toBe("{}");
  });

  it("deletes a namespace larger than one batch", async () => {
    const namespace = `${root}:large`;
    const pipeline = redis.pipeline();
    for (let index = 0; index < 1_250; index += 1) {
      pipeline.set(`${namespace}:daily-price:${index}`, "x");
    }
    await pipeline.exec();

    await expect(deleteRedisNamespace(redis, namespace)).resolves.toBe(1_250);
    expect(await redisKeysUnder(redis, namespace)).toEqual([]);
  });

  it("refuses to scan or delete at a product root", async () => {
    await expect(redisKeysUnder(redis, "benchmark:v1")).rejects.toThrow(
      "is never a suite's to delete",
    );
    await expect(
      deleteRedisNamespace(redis, "stock-data:v2:security"),
    ).rejects.toThrow("is never a suite's to delete");
    await expect(deleteRedisNamespace(redis, "stock-data:v2")).rejects.toThrow(
      "is never a suite's to delete",
    );
  });

  it("reports the keys a run left behind for good, and only those", async () => {
    const namespace = `${root}:leak`;
    await redis.set(`${namespace}:there-before`, "x");
    const before = await suiteRedisKeys(redis);
    expect(before.has(`${namespace}:there-before`)).toBe(true);

    await redis.set(`${namespace}:head`, "{}");
    await redis.sadd(`${namespace}:chunks`, "a");
    // Meant to outlive its test and then go: an abandoned hydration marker, a rate-limit window.
    await redis.set(`${namespace}:hydrating`, "x", "PX", 60_000);

    const leaked = await leakedRedisKeys(redis, before);

    expect(leaked.filter((key) => key.startsWith(`${namespace}:`))).toEqual([
      `${namespace}:chunks`,
      `${namespace}:head`,
    ]);
    // And once the suite has cleaned up after itself, nothing.
    await deleteRedisNamespace(redis, namespace);
    expect(
      (await leakedRedisKeys(redis, before)).filter((key) =>
        key.startsWith(`${namespace}:`),
      ),
    ).toEqual([]);
  });
});
