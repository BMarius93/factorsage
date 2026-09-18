import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadRootEnv } from "./root-env.mjs";

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