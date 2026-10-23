import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKTEST_DEBUG_ARCHIVE_DIR,
  DEFAULT_STOCK_LRU_MAX_SECURITIES,
  getApiConfig,
  getAuthConfig,
  getBacktestDebugArchiveConfig,
  getBacktestWorkerConfig,
  getFmpConfig,
  getGoogleOAuthConfig,
  getEodFinalityConfig,
  getStockEodWorkerConfig,
  getStockDataConfig,
  getMarketDataWorkerConfig,
  getRedisConfig,
  getRedisEvictionPolicyConfig,
  getMonitorWorkerConfig,
  getTestPersonaCredentials,
  getSmtpConfig,
  getStripeBillingConfig,
  getWebBaseUrl,
  getWorkerConfig,
} from "./index";

const JWT_SECRET = "test-only-jwt-secret-that-is-at-least-32-characters";

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret-value",
  GOOGLE_CALLBACK_URL: "https://api.example.test/auth/google/callback",
};

const SMTP_ENV = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "smtp-user",
  SMTP_PASSWORD: "smtp-password-value",
  SMTP_FROM: "FactorSage <no-reply@example.test>",
};

describe("authentication configuration", () => {
  it("defaults the email-verification TTL and web base URL", () => {
    const config = getAuthConfig({ AUTH_JWT_SECRET: JWT_SECRET });

    expect(config.emailVerificationTtlSeconds).toBe(24 * 60 * 60);
    expect(config.webBaseUrl).toBe("http://localhost:3000");
  });

  it("reads a configured verification TTL and web base URL", () => {
    const config = getAuthConfig({
      AUTH_JWT_SECRET: JWT_SECRET,
      AUTH_EMAIL_VERIFICATION_TTL_SECONDS: "3600",
      WEB_BASE_URL: "https://app.example.test/",
    });

    expect(config.emailVerificationTtlSeconds).toBe(3600);
    // Trailing slashes are removed so link building never produces a double slash.
    expect(config.webBaseUrl).toBe("https://app.example.test");
  });

  it("defaults the password-reset TTL to an hour and reads a configured one", () => {
    expect(
      getAuthConfig({ AUTH_JWT_SECRET: JWT_SECRET }).passwordResetTtlSeconds,
    ).toBe(60 * 60);
    expect(
      getAuthConfig({
        AUTH_JWT_SECRET: JWT_SECRET,
        AUTH_PASSWORD_RESET_TTL_SECONDS: "900",
      }).passwordResetTtlSeconds,
    ).toBe(900);
  });

  it("rejects a non-positive password-reset TTL", () => {
    expect(() =>
      getAuthConfig({
        AUTH_JWT_SECRET: JWT_SECRET,
        AUTH_PASSWORD_RESET_TTL_SECONDS: "0",
      }),
    ).toThrow("AUTH_PASSWORD_RESET_TTL_SECONDS must be a positive integer");
  });

  it("rejects a non-positive verification TTL", () => {
    expect(() =>
      getAuthConfig({
        AUTH_JWT_SECRET: JWT_SECRET,
        AUTH_EMAIL_VERIFICATION_TTL_SECONDS: "0",
      }),
    ).toThrow("AUTH_EMAIL_VERIFICATION_TTL_SECONDS must be a positive integer");
  });

  it("rejects a web base URL that is not an absolute http(s) URL", () => {
    expect(() => getWebBaseUrl({ WEB_BASE_URL: "app.example.test" })).toThrow(
      "WEB_BASE_URL must be an absolute URL",
    );
    expect(() =>
      getWebBaseUrl({ WEB_BASE_URL: "ftp://app.example.test" }),
    ).toThrow("WEB_BASE_URL must be an http or https URL");
  });
});

describe("Google OAuth configuration", () => {
  it("accepts a complete configuration", () => {
    expect(getGoogleOAuthConfig(GOOGLE_ENV)).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret-value",
      callbackUrl: "https://api.example.test/auth/google/callback",
    });
  });

  it("treats a completely unset provider as simply not offered", () => {
    expect(getGoogleOAuthConfig({})).toBeNull();
  });

  it("rejects every partial configuration", () => {
    const keys = Object.keys(GOOGLE_ENV) as (keyof typeof GOOGLE_ENV)[];

    for (const missing of keys) {
      const partial = { ...GOOGLE_ENV };
      delete partial[missing];

      expect(() => getGoogleOAuthConfig(partial)).toThrow(
        "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL must be set together",
      );
    }
  });

  it("rejects a callback URL that is not absolute", () => {
    expect(() =>
      getGoogleOAuthConfig({ ...GOOGLE_ENV, GOOGLE_CALLBACK_URL: "/callback" }),
    ).toThrow("GOOGLE_CALLBACK_URL must be an absolute URL");
  });

  it("treats variables that are present but blank as not offering the provider", () => {
    expect(
      getGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_CALLBACK_URL: "",
      }),
    ).toBeNull();
    expect(
      getGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: "   ",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_CALLBACK_URL: "",
      }),
    ).toBeNull();
  });

  it("still rejects a group whose only non-empty value is a default callback", () => {
    // The exact shape `.env.example` used to ship, which made a fresh .env unbootable.
    expect(() =>
      getGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GOOGLE_CALLBACK_URL: "http://localhost:3001/auth/google/callback",
      }),
    ).toThrow(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL must be set together",
    );
  });
});

