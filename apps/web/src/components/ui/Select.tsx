"use client";

import type { SelectHTMLAttributes } from "react";
import styles from "./Select.module.css";

export type SelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

export type SelectOptionGroup = {
  readonly label: string;
  readonly options: readonly SelectOption[];
};

/**
 * The control scale a select sits on.
 *
 * - `default` (44 px): forms, dialogs and anything touch-first.
 * - `compact` (38 px): dense editor rows, such as a Strategy Builder predicate.
 * - `toolbar` (`--action-height`): beside row actions and segmented filters, so a toolbar reads
 *   as one line of controls.
 */
export type SelectDensity = "default" | "compact" | "toolbar";

type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "value" | "onChange" | "children" | "size" | "className"
> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Ungrouped options, rendered before any group. */
  readonly options?: readonly SelectOption[];
  readonly groups?: readonly SelectOptionGroup[];
  /**
   * The empty choice ("Select a strategy…"). Omitted when the control always holds a value. It stays
   * selectable, so a user can go back to "nothing chosen" exactly as they started.
   */
  readonly placeholder?: string;
  /** The placeholder is a prompt only and cannot be chosen back (a row that must name a metric). */
  readonly placeholderDisabled?: boolean;
  /**
   * What a value that is not among the options is shown as — a deleted strategy, a metric a level no
   * longer offers. Without it the browser would show the first option while state still holds the
   * old id, which is a silent lie about what will be submitted. Validation reports the value; this
   * only keeps it visible.
   */
  readonly unavailableLabel?: string;
  readonly density?: SelectDensity;
  readonly invalid?: boolean;
  readonly testId?: string;
};

/**
 * The product's one native select.
 *
 * Native, because a phone then gets its platform picker and a keyboard gets the behaviour it
 * already knows. Every select in the product renders through here, so heights, the chevron, focus,
 * the invalid border and the stale-value rule are decided once.
 */
export function Select({
  value,
  onValueChange,
  options = [],
  groups = [],
  placeholder,
  placeholderDisabled = false,
  unavailableLabel = "Unavailable",
  density = "default",
  invalid = false,
  testId,
  ...rest
}: SelectProps) {
  const known =
    value === "" ||
    options.some((option) => option.value === value) ||
    groups.some((group) =>
      group.options.some((option) => option.value === value),
    );

  return (
    <select
      {...rest}
      className={styles.select}
      data-density={density}
      value={value}
      aria-invalid={invalid || undefined}
      {...(testId ? { "data-testid": testId } : {})}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {placeholder !== undefined ? (
        <option value="" disabled={placeholderDisabled}>
          {placeholder}
        </option>
      ) : null}
      {known ? null : (
        <option value={value} data-unavailable="true">
          {unavailableLabel}
        </option>
      )}
      {options.map((option) => (
        <OptionRow key={option.value} option={option} />
      ))}
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <OptionRow key={option.value} option={option} />
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function OptionRow({ option }: { readonly option: SelectOption }) {
  return (
    <option value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  );
}
