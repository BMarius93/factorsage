import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Workspace package builds must be safe to repeat while other suites are running.
 *
 * `pnpm test` runs every workspace suite concurrently, and several test scripts rebuild the shared
 * packages they depend on (`pnpm --filter @intrinsic/contracts build && vitest run`) so they also
 * work standalone. A plain `tsc` truncates and rewrites every output file even when nothing
 * changed, so a suite importing `@intrinsic/contracts/dist` at that instant loaded an empty module
 * — CI saw `emptyStrategyDefinition is not a function` across a whole web test file.
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