describe("SMTP configuration", () => {
  it("accepts an authenticated production relay", () => {
    expect(getSmtpConfig(SMTP_ENV)).toEqual({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "FactorSage <no-reply@example.test>",
      auth: { user: "smtp-user", password: "smtp-password-value" },
    });
  });

  it("accepts an unauthenticated local relay", () => {
    const config = getSmtpConfig({
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      SMTP_FROM: "FactorSage <dev@example.test>",
    });

    expect(config).toMatchObject({ host: "localhost", port: 1025, auth: null });
  });

  it("defaults implicit TLS from the port and allows an explicit override", () => {
    expect(getSmtpConfig({ ...SMTP_ENV, SMTP_PORT: "465" })?.secure).toBe(true);
    expect(
      getSmtpConfig({ ...SMTP_ENV, SMTP_PORT: "465", SMTP_SECURE: "false" })
        ?.secure,
    ).toBe(false);
    expect(getSmtpConfig({ ...SMTP_ENV, SMTP_SECURE: "true" })?.secure).toBe(
      true,
    );
  });

  it("treats a completely unset transport as email being unavailable", () => {
    expect(getSmtpConfig({})).toBeNull();
  });

  it("rejects a transport that is missing its host or sender", () => {
    expect(() =>
      getSmtpConfig({ SMTP_FROM: "FactorSage <dev@example.test>" }),
    ).toThrow("SMTP_HOST and SMTP_FROM are required");
    expect(() => getSmtpConfig({ SMTP_HOST: "smtp.example.test" })).toThrow(
      "SMTP_HOST and SMTP_FROM are required",
    );
  });

  it("rejects half-configured credentials", () => {
    const withoutPassword: Partial<typeof SMTP_ENV> = { ...SMTP_ENV };
    delete withoutPassword.SMTP_PASSWORD;
    const withoutUser: Partial<typeof SMTP_ENV> = { ...SMTP_ENV };
    delete withoutUser.SMTP_USER;

    expect(() => getSmtpConfig(withoutPassword)).toThrow(
      "SMTP_USER and SMTP_PASSWORD must be set together",
    );
    expect(() => getSmtpConfig(withoutUser)).toThrow(
      "SMTP_USER and SMTP_PASSWORD must be set together",
    );
  });

  it("treats variables that are present but blank as no transport at all", () => {
    expect(
      getSmtpConfig({
        SMTP_HOST: "",
        SMTP_PORT: "",
        SMTP_SECURE: "",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
        SMTP_FROM: "",
      }),
    ).toBeNull();
  });

  it("still rejects a transport switched on by nothing but a port", () => {
    // The exact shape `.env.example` used to ship, which made a fresh .env unbootable.
    expect(() =>
      getSmtpConfig({
        SMTP_HOST: "",
        SMTP_PORT: "587",
        SMTP_SECURE: "",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
        SMTP_FROM: "",
      }),
    ).toThrow("SMTP_HOST and SMTP_FROM are required");
  });

  it("rejects an invalid port or secure flag", () => {
    expect(() => getSmtpConfig({ ...SMTP_ENV, SMTP_PORT: "0" })).toThrow(
      "SMTP_PORT must be a positive integer",
    );
    expect(() => getSmtpConfig({ ...SMTP_ENV, SMTP_PORT: "99999" })).toThrow(
      "SMTP_PORT must be a valid port number",
    );
    expect(() => getSmtpConfig({ ...SMTP_ENV, SMTP_SECURE: "yes" })).toThrow(
      "SMTP_SECURE must be true or false",
    );
  });
});

describe("test persona credentials", () => {
  const QA_ENV = {
    QA_USER_EMAIL: "qa-user@example.test",
    QA_USER_PASSWORD: "qa-user-password-value",
    QA_ADMIN_EMAIL: "qa-admin@example.test",
    QA_ADMIN_PASSWORD: "qa-admin-password-value",
  };

  it("reads a persona's credentials from its own prefix", () => {
    expect(getTestPersonaCredentials("QA_USER", QA_ENV)).toEqual({
      email: "qa-user@example.test",
      password: "qa-user-password-value",
    });
    expect(getTestPersonaCredentials("QA_ADMIN", QA_ENV)).toEqual({
      email: "qa-admin@example.test",
      password: "qa-admin-password-value",
    });
  });

  it("names the missing variable rather than failing vaguely", () => {
    const withoutAdminEmail: Partial<typeof QA_ENV> = { ...QA_ENV };
    delete withoutAdminEmail.QA_ADMIN_EMAIL;

    expect(() =>
      getTestPersonaCredentials("QA_ADMIN", withoutAdminEmail),
    ).toThrow("QA_ADMIN_EMAIL is required");
    expect(() => getTestPersonaCredentials("QA_USER", {})).toThrow(
      "QA_USER_PASSWORD is required",
    );
  });

  it("rejects a persona password that is too short", () => {
    // The same bound as the product's registration policy, so a persona can always sign in
    // through the real form.
    expect(() =>
      getTestPersonaCredentials("QA_USER", {
        ...QA_ENV,
        QA_USER_PASSWORD: "short",
      }),
    ).toThrow("QA_USER_PASSWORD must be at least 12 characters");
  });

  it("works for a persona prefix this package does not know about", () => {
    // The set of personas lives in `@intrinsic/testing`; this function only resolves a prefix.
    expect(
      getTestPersonaCredentials("QA_STARTER", {
        QA_STARTER_EMAIL: "qa-starter@example.test",
        QA_STARTER_PASSWORD: "qa-starter-password",
      }).email,
    ).toBe("qa-starter@example.test");
  });
});

/**
 * PROD-001: a production API refuses to start with a localhost or missing public URL, or without
 * outbound email, instead of booting healthy and failing each customer later.
 */
