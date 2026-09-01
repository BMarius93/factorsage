"use client";

import type { StockListSecurityResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useStockSearch } from "../../stocks/search/hooks/use-stock-search";
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
 * Shares `useStockSearch` (debounce, sequence guarding, catalog-only results) with the global
 * topbar search so the product keeps exactly one search behavior. Only a real catalog result can
 * ever be selected: Enter picks the highlighted row and free text is never turned into a chip.
 * Picking an already-selected row unselects it, so duplicates are impossible by construction.
 */
export function SecurityMultiSelect({
  selected,
  onChange,
  excludedIds,
  inputLabel = "Search stocks to add",
  placeholder = "Search stocks…",
}: SecurityMultiSelectProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = `${useId()}-listbox`;

  const { status, results, retry } = useStockSearch(query);
  const highlighted = activeIndex < results.length ? activeIndex : -1;
  const selectedIds = new Set(selected.map((entry) => entry.id));

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  const toggle = (result: (typeof results)[number]) => {
    if (excludedIds?.has(result.id)) {
      return;
    }
    if (selectedIds.has(result.id)) {
      onChange(selected.filter((entry) => entry.id !== result.id));
      return;
    }
    onChange([
      ...selected,
      {
        id: result.id,
        symbol: result.symbol,
        name: result.name,
        exchangeCode: result.exchangeCode,
        ...(result.exchangeName ? { exchangeName: result.exchangeName } : {}),
      },
    ]);
    // Ready for the next search immediately; the caret stays in the field.
    setQuery("");
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const removeChip = (id: string) => {
    onChange(selected.filter((entry) => entry.id !== id));
    inputRef.current?.focus();
  };

  const move = (delta: number) => {
    if (results.length === 0) {
      return;
    }
    setOpen(true);
    setActiveIndex((current) => {
      const next =
        current < 0 ? (delta > 0 ? 0 : results.length - 1) : current + delta;
      return (next + results.length) % results.length;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      // Enter never submits an enclosing form while a search is in play, and never creates a
      // free-text chip: it only acts when it resolves to a real catalog row.
      if (open || query.trim() !== "") {
        event.preventDefault();
      }
      const option = results[highlighted >= 0 ? highlighted : 0];
      if (open && option) {
        toggle(option);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Backspace" && query === "" && selected.length > 0) {
      const last = selected[selected.length - 1];
      if (last) {
        removeChip(last.id);
      }
    }
  };

  const statusMessage = (() => {
    if (query.trim() === "") {
      return null;
    }
    if (status === "error") {
      return "Search is unavailable right now.";
    }
    if (status === "loading" && results.length === 0) {
      return "Searching…";
    }
    if (status === "ready" && results.length === 0) {
      return `No stocks match “${query.trim()}”.`;
    }
    return null;
  })();

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
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && (results.length > 0 || statusMessage) ? (
        <div
          className={styles.panel}
          // Keeps focus (and the mobile keyboard) on the input while a row is being clicked.
          onMouseDown={(event) => event.preventDefault()}
        >
          <ul className={styles.options} id={listboxId} role="listbox">
            {results.map((result, index) => {
              const isSelected = selectedIds.has(result.id);
              const isExcluded = excludedIds?.has(result.id) ?? false;
              return (
                <li
                  key={result.id}
                  id={`${listboxId}-option-${index}`}
                  className={styles.option}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isExcluded}
                  data-highlighted={index === highlighted}
                  data-muted={isExcluded}
                  onClick={() => toggle(result)}
                >
                  <span className={styles.optionSymbol}>{result.symbol}</span>
                  <span className={styles.optionName}>{result.name}</span>
                  {isExcluded ? (
                    <span className={styles.optionState}>In list</span>
                  ) : isSelected ? (
                    <span className={styles.optionState}>Selected</span>
                  ) : (
                    <span className={styles.optionExchange}>
                      {result.exchangeName ?? result.exchangeCode}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {statusMessage ? (
            <p className={styles.message} role="status">
              {statusMessage}
              {status === "error" ? (
                <button
                  type="button"
                  className={styles.retry}
                  onClick={() => retry()}
                >
                  Try again
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
