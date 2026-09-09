import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATRIX_REDIS_DB,
  MatrixEnvironmentError,
  resolveMatrixEnvironment,
  resolveMatrixRedis,
  useMatrixDatabase,
  MATRIX_DATABASE_ACTIVE_ENV,
} from "./matrix-environment";
import {
  defaultMatrixConcurrency,
  MatrixConcurrencyConfigError,
  resolveMatrixConcurrency,
} from "./matrix-concurrency";
import { assertQaSecuritySeedingAllowed } from "../stocks/seed-qa-securities";

/**
 * Where the matrix may point, and where it may not.
 *
 * The matrix provisions a database, deletes a thousand runs and re-seeds fixtures. Every one of
 * those is safe only because of the target, so the target is decided by rules that refuse before a
 * client exists rather than by a developer remembering which URL is in which variable.
 */
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@localhost:5432/intrinsic_value",
  TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/intrinsic_value_test",
  QA_MATRIX_DATABASE_URL: "postgresql://u:p@localhost:5432/intrinsic_value_matrix",
  REDIS_URL: "redis://localhost:6379",
};

describe("matrix environment safety", () => {
  it("resolves a well-formed local matrix environment", () => {
    const environment = resolveMatrixEnvironment({ ...BASE });
    expect(environment.databaseName).toBe("intrinsic_value_matrix");
    expect(environment.host).toBe("localhost");
    expect(environment.adminDatabaseUrl).toContain("/postgres");
    expect(environment.redisDb).toBe(DEFAULT_MATRIX_REDIS_DB);
    expect(environment.sourceDatabaseUrl).toBe(BASE.DATABASE_URL);
  });

  it("refuses production outright", () => {
    expect(() =>
      resolveMatrixEnvironment({ ...BASE, NODE_ENV: "production" }),
    ).toThrow(/NODE_ENV is production/);
  });

  it("refuses the development database", () => {
    expect(() =>
      resolveMatrixEnvironment({
        ...BASE,
        QA_MATRIX_DATABASE_URL: BASE.DATABASE_URL,
      }),
    ).toThrow(MatrixEnvironmentError);
  });

  it("refuses the test database, because its calendar is too short for a thirty-year run", () => {
    expect(() =>
      resolveMatrixEnvironment({
        ...BASE,
        QA_MATRIX_DATABASE_URL:
          "postgresql://u:p@localhost:5432/intrinsic_value_test",
      }),
    ).toThrow(/names the test database/);
  });

  it("requires the database name to identify itself", () => {
    expect(() =>
      resolveMatrixEnvironment({
        ...BASE,
        QA_MATRIX_DATABASE_URL: "postgresql://u:p@localhost:5432/scratch",
      }),
    ).toThrow(/contains\s+"matrix"/);
  });

  it("refuses a remote host unless it is explicitly allowed", () => {
    const remote = {
      ...BASE,
      QA_MATRIX_DATABASE_URL: "postgresql://u:p@db.example.com:5432/value_matrix",
    };
    expect(() => resolveMatrixEnvironment(remote)).toThrow(/not a local host/);
    expect(
      resolveMatrixEnvironment({
        ...remote,
        QA_MATRIX_ALLOW_REMOTE_HOST: "true",
      }).host,
    ).toBe("db.example.com");
  });

  it("refuses when nothing names the matrix database", () => {
    const withoutMatrix = { ...BASE };
    delete withoutMatrix.QA_MATRIX_DATABASE_URL;
    expect(() => resolveMatrixEnvironment(withoutMatrix)).toThrow(
      /QA_MATRIX_DATABASE_URL is not set/,
    );
  });

  it("refuses to provision a database from itself", () => {
    expect(() =>
      resolveMatrixEnvironment({
        ...BASE,
        QA_MATRIX_SOURCE_DATABASE_URL: BASE.QA_MATRIX_DATABASE_URL,
      }),
    ).toThrow(/its own provisioning source/);
  });
});

