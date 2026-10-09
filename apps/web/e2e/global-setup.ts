import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "@playwright/test";
import {
  e2eArmedMode,
  e2eEgressLogPath,
  e2eFakeFmpControlUrl,
  isToleratedBlockedDestination,
  parseE2eEgressLog,
  type E2eEgressRecord,
  type E2eStackMode,
} from "@intrinsic/testing/e2e-stack";
import { MailpitClient } from "@intrinsic/testing/mailpit";
import { apiBaseUrl } from "./utils/entitlements";
import { STORAGE_STATE, e2eBaseUrl, repositoryRoot } from "./utils/env";
import { listenerPids } from "./utils/listener-pids";

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
 *   a stuck run silently holds a concurrency slot the next run depends on;
 * - the disposable accounts specs registered could not all be removed (below).
 *
 * **Disposable accounts, before and after.** A sign-up spec creates a real account the product
 * offers no way to delete (`@intrinsic/testing/e2e-accounts`). Both ends of the run therefore call
 * the API workspace's guarded cleanup — before, so whatever a killed or older run left is gone;
 * after, so a run leaves nothing behind. That command is the only write made from here, and this
 * process still holds no database client and decides nothing about what is deleted: the command
 * resolves the test database itself and refuses anything else (`apps/api/src/e2e-stack/
 * e2e-accounts.ts`). Otherwise this only reads; nothing here writes to Redis or the fixture server.
 *
 * **Modes** (`E2eStackMode`). This file is the ordinary suite's setup (`pnpm test:e2e`), which
 * refuses an API launched in mail mode: that suite runs with email switched off, and must not
 * quietly start delivering it. `global-setup.mail.ts` is the email lifecycle suite's
 * (`pnpm test:e2e:mail`), which demands the mail-mode API and additionally:
 * - proves the local Mailpit answers on loopback and cannot relay anything to a real server;
 * - before and after, deletes the Mailpit messages addressed only to `authmail` disposable
 *   addresses — what a killed run left, or a finished one missed — and nothing else, and fails the
 *   run if any remain.
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

export default function globalSetup(): Promise<() => Promise<void>> {
  return hermeticGlobalSetup("standard");
}

/** The kind of disposable account whose messages the mail suite owns in Mailpit. */
const MAIL_SUITE_ACCOUNT_KIND = "authmail";

