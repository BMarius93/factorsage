import { PrismaClient } from "@intrinsic/database";

export const PRODUCTION_QA_SECURITIES_MESSAGE =
  "Refusing to seed QA securities: NODE_ENV is production. These are fictional catalog rows for " +
  "deterministic browser testing and must never exist in a production catalog.";

/**
 * Deterministic fictional catalog rows for browser/E2E testing.
 *
 * The symbols are seven characters, longer than any real US listing, and the provider symbols
 * carry a `-QA` suffix no provider uses, so the catalog synchronization — which only ever touches
 * rows whose provider symbol appears in the provider universe — can never collide with or reclaim
 * them. They contain catalog identity only; nothing ever hydrates prices or fundamentals for them
 * unless someone explicitly opens them.
 */
export const QA_SECURITIES = [
  {
    providerSymbol: "QATEST1-QA",
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
    providerSymbol: "QATEST2-QA",
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

/** Unconditional refusal, mirroring the QA persona seeder's production guard. */
export function assertQaSecuritySeedingAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new Error(PRODUCTION_QA_SECURITIES_MESSAGE);
  }
}

/**
 * Creates or updates exactly the fictional QA catalog rows and nothing else. Rerunning is safe:
 * each row is upserted by its provider symbol and re-asserted to the canonical fixture values.
 */
export async function seedQaSecurities(
  prisma: PrismaClient,
): Promise<{ symbol: string; id: string }[]> {
  // Guarded here as well as at the entry point, so no caller can reach the writes without it.
  assertQaSecuritySeedingAllowed();

  const seeded: { symbol: string; id: string }[] = [];
  for (const security of QA_SECURITIES) {
    const { providerSymbol, ...fields } = security;
    const row = await prisma.security.upsert({
      where: { providerSymbol },
      update: { ...fields },
      create: { providerSymbol, ...fields },
      select: { id: true, symbol: true },
    });
    seeded.push(row);
  }
  return seeded;
}
