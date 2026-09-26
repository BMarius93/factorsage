import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * The API and web servers the end-to-end stages read through, pointed at the QA-matrix database.
 *
 * Same commands a developer runs (`pnpm dev:api`, `pnpm dev:web`), with an environment overlay: the
 * matrix database and Redis database, and the dataset pinned (ten-year freshness) so no read can
 * reach the provider and move the evidence under the audit. It refuses to start when either port is
 * already taken, because a server it did not start could be pointed at any database.
 */

export const AUDIT_API = "http://localhost:3001";
export const AUDIT_WEB = "http://localhost:3000";

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `${url} did not come up within ${Math.round(timeoutMs / 1000)}s`,
  );
}

export class AuditStack {
  private readonly children: ChildProcess[] = [];

  constructor(
    private readonly root: string,
    private readonly logDirectory: string,
  ) {}

  async start(log: (line: string) => void): Promise<void> {
    if (
      (await reachable(`${AUDIT_API}/health`)) ||
      (await reachable(AUDIT_WEB))
    ) {
      throw new Error(
        "Port 3000 or 3001 is already serving. Stop the running dev servers: the audit starts its own, pointed at the QA-matrix database.",
      );
    }
    mkdirSync(this.logDirectory, { recursive: true });
    const pinned = String(10 * 365 * 24 * 60 * 60 * 1000);
    const env = {
      ...process.env,
      STOCK_RECENT_PRICE_FRESHNESS_MS: pinned,
      STOCK_FUNDAMENTALS_FRESHNESS_MS: pinned,
      // The alternative-data domains too: their ordinary window is twelve hours, so an audit stack
      // reading a matrix copy would re-ingest disclosure history from the provider on the first page
      // view that named an insider or congressional metric.
      ALT_DATA_FRESHNESS_MS: pinned,
      // The monitor scan cadence decides when Dashboard rows read as stale; the audit reads a
      // frozen scan, so a day's staleness window keeps the freshness badge meaningful.
      MONITOR_SCAN_INTERVAL_MS: String(24 * 60 * 60 * 1000),
    };
    for (const [role, script] of [
      ["api", "dev:api"],
      ["web", "dev:web"],
    ] as const) {
      const out = openSync(join(this.logDirectory, `${role}.log`), "w");
      const child = spawn("pnpm", [script], {
        cwd: this.root,
        env,
        stdio: ["ignore", out, out],
        detached: true,
      });
      closeSync(out);
      this.children.push(child);
      log(`  started ${role} (pid ${child.pid})`);
    }
    await waitFor(`${AUDIT_API}/health`, 240_000);
    await waitFor(`${AUDIT_WEB}/login`, 240_000);
    log("  audit stack is up");
  }

  async stop(): Promise<void> {
    for (const child of this.children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    this.children.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
