import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getApiConfig,
  getFmpConfig,
  getGoogleOAuthConfig,
  getSmtpConfig,
  getStockDataConfig,
  getStripeBillingConfig,
  getTestPersonaCredentials,
} from "@intrinsic/config";
import {
  E2E_DATA_FRESHNESS_MS,
  E2E_FAKE_FMP_API_KEY,
  E2E_MAIL_FROM,
  E2E_TEST_CREDENTIAL_VARIABLES,
  E2eMailBoundaryError,
  LIVE_FMP_API_KEY_ENV,
  LIVE_FMP_HYDRATION_OPT_IN_ENV,
  LIVE_FMP_RUN_VARIABLES,
  e2eArmedMode,
  e2eChildEnvironment,
  e2eEgressGuardPath,
  e2eMailpitApiUrl,
  e2eMailpitSmtpEndpoint,
  e2eStackEnvironment,
  parseE2eEgressLog,
} from "@intrinsic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { QA_SECURITIES } from "../stocks/seed-qa-securities";
import {
  ENTITLEMENT_FIXTURE_SECURITY_COUNT,
  entitlementFixtureSymbol,
} from "../entitlements/seed-entitlement-fixtures";
import {
  e2eFixtureBenchmarkCodes,
  e2eFixtureBenchmarkProviderSymbols,
  e2eFixtureSecuritySymbols,
} from "./fixture-boundary";
import {
  resetE2eFixtureBenchmarkSeries,
  resetE2eFixtureSecurityData,
} from "./fixture-data";

/**
 * The E2E stack's process boundary (E2E-001, E2E-002): the environment every E2E process gets, the
 * egress guard preloaded into it, and the fixture namespace resets are confined to.
 */

const REPOSITORY_ROOT = resolve(__dirname, "../../../..");

/**
 * A developer `.env` with every provider configured, as this machine's is. The E2E overlay must
 * leave none of it usable.
 */
const DEVELOPER_ENV = {
  FMP_API_KEY: "developer-fmp-key",
  SMTP_HOST: "smtp.provider.example",
  SMTP_PORT: "2525",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "FactorSage <no-reply@example.test>",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_CALLBACK_URL: "http://localhost:3001/auth/google/callback",
  STRIPE_SECRET_KEY: "sk_test_developer_key",
  STRIPE_WEBHOOK_SECRET: "whsec_developer",
  STRIPE_PRICE_STARTER_MONTHLY: "price_developer_1",
  STRIPE_PRICE_STARTER_YEARLY: "price_developer_2",
  STRIPE_PRICE_PRO_MONTHLY: "price_developer_3",
  STRIPE_PRICE_PRO_YEARLY: "price_developer_4",
  STOCK_RECENT_PRICE_FRESHNESS_MS: "21600000",
  DATABASE_URL: "postgresql://localhost/intrinsic_value",
};

function overlaid(role: "api" | "worker"): Record<string, string> {
  return {
    ...DEVELOPER_ENV,
    ...e2eStackEnvironment({
      role,
      repositoryRoot: REPOSITORY_ROOT,
      testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
    }),
  };
}

