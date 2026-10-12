import { loadRootEnv } from "@intrinsic/config";
import { createStockDataRedisClient } from "./src/redis-client.js";
import {
  describeLeakedRedisKeys,
  leakedRedisKeys,
  suiteRedisKeys,
} from "./src/redis-namespace.test-helper.js";

/**
 * Fails a run that leaves keys behind in Redis.
 *
 * The suites here share one Redis with each other and, on a developer's machine, with the
 * development stack. They isolate themselves by namespace and nothing is ever flushed, so a suite
 * that does not delete what it wrote leaks it for good: a committed projection has no expiry.
 * This records the suite-owned keys before the first test and compares after the last one. Keys
 * the run created that are still there, and will never expire, are named and fail the run.
 *
 * It looks only outside the product's own key roots, so a development stack working beside the run
 * cannot trip it, and it does nothing where no Redis is configured — the Redis-backed suites skip
 * there too, and are what refuse a CI run without one.
 */
export default async function redisLeakGuard(): Promise<
  (() => Promise<void>) | void
> {
  loadRootEnv();
  const url =
    process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
  if (!url) {
    return;
  }
  const redis = createStockDataRedisClient(url);
  const before = await suiteRedisKeys(redis);

  return async () => {
    try {
      const leaked = await leakedRedisKeys(redis, before);
      if (leaked.length > 0) {
        throw new Error(
          `This run left ${leaked.length} Redis key(s) behind that will never expire, under: ` +
            `${describeLeakedRedisKeys(leaked)}. A suite deletes the namespace it wrote in its ` +
            "teardown (`deleteRedisNamespace`). First keys: " +
            leaked.slice(0, 5).join(", "),
        );
      }
    } finally {
      redis.disconnect();
    }
  };
}
