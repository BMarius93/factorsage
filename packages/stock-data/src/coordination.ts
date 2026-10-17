import type { Redis } from "ioredis";
import Redlock, { type RedlockAbortSignal } from "redlock";

export type LoadLease = {
  assertOwned(): void;
};

/** How one call may differ from the coordinator's own settings. */
export type LoadRunOptions = {
  /**
   * The longest this call waits for the lock before it gives up and throws.
   *
   * Omitted, the coordinator's own wait applies. That one is sized for a hydration, which has
   * nothing better to do than wait for the hydration already running. A caller that has another
   * answer — a read that can fall back to PostgreSQL — passes a short one instead.
   */
  waitMs?: number;
};

export interface LoadCoordinator {
  run<T>(
    resource: string,
    work: (lease: LoadLease) => Promise<T>,
    options?: LoadRunOptions,
  ): Promise<T>;
}

function assertWaitMs(waitMs: number): void {
  if (!Number.isInteger(waitMs) || waitMs <= 0) {
    throw new Error("waitMs must be a positive integer");
  }
}

export class InMemoryLoadCoordinator implements LoadCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    resource: string,
    work: (lease: LoadLease) => Promise<T>,
    options: LoadRunOptions = {},
  ): Promise<T> {
    // Before a place in the queue is taken: a call refused here must leave nothing behind it.
    if (options.waitMs !== undefined) {
      assertWaitMs(options.waitMs);
    }
    const previous = this.tails.get(resource) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(resource, current);
    if (
      options.waitMs !== undefined &&
      !(await settledWithin(previous, options.waitMs))
    ) {
      // Gives its place up without letting a later caller overtake the holder: whoever queued
      // behind this call still waits for everything that was ahead of it.
      void previous.then(() => {
        release();
        if (this.tails.get(resource) === current) {
          this.tails.delete(resource);
        }
      });
      throw new Error(
        `The load lock for '${resource}' was not had within ${options.waitMs}ms`,
      );
    }
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

/** Whether `promise` settles before `waitMs` has passed. */
async function settledWithin(
  promise: Promise<void>,
  waitMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Redlock lease, Redis as the one voter.
 *
 * Two retry budgets, deliberately different, because redlock applies the **instance's** settings to
 * everything a `using` call does after acquiring — every automatic extension and the final release —
 * and only the acquisition to the settings passed per call:
 *
 * - **acquisition** waits as long as the caller can (`lockWaitMs`, or a call's own `waitMs`), in
 *   single attempts of this class's own (see `run`);
 * - **extension and release** retry only within the extension window. With the acquisition budget
 *   in the instance (120 s at 100 ms) a holder whose lease was lost kept retrying an extension that
 *   could never succeed for two minutes, its `assertOwned()` passing all the while, and then spent as
 *   long again releasing a lock it no longer held (CONC-02). Now the loss surfaces as an aborted
 *   signal before the lease would have expired.
 *
 * The automatic extension starts half a lease before expiry, so a stalled event loop (a large
 * decode, a GC pause) has half a lease, not five seconds, before the lease is lost.
 */
export class RedlockLoadCoordinator implements LoadCoordinator {
  private readonly redlock: Redlock;
  private readonly lockDurationMs: number;
  private readonly retryDelayMs: number;
  private readonly lockWaitMs: number;

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
    this.retryDelayMs = retryDelayMs;
    this.lockWaitMs = lockWaitMs;
    const extensionThresholdMs = Math.floor(lockDurationMs / 2);
    this.redlock = new Redlock([redis], {
      // Extension and release only: acquisition passes its own wait on every call below.
      retryCount: this.retryCountFor(Math.floor(extensionThresholdMs / 2)),
      retryDelay: retryDelayMs,
      retryJitter: 0,
      automaticExtensionThreshold: extensionThresholdMs,
    });
  }

  async run<T>(
    resource: string,
    work: (lease: LoadLease) => Promise<T>,
    options: LoadRunOptions = {},
  ): Promise<T> {
    const resources = [`stock-data:load:${resource}`];
    const routine = async (signal: RedlockAbortSignal): Promise<T> => {
      const lease = {
        assertOwned(): void {
          if (signal.aborted) {
            throw signal.error ?? new Error("Stock-data load lock was lost");
          }
        },
      };
      lease.assertOwned();
      return work(lease);
    };
    if (options.waitMs !== undefined) {
      assertWaitMs(options.waitMs);
    }
    const deadline = Date.now() + (options.waitMs ?? this.lockWaitMs);
    // The wait is this loop's, one single-attempt acquisition at a time, and never redlock's own
    // retries. Redlock dates a lock's expiry from the moment its acquisition *began*: a caller that
    // queued longer than one lease behind a slow hydration was handed a lock its own process
    // already counted as expired, failed its first ownership check with "Cannot extend an
    // already-expired lock" and never ran (CONC-03). Each attempt here starts its own clock.
    for (;;) {
      let acquired = false;
      try {
        return await this.redlock.using(
          resources,
          this.lockDurationMs,
          { retryCount: 0 },
          async (signal) => {
            acquired = true;
            return routine(signal);
          },
        );
      } catch (error: unknown) {
        // Before the routine ran, the only thing that can have failed is the acquisition — the lock
        // is held elsewhere, or Redis did not answer — which is retried until the wait is spent, as
        // redlock's own loop did. Anything the routine threw is the caller's.
        if (acquired || Date.now() + this.retryDelayMs > deadline) {
          throw error;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.retryDelayMs);
      });
    }
  }

  /** Attempts after the first that fit inside `waitMs` at this coordinator's retry spacing. */
  private retryCountFor(waitMs: number): number {
    return Math.max(0, Math.ceil(waitMs / this.retryDelayMs) - 1);
  }
}
