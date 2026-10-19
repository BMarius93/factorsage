import type { Redis } from "ioredis";

/**
 * How a Redis-backed suite leaves the shared instance as it found it.
 *
 * Suites isolate themselves by writing under a namespace of their own
 * (`ai/workflows/validation.md`): nothing is ever flushed, so what a suite does not delete stays.
 * Committed projections carry no expiry by design, which makes a suite that forgets its teardown a
 * permanent leak — `benchmark-retention` left about 5,500 keys and 184 MB in one development Redis
 * that way before anybody looked.
 *
 * `deleteRedisNamespace` is the teardown; `leakedRedisKeys` is what the package's global teardown
 * uses to fail a run that left anything behind.
 */

/**
 * Where the product itself keeps keys. A suite may never name one of these, or anything above or
 * below it, as "its" namespace: on a developer's machine the same Redis holds the development
 * stack's data, and a teardown must not be able to reach it whatever it is handed.
 */
export const PRODUCT_REDIS_ROOTS = [
  "stock-data:v2:security",
  "stock-data:v2:symbol",
  "stock-data:v2:resident-stocks",
  "stock-data:v2:access-sequence",
  "stock-data:v2:protected-stocks",
  "stock-data:v2:fmp",
  "stock-data:load",
  "benchmark:v1",
  "rate-limit:v1",
  "rate-limit:e2e",
] as const;

const SCAN_COUNT = 1_000;
const UNLINK_BATCH = 500;

function isAtOrBelow(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}:`);
}

/** Whether `key` belongs to the product rather than to a suite. */
export function isProductRedisKey(key: string): boolean {
  return PRODUCT_REDIS_ROOTS.some((root) => isAtOrBelow(key, root));
}

/** Throws unless `namespace` is one a suite may own: specific, and nowhere near a product root. */
export function assertSuiteRedisNamespace(namespace: string): void {
  const segments = namespace.split(":");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new Error(
      `'${namespace}' is not a suite namespace: it needs at least two non-empty segments`,
    );
  }
  for (const root of PRODUCT_REDIS_ROOTS) {
    if (isAtOrBelow(namespace, root) || isAtOrBelow(root, namespace)) {
      throw new Error(
        `'${namespace}' overlaps the product's '${root}' keys and is never a suite's to delete`,
      );
    }
  }
}

/** `value` as a literal inside a Redis glob pattern. */
function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, "\\$&");
}

async function scan(redis: Redis, pattern?: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] =
      pattern === undefined
        ? await redis.scan(cursor, "COUNT", SCAN_COUNT)
        : await redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  // A scan may report a key twice while the keyspace changes under it.
  return [...new Set(keys)];
}

/** Every key at or below `namespace` — never a sibling that merely shares its spelling. */
export async function redisKeysUnder(
  redis: Redis,
  namespace: string,
): Promise<string[]> {
  assertSuiteRedisNamespace(namespace);
  const keys = await scan(redis, `${escapeGlob(namespace)}*`);
  return keys.filter((key) => isAtOrBelow(key, namespace)).sort();
}

/**
 * Deletes everything a suite wrote under its namespace and returns how many keys went.
 *
 * `SCAN` and `UNLINK`, so a large namespace never blocks the instance another process is using.
 */
export async function deleteRedisNamespace(
  redis: Redis,
  namespace: string,
): Promise<number> {
  const keys = await redisKeysUnder(redis, namespace);
  for (let offset = 0; offset < keys.length; offset += UNLINK_BATCH) {
    await redis.unlink(...keys.slice(offset, offset + UNLINK_BATCH));
  }
  return keys.length;
}

/** The keys outside the product's own roots: what suites, and only suites, write. */
export async function suiteRedisKeys(redis: Redis): Promise<Set<string>> {
  return new Set((await scan(redis)).filter((key) => !isProductRedisKey(key)));
}

/**
 * The keys a run left behind: present now, absent in `before`, outside the product's roots and
 * with no expiry of their own. A key that expires is not a leak — an abandoned hydration marker
 * or a rate-limit window is meant to outlive its test and then go.
 */
export async function leakedRedisKeys(
  redis: Redis,
  before: ReadonlySet<string>,
): Promise<string[]> {
  const leaked: string[] = [];
  for (const key of await suiteRedisKeys(redis)) {
    if (before.has(key)) {
      continue;
    }
    // -1: the key exists and never expires. -2 (gone since the scan) and a positive TTL are fine.
    if ((await redis.ttl(key)) === -1) {
      leaked.push(key);
    }
  }
  return leaked.sort();
}

/** `leaked`, grouped by the namespace a reader would recognise, largest first. */
export function describeLeakedRedisKeys(leaked: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of leaked) {
    const namespace = key
      .split(":")
      .slice(0, 3)
      .join(":")
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "<id>",
      );
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([namespace, count]) => `${namespace} (${count})`)
    .join(", ");
}
