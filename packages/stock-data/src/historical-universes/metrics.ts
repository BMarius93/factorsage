import type {
  LocalDate,
  StockSplit,
  UniverseRankingMetric,
} from "@intrinsic/domain";
import { indicatedAnnualDividend, type DividendRow } from "../dividends.js";

/**
 * The ranking metrics of `UNIVERSE_RANKING_METRICS`, for one security on one reconstitution date
 * (`docs/decisions/historical-universes-v1.md` §5). Pure.
 *
 * Every value reads only what was known by the close of the date `T`:
 *
 * - **Prices** are the stored closes on or before `T`. A metric that needs a close on `T` itself is
 *   unavailable for a security that did not trade on `T`.
 * - **Lags** are counted in the parent's trading sessions, not calendar days, and a lagged close is
 *   the security's latest close on or before the lagged session, at most five sessions earlier.
 * - **Fundamentals** are the point-in-time columns the derived state holds for `T`, which read only
 *   statements available on `T` (`fundamental-metrics-v1.md`).
 * - **Market capitalization and valuation ratios** come from the valuation timeline, which applies
 *   the share-count and price-basis rules of `valuation-ratios-v1.md`.
 * - **Dividends** count once their ex-date is on or before `T` (`dividends.ts`).
 *
 * Unavailable is `null`, never zero, and the reason is reported.
 */

export type MetricUnavailability =
  | "NO_PRICE_ON_DATE"
  | "INSUFFICIENT_HISTORY"
  | "NO_MARKET_CAP"
  | "NO_RATIO"
  | "NO_FUNDAMENTAL"
  | "DIVIDENDS_NOT_INGESTED"
  | "NO_REGULAR_DIVIDEND";

export type MetricValue =
  | { readonly value: number }
  | { readonly value: null; readonly reason: MetricUnavailability };

/** The point-in-time Fundamental Metrics columns the ranking metrics read from the derived state. */
export const FUNDAMENTAL_RANKING_COLUMNS = {
  REVENUE_GROWTH_TTM_YOY: "revenueGrowthTtmYoy",
  EPS_GROWTH_TTM_YOY: "epsGrowthTtmYoy",
  FCF_GROWTH_TTM_YOY: "fcfGrowthTtmYoy",
  ROIC_TTM: "roicTtm",
  ROE_TTM: "roeTtm",
  GROSS_MARGIN_TTM: "grossMarginTtm",
  INTEREST_COVERAGE_TTM: "interestCoverageTtm",
  NET_DEBT_TO_EBITDA_TTM: "netDebtToEbitdaTtm",
} as const satisfies Partial<Record<UniverseRankingMetric, string>>;

export type FundamentalRankingColumn =
  (typeof FUNDAMENTAL_RANKING_COLUMNS)[keyof typeof FUNDAMENTAL_RANKING_COLUMNS];

/** One security's history, as the generator loaded it from PostgreSQL. */
export type SecuritySeries = {
  readonly securityId: string;
  /** The security's own bars, ascending. */
  readonly dates: readonly LocalDate[];
  readonly closes: Float64Array;
  readonly volumes: Float64Array;
  /** Per bar; `NaN` where the valuation rules withhold it. Absent when not loaded. */
  readonly marketCaps?: Float64Array;
  /** Per bar, the valuation ratios a yield inverts; `NaN` where unavailable. */
  readonly ratios?: {
    readonly priceToEarnings?: Float64Array;
    readonly priceToBook?: Float64Array;
    readonly priceToSales?: Float64Array;
    readonly priceToFcf?: Float64Array;
  };
  /** The derived state's fundamental columns on the dates the generator asked for. */
  readonly fundamentals?: ReadonlyMap<
    LocalDate,
    Readonly<Partial<Record<FundamentalRankingColumn, number | null>>>
  >;
  /** `null` when the security's dividends were never synchronized; `[]` when it paid none. */
  readonly dividends?: readonly DividendRow[] | null;
  readonly splits?: readonly StockSplit[];
};

/** The parent's trading sessions, ascending, with each session's index. */
export type SessionCalendar = {
  readonly sessions: readonly LocalDate[];
  readonly indexOf: ReadonlyMap<LocalDate, number>;
};

export function sessionCalendar(
  sessions: readonly LocalDate[],
): SessionCalendar {
  const sorted = [...new Set(sessions)].sort();
  return {
    sessions: sorted,
    indexOf: new Map(sorted.map((session, index) => [session, index])),
  };
}

const LAG_TOLERANCE_SESSIONS = 5;

