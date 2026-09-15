import type { getRateLimitConfig } from "@intrinsic/config";

export type RateLimitRuntimeConfig = ReturnType<typeof getRateLimitConfig>;

/**
 * The rate limiter's own Redis connection.
 *
 * Deliberately a second connection to the **same** Redis instance rather than a share of the
 * stock-data client, and never a second Redis provider. Two reasons, both operational:
 *
 * - a limiter check must not wait behind a stock-data pipeline's `MGET` of a decade of chunks on
 *   the same command queue;
 * - it needs opposite connection semantics. Stock data queues commands while reconnecting because
 *   its callers can afford to wait; a limiter must be told "no" instantly, so this client sets
 *   `enableOfflineQueue: false`.
 */
export const RATE_LIMIT_REDIS = Symbol("RATE_LIMIT_REDIS");
export const RATE_LIMIT_CONFIG = Symbol("RATE_LIMIT_CONFIG");
export const RATE_LIMIT_LOGGER = Symbol("RATE_LIMIT_LOGGER");
