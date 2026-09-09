/**
 * The dedicated environment the Backtest V1 validation matrix executes in.
 *
 * A thousand thirty-year backtests need decades of real canonical history, and none of the three
 * databases that already exist is the right place to put it:
 *
 * - the **development** database has that history, and is exactly what must not be reset, mutated
 *   or filled with a thousand QA runs;
 * - the **test** database is deliberately lightweight and carries a short synthetic execution
 *   calendar, so a "thirty-year" matrix run against it would silently become a six-year one
 *   compared against invented history — the failure mode that is worst of all, because it reports
 *   success;
 * - **production** is never a target of anything in this file.
 *
 * So the matrix gets its own: a local PostgreSQL database whose name says what it is, populated by
 * copying already-durable canonical market data out of the development database rather than by
 * asking the provider for it again. `provision-matrix-database.ts` does that copy; this module only
 * decides where it may point and refuses everything else.
 *
 * Redis is isolated by **logical database index**, not by a key prefix. The matrix worker runs the
 * real composition root, which builds its cache namespaces from the same constants the development
 * stack does, so two processes sharing one Redis database would share projections, hydration locks
 * and the FMP gate. A different index is one character of configuration and cannot be got wrong by
 * a namespace that was forgotten somewhere.
 */

export const MATRIX_DATABASE_URL_ENV = "QA_MATRIX_DATABASE_URL";
export const MATRIX_REDIS_URL_ENV = "QA_MATRIX_REDIS_URL";
export const MATRIX_REDIS_DB_ENV = "QA_MATRIX_REDIS_DB";
export const MATRIX_SOURCE_DATABASE_URL_ENV = "QA_MATRIX_SOURCE_DATABASE_URL";
export const MATRIX_ALLOW_REMOTE_HOST_ENV = "QA_MATRIX_ALLOW_REMOTE_HOST";

/**
 * The marker a matrix database's name must carry.
 *
 * "Keep the matrix environment clearly identifiable" is not decoration: every destructive operation
 * in the runner — dropping a thousand previous runs, provisioning, re-seeding — is safe only
 * because of where it points. A name that has to be read out of a URL to be recognized is a name
 * that will eventually be misread, so the requirement is mechanical.
 */
export const MATRIX_DATABASE_NAME_MARKER = "matrix";

/** Redis logical database the matrix uses when nothing more specific is configured. */
export const DEFAULT_MATRIX_REDIS_DB = 3;

/** Hosts a matrix database may live on without an explicit override. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
  "postgres",
  "redis",
]);

export class MatrixEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixEnvironmentError";
  }
}

export type MatrixEnvironment = {
  /** Where the matrix executes. Never the development, test or production database. */
  readonly databaseUrl: string;
  /** The database's own name, e.g. `intrinsic_value_matrix`. */
  readonly databaseName: string;
  readonly host: string;
  readonly port: number;
  /** A URL to the same server's `postgres` database, used only to `CREATE DATABASE`. */
  readonly adminDatabaseUrl: string;
  /** Redis, on its own logical database so matrix cache state cannot reach dev or test. */
  readonly redisUrl: string;
  readonly redisDb: number;
  /**
   * Where canonical market data is copied **from** during provisioning. Read-only: the provisioner
   * never issues a write against it, which is what makes reusing the development database's
   * thirty-four years of hydrated history safe.
   */
  readonly sourceDatabaseUrl: string;
  /**
   * The development and test connections **as they were before this process was pointed at the
   * matrix**.
   *
   * Captured here rather than re-read later because `useMatrixDatabase` overwrites `DATABASE_URL`
   * and `REDIS_URL` in place. A safety check that read the environment afterwards would compare the
   * matrix URL with itself and report isolation it had not actually verified — which is worse than
   * no check, because it is a green line that means nothing.
   */
  readonly developmentDatabaseUrl: string | null;
  readonly developmentRedisUrl: string | null;
  readonly testDatabaseUrl: string | null;
};

function parsePostgresUrl(
  value: string,
  variable: string,
): { url: URL; database: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MatrixEnvironmentError(
      `${variable} is not a valid URL: \`${redactUrl(value)}\``,
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new MatrixEnvironmentError(
      `${variable} must be a postgresql:// URL; received \`${url.protocol}//…\``,
    );
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new MatrixEnvironmentError(`${variable} names no database`);
  }
  return { url, database };
}