describe("production API configuration", () => {
  const PRODUCTION_API_ENV: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    AUTH_JWT_SECRET: JWT_SECRET,
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    ...SMTP_ENV,
  };

  function production(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...PRODUCTION_API_ENV, ...overrides };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete env[name];
      }
    }
    return env;
  }

  /** Every getter the API process resolves at startup. */
  function startApi(env: NodeJS.ProcessEnv) {
    return {
      api: getApiConfig(env),
      auth: getAuthConfig(env),
      smtp: getSmtpConfig(env),
    };
  }

  it("accepts a complete https configuration", () => {
    const config = startApi(PRODUCTION_API_ENV);

    expect(config.api.corsOrigins).toEqual(["https://app.example.test"]);
    expect(config.auth.webBaseUrl).toBe("https://app.example.test");
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.smtp?.host).toBe("smtp.example.test");
  });

  it("accepts an unauthenticated relay, keeping the credential pair all-or-nothing", () => {
    expect(
      getSmtpConfig(
        production({ SMTP_USER: undefined, SMTP_PASSWORD: undefined }),
      )?.auth,
    ).toBeNull();
    expect(() =>
      getSmtpConfig(production({ SMTP_PASSWORD: undefined })),
    ).toThrow("SMTP_USER and SMTP_PASSWORD must be set together");
  });

  it("requires WEB_BASE_URL", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() => getWebBaseUrl(production({ WEB_BASE_URL: value }))).toThrow(
        "WEB_BASE_URL is required in production",
      );
      expect(() => getAuthConfig(production({ WEB_BASE_URL: value }))).toThrow(
        "WEB_BASE_URL is required in production",
      );
    }
  });

  it("refuses a malformed or non-https WEB_BASE_URL", () => {
    expect(() =>
      getWebBaseUrl(production({ WEB_BASE_URL: "app.example.test" })),
    ).toThrow("WEB_BASE_URL must be an absolute URL");
    expect(() =>
      getWebBaseUrl(production({ WEB_BASE_URL: "http://app.example.test" })),
    ).toThrow("WEB_BASE_URL must be an https URL in production");
  });

  it("refuses a localhost or loopback WEB_BASE_URL", () => {
    for (const value of [
      "https://localhost:3000",
      "https://LOCALHOST",
      "https://app.localhost",
      "https://127.0.0.1",
      "https://127.1",
      "https://[::1]:3000",
      "https://[0:0:0:0:0:0:0:1]",
      "https://[::ffff:127.0.0.1]",
      "https://0.0.0.0",
    ]) {
      expect(
        () => getWebBaseUrl(production({ WEB_BASE_URL: value })),
        value,
      ).toThrow(
        "WEB_BASE_URL must not point at localhost or a loopback address in production",
      );
    }
  });

  it("requires CORS_ORIGINS", () => {
    for (const value of [undefined, "", " , "]) {
      expect(() => getApiConfig(production({ CORS_ORIGINS: value }))).toThrow(
        "CORS_ORIGINS is required in production",
      );
    }
  });

  it("refuses a localhost or loopback CORS origin anywhere in the list", () => {
    for (const value of [
      "http://localhost:3000",
      "https://app.example.test,http://localhost:3000",
      "https://127.0.0.1",
      "https://[::1]",
    ]) {
      expect(
        () => getApiConfig(production({ CORS_ORIGINS: value })),
        value,
      ).toThrow(
        "CORS_ORIGINS must not contain a localhost or loopback origin in production",
      );
    }
  });

  it("requires outbound email", () => {
    const withoutSmtp = production({
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
    });

    expect(() => getSmtpConfig(withoutSmtp)).toThrow(
      "SMTP_HOST and SMTP_FROM are required in production",
    );
    expect(() => getSmtpConfig(production({ SMTP_FROM: undefined }))).toThrow(
      "SMTP_HOST and SMTP_FROM are required when any SMTP_* variable is set",
    );
  });

  it("names the variable in every refusal and never echoes a value", () => {
    const secretish = "https://secret-token@127.0.0.1";
    const failures = [
      () => getWebBaseUrl(production({ WEB_BASE_URL: secretish })),
      () =>
        getWebBaseUrl(production({ WEB_BASE_URL: "http://app.example.test" })),
      () => getApiConfig(production({ CORS_ORIGINS: undefined })),
      () =>
        getSmtpConfig(
          production({
            SMTP_HOST: undefined,
            SMTP_PORT: undefined,
            SMTP_USER: undefined,
            SMTP_PASSWORD: undefined,
            SMTP_FROM: undefined,
          }),
        ),
    ];

    for (const failure of failures) {
      let message = "";
      try {
        failure();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^Invalid application configuration: [A-Z_]+/);
      for (const value of [
        secretish,
        "secret-token",
        "app.example.test",
        JWT_SECRET,
        SMTP_ENV.SMTP_PASSWORD,
      ]) {
        expect(message).not.toContain(value);
      }
    }
  });

  it("keeps the development and test defaults unchanged", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      const env = { NODE_ENV, AUTH_JWT_SECRET: JWT_SECRET };

      expect(getWebBaseUrl(env)).toBe("http://localhost:3000");
      expect(getApiConfig(env).corsOrigins).toEqual(["http://localhost:3000"]);
      expect(getSmtpConfig(env)).toBeNull();
      expect(getAuthConfig(env).webBaseUrl).toBe("http://localhost:3000");
    }
  });

  it("starts the worker in production without any API-only setting", () => {
    // The worker reads none of WEB_BASE_URL, CORS_ORIGINS, SMTP_* or AUTH_*; requiring them
    // there would couple a process that sends no email to the API's deployment surface.
    const workerEnv = { NODE_ENV: "production", LOG_LEVEL: "info" };

    expect(getWorkerConfig(workerEnv).environment).toBe("production");
    expect(() => getBacktestWorkerConfig(workerEnv)).not.toThrow();
    expect(() => getMonitorWorkerConfig(workerEnv)).not.toThrow();
    expect(() => getMarketDataWorkerConfig(workerEnv)).not.toThrow();
    expect(getBacktestDebugArchiveConfig(workerEnv).enabled).toBe(false);
  });
});

