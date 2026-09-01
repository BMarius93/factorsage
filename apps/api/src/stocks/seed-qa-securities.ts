import { PrismaClient } from "@intrinsic/database";

export const PRODUCTION_QA_SECURITIES_MESSAGE =
  "Refusing to seed QA securities: NODE_ENV is production. These are fictional catalog rows for " +
  "deterministic browser testing and must never exist in a production catalog.";

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

/** Unconditional refusal, mirroring the QA persona seeder's production guard. */
export function assertQaSecuritySeedingAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new Error(PRODUCTION_QA_SECURITIES_MESSAGE);
  }
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
