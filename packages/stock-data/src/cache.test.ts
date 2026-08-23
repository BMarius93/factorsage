import { describe, expect, it } from "vitest";
import { RedisSymbolStockCache, type RedisCacheClient } from "./cache.js";
import { InMemoryLoadCoordinator } from "./coordination.js";

class FakeRedis implements RedisCacheClient {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((member) => set.add(member));
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  async zadd(key: string, score: number, member: string) {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sortedSets.set(key, set);
    return 1;
  }

  async zcard(key: string) {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  async zrange(key: string, start: number, stop: number) {
    return [...(this.sortedSets.get(key) ?? [])]
      .sort(
        (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
      )
      .slice(start, stop + 1)
      .map(([member]) => member);
  }

  async zscore(key: string, member: string) {
    const score = this.sortedSets.get(key)?.get(member);
    return score === undefined ? null : String(score);
  }

  async zrem(key: string, ...members: string[]) {
    members.forEach((member) => this.sortedSets.get(key)?.delete(member));
    return members.length;
  }

  async del(...keys: string[]) {
    keys.forEach((key) => {
      this.values.delete(key);
      this.sets.delete(key);
    });
    return keys.length;
  }
}

describe("symbol-level stock cache", () => {
  it("returns cache hits and updates LRU order", async () => {
    const redis = new FakeRedis();
    let now = 1;
    const cache = new RedisSymbolStockCache(redis, 2, "test", () => now++);
    await cache.set("AAPL", "prices", [1]);
    await cache.set("MSFT", "prices", [2]);

    expect(await cache.get<number[]>("AAPL", "prices")).toEqual([1]);
    await cache.set("GOOG", "prices", [3]);

    expect(await cache.hasResidentSymbol("AAPL")).toBe(true);
    expect(await cache.hasResidentSymbol("MSFT")).toBe(false);
    expect(await cache.hasResidentSymbol("GOOG")).toBe(true);
  });

  it("evicts every cache key for a symbol as one unit", async () => {
    const redis = new FakeRedis();
    const cache = new RedisSymbolStockCache(redis, 1, "test", () => 1);
    await cache.set("AAPL", "security", { id: "1" });
    await cache.set("AAPL", "prices:2020", [1]);
    await cache.set("MSFT", "security", { id: "2" });

    expect(await cache.get("AAPL", "security")).toBeNull();
    expect(await cache.get("AAPL", "prices:2020")).toBeNull();
    expect([...redis.values.keys()].every((key) => !key.includes("AAPL"))).toBe(
      true,
    );
  });
});

describe("load coordination", () => {
  it("serializes concurrent work for the same resource", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    let calls = 0;
    const work = async () => {
      calls += 1;
      return calls;
    };

    const first = coordinator.run("AAPL:prices", work);
    const second = coordinator.run("AAPL:prices", work);

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});
