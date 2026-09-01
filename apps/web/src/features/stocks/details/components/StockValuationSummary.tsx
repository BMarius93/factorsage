import { formatLocalDate, formatMoney, formatSignedPercent } from "../utils/format";
import {
  upsideFraction,
  type ValuationSnapshot,
} from "../utils/valuation";
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

function upsideFor(
  valuePerShare: number,
  valueCurrency: string,
  currency: string,
  latestClose?: LatestClose,
): number | undefined {
  if (!latestClose || valueCurrency !== currency) {
    return undefined;
  }
  return upsideFraction(valuePerShare, latestClose.value);
}

function UpsideChip({ fraction }: { readonly fraction: number }) {
  const direction = fraction >= 0 ? "above" : "below";
  return (
    <span className={styles.upside} data-direction={direction}>
      {formatSignedPercent(fraction)} vs price
    </span>
  );
}

/**
 * Latest intrinsic-value estimates next to the latest market close.
 *
 * Values come from the backend's point-in-time materialized series untouched; the only derivation
 * is the display upside against the close. Each entry keeps its own valuation date, and a date
 * differing from the section's as-of date is called out instead of silently blended.
 */
export function StockValuationSummary({
  snapshot,
  latestClose,
  currency,
}: StockValuationSummaryProps) {
  return (
    <section className={styles.card} aria-labelledby="valuation-title">
      <div className={styles.heading}>
        <h2 className={styles.title} id="valuation-title">
          Intrinsic value
        </h2>
        {snapshot ? (
          <p className={styles.caption}>
            Valuation as of {formatLocalDate(snapshot.asOfDate)}
            {latestClose
              ? ` · vs close of ${formatLocalDate(latestClose.date)}`
              : ""}
          </p>
        ) : null}
      </div>

      {snapshot ? (
        <>
          {snapshot.blends.length > 0 ? (
            <ul className={styles.blendGrid} aria-label="Blended intrinsic values">
              {snapshot.blends.map((blend) => {
                const upside = upsideFor(
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
                    {upside === undefined ? null : <UpsideChip fraction={upside} />}
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
                const upside = upsideFor(
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
                      {upside === undefined ? null : <UpsideChip fraction={upside} />}
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
    </section>
  );
}
