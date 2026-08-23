import type { Redis } from "ioredis";
import Redlock from "redlock";

export interface LoadCoordinator {
  run<T>(resource: string, work: () => Promise<T>): Promise<T>;
}

export class InMemoryLoadCoordinator implements LoadCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(resource: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(resource) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(resource, current);
    await previous;
    try {
      return await work();
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
    this.redlock = new Redlock([redis], {
      retryCount: 20,
      retryDelay: 100,
      retryJitter: 50,
      automaticExtensionThreshold: 5_000,
    });
  }

  async run<T>(resource: string, work: () => Promise<T>): Promise<T> {
    return this.redlock.using(
      [`stock-data:load:${resource}`],
      this.lockDurationMs,
      async (signal) => {
        if (signal.aborted) {
          throw signal.error ?? new Error("Stock-data load lock was lost");
        }
        return work();
      },
    );
  }
}
