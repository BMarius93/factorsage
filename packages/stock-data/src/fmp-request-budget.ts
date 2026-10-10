import {
  FmpRequestBudgetExhaustedError,
  type FmpRequestBudget,
} from "@intrinsic/fmp";
import type { Redis } from "ioredis";

/**
 * A hard cap on the provider requests one deliberate run may send, kept in Redis.
 *
 * It is not a second gate and opens no lane of its own. `RedisFmpRequestGate` still decides when
 * every request starts and every request still spends the one shared rate allowance; this only
 * counts, and refuses the request that would be one too many. `FmpClient` spends a unit from
 * inside the gate's slot, immediately before it sends, so the count is of requests that reached
 * the network — a retry is another request and another unit, a request that timed out in the
 * gate's queue is neither.
 *
 * The check and the increment are one Lua script, so they are atomic for every client of the
 * Redis instance: however many callers race for the last unit, exactly one gets it. A counter read
 * and then written by the caller would let two of them both see "one left".
 *
 * The key sits under the gate's own namespace (`stock-data:v2:fmp:*`, `AGENTS.md` invariant 16):
 * it is transient coordination about provider traffic, keyed by run, and it expires on its own.
 */

/** Long enough for any run to finish and be inspected, short enough that nothing accumulates. */
export const FMP_REQUEST_BUDGET_TTL_MS = 6 * 60 * 60 * 1000;

const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

const CONSUME = `
-- consume-budget
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return used
`;

export type RedisFmpRequestBudgetOptions = {
  /** Names the run. Two budgets built with one id are one budget. */
  runId: string;
  limit: number;
  ttlMs?: number;
  namespace?: string;
};

export class RedisFmpRequestBudget implements FmpRequestBudget {
  readonly limit: number;
  private readonly key: string;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: Redis,
    options: RedisFmpRequestBudgetOptions,
  ) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
    if (!RUN_ID.test(options.runId)) {
      throw new Error("runId must be 8 to 64 letters, digits or hyphens");
    }
    const ttlMs = options.ttlMs ?? FMP_REQUEST_BUDGET_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be a positive integer");
    }
    this.limit = options.limit;
    this.ttlMs = ttlMs;
    this.key = `${options.namespace ?? "stock-data:v2:fmp"}:budget:${options.runId}`;
  }

  async consume(): Promise<number> {
    const used: unknown = await this.redis.eval(
      CONSUME,
      1,
      this.key,
      String(this.limit),
      String(this.ttlMs),
    );
    if (typeof used !== "number" || !Number.isInteger(used)) {
      throw new Error("Redis returned an invalid budget response");
    }
    if (used < 0) {
      throw new FmpRequestBudgetExhaustedError(this.limit);
    }
    return used;
  }

  async used(): Promise<number> {
    const raw = await this.redis.get(this.key);
    const used = raw === null ? 0 : Number(raw);
    if (!Number.isInteger(used) || used < 0) {
      throw new Error("Redis holds an invalid budget counter");
    }
    return used;
  }

  /** Removes the counter. A finished run leaves nothing behind; a crashed one expires. */
  async dispose(): Promise<void> {
    await this.redis.del(this.key);
  }
}
