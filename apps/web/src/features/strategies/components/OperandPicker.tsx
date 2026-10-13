"use client";

import { useId, useState } from "react";
import { PickerPopover } from "./PickerPopover";
import styles from "./OperandPicker.module.css";

export type OperandPickerOption = {
  /** The option's identity: a series id, exactly as the catalog spells it. */
  readonly key: string;
  readonly label: string;
};

export type OperandPickerCategory = {
  readonly id: string;
  readonly label: string;
  readonly options: readonly OperandPickerOption[];
};

type OperandPickerProps = {
  /** Names the trigger and the popover: `Value`. */
  readonly label: string;
  /** The trigger's test id; the popover, its categories and its options derive theirs from it. */
  readonly testId: string;
  /** What the popover offers, already partitioned and ordered by the registry or the catalog. */
  readonly categories: readonly OperandPickerCategory[];
  /** The chosen option's key, or `""` when nothing is chosen yet. */
  readonly selectedKey: string;
  /**
   * The category the current choice belongs to. Passed rather than searched for, so a choice the
   * popover no longer offers still reopens on its own category when that category is offered.
   */
  readonly selectedCategoryId?: string;
  /** What the trigger reads: the choice's label, or a prompt or an unavailable label. */
  readonly display: string;
  /** `display` is a prompt rather than a choice, and reads as one. */
  readonly placeholder?: boolean;
  /**
   * Which edge of the fields the popover lines up with: the start for the first operand, the end for
   * the last, so each opens beneath the control that opened it.
   */
  readonly align?: "start" | "end";
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onSelect: (key: string) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
};

/**
 * The height the popover would need to show its longest category without scrolling: its height now,
 * plus the option rows the longest category has beyond the shown one. Read from the rendered grid —
 * its columns, one option's height and the row gap — so the stylesheet stays the only place the
 * layout is decided.
 */
function tallestHeight(panel: HTMLElement, mostOptions: number): number {
  const grid = panel.querySelector<HTMLElement>("[data-option-grid]");
  const option = grid?.firstElementChild;
  if (!grid || !(option instanceof HTMLElement)) {
    return panel.offsetHeight;
  }
  const style = getComputedStyle(grid);
  const columns = Math.max(
    1,
    style.gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  const pitch = option.offsetHeight + (Number.parseFloat(style.rowGap) || 0);
  const shownRows = Math.ceil(grid.children.length / columns);
  const mostRows = Math.ceil(mostOptions / columns);
  return panel.offsetHeight + Math.max(0, mostRows - shownRows) * pitch;
}

/**
 * One series operand of a rule, chosen in two steps inside one popover: a category, then an option
 * of it. It is the picker a series-valued **Value** is chosen with; a rule's Metric has a picker of
 * its own (`MetricPicker`), drawn in the same shell.
 *
 * Every category is visible at once as a grid of tiles; the active one's options sit below in a
 * two-column grid, and only that options area scrolls. Browsing a category changes nothing — choosing
 * an option is the one edit, and it closes the popover. Reopening starts on the category of the
 * current choice with that choice marked, so the popover always opens where the rule already is.
 *
 * The component keeps no catalog: categories, their order, their options and every label are handed
 * in by the caller, which reads them from the series catalog.
 *
 * Above its trigger the popover is held at the height its longest category needs, so a longer
 * category never moves the category tiles away from the pointer that is browsing them.
 */
export function OperandPicker({
  label,
  testId,
  categories,
  selectedKey,
  selectedCategoryId,
  display,
  placeholder = false,
  align = "start",
  invalid,
  describedBy,
  onSelect,
  onFocus,
  onBlur,
}: OperandPickerProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const optionsLabelId = `${useId()}-options`;

  const homeCategoryId =
    (selectedCategoryId !== undefined &&
    categories.some((category) => category.id === selectedCategoryId)
      ? selectedCategoryId
      : categories.find((category) =>
          category.options.some((option) => option.key === selectedKey),
        )?.id) ?? categories[0]?.id;
  const active =
    categories.find((category) => category.id === activeId) ??
    categories.find((category) => category.id === homeCategoryId) ??
    categories[0];
  const mostOptions = Math.max(
    0,
    ...categories.map((category) => category.options.length),
  );

  return (
    <PickerPopover
      label={label}
      testId={testId}
      value={selectedKey}
      display={display}
      placeholder={placeholder}
      align={align}
      invalid={invalid}
      {...(describedBy ? { describedBy } : {})}
      sizing={(panel) => tallestHeight(panel, mostOptions)}
      onOpen={() => setActiveId(homeCategoryId ?? null)}
      // Focus goes to the current choice when it is on show, otherwise to the category being shown.
      initialFocus={(panel) =>
        panel.querySelector<HTMLElement>(
          '[data-option][aria-pressed="true"]',
        ) ??
        panel.querySelector<HTMLElement>('[data-category][aria-pressed="true"]')
      }
      {...(onFocus ? { onFocus } : {})}
      {...(onBlur ? { onBlur } : {})}
    >
      {({ close }) =>
        active ? (
          <>
            <div
              className={styles.categories}
              role="group"
              aria-label="Categories"
            >
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={styles.category}
                  data-category=""
                  data-testid={`${testId}-category`}
                  data-value={category.id}
                  // Marks where the current choice lives while another category is being browsed.
                  data-current={
                    category.id === homeCategoryId && selectedKey !== ""
                      ? "true"
                      : undefined
                  }
                  aria-pressed={category.id === active.id}
                  onClick={() => setActiveId(category.id)}
                >
                  {category.label}
                </button>
              ))}
            </div>

            <div className={styles.options} data-testid={`${testId}-options`}>
              <p className={styles.optionsLabel} id={optionsLabelId}>
                {active.label}
              </p>
              <ul
                className={styles.optionGrid}
                data-option-grid=""
                data-category={active.id}
                aria-labelledby={optionsLabelId}
              >
                {active.options.map((option) => (
                  <li key={option.key}>
                    <button
                      type="button"
                      className={styles.option}
                      data-option=""
                      data-testid={`${testId}-option`}
                      data-value={option.key}
                      aria-pressed={option.key === selectedKey}
                      title={option.label}
                      onClick={() => {
                        if (option.key !== selectedKey) {
                          onSelect(option.key);
                        }
                        close(true);
                      }}
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null
      }
    </PickerPopover>
  );
}
