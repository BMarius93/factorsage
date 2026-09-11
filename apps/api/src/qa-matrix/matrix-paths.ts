import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The repository root, found the same way `@intrinsic/config` finds it: by walking up to the
 * workspace marker. The matrix writes its reports and reads the migration directory relative to the
 * root rather than to a cwd that depends on which package the command was invoked from.
 */
export function repositoryRoot(startDirectory = process.cwd()): string {
  let directory = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return resolve(startDirectory);
    }
    directory = parent;
  }
}

/** Where a sweep's artefacts land. Git-ignored, like every other `.debug` output. */
export function matrixReportRoot(root = repositoryRoot()): string {
  return join(root, ".debug", "qa-matrix");
}
