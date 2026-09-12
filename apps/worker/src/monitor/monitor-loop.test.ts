import { createLogger, type LogSink } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import type { AbortSignalCheck, MonitorCycle } from "./monitor-cycle.js";
import { MonitorWorkerLoop } from "./monitor-loop.js";
import type {
  ClaimedMonitorScan,
  MonitorScanRepository,
} from "./scan-repository.js";

const WORKER_ID = "monitor-worker-under-test";
const SCAN_INTERVAL_MS = 300_000;
const RETRY_BACKOFF_MS = 1_000;

const logger = createLogger({ service: "worker", level: "silent" });

/** Records what the loop asked the schedule to do, without a database. */
class RecordingScanRepository implements MonitorScanRepository {
  readonly completed: { workerId: string; nextDueAt: Date }[] = [];
  readonly released: { workerId: string }[] = [];
  readonly failed: {
    workerId: string;
    backoffMs: number;
    maxBackoffMs: number;
    error: string;
  }[] = [];
  heartbeatHeld = true;
  private readonly claims: ClaimedMonitorScan[];

  constructor(claims: ClaimedMonitorScan[] = []) {
    this.claims = [...claims];
  }

  async ensureSchedule(): Promise<void> {}

  async claimDueScan(): Promise<ClaimedMonitorScan | null> {
    return this.claims.shift() ?? null;
  }

  async heartbeat(): Promise<boolean> {
    return this.heartbeatHeld;
  }

  async completeScan(input: {
    workerId: string;
    nextDueAt: Date;
  }): Promise<boolean> {
    this.completed.push({
      workerId: input.workerId,
      nextDueAt: input.nextDueAt,
    });
    return true;
  }

  async releaseScan(input: { workerId: string }): Promise<boolean> {
    this.released.push({ workerId: input.workerId });
    return true;
  }

  async failScan(input: {
    workerId: string;
    backoffMs: number;
    maxBackoffMs: number;
    error: string;
  }): Promise<boolean> {
    this.failed.push({
      workerId: input.workerId,
      backoffMs: input.backoffMs,
      maxBackoffMs: input.maxBackoffMs,
      error: input.error,
    });
    return true;
  }

  async recoverExpiredScan(): Promise<boolean> {
    return false;
  }
}

/**
 * Stands in for the evaluation cycle. `MonitorCycle` is a class with private state, so the double
 * is cast: the loop only ever calls `run`, and that is the whole surface this test drives.
 */
class FakeCycle {
  readonly sequences: number[] = [];
  private resolveStarted: (() => void) | null = null;
  private readonly startedPromise = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  constructor(
    private readonly behaviour:
      "complete" | "slow-complete" | "wait-for-abort" | "throw",
  ) {}

  waitUntilStarted(): Promise<void> {
    return this.startedPromise;
  }

  async run(cycleSequence: number, isAborted: AbortSignalCheck): Promise<void> {
    this.sequences.push(cycleSequence);
    this.resolveStarted?.();
    if (this.behaviour === "throw") {
      throw new Error("provider unavailable");
    }
    if (this.behaviour === "complete") {
      return;
    }
    if (this.behaviour === "slow-complete") {
      await delay(15);
      return;
    }
    // Bounded so a regression fails the suite instead of hanging it.
    for (let boundary = 0; boundary < 1_000; boundary += 1) {
      if (isAborted()) {
        return;
      }
      await delay(1);
    }
    throw new Error("The cycle was never asked to stop");
  }

  asCycle(): MonitorCycle {
    return this as unknown as MonitorCycle;
  }
}

