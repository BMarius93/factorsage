import type { LocalDate } from "@intrinsic/domain";
import type { BenchmarkSeriesInput } from "./types.js";

/**
 * Reads a benchmark series along the portfolio's ascending execution calendar.
 *
 * The benchmark is passive comparison data: it never consumes cash, never occupies a position slot,
 * and **never contributes a date to the calendar** — the axis is the engine's own pinned execution
 * calendar, so two runs differing only in what they are compared against execute identically.
 *
 * This class is the whole of the benchmark's influence on the percentage-growth methodology every
 * existing summary metric is built on. The absolute `S&P 500` comparison line is a second reading
 * of the same closes, held by `ComparisonScenarios`, and neither changes the other.
 *
 * On a simulated date the benchmark did not trade, its most recent close at or before that date is
 * used — the same carry-forward rule a held position's valuation
 * uses, and the only point-in-time-correct value available. A date before the benchmark's first
 * available close has no value at all; it is reported as absent rather than fabricated.
 */
export class BenchmarkCursor {
  private cursor = -1;
  private base: number | null = null;

  constructor(private readonly series: BenchmarkSeriesInput | null) {}

  /** Most recent benchmark close at or before `date`, or `null` when none exists yet. */
  closeAt(date: LocalDate): number | null {
    if (!this.series) {
      return null;
    }
    const { dates, closes } = this.series;
    while (
      this.cursor + 1 < dates.length &&
      (dates[this.cursor + 1] as LocalDate) <= date
    ) {
      this.cursor += 1;
    }
    if (this.cursor < 0) {
      return null;
    }
    const close = closes[this.cursor];
    return close !== undefined && Number.isFinite(close) && close > 0
      ? close
      : null;
  }

  /**
   * Growth index of the benchmark on `date`, based at 1.0 on the first date the series had a value.
   *
   * The base is the close in effect on the run's first simulated date whenever one exists, so the
   * two curves start together. When the benchmark's history begins later than the run, the base is
   * its first available close and earlier dates report `null`.
   */
  indexAt(date: LocalDate): number | null {
    return this.indexFor(this.closeAt(date));
  }

  /**
   * The same growth index, from a close the caller already read.
   *
   * The day loop needs that close twice — once for this percentage-growth index, which is the
   * methodology every existing summary metric is built on, and once to mark the funded absolute
   * comparison portfolio. Reading it once and deriving both keeps a single monotonic cursor over
   * the series and makes it impossible for the two readings to disagree about which bar was in
   * effect on a date.
   */
  indexFor(close: number | null): number | null {
    if (close === null) {
      return null;
    }
    if (this.base === null) {
      this.base = close;
    }
    return close / this.base;
  }
}
