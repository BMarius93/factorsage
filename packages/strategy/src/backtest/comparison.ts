/**
 * The two funded comparison scenarios the backtest chart shows beside the Strategy.
 *
 * All three scenarios receive **the same external cash flows on the same dates** — the same initial
 * capital and the same monthly contributions — and differ only in what happens to the money:
 *
 * ```text
 * Strategy   traded by the Strategy's own BUY/SELL rules
 * S&P 500    invested passively in the run's pinned comparison series
 * Cash       never invested
 * ```
 *
 * That shared funding is the whole point of the comparison: a difference between the lines is a
 * difference in what the money *did*, never a difference in how much of it there was.
 *
 * See `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md`.
 */

/**
 * The cash baseline and the funded benchmark portfolio, advanced along the execution calendar.
 *
 * State only — the caller owns the calendar walk — so this survives a year boundary by being
 * carried, exactly like the Strategy's own position state.
 */
export class ComparisonScenarios {
  private shares = 0;
  /**
   * External capital that has arrived but could not yet buy benchmark shares.
   *
   * Only reachable for a benchmark whose history starts after the run's first simulated date, which
   * V1's `SPY`-backed `SP500` never does inside the thirty-year maximum period. Holding it rather
   * than discarding it keeps the scenario funded with the same capital as the others; it is
   * invested in full at the first close the benchmark actually has.
   */
  private pending = 0;
  private baseline = 0;

  /**
   * Records an external cash flow — the initial capital, or one monthly contribution.
   *
   * Called with the same amount, on the same date, that the Strategy receives.
   */
  fund(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.baseline += amount;
    this.pending += amount;
  }

  /**
   * The `Cash` line: `initialCapital + cumulativeExternalContributionsThrough(date)`.
   *
   * Under `zero-interest@1` it earns nothing, so it rises only when external capital is added. It
   * is deliberately **not** the Strategy's uninvested cash balance — that is a different number
   * about a different thing, and the two diverge the moment the Strategy buys anything.
   */
  get cashBaselineValue(): number {
    return this.baseline;
  }

  /**
   * Invests any pending capital at `close`, then marks the whole holding to it.
   *
   * `close` is the benchmark's close in effect on the date — its own close, or the most recent one
   * before it under the existing carry-forward rule. `null` means the benchmark has no close at or
   * before this date, so the scenario has no value to report; nothing is fabricated.
   *
   * Shares are fractional, consistent with the Strategy's own continuous-share V1 assumption, and
   * no fees or slippage are applied.
   */
  markBenchmark(close: number | null): number | null {
    if (close === null) {
      return null;
    }
    if (this.pending > 0) {
      this.shares += this.pending / close;
      this.pending = 0;
    }
    return this.shares * close;
  }

  /** Benchmark shares accumulated so far. Exposed for assertions, never for execution. */
  get benchmarkShares(): number {
    return this.shares;
  }
}
