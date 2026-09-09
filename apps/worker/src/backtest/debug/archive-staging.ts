import { createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { archiveJson, archiveNdjsonLine } from "./encoding.js";

/**
 * The filesystem half of a forensic archive: a private staging directory that becomes one `.zip`.
 *
 * Capture is **incremental**. A thirty-year run over a large list holds one calendar year of
 * projection in memory at a time by design, and an archive that buffered every year until the end
 * would put all thirty back — so each window's frames, trades and equity are written as the window
 * is consumed and dropped.
 *
 * Nothing is visible under the configured archive directory until the run is over. Staging happens
 * in a uniquely named sibling directory and the finished zip is written to a `.part` file and then
 * renamed, which is atomic within a filesystem. A worker killed mid-run therefore leaves a stray
 * staging directory — obvious, and never mistakable for a complete archive — rather than a
 * truncated `.zip` that looks like one.
 */
export class BacktestDebugArchiveStaging {
  /** Relative paths written so far, in write order. */
  private readonly entries = new Set<string>();

  private constructor(
    /** The configured output directory the finished archive lands in. */
    private readonly outputDirectory: string,
    /** This attempt's private staging root. */
    readonly root: string,
  ) {}

  /**
   * Opens staging for one attempt.
   *
   * The staging root sits under `.staging/` inside the archive directory so a stray one is easy to
   * find and delete, and carries a random suffix so two workers — or one worker retrying — never
   * share a directory.
   */
  static async open(
    outputDirectory: string,
    name: string,
  ): Promise<BacktestDebugArchiveStaging> {
    const staging = join(outputDirectory, ".staging");
    await mkdir(staging, { recursive: true });
    const root = await mkdtemp(join(staging, `${name}-`));
    return new BacktestDebugArchiveStaging(outputDirectory, root);
  }

  /** Writes one JSON document, replacing whatever was there. */
  async writeJson(relativePath: string, value: unknown): Promise<void> {
    const target = await this.prepare(relativePath);
    await writeFile(target, archiveJson(value), "utf8");
  }

  /**
   * Appends rows to an NDJSON file.
   *
   * NDJSON for the payloads whose size follows the run's length — equity, trades, and the funding
   * schedule — so a window can flush its own rows and forget them, and so a reviewer can stream a
   * thirty-year curve instead of parsing one enormous array.
   */
  async appendNdjson(
    relativePath: string,
    rows: readonly unknown[],
  ): Promise<void> {
    if (rows.length === 0) {
      // Still register the file, so an empty trade log is an empty file rather than a missing one:
      // "this run made no trades" and "the archive lost the trades" must not look the same.
      const target = await this.prepare(relativePath);
      await appendFile(target, "", "utf8");
      return;
    }
    const target = await this.prepare(relativePath);
    await appendFile(target, rows.map(archiveNdjsonLine).join(""), "utf8");
  }

  /**
   * Packs everything staged into one portable `.zip` and returns its path and size.
   *
   * Entries are added in sorted order so two archives of the same run differ only where the data
   * does, and the zip is built by a library rather than by shelling out — a `zip` binary is not
   * present on every machine this runs on, and the ones that have it disagree about flags.
   */
  async pack(
    archiveFileName: string,
  ): Promise<{ path: string; bytes: number }> {
    await mkdir(this.outputDirectory, { recursive: true });
    const destination = await this.uniqueDestination(archiveFileName);
    const partial = `${destination}.part`;

    const zip = new ZipFile();
    for (const relativePath of [...this.entries].sort()) {
      zip.addFile(
        join(this.root, ...relativePath.split("/")),
        relativePath,
        // A fixed timestamp: an archive of the same run should differ only where the run does, and
        // the manifest already records when the capture ran.
        { mtime: new Date(0), mode: 0o100644 },
      );
    }
    zip.end();

    await pipeline(zip.outputStream, createWriteStream(partial));
    await rename(partial, destination);

    return { path: destination, bytes: (await stat(destination)).size };
  }

  /** Removes the staging directory. Called after a successful pack, and after a failed capture. */
  async discard(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  /**
   * A destination that cannot overwrite an existing archive.
   *
   * The name already carries the run and the attempt, and an attempt is consumed exactly once, so
   * a collision should be impossible. It is guarded anyway because the cost is one `stat` and the
   * failure mode is losing forensic evidence of a different attempt.
   */
  private async uniqueDestination(fileName: string): Promise<string> {
    const extension = ".zip";
    const base = fileName.endsWith(extension)
      ? fileName.slice(0, -extension.length)
      : fileName;

    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = join(
        this.outputDirectory,
        suffix === 0 ? `${base}${extension}` : `${base}-${suffix}${extension}`,
      );
      try {
        await stat(candidate);
      } catch {
        return candidate;
      }
    }
    throw new Error(
      `Could not find a free archive name for ${base} in ${this.outputDirectory}`,
    );
  }

  private async prepare(relativePath: string): Promise<string> {
    assertRelative(relativePath);
    const target = join(this.root, ...relativePath.split("/"));
    if (!this.entries.has(relativePath)) {
      await mkdir(dirname(target), { recursive: true });
      this.entries.add(relativePath);
    }
    return target;
  }
}

/**
 * Refuses anything that could escape the staging root.
 *
 * Archive paths are built from run data — symbols and ids — and a path is the one place where a
 * value that is merely odd becomes a write somewhere else on the disk.
 */
function assertRelative(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe debug archive path '${relativePath}'`);
  }
}
