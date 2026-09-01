"use client";

import { useId } from "react";
import { PRICE_RANGE_KEYS, type PriceRangeKey } from "../utils/price-ranges";
import styles from "./StockRangeSelector.module.css";

type StockRangeSelectorProps = {
  readonly value: PriceRangeKey;
  readonly onChange: (range: PriceRangeKey) => void;
};

/**
 * Compact chart-range selector. Real radio inputs give the group native keyboard behaviour
 * (arrow keys, one tab stop) and an explicit selected state beyond color alone.
 */
export function StockRangeSelector({ value, onChange }: StockRangeSelectorProps) {
  const name = useId();

  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>Chart range</legend>
      {PRICE_RANGE_KEYS.map((range) => (
        <label key={range} className={styles.option}>
          <input
            type="radio"
            className={styles.input}
            name={name}
            value={range}
            checked={value === range}
            onChange={() => onChange(range)}
          />
          <span className={styles.pill}>{range}</span>
        </label>
      ))}
    </fieldset>
  );
}
