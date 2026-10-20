import { SectionCard } from "../../../../components/ui/SectionCard";
import {
  formatLocalDate,
  formatMoney,
  formatOscillator,
} from "../utils/format";
import { priceVersusAverage, type TechnicalRow } from "../utils/technicals";
import { PriceRelative } from "./PriceRelative";
import styles from "./StockTechnicalSummary.module.css";

type StockTechnicalSummaryProps = {
  /** EMA 50D, EMA 200D and RSI 14D, in that order (`technicalRows`). */
  readonly rows: readonly TechnicalRow[];
  /** The newest close and its session: what each average is compared with. */
  readonly latestClose?: { readonly value: number; readonly date: string };
  readonly currency: string;
};

/**
 * The compact Technicals card: EMA 50D, EMA 200D and RSI 14D, and nothing else.
 *
 * Every other moving average and oscillator stays in the chart's `Indicators` control — only this
 * permanent card is narrowed. Values are the persisted derived state as the API returned it. Each
 * average shows where the close sits against it, as the one signed figure under a "Price vs avg."
 * heading (SD-6), and only when the average belongs to the close's own session; RSI is a unitless
 * reading and is never compared with a price. There is no Buy or Sell reading of any of it.
 */
export function StockTechnicalSummary({
  rows,
  latestClose,
  currency,
}: StockTechnicalSummaryProps) {
  const asOf = latestClose?.date;
  const relatives = rows.map((row) =>
    row.kind === "average" &&
    row.value !== undefined &&
    latestClose !== undefined &&
    row.date === latestClose.date
      ? priceVersusAverage(latestClose.value, row.value)
      : undefined,
  );
  return (
    <SectionCard
      id="technicals"
      title="Technicals"
      {...(asOf ? { caption: `As of ${formatLocalDate(asOf)} close` } : {})}
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
        {rows.map((row, index) => {
          const relative = relatives[index];
          return (
            <div
              key={row.id}
              className={styles.row}
              data-testid={`technical-${row.id}`}
            >
              <dt className={styles.label}>
                {row.label}
                {row.date !== undefined &&
                asOf !== undefined &&
                row.date !== asOf ? (
                  <span className={styles.readingDate}>
                    {" "}
                    as of {formatLocalDate(row.date)}
                  </span>
                ) : null}
              </dt>
              <dd className={styles.value}>
                {row.value === undefined ? (
                  <span className={styles.unavailable}>Unavailable</span>
                ) : (
                  <span>
                    {row.kind === "oscillator"
                      ? formatOscillator(row.value)
                      : formatMoney(row.value, currency)}
                  </span>
                )}
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
