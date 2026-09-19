import { formatLocalDate, formatMoney } from "../utils/format";
import { priceVersusAverage, type TechnicalSnapshot } from "../utils/technicals";
import { PriceRelative } from "./PriceRelative";
import { SectionCard } from "../../../../components/ui/SectionCard";
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
    <SectionCard
      id="technicals"
      title="Technicals"
      caption={`Moving averages as of ${formatLocalDate(snapshot.date)}`}
    >
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
                  <PriceRelative reference="average" fraction={relative} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </SectionCard>
  );
}
