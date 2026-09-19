import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getApiConfig,
  getFmpConfig,
  getGoogleOAuthConfig,
  getSmtpConfig,
  getStockDataConfig,
  getStripeBillingConfig,
} from "@intrinsic/config";
import {
  E2E_DATA_FRESHNESS_MS,
  E2E_FAKE_FMP_API_KEY,
  e2eEgressGuardPath,
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
