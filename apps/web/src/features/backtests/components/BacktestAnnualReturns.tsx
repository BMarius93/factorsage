import type { BacktestAnnualReturnResponse } from "@intrinsic/contracts";
import { formatSignedPercent } from "../utils/format";
import styles from "./BacktestAnnualReturns.module.css";

export type BacktestAnnualReturnsProps = {
  readonly years: readonly BacktestAnnualReturnResponse[];
  /** One line under the heading, e.g. while a run is still producing years. */
  readonly caption?: string;
};

/**
 * What the portfolio returned in each calendar year — **that year alone**.
 *
 * Not a cumulative badge. `1998 +139.83%` means 1998 itself, and a thirty-year run therefore shows
 * thirty independent figures rather than one number climbing toward its final total. The figures
 * come from the canonical return index (`backtestAnnualReturns`), so a year that received twelve
 * monthly contributions does not report the deposits as performance.
 *
 * Thirty years is the design constraint. A phone gets a compact multi-column grid rather than the
 * full-width pills this replaced — those cost a whole screen on their own — and a desktop lays the
 * same cells out wider still, so the section reads as a strip under the totals it decomposes
 * rather than as a wall of its own.
 */
export function BacktestAnnualReturns({
  years,
  caption,
}: BacktestAnnualReturnsProps) {
  if (years.length === 0) {
    return null;
  }
  return (
    <section
      className={styles.section}
      aria-labelledby="backtest-annual-returns-title"
      data-testid="backtest-annual-returns"
      data-year-count={years.length}
    >
      <div className={styles.head}>
        <h2 className={styles.title} id="backtest-annual-returns-title">
          Annual returns
        </h2>
        <p className={styles.caption}>
          {caption ?? "Each calendar year on its own, not cumulative."}
        </p>
      </div>
      <dl className={styles.grid}>
        {years.map((entry) => (
          <div
            key={entry.year}
            className={styles.cell}
            data-testid="backtest-annual-return"
            data-year={entry.year}
            data-partial={entry.partial ? "true" : undefined}
            title={
              entry.partial
                ? `${entry.year}: ${formatSignedPercent(
                    entry.returnPercent,
                  )} over the part of the year the run simulated, through ${
                    entry.simulatedThrough
                  }`
                : `${entry.year}: ${formatSignedPercent(entry.returnPercent)}`
            }
          >
            <dt className={styles.year}>
              {entry.year}
              {/* A part-year figure is a true return over a shorter window, and saying so is
                  cheaper than a reader assuming it is comparable to a full year. */}
              {entry.partial ? (
                <span className={styles.partial} aria-label="partial year">
                  *
                </span>
              ) : null}
            </dt>
            <dd
              className={styles.value}
              data-tone={
                entry.returnPercent === 0
                  ? undefined
                  : entry.returnPercent > 0
                    ? "positive"
                    : "negative"
              }
            >
              {formatSignedPercent(entry.returnPercent)}
            </dd>
          </div>
        ))}
      </dl>
      {years.some((entry) => entry.partial) ? (
        <p className={styles.footnote}>
          * part of the year only — the run started or ended inside it.
        </p>
      ) : null}
    </section>
  );
}
