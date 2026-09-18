import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "@playwright/test";
import {
  e2eEgressLogPath,
  e2eFakeFmpControlUrl,
  isToleratedBlockedDestination,
  parseE2eEgressLog,
  type E2eEgressRecord,
} from "@intrinsic/testing/e2e-stack";
import { apiBaseUrl } from "./utils/entitlements";
import { STORAGE_STATE, e2eBaseUrl, repositoryRoot } from "./utils/env";

/**
 * Proves the stack under test is the hermetic one before a run, and that nothing escaped it after.
 *
 * **Before** (E2E-001): the fixture FMP server answers, and the processes actually serving the API
 * port, the web port and the backtest worker were launched through `pnpm dev:*:e2e` — each has
 * armed the egress guard in its own pid. A development server left on `:3001` against another
 * database, or a worker started with `pnpm dev:worker`, fails here with the command to run instead
 * of producing failures that look like product bugs.
 *
 * **After**, the run fails if:
 * - the fixture FMP server received any request it has no fixture for (it names each one);
 * - the egress guard blocked any outbound connection from an E2E process (host and pid named);
 * - any persona still has a backtest in flight other than the entitlement fixtures' pinned runs —
 *   a stuck run silently holds a concurrency slot the next run depends on.
 *
 * It only reads. Nothing here writes to the database, Redis or the fixture server.
 */

const PINNED_RUN_STRATEGY = "ENT-In Flight";
const TERMINAL = new Set(["COMPLETED", "FAILED"]);

type JournalEntry = {
  readonly sequence: number;
  readonly endpoint: string;
  readonly query: Readonly<Record<string, string>>;
  readonly status: number;
  readonly outcome: "fixture" | "unexpected";
  readonly detail: string;
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = repositoryRoot();
  if (root === undefined) {
    throw new Error("Playwright must run inside the FactorSage repository");
  }
  const control = e2eFakeFmpControlUrl();
  const journal = await readJournal(control, 0).catch((error: unknown) => {
    throw new Error(
      `The fixture FMP server is not answering at ${control}. The E2E stack is hermetic: start ` +
        "it with `pnpm dev:fmp:e2e`, then `pnpm dev:api:e2e`, `pnpm dev:worker:e2e` and " +
        "`pnpm dev:web:e2e` (ai/workflows/auth-testing.md §7).",
      { cause: error },
    );
  });
  const egressLog = e2eEgressLogPath(root);
  const startedAt = new Date().toISOString();

  const armed = readEgressLog(egressLog).filter(
    (record) => record.kind === "armed" && isAlive(record.pid),
  );
  assertListenerGuarded("api", apiBaseUrl(), armed);
  assertListenerGuarded("web", e2eBaseUrl(), armed);
  if (
    !armed.some(
      (record) =>
        record.role === "worker" && record.command.includes("worker-process"),
    )
  ) {
    throw new Error(
      "No backtest worker child armed with the E2E egress guard is running. Start the worker with " +
        "`pnpm dev:worker:e2e` (a worker started with `pnpm dev:worker` would reach real providers " +
        "and the development configuration).",
    );
  }

  return async () => {
    const problems: string[] = [];

    const entries = (await readJournal(control, journal.last)).entries;
    const byEndpoint = new Map<string, number>();
    for (const entry of entries) {
      const key = `${entry.outcome} ${entry.endpoint}`;
      byEndpoint.set(key, (byEndpoint.get(key) ?? 0) + 1);
    }
    process.stdout.write(
      `[e2e-hermetic] fixture FMP requests this run: ${entries.length}` +
        (entries.length === 0
          ? "\n"
          : ` (${[...byEndpoint].map(([key, count]) => `${key}: ${count}`).join(", ")})\n`),
    );
    for (const entry of entries.filter((item) => item.outcome !== "fixture")) {
      problems.push(`fixture FMP had no fixture for: ${entry.detail}`);
    }

    const blocked = readEgressLog(egressLog).filter(
      (record) => record.kind === "blocked" && record.at >= startedAt,
    );
    process.stdout.write(
      `[e2e-hermetic] outbound connections blocked by the egress guard this run: ${blocked.length}\n`,
    );
    for (const record of blocked) {
      if (record.kind !== "blocked") {
        continue;
      }
      const line = `${record.host}:${record.port} from ${record.role} (pid ${record.pid})`;
      if (isToleratedBlockedDestination(record)) {
        process.stdout.write(
          `[e2e-hermetic] blocked (framework, tolerated): ${line}\n`,
        );
      } else {
        problems.push(`egress guard blocked ${line}, ${record.command}`);
      }
    }

    problems.push(...(await strayRuns()));
    if (problems.length > 0) {
      throw new Error(
        `The E2E run was not hermetic or did not clean up:\n- ${problems.join("\n- ")}`,
      );
    }
  };
}

async function readJournal(
  control: string,
  after: number,
): Promise<{ entries: JournalEntry[]; last: number }> {
  const response = await fetch(`${control}journal?after=${after}`);
  if (!response.ok) {
    throw new Error(`fixture FMP journal answered ${response.status}`);
  }
  return (await response.json()) as { entries: JournalEntry[]; last: number };
}

function readEgressLog(path: string): E2eEgressRecord[] {
  return existsSync(path) ? parseE2eEgressLog(readFileSync(path, "utf8")) : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertListenerGuarded(
  role: "api" | "web",
  baseUrl: string,
  armed: readonly E2eEgressRecord[],
): void {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  let pids: number[];
  try {
    pids = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(Number);
  } catch {
    pids = [];
  }
  const guarded = new Set(
    armed.filter((record) => record.role === role).map((record) => record.pid),
  );
  if (pids.length === 0 || !pids.every((pid) => guarded.has(pid))) {
    throw new Error(
      `The ${role} on port ${port} (pid ${pids.join(", ") || "none"}) was not started through ` +
        `\`pnpm dev:${role}:e2e\`: it has not armed the E2E egress guard, so it may be a stale ` +
        "development process, point at another database, or reach real providers. Stop it and " +
        "start the hermetic stack (ai/workflows/auth-testing.md §7).",
    );
  }
}

/** Every persona's non-terminal runs other than the entitlement fixtures' pinned ones. */
async function strayRuns(): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [persona, storageState] of Object.entries(STORAGE_STATE)) {
    if (seen.has(storageState) || !existsSync(storageState)) {
      continue;
    }
    seen.add(storageState);
    const context = await request.newContext({ storageState });
    try {
      const response = await context.get(`${apiBaseUrl()}/backtests`);
      if (!response.ok()) {
        continue;
      }
      const runs = (await response.json()) as {
        id: string;
        status: string;
        strategyName: string;
      }[];
      for (const run of runs) {
        if (
          !TERMINAL.has(run.status) &&
          run.strategyName !== PINNED_RUN_STRATEGY
        ) {
          problems.push(
            `${persona} still has backtest ${run.id} (${run.strategyName}) ${run.status} after the run`,
          );
        }
      }
    } finally {
      await context.dispose();
    }
  }
  return problems;
}
