import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Which build produced an archive, when that is knowable locally.
 *
 * Read straight out of `.git` rather than by running `git`: a subprocess is a portability and
 * availability problem (a container image usually has no git binary), and the two files this needs
 * are a documented part of the repository format. Anything unreadable is reported as `null` — an
 * archive must never fail to exist because a checkout looked unusual.
 */
export type ArchiveGitMetadata = {
  commit: string | null;
  branch: string | null;
};

const UNKNOWN: ArchiveGitMetadata = { commit: null, branch: null };

export function readGitMetadata(startDirectory: string): ArchiveGitMetadata {
  try {
    const gitDirectory = findGitDirectory(resolve(startDirectory));
    if (!gitDirectory) {
      return UNKNOWN;
    }

    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();

    // A detached HEAD holds the commit itself; otherwise it names the ref the commit lives in.
    if (!head.startsWith("ref:")) {
      return { commit: isSha(head) ? head : null, branch: null };
    }

    const ref = head.slice(4).trim();
    const branch = ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : ref;

    return { commit: readRef(gitDirectory, ref), branch };
  } catch {
    return UNKNOWN;
  }
}

/** The commit a ref points at: its loose file, else the packed-refs table, else null. */
function readRef(gitDirectory: string, ref: string): string | null {
  try {
    const loose = readFileSync(join(gitDirectory, ref), "utf8").trim();
    if (isSha(loose)) {
      return loose;
    }
  } catch {
    // Packed instead, which is normal in a long-lived checkout.
  }

  try {
    const packed = readFileSync(join(gitDirectory, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && sha && isSha(sha)) {
        return sha;
      }
    }
  } catch {
    // No packed-refs file.
  }

  return null;
}

/** The nearest `.git`, walking up. Worktrees store a `gitdir:` pointer file rather than a folder. */
function findGitDirectory(startDirectory: string): string | null {
  let directory = startDirectory;
  while (true) {
    const candidate = join(directory, ".git");
    try {
      const contents = readFileSync(join(candidate, "HEAD"), "utf8");
      if (contents.length > 0) {
        return candidate;
      }
    } catch {
      try {
        const pointer = readFileSync(candidate, "utf8").trim();
        if (pointer.startsWith("gitdir:")) {
          return resolve(directory, pointer.slice("gitdir:".length).trim());
        }
      } catch {
        // Not a checkout at this level.
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}
