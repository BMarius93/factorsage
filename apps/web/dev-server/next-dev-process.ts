import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextDevEnvironment } from "./next-dev-environment";

/**
 * Starting `next dev`, and clearing what an earlier start left behind.
 *
 * Kept apart from `next-dev.ts` so both halves can be exercised: the tests start a real child
 * process through {@link startNextDev} and read back the environment it actually received, which
 * is the only honest way to assert a process boundary.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Starts the dev server with the constructed environment, and only that.
 *
 * `env` is always passed. Leaving it out is how a child inherits everything, so there is no code
 * path here on which it is absent, and the caller cannot supply an environment of its own — only
 * the one to build from.
 */
export function startNextDev(input: {
  /** The environment this process was given. What `next dev` gets is built from it. */
  readonly parentEnvironment: Environment;
  /** The program to run and its arguments. */
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly stdio?: StdioOptions;
}): ChildProcess {
  const [file, ...args] = input.command;
  return spawn(file, args, {
    cwd: input.cwd,
    // Next's types make `NODE_ENV` a required key of `ProcessEnv`. It is not one here: the child
    // gets it only when this process was given it, like every other allowlisted variable.
    env: nextDevEnvironment(input.parentEnvironment) as NodeJS.ProcessEnv,
    stdio: input.stdio ?? "inherit",
  });
}

/**
 * Written beside the Turbopack cache once it is known to have been created by a server started
 * through this module. Bump the number to make every checkout drop its cache once more.
 */
export const DEV_CACHE_BOUNDARY_MARKER = ".environment-boundary-v1";

/**
 * Removes a Turbopack development cache written before the environment boundary existed.
 *
 * Such a cache may hold whatever the dev server's environment once held — on a machine that ever
 * started it from a shell with the QA passwords exported, those passwords — and fixing what the
 * server receives from now on does nothing about what is already on disk. So the first start after
 * this change deletes the cache, records that it did, and every later start leaves it alone.
 *
 * Only `.next/dev/cache/turbopack` is touched: a generated, git-ignored directory `next dev`
 * rebuilds by itself. The price is one cold compile, once per checkout.
 */
export function purgeDevCacheFromBeforeTheBoundary(
  webRoot: string,
): "purged" | "clean" {
  const cache = join(webRoot, ".next", "dev", "cache");
  const marker = join(cache, DEV_CACHE_BOUNDARY_MARKER);
  if (existsSync(marker)) {
    return "clean";
  }

  const turbopack = join(cache, "turbopack");
  const stale = existsSync(turbopack);
  if (stale) {
    rmSync(turbopack, { recursive: true, force: true });
  }
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    marker,
    "The Turbopack cache beside this file was created by a dev server started through\n" +
      "apps/web/dev-server/next-dev.ts, which gives `next dev` an allowlisted environment.\n" +
      "A cache without this marker is deleted on the next start, because it may record\n" +
      "environment variables from before that boundary existed.\n",
  );
  return stale ? "purged" : "clean";
}
