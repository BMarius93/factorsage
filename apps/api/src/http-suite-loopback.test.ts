import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every suite that drives the application over HTTP binds it to loopback.
 *
 * Handed an application that is not listening, supertest starts it on a *wildcard* ephemeral port
 * for each request. On macOS that bind succeeds even when another process already holds the same
 * port on `127.0.0.1`, and the request — sent to `127.0.0.1` — is then delivered to that process.
 * A developer's editor keeps two such listeners open: one answers `404`, the other accepts and
 * never answers, after which every later test in the file runs into its five-second limit. That
 * made `pnpm test` fail at random in whichever suite drew the port (`monitors` with a `404` and
 * `stocks.search` with five timeouts in one run on 2026-10-12), never twice in the same place and
 * never in CI.
 *
 * `await app.listen(0, "127.0.0.1")` removes the mechanism: a bind to one address is never given a
 * port that address already has in use, and supertest uses the address a listening server reports.
 * `ai/workflows/validation.md` records the investigation. This reads the suites as source, as the
 * other coverage tests here do, so a new suite cannot bring the hazard back unnoticed.
 */
const SOURCE = __dirname;
const LOOPBACK_LISTEN = /\.listen\(0, "127\.0\.0\.1"\)/g;

function testFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return testFiles(path);
    }
    return name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("suites that drive the application over HTTP", () => {
  const suites = testFiles(SOURCE)
    .map((path) => ({
      name: relative(SOURCE, path),
      source: readFileSync(path, "utf8"),
    }))
    .filter(
      ({ name, source }) =>
        name !== "http-suite-loopback.test.ts" &&
        /from "supertest"/.test(source),
    );

  it("are found", () => {
    expect(suites.length).toBeGreaterThanOrEqual(30);
  });

  it("never leave an application unlistened", () => {
    expect(
      suites
        .filter(({ source }) => /\.init\(\)/.test(source))
        .map(({ name }) => name),
    ).toEqual([]);
  });

  it("listen on loopback only, once for every application they create", () => {
    const offenders = suites
      .filter(({ source }) => {
        const created = source.match(/createNestApplication\(/g)?.length ?? 0;
        const loopback = source.match(LOOPBACK_LISTEN)?.length ?? 0;
        const anyListen = source.match(/\.listen\(/g)?.length ?? 0;
        return created === 0 || loopback !== created || anyListen !== loopback;
      })
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