describe("stock EOD worker configuration", () => {
  it("runs one preparation child by default, every ten minutes, inside its own lease", () => {
    const config = getStockEodWorkerConfig({});
    expect(config.processes).toBe(1);
    expect(config.refreshIntervalMs).toBe(10 * 60_000);
    expect(config.followUpMs).toBeLessThan(config.refreshIntervalMs);
    expect(config.runBudgetMs).toBeLessThan(config.leaseMs);
    expect(config.securityConcurrency).toBe(2);
  });

  it("can be disabled, and refuses a process count that buys nothing", () => {
    expect(
      getStockEodWorkerConfig({ STOCK_EOD_WORKER_PROCESSES: "0" }).processes,
    ).toBe(0);
    for (const value of ["3", "-1", "1.5", "many"]) {
      expect(() =>
        getStockEodWorkerConfig({ STOCK_EOD_WORKER_PROCESSES: value }),
      ).toThrow(/STOCK_EOD_WORKER_PROCESSES/);
    }
  });
});

describe("EOD finality configuration", () => {
  it("shares the market-data publication delay and retry spacing, and bounds a missing session", () => {
    const config = getEodFinalityConfig({});
    expect(config.publicationDelayMs).toBe(30 * 60_000);
    expect(config.sessionRetryMs).toBe(30 * 60_000);
    expect(config.sessionGiveUpMs).toBe(24 * 60 * 60_000);
    expect(config.lateRecoveryMs).toBe(4 * 24 * 60 * 60_000);
    expect(config.frozenTails).toBe(false);
  });

  it("bounds the late-recovery horizon to the window the recent tail read still covers", () => {
    expect(
      getEodFinalityConfig({ EOD_LATE_RECOVERY_MS: "259200000" }).lateRecoveryMs,
    ).toBe(3 * 24 * 60 * 60_000);
    expect(() =>
      getEodFinalityConfig({ EOD_LATE_RECOVERY_MS: String(7 * 24 * 60 * 60_000) }),
    ).toThrow(/EOD_LATE_RECOVERY_MS/);
    expect(() => getEodFinalityConfig({ EOD_LATE_RECOVERY_MS: "0" })).toThrow(
      /EOD_LATE_RECOVERY_MS/,
    );
  });

  it("freezes stored tails only when asked by name, and refuses anything else", () => {
    expect(getEodFinalityConfig({ EOD_TAIL_REFRESH: "frozen" }).frozenTails).toBe(
      true,
    );
    expect(
      getEodFinalityConfig({ EOD_TAIL_REFRESH: "scheduled" }).frozenTails,
    ).toBe(false);
    expect(() => getEodFinalityConfig({ EOD_TAIL_REFRESH: "off" })).toThrow(
      /EOD_TAIL_REFRESH/,
    );
  });

  it("reads the very key the market-data refresh reads, so the two can never disagree", () => {
    const env = {
      MARKET_DATA_EOD_PUBLICATION_DELAY_MS: "2700000",
      MARKET_DATA_SERIES_RETRY_MS: "600000",
    };
    expect(getEodFinalityConfig(env).publicationDelayMs).toBe(
      getMarketDataWorkerConfig(env).publicationDelayMs,
    );
    expect(getEodFinalityConfig(env).sessionRetryMs).toBe(
      getMarketDataWorkerConfig(env).seriesRetryMs,
    );
  });
});

describe("market-data worker configuration", () => {
  it("runs one refresh child by default, after a half-hour publication delay", () => {
    const config = getMarketDataWorkerConfig({});
    expect(config.processes).toBe(1);
    expect(config.publicationDelayMs).toBe(30 * 60_000);
    expect(config.refreshIntervalMs).toBe(10 * 60_000);
    // A run must fit inside its own lease, or another child would take it over mid-run.
    expect(config.runBudgetMs).toBeLessThan(config.leaseMs);
  });

  it("can be disabled, and refuses a process count that buys nothing", () => {
    expect(
      getMarketDataWorkerConfig({ MARKET_DATA_WORKER_PROCESSES: "0" })
        .processes,
    ).toBe(0);
    for (const value of ["3", "-1", "1.5", "many"]) {
      expect(() =>
        getMarketDataWorkerConfig({ MARKET_DATA_WORKER_PROCESSES: value }),
      ).toThrow(/MARKET_DATA_WORKER_PROCESSES/);
    }
  });

  it("names an accepted Redis eviction policy only when an operator set one", () => {
    expect(getRedisEvictionPolicyConfig({})).toEqual({});
    expect(
      getRedisEvictionPolicyConfig({
        REDIS_ACCEPTED_EVICTION_POLICY: "allkeys-lru",
      }).acceptedPolicy,
    ).toBe("allkeys-lru");
    // The connection settings never carry it.
    expect(
      getRedisConfig({
        REDIS_URL: "redis://localhost:6379",
        REDIS_ACCEPTED_EVICTION_POLICY: "allkeys-lru",
      }),
    ).toEqual({ url: "redis://localhost:6379" });
  });
});

