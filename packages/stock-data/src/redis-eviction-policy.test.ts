import { describe, expect, it } from "vitest";
import {
  assessRedisEvictionPolicy,
  inspectRedisEvictionPolicy,
} from "./redis-eviction-policy.js";

function info(policy: string, maxmemory = 2_147_483_648): string {
  return `# Memory\r\nused_memory:1024\r\nmaxmemory:${maxmemory}\r\nmaxmemory_human:2.00G\r\nmaxmemory_policy:${policy}\r\n`;
}

describe("Redis eviction policy assessment", () => {
  it("accepts noeviction", () => {
    expect(assessRedisEvictionPolicy(info("noeviction"))).toMatchObject({
      verdict: "SAFE",
      policy: "noeviction",
      maxmemoryBytes: 2_147_483_648,
    });
  });

  it("accepts any policy when there is no memory limit, since nothing is ever evicted", () => {
    expect(assessRedisEvictionPolicy(info("allkeys-lru", 0)).verdict).toBe(
      "SAFE",
    );
  });

  it("refuses every allkeys policy: a TTL-free key is no protection against it", () => {
    for (const policy of ["allkeys-lru", "allkeys-lfu", "allkeys-random"]) {
      const assessment = assessRedisEvictionPolicy(info(policy));
      expect(assessment.verdict).toBe("UNSAFE");
      expect(assessment.detail).toMatch(/benchmark/);
    }
  });

  it("lets an operator accept an allkeys policy only by naming exactly that policy", () => {
    expect(
      assessRedisEvictionPolicy(info("allkeys-lru"), {
        acceptedPolicy: "allkeys-lru",
      }).verdict,
    ).toBe("ACCEPTED");
    expect(
      assessRedisEvictionPolicy(info("allkeys-lfu"), {
        acceptedPolicy: "allkeys-lru",
      }).verdict,
    ).toBe("UNSAFE");
  });

  it("tolerates volatile policies, which never evict a key without a TTL", () => {
    expect(assessRedisEvictionPolicy(info("volatile-lru")).verdict).toBe(
      "TOLERATED",
    );
  });

  it("reports an unreadable or unknown policy without failing", async () => {
    expect(assessRedisEvictionPolicy("# Memory\r\n").verdict).toBe("UNKNOWN");
    await expect(
      inspectRedisEvictionPolicy({
        info: async () => {
          throw new Error("NOPERM");
        },
      }),
    ).resolves.toMatchObject({ verdict: "UNKNOWN" });
  });
});
