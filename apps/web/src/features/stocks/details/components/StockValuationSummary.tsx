import { formatLocalDate, formatMoney } from "../utils/format";
import { priceVersusValue, type ValuationSnapshot } from "../utils/valuation";
import { PriceRelative } from "./PriceRelative";
import { SectionCard } from "../../../../components/ui/SectionCard";
import styles from "./StockValuationSummary.module.css";

type LatestClose = {
  readonly value: number;
  readonly date: string;
};

type StockValuationSummaryProps = {
  readonly snapshot?: ValuationSnapshot;
  readonly latestClose?: LatestClose;
  /** The security's trading currency; upside is only computed against same-currency values. */
  readonly currency: string;
};

function priceVsValueFor(
  valuePerShare: number,
  valueCurrency: string,
  currency: string,
  latestClose?: LatestClose,
): number | undefined {
  if (!latestClose || valueCurrency !== currency) {
    return undefined;
  }
  return priceVersusValue(latestClose.value, valuePerShare);
}

/**
 * Latest intrinsic-value estimates next to the latest market close.
 *
 * Values come from the backend's point-in-time materialized series untouched; the only derivation
 * is where the close sits against each value, stated as "Price vs value". Each entry keeps its own valuation date, and a date
 * differing from the section's as-of date is called out instead of silently blended.
 */
export function StockValuationSummary({
  snapshot,
  latestClose,
  currency,
}: StockValuationSummaryProps) {
  return (
    <SectionCard
      id="valuation"
      title="Intrinsic value"
      {...(snapshot
        ? {
            caption: `Valuation as of ${formatLocalDate(snapshot.asOfDate)}${
              latestClose
                ? ` · vs close of ${formatLocalDate(latestClose.date)}`
                : ""
            }`,
          }
        : {})}
    >

      {snapshot ? (
        <>
          {snapshot.blends.length > 0 ? (
            <ul className={styles.blendGrid} aria-label="Blended intrinsic values">
              {snapshot.blends.map((blend) => {
                const upside = priceVsValueFor(
                  blend.valuePerShare,
                  blend.currency,
                  currency,
                  latestClose,
                );
                return (
                  <li key={blend.blendId} className={styles.blendTile}>
                    <span className={styles.blendLabel}>{blend.label}</span>
                    <span className={styles.blendValue}>
                      {formatMoney(blend.valuePerShare, blend.currency)}
                    </span>
                    {upside === undefined ? null : <PriceRelative reference="value" fraction={upside} />}
                    {blend.valuationDate === snapshot.asOfDate ? null : (
                      <span className={styles.staleNote}>
                        as of {formatLocalDate(blend.valuationDate)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {snapshot.models.length > 0 ? (
            <dl className={styles.modelList} aria-label="Intrinsic values by model">
              {snapshot.models.map((model) => {
                const upside = priceVsValueFor(
                  model.valuePerShare,
                  model.currency,
                  currency,
                  latestClose,
                );
                return (
                  <div key={model.model} className={styles.modelRow}>
                    <dt className={styles.modelLabel}>
                      {model.label}
                      {model.valuationDate === snapshot.asOfDate ? null : (
                        <span className={styles.staleNote}>
                          {" "}
                          as of {formatLocalDate(model.valuationDate)}
                        </span>
                      )}
                    </dt>
                    <dd className={styles.modelValue}>
                      <span>{formatMoney(model.valuePerShare, model.currency)}</span>
                      {upside === undefined ? null : <PriceRelative reference="value" fraction={upside} />}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
        </>
      ) : (
        <p className={styles.empty}>
          No intrinsic-value estimates are available for this stock yet.
        </p>
      )}
    </SectionCard>
  );
}
