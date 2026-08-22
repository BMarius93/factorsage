import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process, { loadEnvFile } from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

function loadRootEnv(startDirectory = process.cwd()) {
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

loadRootEnv();

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);