import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getFmpConfig } from "@intrinsic/config";
import {
  LIVE_FMP_API_KEY_ENV,
  LIVE_FMP_HYDRATION_OPT_IN_ENV,
  LIVE_FMP_RUN_VARIABLES,
  liveFmpHydrationEnabled,
  liveFmpTestsEnabled,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  LIVE_FMP_CHILD_INHERITED_VARIABLES,
  LIVE_FMP_RUN_ID_ENV,
  LiveFmpEnvironmentError,
  assertLiveFmpChildEnvironment,
  assertLiveFmpOptIn,
  liveFmpChildEnvironment,
  resolveLiveFmpKey,
  resolveLiveFmpTarget,
} from "./fmp-live-environment";
import { startLiveFmpChild } from "./fmp-live-process";

/**
 * Authorization, target and process environment of a live run, proven offline.
 *
 * Nothing here can reach the provider: the cases that start a real process either start a probe
 * that prints its environment, or start the launcher with a command line or an environment it
 * must refuse — and point it at ports nothing listens on, so even a launcher that wrongly got
 * through would fail before a request.
 */

const API_ROOT = resolve(__dirname, "../..");
const REPOSITORY_ROOT = resolve(API_ROOT, "../..");

/** Key-shaped, unlike any placeholder, and recognisable if it ever turned up in output. */
const LIVE_KEY = "live9f3c1a7e5b2d4f6a8c0e1b3d5f7a9c2e";
const ORDINARY_KEY = "ordinary4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a";

const DEV = {
  DATABASE_URL:
    "postgresql://intrinsic:secret-db-pass@localhost:5432/intrinsic_value",
  REDIS_URL: "redis://localhost:6379",
} as const;

