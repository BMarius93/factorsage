import { formatLocalDate, formatMoney } from "../utils/format";
import { priceVersusValue, type ValuationSnapshot } from "../utils/valuation";
import { PriceRelative } from "./PriceRelative";
import { InfoTip } from "../../../../components/ui/InfoTip";
import { SectionCard } from "../../../../components/ui/SectionCard";
import { DisclosureNote } from "../../../legal/components/DisclosureNote";
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
 * What every "Price … above/below value" in the section means, explained once: where the price
 * stands against an estimate, never a prediction of where it goes.
 */
const VALUE_COMPARISON_EXPLANATION =
  "Each percentage compares the latest closing price with that intrinsic-value estimate. It is not a forecast or an expected return.";

/**
 * Latest intrinsic-value estimates next to the latest market close.
 *
 * Values come from the backend's point-in-time materialized series untouched; the only derivation
 * is where the close sits against each value, stated in words — "Price 73.92% above value" — so
 * nobody has to decode a sign (SD-4). Every blend and every model is stated the same way, in the
 * same neutral style and in the catalog's order: none is hidden, demoted or flagged, however far
 * it sits from the others. Each entry keeps its own valuation date, and a date differing from the
 * section's as-of date is called out instead of silently blended.
 */
export function StockValuationSummary({
  snapshot,
  latestClose,
  currency,
}: StockValuationSummaryProps) {
  // The comparisons are explained on the as-of line, and only when there is one to explain. The tip
  // leads the line: its bubble opens from the button across the card, which clips what overflows
  // it, so only a button at the card's inner edge leaves the bubble room on every width — a
  // phone's card is barely wider than the bubble.
  const compared =
    snapshot !== undefined &&
    [...snapshot.blends, ...snapshot.models].some(
      (entry) =>
        priceVsValueFor(
          entry.valuePerShare,
          entry.currency,
          currency,
          latestClose,
        ) !== undefined,
    );
  return (
    <SectionCard
      id="valuation"
      title="Intrinsic value"
      {...(snapshot
        ? {
            caption: (
              <>
                {compared ? (
                  <>
                    <span className={styles.captionTip}>
                      <InfoTip
                        label="price versus value"
                        testId="valuation-comparison-tip"
                      >
                        {VALUE_COMPARISON_EXPLANATION}
                      </InfoTip>
                    </span>{" "}
                  </>
                ) : null}
                {`Valuation as of ${formatLocalDate(snapshot.asOfDate)}${
                  latestClose
                    ? ` · vs close of ${formatLocalDate(latestClose.date)}`
                    : ""
                }`}
              </>
            ),
          }
        : {})}
    >
      {snapshot ? (
        <>
          {snapshot.blends.length > 0 ? (
            <ul
              className={styles.blendGrid}
              aria-label="Blended intrinsic values"
            >
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
                    {upside === undefined ? null : (
                      <PriceRelative reference="value" fraction={upside} wrap />
                    )}
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
            <dl
              className={styles.modelList}
              aria-label="Intrinsic values by model"
            >
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
                      <span>
                        {formatMoney(model.valuePerShare, model.currency)}
                      </span>
                      {upside === undefined ? null : (
                        <PriceRelative reference="value" fraction={upside} />
                      )}
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

      {/* Beside the figures, not at the foot of the page: these are model outputs, and the one
          sentence that says so belongs where somebody reads the number. */}
      <DisclosureNote id="valuations" className={styles.disclosure} />
    </SectionCard>
  );
}
