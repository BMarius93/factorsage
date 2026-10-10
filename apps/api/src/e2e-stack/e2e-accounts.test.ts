import {
  E2E_DISPOSABLE_ACCOUNT_KINDS,
  e2eDisposableAccountEmail,
  e2eDisposableAccountKindOf,
  e2eDisposableAccountPattern,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  E2eAccountCleanupRefusedError,
  resolveE2eAccountCleanupTarget,
} from "./e2e-accounts";

/**
 * Which addresses and which database the disposable-account cleanup may touch. The deletion itself,
 * against PostgreSQL, is `e2e-accounts.integration.test.ts`.
 */

const TEST_URL =
  "postgresql://intrinsic:secret@localhost:5432/intrinsic_value_test";
const DEVELOPMENT_URL =
  "postgresql://intrinsic:secret@localhost:5432/intrinsic_value";

describe("disposable E2E account addresses", () => {
  it("mints the escalation spec's addresses in their historical shape", () => {
    expect(e2eDisposableAccountEmail("escalation", 1_791_567_155_319)).toBe(
      "escalation-1791567155319@example.test",
    );
    expect(e2eDisposableAccountEmail("escalation")).toMatch(
      /^escalation-\d+@example\.test$/,
    );
  });

  it("matches the escalation kind by exactly ^escalation-\\d+@example\\.test$", () => {
    expect(e2eDisposableAccountPattern("escalation").source).toBe(
      /^escalation-\d+@example\.test$/.source,
    );
    expect(e2eDisposableAccountPattern("escalation").flags).toBe("");
  });

  it.each([
    "escalation-1791567155319@example.test",
    "escalation-0@example.test",
  ])("claims %s", (email) => {
    expect(e2eDisposableAccountKindOf(email)).toBe("escalation");
  });

  it.each([
    "escalation-@example.test",
    "escalation-12a@example.test",
    "escalation-1-2@example.test",
    "escalation-1@example.test.evil",
    "escalation-1@example.testx",
    "escalation-1@sub.example.test",
    "escalation-1@exampleXtest",
    "xescalation-1@example.test",
    "Escalation-1@example.test",
    "escalation-1@Example.test",
    " escalation-1@example.test",
    "escalation-1@example.test\n",
    "escalation 1@example.test",
    "qa-user@factorsage.test",
    "pro@example.test",
  ])("never claims %j", (email) => {
    expect(e2eDisposableAccountKindOf(email)).toBeNull();
  });

  it("mints the email lifecycle suite's addresses as their own kind", () => {
    expect(e2eDisposableAccountEmail("authmail", 1_791_567_155_319)).toBe(
      "authmail-1791567155319@example.test",
    );
    expect(e2eDisposableAccountPattern("authmail").source).toBe(
      /^authmail-\d+@example\.test$/.source,
    );
    expect(
      e2eDisposableAccountKindOf("authmail-1791567155319@example.test"),
    ).toBe("authmail");
    for (const email of [
      "xauthmail-1@example.test",
      "Authmail-1@example.test",
      "authmail-1@example.test.evil",
      "authmail-@example.test",
    ]) {
      expect(e2eDisposableAccountKindOf(email)).toBeNull();
    }
  });

  it("never lets one kind claim another kind's address", () => {
    for (const kind of E2E_DISPOSABLE_ACCOUNT_KINDS) {
      const email = e2eDisposableAccountEmail(kind, 1);
      expect(e2eDisposableAccountKindOf(email)).toBe(kind);
      for (const other of E2E_DISPOSABLE_ACCOUNT_KINDS) {
        expect(e2eDisposableAccountPattern(other).test(email)).toBe(
          other === kind,
        );
      }
    }
  });

  it("declares kinds that are plain lowercase words, never patterns", () => {
    for (const kind of E2E_DISPOSABLE_ACCOUNT_KINDS) {
      expect(kind).toMatch(/^[a-z]+$/);
    }
  });

  it("refuses a stamp that is not a non-negative integer", () => {
    expect(() => e2eDisposableAccountEmail("escalation", -1)).toThrow();
    expect(() => e2eDisposableAccountEmail("escalation", 1.5)).toThrow();
    expect(() => e2eDisposableAccountEmail("escalation", Number.NaN)).toThrow();
  });
});

