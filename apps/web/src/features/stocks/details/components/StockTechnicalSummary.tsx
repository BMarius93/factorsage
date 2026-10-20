import { formatLocalDate, formatMoney } from "../utils/format";
import {
  priceVersusAverage,
  type TechnicalSnapshot,
} from "../utils/technicals";
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
 *
 * The comparison is named once, by a heading over its column, and every row carries just the
 * signed figure (SD-6): fourteen rows of "Price vs average:" read slower than one heading. A
 * screen reader, which has no column to look up, still hears the words with each figure.
 */
export function StockTechnicalSummary({
  snapshot,
  latestClose,
  currency,
}: StockTechnicalSummaryProps) {
  const relatives = snapshot.readings.map((reading) =>
    latestClose === undefined
      ? undefined
      : priceVersusAverage(latestClose, reading.value),
  );
  return (
    <SectionCard
      id="technicals"
      title="Technicals"
      caption={`Moving averages as of ${formatLocalDate(snapshot.date)}`}
    >
      {relatives.some((relative) => relative !== undefined) ? (
        <div
          className={styles.columnHeading}
          aria-hidden="true"
          data-testid="technicals-relative-heading"
        >
          Price vs avg.
        </div>
      ) : null}
      <dl className={styles.list}>
        {snapshot.readings.map((reading, index) => {
          const relative = relatives[index];
          return (
            <div key={reading.key} className={styles.row}>
              <dt className={styles.label}>{reading.label}</dt>
              <dd className={styles.value}>
                <span>{formatMoney(reading.value, currency)}</span>
                {relative === undefined ? null : (
                  <PriceRelative
                    reference="average"
                    fraction={relative}
                    phrasing="figure"
                  />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </SectionCard>
  );
}
