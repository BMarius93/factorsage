import { open as openZip, type Entry, type ZipFile } from "yauzl";

/**
 * Reads a finished archive back into memory, for tests only.
 *
 * A test that asserted against the staging directory would prove nothing about the artifact a
 * developer actually hands to a reviewer: the zip is the deliverable, so the assertions are made
 * against the zip.
 */
export function readArchiveEntries(path: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    openZip(path, { lazyEntries: true }, (err, zip: ZipFile) => {
      if (err) {
        reject(err);
        return;
      }
      const entries = new Map<string, string>();
      zip.on("entry", (entry: Entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            reject(streamErr);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** One JSON document out of an archive. */
export function archiveJsonEntry<T = Record<string, unknown>>(
  entries: ReadonlyMap<string, string>,
  name: string,
): T {
  const raw = entries.get(name);
  if (raw === undefined) {
    throw new Error(
      `Archive has no '${name}'. It holds: ${[...entries.keys()].sort().join(", ")}`,
    );
  }
  return JSON.parse(raw) as T;
}

/** One NDJSON document out of an archive, as parsed rows. */
export function archiveNdjsonEntry<T = Record<string, unknown>>(
  entries: ReadonlyMap<string, string>,
  name: string,
): T[] {
  const raw = entries.get(name);
  if (raw === undefined) {
    throw new Error(
      `Archive has no '${name}'. It holds: ${[...entries.keys()].sort().join(", ")}`,
    );
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
