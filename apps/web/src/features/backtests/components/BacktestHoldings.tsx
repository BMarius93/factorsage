import type { BacktestHoldingResponse } from "@intrinsic/contracts";
import {
  formatMoney,
  formatPercent,
  formatShares,
  formatSignedPercent,
} from "../utils/format";
import styles from "./BacktestHoldings.module.css";

export type BacktestHoldingsProps = {
  readonly holdings: readonly BacktestHoldingResponse[];
  readonly title: string;
  readonly emptyMessage: string;
};

/**
 * Current holdings and how the portfolio is allocated across them.
 *
 * Cards rather than a table: allocation is the number that matters and it needs to stay readable
 * at 390px, where a seven-column row would either overflow or shrink into illegibility.
 */
export function BacktestHoldings({
  holdings,
  title,
  emptyMessage,
}: BacktestHoldingsProps) {
  return (
    <section className={styles.card} aria-labelledby="backtest-holdings-title">
      <div className={styles.head}>
        <h2 className={styles.title} id="backtest-holdings-title">
          {title}
        </h2>
        <span className={styles.count}>{holdings.length}</span>
      </div>

      {holdings.length === 0 ? (
        <p className={styles.empty} data-testid="backtest-holdings-empty">
          {emptyMessage}
        </p>
      ) : (
        <ul className={styles.list} data-testid="backtest-holdings">
          {holdings.map((holding) => (
            <li key={holding.symbol} className={styles.item}>
              <div className={styles.identity}>
                <span className={styles.symbol}>{holding.symbol}</span>
                <span className={styles.name}>{holding.name}</span>
              </div>
              <div className={styles.figures}>
                <span className={styles.value}>
                  {formatMoney(holding.marketValue)}
                </span>
                <span
                  className={styles.change}
                  data-tone={
                    holding.unrealizedPnlPercent === 0
                      ? undefined
                      : holding.unrealizedPnlPercent > 0
                        ? "positive"
                        : "negative"
                  }
                >
                  {formatSignedPercent(holding.unrealizedPnlPercent)}
                </span>
              </div>
              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>Allocation</dt>
                  <dd>{formatPercent(holding.allocationPercent)}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Shares</dt>
                  <dd>{formatShares(holding.shares)}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Avg cost</dt>
                  <dd>{formatMoney(holding.averageCost)}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Last</dt>
                  <dd>{formatMoney(holding.lastPrice)}</dd>
                </div>
              </dl>
              {/* Allocation is the reason this panel exists; the bar makes concentration
                  visible without the user comparing eight percentages by eye. */}
              <div
                className={styles.allocationTrack}
                role="presentation"
                aria-hidden="true"
              >
                <span
                  className={styles.allocationFill}
                  style={{
                    width: `${Math.min(100, Math.max(0, holding.allocationPercent))}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