describe("matrix Redis isolation", () => {
  it("derives its own logical database from REDIS_URL", () => {
    expect(resolveMatrixRedis({ ...BASE })).toEqual({
      redisUrl: "redis://localhost:6379/3",
      redisDb: 3,
    });
  });

  it("honours an explicit index", () => {
    expect(resolveMatrixRedis({ ...BASE, QA_MATRIX_REDIS_DB: "7" }).redisDb).toBe(7);
  });

  it("refuses to share the development stack's logical database", () => {
    // Sharing an index would share cached projections, the hydration lock and the FMP gate — the
    // exact interference a separate namespace exists to prevent.
    expect(() =>
      resolveMatrixRedis({
        ...BASE,
        QA_MATRIX_REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/same server as REDIS_URL/);
    expect(() =>
      resolveMatrixRedis({
        ...BASE,
        REDIS_URL: "redis://localhost:6379/3",
        QA_MATRIX_REDIS_URL: "redis://localhost:6379/3",
      }),
    ).toThrow(/same server as REDIS_URL/);
  });

  it("allows a different server at the same index", () => {
    expect(
      resolveMatrixRedis({
        ...BASE,
        QA_MATRIX_REDIS_URL: "redis://127.0.0.1:6380/0",
      }).redisDb,
    ).toBe(0);
  });

  it("rejects an index outside the Redis range", () => {
    expect(() =>
      resolveMatrixRedis({ ...BASE, QA_MATRIX_REDIS_DB: "99" }),
    ).toThrow(/between 0 and 15/);
  });
});

describe("pointing a process at the matrix database", () => {
  it("rewrites the connection variables and records the target", () => {
    const env: NodeJS.ProcessEnv = { ...BASE };
    const environment = useMatrixDatabase(env);
    expect(env.DATABASE_URL).toBe(environment.databaseUrl);
    expect(env.REDIS_URL).toBe(environment.redisUrl);
    expect(env[MATRIX_DATABASE_ACTIVE_ENV]).toBe("true");
  });

  it("is accepted by the QA seed guard, which otherwise only allows the test database", () => {
    const env: NodeJS.ProcessEnv = { ...BASE };
    useMatrixDatabase(env);
    expect(() => assertQaSecuritySeedingAllowed(env)).not.toThrow();
    // The marker is not a bypass for production.
    expect(() =>
      assertQaSecuritySeedingAllowed({ ...env, NODE_ENV: "production" }),
    ).toThrow();
  });
});

describe("matrix concurrency", () => {
  it("stays conservative on a small machine: memory binds before cores", () => {
    // A worker child holds a year of frames, the run's trades and equity, a Prisma client and a
    // Node runtime. Cores are not the scarce resource.
    expect(defaultMatrixConcurrency(8, 8 * 1024 ** 3)).toBe(3);
    expect(defaultMatrixConcurrency(16, 64 * 1024 ** 3)).toBe(4);
    expect(defaultMatrixConcurrency(2, 4 * 1024 ** 3)).toBe(1);
    expect(defaultMatrixConcurrency(1, 1 * 1024 ** 3)).toBe(1);
  });

  it("prefers an explicit flag, then the environment, then the machine", () => {
    expect(resolveMatrixConcurrency("6", {})).toBe(6);
    expect(resolveMatrixConcurrency(undefined, { QA_MATRIX_CONCURRENCY: "2" })).toBe(2);
    expect(resolveMatrixConcurrency(undefined, {})).toBeGreaterThanOrEqual(1);
  });

  it("rejects a value that is not a usable worker-process count", () => {
    expect(() => resolveMatrixConcurrency("0", {})).toThrow(
      MatrixConcurrencyConfigError,
    );
    expect(() => resolveMatrixConcurrency("2.5", {})).toThrow();
    expect(() => resolveMatrixConcurrency("64", {})).toThrow();
  });
});
