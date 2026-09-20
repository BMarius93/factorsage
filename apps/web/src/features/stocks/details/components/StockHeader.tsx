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
      {...(actions ? { actions } : {})}
      title={
        <span className={styles.identityRow}>
          <StockLogo
            symbol={security.symbol}
            name={security.name}
            size="lg"
            // The page's own identity, above the fold on every viewport: nothing is gained by
            // deferring it behind a viewport check it passes on the first frame.
            loading="eager"
            {...(profile?.logoUrl ? { logoUrl: profile.logoUrl } : {})}
          />
          <span className={styles.titleText}>
            <span className={styles.symbol}>{security.symbol}</span>
            <span className={styles.name}>{security.name}</span>
          </span>
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
        )
      }
    />
  );
}
