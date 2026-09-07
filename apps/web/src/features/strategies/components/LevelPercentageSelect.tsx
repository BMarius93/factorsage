"use client";

import {
  BUY_LEVEL_PERCENTAGES,
  SELL_LEVEL_PERCENTAGES,
} from "@intrinsic/contracts";
import styles from "./StrategyBuilder.module.css";

type LevelPercentageSelectProps = {
  readonly levelKind: "BUY" | "SELL";
  readonly levelIndex: number;
  readonly percentage: number;
  readonly onChange: (percentage: number) => void;
};

/**
 * The level percentage, as a segmented control over the canonical options.
 *
 * A radio group rather than a dropdown: there are only three or four values, they are worth seeing
 * at a glance, and the same control works on a phone without a native picker. FINAL EXIT never
 * renders one — it has no percentage at all.
 */
export function LevelPercentageSelect({
  levelKind,
  levelIndex,
  percentage,
  onChange,
}: LevelPercentageSelectProps) {
  const options: readonly number[] =
    levelKind === "BUY" ? BUY_LEVEL_PERCENTAGES : SELL_LEVEL_PERCENTAGES;
  const name = `${levelKind}-${levelIndex}-percentage`;

  return (
    <div
      className={styles.segmented}
      role="radiogroup"
      aria-label={
        levelKind === "BUY"
          ? "Share of a full position to buy"
          : "Share of the remaining position to sell"
      }
      data-testid="level-percentage"
    >
      {options.map((option) => (
        <label
          key={option}
          className={styles.segment}
          data-selected={option === percentage ? "true" : undefined}
        >
          <input
            className={styles.segmentInput}
            type="radio"
            name={name}
            value={option}
            checked={option === percentage}
            onChange={() => onChange(option)}
          />
          {option}%
        </label>
      ))}
    </div>
  );
}
