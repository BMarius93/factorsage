import { createSyntheticFmpServer } from "./synthetic-fmp";

/**
 * Serves the synthetic provider (`synthetic-fmp.ts`) for the scale benchmark.
 *
 * ```bash
 * pnpm --filter @intrinsic/api bench:synthetic-fmp -- --port 4790 --universe 1600 --latency-ms 0
 * ```
 *
 * Loopback only. `--latency-ms` models the provider's round trip; `--fail-every N` answers every
 * Nth request 429 (or `--fail-status`). `GET /__synthetic/counters` reports what it served.
 */
function main(): void {
  const argv = process.argv.slice(2).filter((value) => value !== "--");
  const options: Record<string, number> = {
    port: 4790,
    universe: 2000,
    "latency-ms": 0,
    "fail-every": 0,
    "fail-status": 429,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = (argv[index] as string).replace(/^--/, "");
    const raw = argv[index + 1];
    if (!(flag in options) || raw === undefined || !/^\d+$/.test(raw)) {
      throw new Error(
        "Usage: synthetic-fmp-server [--port N] [--universe N] [--latency-ms N] [--fail-every N] [--fail-status N]",
      );
    }
    options[flag] = Number(raw);
    index += 1;
  }
  let lastReport = 0;
  const synthetic = createSyntheticFmpServer({
    universe: options.universe as number,
    latencyMs: options["latency-ms"] as number,
    failEvery: options["fail-every"] as number,
    failStatus: options["fail-status"] as number,
    log: (line) => {
      // Unexpected answers are rare and worth seeing; never more than one line a second.
      if (Date.now() - lastReport > 1_000) {
        lastReport = Date.now();
        process.stderr.write(`${line}\n`);
      }
    },
  });
  synthetic.server.keepAliveTimeout = 30_000;
  synthetic.server.listen(options.port, "127.0.0.1", () => {
    process.stdout.write(
      `${JSON.stringify({ event: "synthetic-fmp.listening", ...options })}\n`,
    );
  });
  const stop = () => {
    process.stdout.write(
      `${JSON.stringify({ event: "synthetic-fmp.stopped", counters: synthetic.counters })}\n`,
    );
    void synthetic.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