/** A URL with any credentials removed, so a failure message can name it without leaking a password. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<unparseable>";
  }
}

function databaseNameOf(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return new URL(value.trim()).pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the matrix environment, refusing every target that is not it.
 *
 * The checks are ordered cheapest-and-most-catastrophic first. Nothing here opens a connection: a
 * misconfiguration must be reported before a client exists that could act on it.
 */
export function resolveMatrixEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): MatrixEnvironment {
  if (env.NODE_ENV?.trim() === "production") {
    throw new MatrixEnvironmentError(
      "Refusing to resolve a QA matrix environment: NODE_ENV is production. The matrix seeds " +
        "deterministic QA fixtures, deletes previous QA runs and provisions a database from a " +
        "copy of another one. None of that may ever happen against production data.",
    );
  }

  const raw = env[MATRIX_DATABASE_URL_ENV]?.trim();
  if (!raw) {
    throw new MatrixEnvironmentError(
      `${MATRIX_DATABASE_URL_ENV} is not set. The Backtest V1 validation matrix runs against its ` +
        "own database — never the development one, which must not be reset, and never the test " +
        "one, whose execution calendar is too short for a thirty-year run. Add a line such as\n" +
        `  ${MATRIX_DATABASE_URL_ENV}=postgresql://intrinsic:…@localhost:5432/intrinsic_value_matrix\n` +
        "to .env, then run `pnpm qa:matrix:provision`.",
    );
  }

  const { url, database } = parsePostgresUrl(raw, MATRIX_DATABASE_URL_ENV);

  const developmentDatabase = databaseNameOf(env.DATABASE_URL);
  const testDatabase = databaseNameOf(env.TEST_DATABASE_URL);
  if (database === developmentDatabase) {
    throw new MatrixEnvironmentError(
      `${MATRIX_DATABASE_URL_ENV} names the development database (\`${database}\`). The matrix ` +
        "provisions, re-seeds and deletes runs; the development database is the one durable copy " +
        "of the hydrated history it reads from and must never be its target.",
    );
  }
  if (database === testDatabase) {
    throw new MatrixEnvironmentError(
      `${MATRIX_DATABASE_URL_ENV} names the test database (\`${database}\`). Keeping them apart is ` +
        "the point: the ordinary test database is intentionally lightweight and carries a short " +
        "synthetic execution calendar, so a thirty-year matrix run against it would be silently " +
        "clipped to whatever it happens to cover.",
    );
  }

  if (!database.toLowerCase().includes(MATRIX_DATABASE_NAME_MARKER)) {
    throw new MatrixEnvironmentError(
      `${MATRIX_DATABASE_URL_ENV} must name a database whose name contains ` +
        `"${MATRIX_DATABASE_NAME_MARKER}" so the matrix environment is identifiable at a glance; ` +
        `received \`${database}\`. Every destructive step the runner takes is safe only because ` +
        "of where it points, so that has to be readable rather than remembered.",
    );
  }

  const allowRemote = env[MATRIX_ALLOW_REMOTE_HOST_ENV]?.trim() === "true";
  if (!allowRemote && !LOCAL_HOSTS.has(url.hostname)) {
    throw new MatrixEnvironmentError(
      `${MATRIX_DATABASE_URL_ENV} points at \`${url.hostname}\`, which is not a local host. The ` +
        "matrix is developer/QA tooling and defaults to refusing a remote server outright rather " +
        `than trusting a name. Set ${MATRIX_ALLOW_REMOTE_HOST_ENV}=true only for a database you ` +
        "are certain is disposable.",
    );
  }

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";

  const { redisUrl, redisDb } = resolveMatrixRedis(env);

  const sourceDatabaseUrl =
    env[MATRIX_SOURCE_DATABASE_URL_ENV]?.trim() || env.DATABASE_URL?.trim();
  if (!sourceDatabaseUrl) {
    throw new MatrixEnvironmentError(
      `Neither ${MATRIX_SOURCE_DATABASE_URL_ENV} nor DATABASE_URL is set, so there is no source ` +
        "of canonical market data to populate the matrix database from. The matrix deliberately " +
        "reuses already-durable history instead of re-fetching decades of it from the provider.",
    );
  }
  parsePostgresUrl(sourceDatabaseUrl, MATRIX_SOURCE_DATABASE_URL_ENV);
  if (databaseNameOf(sourceDatabaseUrl) === database) {
    throw new MatrixEnvironmentError(
      "The matrix database cannot also be its own provisioning source.",
    );
  }

  return {
    databaseUrl: raw,
    databaseName: database,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    adminDatabaseUrl: adminUrl.toString(),
    redisUrl,
    redisDb,
    sourceDatabaseUrl,
    developmentDatabaseUrl: env.DATABASE_URL?.trim() ?? null,
    developmentRedisUrl: env.REDIS_URL?.trim() ?? null,
    testDatabaseUrl: env.TEST_DATABASE_URL?.trim() ?? null,
  };
}