describe("FMP configuration", () => {
  const KEY = { FMP_API_KEY: "fmp-key-for-this-test" };

  it("leaves the client on its own endpoint when FMP_BASE_URL is unset", () => {
    const config = getFmpConfig(KEY);

    expect(config).not.toHaveProperty("baseUrl");
    expect(getFmpConfig({ ...KEY, FMP_BASE_URL: "  " })).not.toHaveProperty(
      "baseUrl",
    );
  });

  it("points the client at a local fixture server outside production", () => {
    for (const environment of ["development", "test"]) {
      expect(
        getFmpConfig({
          ...KEY,
          NODE_ENV: environment,
          FMP_BASE_URL: "http://127.0.0.1:3011/stable",
        }).baseUrl,
      ).toBe("http://127.0.0.1:3011/stable/");
    }
  });

  it("keeps the base a directory, so every endpoint resolves beneath it", () => {
    const { baseUrl } = getFmpConfig({
      ...KEY,
      FMP_BASE_URL: "http://localhost:3011/stable/",
    });

    expect(baseUrl).toBe("http://localhost:3011/stable/");
    expect(new URL("historical-price-eod/full", baseUrl).toString()).toBe(
      "http://localhost:3011/stable/historical-price-eod/full",
    );
  });

  it("rejects a malformed base URL, a non-http scheme, a query or a fragment", () => {
    for (const value of [
      "not a url",
      "ftp://127.0.0.1/stable/",
      "http://127.0.0.1:3011/stable/?apikey=x",
      "http://127.0.0.1:3011/stable/#x",
    ]) {
      expect(() => getFmpConfig({ ...KEY, FMP_BASE_URL: value })).toThrow(
        /FMP_BASE_URL/,
      );
    }
  });

  it("refuses a loopback or plain-http base URL in production and names only the variable", () => {
    for (const value of [
      "http://127.0.0.1:3011/stable/",
      "https://localhost/stable/",
      "http://fmp.example.test/stable/",
    ]) {
      expect(() =>
        getFmpConfig({ ...KEY, NODE_ENV: "production", FMP_BASE_URL: value }),
      ).toThrow(/FMP_BASE_URL/);
    }
    expect(
      getFmpConfig({
        ...KEY,
        NODE_ENV: "production",
        FMP_BASE_URL: "https://fmp-proxy.example.test/stable/",
      }).baseUrl,
    ).toBe("https://fmp-proxy.example.test/stable/");
  });

  it("still requires the API key, whatever the base URL", () => {
    expect(() =>
      getFmpConfig({ FMP_BASE_URL: "http://127.0.0.1:3011/stable/" }),
    ).toThrow(/FMP_API_KEY is required/);
  });
});

describe("backtest worker configuration", () => {
  it("defaults to a conservative local execution profile", () => {
    const config = getBacktestWorkerConfig({});

    expect(config).toEqual({
      processes: 2,
      pollIntervalMs: 1_000,
      leaseMs: 60_000,
      heartbeatIntervalMs: 15_000,
      maxAttempts: 3,
      retryBackoffMs: 15_000,
      checkpointEveryDays: 5,
      checkpointMinIntervalMs: 1_000,
      frameConcurrency: 4,
      nonResidentFrameRead: "REBUILD",
    });
  });

  it("reads a configured execution profile", () => {
    const config = getBacktestWorkerConfig({
      BACKTEST_WORKER_PROCESSES: "8",
      BACKTEST_JOB_POLL_INTERVAL_MS: "250",
      BACKTEST_JOB_LEASE_MS: "120000",
      BACKTEST_JOB_HEARTBEAT_INTERVAL_MS: "20000",
      BACKTEST_JOB_MAX_ATTEMPTS: "5",
      BACKTEST_JOB_RETRY_BACKOFF_MS: "30000",
      BACKTEST_CHECKPOINT_EVERY_DAYS: "10",
      BACKTEST_CHECKPOINT_MIN_INTERVAL_MS: "500",
      BACKTEST_FRAME_LOAD_CONCURRENCY: "12",
    });

    expect(config.processes).toBe(8);
    expect(config.pollIntervalMs).toBe(250);
    expect(config.leaseMs).toBe(120_000);
    expect(config.heartbeatIntervalMs).toBe(20_000);
    expect(config.maxAttempts).toBe(5);
    expect(config.retryBackoffMs).toBe(30_000);
    expect(config.checkpointEveryDays).toBe(10);
    expect(config.checkpointMinIntervalMs).toBe(500);
    expect(config.frameConcurrency).toBe(12);
  });

  it("reads how a window reads a non-resident security, and refuses anything else", () => {
    expect(
      getBacktestWorkerConfig({ BACKTEST_NON_RESIDENT_FRAME_READ: "STORE" })
        .nonResidentFrameRead,
    ).toBe("STORE");
    expect(
      getBacktestWorkerConfig({ BACKTEST_NON_RESIDENT_FRAME_READ: "REBUILD" })
        .nonResidentFrameRead,
    ).toBe("REBUILD");
    for (const value of ["store", "POSTGRES", "1"]) {
      expect(() =>
        getBacktestWorkerConfig({ BACKTEST_NON_RESIDENT_FRAME_READ: value }),
      ).toThrow(/BACKTEST_NON_RESIDENT_FRAME_READ/);
    }
  });

  it("rejects a worker count that cannot run", () => {
    expect(() =>
      getBacktestWorkerConfig({ BACKTEST_WORKER_PROCESSES: "0" }),
    ).toThrow("BACKTEST_WORKER_PROCESSES must be a positive integer");
  });

  // A typo here would fork a process per unit rather than per worker, so it fails at startup
  // instead of exhausting the database connection budget under load.
  it("rejects more workers than the supported maximum", () => {
    expect(() =>
      getBacktestWorkerConfig({ BACKTEST_WORKER_PROCESSES: "200" }),
    ).toThrow("BACKTEST_WORKER_PROCESSES must be between 1 and 32");
  });

  it("rejects a non-positive lease", () => {
    expect(() =>
      getBacktestWorkerConfig({ BACKTEST_JOB_LEASE_MS: "-1" }),
    ).toThrow("BACKTEST_JOB_LEASE_MS must be a positive integer");
  });
});

