import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The lines the live FMP run must not cross, read from the source.
 *
 * The behavioural suites prove what a run does. This proves what the code *cannot* do — the part a
 * passing run never shows, and the part a later refactor is most likely to undo without anybody
 * noticing:
 *
 * - the live credential is read in one place, under one name, and reaches one process;
 * - that process is started with a constructed environment and never loads `.env`;
 * - the run composes the per-security loaders and nothing that widens the symbol universe;
 * - nothing in it writes provider data to the database except the loaders it calls;
 * - no script, hook or workflow authorizes a run for a whole session or for CI.
 */

const REPOSITORY_ROOT = resolve(__dirname, "../../../..");
const API_SRC = resolve(__dirname, "..");
const LIVE_DIRECTORY = resolve(API_SRC, "fmp-live");
const LAUNCHER = resolve(API_SRC, "fmp-live.ts");

const SKIPPED = new Set([
  "node_modules",
  "dist",
  ".git",
  ".next",
  ".cloud",
  ".e2e-stack",
  "playwright-report",
  "test-results",
  "artifacts",
]);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function filesUnder(directory: string, extensions: RegExp): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED.has(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...filesUnder(path, extensions));
    } else if (extensions.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

const repositoryPath = (path: string) =>
  relative(REPOSITORY_ROOT, path).split(sep).join("/");

/** Comments describe the rules in the very words the rules forbid, so they are not code. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const isTest = (path: string) => /\.test\.tsx?$|\.test-helper\.ts$/.test(path);

/** The live run itself: its modules and the launcher. Tests excluded. */
const LIVE_FILES = [
  ...filesUnder(LIVE_DIRECTORY, /\.ts$/).filter((path) => !isTest(path)),
  LAUNCHER,
];

/** Every source file of the product and its tooling, tests excluded. */
const PRODUCT_FILES = ["apps", "packages"].flatMap((root) =>
  filesUnder(
    resolve(REPOSITORY_ROOT, root),
    /\.(ts|tsx|mts|cts|js|mjs|cjs)$/,
  ).filter((path) => !isTest(path)),
);

describe("the live FMP credential", () => {
  it("is named in exactly one place and read in exactly two", () => {
    // The literal name: its definition, and nowhere else in code.
    const literal = PRODUCT_FILES.filter((path) =>
      /LIVE_FMP_API_KEY(?!_ENV)/.test(withoutComments(read(path))),
    ).map(repositoryPath);
    expect(literal).toEqual(["packages/testing/src/live-fmp.ts"]);

    // The constant: the launcher's environment module reads the variable, and the hermetic E2E
    // overlay blanks it for every stack process. Nothing else can even refer to it.
    const constant = PRODUCT_FILES.filter((path) =>
      /\bLIVE_FMP_API_KEY_ENV\b|\bLIVE_FMP_RUN_VARIABLES\b/.test(
        withoutComments(read(path)),
      ),
    ).map(repositoryPath);
    expect(constant.sort()).toEqual([
      "apps/api/src/fmp-live/fmp-live-environment.ts",
      "packages/testing/src/e2e-stack.ts",
      "packages/testing/src/live-fmp.ts",
    ]);
  });

  it("is unknown to the application's configuration", () => {
    const config = read(
      resolve(REPOSITORY_ROOT, "packages/config/src/index.ts"),
    );
    expect(config).not.toContain("LIVE_FMP");
    expect(config).not.toContain("RUN_LIVE_FMP_HYDRATION");
    // The name the application reads is still the only one `getFmpConfig` knows.
    expect(config).toContain('apiKey: required(env, "FMP_API_KEY")');
  });

  it("is mapped onto FMP_API_KEY in one function", () => {
    const assigning = LIVE_FILES.filter((path) =>
      /\bFMP_API_KEY\s*=[^=]/.test(withoutComments(read(path))),
    ).map(repositoryPath);
    expect(assigning).toEqual([
      "apps/api/src/fmp-live/fmp-live-environment.ts",
    ]);
    expect(
      withoutComments(read(resolve(LIVE_DIRECTORY, "fmp-live-environment.ts"))),
    ).toContain("environment.FMP_API_KEY = input.key;");
  });

  it("is never printed", () => {
    for (const path of LIVE_FILES) {
      const source = withoutComments(read(path));
      // Nothing logs an environment, a configuration object or the key itself.
      expect(source, repositoryPath(path)).not.toMatch(
        /console\.\w+\([^)]*\b(process\.env|environment|config|key)\b[^)]*\)/,
      );
      expect(source, repositoryPath(path)).not.toMatch(
        /logger\.\w+\(\{[^}]*\b(apiKey|key|environment)\b/,
      );
    }
  });
});

