import type { Redis } from "ioredis";
import Redlock from "redlock";

export type LoadLease = {
  assertOwned(): void;
};

export interface LoadCoordinator {
  run<T>(resource: string, work: (lease: LoadLease) => Promise<T>): Promise<T>;
}

export class InMemoryLoadCoordinator implements LoadCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    resource: string,
    work: (lease: LoadLease) => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(resource) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(resource, current);
    await previous;
    try {
      return await work({ assertOwned: () => {} });
    } finally {
      release();
      if (this.tails.get(resource) === current) {
        this.tails.delete(resource);
      }
    }
  }
}

export class RedlockLoadCoordinator implements LoadCoordinator {
  private readonly redlock: Redlock;
  private readonly lockDurationMs: number;

  constructor(
    redis: Redis,
    options: {
      lockDurationMs?: number;
      lockWaitMs?: number;
      retryDelayMs?: number;
    } = {},
  ) {
    const lockDurationMs = options.lockDurationMs ?? 30_000;
    const lockWaitMs = options.lockWaitMs ?? 120_000;
    const retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isInteger(lockDurationMs) || lockDurationMs < 1_000) {
      throw new Error("lockDurationMs must be an integer of at least 1000ms");
    }
    if (!Number.isInteger(lockWaitMs) || lockWaitMs <= 0) {
      throw new Error("lockWaitMs must be a positive integer");
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs <= 0) {
      throw new Error("retryDelayMs must be a positive integer");
    }
    this.lockDurationMs = lockDurationMs;
    this.redlock = new Redlock([redis], {
      retryCount: Math.max(0, Math.ceil(lockWaitMs / retryDelayMs) - 1),
      retryDelay: retryDelayMs,
      retryJitter: 0,
      automaticExtensionThreshold: Math.min(
        5_000,
        Math.floor(lockDurationMs / 2),
      ),
    });
  }

  async run<T>(
    resource: string,
    work: (lease: LoadLease) => Promise<T>,
  ): Promise<T> {
    return this.redlock.using(
      [`stock-data:load:${resource}`],
      this.lockDurationMs,
      async (signal) => {
        const lease = {
          assertOwned(): void {
            if (signal.aborted) {
              throw signal.error ?? new Error("Stock-data load lock was lost");
            }
          },
        };
        lease.assertOwned();
        return work(lease);
      },
    );
  }
}
