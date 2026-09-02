import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  assertLiveFmpCredentials,
  isPlaceholderFmpKey,
  LIVE_FMP_OPT_IN_ENV,
  liveFmpTestsEnabled,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";

/**
 * Proof that live FMP suites cannot reach the network without an explicit opt-in.
 *
 * Entirely offline: it exercises the gate predicate over environment permutations and reads the
 * live suites as source text. It exists because the failure it guards against is silent — a live
 * suite that gates on `FMP_API_KEY` alone looks fine, passes review, and then fires real requests
 * the moment a developer with a key in `.env` runs `vitest` directly and bypasses the package
 * script's `--exclude`. That is exactly what happened once; this suite makes the recurrence a test
 * failure instead of a surprise invoice.
 */

/** Workspace root, found by walking up from the working directory. */
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

/** Every `*live-fmp*` test file in the repository, as repo-relative POSIX paths. */
function discoverLiveSuites(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(join(directory, entry.name));
        }
        continue;
      }
      if (
        entry.name.includes("live-fmp") &&
        entry.name.endsWith(".test.ts") &&
        !entry.name.includes("live-fmp-gate")
      ) {
        found.push(
          relative(REPO_ROOT, join(directory, entry.name)).split(sep).join("/"),
        );
      }
    }
  };
  walk(REPO_ROOT);
  return found.sort();
}

/**
 * The live suites this guard knows about. Discovery below asserts the repository contains exactly
 * these, so a newly added live suite fails here until it is protected too.
 */
const EXPECTED_LIVE_SUITES = [
  "apps/api/src/stocks/stocks.live-fmp.integration.test.ts",
  "packages/stock-data/src/live-fmp.integration.test.ts",
] as const;

function suiteSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** A key-shaped string: long enough and unlike any placeholder. */
const REAL_LOOKING_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

describe("live FMP opt-in gate", () => {
  it("authorizes only on the exact opt-in value", () => {
    expect(liveFmpTestsEnabled({ [LIVE_FMP_OPT_IN_ENV]: "1" })).toBe(true);

    // Everything else leaves the suites skipped. `true`/`yes`/`on` are the near-misses a
    // developer actually types, so they are pinned rather than assumed.
    for (const value of ["", "0", "true", "TRUE", "yes", "on", "2", " 1", "1 "]) {
      expect(liveFmpTestsEnabled({ [LIVE_FMP_OPT_IN_ENV]: value })).toBe(false);
    }
    expect(liveFmpTestsEnabled({})).toBe(false);
  });

  it("never treats an API key as authorization", () => {
    // The exact situation that caused the accidental live call: a real key in the environment,
    // no opt-in. The gate must stay closed.
    expect(liveFmpTestsEnabled({ FMP_API_KEY: REAL_LOOKING_KEY })).toBe(false);
    expect(
      liveFmpTestsEnabled({
        FMP_API_KEY: REAL_LOOKING_KEY,
        [LIVE_FMP_OPT_IN_ENV]: "0",
      }),
    ).toBe(false);
  });

  it("refuses to treat a missing or placeholder key as a credential", () => {
    for (const value of [
      undefined,
      "",
      "   ",
      "changeme",
      "CHANGEME",
      "your-api-key",
      "placeholder",
      "test",
      "<your-key>",
      "${FMP_API_KEY}",
    ]) {
      expect(isPlaceholderFmpKey(value)).toBe(true);
    }
    expect(isPlaceholderFmpKey(REAL_LOOKING_KEY)).toBe(false);
  });

  it("fails loudly when the opt-in is set without usable credentials", () => {
    expect(() =>
      assertLiveFmpCredentials({
        [LIVE_FMP_OPT_IN_ENV]: "1",
        FMP_API_KEY: "changeme",
      }),
    ).toThrow(/requires a real FMP_API_KEY/);
    expect(() =>
      assertLiveFmpCredentials({ [LIVE_FMP_OPT_IN_ENV]: "1" }),
    ).toThrow(/requires a real FMP_API_KEY/);

    // With real credentials it passes; without the opt-in it is a programming error to call at all.
    expect(() =>
      assertLiveFmpCredentials({
        [LIVE_FMP_OPT_IN_ENV]: "1",
        FMP_API_KEY: REAL_LOOKING_KEY,
      }),
    ).not.toThrow();
    expect(() =>
      assertLiveFmpCredentials({ FMP_API_KEY: REAL_LOOKING_KEY }),
    ).toThrow(/only be required after/);
  });

  it("keeps the gate closed for this very run", () => {
    // The deterministic gate must be off while `pnpm test` (or a direct vitest run) executes, so
    // no suite in this process is authorized to call the provider.
    expect(liveFmpTestsEnabled()).toBe(false);
  });

  it("finds exactly the live suites this guard protects", () => {
    // Real discovery, not a restated list: a new live-FMP suite added anywhere in the repository
    // fails here until it is added to EXPECTED_LIVE_SUITES and gated like the others.
    expect(discoverLiveSuites()).toEqual([...EXPECTED_LIVE_SUITES]);
  });

  it.each(EXPECTED_LIVE_SUITES)(
    "gates %s through the shared opt-in and nothing else",
    (relativePath) => {
      const source = suiteSource(relativePath);

      // The shared gate, not a hand-rolled copy that can drift.
      expect(source).toMatch(
        /const describeLive = liveFmpTestsEnabled\(\) \? describe : describe\.skip;/,
      );

      // No suite may condition execution on a key's presence: `runIf(FMP_API_KEY)` is the precise
      // bug this guard exists for.
      expect(source).not.toMatch(/\.(runIf|skipIf)\s*\(/);

      // Every top-level suite in the file goes through the gate, so a later `describe(...)` added
      // beside it cannot run ungated.
      expect(source).not.toMatch(/^describe\(/m);
      expect(source).toMatch(/^describeLive\(/m);
    },
  );
});
