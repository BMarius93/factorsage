import type { SecurityResponse } from "@intrinsic/contracts";
import {
  formatLocalDate,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
} from "../utils/format";
import type { PriceSummary } from "../utils/price-summary";
import styles from "./StockHeader.module.css";

type StockHeaderProps = {
  readonly security: SecurityResponse;
  readonly summary?: PriceSummary;
};

const SECURITY_TYPE_BADGES: Partial<Record<SecurityResponse["type"], string>> = {
  ETF: "ETF",
  FUND: "Fund",
};

/**
 * Identity block for the stock: who this is, where it trades, and the latest end-of-day quote.
 * The change is derived from the two most recent EOD closes and is labelled as at-close data —
 * nothing here claims to be live.
 */
export function StockHeader({ security, summary }: StockHeaderProps) {
  const change = summary?.change;
  const direction =
    change === undefined ? undefined : change.absolute >= 0 ? "up" : "down";
  const typeBadge = SECURITY_TYPE_BADGES[security.type];

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <h1 className={styles.title}>
          <span className={styles.symbol}>{security.symbol}</span>
          <span className={styles.name}>{security.name}</span>
        </h1>
        <ul className={styles.badges} aria-label="Listing details">
          <li className={styles.badge}>
            {security.exchangeName ?? security.exchangeCode}
          </li>
          <li className={styles.badge}>{security.currency}</li>
          {typeBadge ? <li className={styles.badge}>{typeBadge}</li> : null}
          {security.isAdr ? <li className={styles.badge}>ADR</li> : null}
          {security.isActivelyTrading ? null : (
            <li className={`${styles.badge} ${styles.badgeWarning}`}>
              Not actively trading
            </li>
          )}
        </ul>
      </div>

      <div className={styles.quote}>
        {summary ? (
          <>
            <p className={styles.price}>
              {formatMoney(summary.latestClose, security.currency)}
            </p>
            {change && direction ? (
              <p className={styles.change} data-direction={direction}>
                <span aria-hidden="true">{direction === "up" ? "▲" : "▼"}</span>{" "}
                {formatSignedMoney(change.absolute, security.currency)} (
                {formatSignedPercent(change.fraction)})
              </p>
            ) : null}
            <p className={styles.asOf}>
              At close · {formatLocalDate(summary.latestDate)} · End-of-day data
            </p>
          </>
        ) : (
          <p className={styles.noQuote}>No recent price data</p>
        )}
      </div>
    </header>
  );
}
