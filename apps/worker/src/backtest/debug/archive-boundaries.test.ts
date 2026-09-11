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
  const MARKERS = [
    "debugArchive",
    "BACKTEST_DEBUG_ARCHIVE",
    "archiveSchemaVersion",
    "backtest-debug-archive",
  ];

  it("is not referenced by the web app or the wire contracts", async () => {
    const root = repositoryRoot();
    const offenders: string[] = [];
    for (const area of ["apps/web/src", "packages/contracts/src"]) {
      for await (const file of sourceFiles(join(root, area))) {
        const contents = await readFile(file, "utf8");
        if (MARKERS.some((marker) => contents.includes(marker))) {
          offenders.push(file.slice(root.length + 1));
        }
      }
    }
    // A `debug` field on the public Backtest contract, or anything in the browser that knows an
    // archive exists, would make this a product feature by accident.
    expect(offenders).toEqual([]);
  });

  /**
   * The property that actually matters for the API, stated as what it is.
   *
   * "No file under `apps/api/src`" was a proxy for it, and the proxy broke the moment developer-only
   * tooling landed in that tree — `apps/api/src/qa-matrix`, the QA validation-matrix runner, spawns
   * the real worker with `BACKTEST_DEBUG_ARCHIVE=full` for a handful of golden combinations and
   * reads the archives back. That is a `tsx` command a developer runs, not a route a user can
   * reach, and forbidding it would have said nothing about the product.
   *
   * So the boundary is drawn where it belongs: the **running API's own module graph**, walked from
   * `app.module.ts` through its relative imports. Nothing the Nest application can reach may mention
   * the archive — which is the guarantee the original test was written to protect, made exact rather
   * than approximated by a directory name.
   */
  it("is unknown to the API's own application graph", async () => {
    const root = repositoryRoot();
    const graph = await apiApplicationGraph(root);
    const offenders: string[] = [];
    for (const [file, contents] of graph) {
      if (MARKERS.some((marker) => contents.includes(marker))) {
        offenders.push(file.slice(root.length + 1));
      }
    }
    expect(graph.size).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  /**
   * And the developer tooling that is allowed to know stays developer tooling: the API application
   * may not reach it, and it may not declare a route.
   *
   * The `qa-matrix` tree holds `tsx` entry points — the fixture seeder and the validation-matrix
   * runner — which is exactly why they are outside the graph above rather than exempted from it.
   */
  it("keeps the QA matrix tooling out of the request path", async () => {
    const root = repositoryRoot();
    const offenders: string[] = [];

    for (const [file, contents] of await apiApplicationGraph(root)) {
      if (/from\s+"[^"]*qa-matrix[^"]*"/.test(contents)) {
        offenders.push(
          `${file.slice(root.length + 1)} is in the API graph and imports the QA matrix tooling`,
        );
      }
    }
    for await (const file of sourceFiles(join(root, "apps/api/src/qa-matrix"))) {
      const contents = await readFile(file, "utf8");
      if (contents.includes("@Controller")) {
        offenders.push(`${file.slice(root.length + 1)} declares a controller`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Every source file the Nest application can reach from its root module, with its contents.
 *
 * Walked through relative imports only, which is all the API's own graph is built from: a workspace
 * package is a different boundary with its own rules.
 */
async function apiApplicationGraph(
  root: string,
): Promise<Map<string, string>> {
  const graph = new Map<string, string>();
  const queue = [join(root, "apps/api/src/app.module.ts")];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (graph.has(file)) {
      continue;
    }
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      continue;
    }
    graph.set(file, contents);
    for (const specifier of relativeImports(contents)) {
      const resolved = await resolveModule(dirname(file), specifier);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }
  return graph;
}

/** Relative import specifiers, which is all the API's own graph is built from. */
function relativeImports(contents: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s+"(\.[^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

async function resolveModule(
  from: string,
  specifier: string,
): Promise<string | null> {
  const base = resolve(from, specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

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
