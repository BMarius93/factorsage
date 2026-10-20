import { formatPriceRelative, formatSignedPercent } from "../utils/format";
import styles from "./PriceRelative.module.css";

type PriceRelativeProps = {
  /** What the price is compared with, in words: "value", "average". */
  readonly reference: string;
  /** `(price - reference) / reference`; negative means the price is below its reference. */
  readonly fraction: number;
  /**
   * `sentence` (the default) says the whole comparison: "Price 5.90% below value". `figure` is
   * the bare signed number, "-5.90%", for a column whose visible heading already names the
   * comparison; the words stay in the accessible text, so a screen reader still hears what the
   * number compares.
   */
  readonly phrasing?: "sentence" | "figure";
  /** The sentence may wrap rather than overflow a narrow container, such as a blend tile. */
  readonly wrap?: boolean;
};

/**
 * Where the price sits against a reference — the one way Stock Details states it (UI-018, SD-4).
 *
 * Always the price relative to the reference, always the same sign convention, and deliberately
 * neutral in colour: a price below its intrinsic value and a price below its moving average mean
 * different things to different readers, so green and red would assert a judgement the page does
 * not make.
 */
export function PriceRelative({
  reference,
  fraction,
  phrasing = "sentence",
  wrap = false,
}: PriceRelativeProps) {
  return (
    <span
      className={styles.relative}
      data-direction={
        fraction === 0 ? "equal" : fraction > 0 ? "above" : "below"
      }
      data-wrap={wrap ? "true" : undefined}
    >
      {phrasing === "sentence" ? (
        formatPriceRelative(fraction, reference)
      ) : (
        <>
          <span className={styles.srOnly}>Price vs {reference}: </span>
          {formatSignedPercent(fraction)}
        </>
      )}
    </span>
  );
}
