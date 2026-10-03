import type { PrismaClient } from "@intrinsic/database";
import { SecurityType } from "@intrinsic/database";
import {
  fundamentalsDatasetOperations,
  PrismaStockDataStore,
  priceRetentionYears,
  subtractYears,
} from "@intrinsic/stock-data";
import type { GeneratedHistory } from "./generator";

/**
 * Generated histories written into a throwaway PostgreSQL database as ordinary securities, so the
 * real-data audit (`auditRealData`) can hold every production layer — the Strategy frame, the
 * backtest's pinned windows, the Monitor frame and the Stock Details service — to the oracle over
 * the rules the development store never exercises: measured and undated re-bases, unexplained
 * changes, restatements and their chains, forward and history entries, early observations.
 *
 * Each history is stored exactly as the oracle reads it: its statement rows with their
 * availability and observation instants, its closes, its price basis (verified, generation 1 when
 * it carries events) and events, its split list — every dataset recorded as synced at its last
 * session, which is the audit's "today" for the security, so nothing reaches the provider. A
 * history whose price basis was never verified is not stored: its first verification needs the
 * provider (rule 0 is audited on the pure calculation instead).
 *
 * `truncateBefore` stores a second copy whose sessions end the session before a date: the Monitor
 * layer's provisional observation then lands on that date, reading the statements of the session
 * before it — the carry-forward rule exercised on an availability, an event or a restatement day.
 */
export const SYNTHETIC_SYMBOL_PREFIX = "ZZSYN";

export type SyntheticSecurity = {
  securityId: string;
  symbol: string;
  family: string;
  seed: number;
  /** The session the stored history stops before, for a truncated copy. */
  truncatedBefore?: string;
};

function dayBefore(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10);
}

/** Removes every security an earlier run stored (and, by cascade, all of its rows). */
export async function clearSyntheticSecurities(
  prisma: PrismaClient,
): Promise<number> {
  const removed = await prisma.security.deleteMany({
    where: { providerSymbol: { startsWith: SYNTHETIC_SYMBOL_PREFIX } },
  });
  return removed.count;
}

export async function storeSyntheticHistory(input: {
  prisma: PrismaClient;
  store: PrismaStockDataStore;
  history: GeneratedHistory;
  family: string;
  truncateBefore?: string;
}): Promise<SyntheticSecurity | undefined> {
  const { prisma, store, history } = input;
  const { security } = history;
  if (security.verifiedAt === null) {
    return undefined;
  }
  const sessions =
    input.truncateBefore === undefined
      ? history.sessions
      : history.sessions.filter(
          (session) => session.date < (input.truncateBefore as string),
        );
  if (sessions.length < 30) {
    return undefined;
  }
  const lastSession = (sessions.at(-1) as { date: string }).date;
  const symbol = `${SYNTHETIC_SYMBOL_PREFIX}${input.family === "restatement" ? "R" : "A"}${history.seed}${input.truncateBefore ? "T" : ""}`;
  const row = await prisma.security.create({
    data: {
      providerSymbol: symbol,
      symbol,
      name: `Synthetic ${input.family} ${history.seed}`,
      exchangeCode: "NASDAQ",
      currency: security.currency,
      type: SecurityType.STOCK,
      isAdr: false,
      isActivelyTrading: true,
    },
  });
  const syncedAt = `${lastSession}T06:00:00.000Z`;
  await store.saveDailyPriceSync({
    securityId: row.id,
    prices: sessions.map(({ date, close }) => ({
      securityId: row.id,
      date,
      open: Number(close),
      high: Number(close),
      low: Number(close),
      close: Number(close),
      volume: 1_000_000,
    })),
    successfulCoverage: [
      {
        from: subtractYears(lastSession, priceRetentionYears(30)),
        to: lastSession,
      },
    ],
    syncedAt,
    tailDate: lastSession,
    freshThrough: lastSession,
  });
  await prisma.financialStatement.createMany({
    data: security.statements.map((statement) => ({
      securityId: row.id,
      statementType: statement.statementType,
      fiscalDate: new Date(`${statement.fiscalDate}T00:00:00.000Z`),
      fiscalYear: statement.fiscalYear,
      period: statement.period,
      reportedCurrency: statement.reportedCurrency,
      // Filed the day before it became available, as a stored row with a real filing date is.
      filingDate: new Date(
        `${dayBefore(statement.availableFromDate)}T00:00:00.000Z`,
      ),
      availableFromDate: new Date(
        `${statement.availableFromDate}T00:00:00.000Z`,
      ),
      observedAt: new Date(statement.observedAt),
      contentHash: statement.contentHash,
      values: statement.values as object,
    })),
  });
  await store.createPriceBasis({
    securityId: row.id,
    verifiedAt: security.verifiedAt,
  });
  if (security.events.length > 0) {
    await prisma.securityPriceBasis.update({
      where: { securityId: row.id },
      data: { generation: 1 },
    });
    for (const event of security.events) {
      await prisma.priceBasisEvent.create({
        data: {
          securityId: row.id,
          generation: 1,
          kind: event.kind,
          effectiveDate: event.effectiveDate
            ? new Date(`${event.effectiveDate}T00:00:00.000Z`)
            : null,
          effectiveFrom: event.effectiveFrom
            ? new Date(`${event.effectiveFrom}T00:00:00.000Z`)
            : null,
          effectiveTo: event.effectiveTo
            ? new Date(`${event.effectiveTo}T00:00:00.000Z`)
            : null,
          priceRatio: event.priceRatio ?? null,
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
  }
  await store.replaceStockSplits({
    securityId: row.id,
    splits: security.splits.map((split) => ({
      securityId: row.id,
      date: split.date,
      numerator: Number(split.numerator),
      denominator: Number(split.denominator),
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
  return {
    securityId: row.id,
    symbol,
    family: input.family,
    seed: history.seed,
    ...(input.truncateBefore ? { truncatedBefore: input.truncateBefore } : {}),
  };
}

/**
 * A date worth a provisional observation: the first session on or after an availability, an event
 * or an entry the history holds, chosen by the seed, at least 30 sessions in.
 */
export function boundarySession(history: GeneratedHistory): string | undefined {
  const dates = history.sessions.map((session) => session.date);
  const candidates = new Set<string>();
  for (const statement of history.security.statements) {
    candidates.add(statement.availableFromDate);
    candidates.add(statement.observedAt.slice(0, 10));
  }
  for (const event of history.security.events) {
    for (const date of [
      event.effectiveDate,
      event.effectiveFrom,
      event.effectiveTo,
      event.detectedAt.slice(0, 10),
    ]) {
      if (date) {
        candidates.add(date);
      }
    }
  }
  for (const split of history.security.splits) {
    candidates.add(split.date);
  }
  const sessions = [...candidates]
    .map((date) => dates.find((session) => session >= date))
    .filter(
      (session): session is string =>
        session !== undefined && dates.indexOf(session) >= 30,
    )
    .sort();
  if (sessions.length === 0) {
    return undefined;
  }
  return sessions[history.seed % sessions.length];
}
