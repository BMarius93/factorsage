import { formatSignedPercent } from "../utils/format";
import styles from "./PriceRelative.module.css";

type PriceRelativeProps = {
  /** What the price is compared with, in words: "value", "average". */
  readonly reference: string;
  /** `(price - reference) / reference`; negative means the price is below its reference. */
  readonly fraction: number;
};

/**
 * "Price vs value: −5.9%" — the one way Stock Details states where the price sits against a
 * reference (UI-018).
 *
 * Always the price relative to the reference, always labelled, and deliberately neutral in colour:
 * a price below its intrinsic value and a price below its moving average mean different things to
 * different readers, so green and red would assert a judgement the page does not make.
 */
export function PriceRelative({ reference, fraction }: PriceRelativeProps) {
  return (
    <span
      className={styles.relative}
      data-direction={fraction >= 0 ? "above" : "below"}
    >
      Price vs {reference}: {formatSignedPercent(fraction)}
    </span>
  );
}
