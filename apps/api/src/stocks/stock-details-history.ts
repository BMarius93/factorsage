import {
  STOCK_DETAILS_MAX_HISTORY_YEARS,
  type StockHistoryBoundsResponse,
} from "@intrinsic/contracts";
import type { DateRange } from "@intrinsic/domain";

/**
 * The historical bound of the Stock Details surface.
 *
 * `STOCK_DETAILS_MAX_HISTORY_YEARS` is the product limit and lives in `@intrinsic/contracts`, so
 * the number the web app navigates against and the number the API enforces are the same one. This
 * module turns it into a concrete date for a concrete security, and clamps the ranges the HTTP
 * reads are allowed to ask the canonical loader for.
 *
 * The clamp belongs here rather than in the loader: `/stocks/*` is the Stock Details surface, and
 * a backtest names its own period straight through `StockDataService` without passing this way.
 * Widening or narrowing the product limit must not silently change what a backtest can reach.
 */

/** Subtracts whole years from a `YYYY-MM-DD` date, clamping 29 February to 28 February. */
export function subtractYears(date: string, years: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid local date '${date}'`);
  }
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCFullYear(parsed.getUTCFullYear() - years);
  const lastDayOfMonth = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  ).getUTCDate();
  parsed.setUTCDate(Math.min(day, lastDayOfMonth));
  return parsed.toISOString().slice(0, 10);
}

/**
 * The retained years this deployment may serve Stock Details from.
 *
 * The loader's own retention horizon is the ceiling: a deployment configured to keep less than the
 * product limit cannot promise the surface more than it retains, and one configured to keep more
 * still exposes only the 30 years Stock Details is defined to explore.
 */
export function stockDetailsHistoryYears(retentionYears: number): number {
  return Math.min(retentionYears, STOCK_DETAILS_MAX_HISTORY_YEARS);
}

/**
 * How far back Stock Details may go for one security.
 *
 * The listing date wins when it is later than the horizon: there is nothing before a security
 * exists, and reporting `LISTING` lets the client say so rather than implying the 30-year limit
 * was reached. A security whose real price history starts later still reports the earlier bound —
 * where the data actually begins is discovered from the rows the bounded reads return.
 */
export function stockDetailsHistoryBounds(input: {
  readonly today: string;
  readonly retentionYears: number;
  readonly ipoDate?: string;
}): StockHistoryBoundsResponse {
  const horizonStart = subtractYears(
    input.today,
    stockDetailsHistoryYears(input.retentionYears),
  );
  const listing = input.ipoDate;
  return listing !== undefined && listing > horizonStart
    ? { start: listing, end: input.today, startOrigin: "LISTING" }
    : { start: horizonStart, end: input.today, startOrigin: "HORIZON" };
}

/**
 * Clamps a requested Stock Details window into the bound.
 *
 * Clamping rather than rejecting: a client that asks for more history than the surface offers is
 * asking for "everything", and answering it with the bound is more useful than a 400. A window
 * that lies entirely outside the bound collapses onto its nearest edge, which reads as empty.
 */
export function clampStockDetailsRange(
  range: DateRange,
  bounds: Pick<StockHistoryBoundsResponse, "start">,
): DateRange {
  return {
    ...range,
    ...(range.from
      ? { from: range.from < bounds.start ? bounds.start : range.from }
      : {}),
    ...(range.to ? { to: range.to < bounds.start ? bounds.start : range.to } : {}),
  };
}
