import { loadRootEnv } from "@intrinsic/config";

/**
 * Points this process at the dedicated PostgreSQL test database.
 *
 * `DATABASE_URL` is the development database and must never be written to by tests, so
 * PostgreSQL-backed suites resolve their connection through `TEST_DATABASE_URL` instead.
 * There is deliberately no fallback: an unconfigured run fails loudly rather than quietly
 * mutating development data.
 *
 * Call this at module scope of a PostgreSQL-backed test file, before anything constructs a
 * Prisma client. `PrismaClient` reads `DATABASE_URL` when it is constructed — directly, or
 * through `PrismaService` when a Nest testing module compiles — so the swap must already
 * have happened by then. Module-scope calls run after the file's imports are evaluated and
 * before any `beforeAll`, which satisfies both.
 *
 * Redis isolation is deliberately not handled here: suites isolate Redis with randomized key
 * namespaces and targeted cleanup, never by switching instances or flushing.
 */
export function useTestDatabase(): string {
  loadRootEnv();
  const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
  const developmentDatabaseUrl = process.env.DATABASE_URL?.trim();

  if (!testDatabaseUrl) {
    throw new Error(
      "PostgreSQL-backed tests require TEST_DATABASE_URL pointing at a dedicated test " +
        "database (for example intrinsic_value_test). DATABASE_URL is the development " +
        "database and is never used as a fallback, so an accidental run cannot write test " +
        "fixtures into development data.\n" +
        "Create and migrate the test database once:\n" +
        "  docker compose exec -T postgres createdb -U intrinsic intrinsic_value_test\n" +
        "  TEST_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_test \\\n" +
        "    pnpm db:test:prepare\n" +
        "Then keep that TEST_DATABASE_URL line in your .env.",
    );
  }

  // CI runs against a database that is already dedicated and thrown away with the job, so it
  // may legitimately point both variables at the same URL. Locally that would mean writing
  // fixtures into development data.
  if (testDatabaseUrl === developmentDatabaseUrl && process.env.CI !== "true") {
    throw new Error(
      "TEST_DATABASE_URL must be a dedicated test database, not the same URL as " +
        "DATABASE_URL. Only CI may point both at its own throwaway database. Create a local " +
        "test database with `pnpm db:test:prepare`.",
    );
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  return testDatabaseUrl;
}
