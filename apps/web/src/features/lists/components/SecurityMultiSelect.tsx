"use client";

import type { StockListSecurityResponse } from "@intrinsic/contracts";
import { SecurityListbox } from "../../stocks/search/components/SecurityListbox";
import { useSecurityCombobox } from "../../stocks/search/hooks/use-security-combobox";
import styles from "./SecurityMultiSelect.module.css";

type SecurityMultiSelectProps = {
  /** Securities picked so far, rendered as removable chips. */
  readonly selected: readonly StockListSecurityResponse[];
  readonly onChange: (next: StockListSecurityResponse[]) => void;
  /** Ids that cannot be picked again (already list members); shown but annotated. */
  readonly excludedIds?: ReadonlySet<string>;
  readonly inputLabel?: string;
  readonly placeholder?: string;
};

/**
 * Multi-select combobox over the catalog-backed stock search, for building list membership.
 *
 * The `multi` mode of the shared stock combobox (`useSecurityCombobox`), so it searches, throttles,
 * offers recently viewed stocks on a blank field, and answers the keyboard exactly like the topbar
 * search. Only a real catalog row can ever be selected: Enter picks the highlighted row and free
 * text is never turned into a chip. Picking an already-selected row unselects it, so duplicates are
 * impossible by construction.
 */
export function SecurityMultiSelect({
  selected,
  onChange,
  excludedIds,
  inputLabel = "Search stocks to add",
  placeholder = "Search stocks…",
}: SecurityMultiSelectProps) {
  const selectedIds = new Set(selected.map((entry) => entry.id));

  const combobox = useSecurityCombobox({
    mode: "multi",
    onPick: (option) => {
      const security = option.security;
      if (!security || excludedIds?.has(security.id)) {
        return;
      }
      if (selectedIds.has(security.id)) {
        onChange(selected.filter((entry) => entry.id !== security.id));
      } else {
        onChange([
          ...selected,
          {
            id: security.id,
            symbol: security.symbol,
            name: security.name,
            exchangeCode: security.exchangeCode,
            ...(security.exchangeName
              ? { exchangeName: security.exchangeName }
              : {}),
            // Carried onto the selection so a member added in this session renders the same mark
            // the saved list will, without waiting for a reload to fetch it back.
            ...(security.logoUrl ? { logoUrl: security.logoUrl } : {}),
          },
        ]);
      }
      // Ready for the next search immediately: the caret stays in the field, and the list closes
      // until the next keystroke, so it never covers the dialog's own buttons after a pick.
      combobox.clear();
      combobox.close();
      combobox.inputRef.current?.focus();
    },
    onBackspaceEmpty: () => {
      const last = selected[selected.length - 1];
      if (last) {
        removeChip(last.id);
      }
    },
  });
  const { inputRef, containerRef } = combobox;

  const removeChip = (id: string) => {
    onChange(selected.filter((entry) => entry.id !== id));
    inputRef.current?.focus();
  };

  return (
    <div className={styles.multiselect} ref={containerRef}>
      <div
        className={styles.field}
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((entry) => (
          <span key={entry.id} className={styles.chip}>
            <span className={styles.chipSymbol}>{entry.symbol}</span>
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Remove ${entry.symbol}`}
              onClick={() => removeChip(entry.id)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder={selected.length === 0 ? placeholder : "Add another…"}
          aria-label={inputLabel}
          {...combobox.inputProps}
        />
      </div>

      <SecurityListbox
        combobox={combobox}
        isSelected={(option) =>
          option.security !== undefined && selectedIds.has(option.security.id)
        }
        unavailableReason={(option) =>
          option.security !== undefined && excludedIds?.has(option.security.id)
            ? "In list"
            : null
        }
      />
    </div>
  );
}
