import { describe, expect, it } from "vitest";
import {
  PRODUCTION_QA_PERSONA_MESSAGE,
  QA_PERSONA_ALLOW_REMOTE_HOST_ENV,
  QA_PERSONA_DATABASE_URL_ENV,
  QaPersonaEnvironmentError,
  redactDatabaseUrl,
  resolveQaPersonaEnvironment,
} from "./qa-persona-environment";

/**
 * The refusals are the feature.
 *
 * `pnpm qa:reset` deletes rows, and the only thing standing between it and a database that is not
 * a local QA one is this resolver — so each refusal is asserted on its own rather than inferred
 * from the happy path.
 */
describe("resolveQaPersonaEnvironment", () => {
  const local = "postgresql://user:secret@localhost:5432/intrinsic_value";

  it("resolves the development database by default", () => {
    const environment = resolveQaPersonaEnvironment({ DATABASE_URL: local });

    expect(environment.databaseName).toBe("intrinsic_value");
    expect(environment.host).toBe("localhost");
    expect(environment.source).toBe("DATABASE_URL");
  });

  it("prefers the explicit QA override and says so", () => {
    const environment = resolveQaPersonaEnvironment({
      DATABASE_URL: local,
      [QA_PERSONA_DATABASE_URL_ENV]:
        "postgresql://user:secret@127.0.0.1:5432/intrinsic_value_qa",
    });

    expect(environment.databaseName).toBe("intrinsic_value_qa");
    expect(environment.source).toBe(QA_PERSONA_DATABASE_URL_ENV);
  });

  it("refuses production before looking at anything else", () => {
    expect(() =>
      resolveQaPersonaEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: local,
      }),
    ).toThrow(PRODUCTION_QA_PERSONA_MESSAGE);
  });

  it("refuses a host that is not this machine", () => {
    expect(() =>
      resolveQaPersonaEnvironment({
        DATABASE_URL:
          "postgresql://user:secret@db.staging.example.com:5432/app",
      }),
    ).toThrow(QaPersonaEnvironmentError);
  });

  it("accepts a remote host only on deliberate opt-in", () => {
    const environment = resolveQaPersonaEnvironment({
      DATABASE_URL: "postgresql://user:secret@db.staging.example.com:5432/app",
      [QA_PERSONA_ALLOW_REMOTE_HOST_ENV]: "true",
    });

    expect(environment.host).toBe("db.staging.example.com");
  });

  it("refuses a URL that is not PostgreSQL, and one that names no database", () => {
    expect(() =>
      resolveQaPersonaEnvironment({
        DATABASE_URL: "mysql://localhost:3306/app",
      }),
    ).toThrow(/must be a postgresql/);
    expect(() =>
      resolveQaPersonaEnvironment({
        DATABASE_URL: "postgresql://localhost:5432",
      }),
    ).toThrow(/names no database/);
  });

  it("refuses when no database is configured at all", () => {
    expect(() => resolveQaPersonaEnvironment({})).toThrow(/needs a database/);
  });

  it("never echoes a password when naming a target", () => {
    const redacted = redactDatabaseUrl(local);

    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("intrinsic_value");
  });
});
