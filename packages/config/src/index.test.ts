import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getApiConfig,
  getAuthConfig,
  getGoogleOAuthConfig,
  getQaPersonaConfig,
  getSmtpConfig,
  getWebBaseUrl,
  getWebPublicConfig,
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
    expect(
      getSmtpConfig({ ...SMTP_ENV, SMTP_PORT: "465" })?.secure,
    ).toBe(true);
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

describe("QA persona configuration", () => {
  const QA_ENV = {
    QA_USER_EMAIL: "qa-user@example.test",
    QA_USER_PASSWORD: "qa-user-password-value",
    QA_ADMIN_EMAIL: "qa-admin@example.test",
    QA_ADMIN_PASSWORD: "qa-admin-password-value",
  };

  it("reads both personas with their roles", () => {
    const config = getQaPersonaConfig(QA_ENV);

    expect(config.user).toMatchObject({
      email: "qa-user@example.test",
      role: "USER",
    });
    expect(config.admin).toMatchObject({
      email: "qa-admin@example.test",
      role: "ADMIN",
    });
  });

  it("requires every persona variable", () => {
    const withoutAdminEmail: Partial<typeof QA_ENV> = { ...QA_ENV };
    delete withoutAdminEmail.QA_ADMIN_EMAIL;

    expect(() => getQaPersonaConfig(withoutAdminEmail)).toThrow(
      "QA_ADMIN_EMAIL is required",
    );
    expect(() => getQaPersonaConfig({})).toThrow("QA_USER_PASSWORD is required");
  });

  it("rejects a persona password that is too short", () => {
    expect(() =>
      getQaPersonaConfig({ ...QA_ENV, QA_USER_PASSWORD: "short" }),
    ).toThrow("QA_USER_PASSWORD must be at least 12 characters");
  });
});

describe("browser-exposed configuration", () => {
  it("never exposes a server secret", () => {
    const publicConfig = getWebPublicConfig({
      ...GOOGLE_ENV,
      ...SMTP_ENV,
      AUTH_JWT_SECRET: JWT_SECRET,
      ADMIN_PASSWORD: "admin-password-value",
      QA_USER_PASSWORD: "qa-user-password-value",
      STRIPE_SECRET_KEY: "stripe-secret-key",
      FMP_API_KEY: "fmp-api-key",
      DATABASE_URL: "postgresql://user:password@localhost:5432/db",
      NEXT_PUBLIC_API_BASE_URL: "https://api.example.test",
    });

    const serialized = JSON.stringify(publicConfig);
    const secrets = [
      JWT_SECRET,
      "google-client-secret-value",
      "smtp-password-value",
      "smtp-user",
      "admin-password-value",
      "qa-user-password-value",
      "stripe-secret-key",
      "fmp-api-key",
      "postgresql://user:password@localhost:5432/db",
    ];

    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(publicConfig).sort()).toEqual([
      "apiBaseUrl",
      "stripePublishableKey",
    ]);
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
    ];

    for (const name of mustBeEmpty) {
      expect(template).toHaveProperty(name);
      expect(`${name}=${template[name]}`).toBe(`${name}=`);
    }
  });

  it("parses cleanly, with Google and SMTP genuinely disabled", () => {
    expect(getGoogleOAuthConfig(template)).toBeNull();
    expect(getSmtpConfig(template)).toBeNull();
    expect(() => getAuthConfig(template)).not.toThrow();
    expect(() => getApiConfig(template)).not.toThrow();
  });
});
