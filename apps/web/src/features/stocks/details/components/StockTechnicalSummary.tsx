import { formatLocalDate, formatMoney, formatSignedPercent } from "../utils/format";
import { priceVersusAverage, type TechnicalSnapshot } from "../utils/technicals";
import styles from "./StockTechnicalSummary.module.css";

type StockTechnicalSummaryProps = {
  readonly snapshot: TechnicalSnapshot;
  readonly latestClose?: number;
  readonly currency: string;
};

/**
 * Latest catalog moving averages with the close's position relative to each.
 *
 * Weekly rows carry the latest completed week's value, carried forward onto this trading day by
 * the backend. Indicators still in their warm-up window are absent from the snapshot and simply
 * not rendered.
 */
export function StockTechnicalSummary({
  snapshot,
  latestClose,
  currency,
}: StockTechnicalSummaryProps) {
  return (
    <section className={styles.card} aria-labelledby="technicals-title">
      <div className={styles.heading}>
        <h2 className={styles.title} id="technicals-title">
          Technicals
        </h2>
        <p className={styles.caption}>
          Moving averages as of {formatLocalDate(snapshot.date)}
        </p>
      </div>
      <dl className={styles.list}>
        {snapshot.readings.map((reading) => {
          const relative =
            latestClose === undefined
              ? undefined
              : priceVersusAverage(latestClose, reading.value);
          return (
            <div key={reading.key} className={styles.row}>
              <dt className={styles.label}>{reading.label}</dt>
              <dd className={styles.value}>
                <span>{formatMoney(reading.value, currency)}</span>
                {relative === undefined ? null : (
                  <span
                    className={styles.relative}
                    data-direction={relative >= 0 ? "above" : "below"}
                  >
                    price {formatSignedPercent(relative)}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
