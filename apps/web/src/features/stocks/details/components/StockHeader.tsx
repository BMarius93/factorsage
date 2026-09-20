import type {
  SecurityProfileResponse,
  SecurityResponse,
} from "@intrinsic/contracts";
import type { ReactNode } from "react";
import { PageHeader } from "../../../../components/ui/PageHeader";
import { StatusBadge } from "../../../../components/ui/StatusBadge";
import { StockLogo } from "../../../../components/ui/StockIdentity";
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
  /**
   * Optional company profile. Its logo is decoration: the header renders identically without
   * one, and a broken image falls back to the ticker monogram.
   */
  readonly profile?: SecurityProfileResponse;
  /** Page actions — "Add to list" — rendered where every entity header puts them. */
  readonly actions?: ReactNode;
};

const SECURITY_TYPE_BADGES: Partial<Record<SecurityResponse["type"], string>> =
  {
    ETF: "ETF",
    FUND: "Fund",
  };

/**
 * Identity block for the stock: who this is, where it trades, and the latest end-of-day quote.
 * The change is derived from the two most recent EOD closes and is labelled as at-close data —
 * nothing here claims to be live.
 */
export function StockHeader({
  security,
  summary,
  profile,
  actions,
}: StockHeaderProps) {
  const change = summary?.change;
  const direction =
    change === undefined ? undefined : change.absolute >= 0 ? "up" : "down";
  const typeBadge = SECURITY_TYPE_BADGES[security.type];

  return (
    <PageHeader
      // A quote header, not a page introduction: the identity, the close and the one action
      // read as a single dense row so the chart below starts as high as it can.
      density="compact"
      {...(actions ? { actions } : {})}
      // Beside the identity rather than inside the heading: the mark then spans the ticker and
      // the listing metadata under it, which is what keeps a phone's identity two lines instead
      // of three.
      mark={
        <StockLogo
          symbol={security.symbol}
          name={security.name}
          size="lg"
          // The page's own identity, above the fold on every viewport: nothing is gained by
          // deferring it behind a viewport check it passes on the first frame.
          loading="eager"
          {...(profile?.logoUrl ? { logoUrl: profile.logoUrl } : {})}
        />
      }
      title={
        <span className={styles.titleText}>
          <span className={styles.symbol}>{security.symbol}</span>
          <span className={styles.name}>{security.name}</span>
        </span>
      }
      badges={
        <ul className={styles.badges} aria-label="Listing details">
          {[
            security.exchangeName ?? security.exchangeCode,
            security.currency,
            ...(typeBadge ? [typeBadge] : []),
            ...(security.isAdr ? ["ADR"] : []),
          ].map((label) => (
            <li key={label}>
              <StatusBadge tone="neutral" variant="outline">
                {label}
              </StatusBadge>
            </li>
          ))}
          {security.isActivelyTrading ? null : (
            <li>
              <StatusBadge tone="warning">Not actively trading</StatusBadge>
            </li>
          )}
        </ul>
      }
      aside={
        summary ? (
          <>
            {/* The close and its move are one fact and sit on one line; only the metadata
                below them is a second. */}
            <div className={styles.quote}>
              <p className={styles.price}>
                {formatMoney(summary.latestClose, security.currency)}
              </p>
              {change && direction ? (
                <p className={styles.change} data-direction={direction}>
                  <span aria-hidden="true">
                    {direction === "up" ? "▲" : "▼"}
                  </span>{" "}
                  {formatSignedMoney(change.absolute, security.currency)} (
                  {formatSignedPercent(change.fraction)})
                </p>
              ) : null}
            </div>
            <p className={styles.asOf}>
              At close · {formatLocalDate(summary.latestDate)} · End-of-day data
            </p>
          </>
        ) : (
          <p className={styles.noQuote}>No recent price data</p>
        )
      }
    />
  );
}
