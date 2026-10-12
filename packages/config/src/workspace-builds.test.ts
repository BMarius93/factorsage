import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Workspace package builds must be safe to repeat while other suites are running.
 *
 * Suites can run beside each other — `pnpm -r test`, two terminals, and `pnpm test` itself until it
 * was serialized (below) — and several test scripts rebuild the shared packages they depend on
 * (`pnpm --filter @intrinsic/contracts build && vitest run`) so they also work standalone. A plain
 * `tsc` truncates and rewrites every output file even when nothing changed, so a suite importing
 * `@intrinsic/contracts/dist` at that instant loaded an empty module — CI saw
 * `emptyStrategyDefinition is not a function` across a whole web test file.
 *
 * An incremental build whose build info lives beside its output rewrites nothing when the sources
 * are unchanged, which makes those repeated builds invisible to concurrent readers. Keeping the
 * build info inside `dist` means deleting `dist` also forces a full rebuild.
 */

function repositoryRoot(): string {
  let directory = resolve(__dirname);
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("pnpm-workspace.yaml not found");
    }
    directory = parent;
  }
  return directory;
}

/**
 * `pnpm test` runs the workspace's suites one package at a time.
 *
 * pnpm runs four packages at once by default. That put the web suite, which starts a jsdom worker
 * per core, beside `packages/stock-data`'s integration suites, which drive one real PostgreSQL and
 * one real Redis and whose tests are sized for a machine that is not otherwise saturated: measured
 * with only those two running, one persistence test went from 2.0 s to between 4.4 and 5.4 s, and
 * two `redis.integration` cases crossed the five-second limit in every run — so `pnpm test` failed
 * locally while each package passed alone, and stopped before `apps/api` and `apps/worker`.
 * Those two also ran together, on one test database.
 *
 * The contention is removed at its source, exactly as the PostgreSQL-backed packages already
 * serialize their own files (`fileParallelism: false`): a longer deadline would only move the
 * point at which the interference shows. `ai/workflows/validation.md` has the measurements.
 */
describe("the workspace test gate", () => {
  const scripts = (
    JSON.parse(
      readFileSync(join(repositoryRoot(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> }
  ).scripts;

  it("runs every workspace suite, one package at a time", () => {
    const test = scripts.test ?? "";
    expect(test).toMatch(/^pnpm -r\b/);
    expect(test).toMatch(/--workspace-concurrency=1\b/);
    expect(test).toMatch(/--if-present test$/);
  });
});

describe("workspace package builds", () => {
  const packagesDirectory = join(repositoryRoot(), "packages");
  const manifests = readdirSync(packagesDirectory)
    .map((name) => join(packagesDirectory, name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(path, "utf8")) as {
        name: string;
        scripts?: Record<string, string>;
      },
    }));

  it("finds the workspace packages", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(10);
  });

  it("builds every package incrementally, with its build info inside dist", () => {
    const offenders = manifests
      .filter(({ manifest }) => manifest.scripts?.build?.includes("tsc"))
      .filter(
        ({ manifest }) =>
          !/--incremental\b/.test(manifest.scripts!.build!) ||
          !/--tsBuildInfoFile dist\//.test(manifest.scripts!.build!),
      )
      .map(({ manifest }) => manifest.name);
    expect(offenders).toEqual([]);
  });
});