/** The index of the security's latest bar on or before `date`, or -1. */
function barOnOrBefore(series: SecuritySeries, date: LocalDate): number {
  let low = 0;
  let high = series.dates.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((series.dates[middle] as LocalDate) <= date) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** The bar exactly on `date`, or -1. */
function barOn(series: SecuritySeries, date: LocalDate): number {
  const index = barOnOrBefore(series, date);
  return index >= 0 && series.dates[index] === date ? index : -1;
}

/**
 * The close `lag` sessions before session `at`: the security's latest close on or before that
 * session, no more than five sessions earlier. `null` when the calendar does not reach back that far
 * or the security has no close near it.
 */
function lagged(
  series: SecuritySeries,
  calendar: SessionCalendar,
  at: number,
  lag: number,
): number | null {
  const target = at - lag;
  if (target < 0) {
    return null;
  }
  const bar = barOnOrBefore(series, calendar.sessions[target] as LocalDate);
  if (bar < 0) {
    return null;
  }
  const barSession = calendar.indexOf.get(series.dates[bar] as LocalDate);
  if (
    barSession === undefined ||
    target - barSession > LAG_TOLERANCE_SESSIONS
  ) {
    return null;
  }
  const close = series.closes[bar] as number;
  return Number.isFinite(close) && close > 0 ? close : null;
}

/** Daily log returns of the security's bars inside sessions `(from, to]`. */
function logReturns(
  series: SecuritySeries,
  calendar: SessionCalendar,
  fromSession: number,
  toSession: number,
): number[] {
  if (fromSession < 0) {
    return [];
  }
  const start = barOnOrBefore(
    series,
    calendar.sessions[fromSession] as LocalDate,
  );
  const end = barOnOrBefore(series, calendar.sessions[toSession] as LocalDate);
  const returns: number[] = [];
  for (let index = Math.max(start, 0) + 1; index <= end; index += 1) {
    const previous = series.closes[index - 1] as number;
    const current = series.closes[index] as number;
    if (previous > 0 && current > 0) {
      returns.push(Math.log(current / previous));
    }
  }
  return start < 0 ? [] : returns;
}

function annualizedVolatility(returns: readonly number[]): number {
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

const unavailable = (reason: MetricUnavailability): MetricValue => ({
  value: null,
  reason,
});

const available = (value: number): MetricValue =>
  Number.isFinite(value) ? { value } : unavailable("INSUFFICIENT_HISTORY");

function inverse(column: Float64Array | undefined, bar: number): MetricValue {
  const ratio = column?.[bar];
  return ratio !== undefined && Number.isFinite(ratio) && ratio > 0
    ? { value: 1 / ratio }
    : unavailable("NO_RATIO");
}

function fundamental(
  series: SecuritySeries,
  date: LocalDate,
  column: FundamentalRankingColumn,
): MetricValue {
  const value = series.fundamentals?.get(date)?.[column];
  return value === null || value === undefined || !Number.isFinite(value)
    ? unavailable("NO_FUNDAMENTAL")
    : { value };
}

/**
 * The as-traded close on bar `bar`: the stored (split-adjusted) close with every split after it
 * undone. A 4-for-1 split after `date` divided the stored close before it by four.
 */
export function nominalClose(series: SecuritySeries, bar: number): number {
  const date = series.dates[bar] as LocalDate;
  let close = series.closes[bar] as number;
  for (const split of series.splits ?? []) {
    if (split.date > date && split.numerator > 0 && split.denominator > 0) {
      close *= split.numerator / split.denominator;
    }
  }
  return close;
}

/** One metric for one security on one reconstitution date. */
export function metricOn(
  metric: Exclude<UniverseRankingMetric, "GROWTH_SCORE" | "VALUE_SCORE">,
  series: SecuritySeries,
  calendar: SessionCalendar,
  date: LocalDate,
): MetricValue {
  const at = calendar.indexOf.get(date);
  const bar = barOn(series, date);
  if (at === undefined || bar < 0) {
    return unavailable("NO_PRICE_ON_DATE");
  }
  const close = series.closes[bar] as number;
  if (!(close > 0)) {
    return unavailable("NO_PRICE_ON_DATE");
  }
  switch (metric) {
    case "MARKET_CAP": {
      const value = series.marketCaps?.[bar];
      return value !== undefined && Number.isFinite(value) && value > 0
        ? { value }
        : unavailable("NO_MARKET_CAP");
    }
    case "MOMENTUM_12_1": {
      const start = lagged(series, calendar, at, 252);
      const end = lagged(series, calendar, at, 21);
      return start === null || end === null
        ? unavailable("INSUFFICIENT_HISTORY")
        : available(end / start - 1);
    }
    case "RETURN_6M": {
      const start = lagged(series, calendar, at, 126);
      return start === null
        ? unavailable("INSUFFICIENT_HISTORY")
        : available(close / start - 1);
    }
    case "RETURN_12M": {
      const start = lagged(series, calendar, at, 252);
      return start === null
        ? unavailable("INSUFFICIENT_HISTORY")
        : available(close / start - 1);
    }
    case "RISK_ADJUSTED_MOMENTUM_12_1": {
      const start = lagged(series, calendar, at, 252);
      const end = lagged(series, calendar, at, 21);
      const returns = logReturns(series, calendar, at - 252, at - 21);
      if (start === null || end === null || returns.length < 220) {
        return unavailable("INSUFFICIENT_HISTORY");
      }
      const volatility = annualizedVolatility(returns);
      return volatility > 0
        ? available((end / start - 1) / volatility)
        : unavailable("INSUFFICIENT_HISTORY");
    }
    case "VOLATILITY_252D": {
      const returns = logReturns(series, calendar, at - 252, at);
      return returns.length < 240
        ? unavailable("INSUFFICIENT_HISTORY")
        : available(annualizedVolatility(returns));
    }
    case "DOLLAR_VOLUME_63D": {
      if (at - 63 < 0) {
        return unavailable("INSUFFICIENT_HISTORY");
      }
      const from = calendar.sessions[at - 63] as LocalDate;
      let sum = 0;
      let count = 0;
      for (let index = bar; index >= 0; index -= 1) {
        const day = series.dates[index] as LocalDate;
        if (day <= from) {
          break;
        }
        const value =
          (series.closes[index] as number) * (series.volumes[index] as number);
        if (Number.isFinite(value) && value >= 0) {
          sum += value;
          count += 1;
        }
      }
      return count < 50
        ? unavailable("INSUFFICIENT_HISTORY")
        : available(sum / count);
    }
    case "INDICATED_DIVIDEND_YIELD": {
      if (series.dividends === null || series.dividends === undefined) {
        return unavailable("DIVIDENDS_NOT_INGESTED");
      }
      const annual = indicatedAnnualDividend(series.dividends, date);
      return annual === null
        ? unavailable("NO_REGULAR_DIVIDEND")
        : available(annual / close);
    }
    case "EARNINGS_YIELD_TTM":
      return inverse(series.ratios?.priceToEarnings, bar);
    case "FCF_YIELD_TTM":
      return inverse(series.ratios?.priceToFcf, bar);
    case "BOOK_TO_PRICE":
      return inverse(series.ratios?.priceToBook, bar);
    case "SALES_TO_PRICE_TTM":
      return inverse(series.ratios?.priceToSales, bar);
    case "NOMINAL_PRICE":
      return available(nominalClose(series, bar));
    case "REVENUE_GROWTH_TTM_YOY":
    case "EPS_GROWTH_TTM_YOY":
    case "FCF_GROWTH_TTM_YOY":
    case "ROIC_TTM":
    case "ROE_TTM":
    case "GROSS_MARGIN_TTM":
    case "INTEREST_COVERAGE_TTM":
    case "NET_DEBT_TO_EBITDA_TTM":
      return fundamental(series, date, FUNDAMENTAL_RANKING_COLUMNS[metric]);
  }
}

/** The components each composite score averages, and how many a candidate needs. */
export const COMPOSITE_COMPONENTS = {
  GROWTH_SCORE: {
    components: ["REVENUE_GROWTH_TTM_YOY", "EPS_GROWTH_TTM_YOY", "RETURN_12M"],
    minimum: 2,
  },
  VALUE_SCORE: {
    components: ["BOOK_TO_PRICE", "EARNINGS_YIELD_TTM", "SALES_TO_PRICE_TTM"],
    minimum: 2,
  },
} as const satisfies Record<
  "GROWTH_SCORE" | "VALUE_SCORE",
  {
    components: readonly Exclude<
      UniverseRankingMetric,
      "GROWTH_SCORE" | "VALUE_SCORE"
    >[];
    minimum: number;
  }
>;

export type CompositeMetric = keyof typeof COMPOSITE_COMPONENTS;

export function isCompositeMetric(
  metric: UniverseRankingMetric,
): metric is CompositeMetric {
  return metric === "GROWTH_SCORE" || metric === "VALUE_SCORE";
}

/** The base metrics a set of ranking metrics needs computed per security. */
export function baseMetricsFor(
  metrics: Iterable<UniverseRankingMetric>,
): Set<Exclude<UniverseRankingMetric, CompositeMetric>> {
  const base = new Set<Exclude<UniverseRankingMetric, CompositeMetric>>([
    "MARKET_CAP",
  ]);
  for (const metric of metrics) {
    if (isCompositeMetric(metric)) {
      for (const component of COMPOSITE_COMPONENTS[metric].components) {
        base.add(component);
      }
    } else {
      base.add(metric);
    }
  }
  return base;
}
