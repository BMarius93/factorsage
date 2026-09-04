import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import { shiftLocalDateDays } from "./local-dates";

/**
 * How Stock Details turns a viewport into a history request.
 *
 * The chart owns the viewport and the API owns the data; this module is the translation between
 * them. It answers one question — *given where the user has navigated, what older window is still
 * missing?* — and it answers it in dates, so no component has to do calendar arithmetic and no
 * second copy of the 30-year limit exists anywhere.
 *
 * The limit itself is `STOCK_DETAILS_MAX_HISTORY_YEARS` in `@intrinsic/contracts`. The API resolves
 * it against each security's listing date and reports the result as `history.start`; everything
 * here navigates against that reported bound rather than recomputing it.
 */

export { STOCK_DETAILS_MAX_HISTORY_YEARS };

/**
 * Calendar days per trading day. Used only to size a request from a count of chart bars, which is
 * an estimate by nature: asking for slightly more calendar days than the bars strictly need costs
 * nothing, because the loader answers with whatever trading days actually exist inside the window.
 */
const CALENDAR_DAYS_PER_TRADING_DAY = 365 / 252;

/**
 * Bars of genuinely empty space to the left of the oldest bar before the next window is fetched.
 *
 * Deliberately not zero. Framing a window that spans the whole loaded series leaves a fraction of
 * a bar of padding at the left edge, and reading that as navigation would make every page view
 * prefetch a year nobody asked for. A few bars of slack is unambiguous: the user has dragged or
 * zoomed into history that is not loaded.
 */
export const HISTORY_EDGE_TRIGGER_BARS = 5;

/**
 * Bars loaded beyond the empty space the viewport currently shows, so a steady pan does not have
 * to stop and wait once per screen.
 */
const HISTORY_PREFETCH_BARS = 120;

/**
 * Smallest history request. A pan crossing the edge by a few bars still asks for a year: many
 * slivers cost more round trips, more provider deltas and more merges than one modest window,
 * and the loader's own derived warm-up dwarfs a sliver anyway.
 */
const MIN_HISTORY_STEP_DAYS = 365;

/**
 * The older window to request, or `null` when there is nothing left to ask for.
 *
 * The size follows the viewport rather than a fixed schedule: a pan sees a screen of empty space
 * and asks for about a year, while a wide zoom-out sees thousands of empty bars and asks for the
 * years needed to fill them in one request. Both are clamped to `historyStart`, so no request is
 * ever made for history before the boundary — the 30-year product horizon, or the security's
 * listing date when that is later.
 */
export function historyRequestStart(input: {
  readonly loadedFrom: string;
  /** Trading days of empty space to the left of the loaded history. */
  readonly barsBeforeLoaded: number;
  readonly historyStart: string;
}): string | null {
  if (input.loadedFrom <= input.historyStart) {
    return null;
  }
  const bars = Math.max(0, input.barsBeforeLoaded) + HISTORY_PREFETCH_BARS;
  const days = Math.max(
    MIN_HISTORY_STEP_DAYS,
    Math.ceil(bars * CALENDAR_DAYS_PER_TRADING_DAY),
  );
  const requested = shiftLocalDateDays(input.loadedFrom, -days);
  return requested < input.historyStart ? input.historyStart : requested;
}

/**
 * Merges a newly loaded older window into what is already on screen.
 *
 * Ascending by date and deduplicated on the identity the caller names, so a window that overlaps
 * what is already loaded — a retry, a range whose edges meet — can never produce a duplicate row
 * or a gap at the seam. The incoming rows win on a collision: they are the fresher read.
 */
export function mergeHistory<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string,
  dateOf: (row: T) => string,
): T[] {
  if (incoming.length === 0) {
    return [...existing];
  }
  const byKey = new Map<string, T>();
  for (const row of existing) {
    byKey.set(keyOf(row), row);
  }
  for (const row of incoming) {
    byKey.set(keyOf(row), row);
  }
  return [...byKey.values()].sort((left, right) =>
    dateOf(left).localeCompare(dateOf(right)),
  );
}
