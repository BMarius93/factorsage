import type {
  SecurityProfileResponse,
  SecurityResponse,
} from "@intrinsic/contracts";
import type { ReactNode } from "react";
import {
  formatCompactNumber,
  formatInteger,
  formatLocalDate,
  formatMoney,
  formatWebsiteHost,
} from "../utils/format";
import type { PriceSummary } from "../utils/price-summary";
import styles from "./StockMetrics.module.css";

type StockMetricsProps = {
  readonly security: SecurityResponse;
  readonly profile?: SecurityProfileResponse;
  readonly summary?: PriceSummary;
};

type Fact = {
  readonly label: string;
  readonly value: ReactNode;
};

function facts(entries: ReadonlyArray<Fact | undefined>): Fact[] {
  return entries.filter((entry): entry is Fact => entry !== undefined);
}

function FactList({ items }: { readonly items: readonly Fact[] }) {
  return (
    <dl className={styles.list}>
      {items.map((fact) => (
        <div key={fact.label} className={styles.row}>
          <dt className={styles.label}>{fact.label}</dt>
          <dd className={styles.value}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Key facts panel: the latest-session market snapshot plus company/security metadata. Only facts
 * that actually exist render — optional identity fields are omitted, never shown as empty rows.
 */
export function StockMetrics({ security, profile, summary }: StockMetricsProps) {
  const currency = security.currency;
  const marketFacts = summary
    ? facts([
        summary.change
          ? {
              label: "Previous close",
              value: formatMoney(summary.change.previousClose, currency),
            }
          : undefined,
        {
          label: "Day range",
          value: `${formatMoney(summary.dayLow, currency)} – ${formatMoney(summary.dayHigh, currency)}`,
        },
        {
          label: "52-week range",
          value: `${formatMoney(summary.windowLow, currency)} – ${formatMoney(summary.windowHigh, currency)}`,
        },
        { label: "Volume", value: formatCompactNumber(summary.latestVolume) },
      ])
    : [];

  const companyFacts = facts([
    security.sector ? { label: "Sector", value: security.sector } : undefined,
    security.industry
      ? { label: "Industry", value: security.industry }
      : undefined,
    {
      label: "Exchange",
      value: security.exchangeName ?? security.exchangeCode,
    },
    { label: "Currency", value: security.currency },
    security.country ? { label: "Country", value: security.country } : undefined,
    security.ipoDate
      ? { label: "IPO date", value: formatLocalDate(security.ipoDate) }
      : undefined,
    profile?.ceo ? { label: "CEO", value: profile.ceo } : undefined,
    profile?.employees === undefined
      ? undefined
      : { label: "Employees", value: formatInteger(profile.employees) },
    profile?.website
      ? {
          label: "Website",
          value: (
            <a
              className={styles.link}
              href={profile.website}
              target="_blank"
              rel="noreferrer"
            >
              {formatWebsiteHost(profile.website)}
            </a>
          ),
        }
      : undefined,
  ]);

  return (
    <section className={styles.card} aria-labelledby="key-facts-title">
      <h2 className={styles.title} id="key-facts-title">
        Key facts
      </h2>

      {marketFacts.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>Market snapshot</h3>
          <FactList items={marketFacts} />
        </div>
      ) : null}

      <div className={styles.group}>
        <h3 className={styles.groupTitle}>Company</h3>
        {profile?.description ? (
          <p className={styles.description}>{profile.description}</p>
        ) : null}
        <FactList items={companyFacts} />
      </div>
    </section>
  );
}
