// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_CACHE_BOUNDARY_MARKER,
  purgeDevCacheFromBeforeTheBoundary,
  startNextDev,
} from "./next-dev-process";

/**
 * The process boundary itself: a real child is started through `startNextDev` and reports the
 * environment it was actually given. A unit test of the allowlist proves what the function
 * returns; only this proves what crosses into the process.
 */

const WEB_ROOT = resolve(__dirname, "..");
const REPOSITORY_ROOT = resolve(WEB_ROOT, "../..");

const PASSWORDS = {
  QA_BILLING_PASSWORD: "leak-billing-4be19a",
  QA_FREE_PASSWORD: "leak-free-4be19a",
  QA_STARTER_PASSWORD: "leak-starter-4be19a",
  QA_USER_PASSWORD: "leak-user-4be19a",
  QA_ADMIN_PASSWORD: "leak-admin-4be19a",
  QA_DOWNGRADED_PASSWORD: "leak-downgraded-4be19a",
};

/** Runs a child that prints its own environment, and returns what it printed. */
async function environmentSeenByChild(
  parentEnvironment: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const child = startNextDev({
    parentEnvironment,
    command: [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify(process.env))",
    ],
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((done) => {
    child.on("exit", done);
  });
  expect(code).toBe(0);
  return JSON.parse(output) as Record<string, string>;
}

describe("startNextDev", () => {
  it("starts a process that holds none of its parent's test passwords", async () => {
    const seen = await environmentSeenByChild({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
      AUTH_JWT_SECRET: "leak-jwt-4be19a",
      DATABASE_URL: "postgresql://user:leak-db-4be19a@localhost/app",
      ...PASSWORDS,
    });

    for (const [name, value] of Object.entries(PASSWORDS)) {
      expect(Object.keys(seen), name).not.toContain(name);
      expect(JSON.stringify(seen), name).not.toContain(value);
    }
    expect(JSON.stringify(seen)).not.toContain("4be19a");
    // What it is meant to have did arrive.
    expect(seen.PATH).toBe(process.env.PATH);
    expect(seen.NEXT_PUBLIC_API_BASE_URL).toBe("http://localhost:3001");
  });

  it("does not fall back to this process's own environment", async () => {
    // The mistake being guarded against: a spawn with no `env` inherits everything. The variable
    // is in this process and not in the environment the child is to be built from.
    process.env.QA_BILLING_PASSWORD = PASSWORDS.QA_BILLING_PASSWORD;
    process.env.NEXT_DEV_BOUNDARY_PROBE = "inherited-by-accident";
    try {
      const seen = await environmentSeenByChild({ PATH: process.env.PATH });

      expect(seen.QA_BILLING_PASSWORD).toBeUndefined();
      expect(seen.NEXT_DEV_BOUNDARY_PROBE).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("inherited-by-accident");
    } finally {
      delete process.env.QA_BILLING_PASSWORD;
      delete process.env.NEXT_DEV_BOUNDARY_PROBE;
    }
  });
});

describe("the dev server's entry point", () => {
  const read = (path: string) =>
    readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
  const scriptsOf = (path: string) =>
    (JSON.parse(read(path)) as { scripts: Record<string, string> }).scripts;
  const withoutComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("is the only thing that starts next dev", () => {
    const web = scriptsOf("apps/web/package.json");
    const root = scriptsOf("package.json");

    expect(web.dev).toBe("tsx dev-server/next-dev.ts");
    expect(root["dev:web"]).toBe("pnpm --filter @intrinsic/web dev");
    // No script anywhere runs `next dev` directly, which would inherit the whole environment.
    for (const [name, script] of [
      ...Object.entries(web),
      ...Object.entries(root),
    ]) {
      expect(script, name).not.toMatch(/\bnext\s+dev\b/);
    }
  });

  it("is what the hermetic launcher and the cloud stack script both go through", () => {
    // Both start the web process as `pnpm dev:web`, so neither can hand next dev anything the
    // entry point does not let through.
    expect(read("apps/api/src/e2e-stack/launch.ts")).toMatch(
      /web:\s*\["dev:web"\]/,
    );
    const stack = read("scripts/cloud/stack.sh");
    expect(stack).toMatch(/start_role web pnpm dev:web:e2e/);
    expect(stack).toMatch(/start_role web pnpm dev:web &&/);
    expect(scriptsOf("package.json")["dev:web:e2e"]).toMatch(/e2e:launch web$/);
  });

  it("builds the child's environment in exactly one place", () => {
    const entry = withoutComments(read("apps/web/dev-server/next-dev.ts"));
    const processModule = withoutComments(
      read("apps/web/dev-server/next-dev-process.ts"),
    );

    // The entry point starts nothing itself…
    expect(entry).not.toMatch(/child_process|\bspawn\b|\bexec\b|\bfork\b/);
    expect(entry).toMatch(/startNextDev\(/);
    // …and the one spawn there is always gives the child the constructed environment.
    expect(processModule.match(/\bspawn\(/g)).toHaveLength(1);
    expect(processModule).toMatch(
      /env:\s*nextDevEnvironment\(input\.parentEnvironment\)/,
    );
    expect(processModule).not.toMatch(/process\.env/);
  });
});

describe("purgeDevCacheFromBeforeTheBoundary", () => {
  const roots: string[] = [];

  function webRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "next-dev-boundary-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const cache = (root: string) => join(root, ".next", "dev", "cache");
  const turbopack = (root: string) => join(cache(root), "turbopack");
  const marker = (root: string) => join(cache(root), DEV_CACHE_BOUNDARY_MARKER);

  it("deletes a cache written before the boundary existed, once", () => {
    const root = webRoot();
    mkdirSync(turbopack(root), { recursive: true });
    writeFileSync(
      join(turbopack(root), "00000001.sst"),
      "QA_USER_PASSWORD=leaked",
    );

    expect(purgeDevCacheFromBeforeTheBoundary(root)).toBe("purged");

    expect(existsSync(turbopack(root))).toBe(false);
    expect(existsSync(marker(root))).toBe(true);
  });

  it("leaves a cache alone once the marker says it was created behind the boundary", () => {
    const root = webRoot();
    expect(purgeDevCacheFromBeforeTheBoundary(root)).toBe("clean");
    // What the dev server then writes.
    mkdirSync(turbopack(root), { recursive: true });
    writeFileSync(join(turbopack(root), "00000001.sst"), "compiled");

    expect(purgeDevCacheFromBeforeTheBoundary(root)).toBe("clean");

    expect(readFileSync(join(turbopack(root), "00000001.sst"), "utf8")).toBe(
      "compiled",
    );
  });

  it("writes the marker on a checkout that has never run the dev server", () => {
    const root = webRoot();
    expect(purgeDevCacheFromBeforeTheBoundary(root)).toBe("clean");
    expect(existsSync(marker(root))).toBe(true);
    expect(existsSync(turbopack(root))).toBe(false);
  });

  it("touches nothing but the Turbopack development cache", () => {
    const root = webRoot();
    mkdirSync(turbopack(root), { recursive: true });
    mkdirSync(join(root, ".next", "server"), { recursive: true });
    writeFileSync(join(root, ".next", "BUILD_ID"), "build");
    writeFileSync(join(root, ".next", "server", "page.js"), "page");
    writeFileSync(join(cache(root), ".rscinfo"), "rsc");

    purgeDevCacheFromBeforeTheBoundary(root);

    expect(readFileSync(join(root, ".next", "BUILD_ID"), "utf8")).toBe("build");
    expect(readFileSync(join(root, ".next", "server", "page.js"), "utf8")).toBe(
      "page",
    );
    expect(readFileSync(join(cache(root), ".rscinfo"), "utf8")).toBe("rsc");
  });
});
