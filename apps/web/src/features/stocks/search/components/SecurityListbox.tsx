"use client";

import { Fragment, type ReactNode } from "react";
import { StockIdentity } from "../../../../components/ui/StockIdentity";
import type {
  SecurityCombobox,
  SecurityOption,
} from "../hooks/use-security-combobox";
import styles from "./SecurityListbox.module.css";

type SecurityListboxProps = {
  readonly combobox: SecurityCombobox;
  /** Positions the panel for its surface; the panel's look is shared. */
  readonly className?: string;
  /** `multi` only: whether an option is in the caller's selection. */
  readonly isSelected?: (option: SecurityOption) => boolean;
  /** An option that is shown but cannot be picked, and the word that says why ("In list"). */
  readonly unavailableReason?: (option: SecurityOption) => string | null;
};

/**
 * The dropdown half of the stock combobox: one labelled listbox, its section headings, the rows and
 * the status line. Rendered by every stock search surface so they share one ARIA model:
 *
 * - `single`: `aria-selected` marks the highlighted option — the one Enter will open — as the
 *   APG single-select combobox pattern expects.
 * - `multi`: the listbox is `aria-multiselectable` and `aria-selected` means *chosen*; the
 *   highlight is carried by `aria-activedescendant` alone.
 */
export function SecurityListbox({
  combobox,
  className,
  isSelected,
  unavailableReason,
}: SecurityListboxProps) {
  const { sections, highlighted, listboxId, labelId, mode, statusMessage } =
    combobox;
  if (!combobox.expanded) {
    return null;
  }

  // Where each section starts in the flat option sequence, so a row's id and highlight state can be
  // derived without threading a mutable counter through the render.
  const sectionOffsets = sections.reduce<number[]>(
    (offsets, section) => {
      const previous = offsets[offsets.length - 1] ?? 0;
      return [...offsets, previous + section.options.length];
    },
    [0],
  );

  return (
    <div
      className={[styles.panel, className].filter(Boolean).join(" ")}
      // Keeps focus (and the mobile keyboard) on the input while a row is being clicked.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className={styles.panelHeader}>
        <span className={styles.groupLabel} id={labelId}>
          {sections[0]?.label ?? "Results"}
        </span>
        {combobox.status === "loading" ? (
          <span className={styles.loading} aria-hidden="true" />
        ) : null}
      </div>

      <ul
        className={styles.options}
        id={listboxId}
        role="listbox"
        aria-labelledby={labelId}
        {...(mode === "multi" ? { "aria-multiselectable": true } : {})}
      >
        {sections.map((section, sectionIndex) => (
          <Fragment key={section.key}>
            {sectionIndex > 0 ? (
              <li className={styles.sectionHeader} role="presentation">
                <span className={styles.groupLabel}>{section.label}</span>
              </li>
            ) : null}
            {section.options.map((option, position) => {
              const index = (sectionOffsets[sectionIndex] ?? 0) + position;
              const chosen = isSelected?.(option) ?? false;
              const reason = unavailableReason?.(option) ?? null;
              const trailing: ReactNode =
                reason ?? (chosen ? "Selected" : (option.exchange ?? null));
              return (
                <li
                  key={option.key}
                  id={`${listboxId}-option-${index}`}
                  className={styles.option}
                  role="option"
                  aria-selected={
                    mode === "multi" ? chosen : index === highlighted
                  }
                  {...(reason ? { "aria-disabled": true } : {})}
                  data-highlighted={index === highlighted}
                  data-muted={reason !== null}
                  onClick={() => combobox.pick(option)}
                >
                  {/* The shared identity treatment, so a stock looks the same here as it does in a
                      list, a monitor or a trade log. */}
                  <StockIdentity
                    symbol={option.symbol}
                    name={option.name}
                    {...(option.logoUrl ? { logoUrl: option.logoUrl } : {})}
                    size="sm"
                  />
                  {trailing ? (
                    <span
                      className={styles.trailing}
                      data-state={
                        reason ? "unavailable" : chosen ? "chosen" : undefined
                      }
                    >
                      {trailing}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </Fragment>
        ))}
      </ul>

      {statusMessage ? (
        <p className={styles.message} role="status">
          {statusMessage}
          {/* Offered only when trying again can work: never inside a throttling wait (UI-036). */}
          {combobox.retryable ? (
            <button
              type="button"
              className={styles.retry}
              onClick={() => combobox.retry()}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
