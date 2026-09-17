"use client";

import styles from "./SelectControl.module.css";

export type SelectControlOption = {
  readonly value: string;
  readonly label: string;
};

type SelectControlProps = {
  /** Visible label beside the control; also its accessible name. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectControlOption[];
  /** Must be unique on the page — it is what ties the label to the control. */
  readonly id: string;
  readonly testId?: string;
};

/**
 * The product's one labelled dropdown: a native `select` with its label beside it.
 *
 * A native control rather than a custom listbox, because a phone then gets its platform picker and
 * a keyboard gets the behaviour it already knows. It is deliberately a *different shape* from the
 * segmented pill filters: when two filters on one toolbar look the same, they read as two competing
 * tab systems instead of one state and one refinement of it.
 */
export function SelectControl({
  label,
  value,
  onChange,
  options,
  id,
  testId,
}: SelectControlProps) {
  return (
    <div className={styles.control}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(testId ? { "data-testid": testId } : {})}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