/**
 * The matrix's Redis connection, on a logical database of its own.
 *
 * Derived from `REDIS_URL` by default so there is one Redis server to run locally and no second
 * connection string to keep in step. An explicit `QA_MATRIX_REDIS_URL` wins, and either way the
 * result must not land on the same logical database the development stack uses — a shared index
 * would share projections, the hydration lock and the FMP gate, which is precisely the
 * interference this exists to prevent.
 */
export function resolveMatrixRedis(env: NodeJS.ProcessEnv = process.env): {
  redisUrl: string;
  redisDb: number;
} {
  const configuredDb = env[MATRIX_REDIS_DB_ENV]?.trim();
  const matrixDb = configuredDb ? Number(configuredDb) : DEFAULT_MATRIX_REDIS_DB;
  if (!Number.isInteger(matrixDb) || matrixDb < 0 || matrixDb > 15) {
    throw new MatrixEnvironmentError(
      `${MATRIX_REDIS_DB_ENV} must be an integer Redis database index between 0 and 15; received ` +
        `\`${configuredDb}\``,
    );
  }

  const baseUrl = env.REDIS_URL?.trim();
  const explicit = env[MATRIX_REDIS_URL_ENV]?.trim();
  if (!explicit && !baseUrl) {
    throw new MatrixEnvironmentError(
      `Neither ${MATRIX_REDIS_URL_ENV} nor REDIS_URL is set, so the matrix has no cache to run ` +
        "against.",
    );
  }

  let url: URL;
  try {
    url = new URL(explicit ?? (baseUrl as string));
  } catch {
    throw new MatrixEnvironmentError(
      `${explicit ? MATRIX_REDIS_URL_ENV : "REDIS_URL"} is not a valid URL`,
    );
  }
  if (!explicit) {
    url.pathname = `/${matrixDb}`;
  }

  const resolvedDb = redisDatabaseIndexOf(url);
  const developmentDb = baseUrl
    ? redisDatabaseIndexOf(new URL(baseUrl))
    : null;
  if (
    developmentDb !== null &&
    resolvedDb === developmentDb &&
    url.host === new URL(baseUrl as string).host
  ) {
    throw new MatrixEnvironmentError(
      `The matrix Redis connection resolves to database ${resolvedDb} on the same server as ` +
        "REDIS_URL. Matrix execution must not share cached projections, hydration locks or the " +
        `FMP gate with the development stack — give it its own index, for example ` +
        `${MATRIX_REDIS_URL_ENV}=redis://localhost:6379/${DEFAULT_MATRIX_REDIS_DB}.`,
    );
  }

  return { redisUrl: url.toString(), redisDb: resolvedDb };
}

/** ioredis reads the logical database from the URL path; an absent path means database 0. */
export function redisDatabaseIndexOf(url: URL): number {
  const path = url.pathname.replace(/^\//, "");
  if (!path) {
    return 0;
  }
  const parsed = Number(path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MatrixEnvironmentError(
      `\`${url.pathname}\` is not a Redis database index`,
    );
  }
  return parsed;
}

/**
 * Marks this process as pointed at the matrix database.
 *
 * The QA seed guard refuses to write deterministic fixtures anywhere but a database that has been
 * proven not to be development or production. `useTestDatabase` makes exactly the same claim for
 * the test database and records it the same way; this is the third legitimate target, and it is
 * recorded rather than special-cased inside the guard so the guard keeps one rule.
 */
export const MATRIX_DATABASE_ACTIVE_ENV = "INTRINSIC_QA_MATRIX_DATABASE_ACTIVE";

/**
 * Points this process's Prisma clients at the matrix database.
 *
 * Call it before anything constructs a `PrismaClient` — directly or through Nest — for the same
 * reason `useTestDatabase` must be called at module scope: the client reads `DATABASE_URL` when it
 * is constructed. `resolveMatrixEnvironment` has already refused every unsafe target by the time
 * this returns.
 */
export function useMatrixDatabase(
  env: NodeJS.ProcessEnv = process.env,
): MatrixEnvironment {
  const environment = resolveMatrixEnvironment(env);
  env.DATABASE_URL = environment.databaseUrl;
  env.REDIS_URL = environment.redisUrl;
  env[MATRIX_DATABASE_ACTIVE_ENV] = "true";
  return environment;
}