export async function hermeticGlobalSetup(
  mode: E2eStackMode,
): Promise<() => Promise<void>> {
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
  const api = assertListenerGuarded("api", apiBaseUrl(), armed);
  assertListenerMode(api, armed, mode);
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

  const mailpit = mode === "mail" ? await preflightMailpit() : null;

  const stranded = pruneDisposableAccounts(root);
  if (stranded !== null) {
    throw new Error(
      `${stranded}. The run did not start: the test database holds a disposable account the ` +
        "cleanup will not delete, or the cleanup could not reach it.",
    );
  }
  if (mailpit !== null) {
    await sweepMailSuiteMessages(mailpit, "before");
  }

  return async () => {
    const problems: string[] = [];

    const leftover = pruneDisposableAccounts(root);
    if (leftover !== null) {
      problems.push(leftover);
    }
    if (mailpit !== null) {
      const remaining = await sweepMailSuiteMessages(mailpit, "after").catch(
        (error: unknown) => {
          problems.push(
            `the Mailpit cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 0;
        },
      );
      if (remaining > 0) {
        problems.push(
          `${remaining} ${MAIL_SUITE_ACCOUNT_KIND} message(s) are still in Mailpit after the cleanup`,
        );
      }
    }

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

/**
 * Runs `pnpm test:accounts:prune`'s command in the API workspace and reports a failure, or `null`.
 *
 * Without the root script's package build: the stack's launchers built them already. The command's
 * own `[e2e-accounts]` lines are passed through, so a refusal names the account and the reason.
 */
function pruneDisposableAccounts(root: string): string | null {
  const result = spawnSync(
    "pnpm",
    ["--silent", "--filter", "@intrinsic/api", "e2e:accounts:prune"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      timeout: 60_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output !== "") {
    process.stdout.write(`${output}\n`);
  }
  if (result.error !== undefined) {
    return `the disposable-account cleanup could not run: ${result.error.message}`;
  }
  if (result.status !== 0) {
    return (
      `the disposable-account cleanup failed (${result.signal ?? `exit ${result.status}`}); ` +
      "see the [e2e-accounts] lines above"
    );
  }
  return null;
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

/**
 * Proves the local Mailpit is the one the mail mode delivers to: loopback (the client refuses any
 * other origin), answering as Mailpit, and unable to relay.
 */
async function preflightMailpit(): Promise<MailpitClient> {
  const mailpit = new MailpitClient();
  try {
    const { version } = await mailpit.preflight();
    process.stdout.write(
      `[e2e-mail] Mailpit ${version} at ${mailpit.baseUrl}\n`,
    );
  } catch (error) {
    throw new Error(
      `The local Mailpit at ${mailpit.baseUrl} is not usable for the email lifecycle suite. In a ` +
        "Claude cloud session the SessionStart hook starts it; elsewhere run the pinned Mailpit with " +
        "`--smtp 127.0.0.1:1025 --listen 127.0.0.1:8025` (ai/workflows/auth-testing.md §7).",
      { cause: error },
    );
  }
  return mailpit;
}

/**
 * Deletes the messages the mail suite's disposable addresses received, and returns how many are
 * left afterwards (zero unless a delete silently failed). Messages to anybody else are untouched.
 */
async function sweepMailSuiteMessages(
  mailpit: MailpitClient,
  when: "before" | "after",
): Promise<number> {
  const removed = await mailpit.sweepDisposableKind(MAIL_SUITE_ACCOUNT_KIND);
  const remaining = (await mailpit.messagesOwnedBy(MAIL_SUITE_ACCOUNT_KIND))
    .length;
  process.stdout.write(
    `[e2e-mail] removed ${removed} ${MAIL_SUITE_ACCOUNT_KIND} message(s) from Mailpit ${when} the run; ${remaining} remain\n`,
  );
  return remaining;
}

/**
 * Refuses an API launched in the other mode. The ordinary suite must not run against an API that
 * delivers email, and the mail suite would only wait out its timeouts against one that sends none.
 */
function assertListenerMode(
  pids: readonly number[],
  armed: readonly E2eEgressRecord[],
  mode: E2eStackMode,
): void {
  const modes = new Set(
    armed
      .filter((record) => record.kind === "armed" && pids.includes(record.pid))
      .map((record) => (record.kind === "armed" ? e2eArmedMode(record) : "")),
  );
  if (modes.size === 1 && modes.has(mode)) {
    return;
  }
  throw new Error(
    mode === "mail"
      ? "The API on :3001 was not launched in mail mode, so no message would ever reach Mailpit. " +
          "Stop it and start `pnpm dev:api:e2e:mail` for `pnpm test:e2e:mail` " +
          "(ai/workflows/auth-testing.md §7)."
      : "The API on :3001 was launched in mail mode (`pnpm dev:api:e2e:mail`): it delivers email " +
          "to the local Mailpit, and the ordinary suite runs with email switched off. Stop it and " +
          "start `pnpm dev:api:e2e`, or run the email lifecycle suite with `pnpm test:e2e:mail`.",
  );
}

function assertListenerGuarded(
  role: "api" | "web",
  baseUrl: string,
  armed: readonly E2eEgressRecord[],
): readonly number[] {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const { tool, pids } = listenerPids(port);
  const guarded = new Set(
    armed.filter((record) => record.role === role).map((record) => record.pid),
  );
  if (pids.length === 0 || !pids.every((pid) => guarded.has(pid))) {
    const owner =
      tool === undefined
        ? "no listener found by lsof or fuser"
        : `pid ${pids.join(", ")} per ${tool}`;
    throw new Error(
      `The ${role} on port ${port} (${owner}) was not started through ` +
        `\`pnpm dev:${role}:e2e\`: it has not armed the E2E egress guard, so it may be a stale ` +
        "development process, point at another database, or reach real providers. Stop it and " +
        "start the hermetic stack (ai/workflows/auth-testing.md §7).",
    );
  }
  return pids;
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