/**
 * The forensic archive is developer tooling that writes a user's whole run to a local disk, so
 * "off unless asked for" and "never in production" are configuration guarantees rather than
 * conventions someone has to remember.
 */
describe("backtest debug archive configuration", () => {
  it("is off by default", () => {
    const config = getBacktestDebugArchiveConfig({});

    expect(config.mode).toBe("off");
    expect(config.enabled).toBe(false);
  });

  it("enables the full capture and defaults its directory", () => {
    const config = getBacktestDebugArchiveConfig(
      { BACKTEST_DEBUG_ARCHIVE: "full" },
      repositoryRoot(),
    );

    expect(config.mode).toBe("full");
    expect(config.enabled).toBe(true);
    expect(config.directory).toBe(
      join(repositoryRoot(), DEFAULT_BACKTEST_DEBUG_ARCHIVE_DIR),
    );
  });

  // `pnpm dev:worker` runs with the cwd inside apps/worker, so a relative directory has to mean
  // the same place whichever package started the process.
  it("resolves a relative directory against the repository root", () => {
    const config = getBacktestDebugArchiveConfig(
      {
        BACKTEST_DEBUG_ARCHIVE: "full",
        BACKTEST_DEBUG_ARCHIVE_DIR: "tmp/archives",
      },
      join(repositoryRoot(), "apps", "worker"),
    );

    expect(config.directory).toBe(join(repositoryRoot(), "tmp/archives"));
  });

  it("keeps an absolute directory as given", () => {
    const config = getBacktestDebugArchiveConfig({
      BACKTEST_DEBUG_ARCHIVE: "full",
      BACKTEST_DEBUG_ARCHIVE_DIR: "/var/tmp/backtest-archives",
    });

    expect(config.directory).toBe("/var/tmp/backtest-archives");
  });

  it("rejects a mode it does not implement", () => {
    expect(() =>
      getBacktestDebugArchiveConfig({ BACKTEST_DEBUG_ARCHIVE: "summary" }),
    ).toThrow("BACKTEST_DEBUG_ARCHIVE must be off or full");
  });

  it("refuses to capture in production", () => {
    expect(() =>
      getBacktestDebugArchiveConfig({
        NODE_ENV: "production",
        BACKTEST_DEBUG_ARCHIVE: "full",
      }),
    ).toThrow("BACKTEST_DEBUG_ARCHIVE must be off in production");
  });

  it("stays startable in production while it is off", () => {
    expect(() =>
      getBacktestDebugArchiveConfig({
        NODE_ENV: "production",
        BACKTEST_DEBUG_ARCHIVE: "off",
      }),
    ).not.toThrow();
  });
});

/** Mirrors how `loadRootEnv` locates the workspace, so this works from any cwd. */
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

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) {
      values[match[1] as string] = match[2] ?? "";
    }
  }
  return values;
}

/**
 * `.env.example` is the first thing a new contributor copies to `.env`, so the template has to
 * satisfy the parser it documents. A stray value left inside an optional group makes that group
 * look half-configured and stops the API from starting.
 */
describe(".env.example template", () => {
  const template = parseEnvFile(join(repositoryRoot(), ".env.example"));

  it("leaves every optional and secret value empty", () => {
    const mustBeEmpty = [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_CALLBACK_URL",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_SECURE",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "SMTP_FROM",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
      "QA_USER_EMAIL",
      "QA_USER_PASSWORD",
      "QA_ADMIN_EMAIL",
      "QA_ADMIN_PASSWORD",
      "FMP_API_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_STARTER_MONTHLY",
      "STRIPE_PRICE_PRO_MONTHLY",
      "STRIPE_PRICE_PRO_PLUS_MONTHLY",
    ];

    for (const name of mustBeEmpty) {
      expect(template).toHaveProperty(name);
      expect(`${name}=${template[name]}`).toBe(`${name}=`);
    }
    // A listed variable invites a value, and a value for a retired annual price refuses startup.
    expect(template).not.toHaveProperty("STRIPE_PRICE_STARTER_YEARLY");
    expect(template).not.toHaveProperty("STRIPE_PRICE_PRO_YEARLY");
  });

  it("parses cleanly, with Google and SMTP genuinely disabled", () => {
    expect(getGoogleOAuthConfig(template)).toBeNull();
    expect(getSmtpConfig(template)).toBeNull();
    expect(() => getAuthConfig(template)).not.toThrow();
    expect(() => getApiConfig(template)).not.toThrow();
    expect(() => getBacktestWorkerConfig(template)).not.toThrow();
    expect(() => getMonitorWorkerConfig(template)).not.toThrow();
    expect(() => getMarketDataWorkerConfig(template)).not.toThrow();
    expect(getBacktestDebugArchiveConfig(template).enabled).toBe(false);
    // Billing must be genuinely off in the template: a placeholder that parsed as "configured"
    // would make every fresh checkout fail at startup.
    expect(getStripeBillingConfig(template)).toBeNull();
  });
});

/**
 * Stripe billing configuration.
 *
 * `docs/decisions/stripe-billing-v1.md` section 2 makes two demands of this layer that are worth
 * testing rather than trusting: billing is optional as a whole but all-or-nothing once touched, and
 * sandbox and live material can never cross into the wrong environment.
 */
