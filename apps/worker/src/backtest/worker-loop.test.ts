import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import {
  BacktestInterruptedError,
  type BacktestJobLease,
} from "./job-lease.js";
import type {
  BacktestJobRepository,
  ClaimedBacktestJob,
  StaleJobRecovery,
} from "./job-repository.js";
import {
  BacktestWorkerLoop,
  type BacktestJobProcessor,
} from "./worker-loop.js";

const WORKER_ID = "worker-under-test";

const logger = createLogger({ service: "worker", level: "silent" });

const CLAIM: ClaimedBacktestJob = {
  jobId: "job-1",
  runId: "run-1",
  attempt: 1,
  actorUserId: "user-1",
  snapshot: { snapshotVersion: 1 },
};

/** Records what the loop asked the queue to do, without a database. */
class RecordingRepository implements BacktestJobRepository {
  readonly released: { jobId: string; runId: string; workerId: string }[] = [];
  private readonly queue: ClaimedBacktestJob[];

  constructor(queue: ClaimedBacktestJob[] = []) {
    this.queue = [...queue];
  }

  async claimNextJob(): Promise<ClaimedBacktestJob | null> {
    return this.queue.shift() ?? null;
  }

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async recoverStaleJobs(): Promise<StaleJobRecovery> {
    return { requeued: 0, abandoned: 0 };
  }

  async updateProgress(): Promise<boolean> {
    return true;
  }

  async persistResult(): Promise<boolean> {
    return true;
  }

  async failJob(): Promise<boolean> {
    return true;
  }

  async releaseJob(
    jobId: string,
    runId: string,
    workerId: string,
  ): Promise<boolean> {
    this.released.push({ jobId, runId, workerId });
    return true;
  }
}

/** Stands in for the day loop: checks the lease the way a real checkpoint does. */
class CheckpointingProcessor implements BacktestJobProcessor {
  private started = false;
  private resolveStarted: (() => void) | null = null;
  private readonly startedPromise: Promise<void>;

  constructor(
    private readonly onCheckpoint?: (lease: BacktestJobLease) => void,
  ) {
    this.startedPromise = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  waitUntilStarted(): Promise<void> {
    return this.startedPromise;
  }

  async process(
    _claim: ClaimedBacktestJob,
    lease: BacktestJobLease,
  ): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.resolveStarted?.();
    }

    // Bounded so a regression fails the suite instead of hanging it.
    for (let checkpoint = 0; checkpoint < 1_000; checkpoint += 1) {
      this.onCheckpoint?.(lease);
      const interruption = lease.interruption();
      if (interruption) {
        throw new BacktestInterruptedError(interruption);
      }
      await delay(1);
    }
    throw new Error("The processor was never interrupted");
  }
}

function createLoop(
  repository: BacktestJobRepository,
  processor: BacktestJobProcessor,
): BacktestWorkerLoop {
  return new BacktestWorkerLoop(repository, processor, logger, {
    workerId: WORKER_ID,
    pollIntervalMs: 5_000,
    leaseMs: 60_000,
    heartbeatIntervalMs: 60_000,
    retryBackoffMs: 1_000,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("backtest worker loop shutdown", () => {
  it("hands a run in flight back to the queue instead of stranding it", async () => {
    const repository = new RecordingRepository([CLAIM]);
    const processor = new CheckpointingProcessor();
    const loop = createLoop(repository, processor);

    const running = loop.run();
    await processor.waitUntilStarted();
    loop.stop();
    await running;

    // The run must never be left permanently RUNNING with nobody executing it.
    expect(repository.released).toEqual([
      { jobId: CLAIM.jobId, runId: CLAIM.runId, workerId: WORKER_ID },
    ]);
  });

  it("writes nothing when the claim was already taken over by another worker", async () => {
    const repository = new RecordingRepository([CLAIM]);
    const processor = new CheckpointingProcessor((lease) => lease.markLost());
    const loop = createLoop(repository, processor);

    const running = loop.run();
    await processor.waitUntilStarted();
    await delay(20);
    loop.stop();
    await running;

    // Releasing here would hand back a claim this process no longer holds.
    expect(repository.released).toEqual([]);
  });

  it("stops waiting for work the moment it is asked to stop", async () => {
    const repository = new RecordingRepository();
    const loop = createLoop(repository, new CheckpointingProcessor());

    const startedAt = Date.now();
    const running = loop.run();
    await delay(10);
    loop.stop();
    await running;

    // A five-second poll interval must not become a five-second shutdown.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
