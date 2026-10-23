import type { BacktestAnnualReturnResponse } from "@intrinsic/contracts";
import { useId } from "react";
import { annualReturnShade } from "../utils/annual-heatmap";
import { formatSignedPercent, METRIC_PLACEHOLDER } from "../utils/format";
import styles from "./BacktestAnnualReturns.module.css";

export type BacktestAnnualReturnsProps = {
  readonly years: readonly BacktestAnnualReturnResponse[];
  /** The benchmark's own product name, which labels its row. */
  readonly benchmarkName: string;
  /** One line under the heading, e.g. while a run is still producing years. */
  readonly caption?: string;
};

function strategyTitle(entry: BacktestAnnualReturnResponse): string {
  const value = formatSignedPercent(entry.returnPercent);
  return entry.partial
    ? `${entry.year}: Strategy ${value} over the part of the year the run simulated, through ${entry.simulatedThrough}`
    : `${entry.year}: Strategy ${value}`;
}

function benchmarkTitle(
  entry: BacktestAnnualReturnResponse,
  benchmarkName: string,
): string {
  if (entry.benchmarkReturnPercent === null) {
    return `${entry.year}: ${benchmarkName} return unavailable — the benchmark has no value at the start or the end of this year's window`;
  }
  const value = formatSignedPercent(entry.benchmarkReturnPercent);
  return entry.partial
    ? `${entry.year}: ${benchmarkName} ${value} over the same part of the year, through ${entry.simulatedThrough}`
    : `${entry.year}: ${benchmarkName} ${value}`;
}

/**
 * What the Strategy and its benchmark returned in each calendar year — **that year alone** — as a
 * two-row heatmap: one column per year, oldest first, the figure printed in every cell and its
 * shade saying how large a gain (green) or loss (red) it was.
 *
 * Not cumulative. `1998 +139.83%` means 1998 itself, and a thirty-year run shows thirty independent
 * pairs. Both rows come from the canonical `backtestAnnualReturns`: the Strategy's off the run's
 * cash-flow-adjusted return index, so contributions never read as performance, and the
 * benchmark's off the run's own benchmark index on exactly the same two dates, so the two cells
 * of a column always describe one window. A benchmark figure the run cannot measure over that
 * window is shown as unavailable, never estimated.
 *
 * Thirty years is the design constraint. The table keeps a compact fixed column width and scrolls
 * sideways inside its own region — a keyboard can scroll it too — with the row labels pinned, so
 * a long history never widens the page and every value stays under its year.
 */
export function BacktestAnnualReturns({
  years,
  benchmarkName,
  caption,
}: BacktestAnnualReturnsProps) {
  const titleId = useId();
  if (years.length === 0) {
    return null;
  }
  const anyPartial = years.some((entry) => entry.partial);
  const anyUnavailable = years.some(
    (entry) => entry.benchmarkReturnPercent === null,
  );
  return (
    <section
      className={styles.section}
      aria-labelledby={titleId}
      data-testid="backtest-annual-returns"
      data-year-count={years.length}
    >
      <div className={styles.head}>
        <h2 className={styles.title} id={titleId}>
          Annual returns
        </h2>
        <p className={styles.caption}>
          {caption ?? "Each calendar year on its own, not cumulative."}
        </p>
      </div>
      {/* Its own scroll region: focusable so a keyboard can scroll a long history, and named so a
          screen reader announces what it is scrolling. */}
      <div
        className={styles.scroll}
        role="region"
        aria-labelledby={titleId}
        tabIndex={0}
        data-testid="backtest-annual-returns-scroll"
      >
        <table className={styles.table} data-testid="backtest-annual-heatmap">
          <caption className={styles.srOnly}>
            Strategy and {benchmarkName} return in each calendar year, oldest
            first. Each figure is that year alone, not cumulative.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.corner}>
                <span className={styles.srOnly}>Year</span>
              </th>
              {years.map((entry) => (
                <th
                  key={entry.year}
                  scope="col"
                  className={styles.year}
                  data-testid="backtest-annual-year"
                  data-year={entry.year}
                  data-partial={entry.partial ? "true" : undefined}
                >
                  {entry.year}
                  {/* A part-year figure is a true return over a shorter window, and saying so is
                      cheaper than a reader assuming it is comparable to a full year. */}
                  {entry.partial ? (
                    <span
                      className={styles.partialMark}
                      aria-label="partial year"
                    >
                      *
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr data-testid="backtest-annual-strategy-row">
              <th scope="row" className={styles.rowLabel}>
                Strategy
              </th>
              {years.map((entry) => {
                const shade = annualReturnShade(entry.returnPercent);
                return (
                  <td
                    key={entry.year}
                    className={styles.cell}
                    data-testid="backtest-annual-return"
                    data-year={entry.year}
                    data-partial={entry.partial ? "true" : undefined}
                    data-tone={shade.tone}
                    data-intensity={shade.intensity}
                    title={strategyTitle(entry)}
                  >
                    {formatSignedPercent(entry.returnPercent)}
                  </td>
                );
              })}
            </tr>
            <tr data-testid="backtest-annual-benchmark-row">
              <th scope="row" className={styles.rowLabel}>
                {benchmarkName}
              </th>
              {years.map((entry) => {
                const shade = annualReturnShade(entry.benchmarkReturnPercent);
                return (
                  <td
                    key={entry.year}
                    className={styles.cell}
                    data-testid="backtest-annual-benchmark-return"
                    data-year={entry.year}
                    data-partial={entry.partial ? "true" : undefined}
                    data-tone={shade.tone}
                    data-intensity={shade.intensity}
                    title={benchmarkTitle(entry, benchmarkName)}
                  >
                    {entry.benchmarkReturnPercent === null ? (
                      <>
                        <span aria-hidden="true">{METRIC_PLACEHOLDER}</span>
                        <span className={styles.srOnly}>Unavailable</span>
                      </>
                    ) : (
                      formatSignedPercent(entry.benchmarkReturnPercent)
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <div className={styles.footnotes}>
        {anyPartial ? (
          <p data-testid="backtest-annual-partial-note">
            * part of the year only — the run started or ended inside it.
          </p>
        ) : null}
        {anyUnavailable ? (
          <p data-testid="backtest-annual-unavailable-note">
            {METRIC_PLACEHOLDER} {benchmarkName} return unavailable — the
            benchmark has no value at the start or the end of that year&apos;s
            window.
          </p>
        ) : null}
        <p>
          Shading deepens with the size of the year&apos;s gain (green) or loss
          (red).
        </p>
      </div>
    </section>
  );
}