describe("getStripeBillingConfig", () => {
  const PRICES = {
    STRIPE_PRICE_STARTER_MONTHLY: "price_starter_m",
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_m",
    STRIPE_PRICE_PRO_PLUS_MONTHLY: "price_pro_plus_m",
  };

  function sandbox(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: "development",
      STRIPE_SECRET_KEY: "sk_test_abc123",
      STRIPE_WEBHOOK_SECRET: "whsec_abc123",
      ...PRICES,
      ...overrides,
    };
  }

  it("is null when nothing is configured", () => {
    expect(getStripeBillingConfig({ NODE_ENV: "development" })).toBeNull();
  });

  describe("retired prices (STRIPE_LEGACY_PRICES)", () => {
    it("is empty when unset", () => {
      expect(getStripeBillingConfig(sandbox())?.legacyPrices).toEqual([]);
    });

    it("parses each retired price with the plan and cadence it grants", () => {
      const config = getStripeBillingConfig(
        sandbox({ STRIPE_LEGACY_PRICES: " price_old1=STARTER/MONTH , price_old2=PRO/YEAR,price_old3=PRO_PLUS/MONTH " }),
      );
      expect(config?.legacyPrices).toEqual([
        { priceId: "price_old1", plan: "STARTER", interval: "MONTH" },
        { priceId: "price_old2", plan: "PRO", interval: "YEAR" },
        { priceId: "price_old3", plan: "PRO_PLUS", interval: "MONTH" },
      ]);
    });

    it.each([
      ["price_old1", "not price_…=PLAN/INTERVAL"],
      ["price_old1=FREE/MONTH", "FREE is never a price"],
      ["price_old1=PRO/WEEK", "unknown cadence"],
      ["prod_old1=PRO/MONTH", "not a price id"],
    ])("refuses %s (%s)", (entry) => {
      expect(() => getStripeBillingConfig(sandbox({ STRIPE_LEGACY_PRICES: entry }))).toThrow(
        /STRIPE_LEGACY_PRICES entry/,
      );
    });

    it("refuses a duplicate and a price that is also a current catalog price", () => {
      expect(() =>
        getStripeBillingConfig(
          sandbox({ STRIPE_LEGACY_PRICES: "price_old1=PRO/YEAR,price_old1=PRO/YEAR" }),
        ),
      ).toThrow(/appears twice/);
      expect(() =>
        getStripeBillingConfig(sandbox({ STRIPE_LEGACY_PRICES: "price_pro_m=PRO/MONTH" })),
      ).toThrow(/current catalog price/);
    });

    it("points an operator still setting a retired annual variable at it", () => {
      expect(() =>
        getStripeBillingConfig(sandbox({ STRIPE_PRICE_PRO_YEARLY: "price_pro_y" })),
      ).toThrow(/STRIPE_LEGACY_PRICES/);
    });
  });

  it("resolves a complete sandbox configuration", () => {
    const config = getStripeBillingConfig(sandbox());
    expect(config).not.toBeNull();
    expect(config?.testMode).toBe(true);
    expect(config?.priceIds).toEqual({
      STARTER_MONTHLY: "price_starter_m",
      PRO_MONTHLY: "price_pro_m",
      PRO_PLUS_MONTHLY: "price_pro_plus_m",
    });
  });

  it("derives return URLs from WEB_BASE_URL and never from a request", () => {
    const config = getStripeBillingConfig(
      sandbox({ WEB_BASE_URL: "https://app.example.test" }),
    );
    expect(config?.checkoutSuccessUrl).toBe(
      "https://app.example.test/billing?checkout=success",
    );
    expect(config?.checkoutCancelUrl).toBe(
      "https://app.example.test/billing?checkout=cancelled",
    );
    expect(config?.portalReturnUrl).toBe("https://app.example.test/billing");
  });

  it("refuses a half-configured biller rather than silently disabling it", () => {
    // Only the secret key set: partial configuration fails at startup, not at a customer's
    // Checkout, which is the whole point of the all-or-nothing rule.
    expect(() =>
      getStripeBillingConfig({
        NODE_ENV: "development",
        STRIPE_SECRET_KEY: "sk_test_abc123",
      }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET is required/);

    for (const missing of Object.keys(PRICES)) {
      const env = sandbox();
      delete env[missing];
      expect(() => getStripeBillingConfig(env)).toThrow(
        new RegExp(`${missing} is required`),
      );
    }
  });

  it("refuses a live key outside production", () => {
    expect(() =>
      getStripeBillingConfig(sandbox({ STRIPE_SECRET_KEY: "sk_live_abc123" })),
    ).toThrow(/live-mode key and NODE_ENV is 'development'/);
    expect(() =>
      getStripeBillingConfig(
        sandbox({ NODE_ENV: "test", STRIPE_SECRET_KEY: "rk_live_abc123" }),
      ),
    ).toThrow(/live-mode key and NODE_ENV is 'test'/);
  });

  it("refuses a sandbox key in production", () => {
    expect(() =>
      getStripeBillingConfig(
        sandbox({
          NODE_ENV: "production",
          AUTH_JWT_SECRET: "x".repeat(32),
        }),
      ),
    ).toThrow(/sandbox\/test-mode key and NODE_ENV is 'production'/);
  });

  it("accepts a live configuration in production", () => {
    const config = getStripeBillingConfig(
      sandbox({
        NODE_ENV: "production",
        STRIPE_SECRET_KEY: "sk_live_abc123",
        WEB_BASE_URL: "https://app.example.test",
      }),
    );
    expect(config?.testMode).toBe(false);
  });

  it("rejects malformed secrets and price IDs", () => {
    expect(() =>
      getStripeBillingConfig(sandbox({ STRIPE_SECRET_KEY: "pk_test_abc" })),
    ).toThrow(/must be a Stripe secret or restricted key/);
    expect(() =>
      getStripeBillingConfig(sandbox({ STRIPE_WEBHOOK_SECRET: "secret" })),
    ).toThrow(/must be a Stripe webhook signing secret/);
    expect(() =>
      getStripeBillingConfig(
        sandbox({ STRIPE_PRICE_PRO_MONTHLY: "prod_pro_monthly" }),
      ),
    ).toThrow(/STRIPE_PRICE_PRO_MONTHLY must be a Stripe Price ID/);
  });

  it("rejects two logical prices pointing at one Stripe price", () => {
    // The copy-paste that would sell Pro at the Starter price, or Pro+ at the Pro price.
    expect(() =>
      getStripeBillingConfig(
        sandbox({ STRIPE_PRICE_PRO_MONTHLY: "price_starter_m" }),
      ),
    ).toThrow(/each logical price must map to its own Stripe price/);
    expect(() =>
      getStripeBillingConfig(
        sandbox({ STRIPE_PRICE_PRO_PLUS_MONTHLY: "price_pro_m" }),
      ),
    ).toThrow(
      /STRIPE_PRICE_PRO_PLUS_MONTHLY and STRIPE_PRICE_PRO_MONTHLY are the same Stripe Price ID/,
    );
  });

  it("requires the Pro+ price once billing is configured", () => {
    // A deployment configured for the retired catalog that dropped its annual prices but never
    // added Pro+: refused at startup rather than failing the first Pro+ Checkout.
    const withoutProPlus = sandbox();
    delete withoutProPlus.STRIPE_PRICE_PRO_PLUS_MONTHLY;
    expect(() => getStripeBillingConfig(withoutProPlus)).toThrow(
      "Invalid application configuration: STRIPE_PRICE_PRO_PLUS_MONTHLY is required",
    );
    expect(() =>
      getStripeBillingConfig(sandbox({ STRIPE_PRICE_PRO_PLUS_MONTHLY: "  " })),
    ).toThrow(/STRIPE_PRICE_PRO_PLUS_MONTHLY is required/);
  });

  it.each(["STRIPE_PRICE_STARTER_YEARLY", "STRIPE_PRICE_PRO_YEARLY"])(
    "refuses the retired %s rather than ignoring it",
    (retired) => {
      // Set beside a complete monthly catalog, so nothing else about the configuration is wrong:
      // the deployment was set up for an annual price this product no longer sells.
      expect(() =>
        getStripeBillingConfig(sandbox({ [retired]: "price_retired_annual" })),
      ).toThrow(
        new RegExp(`${retired} belongs to the retired annual catalog and is no longer read`),
      );
    },
  );

  it("names every retired variable it refuses, and ignores one left blank", () => {
    expect(() =>
      getStripeBillingConfig(
        sandbox({
          STRIPE_PRICE_STARTER_YEARLY: "price_starter_y",
          STRIPE_PRICE_PRO_YEARLY: "price_pro_y",
        }),
      ),
    ).toThrow(
      /STRIPE_PRICE_STARTER_YEARLY and STRIPE_PRICE_PRO_YEARLY belong to the retired annual catalog/,
    );
    // An empty line kept from the old template configures nothing, so it is not a refusal.
    expect(
      getStripeBillingConfig(
        sandbox({ STRIPE_PRICE_STARTER_YEARLY: "", STRIPE_PRICE_PRO_YEARLY: " " }),
      )?.priceIds,
    ).toEqual({
      STARTER_MONTHLY: "price_starter_m",
      PRO_MONTHLY: "price_pro_m",
      PRO_PLUS_MONTHLY: "price_pro_plus_m",
    });
  });
});

