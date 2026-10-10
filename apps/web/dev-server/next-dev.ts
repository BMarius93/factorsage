import { resolve } from "node:path";
import {
  nextDevEnvironment,
  withheldFromNextDev,
} from "./next-dev-environment";
import {
  purgeDevCacheFromBeforeTheBoundary,
  startNextDev,
} from "./next-dev-process";

/**
 * `pnpm dev:web` — the only thing in this repository that starts `next dev`.
 *
 * It exists for one reason: `next dev` must not inherit its parent's environment
 * (`next-dev-environment.ts` says why, and what it receives instead). The hermetic E2E stack's web
 * launcher and `scripts/cloud/stack.sh` both run `pnpm dev:web`, so they arrive here too, and no
 * launcher — present or future — can hand the dev server more than this lets through.
 *
 * Arguments are passed on: `pnpm dev:web -- --port 4000` is `next dev --port 4000`.
 */

const WEB_ROOT = resolve(__dirname, "..");
const NEXT_BIN = resolve(WEB_ROOT, "node_modules/next/dist/bin/next");

function main(): void {
  if (purgeDevCacheFromBeforeTheBoundary(WEB_ROOT) === "purged") {
    console.log(
      "[next-dev] Removed a Turbopack development cache created before the dev server's " +
        "environment was restricted; it may have recorded environment variables. The next " +
        "compile is a cold one.",
    );
  }

  // Counts and a path, never a name's value: a developer whose exported variable no longer
  // reaches the dev server should be able to find out why from the terminal.
  const received = Object.keys(nextDevEnvironment(process.env)).length;
  const withheld = withheldFromNextDev(process.env).length;
  console.log(
    `[next-dev] next dev receives ${received} of ${received + withheld} environment ` +
      "variables (the allowlist is apps/web/dev-server/next-dev-environment.ts).",
  );

  const child = startNextDev({
    parentEnvironment: process.env,
    command: [
      process.execPath,
      NEXT_BIN,
      "dev",
      // pnpm forwards the `--` separator itself.
      ...process.argv.slice(2).filter((argument) => argument !== "--"),
    ],
    cwd: WEB_ROOT,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
