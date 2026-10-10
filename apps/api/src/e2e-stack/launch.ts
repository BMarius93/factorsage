import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { e2eStackEnvironment, type E2eStackRole } from "@intrinsic/testing";

/**
 * Launches one process of the deterministic E2E stack: `pnpm dev:api:e2e`, `pnpm dev:worker:e2e`
 * and `pnpm dev:web:e2e` all come through here.
 *
 * It lays `e2eStackEnvironment(role)` over the developer's `.env` and runs the ordinary development
 * command, so the E2E stack is the real application with its external boundary replaced — the test
 * database, the fixture FMP server, every other provider switched off or made inert, and the egress
 * guard preloaded into every Node process underneath. Nothing about the development stack changes.
 *
 * `pnpm dev:api:e2e:mail` is the same API with `--mail`: its email goes to the local Mailpit instead
 * of being switched off (`E2eStackMode`), for the email lifecycle suite alone. The Mailpit endpoint
 * is refused unless it is loopback, before the child exists.
 *
 * Only `TEST_DATABASE_URL` is read from `.env` here; everything else the child loads itself.
 */

const COMMANDS: Record<E2eStackRole, readonly string[]> = {
  api: ["dev:api"],
  worker: ["dev:worker"],
  web: ["dev:web"],
};

function repositoryRoot(start: string): string {
  let directory = resolve(start);
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        "Could not find the repository root (pnpm-workspace.yaml)",
      );
    }
    directory = parent;
  }
  return directory;
}

function testDatabaseUrl(root: string): string | undefined {
  const fromShell = process.env.TEST_DATABASE_URL?.trim();
  if (fromShell) {
    return fromShell;
  }
  const envFile = join(root, ".env");
  return existsSync(envFile)
    ? parseEnv(readFileSync(envFile, "utf8")).TEST_DATABASE_URL?.trim()
    : undefined;
}

function main(): void {
  const [role, ...options] = process.argv
    .slice(2)
    .filter((arg) => arg !== "--") as [E2eStackRole | undefined, ...string[]];
  if (
    role === undefined ||
    !(role in COMMANDS) ||
    options.some((option) => option !== "--mail")
  ) {
    throw new Error("Usage: launch.ts <api|worker|web> [--mail]");
  }
  const root = repositoryRoot(process.cwd());
  const overlay = e2eStackEnvironment({
    role,
    repositoryRoot: root,
    testDatabaseUrl: testDatabaseUrl(root),
    inheritedNodeOptions: process.env.NODE_OPTIONS,
    mode: options.includes("--mail") ? "mail" : "standard",
    launcherEnvironment: process.env,
  });

  const child = spawn("pnpm", [...COMMANDS[role]], {
    cwd: root,
    env: { ...process.env, ...overlay },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
