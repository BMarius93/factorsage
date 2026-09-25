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
  priceRetentionYears,
  startOfIsoWeek,
  subtractYears,
  type EvaluatedIntrinsicModel,
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

/**
 * A stretch where every intrinsic model is genuinely **not calculable**, and then is again.
 *
 * Real securities do this: `AMZN`'s DCF disappears for the quarters its free cash flow is
 * negative, and `AAPL`'s DDM is absent across the 1996-2012 dividend suspension. It is a
 * different fact from "the value has not changed", and it must render as a break in the line
 * rather than a straight segment joining the values on either side — the chart is not allowed to
 * invent intrinsic values for the days in between. Seeding one here is what gives the browser
 * suites a genuinely unavailable *interior* interval to assert that against; the pre-eligibility
 * stretch before `VALUATION_START_WEEK` only ever exercised a leading absence.
 */
const UNAVAILABLE_FROM_WEEK = 80;
const UNAVAILABLE_UNTIL_WEEK = 100;

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
 * When the fictional security's intrinsic models are readable, as dates.
 *
 * Exported so the seed's availability shape is provable without a database: the browser suites
 * assert against exactly these boundaries.
 */
export function qaIntrinsicWindows(prices: readonly { date: string }[]): {
  valuationStart: string;
  unavailableFrom: string;
  unavailableUntil: string;
  /** Absent because it is not calculable yet, or because it is not calculable any more. */
  notCalculable: (date: string) => boolean;
} {
  const fallback = prices.at(-1)?.date ?? "";
  const valuationStart = prices[VALUATION_START_WEEK * 5]?.date ?? fallback;
  const unavailableFrom = prices[UNAVAILABLE_FROM_WEEK * 5]?.date ?? fallback;
  const unavailableUntil = prices[UNAVAILABLE_UNTIL_WEEK * 5]?.date ?? fallback;
  return {
    valuationStart,
    unavailableFrom,
    unavailableUntil,
    notCalculable: (date: string) =>
      date < valuationStart ||
      (date >= unavailableFrom && date < unavailableUntil),
  };
}

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
    const blend = combineBlendComponents(
      INTRINSIC_VALUE_BLENDS[blendId],
      models,
    );
    if (blend.status === "CALCULATED") {
      blends[blendId] = blend.valuePerShare;
    }
  }

  return {
    values: { ...QA_MODEL_VALUES },
    blends,
    currency: INTRINSIC_CURRENCY,
  };
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
 * Session volume of the `index`-th seeded trading day.
 *
 * Deliberately not a flat or monotone series. A fixture whose volume barely moves makes every
 * Relative Volume reading land on 1.00x, which renders as a flat histogram and proves nothing
 * about the chart, the legend or a Strategy threshold. This has a steady base, a weekly rhythm and
 * a periodic spike, so the seeded history contains readings comfortably above and below 1x while
 * staying fully deterministic.
 */
function qaVolumeAt(index: number): number {
  const weekly = (index % 5) * 120_000;
  const spike = index % 37 === 0 ? 4_500_000 : 0;
  return 1_000_000 + weekly + spike;
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
        volume: qaVolumeAt(rows.length),
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
 * expires — after thirty days on the E2E stack, which overrides the six-hour product window — so the
 * seed is a documented precondition of an E2E run rather than a permanent fixture; rerunning it is
 * safe and produces the same data for the same day.
 */
export async function seedQaStockData(
  prisma: PrismaClient,
  securityId: string,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ from: string; to: string; tradingDays: number }> {
  assertQaSecuritySeedingAllowed();

  const { productHistoryYears } = getStockDataConfig();
  const store = new PrismaStockDataStore(prisma);
  const prices = qaTradingDays(securityId, today);
  const first = prices[0];
  const last = prices.at(-1);
  if (!first || !last) {
    throw new Error("QA stock-data seed produced no trading days");
  }

  const syncedAt = new Date().toISOString();
  // What this fixture claims to have covered — see `saveDailyPriceSync` below.
  //
  // The **retention** horizon, not the product horizon: a Stock Details window opened at the
  // thirty-year bound makes the loader widen its load target to the raw-price retention start, and
  // a fixture that only claimed the product horizon would leave that prefix uncovered and send the
  // loader to a provider that has never heard of `QATEST1`. The same year arithmetic the loader
  // and the Stock Details bound use, so 29 February clamps to 28 February.
  const retentionStart = subtractYears(
    today,
    priceRetentionYears(productHistoryYears),
  );

  await store.saveDailyPriceSync({
    securityId,
    prices,
    // The whole horizon, and that claim is **true here**: `QATEST1` is a fictional security whose
    // only provider is this fixture, so the fixture is the authority on what exists before its
    // first row — nothing. Recording the horizon is what lets Stock Details report a `PROVIDER`
    // boundary, which is the property its navigation suites assert.
    //
    // The benchmark seed deliberately does *not* do this. `SP500` is backed by a real symbol with
    // real history further back, so claiming the horizon there would be a lie that permanently
    // blocked fetching it. The difference is not "seed versus provider"; it is whether the claim
    // happens to be true.
    successfulCoverage: [{ from: retentionStart, to: today }],
    syncedAt,
    tailDate: today,
    freshThrough: today,
  });

  const weeklyBars = aggregateCompletedWeeks(prices, today, {
    historyStart: retentionStart,
    historyStartOrigin: "HORIZON",
  });
  const { valuationStart, notCalculable } = qaIntrinsicWindows(prices);
  const sourceDataAsOf = `${valuationStart}T20:00:00.000Z`;
  const intrinsic = qaIntrinsicFixture(sourceDataAsOf);
  const rows = buildDailyDerivedState({ prices, weeklyBars }).map((row) =>
    notCalculable(row.date)
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
    // Derived state is computed from the prices above and over the same interval, so it makes the
    // same claim for the same reason.
    successfulCoverage: { from: retentionStart, to: today },
    syncedAt,
  });

  await recordFixtureDatasetStates(store, securityId, {
    productHistoryYears,
    retentionStart,
    today,
    syncedAt,
  });

  return { from: first.date, to: last.date, tradingDays: prices.length };
}

