import { getStockDataConfig } from "@intrinsic/config";
import type { PrismaClient } from "@intrinsic/database";
import type { DailyPrice } from "@intrinsic/domain";
import {
  addDays,
  aggregateCompletedWeeks,
  buildDailyDerivedState,
  fundamentalsDatasetOperations,
  PrismaStockDataStore,
  startOfIsoWeek,
} from "@intrinsic/stock-data";
import { assertQaSecuritySeedingAllowed } from "./seed-qa-securities";

/**
 * Deterministic market data for the fictional QA securities.
 *
 * Stock Details cannot be exercised end to end without a security that actually has price,
 * technical and intrinsic-value history, and the QA catalog rows are fictional so no provider will
 * ever return data for them. This seed supplies that history locally: a synthetic but fully
 * deterministic price series, the derived state the production calculators produce from it, and
 * the dataset coverage/state watermarks that tell the canonical loader nothing is missing — so a
 * page view resolves entirely out of PostgreSQL and never calls FMP.
 *
 * It is a test fixture, not product behaviour: nothing here recalculates or reinterprets a
 * financial formula. Technicals and weekly carry-forward come from `buildDailyDerivedState`, the
 * same function the loader uses. Only the intrinsic-value numbers are fixture constants, because
 * seeding point-in-time filings for a company that does not exist would be a second, far larger
 * fixture without making the browser assertions any stronger.
 */

/** Trading weeks of history. Long enough for 100W, deliberately short of 200W. */
const HISTORY_WEEKS = 160;

/** First trading day of the deterministic series, relative to the seeded week grid. */
const PRICE_SEED = 100;

/** Intrinsic values become eligible partway through the history, as a real valuation would. */
const VALUATION_START_WEEK = 40;

const INTRINSIC_FIXTURE = {
  values: {
    DCF_FCFF: 182.5,
    RESIDUAL_INCOME: 151.25,
    GRAHAM: 121.75,
  },
  blends: {
    BALANCED: 0.5 * 182.5 + 0.3 * 151.25 + 0.2 * 121.75,
    CONSERVATIVE: 0.4 * 182.5 + 0.3 * 151.25 + 0.3 * 121.75,
  },
  currency: "USD",
} as const;

/** Closing price of the `index`-th trading day. Pure function of the index: reruns are identical. */
function closeAt(index: number): number {
  return PRICE_SEED + (index % 41) * 0.6 + index * 0.05;
}

/** The Monday that starts a history of `HISTORY_WEEKS` complete weeks ending before `today`. */
export function seedHistoryStart(today: string): string {
  return addDays(startOfIsoWeek(today), -7 * HISTORY_WEEKS);
}

/**
 * Monday-Friday trading days from `seedHistoryStart(today)` up to the last completed week.
 *
 * The current, still-running week is deliberately excluded: it is not a completed week, and its
 * absence keeps the seeded weekly carry-forward exactly what the production rules would produce.
 */
export function qaTradingDays(securityId: string, today: string): DailyPrice[] {
  const start = seedHistoryStart(today);
  const rows: DailyPrice[] = [];
  for (let week = 0; week < HISTORY_WEEKS; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const close = closeAt(rows.length);
      rows.push({
        securityId,
        date: addDays(start, week * 7 + day),
        open: close - 0.75,
        high: close + 1.5,
        low: close - 1.5,
        close,
        volume: 1_000_000 + rows.length,
      });
    }
  }
  return rows;
}

/**
 * Seeds one QA security's complete stock-data state.
 *
 * Coverage and dataset-state rows are written with `syncedAt = now`, which is what keeps the
 * canonical loader from deciding the tail is stale and reaching for the provider. That freshness
 * expires, so the seed is a documented precondition of an E2E run rather than a permanent fixture;
 * rerunning it is safe and produces the same data for the same day.
 */
export async function seedQaStockData(
  prisma: PrismaClient,
  securityId: string,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ from: string; to: string; tradingDays: number }> {
  assertQaSecuritySeedingAllowed();

  const { historyYears } = getStockDataConfig();
  const store = new PrismaStockDataStore(prisma);
  const prices = qaTradingDays(securityId, today);
  const first = prices[0];
  const last = prices.at(-1);
  if (!first || !last) {
    throw new Error("QA stock-data seed produced no trading days");
  }

  const syncedAt = new Date().toISOString();
  // The canonical target the loader will ask for: the whole configured horizon up to today. The
  // seeded rows only span the recent part of it, which is normal — coverage is a watermark, not a
  // promise that every calendar day inside it has a market row.
  const horizonStart = (() => {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCFullYear(date.getUTCFullYear() - historyYears);
    return date.toISOString().slice(0, 10);
  })();

  await store.saveDailyPriceSync({
    securityId,
    prices,
    successfulCoverage: [{ from: horizonStart, to: today }],
    syncedAt,
    tailDate: today,
    freshThrough: today,
  });

  const weeklyBars = aggregateCompletedWeeks(prices, today, {
    historyStart: horizonStart,
    historyStartOrigin: "HORIZON",
  });
  const valuationStart = prices[VALUATION_START_WEEK * 5]?.date ?? last.date;
  const rows = buildDailyDerivedState({ prices, weeklyBars }).map((row) =>
    row.date < valuationStart
      ? row
      : {
          ...row,
          intrinsicValues: { ...INTRINSIC_FIXTURE.values },
          intrinsicValueBlends: { ...INTRINSIC_FIXTURE.blends },
          dcfFcffSourceAsOf: `${valuationStart}T20:00:00.000Z`,
          residualIncomeSourceAsOf: `${valuationStart}T20:00:00.000Z`,
          grahamSourceAsOf: `${valuationStart}T20:00:00.000Z`,
          intrinsicCurrency: INTRINSIC_FIXTURE.currency,
        },
  );

  await store.saveDailyDerivedState({
    securityId,
    rows,
    weeklyPrices: weeklyBars,
    successfulCoverage: { from: horizonStart, to: today },
    syncedAt,
  });

  // Fundamentals are not seeded, but their dataset state is: without it the loader would try to
  // backfill statements for a symbol no provider knows.
  for (const operation of fundamentalsDatasetOperations(historyYears)) {
    await store.upsertDatasetState({
      securityId,
      dataset: operation.dataset,
      variant: operation.variant,
      syncedAt,
      earliestDate: horizonStart,
      latestDate: today,
    });
  }

  return { from: first.date, to: last.date, tradingDays: prices.length };
}