describe("the process that performs a live run", () => {
  const launcher = withoutComments(read(LAUNCHER));
  const starter = withoutComments(
    read(resolve(LIVE_DIRECTORY, "fmp-live-process.ts")),
  );

  it("is the only thing the launcher starts, through the one starter", () => {
    expect(launcher).toContain("startLiveFmpChild({");
    expect(launcher).not.toMatch(/\bspawn\w*\(|\bexec\w*\(|\bfork\(/);
    expect(launcher).toContain('"fmp-live-child.ts"');
    // The starter spawns once, with the constructed environment and no other.
    expect(starter.match(/\bspawn\(/g)).toHaveLength(1);
    expect(starter).toMatch(/env:\s*liveFmpChildEnvironment\(/);
    for (const source of [launcher, starter]) {
      expect(source).not.toMatch(/env:\s*process\.env/);
      expect(source).not.toMatch(/\.\.\.\s*process\.env/);
    }
    // No other file in the live run starts a process at all.
    for (const path of LIVE_FILES) {
      if (path.endsWith("fmp-live-process.ts")) {
        continue;
      }
      expect(withoutComments(read(path)), repositoryPath(path)).not.toMatch(
        /from "node:child_process"/,
      );
    }
  });

  it("checks the opt-in and the target before it looks for the key", () => {
    const parse = launcher.indexOf("parseLiveFmpArguments(");
    const env = launcher.indexOf("loadRootEnv()");
    const optIn = launcher.indexOf("assertLiveFmpOptIn(");
    const target = launcher.indexOf("resolveLiveFmpTarget(");
    const key = launcher.indexOf("resolveLiveFmpKey(");
    const start = launcher.indexOf("startLiveFmpChild({");
    for (const index of [parse, env, optIn, target, key, start]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(parse).toBeLessThan(env);
    expect(env).toBeLessThan(optIn);
    expect(optIn).toBeLessThan(target);
    expect(target).toBeLessThan(key);
    expect(key).toBeLessThan(start);
  });

  it("never loads the repository's .env itself", () => {
    // The launcher reads `.env`; the child's environment is the allowlist and nothing more.
    for (const path of LIVE_FILES) {
      const source = withoutComments(read(path));
      if (path === LAUNCHER) {
        expect(source).toContain("loadRootEnv()");
        continue;
      }
      expect(source, repositoryPath(path)).not.toMatch(
        /loadRootEnv|loadEnvFile|dotenv|parseEnv/,
      );
    }
  });

  it("re-checks everything the launcher checked", () => {
    const child = withoutComments(
      read(resolve(LIVE_DIRECTORY, "fmp-live-child.ts")),
    );
    expect(child).toContain("parseLiveFmpArguments(process.argv.slice(2))");
    expect(child).toContain("assertLiveFmpChildEnvironment(process.env");
    expect(child.indexOf("assertLiveFmpChildEnvironment(")).toBeLessThan(
      child.indexOf("createLiveFmpRuntime("),
    );
  });
});

describe("what a live run is composed of", () => {
  const sources = LIVE_FILES.map(
    (path) => [repositoryPath(path), withoutComments(read(path))] as const,
  );

  it("builds one guarded client, on the shared gate, pinned to the provider's endpoint", () => {
    const constructing = sources
      .filter(([, source]) => source.includes("new FmpClient("))
      .map(([path]) => path);
    expect(constructing).toEqual(["apps/api/src/fmp-live/fmp-live-runtime.ts"]);
    const runtime = sources.find(([path]) =>
      path.endsWith("fmp-live-runtime.ts"),
    )?.[1] as string;
    expect(runtime.match(/new FmpClient\(/g)).toHaveLength(1);
    expect(runtime.match(/new RedisFmpRequestGate\(/g)).toHaveLength(1);
    expect(runtime).toMatch(/guard,\s*\},\s*\);/);
    expect(runtime).toContain("new FmpSecurityScope(input.symbols, {");
    expect(runtime).toContain("maxSecurities: LIVE_FMP_MAX_SECURITIES");
    expect(runtime).toContain("new LiveFmpRunGuard(scope, budget)");
    // Never a second endpoint: the base URL the application honours is not carried over.
    expect(runtime).not.toContain("baseUrl");
    expect(runtime).not.toContain("FMP_BASE_URL");
  });

  it.each([
    [
      "the benchmark loader",
      /CanonicalBenchmarkDataService|getBenchmarkDailyPrices|BENCHMARK_CATALOG/,
    ],
    ["the trading calendar", /CachedTradingCalendar|getExchangeHolidays/],
    ["current quotes", /getCurrentQuotes|getCurrentObservations/],
    ["the exchange-wide screener", /\.getStockUniverse\(/],
    [
      "a Monitor's data preparation",
      /prepareMonitorEvaluationData|readMonitorEvaluationFrame/,
    ],
    [
      "a backtest's data preparation",
      /prepareDailyEvaluationData|readDailyEvaluationFrame|getDailyEvaluationFrame/,
    ],
    [
      "a list of securities from somewhere else",
      /QA_MATRIX_SECURITIES|findSecuritiesByIds|stockList|builtin/i,
    ],
    ["a worker", /@intrinsic\/worker|worker\/src/],
  ])("never reaches for %s", (_label, pattern) => {
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(pattern);
    }
  });

  it("calls the canonical loaders for its data, and only these", () => {
    const calls = new Set<string>();
    for (const [, source] of sources) {
      for (const [, method] of source.matchAll(
        /\b(?:stockData|alternativeData)\s*\.\s*(\w+)\(/g,
      )) {
        calls.add(method as string);
      }
    }
    expect([...calls].sort()).toEqual([
      "ensureIngested",
      "getDailyDerivedState",
      "getDailyValuationRatio",
      "getSecurity",
    ]);
  });

  it("writes nothing to the database itself", () => {
    // Every row a run stores is written by a loader it called. The run's own Prisma use is the
    // read-back of counts and date bounds, and nothing else.
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(
        /\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(/,
      );
      expect(source, path).not.toMatch(/\$executeRaw|\$queryRaw|\$transaction/);
    }
    const prismaUsers = sources
      .filter(([, source]) => /\bprisma\.\w+\.\w+\(/.test(source))
      .map(([path]) => path);
    expect(prismaUsers).toEqual(["apps/api/src/fmp-live/fmp-live-coverage.ts"]);
    const coverage = sources.find(([path]) =>
      path.endsWith("fmp-live-coverage.ts"),
    )?.[1] as string;
    expect(
      [...coverage.matchAll(/\bprisma\.\w+\.(\w+)\(/g)].map(
        (match) => match[1],
      ),
    ).toEqual(
      expect.arrayContaining(["count", "aggregate", "groupBy", "findMany"]),
    );
    expect(coverage).not.toMatch(
      /\braw\b|payload|select:\s*\{[^}]*\b(close|open|price|values)\b/,
    );
  });

  it("admits an unknown symbol through the catalog service, not around it", () => {
    const identity = sources.find(([path]) =>
      path.endsWith("fmp-live-identity.ts"),
    )?.[1] as string;
    expect(identity).toContain("new CanonicalSecurityCatalogService(");
    expect(identity).not.toMatch(
      /createSecurityCatalogEntries|updateSecurityCatalogEntry/,
    );
    // One provider method, and it is the per-security one.
    expect(
      [...identity.matchAll(/\bprovider\.(\w+)\(/g)].map((match) => match[1]),
    ).toEqual(["getProfile"]);
  });
});

describe("how a live run can be started", () => {
  const packageScripts = (path: string): Record<string, string> =>
    (
      JSON.parse(read(resolve(REPOSITORY_ROOT, path))) as {
        scripts: Record<string, string>;
      }
    ).scripts;

  it("has one script, and no other script sets the opt-in or names the child", () => {
    const root = packageScripts("package.json");
    const api = packageScripts("apps/api/package.json");
    expect(root["fmp:live"]).toBe(
      "pnpm build:packages && pnpm --filter @intrinsic/api fmp:live",
    );
    expect(api["fmp:live"]).toBe("tsx src/fmp-live.ts");
    expect(root["cloud:fmp"]).toBe("bash scripts/cloud/fmp-live.sh");

    for (const path of [
      "package.json",
      "apps/api/package.json",
      "apps/worker/package.json",
      "apps/web/package.json",
    ]) {
      for (const [name, script] of Object.entries(packageScripts(path))) {
        expect(script, `${path} ${name}`).not.toContain(
          "RUN_LIVE_FMP_HYDRATION",
        );
        expect(script, `${path} ${name}`).not.toContain("LIVE_FMP_API_KEY");
        expect(script, `${path} ${name}`).not.toContain("fmp-live-child");
      }
    }
    // The ordinary gate and the dev commands do not run it.
    for (const name of [
      "test",
      "build",
      "typecheck",
      "lint",
      "dev:api",
      "dev:worker",
      "dev:web",
      "test:e2e",
    ]) {
      expect(root[name], name).not.toContain("fmp:live");
    }
  });

  it("is never authorized by CI or by a session hook", () => {
    const workflows = filesUnder(
      resolve(REPOSITORY_ROOT, ".github/workflows"),
      /\.ya?ml$/,
    );
    expect(workflows.length).toBeGreaterThan(0);
    for (const path of workflows) {
      const source = read(path);
      expect(source, repositoryPath(path)).not.toContain(
        "RUN_LIVE_FMP_HYDRATION",
      );
      expect(source, repositoryPath(path)).not.toContain("LIVE_FMP_API_KEY");
      expect(source, repositoryPath(path)).not.toContain("fmp:live");
    }
    const settings = read(resolve(REPOSITORY_ROOT, ".claude/settings.json"));
    expect(settings).not.toContain("fmp");
  });

  it("is wrapped for the cloud by a script that can run nothing else", () => {
    const wrapper = read(resolve(REPOSITORY_ROOT, "scripts/cloud/fmp-live.sh"));
    const code = wrapper
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // Its last word is the one command; unlike with-stripe.sh it never executes its arguments.
    expect(code.trimEnd().endsWith('exec pnpm fmp:live -- "$@"')).toBe(true);
    expect(code).not.toMatch(/^\s*exec "\$@"/m);
    expect(code).not.toMatch(/\beval\b/);
    // It goes through the session guard, and maps no credential itself.
    expect(code.indexOf("cloud_assert_safe")).toBeGreaterThan(-1);
    expect(code.indexOf("cloud_assert_safe")).toBeLessThan(
      code.indexOf("exec pnpm fmp:live"),
    );
    expect(code).not.toContain("FMP_API_KEY");
    expect(code).not.toContain("financialmodelingprep");
  });

  it("cannot be opted into for a whole cloud session, and no stack holds the key", () => {
    const library = read(resolve(REPOSITORY_ROOT, "scripts/cloud/lib.sh"));
    const neutralized = /^CLOUD_NEUTRALIZED_VARS="([^"]+)"/m.exec(library)?.[1];
    expect(neutralized?.split(" ")).toEqual(
      expect.arrayContaining([
        "FMP_API_KEY",
        "FMP_BASE_URL",
        "RUN_LIVE_FMP_TESTS",
        "RUN_LIVE_FMP_HYDRATION",
      ]),
    );

    const stack = read(resolve(REPOSITORY_ROOT, "scripts/cloud/stack.sh"));
    const unset = stack.indexOf("unset LIVE_FMP_API_KEY");
    expect(unset).toBeGreaterThan(-1);
    // Before any process of either stack is started.
    expect(unset).toBeLessThan(
      stack.indexOf("start_role fmp pnpm dev:fmp:e2e"),
    );
    expect(unset).toBeLessThan(stack.indexOf("start_role api pnpm dev:api"));

    // The Stripe wrapper, which does run arbitrary commands, knows nothing about FMP.
    const stripe = read(
      resolve(REPOSITORY_ROOT, "scripts/cloud/with-stripe.sh"),
    );
    expect(stripe).not.toMatch(/FMP/);
  });
});
