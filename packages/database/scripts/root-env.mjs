import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process, { loadEnvFile } from "node:process";

/**
 * Loads the repository-root `.env` when it exists, so Prisma commands see the same variables as
 * every other package script. Deployed environments have no `.env` and inject variables directly.
 */
export function loadRootEnv(startDirectory = process.cwd()) {
  let directory = resolve(startDirectory);

  while (true) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      const envFile = join(directory, ".env");
      if (existsSync(envFile)) {
        loadEnvFile(envFile);
      }
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}