/**
 * The dataset state a fictional security needs so the loader never asks a provider about the
 * datasets the fixture does not seed: every fundamentals operation, and the descriptive profile.
 *
 * Fundamentals are not seeded, but their dataset state is: without it the loader would try to
 * backfill statements for a symbol no provider knows. They stay on the product horizon: their
 * variant encodes it, and their own warm-up is a separate policy that must not compound with the
 * price-retention warm-up.
 *
 * The profile is recorded as synced with nothing saved. The loader records a profile sync only
 * when the provider returned one, so a fictional security without this state is re-asked on every
 * cold hydration — the one provider request a fully seeded fixture used to keep making. The claim
 * is true for the same reason the coverage claims are: the fixture is the only provider these
 * securities have, and it has no profile for them.
 */
export async function recordFixtureDatasetStates(
  store: Pick<PrismaStockDataStore, "upsertDatasetState">,
  securityId: string,
  input: {
    productHistoryYears: number;
    retentionStart: string;
    today: string;
    syncedAt: string;
  },
): Promise<void> {
  for (const operation of fundamentalsDatasetOperations(
    input.productHistoryYears,
  )) {
    await store.upsertDatasetState({
      securityId,
      dataset: operation.dataset,
      variant: operation.variant,
      syncedAt: input.syncedAt,
      earliestDate: input.retentionStart,
      latestDate: input.today,
    });
  }
  await store.upsertDatasetState({
    securityId,
    dataset: "SECURITY_PROFILE",
    variant: "",
    syncedAt: input.syncedAt,
  });
}

/**
 * Declares one fictional security **complete and empty** over the whole retention horizon
 * (E2E-005).
 *
 * The same claims `seedQaStockData` makes for `QATEST1` — price and derived-state coverage from the
 * retention start to today, the tail freshness watermark, the fundamentals and profile state — but
 * over no rows at all. That is what the canonical loader reads as "the provider was asked for all
 * of it and has nothing": a backtest or a Monitor scan over the security settles immediately with
 * no data and no provider request. No loader change is involved; "covered, zero rows" is already a
 * settled state in production, reached whenever a real provider answers an empty window.
 *
 * True for the entitlement universe for the same reason it is true for `QATEST1`: these tickers are
 * fictional and the fixture is their only provider.
 */
export async function seedEmptyStockCoverage(
  prisma: PrismaClient,
  securityId: string,
  today = new Date().toISOString().slice(0, 10),
): Promise<void> {
  assertQaSecuritySeedingAllowed();
  const { productHistoryYears } = getStockDataConfig();
  const store = new PrismaStockDataStore(prisma);
  const retentionStart = subtractYears(
    today,
    priceRetentionYears(productHistoryYears),
  );
  const syncedAt = new Date().toISOString();

  await store.saveDailyPriceSync({
    securityId,
    prices: [],
    successfulCoverage: [{ from: retentionStart, to: today }],
    syncedAt,
    tailDate: today,
    freshThrough: today,
  });
  await store.saveDailyDerivedState({
    securityId,
    rows: [],
    weeklyPrices: [],
    successfulCoverage: { from: retentionStart, to: today },
    syncedAt,
  });
  await recordFixtureDatasetStates(store, securityId, {
    productHistoryYears,
    retentionStart,
    today,
    syncedAt,
  });
}
