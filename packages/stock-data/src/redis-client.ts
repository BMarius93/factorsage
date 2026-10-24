import { createHash } from "node:crypto";
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
 *
 * `maxRetriesPerRequest` is how many reconnection attempts a pending command waits through before
 * it fails. The default, 1, fails fast — within a fraction of a second of an outage — which is right
 * where a person is waiting for an answer. A batch process whose work would otherwise be lost to a
 * brief Redis restart passes more: ioredis waits 50 ms before its first attempt, doubling to at most
 * 5 s, so 30 attempts ride through about two minutes of refused connections. (A restarted Redis that
 * is still loading its snapshot accepts the connection and holds commands until it is ready, which
 * costs no attempt.)
 */
export function createStockDataRedisClient(
  url: string,
  onError?: (error: Error) => void,
  options: { maxRetriesPerRequest?: number } = {},
): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 1,
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

  mgetBuffer(...keys: string[]): Promise<Array<Buffer | null>> {
    return this.redis.mgetBuffer(...keys);
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

  scan(
    cursor: string,
    pattern: string,
    count: number,
  ): Promise<[string, string[]]> {
    return this.redis.scan(cursor, "MATCH", pattern, "COUNT", count);
  }

  /**
   * `EVALSHA` by the script's SHA-1, falling back to `EVAL` — which also loads it — when the server
   * does not know it yet (a fresh or restarted Redis, a `SCRIPT FLUSH`). The scripts are sent once
   * per server instead of with every call: a cache read touches its LRU entry through one, thousands
   * of times per backtest window. A script is idempotent per call either way, and a `NOSCRIPT` reply
   * means nothing ran.
   */
  async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | Buffer>
  ): Promise<unknown> {
    let sha = this.scriptShas.get(script);
    if (sha === undefined) {
      sha = createHash("sha1").update(script).digest("hex");
      this.scriptShas.set(script, sha);
    }
    try {
      return await this.redis.call(
        "EVALSHA",
        sha,
        String(numberOfKeys),
        ...args,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT")) {
        throw error;
      }
      return this.redis.call("EVAL", script, String(numberOfKeys), ...args);
    }
  }

  private readonly scriptShas = new Map<string, string>();
}
