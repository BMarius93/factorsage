import { Redis } from "ioredis";
import type { RedisCacheClient } from "./cache.js";

/**
 * The one Redis client a process uses for the stock-data cache, the hydration lock and the
 * provider gate.
 *
 * `onError` receives every connection-level error the client emits. Without a listener ioredis
 * prints "[ioredis] Unhandled error event" to stderr on each reconnect attempt — an unstructured
 * line no log query finds — so every composition root passes its structured logger here and a
 * Redis outage shows up as `stock-data.redis.error` beside the operation it broke.
 */
export function createStockDataRedisClient(
  url: string,
  onError?: (error: Error) => void,
): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  if (onError) {
    redis.on("error", onError);
  }
  return redis;
}

export class IoredisCacheClient implements RedisCacheClient {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    return this.redis.mget(...keys);
  }

  set(key: string, value: string): Promise<unknown> {
    return this.redis.set(key, value);
  }

  sadd(key: string, ...members: string[]): Promise<unknown> {
    return this.redis.sadd(key, ...members);
  }

  smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  zadd(key: string, score: number, member: string): Promise<unknown> {
    return this.redis.zadd(key, score, member);
  }

  zcard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const result: unknown = await this.redis.call(
      "ZRANGE",
      key,
      String(start),
      String(stop),
    );
    if (
      !Array.isArray(result) ||
      result.some((value) => typeof value !== "string")
    ) {
      throw new Error("Redis returned an invalid ZRANGE response");
    }
    return result as string[];
  }

  zscore(key: string, member: string): Promise<string | null> {
    return this.redis.zscore(key, member);
  }

  zrem(key: string, ...members: string[]): Promise<unknown> {
    return this.redis.zrem(key, ...members);
  }

  del(...keys: string[]): Promise<unknown> {
    return this.redis.del(...keys);
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown> {
    return this.redis.call("EVAL", script, String(numberOfKeys), ...args);
  }
}