describe("E2E stack environment", () => {
  it.each(["api", "worker"] as const)(
    "points the %s at the fixture FMP server with the fixture key, never the developer's",
    (role) => {
      const fmp = getFmpConfig(overlaid(role));

      expect(fmp.baseUrl).toBe("http://127.0.0.1:3011/stable/");
      expect(new URL(fmp.baseUrl as string).hostname).toBe("127.0.0.1");
      expect(fmp.apiKey).toBe(E2E_FAKE_FMP_API_KEY);
    },
  );

  it.each(["api", "worker"] as const)(
    "runs the %s on the test database with every other provider off or inert",
    (role) => {
      const env = overlaid(role);

      expect(env.DATABASE_URL).toBe(
        "postgresql://localhost/intrinsic_value_test",
      );
      expect(getSmtpConfig(env)).toBeNull();
      expect(getGoogleOAuthConfig(env)).toBeNull();
      const stripe = getStripeBillingConfig(env);
      expect(stripe?.testMode).toBe(true);
      expect(stripe?.secretKey).not.toBe(DEVELOPER_ENV.STRIPE_SECRET_KEY);
      expect(stripe?.secretKey).toMatch(/placeholder/);
    },
  );

  it("keeps seeded data fresh for thirty days without touching the product default", () => {
    const e2e = getStockDataConfig(overlaid("worker"));
    expect(e2e.recentPriceFreshnessMs).toBe(E2E_DATA_FRESHNESS_MS);
    expect(e2e.fundamentalsFreshnessMs).toBe(E2E_DATA_FRESHNESS_MS);
    expect(getStockDataConfig({}).recentPriceFreshnessMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  it("preloads the egress guard in every role, keeping inherited NODE_OPTIONS", () => {
    for (const role of ["api", "worker", "web"] as const) {
      const env = e2eStackEnvironment({
        role,
        repositoryRoot: REPOSITORY_ROOT,
        testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
        inheritedNodeOptions: "--max-old-space-size=4096",
      });
      expect(env.NODE_OPTIONS).toBe(
        `--require=${e2eEgressGuardPath(REPOSITORY_ROOT)} --max-old-space-size=4096`,
      );
      expect(env.E2E_STACK_ROLE).toBe(role);
    }
    expect(existsSync(e2eEgressGuardPath(REPOSITORY_ROOT))).toBe(true);
  });

  it("keeps the API's rate limits on, in their own namespace", () => {
    const env = overlaid("api");
    expect(env.RATE_LIMIT_KEY_NAMESPACE).toBe("rate-limit:e2e");
    expect(() => getApiConfig(env)).not.toThrow();
  });

  it("refuses to build an API or worker environment without the test database", () => {
    expect(() =>
      e2eStackEnvironment({ role: "api", repositoryRoot: REPOSITORY_ROOT }),
    ).toThrow(/TEST_DATABASE_URL/);
  });

  it("launches every role in standard mode unless told otherwise", () => {
    for (const role of ["api", "worker", "web"] as const) {
      const env = e2eStackEnvironment({
        role,
        repositoryRoot: REPOSITORY_ROOT,
        testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
      });
      expect(env.E2E_STACK_MODE).toBe("standard");
    }
  });
});

/**
 * Who holds the test passwords.
 *
 * The QA persona and billing persona passwords have two readers: the seeders, which hash them into
 * the test database, and the Playwright runner, which types them into the sign-in form. No process
 * of the stack needs one, and the web server must never receive one — `next dev` writes its
 * environment into `.next/dev/cache/turbopack`, which is where `QA_BILLING_PASSWORD` was found.
 *
 * The cases below run against a launcher environment that has every one of them exported, which is
 * what a Claude cloud session is: there each configured variable is ambient in every shell.
 */
describe("E2E test credentials", () => {
  const PASSWORD_VARIABLES = [
    "QA_FREE_PASSWORD",
    "QA_STARTER_PASSWORD",
    "QA_USER_PASSWORD",
    "QA_ADMIN_PASSWORD",
    "QA_DOWNGRADED_PASSWORD",
    "QA_BILLING_PASSWORD",
  ];
  const leaked = (name: string) => `leak-${name.toLowerCase()}-71c2`;

  /** The launcher's own `process.env`, with everything exported. */
  function launcherEnvironment(): Record<string, string> {
    return {
      ...DEVELOPER_ENV,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      NODE_OPTIONS: "--max-old-space-size=4096",
      QA_FREE_EMAIL: "qa-free@factorsage.test",
      ...Object.fromEntries(
        PASSWORD_VARIABLES.map((name) => [name, leaked(name)]),
      ),
    };
  }

  const child = (role: "api" | "worker" | "web", mode?: "mail") =>
    e2eChildEnvironment({
      role,
      repositoryRoot: REPOSITORY_ROOT,
      testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
      ...(mode ? { mode } : {}),
      parentEnvironment: launcherEnvironment(),
    });

  it("are the persona passwords, read from the two registries", () => {
    // Written out here; derived there, so a new persona is covered without anybody remembering.
    expect([...E2E_TEST_CREDENTIAL_VARIABLES]).toEqual(PASSWORD_VARIABLES);
  });

  it.each(["api", "worker", "web"] as const)(
    "never reach the %s, whatever the launcher itself was started with",
    (role) => {
      const environment = child(role);

      for (const name of PASSWORD_VARIABLES) {
        expect(environment[name], name).toBe("");
        // Not under another name either.
        expect(JSON.stringify(environment), name).not.toContain(leaked(name));
      }
      // Everything else the process legitimately inherits is still there…
      expect(environment.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(environment.QA_FREE_EMAIL).toBe("qa-free@factorsage.test");
      // …and the overlay still wins over what was inherited.
      expect(environment.E2E_STACK_ROLE).toBe(role);
      expect(environment.NODE_OPTIONS).toBe(
        `--require=${e2eEgressGuardPath(REPOSITORY_ROOT)} --max-old-space-size=4096`,
      );
    },
  );

  it("never reach the mail-mode API either", () => {
    const environment = child("api", "mail");
    for (const name of PASSWORD_VARIABLES) {
      expect(environment[name], name).toBe("");
    }
    expect(environment.E2E_STACK_MODE).toBe("mail");
    expect(getSmtpConfig(environment)?.host).toBe("127.0.0.1");
  });

  it("leave the API and the worker everything else the hermetic overlay gives them", () => {
    for (const role of ["api", "worker"] as const) {
      const environment = child(role);
      expect(environment.DATABASE_URL).toBe(
        "postgresql://localhost/intrinsic_value_test",
      );
      expect(getFmpConfig(environment).apiKey).toBe(E2E_FAKE_FMP_API_KEY);
      expect(getStripeBillingConfig(environment)?.secretKey).toMatch(
        /placeholder/,
      );
    }
  });

  it("cannot be read back through the configuration loader", () => {
    const environment = child("api");
    for (const prefix of [
      "QA_FREE",
      "QA_STARTER",
      "QA_USER",
      "QA_ADMIN",
      "QA_DOWNGRADED",
    ]) {
      expect(() => getTestPersonaCredentials(prefix, environment)).toThrow(
        new RegExp(`${prefix}_PASSWORD`),
      );
    }
  });

  it("stay blank when the process then loads a .env that defines them", () => {
    // The API and the worker load the repository-root `.env` themselves, and that file holds the
    // persona passwords. The blank is what stops them coming back that way: Node's loader does
    // not replace a variable that is already set, an empty one included. Proven with a real
    // process and the real loader rather than assumed.
    const directory = mkdtempSync(join(tmpdir(), "e2e-credentials-"));
    try {
      const envFile = join(directory, ".env");
      writeFileSync(
        envFile,
        PASSWORD_VARIABLES.map((name) => `${name}=${leaked(name)}`).join("\n"),
      );
      const overlay = e2eStackEnvironment({
        role: "api",
        repositoryRoot: REPOSITORY_ROOT,
        testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
      });
      const load = (environment: Record<string, string>) => {
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            "process.loadEnvFile(process.argv[1]);" +
              "process.stdout.write(JSON.stringify(Object.fromEntries(" +
              "Object.entries(process.env).filter(([name]) => name.startsWith('QA_')))))",
            envFile,
          ],
          {
            env: { PATH: process.env.PATH ?? "", ...environment },
            encoding: "utf8",
          },
        );
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout) as Record<string, string>;
      };

      // Without the overlay the loader does define them, so the case below is not vacuous.
      expect(load({})).toEqual(
        Object.fromEntries(
          PASSWORD_VARIABLES.map((name) => [name, leaked(name)]),
        ),
      );
      expect(
        load(
          Object.fromEntries(
            PASSWORD_VARIABLES.map((name) => [name, overlay[name] as string]),
          ),
        ),
      ).toEqual(
        Object.fromEntries(PASSWORD_VARIABLES.map((name) => [name, ""])),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reach no child through the launcher assembling an environment of its own", () => {
    const launcher = readFileSync(resolve(__dirname, "launch.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

    // One spawn, and the environment it is given is the one the boundary module built.
    expect(launcher.match(/\bspawn\(/g)).toHaveLength(1);
    expect(launcher).toMatch(/e2eChildEnvironment\(/);
    expect(launcher).toMatch(/env:\s*environment\b/);
    // Never the launcher's own, whole or spread.
    expect(launcher).not.toMatch(/\.\.\.process\.env/);
    expect(launcher).not.toMatch(/env:\s*process\.env/);
  });
});

/**
 * The email lifecycle suite's mail mode (`pnpm dev:api:e2e:mail`): the API delivers to the local
 * Mailpit, and nowhere else, whatever the developer's `.env` configures.
 */
describe("E2E stack and the live FMP run", () => {
  const LIVE_KEY = "leak-live-fmp-key-8c41d09e7a2b";

  const child = (role: "api" | "worker" | "web") =>
    e2eChildEnvironment({
      role,
      repositoryRoot: REPOSITORY_ROOT,
      testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
      // A Claude cloud session: the live key is ambient in the shell that starts the stack, and
      // somebody has exported the opt-in as well.
      parentEnvironment: {
        ...DEVELOPER_ENV,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        [LIVE_FMP_API_KEY_ENV]: LIVE_KEY,
        [LIVE_FMP_HYDRATION_OPT_IN_ENV]: "1",
      },
    });

  it("names the live run's variables once, for every boundary to withhold", () => {
    expect([...LIVE_FMP_RUN_VARIABLES]).toEqual([
      "LIVE_FMP_API_KEY",
      "RUN_LIVE_FMP_HYDRATION",
    ]);
  });

  it.each(["api", "worker", "web"] as const)(
    "gives the %s neither the live key nor the opt-in",
    (role) => {
      const environment = child(role);
      for (const name of LIVE_FMP_RUN_VARIABLES) {
        expect(environment[name], name).toBe("");
      }
      // Not under another name either: the key is nowhere in what the process receives.
      expect(JSON.stringify(environment)).not.toContain(LIVE_KEY);
    },
  );

  it("leaves the API and the worker on the fixture provider and nothing else", () => {
    for (const role of ["api", "worker"] as const) {
      const config = getFmpConfig(child(role));
      expect(config.apiKey).toBe(E2E_FAKE_FMP_API_KEY);
      expect(config.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stable\/$/);
    }
  });
});

describe("E2E mail mode", () => {
  function mailOverlaid(
    launcherEnvironment: Record<string, string> = {},
  ): Record<string, string> {
    return {
      ...DEVELOPER_ENV,
      ...e2eStackEnvironment({
        role: "api",
        repositoryRoot: REPOSITORY_ROOT,
        testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
        mode: "mail",
        launcherEnvironment,
      }),
    };
  }

  it("points the API's SMTP at loopback Mailpit with no credentials, never the developer's relay", () => {
    const env = mailOverlaid();

    expect(getSmtpConfig(env)).toEqual({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      from: E2E_MAIL_FROM,
      auth: null,
    });
    expect(env.SMTP_USER).toBe("");
    expect(env.SMTP_PASSWORD).toBe("");
    expect(env.E2E_STACK_MODE).toBe("mail");
    // Everything else about the hermetic API is unchanged.
    expect(env.DATABASE_URL).toBe(
      "postgresql://localhost/intrinsic_value_test",
    );
    expect(getFmpConfig(env).apiKey).toBe(E2E_FAKE_FMP_API_KEY);
    expect(getGoogleOAuthConfig(env)).toBeNull();
    expect(getStripeBillingConfig(env)?.secretKey).toMatch(/placeholder/);
    expect(env.NODE_OPTIONS).toContain(e2eEgressGuardPath(REPOSITORY_ROOT));
  });

  it("follows a loopback Mailpit on another port", () => {
    expect(
      getSmtpConfig(
        mailOverlaid({ E2E_MAILPIT_SMTP_URL: "smtp://localhost:2525" }),
      ),
    ).toMatchObject({ host: "localhost", port: 2525, auth: null });
    expect(
      getSmtpConfig(
        mailOverlaid({ E2E_MAILPIT_SMTP_URL: "smtp://[::1]:1025" }),
      ),
    ).toMatchObject({ host: "::1", port: 1025 });
  });

  it.each([
    ["a remote host", "smtp://smtp.provider.example:587", /not loopback/],
    ["a private address", "smtp://10.0.0.5:1025", /not loopback/],
    [
      "a loopback lookalike",
      "smtp://localhost.provider.example:1025",
      /not loopback/,
    ],
    [
      "embedded credentials",
      "smtp://user:secret@127.0.0.1:1025",
      /credentials/,
    ],
    ["implicit TLS", "smtps://127.0.0.1:465", /must be a smtp:/],
    ["no port", "smtp://127.0.0.1", /must name its port/],
    ["a path", "smtp://127.0.0.1:1025/relay", /origin only/],
    ["not a URL", "127.0.0.1:1025", /smtp:|not a valid URL/],
  ])("refuses %s before building anything", (_label, url, message) => {
    expect(() => mailOverlaid({ E2E_MAILPIT_SMTP_URL: url })).toThrow(
      E2eMailBoundaryError,
    );
    expect(() => mailOverlaid({ E2E_MAILPIT_SMTP_URL: url })).toThrow(message);
  });

  it("refuses production", () => {
    expect(() => mailOverlaid({ NODE_ENV: "production" })).toThrow(
      /NODE_ENV is production/,
    );
    expect(() => e2eMailpitApiUrl({ NODE_ENV: "production" })).toThrow(
      /NODE_ENV is production/,
    );
  });

  it("exists for the API only", () => {
    for (const role of ["worker", "web"] as const) {
      expect(() =>
        e2eStackEnvironment({
          role,
          repositoryRoot: REPOSITORY_ROOT,
          testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
          mode: "mail",
        }),
      ).toThrow(/Only the API has a mail mode/);
    }
  });

  it("resolves the Mailpit HTTP API on loopback only", () => {
    expect(e2eMailpitApiUrl({})).toBe("http://127.0.0.1:8025");
    expect(
      e2eMailpitApiUrl({ E2E_MAILPIT_URL: "http://localhost:9025/" }),
    ).toBe("http://localhost:9025");
    expect(e2eMailpitSmtpEndpoint({})).toEqual({
      host: "127.0.0.1",
      port: 1025,
    });
    for (const [url, message] of [
      ["http://mail.provider.example:8025", /not loopback/],
      ["https://127.0.0.1:8025", /must be a http:/],
      ["http://admin:secret@127.0.0.1:8025", /credentials/],
      ["http://127.0.0.1:8025/api/v1", /origin only/],
      ["http://127.0.0.1:8025/?next=x", /origin only/],
    ] as const) {
      expect(() => e2eMailpitApiUrl({ E2E_MAILPIT_URL: url })).toThrow(message);
    }
  });
});

describe("E2E egress guard", () => {
  const directory = mkdtempSync(join(tmpdir(), "e2e-egress-"));
  const log = join(directory, "egress.jsonl");

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * A child process under the guard tries a loopback server and three non-loopback destinations.
   *
   * The non-loopback ones are reserved names and addresses (`.invalid`, RFC 6761; TEST-NET-1,
   * RFC 5737) that cannot reach anyone even if the guard were broken, so this test can never make
   * the request it exists to forbid.
   */
  const PROBE = `
    const http = require("node:http");
    const net = require("node:net");
    const tls = require("node:tls");
    const results = {};
    const server = http.createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      results.loopback = await (await fetch("http://127.0.0.1:" + port + "/")).text();
      results.localhost = await (await fetch("http://localhost:" + port + "/")).text();
      try { await fetch("https://api.provider.invalid/stable/profile"); results.fetch = "sent"; }
      catch (error) { results.fetch = error.cause && error.cause.code; }
      results.tls = await new Promise((done) =>
        tls.connect(443, "images.provider.invalid").on("error", (e) => done(e.code)));
      results.tcp = await new Promise((done) =>
        net.connect(25, "192.0.2.1").on("error", (e) => done(e.code)));
      server.close();
      process.stdout.write(JSON.stringify(results));
    });`;

  it("allows loopback and blocks every other destination before it is contacted", () => {
    const child = spawnSync(process.execPath, ["-e", PROBE], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${e2eEgressGuardPath(REPOSITORY_ROOT)}`,
        E2E_EGRESS_LOG: log,
        E2E_STACK_ROLE: "probe",
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      loopback: "ok",
      localhost: "ok",
      fetch: "E2E_EGRESS_BLOCKED",
      tls: "E2E_EGRESS_BLOCKED",
      tcp: "E2E_EGRESS_BLOCKED",
    });
    expect(child.stderr).toContain(
      "[e2e-egress-guard] BLOCKED outbound connection to api.provider.invalid:443",
    );

    const records = parseE2eEgressLog(readFileSync(log, "utf8"));
    expect(records.filter((record) => record.kind === "armed")).toHaveLength(1);
    expect(
      records
        .filter((record) => record.kind === "blocked")
        .map((record) =>
          record.kind === "blocked" ? `${record.host}:${record.port}` : "",
        ),
    ).toEqual([
      "api.provider.invalid:443",
      "images.provider.invalid:443",
      "192.0.2.1:25",
    ]);
    expect(records.every((record) => record.role === "probe")).toBe(true);
  });
});

describe("E2E egress guard and SMTP", () => {
  const directory = mkdtempSync(join(tmpdir(), "e2e-egress-smtp-"));
  const log = join(directory, "egress.jsonl");

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * The application's own SMTP library, under the guard: delivery to a loopback SMTP server (a
   * minimal one, standing in for Mailpit) proceeds, and delivery to anything else is refused before
   * a packet leaves. `192.0.2.1` is TEST-NET-1 (RFC 5737) — unreachable even if the guard broke, and
   * a literal address, so not even a DNS query is made.
   *
   * Spawned rather than run in-process: this package's tests replace `nodemailer`
   * (`no-real-email.setup.ts`), and the point here is the real library's sockets.
   */
  const PROBE = `
    const net = require("node:net");
    const nodemailer = require("nodemailer");
    const received = [];
    const server = net.createServer((socket) => {
      let data = false;
      socket.write("220 loopback ESMTP\\r\\n");
      socket.on("data", (chunk) => {
        for (const line of chunk.toString().split("\\r\\n").filter(Boolean)) {
          if (data) {
            if (line === ".") { data = false; socket.write("250 queued\\r\\n"); }
            else if (line.startsWith("Subject:")) { received.push(line); }
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") socket.write("250 loopback\\r\\n");
          else if (verb === "DATA") { data = true; socket.write("354 go\\r\\n"); }
          else if (verb === "QUIT") { socket.end("221 bye\\r\\n"); }
          else socket.write("250 ok\\r\\n");
        }
      });
    }).listen(0, "127.0.0.1", async () => {
      const message = { from: "no-reply@factorsage.test", to: "authmail-1@example.test", subject: "probe", text: "probe" };
      const results = {};
      const local = nodemailer.createTransport({ host: "127.0.0.1", port: server.address().port, secure: false });
      results.loopback = await local.sendMail(message).then(() => "delivered", (e) => e.code);
      const remote = nodemailer.createTransport({ host: "192.0.2.1", port: 587, secure: false, connectionTimeout: 5000 });
      results.remote = await remote.sendMail(message).then(() => "delivered", (e) => e.message.includes("E2E egress guard") ? "E2E_EGRESS_BLOCKED" : e.code);
      results.received = received;
      server.close();
      process.stdout.write(JSON.stringify(results));
    });`;

  it("lets the mail-mode API reach loopback SMTP and blocks SMTP to anywhere else", () => {
    const child = spawnSync(process.execPath, ["-e", PROBE], {
      cwd: join(REPOSITORY_ROOT, "apps", "api"),
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${e2eEgressGuardPath(REPOSITORY_ROOT)}`,
        E2E_EGRESS_LOG: log,
        E2E_STACK_ROLE: "api",
        E2E_STACK_MODE: "mail",
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      loopback: "delivered",
      remote: "E2E_EGRESS_BLOCKED",
      received: ["Subject: probe"],
    });

    const records = parseE2eEgressLog(readFileSync(log, "utf8"));
    const armed = records.filter((record) => record.kind === "armed");
    expect(armed).toHaveLength(1);
    expect(e2eArmedMode(armed[0]!)).toBe("mail");
    expect(
      records
        .filter((record) => record.kind === "blocked")
        .map((record) =>
          record.kind === "blocked" ? `${record.host}:${record.port}` : "",
        ),
    ).toEqual(["192.0.2.1:587"]);
  });

  it("reads a record written before modes existed as standard", () => {
    expect(e2eArmedMode({})).toBe("standard");
    expect(e2eArmedMode({ mode: "mail" })).toBe("mail");
  });
});

describe("E2E fixture namespace", () => {
  it("contains every security and benchmark series the seeds own, and nothing else", () => {
    expect(e2eFixtureSecuritySymbols()).toEqual([
      ...QA_SECURITIES.map((security) => security.symbol),
      ...Array.from(
        { length: ENTITLEMENT_FIXTURE_SECURITY_COUNT },
        (_, index) => entitlementFixtureSymbol(index),
      ),
    ]);
    expect(e2eFixtureBenchmarkCodes()).toEqual([
      "SP500",
      "SP500_INDEX",
      "DJIA_INDEX",
      "VIX_INDEX",
    ]);
    expect(e2eFixtureBenchmarkProviderSymbols().sort()).toEqual(
      ["SPY", "^DJI", "^GSPC", "^VIX"].sort(),
    );
    // Fixture securities are fictional: none can collide with a real listing.
    expect(
      e2eFixtureSecuritySymbols().every((symbol) =>
        /^(QATEST\d|ENTF\d{3})$/.test(symbol),
      ),
    ).toBe(true);
  });

  it("refuses to reset anything outside the namespace before touching the database", async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be touched");
        },
      },
    ) as Parameters<typeof resetE2eFixtureSecurityData>[0];
    const env = {
      TEST_DATABASE_URL: "postgresql://localhost/intrinsic_value_test",
      DATABASE_URL: "postgresql://localhost/intrinsic_value",
    };
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
      await expect(
        resetE2eFixtureSecurityData(untouchable, ["QATEST1", "AAPL"]),
      ).rejects.toThrow(/outside the E2E fixture namespace: AAPL/);
      await expect(
        resetE2eFixtureBenchmarkSeries(untouchable, ["SP500", "NDX"]),
      ).rejects.toThrow(/outside the E2E fixture namespace: NDX/);
    } finally {
      process.env = previous;
    }
  });

  it("refuses production outright", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        resetE2eFixtureSecurityData({} as never, ["QATEST1"]),
      ).rejects.toThrow(/NODE_ENV is production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
