import {
  FUNDAMENTAL_METRIC_IDS,
  findSelectableSeries,
  STOCK_SUMMARY_TECHNICAL_IDS,
  VALUATION_RATIO_IDS,
  type FundamentalMetricId,
  type StockSummaryTechnicalId,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import {
  fundamentalMetricDefinition,
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  type DailyDerivedState,
  type DailyPrice,
  type DateRange,
  type FinancialStatement,
  type IntrinsicValueBlendPoint,
  type IntrinsicValuePoint,
  type LocalDate,
  type Security,
  type SecurityProfile,
} from "@intrinsic/domain";

/**
 * The Stock Details summary: the latest state of one security, selected from one trailing window of
 * canonical rows (`GET /stocks/:symbol/summary`).
 *
 * Everything here is **selection**, never calculation. The rows arrive as the canonical reads give
 * them — the stored prices, the persisted derived state, the intrinsic-value points already filtered
 * by their own provenance, and the valuation-ratio columns the one ratio calculation produced — and
 * this module picks the newest session each series has a value on. A series with no value anywhere in
 * the window has no reading: it is never zero and never borrowed from outside the window.
 */

/** One series' newest reading in the window: the session it was found on, and its value. */
export type StockSummaryReading<TId extends string> = {
  id: TId;
  date?: LocalDate;
  value?: number;
};

/** The newest stored bar of the window, the one before it, and the window's high and low. */
export type StockSummaryQuote = {
  date: LocalDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  previous?: { date: LocalDate; close: number };
  rangeHigh: number;
  rangeLow: number;
};

/** The newest quarterly statement period public by the newest session. */
export type StockSummaryQuarter = {
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
  fiscalDate: LocalDate;
  /** The first session any of the period's statements could be read on. */
  availableFromDate: LocalDate;
};

export type StockSummaryValuationRatios =
  | {
      status: "AVAILABLE";
      readings: StockSummaryReading<ValuationRatioId>[];
    }
  /**
   * The calculation's inputs could not be prepared — the provider's split list could not be
   * refreshed — so nothing was computed. `cause` is the original error, for the caller's log.
   */
  | { status: "FAILED"; cause: unknown };

export type StockSummary = {
  security: Security;
  profile?: SecurityProfile;
  window: Required<DateRange>;
  quote?: StockSummaryQuote;
  intrinsicValues: IntrinsicValuePoint[];
  intrinsicValueBlends: IntrinsicValueBlendPoint[];
  valuationRatios: StockSummaryValuationRatios;
  fundamentals: StockSummaryReading<FundamentalMetricId>[];
  technicals: StockSummaryReading<StockSummaryTechnicalId>[];
  latestQuarter?: StockSummaryQuarter;
};

const QUARTERS = new Set(["Q1", "Q2", "Q3", "Q4"]);

/**
 * The technical field each summary series is read from, resolved once through the canonical
 * selectable-series catalog — the same entry the chart's `Indicators` control and the technical
 * endpoint's `series=` filter resolve — so the summary keeps no field map of its own.
 */
const TECHNICAL_FIELDS = STOCK_SUMMARY_TECHNICAL_IDS.map((id) => {
  const entry = findSelectableSeries(id);
  if (
    !entry ||
    (entry.source.kind !== "MOVING_AVERAGE" &&
      entry.source.kind !== "OSCILLATOR")
  ) {
    throw new Error(`${id} is not a technical series of the catalog`);
  }
  return { id, field: entry.source.field as keyof DailyDerivedState };
});

/**
 * The newest index at or before which `valueAt` is a finite number, searching from the end.
 * `undefined` when there is none.
 */
function newestIndex(
  length: number,
  valueAt: (index: number) => unknown,
): number | undefined {
  for (let index = length - 1; index >= 0; index -= 1) {
    const value = valueAt(index);
    if (typeof value === "number" && Number.isFinite(value)) {
      return index;
    }
  }
  return undefined;
}

function derivedReading<TId extends string>(
  id: TId,
  rows: readonly DailyDerivedState[],
  field: keyof DailyDerivedState,
): StockSummaryReading<TId> {
  const index = newestIndex(rows.length, (i) => rows[i]?.[field]);
  if (index === undefined) {
    return { id };
  }
  const row = rows[index] as DailyDerivedState;
  return { id, date: row.date, value: row[field] as number };
}

function newestBy<
  TKey extends string,
  TPoint extends { valuationDate: string },
>(
  points: readonly TPoint[],
  keys: readonly TKey[],
  keyOf: (point: TPoint) => TKey,
): TPoint[] {
  const newest = new Map<TKey, TPoint>();
  for (const point of points) {
    const key = keyOf(point);
    const held = newest.get(key);
    if (!held || point.valuationDate >= held.valuationDate) {
      newest.set(key, point);
    }
  }
  return keys.flatMap((key) => {
    const point = newest.get(key);
    return point ? [point] : [];
  });
}

function summarizeQuote(
  prices: readonly DailyPrice[],
): StockSummaryQuote | undefined {
  const latest = prices.at(-1);
  if (!latest) {
    return undefined;
  }
  const previous = prices.at(-2);
  let rangeHigh = latest.high;
  let rangeLow = latest.low;
  for (const row of prices) {
    rangeHigh = Math.max(rangeHigh, row.high);
    rangeLow = Math.min(rangeLow, row.low);
  }
  return {
    date: latest.date,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
    volume: latest.volume,
    ...(previous
      ? { previous: { date: previous.date, close: previous.close } }
      : {}),
    rangeHigh,
    rangeLow,
  };
}

/**
 * The newest quarterly period whose statements were public by `asOf`, with the first session any of
 * them could be read on. The statements are the ones every statement-derived calculation reads — the
 * stored revisions after the listing-evidence rule — so the period named is one those calculations
 * can actually be reading; a revision public only after `asOf` is never considered.
 */
export function latestPublicQuarter(
  statements: readonly Pick<
    FinancialStatement,
    "fiscalYear" | "period" | "fiscalDate" | "availableFromDate"
  >[],
  asOf: LocalDate,
): StockSummaryQuarter | undefined {
  let latest: StockSummaryQuarter | undefined;
  for (const statement of statements) {
    if (!QUARTERS.has(statement.period) || statement.availableFromDate > asOf) {
      continue;
    }
    if (!latest || statement.fiscalDate > latest.fiscalDate) {
      latest = {
        fiscalYear: statement.fiscalYear,
        period: statement.period as StockSummaryQuarter["period"],
        fiscalDate: statement.fiscalDate,
        availableFromDate: statement.availableFromDate,
      };
    } else if (
      statement.fiscalDate === latest.fiscalDate &&
      statement.availableFromDate < latest.availableFromDate
    ) {
      latest = { ...latest, availableFromDate: statement.availableFromDate };
    }
  }
  return latest;
}

/**
 * Selects the summary from one window of canonical rows.
 *
 * `prices` and `derived` are the window's stored bars and derived rows, oldest first. `ratioColumns`
 * is the one valuation-ratio calculation's output aligned to `prices`, or `undefined` when its inputs
 * could not be prepared. `intrinsicValues` and `intrinsicValueBlends` are the window's points as the
 * canonical intrinsic reads project them — each model and blend already filtered by its own
 * provenance — and the newest of each is kept with its own valuation date.
 */
export function summarizeStockWindow(input: {
  readonly prices: readonly DailyPrice[];
  readonly derived: readonly DailyDerivedState[];
  readonly intrinsicValues: readonly IntrinsicValuePoint[];
  readonly intrinsicValueBlends: readonly IntrinsicValueBlendPoint[];
  readonly ratioColumns:
    | ReadonlyMap<ValuationRatioId, ArrayLike<number>>
    | { readonly failure: unknown };
  readonly statements: readonly Pick<
    FinancialStatement,
    "fiscalYear" | "period" | "fiscalDate" | "availableFromDate"
  >[];
}): Omit<StockSummary, "security" | "profile" | "window"> {
  const { prices, derived } = input;
  const quote = summarizeQuote(prices);
  const columns = input.ratioColumns;
  const valuationRatios: StockSummaryValuationRatios =
    "failure" in columns
      ? { status: "FAILED", cause: columns.failure }
      : {
          status: "AVAILABLE",
          readings: VALUATION_RATIO_IDS.map((id) => {
            const column = columns.get(id);
            const index =
              column === undefined
                ? undefined
                : newestIndex(prices.length, (i) => column[i]);
            if (index === undefined) {
              return { id };
            }
            return {
              id,
              date: (prices[index] as DailyPrice).date,
              value: (column as ArrayLike<number>)[index] as number,
            };
          }),
        };
  const latestQuarter = quote
    ? latestPublicQuarter(input.statements, quote.date)
    : undefined;
  return {
    ...(quote ? { quote } : {}),
    intrinsicValues: newestBy(
      input.intrinsicValues,
      INTRINSIC_VALUE_MODELS,
      (point) => point.model,
    ),
    intrinsicValueBlends: newestBy(
      input.intrinsicValueBlends,
      INTRINSIC_VALUE_BLEND_IDS,
      (point) => point.blendId,
    ),
    valuationRatios,
    fundamentals: FUNDAMENTAL_METRIC_IDS.map((id) =>
      derivedReading(id, derived, fundamentalMetricDefinition(id).field),
    ),
    technicals: TECHNICAL_FIELDS.map(({ id, field }) =>
      derivedReading(id, derived, field),
    ),
    ...(latestQuarter ? { latestQuarter } : {}),
  };
}
