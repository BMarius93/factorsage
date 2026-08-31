"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useStockSearch } from "../hooks/use-stock-search";
import { POPULAR_STOCK_SEARCHES } from "../utils/popular-stocks";
import { stockDetailsHref } from "../utils/stock-routes";
import { ClearIcon, SearchIcon } from "./search-icons";
import styles from "./StockSearch.module.css";

type SearchOption = {
  readonly symbol: string;
  readonly name: string;
  readonly exchange?: string;
};

/**
 * Global stock search for the application topbar.
 *
 * A combobox over one of two option sets: static popular shortcuts while the query is blank, and
 * debounced results from the persisted securities universe once it is not. Both sets share the
 * same row shape and the same selection paths (mouse, touch, keyboard) so switching between them
 * is not a mode change for the user.
 */
export function StockSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = `${useId()}-listbox`;
  const labelId = `${useId()}-label`;

  const { status, results, retry } = useStockSearch(query);
  const showingPopular = query.trim() === "";
  const options: readonly SearchOption[] = showingPopular
    ? POPULAR_STOCK_SEARCHES
    : results.map((result) => ({
        symbol: result.symbol,
        name: result.name,
        exchange: result.exchangeName ?? result.exchangeCode,
      }));

  // The option list changes underneath the highlight as results arrive, so a stale index must not
  // point past the end of the current list.
  const highlighted = activeIndex < options.length ? activeIndex : -1;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const collapse = useCallback(() => {
    close();
    setExpanded(false);
  }, [close]);

  const select = useCallback(
    (option: SearchOption) => {
      setQuery("");
      collapse();
      inputRef.current?.blur();
      router.push(stockDetailsHref(option.symbol));
    },
    [collapse, router],
  );

  useEffect(() => {
    if (!open && !expanded) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      collapse();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [collapse, expanded, open]);

  // The compact surface is only useful with the caret already in it.
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    }
  }, [expanded]);

  const move = (delta: number) => {
    if (options.length === 0) {
      return;
    }
    setOpen(true);
    setActiveIndex((current) => {
      const next =
        current < 0 ? (delta > 0 ? 0 : options.length - 1) : current + delta;
      return (next + options.length) % options.length;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      // With nothing highlighted, Enter takes the strongest match, which is what a user who typed
      // a full ticker and pressed Enter is asking for.
      const option = options[highlighted >= 0 ? highlighted : 0];
      if (open && option) {
        event.preventDefault();
        select(option);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const statusMessage = (() => {
    if (showingPopular) {
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
    <div className={styles.search} data-expanded={expanded} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-label="Search stocks"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(true);
          setOpen(true);
        }}
      >
        <SearchIcon className={styles.triggerIcon} />
      </button>

      <div className={styles.field}>
        <SearchIcon className={styles.fieldIcon} />
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="Search AAPL, Microsoft, NVIDIA…"
          aria-label="Search stocks"
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
          // Focus alone is not enough: after Escape the input is still focused, and clicking it
          // again must reopen the dropdown rather than look inert.
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query === "" ? null : (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setActiveIndex(-1);
              inputRef.current?.focus();
            }}
          >
            <ClearIcon className={styles.clearIcon} />
          </button>
        )}
        <button type="button" className={styles.cancel} onClick={collapse}>
          Cancel
        </button>
      </div>

      {open ? (
        <div
          className={styles.panel}
          // Keeps focus (and the mobile keyboard) on the input while a row is being clicked.
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className={styles.panelHeader}>
            <span className={styles.groupLabel} id={labelId}>
              {showingPopular ? "Popular Searches" : "Results"}
            </span>
            {status === "loading" ? (
              <span className={styles.loading} aria-hidden="true" />
            ) : null}
          </div>

          <ul
            className={styles.options}
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
          >
            {options.map((option, index) => (
              <li
                key={option.symbol}
                id={`${listboxId}-option-${index}`}
                className={styles.option}
                role="option"
                aria-selected={index === highlighted}
                data-highlighted={index === highlighted}
                onClick={() => select(option)}
              >
                <span className={styles.symbol}>{option.symbol}</span>
                <span className={styles.name}>{option.name}</span>
                {option.exchange ? (
                  <span className={styles.exchange}>{option.exchange}</span>
                ) : null}
              </li>
            ))}
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
