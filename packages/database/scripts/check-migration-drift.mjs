/**
 * Fails when `prisma/schema.prisma` and `prisma/migrations` describe different databases (CI-002).
 *
 * `prisma validate` checks only that the schema parses, and `migrate deploy` only applies what is
 * committed, so neither notices a schema edit that shipped without its migration — which then
 * fails, or silently drifts, at `migrate deploy` in production. This replays every committed
 * migration into a brand-new throwaway database and diffs the result against the schema's
 * datamodel with `prisma migrate diff --exit-code`.
 *
 * The throwaway database is created on the server `MIGRATION_DRIFT_DATABASE_URL` points at
 * (default: `DATABASE_URL`) under a unique generated name, and dropped afterwards. The configured
 * database itself is only used to issue `CREATE DATABASE`/`DROP DATABASE` for that generated name;
 * nothing is read from or written to it, and it is never used as the shadow — Prisma empties a
 * shadow database before replaying into it. The role needs the CREATEDB privilege.
 *
 * Exit status: 0 when they agree, 1 on drift or on any error.
 */
import console from "node:console";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { URL, fileURLToPath } from "node:url";
import { loadRootEnv } from "./root-env.mjs";

loadRootEnv();

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");

function prisma(args, options = {}) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: packageDirectory,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function execute(url, sql) {
  const result = prisma(["db", "execute", "--url", url, "--stdin"], {
    input: sql,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error("prisma db execute failed");
  }
}

const serverUrlVariable = process.env.MIGRATION_DRIFT_DATABASE_URL
  ? "MIGRATION_DRIFT_DATABASE_URL"
  : "DATABASE_URL";
const serverUrl = process.env[serverUrlVariable];
if (!serverUrl) {
  console.error(
    "Migration drift check: set DATABASE_URL (or MIGRATION_DRIFT_DATABASE_URL) to a PostgreSQL " +
      "server where a throwaway database may be created.",
  );
  process.exit(1);
}

const shadowName = `prisma_drift_shadow_${Date.now()}_${process.pid}`;
const shadowUrl = new URL(serverUrl);
shadowUrl.pathname = `/${shadowName}`;

let exitCode = 1;
let created = false;
try {
  execute(serverUrl, `CREATE DATABASE "${shadowName}";`);
  created = true;
  console.log(`Migration drift check: replaying migrations into ${shadowName}`);

  const diffArgs = [
    "migrate",
    "diff",
    "--from-migrations",
    "prisma/migrations",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--shadow-database-url",
    shadowUrl.toString(),
  ];
  const diff = prisma([...diffArgs, "--exit-code"]);

  if (diff.status === 0) {
    console.log(
      "Migration drift check: schema.prisma matches the migration history.",
    );
    exitCode = 0;
  } else if (diff.status === 2) {
    const script = prisma([...diffArgs, "--script"]);
    console.error(
      "Migration drift check FAILED: prisma/schema.prisma and prisma/migrations disagree.\n" +
        "Applying every committed migration does not produce the schema. Add a migration for " +
        "the schema change (see ai/workflows/validation.md). The missing SQL is:\n",
    );
    console.error(script.stdout || diff.stdout);
  } else {
    process.stderr.write(diff.stdout + diff.stderr);
    console.error("Migration drift check: prisma migrate diff failed.");
  }
} catch (error) {
  console.error(
    `Migration drift check: ${error instanceof Error ? error.message : error}`,
  );
} finally {
  if (created) {
    try {
      execute(
        serverUrl,
        `DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE);`,
      );
    } catch {
      console.error(
        `Migration drift check: could not drop ${shadowName}; drop it manually.`,
      );
      exitCode = 1;
    }
  }
}

process.exit(exitCode);
