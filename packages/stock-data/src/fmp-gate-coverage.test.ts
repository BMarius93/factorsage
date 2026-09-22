import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Proof that no process can reach Financial Modeling Prep outside the shared provider gate.
 *
 * Provider throttling is a **different problem** from API rate limiting, and the difference is in
 * what a limit means. A user who asks too often should be refused: their request is optional and
 * `429` is a complete answer. A backtest that needs thirty years of prices must not be refused
 * because a Monitor cycle happened to be running — it must **wait**. `RedisFmpRequestGate` is
 * therefore a queue with a bounded wait, not a rejecter: concurrency, a rolling request window and
 * a shared `Retry-After` cooldown, all in Redis so the API instances and every worker child spend
 * one allowance rather than one each.
 *
 * ```text
 *   web A ─────┐
 *   web B ─────┤
 *   worker A ──┼── RedisFmpRequestGate ── FMP
 *   worker B ──┘        (stock-data:v2:fmp:*)
 * ```
 *
 * The gate is only worth anything if **every** caller passes through it, and `FmpClient` accepts
 * an optional gate — a composition that forgets one still works, still passes every functional
 * test, and quietly doubles the provider traffic. That is the failure this suite makes impossible:
 * it reads the repository as source text and requires every production `new FmpClient(...)` to be
 * constructed with a `RedisFmpRequestGate`.
 *
 * Entirely offline. It reads files; it constructs nothing and calls nobody.
 */

function workspaceRoot(): string {
  let current = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the workspace root");
    }
    current = parent;
  }
}

const REPO_ROOT = workspaceRoot();

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".next",
  "playwright-report",
  "test-results",
]);

/**
 * Files that construct an `FmpClient` and are part of the running product.
 *
 * Test files are excluded deliberately: a suite that injects a counting or failing provider is the
 * point of having a seam, and `packages/fmp`'s own suite constructs ungated clients to test the
 * client itself.
 */
function discoverProductionFmpClientFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) {
        continue;
      }
      if (readFileSync(path, "utf8").includes("new FmpClient(")) {
        found.push(relative(REPO_ROOT, path).split(sep).join("/"));
      }
    }
  };
  walk(REPO_ROOT);
  return found.sort();
}

describe("shared FMP provider gate", () => {
  const files = discoverProductionFmpClientFiles();

  it("is constructed by exactly the known composition roots", () => {
    // Listed rather than counted, so adding a process is a deliberate edit here and an occasion to
    // ask whether it shares the allowance correctly.
    //
    // Two entry points here are not long-running services: the benchmark prewarm CLI and the stock
    // resync CLI. They are on the list for exactly the reason the list exists — a thirty-year index
    // backfill, or a re-verification of thirty-odd securities' whole history, is the job most likely
    // to starve a live Stock Details read, so both go through the same Redis gate and spend the same
    // budget rather than opening a private lane beside it.
    expect(files).toEqual([
      "apps/api/src/benchmarks/prewarm-benchmark-data.ts",
      "apps/api/src/resync-canonical-stock-data.ts",
      "apps/api/src/stocks/stocks.module.ts",
      "apps/worker/src/backtest/composition.ts",
      "apps/worker/src/monitor/composition.ts",
    ]);
  });

  it("passes a Redis-backed gate at every construction site", () => {
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const construction = source.slice(source.indexOf("new FmpClient("));
      expect(
        construction.includes("gate:"),
        `${file} constructs FmpClient without a gate`,
      ).toBe(true);
      expect(
        construction.includes("new RedisFmpRequestGate("),
        `${file} must share the Redis gate, not a process-local one`,
      ).toBe(true);
    }
  });

  it("sizes every gate from the same configuration, never from a literal", () => {
    // A hard-coded allowance would be a guess at the FMP plan this deployment bought. The numbers
    // are `FMP_*` environment configuration with documented defaults, so an operator raises them
    // when they raise their plan — in one place, for every process at once.
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const options = source.slice(
        source.indexOf("new RedisFmpRequestGate("),
        source.indexOf("new RedisFmpRequestGate(") + 600,
      );
      for (const option of [
        "maxConcurrentRequests",
        "rateLimitPerWindow",
        "rateWindowMs",
        "maxQueueDepth",
        "maxQueueWaitMs",
      ]) {
        expect(options, `${file}: ${option}`).toContain(`${option}:`);
        // `rateLimitPerWindow: 20` in a composition root would pin one process to a number the
        // others do not share.
        expect(
          new RegExp(`${option}:\\s*\\d`).test(options),
          `${file} hard-codes ${option} instead of reading configuration`,
        ).toBe(false);
      }
    }
  });

  it("keeps the browser-facing logo proxy off the metered API", () => {
    // `apps/web` may not depend on `@intrinsic/fmp` at all (`AGENTS.md` dependency rules), so its
    // logo endpoint cannot pass the gate. That is safe only because it talks to the unmetered
    // image host rather than to the API: no key, no allowance, nothing the gate protects. If that
    // URL ever became an API call, this assertion is what would catch it.
    const route = readFileSync(
      join(REPO_ROOT, "apps/web/src/app/api/logo/[symbol]/route.ts"),
      "utf8",
    );
    expect(route).toContain("images.financialmodelingprep.com");
    expect(route).not.toContain("financialmodelingprep.com/stable");
    expect(route).not.toContain("apikey");
  });
});
