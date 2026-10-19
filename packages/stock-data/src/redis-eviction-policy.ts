/**
 * Whether the Redis this process talks to can evict what the product relies on staying resident
 * (`docs/decisions/etf-market-data-v1.md`, "Redis eviction policy").
 *
 * The application's own count-bounded LRU decides which ordinary stocks are resident, and it never
 * touches the protected stock tier (`docs/decisions/stock-cache-tiers-v1.md`) or the benchmark
 * namespace. Redis's server-side `maxmemory-policy` is a different mechanism, outside the
 * application, and an `allkeys-*` policy may evict **any** key once memory is full: a protected
 * universe security's chunk or a committed benchmark head — which carry no TTL precisely because
 * they must stay — a hydration lock, or the provider gate's shared cooldown. A TTL-free key is no
 * protection against it, and neither is a key prefix. Nothing would fail loudly; the residency
 * guarantee would simply stop holding.
 *
 * So the policy is read (`INFO memory`, which managed services permit where `CONFIG GET` is often
 * refused) and judged:
 *
 * - `SAFE` — `noeviction`, or no memory limit at all, so Redis never evicts;
 * - `TOLERATED` — a `volatile-*` policy: only keys with a TTL can be evicted, and no committed
 *   projection key has one — no protected-tier key ever has one, even mid-hydration — but a lock,
 *   a rate-limit counter or an ordinary stock's in-flight hydration may still go under pressure;
 * - `ACCEPTED` — an `allkeys-*` policy the operator named in `REDIS_ACCEPTED_EVICTION_POLICY`;
 * - `UNSAFE` — any other `allkeys-*` policy. Readiness refuses it;
 * - `UNKNOWN` — the policy could not be read. Reported, never treated as a failure.
 */

export type RedisEvictionVerdict =
  "SAFE" | "TOLERATED" | "ACCEPTED" | "UNSAFE" | "UNKNOWN";

export type RedisEvictionAssessment = {
  verdict: RedisEvictionVerdict;
  policy?: string;
  /** `maxmemory` in bytes; 0 means no limit. */
  maxmemoryBytes?: number;
  detail: string;
};

function field(info: string, name: string): string | undefined {
  for (const line of info.split(/\r?\n/)) {
    if (line.startsWith(`${name}:`)) {
      return line.slice(name.length + 1).trim();
    }
  }
  return undefined;
}

/** Judges an `INFO memory` reply. Pure. */
export function assessRedisEvictionPolicy(
  info: string,
  options: { acceptedPolicy?: string } = {},
): RedisEvictionAssessment {
  const policy = field(info, "maxmemory_policy");
  const rawLimit = field(info, "maxmemory");
  const maxmemoryBytes =
    rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number(rawLimit)
      : undefined;
  const base = {
    ...(policy !== undefined ? { policy } : {}),
    ...(maxmemoryBytes !== undefined ? { maxmemoryBytes } : {}),
  };
  if (policy === undefined) {
    return {
      verdict: "UNKNOWN",
      ...base,
      detail: "INFO memory did not report maxmemory_policy",
    };
  }
  if (policy === "noeviction") {
    return {
      verdict: "SAFE",
      ...base,
      detail: "noeviction: Redis refuses writes rather than evicting a key",
    };
  }
  if (maxmemoryBytes === 0) {
    return {
      verdict: "SAFE",
      ...base,
      detail: `${policy} with no maxmemory limit: Redis never evicts; size the host's memory for it`,
    };
  }
  if (policy.startsWith("volatile-")) {
    return {
      verdict: "TOLERATED",
      ...base,
      detail: `${policy}: committed projections and the protected stock tier carry no TTL and are never evicted, but locks and counters with a TTL may be; noeviction is the supported policy`,
    };
  }
  if (policy.startsWith("allkeys-")) {
    if (options.acceptedPolicy === policy) {
      return {
        verdict: "ACCEPTED",
        ...base,
        detail: `${policy} accepted by REDIS_ACCEPTED_EVICTION_POLICY: any key may be evicted, so neither the protected stock tier nor benchmark residency is guaranteed`,
      };
    }
    return {
      verdict: "UNSAFE",
      ...base,
      detail: `${policy}: Redis may evict any key, including the protected stock tier, the always-resident benchmark histories, hydration locks and the provider gate's cooldown. Set maxmemory-policy noeviction, or name the policy in REDIS_ACCEPTED_EVICTION_POLICY to accept that`,
    };
  }
  return {
    verdict: "UNKNOWN",
    ...base,
    detail: `unrecognized policy ${policy}`,
  };
}

/** Reads and judges the policy. A Redis that refuses `INFO` yields `UNKNOWN`, not an error. */
export async function inspectRedisEvictionPolicy(
  redis: { info(section: "memory"): Promise<string> },
  options: { acceptedPolicy?: string } = {},
): Promise<RedisEvictionAssessment> {
  try {
    return assessRedisEvictionPolicy(await redis.info("memory"), options);
  } catch (err) {
    return {
      verdict: "UNKNOWN",
      detail: `INFO memory failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
