import { randomUUID } from "node:crypto";
import { FmpTransientError, type FmpRequestGate } from "@intrinsic/fmp";
import type { Redis } from "ioredis";

export type RedisFmpRequestGateOptions = {
  maxConcurrentRequests: number;
  rateLimitPerWindow: number;
  rateWindowMs: number;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  requestLeaseMs: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  namespace?: string;
};

const ACQUIRE_START = `
-- acquire-start
local cooldown = redis.call('PTTL', KEYS[3])
if cooldown > 0 then return {0, cooldown} end

local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(first[2]) - now)}
end

local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current >= tonumber(ARGV[2]) then
  return {0, math.max(1, redis.call('PTTL', KEYS[2]))}
end

redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), ARGV[5])
current = redis.call('INCR', KEYS[2])
if current == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
return {1, 0}
`;

const PUBLISH_COOLDOWN = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local proposed = now + tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if proposed > current then
  redis.call('PSETEX', KEYS[1], ARGV[1], tostring(proposed))
  return proposed
end
return current
`;

export class RedisFmpRequestGate implements FmpRequestGate {
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly namespace: string;
  private waiting = 0;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisFmpRequestGateOptions,
  ) {
    for (const [name, value] of Object.entries({
      maxConcurrentRequests: options.maxConcurrentRequests,
      rateLimitPerWindow: options.rateLimitPerWindow,
      rateWindowMs: options.rateWindowMs,
      maxQueueDepth: options.maxQueueDepth,
      maxQueueWaitMs: options.maxQueueWaitMs,
      requestLeaseMs: options.requestLeaseMs,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.namespace = options.namespace ?? "stock-data:v2:fmp";
  }

  async run<T>(request: () => Promise<T>): Promise<T> {
    if (this.waiting >= this.options.maxQueueDepth) {
      throw new FmpTransientError();
    }
    this.waiting += 1;
    const deadline = this.now() + this.options.maxQueueWaitMs;
    const token = randomUUID();
    try {
      while (true) {
        await this.waitForCooldown(deadline);
        await this.acquireStart(token, deadline);
        try {
          return await request();
        } finally {
          await this.redis.zrem(this.concurrentKey(), token);
        }
      }
    } finally {
      this.waiting -= 1;
    }
  }

  async publishCooldown(delayMs: number): Promise<void> {
    const providerDelayMs = Math.max(Math.ceil(delayMs), 1);
    await this.redis.eval(
      PUBLISH_COOLDOWN,
      1,
      this.cooldownKey(),
      String(providerDelayMs),
    );
  }

  private async acquireStart(token: string, deadline: number): Promise<void> {
    while (true) {
      this.assertBeforeDeadline(deadline, this.now());
      const result = asNumberPair(
        await this.redis.eval(
          ACQUIRE_START,
          3,
          this.concurrentKey(),
          this.rateKey(),
          this.cooldownKey(),
          String(this.options.maxConcurrentRequests),
          String(this.options.rateLimitPerWindow),
          String(this.options.rateWindowMs),
          String(this.options.requestLeaseMs),
          token,
        ),
      );
      if (result[0] === 1) {
        return;
      }
      await this.boundedSleep(result[1], deadline);
    }
  }

  private async waitForCooldown(deadline: number): Promise<void> {
    while (true) {
      const remaining = await this.redis.pttl(this.cooldownKey());
      if (remaining <= 0) {
        return;
      }
      await this.boundedSleep(remaining, deadline);
    }
  }

  private async boundedSleep(delayMs: number, deadline: number): Promise<void> {
    const jitter = Math.floor(this.random() * 25);
    const delay = Math.max(1, delayMs) + jitter;
    if (this.now() + delay > deadline) {
      throw new FmpTransientError();
    }
    await this.sleep(delay);
  }

  private assertBeforeDeadline(deadline: number, now: number): void {
    if (now >= deadline) {
      throw new FmpTransientError();
    }
  }

  private concurrentKey(): string {
    return `${this.namespace}:concurrent`;
  }

  private rateKey(): string {
    return `${this.namespace}:rate-window`;
  }

  private cooldownKey(): string {
    return `${this.namespace}:cooldown-until`;
  }
}

function asNumberPair(value: unknown): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => typeof entry === "number")
  ) {
    throw new Error("Redis returned an invalid limiter response");
  }
  return value as [number, number];
}
