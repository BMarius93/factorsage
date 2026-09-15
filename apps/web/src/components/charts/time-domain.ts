/**
 * The constrained time domain every product time-series chart navigates inside.
 *
 * One question, answered once: *which dates may the viewport show?* Stock Details and Backtest
 * Results answer it with different dates but with the same rules, so the rules live here rather
 * than as two slightly different copies of edge handling inside two chart components.
 *
 * Nothing in this module touches Lightweight Charts. It is arithmetic over dates and bar indices,
 * which is what makes the boundary behaviour testable without a canvas;
 * `use-bounded-time-scale.ts` is the part that applies it to a chart.
 */

/**
 * How far a chart may be navigated, and whether it may be navigated at all.
 *
 * `minTime`/`maxTime` are the hard boundary — the product's answer to "what is the useful
 * domain", not the extent of whatever data happens to be drawn. They are inclusive dates in the
 * `YYYY-MM-DD` form every series in this app uses, which compare correctly as strings.
 */
export type TimeDomain = {
  /** Oldest navigable date. The viewport may never show anything before it. */
  readonly minTime: string;
  /** Newest navigable date. The viewport may never show anything after it. */
  readonly maxTime: string;
  /**
   * Oldest date currently drawn, or `undefined` while the chart holds no bars.
   *
   * Usually later than `minTime`: Stock Details loads history lazily, so the interval between the
   * two is domain that exists but has not arrived. That interval is navigable — moving into it is
   * how the page asks for it — and `leadBars` is how far.
   */
  readonly oldestBar: string | undefined;
  /**
   * Nothing older than `oldestBar` can ever arrive, so the drawn series *is* the domain's left
   * edge. This is what turns the soft boundary into the library's own `fixLeftEdge` pin.
   */
  readonly domainComplete: boolean;
  /**
   * `LOCKED` refuses every gesture and holds the viewport on the whole domain — a backtest being
   * computed is not something to explore. `BOUNDED` is ordinary navigation inside the domain.
   */
  readonly interaction: TimeDomainInteraction;
};

export type TimeDomainInteraction = "LOCKED" | "BOUNDED";

/**
 * Calendar days per trading day, the same ratio `history-window.ts` sizes history requests with.
 *
 * Used here for one purpose: converting the not-yet-loaded part of the domain into a number of
 * chart bars, so a drag into it can be stopped at the right place. It is an estimate by nature —
 * the trading calendar is not known until the days are loaded — and it is only ever the *transient*
 * bound. The exact boundary is enforced by the library the moment the domain is complete, and no
 * request is ever issued past `minTime` regardless, so an estimate being a percent generous costs
 * a percent of extra empty space for as long as it takes the next window to arrive.
 */
const CALENDAR_DAYS_PER_TRADING_DAY = 365 / 252;

const MILLISECONDS_PER_DAY = 86_400_000;

/** Whole calendar days from `from` to `to`; negative when `to` precedes `from`. */
function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MILLISECONDS_PER_DAY);
}

/**
 * Bars of empty space the viewport may open to the left of the oldest drawn bar.
 *
 * Zero whenever the domain is complete — there is nothing left to load, so empty space would be
 * blank canvas rather than a request. Otherwise it is the unloaded part of the domain expressed in
 * trading days, which is exactly as far as a gesture may reach before it would be asking for
 * history the product does not offer.
 */
export function leadBarsOf(domain: TimeDomain): number {
  if (domain.domainComplete || domain.oldestBar === undefined) {
    return 0;
  }
  const days = calendarDaysBetween(domain.minTime, domain.oldestBar);
  if (days <= 0) {
    return 0;
  }
  return Math.ceil(days / CALENDAR_DAYS_PER_TRADING_DAY);
}

/**
 * Floating-point slack, in bars, before a viewport counts as out of bounds.
 *
 * Framing a window that spans the whole series leaves a fraction of a bar of padding, and the
 * library reports logical ranges as floats. Correcting those would mean writing a range back on
 * every frame of an ordinary pan — and each write reports a new range, which is how a clamp turns
 * into a feedback loop. A bar of slack is unambiguous: below it nothing is wrong.
 */
const CLAMP_EPSILON_BARS = 1;

export type LogicalRange = { readonly from: number; readonly to: number };

/**
 * The corrected viewport, or `null` when the viewport is already legal.
 *
 * `null` is the important half of the contract: a clamp that always returns a range would have
 * every correction report a change, and every reported change trigger another correction.
 *
 * The zoom level is preserved where it can be — an over-panned window is *slid* back inside the
 * domain rather than squashed — because the user chose that zoom and only the position is wrong.
 * A window wider than the domain itself cannot keep its span, and is pinned to the domain.
 */
export function clampLogicalRange(
  range: LogicalRange,
  bounds: { readonly minFrom: number; readonly maxTo: number },
): LogicalRange | null {
  const { minFrom, maxTo } = bounds;
  const underflow = minFrom - range.from;
  const overflow = range.to - maxTo;
  if (underflow <= CLAMP_EPSILON_BARS && overflow <= CLAMP_EPSILON_BARS) {
    return null;
  }
  if (maxTo - minFrom <= range.to - range.from) {
    return { from: minFrom, to: maxTo };
  }
  const shift = underflow > 0 ? underflow : -overflow;
  return { from: range.from + shift, to: range.to + shift };
}
