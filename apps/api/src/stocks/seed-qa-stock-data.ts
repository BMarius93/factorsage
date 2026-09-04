import { getStockDataConfig } from "@intrinsic/config";
import type { PrismaClient } from "@intrinsic/database";
import {
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_BLENDS,
  INTRINSIC_VALUE_MODELS,
  type DailyPrice,
  type IntrinsicValueBlendId,
  type IntrinsicValueModel,
} from "@intrinsic/domain";
import {
  addDays,
  aggregateCompletedWeeks,
  buildDailyDerivedState,
  combineBlendComponents,
  fundamentalsDatasetOperations,
  PrismaStockDataStore,
  startOfIsoWeek,
  type EvaluatedIntrinsicModel,
} from "@intrinsic/stock-data";
import { assertQaSecuritySeedingAllowed } from "./seed-qa-securities";
import { subtractYears } from "./stock-details-history";

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

const INTRINSIC_CURRENCY = "USD";

/**
 * Per-model values for the fictional QA security.
 *
 * `DDM` is deliberately not applicable: the fictional company pays no dividend, which is what
 * makes the `DIVIDEND` blend unavailable and gives the browser tests a genuinely unavailable
 * catalog entry to assert against.
 */
const QA_MODEL_VALUES: Partial<Record<IntrinsicValueModel, number>> = {
  DCF_FCFF: 182.5,
  RESIDUAL_INCOME: 151.25,
  GRAHAM: 121.75,
};

/**
 * The intrinsic fixture, blends included, for a given provenance instant.
 *
 * Blend values are produced by `combineBlendComponents` over the canonical
 * `INTRINSIC_VALUE_BLENDS` definitions — the same function the production evaluator uses — rather
 * than by restating the weights as arithmetic literals. A weight change in the product definition
 * therefore reaches this fixture automatically, and a blend whose components are not all present
 * is simply absent, exactly as production materializes it.
 */
export function qaIntrinsicFixture(sourceDataAsOf: string): {
  values: Partial<Record<IntrinsicValueModel, number>>;
  blends: Partial<Record<IntrinsicValueBlendId, number>>;
  currency: string;
} {
  const models = Object.fromEntries(
    INTRINSIC_VALUE_MODELS.map((model) => {
      const valuePerShare = QA_MODEL_VALUES[model];
      return [
        model,
        valuePerShare === undefined
          ? {
              status: "NOT_APPLICABLE",
              phase: "VALUATION",
              reason: "NON_POSITIVE_DIVIDEND",
            }
          : {
              status: "CALCULATED",
              valuePerShare,
              sourceDataAsOf,
              currency: INTRINSIC_CURRENCY,
            },
      ];
    }),
  ) as Record<IntrinsicValueModel, EvaluatedIntrinsicModel>;

  const blends: Partial<Record<IntrinsicValueBlendId, number>> = {};
  for (const blendId of INTRINSIC_VALUE_BLEND_IDS) {
    const blend = combineBlendComponents(INTRINSIC_VALUE_BLENDS[blendId], models);
    if (blend.status === "CALCULATED") {
      blends[blendId] = blend.valuePerShare;
    }
  }

  return { values: { ...QA_MODEL_VALUES }, blends, currency: INTRINSIC_CURRENCY };
}

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
  // The same year arithmetic the loader and the Stock Details bound use (29 February clamps to
  // 28 February), so the seeded coverage starts exactly on the permitted start and the QA stock's
  // boundary is provable as `PROVIDER` on every calendar day, leap days included.
  const horizonStart = subtractYears(today, historyYears);

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
  const sourceDataAsOf = `${valuationStart}T20:00:00.000Z`;
  const intrinsic = qaIntrinsicFixture(sourceDataAsOf);
  const rows = buildDailyDerivedState({ prices, weeklyBars }).map((row) =>
    row.date < valuationStart
      ? row
      : {
          ...row,
          intrinsicValues: { ...intrinsic.values },
          intrinsicValueBlends: { ...intrinsic.blends },
          // Only the models that actually produced a value carry provenance; a value without its
          // own provenance is never point-in-time readable.
          dcfFcffSourceAsOf: sourceDataAsOf,
          residualIncomeSourceAsOf: sourceDataAsOf,
          grahamSourceAsOf: sourceDataAsOf,
          intrinsicCurrency: intrinsic.currency,
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