describe("resolveE2eAccountCleanupTarget", () => {
  function refusal(env: NodeJS.ProcessEnv): string {
    try {
      resolveE2eAccountCleanupTarget(env);
    } catch (error) {
      expect(error).toBeInstanceOf(E2eAccountCleanupRefusedError);
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  }

  it("resolves the dedicated local test database", () => {
    expect(
      resolveE2eAccountCleanupTarget({
        TEST_DATABASE_URL: ` ${TEST_URL} `,
        DATABASE_URL: DEVELOPMENT_URL,
      }),
    ).toEqual({ databaseUrl: TEST_URL, databaseName: "intrinsic_value_test" });
  });

  it("accepts every loopback spelling", () => {
    for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
      expect(
        resolveE2eAccountCleanupTarget({
          TEST_DATABASE_URL: `postgres://u:p@${host}:5432/factorsage_test?schema=public`,
        }).databaseName,
      ).toBe("factorsage_test");
    }
  });

  it("refuses production before looking at anything else", () => {
    expect(
      refusal({
        NODE_ENV: "production",
        TEST_DATABASE_URL: TEST_URL,
        DATABASE_URL: DEVELOPMENT_URL,
      }),
    ).toMatch(/NODE_ENV is production/);
    expect(refusal({ NODE_ENV: " production " })).toMatch(/production/);
  });

  it("refuses without TEST_DATABASE_URL and never falls back to DATABASE_URL", () => {
    expect(refusal({ DATABASE_URL: TEST_URL })).toMatch(
      /TEST_DATABASE_URL is not set/,
    );
    expect(refusal({ TEST_DATABASE_URL: "  " })).toMatch(/not set/);
  });

  it.each([
    ["not a URL", "intrinsic_value_test", /not a valid URL/],
    [
      "another scheme",
      "mysql://u:p@localhost/intrinsic_value_test",
      /not a PostgreSQL URL/,
    ],
    ["no database", "postgresql://u:p@localhost:5432/", /names no database/],
  ])("refuses %s", (_label, url, message) => {
    expect(refusal({ TEST_DATABASE_URL: url })).toMatch(message);
  });

  it.each([
    "db.internal",
    "10.0.0.5",
    "prod.example.com",
    "localhost.evil.com",
  ])("refuses the non-local host %s", (host) => {
    expect(
      refusal({
        TEST_DATABASE_URL: `postgresql://u:p@${host}:5432/intrinsic_value_test`,
      }),
    ).toMatch(/not a local host/);
  });

  it.each([
    "intrinsic_value",
    "contest",
    "intrinsic_value_testing",
    "testdb",
    "postgres",
  ])("refuses the database %s, whose name has no test segment", (name) => {
    expect(
      refusal({ TEST_DATABASE_URL: `postgresql://u:p@localhost:5432/${name}` }),
    ).toMatch(/does not identify itself as a test database/);
  });

  it("refuses the development database, however the URL is spelled", () => {
    expect(
      refusal({ TEST_DATABASE_URL: TEST_URL, DATABASE_URL: TEST_URL }),
    ).toMatch(/names the development database/);
    expect(
      refusal({
        TEST_DATABASE_URL:
          "postgresql://a:b@127.0.0.1:5432/intrinsic_value_test",
        DATABASE_URL: "postgresql://c:d@localhost:5433/INTRINSIC_VALUE_TEST",
      }),
    ).toMatch(/names the development database/);
  });

  it("allows no CI exception", () => {
    expect(
      refusal({
        CI: "true",
        TEST_DATABASE_URL: TEST_URL,
        DATABASE_URL: TEST_URL,
      }),
    ).toMatch(/names the development database/);
  });
});
