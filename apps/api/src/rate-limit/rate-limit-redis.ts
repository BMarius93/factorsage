import { Redis } from "ioredis";

/**
 * The Redis client the rate limiter uses.
 *
 * Tuned for one property the stock-data client deliberately does not have: **a command either
 * answers quickly or fails quickly.** `enableOfflineQueue: false` refuses instead of queueing
 * while the connection is down, `commandTimeout` bounds a connection that is up but not
 * answering, and one retry per request keeps a slow reconnect from multiplying the wait. The
 * service races its own timeout on top, so a failure is bounded even if this client's own bounds
 * are raised.
 *
 * `lazyConnect` keeps construction side-effect-free — a Nest module graph compiles in tests
 * without opening a socket — and the module's lifecycle hook connects explicitly at startup so the
 * first real request does not pay for the handshake.
 */
export function createRateLimitRedisClient(
  url: string,
  commandTimeoutMs: number,
  onError?: (error: Error) => void,
): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: commandTimeoutMs,
    connectTimeout: commandTimeoutMs * 4,
  });
  if (onError) {
    redis.on("error", onError);
  }
  return redis;
}