function createLoop(
  repository: MonitorScanRepository,
  cycle: FakeCycle,
  now: () => Date = () => new Date(),
  options: { scanIntervalMs?: number; sink?: LogSink } = {},
): MonitorWorkerLoop {
  const loopLogger = options.sink
    ? createLogger({
        service: "worker",
        level: "warn",
        stdout: options.sink,
        stderr: options.sink,
      })
    : logger;
  return new MonitorWorkerLoop(repository, cycle.asCycle(), loopLogger, {
    workerId: WORKER_ID,
    scanIntervalMs: options.scanIntervalMs ?? SCAN_INTERVAL_MS,
    pollIntervalMs: 5_000,
    leaseMs: 60_000,
    heartbeatIntervalMs: 5,
    retryBackoffMs: RETRY_BACKOFF_MS,
    now,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLAIM: ClaimedMonitorScan = { cycleSequence: 7, claimedAt: new Date() };

describe("monitor worker loop", () => {
  it("completes a due cycle and schedules the next one from its end", async () => {
    const fixedNow = new Date("2026-09-11T14:00:00.000Z");
    const repository = new RecordingScanRepository([CLAIM]);
    const cycle = new FakeCycle("complete");
    const loop = createLoop(repository, cycle, () => fixedNow);

    const running = loop.run();
    await cycle.waitUntilStarted();
    await delay(10);
    loop.stop();
    await running;

    expect(cycle.sequences).toEqual([CLAIM.cycleSequence]);
    // The interval is measured from completion, so a slow cycle delays rather than overlaps.
    expect(repository.completed).toEqual([
      {
        workerId: WORKER_ID,
        nextDueAt: new Date(fixedNow.getTime() + SCAN_INTERVAL_MS),
      },
    ]);
    expect(repository.released).toEqual([]);
    expect(repository.failed).toEqual([]);
  });

  it("hands an unfinished cycle back when stopped, recording no outcome", async () => {
    const repository = new RecordingScanRepository([CLAIM]);
    const cycle = new FakeCycle("wait-for-abort");
    const loop = createLoop(repository, cycle);

    const running = loop.run();
    await cycle.waitUntilStarted();
    loop.stop();
    await running;

    // The claim goes back and stays due; stamping a completion would report a scan that did
    // not happen and erase the failure history.
    expect(repository.released).toEqual([{ workerId: WORKER_ID }]);
    expect(repository.completed).toEqual([]);
    expect(repository.failed).toEqual([]);
  });

  it("abandons a cycle whose lease another process recovered", async () => {
    const repository = new RecordingScanRepository([CLAIM]);
    repository.heartbeatHeld = false;
    const cycle = new FakeCycle("wait-for-abort");
    const loop = createLoop(repository, cycle);

    const running = loop.run();
    await cycle.waitUntilStarted();
    // The heartbeat learns the lease is gone and the cycle stops at its next boundary on its own.
    await delay(50);
    loop.stop();
    await running;

    // Neither a completion nor a release: the schedule belongs to the new owner now.
    expect(repository.completed).toEqual([]);
    expect(repository.released).toEqual([]);
    expect(repository.failed).toEqual([]);
  });

  it("records a failed cycle with a retry backoff capped at the scan interval", async () => {
    const repository = new RecordingScanRepository([CLAIM]);
    const cycle = new FakeCycle("throw");
    const loop = createLoop(repository, cycle);

    const running = loop.run();
    await cycle.waitUntilStarted();
    await delay(10);
    loop.stop();
    await running;

    expect(repository.failed).toEqual([
      {
        workerId: WORKER_ID,
        backoffMs: RETRY_BACKOFF_MS,
        maxBackoffMs: SCAN_INTERVAL_MS,
        error: "provider unavailable",
      },
    ]);
    expect(repository.completed).toEqual([]);
  });

  it("warns when a completed cycle ran longer than the scan interval", async () => {
    // A slow cycle never overlaps the next one, so nothing fails; the cadence just silently
    // becomes "as fast as possible". That is a capacity signal and must be a named log line.
    const slowLines: string[] = [];
    const slowLoop = createLoop(
      new RecordingScanRepository([CLAIM]),
      new FakeCycle("slow-complete"),
      undefined,
      {
        scanIntervalMs: 1,
        sink: { write: (chunk) => slowLines.push(String(chunk)) },
      },
    );
    const slowRunning = slowLoop.run();
    await delay(40);
    slowLoop.stop();
    await slowRunning;
    expect(
      slowLines.filter((line) => line.includes("monitor.cycle.over-cadence")),
    ).toHaveLength(1);

    const quickLines: string[] = [];
    const quickLoop = createLoop(
      new RecordingScanRepository([CLAIM]),
      new FakeCycle("slow-complete"),
      undefined,
      {
        scanIntervalMs: SCAN_INTERVAL_MS,
        sink: { write: (chunk) => quickLines.push(String(chunk)) },
      },
    );
    const quickRunning = quickLoop.run();
    await delay(40);
    quickLoop.stop();
    await quickRunning;
    expect(quickLines.some((line) => line.includes("over-cadence"))).toBe(
      false,
    );
  });

  it("stops waiting for a due cycle the moment it is asked to stop", async () => {
    const repository = new RecordingScanRepository();
    const loop = createLoop(repository, new FakeCycle("complete"));

    const startedAt = Date.now();
    const running = loop.run();
    await delay(10);
    loop.stop();
    await running;

    // A five-second poll interval must not become a five-second shutdown.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