const OPTED_IN = { [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1" } as const;

describe("live FMP hydration opt-in", () => {
  it("is authorized by the literal opt-in and by nothing else", () => {
    expect(
      liveFmpHydrationEnabled({ [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1" }),
    ).toBe(true);
    for (const value of [
      "true",
      "yes",
      "on",
      "TRUE",
      "0",
      "",
      " 1",
      "1 ",
      "2",
    ]) {
      expect(
        liveFmpHydrationEnabled({ [LIVE_FMP_HYDRATION_OPT_IN_ENV]: value }),
        JSON.stringify(value),
      ).toBe(false);
    }
    expect(liveFmpHydrationEnabled({})).toBe(false);
  });

  it("is not authorized by a key being present, under any name", () => {
    for (const env of [
      { [LIVE_FMP_API_KEY_ENV]: LIVE_KEY },
      { FMP_API_KEY: ORDINARY_KEY },
      { [LIVE_FMP_API_KEY_ENV]: LIVE_KEY, FMP_API_KEY: ORDINARY_KEY },
    ]) {
      expect(liveFmpHydrationEnabled(env)).toBe(false);
      expect(() => assertLiveFmpOptIn(env)).toThrowError(
        /needs RUN_LIVE_FMP_HYDRATION=1/,
      );
      // The key cannot even be obtained for a run nobody authorized.
      expect(() => resolveLiveFmpKey(env)).toThrowError(
        LiveFmpEnvironmentError,
      );
    }
  });

  it("is separate from the live test-suite gate, in both directions", () => {
    expect(liveFmpHydrationEnabled({ RUN_LIVE_FMP_TESTS: "1" })).toBe(false);
    expect(liveFmpTestsEnabled({ [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1" })).toBe(
      false,
    );
  });

  it("is closed for this very test run", () => {
    // `pnpm test`, or a direct vitest run, must never be a process that may start a live run.
    expect(liveFmpHydrationEnabled()).toBe(false);
  });
});

describe("live FMP credential", () => {
  it("comes from LIVE_FMP_API_KEY once the run is authorized", () => {
    expect(
      resolveLiveFmpKey({
        ...OPTED_IN,
        [LIVE_FMP_API_KEY_ENV]: ` ${LIVE_KEY} `,
      }),
    ).toBe(LIVE_KEY);
  });

  it("never falls back to the application's own key", () => {
    // A developer's ordinary key is present; the deliberately provisioned one is not.
    for (const live of [
      undefined,
      "",
      "   ",
      "changeme",
      "<key>",
      "your-api-key",
    ]) {
      expect(
        () =>
          resolveLiveFmpKey({
            ...OPTED_IN,
            FMP_API_KEY: ORDINARY_KEY,
            ...(live === undefined ? {} : { [LIVE_FMP_API_KEY_ENV]: live }),
          }),
        JSON.stringify(live),
      ).toThrowError(/FMP_API_KEY is never a substitute/);
    }
  });

  it("is invisible to the application's own configuration", () => {
    // The name the application reads is FMP_API_KEY. A process that merely inherits the live
    // variable has no provider credential as far as any loader can tell.
    expect(() =>
      getFmpConfig({ [LIVE_FMP_API_KEY_ENV]: LIVE_KEY, ...OPTED_IN }),
    ).toThrowError(/FMP_API_KEY is required/);
  });

  it("never appears in a refusal", () => {
    for (const attempt of [
      () => resolveLiveFmpKey({ [LIVE_FMP_API_KEY_ENV]: LIVE_KEY }),
      () =>
        assertLiveFmpChildEnvironment(
          { ...DEV, ...OPTED_IN, [LIVE_FMP_API_KEY_ENV]: LIVE_KEY },
          { plan: false },
        ),
      () =>
        assertLiveFmpChildEnvironment(
          { ...DEV, FMP_API_KEY: LIVE_KEY, [LIVE_FMP_RUN_ID_ENV]: "run-1" },
          { plan: true },
        ),
    ]) {
      let message = "";
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(LIVE_KEY);
    }
  });
});

describe("live FMP target", () => {
  it("is the local development database and the local Redis", () => {
    expect(resolveLiveFmpTarget(DEV)).toEqual({
      databaseUrl: DEV.DATABASE_URL,
      databaseName: "intrinsic_value",
      databaseHost: "localhost",
      redisUrl: DEV.REDIS_URL,
      redisHost: "localhost",
    });
    expect(
      resolveLiveFmpTarget({
        DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/intrinsic_value",
        REDIS_URL: "redis://127.0.0.1:6379/0",
        NODE_ENV: "development",
      }).databaseHost,
    ).toBe("127.0.0.1");
  });

  it("refuses production", () => {
    expect(() =>
      resolveLiveFmpTarget({ ...DEV, NODE_ENV: "production" }),
    ).toThrowError(/NODE_ENV is production/);
  });

  it.each([
    "postgresql://app:pw@db.internal.example.com:5432/intrinsic_value",
    "postgresql://app:pw@10.0.0.12:5432/intrinsic_value",
    "postgresql://app:pw@factorsage.cluster-abc.eu-west-1.rds.amazonaws.com/intrinsic_value",
    "postgresql://app:pw@host.docker.internal:5432/intrinsic_value",
    "postgresql://app:pw@postgres:5432/intrinsic_value",
  ])("refuses the database %s, which is not this machine", (url) => {
    let message = "";
    try {
      resolveLiveFmpTarget({ ...DEV, DATABASE_URL: url });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/is not this machine/);
    // The URL is named without its credentials.
    expect(message).not.toContain("pw@");
  });

  it("has no override that admits a remote database", () => {
    for (const override of [
      "QA_PERSONA_ALLOW_REMOTE_HOST",
      "QA_MATRIX_ALLOW_REMOTE_HOST",
      "LIVE_FMP_ALLOW_REMOTE_HOST",
    ]) {
      expect(() =>
        resolveLiveFmpTarget({
          ...DEV,
          DATABASE_URL: "postgresql://app:pw@db.example.com/intrinsic_value",
          [override]: "true",
        }),
      ).toThrowError(/is not this machine/);
    }
  });

  it.each([
    "intrinsic_value_test",
    "intrinsic_value_matrix",
    "test",
    "TEST_DB",
    "qa-matrix",
  ])("refuses the fixture database %s", (name) => {
    expect(() =>
      resolveLiveFmpTarget({
        ...DEV,
        DATABASE_URL: `postgresql://u:p@localhost:5432/${name}`,
      }),
    ).toThrowError(/deterministic fixtures/);
  });

  it("refuses a database another variable names as a fixture database", () => {
    for (const variable of ["TEST_DATABASE_URL", "QA_MATRIX_DATABASE_URL"]) {
      expect(() =>
        resolveLiveFmpTarget({ ...DEV, [variable]: DEV.DATABASE_URL }),
      ).toThrowError(new RegExp(`same database as ${variable}`));
    }
  });

  it.each([
    [{ DATABASE_URL: undefined }, /needs DATABASE_URL/],
    [{ DATABASE_URL: "not a url" }, /DATABASE_URL is not a valid URL/],
    [{ DATABASE_URL: "mysql://localhost/app" }, /must be a postgresql/],
    [{ DATABASE_URL: "postgresql://localhost:5432/" }, /names no database/],
    [{ REDIS_URL: undefined }, /needs REDIS_URL/],
    [{ REDIS_URL: "http://localhost:6379" }, /must be a redis/],
    [{ REDIS_URL: "redis://cache.example.com:6379" }, /not this machine/],
    [
      { REDIS_URL: "rediss://default:pw@redis.upstash.io:6379" },
      /not this machine/,
    ],
  ])("refuses %j", (override, message) => {
    expect(() => resolveLiveFmpTarget({ ...DEV, ...override })).toThrowError(
      message,
    );
  });
});

describe("live FMP child environment", () => {
  /** A launcher's environment as a developer machine or a cloud session really has it. */
  const PARENT: Record<string, string> = {
    ...DEV,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/dev",
    NODE_ENV: "development",
    LOG_LEVEL: "debug",
    FMP_MAX_CONCURRENT_REQUESTS: "4",
    STOCK_HISTORY_YEARS: "30",
    ALT_DATA_MAX_PAGES_PER_INGEST: "12",
    [LIVE_FMP_API_KEY_ENV]: LIVE_KEY,
    [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1",
    // Everything below must stay behind.
    FMP_API_KEY: ORDINARY_KEY,
    FMP_BASE_URL: "http://127.0.0.1:3011/stable/",
    RUN_LIVE_FMP_TESTS: "1",
    TEST_DATABASE_URL:
      "postgresql://u:leak-test-db@localhost/intrinsic_value_test",
    AUTH_JWT_SECRET: "leak-jwt-secret",
    STRIPE_SECRET_KEY: "sk_test_leak",
    SANDBOX_STRIPE_SECRET_KEY: "sk_test_leak_sandbox",
    STRIPE_WEBHOOK_SECRET: "whsec_leak",
    GOOGLE_CLIENT_SECRET: "leak-google",
    SMTP_PASSWORD: "leak-smtp",
    QA_ADMIN_PASSWORD: "leak-admin-password",
    QA_BILLING_PASSWORD: "leak-billing-password",
    GITHUB_TOKEN: "leak-github-token",
    NODE_OPTIONS: "--require=/tmp/anything.cjs",
    SOME_FUTURE_SECRET: "leak-future",
  };

  it("is an allowlist, with the live key mapped onto the name the application reads", () => {
    const child = liveFmpChildEnvironment({
      parentEnvironment: PARENT,
      key: LIVE_KEY,
      runId: "run-1234",
    });

    expect(child).toEqual({
      ...DEV,
      PATH: PARENT.PATH,
      HOME: PARENT.HOME,
      NODE_ENV: "development",
      LOG_LEVEL: "debug",
      FMP_MAX_CONCURRENT_REQUESTS: "4",
      STOCK_HISTORY_YEARS: "30",
      ALT_DATA_MAX_PAGES_PER_INGEST: "12",
      FMP_API_KEY: LIVE_KEY,
      [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1",
      [LIVE_FMP_RUN_ID_ENV]: "run-1234",
    });
    // The cloud-only name is not passed on, and the developer's ordinary key is not what it got.
    expect(child).not.toHaveProperty(LIVE_FMP_API_KEY_ENV);
    expect(JSON.stringify(child)).not.toContain(ORDINARY_KEY);
    // "Live" can never quietly mean a fixture server.
    expect(child).not.toHaveProperty("FMP_BASE_URL");
    for (const value of Object.values(child)) {
      expect(value).not.toMatch(/leak/);
    }
  });

  it("gives a plan neither the key nor the opt-in", () => {
    const child = liveFmpChildEnvironment({
      parentEnvironment: PARENT,
      key: null,
      runId: "run-1234",
    });
    expect(child).not.toHaveProperty("FMP_API_KEY");
    expect(child).not.toHaveProperty(LIVE_FMP_API_KEY_ENV);
    expect(child).not.toHaveProperty(LIVE_FMP_HYDRATION_OPT_IN_ENV);
    expect(JSON.stringify(child)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(child)).not.toContain(ORDINARY_KEY);
  });

  it("inherits nothing that names a credential, and nothing it was not told to", () => {
    for (const name of LIVE_FMP_CHILD_INHERITED_VARIABLES) {
      expect(name, name).not.toMatch(
        /PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|STRIPE|SMTP|GOOGLE|JWT/i,
      );
    }
    expect(LIVE_FMP_CHILD_INHERITED_VARIABLES).not.toContain("FMP_BASE_URL");
    expect(LIVE_FMP_CHILD_INHERITED_VARIABLES).not.toContain("NODE_OPTIONS");
    for (const name of LIVE_FMP_RUN_VARIABLES) {
      expect(LIVE_FMP_CHILD_INHERITED_VARIABLES).not.toContain(name);
    }
  });

  it("carries every variable the composed loaders' configuration reads", () => {
    // The getters the runtime calls. If one of them starts reading a new variable, it is either
    // added to the allowlist on purpose or the child silently runs on a default.
    const config = readFileSync(
      join(REPOSITORY_ROOT, "packages/config/src/index.ts"),
      "utf8",
    );
    const read = new Set<string>();
    for (const getter of [
      "getFmpTrafficConfig",
      "getStockDataConfig",
      "getAlternativeDataConfig",
      "getRedisConfig",
    ]) {
      const start = config.indexOf(`export function ${getter}(`);
      expect(start, getter).toBeGreaterThan(-1);
      const body = config.slice(start, config.indexOf("\n}\n", start));
      for (const [, name] of body.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) {
        read.add(name as string);
      }
    }
    expect(read.size).toBeGreaterThan(20);
    for (const name of read) {
      expect(LIVE_FMP_CHILD_INHERITED_VARIABLES, name).toContain(name);
    }
  });

  it("is what a real child process receives, and all it receives", async () => {
    const child = startLiveFmpChild({
      parentEnvironment: { ...PARENT, PATH: process.env.PATH },
      key: LIVE_KEY,
      runId: "run-1234",
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(process.env))",
      ],
      cwd: API_ROOT,
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
    const seen = JSON.parse(output) as Record<string, string>;

    expect(seen.FMP_API_KEY).toBe(LIVE_KEY);
    expect(seen[LIVE_FMP_HYDRATION_OPT_IN_ENV]).toBe("1");
    expect(Object.keys(seen)).not.toContain(LIVE_FMP_API_KEY_ENV);
    expect(Object.keys(seen)).not.toContain("FMP_BASE_URL");
    expect(output).not.toContain("leak");
    expect(output).not.toContain(ORDINARY_KEY);
    // Nothing of this test process's own environment came along either: no fallback to the
    // spawner's `process.env`. (macOS adds `__CF_USER_TEXT_ENCODING` to every process itself.)
    const allowed = new Set([
      ...LIVE_FMP_CHILD_INHERITED_VARIABLES,
      "FMP_API_KEY",
      LIVE_FMP_HYDRATION_OPT_IN_ENV,
      LIVE_FMP_RUN_ID_ENV,
      "__CF_USER_TEXT_ENCODING",
    ]);
    for (const name of Object.keys(seen)) {
      expect(allowed, name).toContain(name);
    }
  });
});

describe("the process that performs a live run", () => {
  const RUN = {
    ...DEV,
    ...OPTED_IN,
    FMP_API_KEY: LIVE_KEY,
    [LIVE_FMP_RUN_ID_ENV]: "run-1234",
  };

  it("accepts the environment the launcher builds", () => {
    expect(assertLiveFmpChildEnvironment(RUN, { plan: false })).toMatchObject({
      runId: "run-1234",
      target: { databaseName: "intrinsic_value" },
    });
    // A plan's environment: the same, with neither the key nor the opt-in.
    expect(
      assertLiveFmpChildEnvironment(
        { ...DEV, [LIVE_FMP_RUN_ID_ENV]: "run-1234" },
        { plan: true },
      ).runId,
    ).toBe("run-1234");
  });

  it.each([
    [
      "without the opt-in",
      { [LIVE_FMP_HYDRATION_OPT_IN_ENV]: undefined },
      /needs RUN_LIVE_FMP_HYDRATION=1/,
    ],
    [
      "with the opt-in spelled loosely",
      { [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "true" },
      /needs RUN_LIVE_FMP_HYDRATION=1/,
    ],
    [
      "without a key",
      { FMP_API_KEY: undefined },
      /without a real provider credential/,
    ],
    [
      "with a placeholder key",
      { FMP_API_KEY: "changeme" },
      /without a real provider credential/,
    ],
    [
      "pointed at a fixture server",
      { FMP_BASE_URL: "http://127.0.0.1:3011/stable/" },
      /FMP_BASE_URL is set/,
    ],
    [
      "holding the cloud-only variable",
      { [LIVE_FMP_API_KEY_ENV]: LIVE_KEY },
      /reached the process that performs the run/,
    ],
    [
      "against the test database",
      { DATABASE_URL: "postgresql://u:p@localhost/intrinsic_value_test" },
      /deterministic fixtures/,
    ],
    [
      "against a remote database",
      { DATABASE_URL: "postgresql://u:p@db.example.com/intrinsic_value" },
      /not this machine/,
    ],
    ["in production", { NODE_ENV: "production" }, /NODE_ENV is production/],
    [
      "without a run id",
      { [LIVE_FMP_RUN_ID_ENV]: undefined },
      /LIVE_FMP_RUN_ID is missing/,
    ],
  ])(
    "refuses to run %s, however it was started",
    (_label, override, message) => {
      expect(() =>
        assertLiveFmpChildEnvironment({ ...RUN, ...override }, { plan: false }),
      ).toThrowError(message);
    },
  );

  it("refuses a plan that was handed a credential", () => {
    expect(() =>
      assertLiveFmpChildEnvironment(
        { ...DEV, FMP_API_KEY: LIVE_KEY, [LIVE_FMP_RUN_ID_ENV]: "run-1" },
        { plan: true },
      ),
    ).toThrowError(/must not hold a provider credential/);
  });
});

describe("pnpm fmp:live, as a real process", () => {
  /**
   * Runs the launcher itself. `.env` is loaded by it and never overrides a variable that is
   * already set — an empty one included — so every variable a case depends on is set here, and
   * the database and Redis are ports nothing listens on.
   */
  function launch(
    argv: readonly string[],
    environment: Record<string, string>,
  ): { status: number | null; output: string } {
    const result = spawnSync(
      process.execPath,
      [
        join(API_ROOT, "node_modules/tsx/dist/cli.mjs"),
        join(API_ROOT, "src/fmp-live.ts"),
        ...argv,
      ],
      {
        cwd: API_ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "development",
          DATABASE_URL: "postgresql://u:p@127.0.0.1:1/intrinsic_value",
          REDIS_URL: "redis://127.0.0.1:1",
          TEST_DATABASE_URL: "",
          QA_MATRIX_DATABASE_URL: "",
          FMP_API_KEY: "",
          [LIVE_FMP_API_KEY_ENV]: "",
          [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "",
          ...environment,
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  }

  const RUN = ["--symbols", "AAPL", "--full-history"];

  it("does nothing when a key is present and the run was not opted into", () => {
    for (const optIn of ["", "true", "0"]) {
      const { status, output } = launch(RUN, {
        [LIVE_FMP_API_KEY_ENV]: LIVE_KEY,
        FMP_API_KEY: ORDINARY_KEY,
        [LIVE_FMP_HYDRATION_OPT_IN_ENV]: optIn,
      });
      expect(status, JSON.stringify(optIn)).toBe(2);
      expect(output).toMatch(/needs RUN_LIVE_FMP_HYDRATION=1/);
      expect(output).not.toContain(LIVE_KEY);
      expect(output).not.toContain(ORDINARY_KEY);
      // The run never started: no run id, no report.
      expect(output).not.toMatch(/Live FMP hydration:/);
    }
  }, 120_000);

  it("refuses a fourth security before it looks at the environment at all", () => {
    const { status, output } = launch(
      ["--symbols", "AAPL,MSFT,NVDA,GOOGL", "--full-history"],
      {
        [LIVE_FMP_API_KEY_ENV]: LIVE_KEY,
        [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1",
      },
    );
    expect(status).toBe(2);
    expect(output).toMatch(/at most 3 distinct securities; 4 were given/);
    expect(output).not.toMatch(/Live FMP hydration:/);
  }, 60_000);

  it("refuses an opted-in run that has no live key, even beside an ordinary one", () => {
    const { status, output } = launch(RUN, {
      [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1",
      FMP_API_KEY: ORDINARY_KEY,
    });
    expect(status).toBe(2);
    expect(output).toMatch(/LIVE_FMP_API_KEY is not set to a real key/);
    expect(output).not.toContain(ORDINARY_KEY);
  }, 60_000);

  it("refuses a fixture or remote database before it looks for the key", () => {
    for (const [url, message] of [
      [
        "postgresql://u:p@127.0.0.1:1/intrinsic_value_test",
        /deterministic fixtures/,
      ],
      [
        "postgresql://u:p@db.example.com:5432/intrinsic_value",
        /not this machine/,
      ],
    ] as const) {
      const { status, output } = launch(RUN, {
        [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1",
        [LIVE_FMP_API_KEY_ENV]: LIVE_KEY,
        DATABASE_URL: url,
      });
      expect(status).toBe(2);
      expect(output).toMatch(message);
      expect(output).not.toContain(LIVE_KEY);
    }
  }, 120_000);
});
