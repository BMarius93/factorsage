import {
  MONEY_ZERO,
  quantizeMoney,
  quantizePrice,
  toNumber,
  type MoneyValue,
} from "./money.js";
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
  /**
   * Benchmark shares held, at full decimal precision.
   *
   * Deliberately **not** quantized to the ten-decimal scale a persisted position uses. These shares
   * are internal — only the marked value reaches the database — so that scale protects nothing
   * here, and applying it destroys the remainder between the capital that arrived and what a
   * truncated share count could buy. Measured at up to `price x 1e-10` per funding: seven
   * millionths of a dollar across three hundred and sixty one-dollar contributions at $412, and
   * thirty-six millionths at the contract maximum.
   *
   * `funded-scenarios/strategy-benchmark-cash@1` says each external cash flow buys
   * `amount / benchmarkCloseOnThatDate` fractional shares. This is that, exactly.
   */
  private shares: MoneyValue = MONEY_ZERO;
  /**
   * External capital that has arrived but could not yet buy benchmark shares.
   *
   * Only reachable for a benchmark whose history starts after the run's first simulated date, which
   * V1's `SPY`-backed `SP500` never does inside the thirty-year maximum period. Holding it rather
   * than discarding it keeps the scenario funded with the same capital as the others; it is
   * invested in full at the first close the benchmark actually has.
   */
  private pending: MoneyValue = MONEY_ZERO;
  private baseline: MoneyValue = MONEY_ZERO;

  /**
   * Records an external cash flow — the initial capital, or one monthly contribution.
   *
   * Called with the same amount, on the same date, that the Strategy receives.
   */
  fund(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    const deposit = quantizeMoney(amount);
    this.baseline = quantizeMoney(this.baseline.plus(deposit));
    this.pending = quantizeMoney(this.pending.plus(deposit));
  }

  /**
   * The `Cash` line: `initialCapital + cumulativeExternalContributionsThrough(date)`.
   *
   * Under `zero-interest@1` it earns nothing, so it rises only when external capital is added. It
   * is deliberately **not** the Strategy's uninvested cash balance — that is a different number
   * about a different thing, and the two diverge the moment the Strategy buys anything.
   */
  get cashBaselineValue(): MoneyValue {
    return this.baseline;
  }

  /**
   * Invests any pending capital at `close`, then marks the whole holding to it.
   *
   * `close` is the benchmark's close in effect on the date — its own close, or the most recent one
   * before it under the existing carry-forward rule. `null` means the benchmark has no close at or
   * before this date, so the scenario has no value to report; nothing is fabricated.
   *
   * Shares are fractional and exact, consistent with the Strategy's own continuous-share V1
   * assumption, and no fees or slippage are applied. A non-positive close is not a price: the
   * capital stays pending rather than being spent at it, exactly as it does before the benchmark's
   * first close.
   */
  markBenchmark(close: number | null): MoneyValue | null {
    if (close === null) {
      return null;
    }
    const price = quantizePrice(close);
    if (this.pending.gt(MONEY_ZERO) && price.gt(MONEY_ZERO)) {
      // In full, and with no remainder left behind: the pending capital buys exactly
      // `pending / price` shares. Quantization happens once, at the money boundary below, where
      // the value is actually persisted.
      this.shares = this.shares.plus(this.pending.div(price));
      this.pending = MONEY_ZERO;
    }
    return quantizeMoney(this.shares.times(price));
  }

  /** Benchmark shares accumulated so far. Exposed for assertions, never for execution. */
  get benchmarkShares(): number {
    return toNumber(this.shares);
  }

  /**
   * External capital held but not yet invested, for the same read-only purposes.
   *
   * Non-zero only for a benchmark whose history starts after the run's first simulated date, which
   * V1 never reaches; a diagnostic capture reports it so that stays visible rather than assumed.
   */
  get pendingCapital(): number {
    return toNumber(this.pending);
  }
}
