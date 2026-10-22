"use client";

import styles from "./SegmentedControl.module.css";

export type SegmentedOption<TValue extends string> = {
  readonly value: TValue;
  readonly label: string;
  /** How many records this option would show, when that is known. */
  readonly count?: number;
};

type SegmentedControlProps<TValue extends string> = {
  /** The group's accessible name, e.g. "Filter by state". */
  readonly label: string;
  readonly options: readonly SegmentedOption<TValue>[];
  readonly value: TValue;
  readonly onChange: (next: TValue) => void;
  readonly testId?: string;
  /**
   * Share one row equally between the options instead of wrapping them. For a short, fixed set
   * that must read as one control in a narrow space — Market watch's six periods.
   */
  readonly fill?: boolean;
  /**
   * The row-action height and a tighter gap, for a control that sits inside a dense surface rather
   * than above a page's content — Market watch's period selector. Desktop-only surfaces only: it
   * is below a comfortable touch target.
   */
  readonly compact?: boolean;
  /**
   * An option that has just become selected without the reader's hand — Market watch's rotation.
   * It carries `data-highlight="true"` for the consumer to draw its own brief acknowledgement;
   * this component draws nothing for it.
   */
  readonly highlight?: TValue | null;
};

/**
 * One row of mutually exclusive choices that narrow what the page shows (cleanup plan §3.5).
 *
 * Built as `aria-pressed` toggle buttons in a labelled group, which is what a view filter is: each
 * option shows the count it would reveal, so a reader can see there is nothing behind a view
 * before opening it. The Dashboard's state filter and the Monitor page's status filter use this
 * one component, so the two cannot drift into two looks for one idea.
 */
export function SegmentedControl<TValue extends string>({
  label,
  options,
  value,
  onChange,
  testId,
  fill,
  compact,
  highlight,
}: SegmentedControlProps<TValue>) {
  return (
    <div
      className={styles.group}
      data-fill={fill ? "true" : undefined}
      data-compact={compact ? "true" : undefined}
      role="group"
      aria-label={label}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.option}
          data-active={value === option.value ? "true" : undefined}
          aria-pressed={value === option.value}
          data-value={option.value}
          data-highlight={highlight === option.value ? "true" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count === undefined ? null : (
            <span className={styles.count}>{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
