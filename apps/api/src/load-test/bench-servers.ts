import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadRootEnv } from "@intrinsic/config";
import {
  benchEnvironment,
  benchProcessEnvironment,
} from "../backtest-benchmark/bench-environment";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * The API and the web app for the interactive-load benchmark (`docs/production/benchmarks.md`,
 * "Interactive load"), each from its production build, on the isolated benchmark environment.
 *
 * ```bash
 * pnpm --filter @intrinsic/api build
 * NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3101 pnpm --filter @intrinsic/web build
 * BENCH_DATABASE_URL=… BENCH_REDIS_URL=… pnpm --filter @intrinsic/api load:servers -- --api-port 3101 --web-port 3100
 * ```
 *
 * - The API gets exactly `benchProcessEnvironment` — no provider key, no Stripe secret, no test
 *   password — plus its port, the web origin, a rate-limit namespace of its own with the allowance
 *   multiplied (one load generator signs a hundred people in from one address; the per-user limits
 *   are unchanged by it), no SMTP, and the event-loop probe the backtest workers carry.
 * - The web server gets an allowlist: it opens no database and holds no secret.
 *
 * Both log to `artifacts/load/`; their pids are written to `artifacts/load/servers.json` for
 * `load:interactive run --api-pid`. Ctrl-C stops both. `--api-only` starts one more API process and
 * no web server (`api-<port>.log`, `servers-<port>.json`), so the API can be measured with two
 * processes — two load generators, each signing in its own accounts (`--first-user`).
 */

/** `apiOnly`: one more API process and no web server, to measure the API with more than one process. */
type Arguments = { apiPort: number; webPort: number; apiOnly: boolean };

function parseArguments(argv: readonly string[]): Arguments {
  const parsed: Arguments = { apiPort: 3101, webPort: 3100, apiOnly: false };
  const rest = argv.filter((value) => value !== "--");
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === "--api-only") {
      parsed.apiOnly = true;
      index -= 1;
      continue;
    }
    const value = Number(rest[index + 1]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${flag} needs a port`);
    }
    if (flag === "--api-port") parsed.apiPort = value;
    else if (flag === "--web-port") parsed.webPort = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  return parsed;
}

/** The API origin the web build compiled in: it must be the one this API listens on. */
function compiledApiOrigins(webRoot: string): Set<string> {
  const origins = new Set<string>();
  const chunks = join(webRoot, ".next/static/chunks");
  if (!existsSync(chunks)) {
    return origins;
  }
  for (const file of readdirSync(chunks)) {
    if (!file.endsWith(".js")) continue;
    for (const match of readFileSync(join(chunks, file), "utf8").matchAll(
      /http:\/\/127\.0\.0\.1:\d+/g,
    )) {
      origins.add(match[0]);
    }
  }
  return origins;
}

async function waitFor(url: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return Date.now() - startedAt;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${url} did not answer within ${timeoutMs} ms`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
}

function started(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  log: string,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stream = createWriteStream(log);
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  return child;
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArguments(process.argv.slice(2));
  const bench = benchEnvironment();
  const root = repositoryRoot();
  const apiEntry = join(root, "apps/api/dist/main.js");
  const webRoot = join(root, "apps/web");
  if (!existsSync(apiEntry)) {
    throw new Error(
      "apps/api/dist/main.js is missing: run `pnpm --filter @intrinsic/api build`",
    );
  }
  const apiOrigin = `http://127.0.0.1:${args.apiPort}`;
  const webOrigin = `http://127.0.0.1:${args.webPort}`;
  const compiled = args.apiOnly ? null : compiledApiOrigins(webRoot);
  if (compiled && !compiled.has(apiOrigin)) {
    throw new Error(
      `The web build calls ${[...compiled].join(", ") || "no loopback API"}, not ${apiOrigin}: ` +
        `rebuild it with NEXT_PUBLIC_API_BASE_URL=${apiOrigin}`,
    );
  }
  const logs = join(root, "artifacts/load");
  mkdirSync(logs, { recursive: true });

  const apiEnv = benchProcessEnvironment(bench, {
    PORT: String(args.apiPort),
    WEB_BASE_URL: webOrigin,
    CORS_ORIGINS: webOrigin,
    RATE_LIMIT_KEY_NAMESPACE: "rate-limit:bench",
    RATE_LIMIT_ALLOWANCE_MULTIPLIER: "100",
    EOD_TAIL_REFRESH: "frozen",
    // Every SMTP_* variable, or a session's mail settings leak in and half-configure SMTP.
    SMTP_HOST: "",
    SMTP_PORT: "",
    SMTP_SECURE: "",
    SMTP_FROM: "",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    LOG_LEVEL: "info",
  });
  const probe = join(
    root,
    "apps/api/src/backtest-benchmark/event-loop-probe.cjs",
  );
  const api = started(
    process.execPath,
    ["--require", probe, apiEntry],
    join(root, "apps/api"),
    apiEnv,
    join(logs, args.apiOnly ? `api-${args.apiPort}.log` : "api.log"),
  );

  if (args.apiOnly) {
    const stopApi = () => api.kill("SIGTERM");
    process.on("SIGINT", stopApi);
    process.on("SIGTERM", stopApi);
    const readyMs = await waitFor(`${apiOrigin}/health`, 120_000);
    const servers = { api: { pid: api.pid, origin: apiOrigin, readyMs }, logs };
    writeFileSync(
      join(logs, `servers-${args.apiPort}.json`),
      `${JSON.stringify(servers, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(servers)}\n`);
    await new Promise((resolveExit) => api.once("exit", resolveExit));
    return;
  }

  // An allowlist: the web server reads no secret and opens no data store.
  const webEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(args.webPort),
  };
  const web = started(
    process.execPath,
    [
      join(webRoot, "node_modules/next/dist/bin/next"),
      "start",
      "-p",
      String(args.webPort),
      "-H",
      "127.0.0.1",
    ],
    webRoot,
    webEnv,
    join(logs, "web.log"),
  );

  const stop = () => {
    api.kill("SIGTERM");
    web.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const apiReadyMs = await waitFor(`${apiOrigin}/health`, 120_000);
  const webReadyMs = await waitFor(`${webOrigin}/login`, 120_000);
  const servers = {
    api: { pid: api.pid, origin: apiOrigin, readyMs: apiReadyMs },
    web: { pid: web.pid, origin: webOrigin, readyMs: webReadyMs },
    logs,
  };
  writeFileSync(
    join(logs, "servers.json"),
    `${JSON.stringify(servers, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(servers)}\n`);
  await Promise.all(
    [api, web].map(
      (child) => new Promise((resolveExit) => child.once("exit", resolveExit)),
    ),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
