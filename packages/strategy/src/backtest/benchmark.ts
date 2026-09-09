import type { LocalDate } from "@intrinsic/domain";
import type { BenchmarkSeriesInput } from "./types.js";

/**
 * Reads a benchmark series along the portfolio's ascending execution calendar.
 *
 * The benchmark is passive comparison data: it never consumes cash, never occupies a position slot,
 * and **never contributes a date to the calendar** — the axis comes from the run's securities and
 * the engine's own execution-calendar reference, so two runs differing only in what they are
 * compared against execute identically. This class is the whole of the benchmark's influence on a
 * result: a column of numbers beside the portfolio's.
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
    const close = this.closeAt(date);
    if (close === null) {
      return null;
    }
    if (this.base === null) {
      this.base = close;
    }
    return close / this.base;
  }
}
