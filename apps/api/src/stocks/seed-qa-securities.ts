import { PrismaClient } from "@intrinsic/database";

export const PRODUCTION_QA_SECURITIES_MESSAGE =
  "Refusing to seed QA securities: NODE_ENV is production. These are fictional catalog rows for " +
  "deterministic browser testing and must never exist in a production catalog.";

export const DEV_DATABASE_QA_SEED_MESSAGE =
  "Refusing to seed QA data into the development database. Deterministic fixtures — including " +
  "synthetic S&P 500 bars — belong in the dedicated test database, or a normal backtest would " +
  "silently compare against invented history. Run `pnpm test:securities:seed`, which targets " +
  "TEST_DATABASE_URL, and point the Playwright stack at it with `pnpm dev:api:e2e` / " +
  "`pnpm dev:worker:e2e`.";

export const MISSING_TEST_DATABASE_QA_SEED_MESSAGE =
  "Refusing to seed QA data: TEST_DATABASE_URL is not set. It must point at a dedicated test " +
  "database, for example postgresql://…/intrinsic_value_test.";

/**
 * Deterministic fictional catalog rows for browser/E2E testing.
 *
 * The symbols are seven characters, longer than any real US listing, so the catalog
 * synchronization — which only ever touches rows whose provider symbol appears in the provider
 * universe — can never collide with or reclaim them. That length is the guard; the provider symbol
 * deliberately equals the product symbol, exactly as every real catalog row has it, because
 * `/stocks/{symbol}` resolves a security by its provider identity. A decorated provider symbol
 * would make these the only rows in the catalog that the product's own navigation cannot open.
 *
 * They contain catalog identity only. `seedQaStockData` separately gives the first of them the
 * deterministic market data the Stock Details E2E suite needs.
 */
export const QA_SECURITIES = [
  {
    providerSymbol: "QATEST1",
    symbol: "QATEST1",
    name: "QA Test Alpha Corporation",
    exchangeCode: "NASDAQ",
    exchangeName: "NASDAQ Global Select",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  },
  {
    providerSymbol: "QATEST2",
    symbol: "QATEST2",
    name: "QA Test Beta Corporation",
    exchangeCode: "NASDAQ",
    exchangeName: "NASDAQ Global Select",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  },
] as const;

/**
 * Where deterministic QA fixtures may be written, and where they may not.
 *
 * Never production, and never the development database. The second rule is the one that matters
 * day to day: `seedQaBenchmarkData` writes synthetic bars into the **real** `SP500` series, so a
 * seed that landed in `DATABASE_URL` would leave a normal manual backtest comparing against
 * invented history — real for the years FMP supplied, fabricated for the seeded window, with
 * nothing on screen to say which. The fixtures therefore only ever reach `TEST_DATABASE_URL`, and
 * the deterministic Playwright stack points at that database.
 *
 * CI may legitimately run with both variables at the same URL — there is no second database to
 * protect there — which is exactly the carve-out `useTestDatabase` makes for the same reason.
 *
 * A DB-backed suite is the other legitimate equality: `useTestDatabase` points the process at the
 * test database by overwriting `DATABASE_URL`, having already made this exact check against the
 * real one first. It records that with `INTRINSIC_TEST_DATABASE_ACTIVE`, named literally here so
 * this guard keeps no runtime dependency on a test-only package.
 *
 * The QA validation matrix is the third proven-safe target, recorded the same way with
 * `INTRINSIC_QA_MATRIX_DATABASE_ACTIVE`. Its own resolver has already refused production, refused
 * the development and test databases by name, and required a database whose name says what it is —
 * a stricter set of checks than this one, made before any client existed. It is accepted before
 * `TEST_DATABASE_URL` is required rather than after, because a matrix environment legitimately has
 * nothing to do with the test database and must not be blocked by its absence.
 */
export function assertQaSecuritySeedingAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new Error(PRODUCTION_QA_SECURITIES_MESSAGE);
  }

  if (env.INTRINSIC_QA_MATRIX_DATABASE_ACTIVE === "true") {
    return;
  }

  const testDatabaseUrl = env.TEST_DATABASE_URL?.trim();
  if (!testDatabaseUrl) {
    throw new Error(MISSING_TEST_DATABASE_QA_SEED_MESSAGE);
  }
  if (env.CI === "true" || env.INTRINSIC_TEST_DATABASE_ACTIVE === "true") {
    return;
  }
  // A `.env` whose test URL is the development database would defeat the explicit connection
  // below, so the two must differ locally.
  if (env.DATABASE_URL?.trim() === testDatabaseUrl) {
    throw new Error(DEV_DATABASE_QA_SEED_MESSAGE);
  }
}

/**
 * The database deterministic fixtures are written to, chosen explicitly rather than inherited.
 *
 * Resolving it here — instead of relying on whatever `DATABASE_URL` happens to be — means the
 * seed cannot reach the development database even if it is invoked from a shell that points there.
 * `.env` stays the single source: it is loaded before this is read.
 */
export function qaSeedDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const testDatabaseUrl = env.TEST_DATABASE_URL?.trim();
  if (!testDatabaseUrl) {
    throw new Error(MISSING_TEST_DATABASE_QA_SEED_MESSAGE);
  }
  return testDatabaseUrl;
}

/**
 * Creates or updates exactly the fictional QA catalog rows and nothing else.
 *
 * Rerunning is safe. The row is located by its product symbol rather than upserted by provider
 * symbol, so a row left by an earlier seed that used a decorated provider symbol is reconciled in
 * place instead of colliding with `@@unique([symbol, exchangeCode])`. Nothing is ever deleted:
 * these rows can already be referenced by user-owned stock lists.
 */
export async function seedQaSecurities(
  prisma: PrismaClient,
): Promise<{ symbol: string; id: string }[]> {
  // Guarded here as well as at the entry point, so no caller can reach the writes without it.
  assertQaSecuritySeedingAllowed();

  const seeded: { symbol: string; id: string }[] = [];
  for (const security of QA_SECURITIES) {
    const { providerSymbol, ...fields } = security;
    const existing = await prisma.security.findFirst({
      where: { symbol: fields.symbol, exchangeCode: fields.exchangeCode },
      select: { id: true },
    });
    const row = existing
      ? await prisma.security.update({
          where: { id: existing.id },
          data: { providerSymbol, ...fields },
          select: { id: true, symbol: true },
        })
      : await prisma.security.create({
          data: { providerSymbol, ...fields },
          select: { id: true, symbol: true },
        });
    seeded.push(row);
  }
  return seeded;
}
