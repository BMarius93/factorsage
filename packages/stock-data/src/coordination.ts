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

  constructor(
    redis: Redis,
    private readonly lockDurationMs = 30_000,
  ) {
    if (!Number.isInteger(lockDurationMs) || lockDurationMs < 1_000) {
      throw new Error("lockDurationMs must be an integer of at least 1000ms");
    }
    this.redlock = new Redlock([redis], {
      retryCount: 20,
      retryDelay: 100,
      retryJitter: 50,
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
