import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { loadRootEnv } from "@intrinsic/config";
import {
  LIVE_FMP_USAGE,
  LiveFmpUsageError,
  parseLiveFmpArguments,
} from "./fmp-live/fmp-live-arguments";
import {
  LiveFmpEnvironmentError,
  assertLiveFmpOptIn,
  resolveLiveFmpKey,
  resolveLiveFmpTarget,
} from "./fmp-live/fmp-live-environment";
import { startLiveFmpChild } from "./fmp-live/fmp-live-process";
import { LIVE_FMP_REFUSED_EXIT_CODE } from "./fmp-live/fmp-live-report";

/**
 * `pnpm fmp:live` — hydrates the full supported history of at most three securities from the real
 * provider, into the local development database, through the product's own loaders.
 *
 * ```bash
 * RUN_LIVE_FMP_HYDRATION=1 pnpm fmp:live -- --symbols AAPL --full-history
 * RUN_LIVE_FMP_HYDRATION=1 pnpm fmp:live -- --symbols AAPL,MSFT,NVDA --full-history --budget 300
 * pnpm fmp:live -- --symbols AAPL,MSFT,NVDA --full-history --plan     # asks the provider nothing
 * ```
 *
 * This file is the launcher, and it touches neither the database nor the provider. In order, and
 * stopping at the first refusal:
 *
 * 1. the command line is parsed (`fmp-live-arguments.ts`), before any variable is read;
 * 2. the opt-in is required — `RUN_LIVE_FMP_HYDRATION=1`, for this command;
 * 3. the target is vetted: a local development database and a local Redis;
 * 4. only then is `LIVE_FMP_API_KEY` looked for;
 * 5. a child is started with an allowlisted environment in which that key is `FMP_API_KEY`
 *    (`startLiveFmpChild`, which builds it with `liveFmpChildEnvironment`). The child
 *    (`fmp-live/fmp-live-child.ts`) does the run.
 *
 * `docs/development/fmp-live-hydration.md` is the runbook.
 */

const API_ROOT = resolve(__dirname, "..");

function refuse(message: string, usage = false): never {
  console.error(message);
  if (usage) {
    console.error(LIVE_FMP_USAGE);
  }
  process.exit(LIVE_FMP_REFUSED_EXIT_CODE);
}

function main(): void {
  const forwarded = process.argv.slice(2);
  let key: string | null = null;
  try {
    const parsed = parseLiveFmpArguments(forwarded);
    // The launcher is where `.env` is read, so that the child never has to.
    loadRootEnv();
    if (!parsed.plan) {
      assertLiveFmpOptIn(process.env);
    }
    resolveLiveFmpTarget(process.env);
    if (!parsed.plan) {
      key = resolveLiveFmpKey(process.env);
    }
  } catch (error) {
    if (error instanceof LiveFmpUsageError) {
      refuse(error.message, true);
    }
    if (error instanceof LiveFmpEnvironmentError) {
      refuse(error.message);
    }
    throw error;
  }

  const child = startLiveFmpChild({
    command: [
      process.execPath,
      require.resolve("tsx/cli"),
      join(API_ROOT, "src", "fmp-live", "fmp-live-child.ts"),
      ...forwarded,
    ],
    parentEnvironment: process.env,
    key,
    runId: randomUUID(),
    cwd: API_ROOT,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
