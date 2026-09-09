import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveNumber, archiveNumbers, safeFileSymbol } from "./encoding.js";
import { scrubSecrets } from "./redaction.js";

/**
 * The forensic archive is developer infrastructure, and the boundary that keeps it that way is a
 * property of the repository rather than of any one module: nothing a user can reach may know it
 * exists.
 */
describe("the debug archive stays out of the product", () => {
  it("is not referenced by the web app, the API or the wire contracts", async () => {
    const root = repositoryRoot();
    const markers = [
      "debugArchive",
      "BACKTEST_DEBUG_ARCHIVE",
      "archiveSchemaVersion",
      "backtest-debug-archive",
    ];

    const offenders: string[] = [];
    for (const area of [
      "apps/web/src",
      "apps/api/src",
      "packages/contracts/src",
    ]) {
      for await (const file of sourceFiles(join(root, area))) {
        const contents = await readFile(file, "utf8");
        if (markers.some((marker) => contents.includes(marker))) {
          offenders.push(file.slice(root.length + 1));
        }
      }
    }

    // A `debug` field on the public Backtest contract, or archive configuration read by the API,
    // would make this a product feature by accident. It is worker-only on purpose.
    expect(offenders).toEqual([]);
  });
});

/**
 * The encoding rule the whole archive rests on, asserted directly rather than only through a run.
 *
 * `NaN` is the engine's single representation of an absent value and `0` is a real reading, so the
 * two must never collapse into each other on the way to JSON.
 */
describe("archive number encoding", () => {
  it("turns an absent value into null and leaves a real zero alone", () => {
    expect(archiveNumber(Number.NaN)).toBeNull();
    expect(archiveNumber(null)).toBeNull();
    expect(archiveNumber(undefined)).toBeNull();
    expect(archiveNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(archiveNumber(Number.NEGATIVE_INFINITY)).toBeNull();

    // The cases that a `value || null` or a `value ?? -1` would silently corrupt: an RSI of 0 and
    // a Margin of Safety of 0 are real readings, and a negative value is ordinary.
    expect(archiveNumber(0)).toBe(0);
    expect(archiveNumber(-0)).toBe(-0);
    expect(archiveNumber(-12.5)).toBe(-12.5);
    expect(archiveNumber(1e-12)).toBe(1e-12);
  });

  it("applies the same rule across a column, position by position", () => {
    const column = Float64Array.from([Number.NaN, 0, 42.5, Number.NaN, -3]);

    expect(archiveNumbers(column)).toEqual([null, 0, 42.5, null, -3]);
    // And the result is JSON a reviewer can actually parse.
    expect(JSON.parse(JSON.stringify(archiveNumbers(column)))).toEqual([
      null,
      0,
      42.5,
      null,
      -3,
    ]);
  });

  it("keeps a symbol usable as a file name", () => {
    expect(safeFileSymbol("AAPL")).toBe("AAPL");
    expect(safeFileSymbol("BRK.B")).toBe("BRK.B");
    expect(safeFileSymbol("../etc/passwd")).toBe(".._etc_passwd");
    expect(safeFileSymbol("")).toBe("SECURITY");
  });
});

/**
 * The one place the archive writes text it did not construct field by field. Everything else is an
 * allowlist, which is why this is the only thing that needs scrubbing.
 */
describe("failure-message scrubbing", () => {
  it("removes provider, database and Redis credentials", () => {
    expect(
      scrubSecrets(
        "GET https://financialmodelingprep.com/api/v3/x?apikey=secret-key failed",
      ),
    ).not.toContain("secret-key");
    expect(
      scrubSecrets("connect postgresql://user:hunter2@localhost:5432/db"),
    ).not.toContain("hunter2");
    expect(scrubSecrets("redis://:pw@localhost:6379 refused")).not.toContain(
      "pw@localhost",
    );
    expect(scrubSecrets('apiKey: "abc123def456"')).not.toContain(
      "abc123def456",
    );
    expect(
      scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"),
    ).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("leaves an ordinary diagnostic message readable", () => {
    const message =
      "The projection for 2021 could not be read: 0 rows for security-aaa";
    expect(scrubSecrets(message)).toBe(message);
  });
});

function repositoryRoot(): string {
  let directory = resolve(process.cwd());
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate the repository root");
    }
    directory = parent;
  }
  return directory;
}

async function* sourceFiles(root: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") {
      continue;
    }
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}
