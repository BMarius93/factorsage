import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MatrixEnvironment } from "./matrix-environment";
import { MatrixWorkerPool } from "./matrix-worker-pool";

/**
 * "Stopped" has to mean nothing from this pool can claim another job.
 *
 * The sweep pool and the golden-rerun pool draw from the same PostgreSQL queue with different
 * archive settings, so one surviving child of the wrong pool silently takes a rerun's job and
 * produces no archive for it. A sweep measured exactly that: the pool reported itself stopped, its
 * supervisor logged `worker.stopped`, and three children kept claiming for another forty minutes —
 * taking four of the six golden reruns, and ending with two archives where six were planned.
 *
 * So the pool no longer trusts the supervisor to have reaped anything. It signals the process
 * **group**, and does not return until the group is gone. The supervisor below is deliberately the
 * worst case: it forks a child that ignores SIGTERM entirely, and then exits on its own, leaving
 * that child orphaned and running — which is precisely what happened.
 */

const ENVIRONMENT: MatrixEnvironment = {
  databaseUrl: "postgresql://localhost:5432/intrinsic_value_matrix",
  databaseName: "intrinsic_value_matrix",
  redisUrl: "redis://localhost:6379/3",
  redisDb: 3,
} as unknown as MatrixEnvironment;

const pools: MatrixWorkerPool[] = [];
const survivors: number[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    await pool.stop(1_000).catch(() => {});
  }
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the point of the test.
    }
  }
});

/** A supervisor that forks an unkillable-by-SIGTERM child and then exits without reaping it. */
function orphaningSupervisor(): string {
  const directory = mkdtempSync(join(tmpdir(), "qa-matrix-pool-"));
  const child = join(directory, "child.mjs");
  writeFileSync(
    child,
    [
      "process.on('SIGTERM', () => {});",
      "console.log(JSON.stringify({ event: 'fake.child.ready', pid: process.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  const supervisor = join(directory, "supervisor.mjs");
  writeFileSync(
    supervisor,
    [
      "import { spawn } from 'node:child_process';",
      `const child = spawn(process.execPath, [${JSON.stringify(child)}], {`,
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "});",
      "console.log(JSON.stringify({ event: 'fake.supervisor.ready', childPid: child.pid }));",
      // Exits on its own a moment later, orphaning the child — the observed failure.
      "setTimeout(() => process.exit(0), 300);",
    ].join("\n"),
    "utf8",
  );
  return supervisor;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("stopping a matrix worker pool", () => {
  it("leaves no child claiming, even one that ignores SIGTERM and outlived its parent", async () => {
    const records: Record<string, unknown>[] = [];
    const pool = new MatrixWorkerPool({
      environment: ENVIRONMENT,
      repositoryRoot: process.cwd(),
      processes: 1,
      debugArchive: "off",
      entryPointOverride: orphaningSupervisor(),
      onLogRecord: (record) => records.push(record),
    });
    pools.push(pool);
    pool.start();

    await waitFor(() => records.some((r) => r.event === "fake.child.ready"));
    const childPid = records.find((r) => r.event === "fake.child.ready")
      ?.pid as number;
    expect(typeof childPid).toBe("number");
    survivors.push(childPid);

    // The supervisor has exited on its own by now; the child is an orphan and still running.
    await waitFor(() => alive(childPid));
    expect(alive(childPid)).toBe(true);

    await pool.stop(1_000);

    await waitFor(() => !alive(childPid), 3_000);
    expect(alive(childPid)).toBe(false);
  }, 30_000);

  it("is idempotent and safe to call when the pool never started", async () => {
    const pool = new MatrixWorkerPool({
      environment: ENVIRONMENT,
      repositoryRoot: process.cwd(),
      processes: 1,
      debugArchive: "off",
    });
    await expect(pool.stop(500)).resolves.toBeUndefined();
  });
});

describe("two pools may never claim from the same queue at once", () => {
  it("refuses to start a second pool while one is running", async () => {
    const first = new MatrixWorkerPool({
      environment: ENVIRONMENT,
      repositoryRoot: process.cwd(),
      processes: 1,
      debugArchive: "off",
      entryPointOverride: orphaningSupervisor(),
    });
    pools.push(first);
    first.start();

    const second = new MatrixWorkerPool({
      environment: ENVIRONMENT,
      repositoryRoot: process.cwd(),
      processes: 1,
      debugArchive: "full",
      entryPointOverride: orphaningSupervisor(),
    });
    expect(() => second.start()).toThrow(
      /Another matrix worker pool is already running/,
    );

    // And the seat is released once the first one is genuinely stopped.
    await first.stop(1_000);
    expect(() => second.start()).not.toThrow();
    pools.push(second);
  }, 30_000);
});