describe("stock LRU capacity", () => {
  it("is a count of distinct securities, 100 by default", () => {
    expect(DEFAULT_STOCK_LRU_MAX_SECURITIES).toBe(100);
    expect(getStockDataConfig({}).lruMaxSecurities).toBe(100);
    expect(
      getStockDataConfig({ STOCK_LRU_MAX_SECURITIES: "2000" }).lruMaxSecurities,
    ).toBe(2000);
  });

  it("still reads the earlier names", () => {
    expect(
      getStockDataConfig({ STOCK_CACHE_MAX_RESIDENT_STOCKS: "250" })
        .lruMaxSecurities,
    ).toBe(250);
    expect(
      getStockDataConfig({ STOCK_CACHE_MAX_RESIDENT_SYMBOLS: "40" })
        .lruMaxSecurities,
    ).toBe(40);
    expect(
      getStockDataConfig({
        STOCK_LRU_MAX_SECURITIES: "300",
        STOCK_CACHE_MAX_RESIDENT_STOCKS: "300",
      }).lruMaxSecurities,
    ).toBe(300);
  });

  it("refuses two names with different values, and anything but a positive integer", () => {
    expect(() =>
      getStockDataConfig({
        STOCK_LRU_MAX_SECURITIES: "2000",
        STOCK_CACHE_MAX_RESIDENT_STOCKS: "100",
      }),
    ).toThrow("name different stock LRU capacities");
    for (const value of ["0", "-1", "1.5", "2GB"]) {
      expect(() =>
        getStockDataConfig({ STOCK_LRU_MAX_SECURITIES: value }),
      ).toThrow("must be a positive integer");
    }
  });
});
