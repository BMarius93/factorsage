import type { PrismaClient } from "@intrinsic/database";
import { SecurityType } from "@intrinsic/database";
import type { Security } from "@intrinsic/domain";
import {
  fundamentalsDatasetOperations,
  priceRetentionYears,
  subtractYears,
  type PrismaStockDataStore,
} from "@intrinsic/stock-data";
import {
  VALUATION_AUDIT_CURRENCY,
  VALUATION_AUDIT_EVENTS,
  VALUATION_AUDIT_SPLITS,
  VALUATION_AUDIT_VERIFIED_AT,
  valuationAuditSessions,
  valuationAuditStatements,
  type ValuationAuditSession,
} from "@intrinsic/testing";

/**
 * Writes the valuation audit's anchor (`@intrinsic/testing`, `valuation-audit.ts`) into PostgreSQL
 * as one security: its stored statement rows exactly as the API audit's oracle reads them —
 * availability and observation instants included, no loader rule in between — its sessions (up to
 * `lastSession` when given), the verified price basis replaced once by the measured re-base, and the
 * provider's split list, fresh. Every dataset is recorded as synced now, so nothing reaches the
 * provider.
 */
export async function seedValuationAuditSecurity(
  prisma: PrismaClient,
  store: PrismaStockDataStore,
  input: { symbol: string; lastSession?: string },
): Promise<{ security: Security; sessions: ValuationAuditSession[] }> {
  const sessions = valuationAuditSessions().filter(
    (session) =>
      input.lastSession === undefined || session.date <= input.lastSession,
  );
  const row = await prisma.security.create({
    data: {
      providerSymbol: input.symbol,
      symbol: input.symbol,
      name: "Valuation Audit Corp",
      exchangeCode: "NASDAQ",
      currency: VALUATION_AUDIT_CURRENCY,
      type: SecurityType.STOCK,
      isAdr: false,
      isActivelyTrading: true,
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  const syncedAt = new Date().toISOString();
  await store.saveDailyPriceSync({
    securityId: row.id,
    prices: sessions.map(({ date, close, volume }) => ({
      securityId: row.id,
      date,
      open: Number(close),
      high: Number(close),
      low: Number(close),
      close: Number(close),
      volume,
    })),
    successfulCoverage: [
      { from: subtractYears(today, priceRetentionYears(30)), to: today },
    ],
    syncedAt,
    tailDate: today,
    freshThrough: today,
  });
  await prisma.financialStatement.createMany({
    data: valuationAuditStatements().map((statement) => ({
      securityId: row.id,
      statementType: statement.statementType,
      fiscalDate: new Date(`${statement.fiscalDate}T00:00:00.000Z`),
      fiscalYear: statement.fiscalYear,
      period: statement.period,
      reportedCurrency: statement.reportedCurrency,
      filingDate: new Date(`${statement.filingDate}T00:00:00.000Z`),
      availableFromDate: new Date(
        `${statement.availableFromDate}T00:00:00.000Z`,
      ),
      observedAt: new Date(statement.observedAt),
      contentHash: statement.contentHash,
      values: statement.values,
    })),
  });
  // Verified, then replaced once when the loader measured the 2024 re-base.
  await store.createPriceBasis({
    securityId: row.id,
    verifiedAt: VALUATION_AUDIT_VERIFIED_AT,
  });
  await prisma.securityPriceBasis.update({
    where: { securityId: row.id },
    data: { generation: 1 },
  });
  for (const event of VALUATION_AUDIT_EVENTS) {
    await prisma.priceBasisEvent.create({
      data: {
        securityId: row.id,
        generation: 1,
        kind: event.kind,
        effectiveDate: new Date(`${event.effectiveDate}T00:00:00.000Z`),
        priceRatio: event.priceRatio,
        detectedAt: new Date(event.detectedAt),
        evidence: {
          runs: [],
          comparedSessions: 0,
          changedSessions: 0,
          unfittedSessions: 0,
        },
      },
    });
  }
  await store.replaceStockSplits({
    securityId: row.id,
    splits: VALUATION_AUDIT_SPLITS.map((split) => ({
      securityId: row.id,
      date: split.date,
      numerator: split.numerator,
      denominator: split.denominator,
      label: split.label,
    })),
    syncedAt,
  });
  for (const operation of fundamentalsDatasetOperations(30)) {
    await store.upsertDatasetState({
      securityId: row.id,
      dataset: operation.dataset,
      variant: operation.variant,
      syncedAt,
    });
  }
  await store.upsertDatasetState({
    securityId: row.id,
    dataset: "SECURITY_PROFILE",
    variant: "",
    syncedAt,
  });
  const [security] = (await store.findSecuritiesByIds([row.id])) as [Security];
  return { security, sessions };
}
