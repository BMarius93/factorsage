import type {
  BacktestTradeAction,
  BacktestTradeResponse,
} from "@intrinsic/contracts";
import {
  formatDay,
  formatMoney,
  formatShares,
  formatSignedMoney,
  formatSignedPercent,
} from "../utils/format";
import styles from "./BacktestTrades.module.css";

/** One product label per action; the tone follows the established buy/sell/final-exit colours. */
const ACTION_LABELS = {
  BUY: "Buy",
  SELL: "Sell",
  FINAL_EXIT: "Final exit",
} as const satisfies Record<BacktestTradeAction, string>;

export type BacktestTradesProps = {
  readonly trades: readonly BacktestTradeResponse[];
  readonly title: string;
  readonly emptyMessage: string;
  /** True when the run's true trade count exceeds what the payload carries. */
  readonly truncatedFrom?: number;
};

/**
 * The trade log, newest first.
 *
 * The same component serves the running page's recent trades and a completed run's full log: they
 * differ only in how many rows the payload carries, never in what a trade means.
 */
export function BacktestTrades({
  trades,
  title,
  emptyMessage,
  truncatedFrom,
}: BacktestTradesProps) {
  const shown = [...trades].sort(
    (left, right) => right.sequence - left.sequence,
  );
  const truncated =
    truncatedFrom !== undefined && truncatedFrom > trades.length
      ? truncatedFrom
      : undefined;

  return (
    <section className={styles.card} aria-labelledby="backtest-trades-title">
      <div className={styles.head}>
        <h2 className={styles.title} id="backtest-trades-title">
          {title}
        </h2>
        {truncated === undefined ? (
          <span className={styles.count}>{trades.length}</span>
        ) : (
          <span className={styles.count}>
            {trades.length} of {truncated}
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <p className={styles.empty} data-testid="backtest-trades-empty">
          {emptyMessage}
        </p>
      ) : (
        <ul className={styles.list} data-testid="backtest-trades">
          {shown.map((trade) => (
            <li
              key={trade.sequence}
              className={styles.item}
              data-action={trade.action}
            >
              <span className={styles.action}>
                {ACTION_LABELS[trade.action]}
                {trade.levelPercentage === null
                  ? null
                  : ` ${trade.levelPercentage}%`}
              </span>
              <div className={styles.identity}>
                <span className={styles.symbol}>{trade.symbol}</span>
                <span className={styles.date}>{formatDay(trade.date)}</span>
              </div>
              <div className={styles.figures}>
                <span className={styles.amount}>
                  {formatMoney(trade.amount)}
                </span>
                <span className={styles.detail}>
                  {formatShares(trade.shares)} @ {formatMoney(trade.price)}
                </span>
              </div>
              {trade.realizedPnl === null ? null : (
                <span
                  className={styles.realized}
                  data-tone={
                    trade.realizedPnl === 0
                      ? undefined
                      : trade.realizedPnl > 0
                        ? "positive"
                        : "negative"
                  }
                >
                  {formatSignedMoney(trade.realizedPnl)}
                  {trade.realizedPnlPercent === null
                    ? null
                    : ` · ${formatSignedPercent(trade.realizedPnlPercent)}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
