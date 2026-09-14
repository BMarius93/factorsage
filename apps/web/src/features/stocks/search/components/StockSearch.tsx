"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { canNavigate } from "../../../../components/layout/unsaved-changes";
import { useRecentSecurities } from "../../recent/hooks/use-recent-securities";
import { useStockSearch } from "../hooks/use-stock-search";
import { popularStockSearches } from "../utils/popular-stocks";
import { stockDetailsHref } from "../utils/stock-routes";
import { ClearIcon, SearchIcon } from "./search-icons";
import { StockIdentity } from "../../../../components/ui/StockIdentity";
import styles from "./StockSearch.module.css";

type SearchOption = {
  readonly symbol: string;
  readonly name: string;
  readonly exchange?: string;
};

/** One labelled run of options inside the single listbox. */
type SearchSection = {
  readonly key: string;
  readonly label: string;
  readonly options: readonly SearchOption[];
};

/**
 * Global stock search for the application topbar.
 *
 * A combobox over one of two option sets: shortcuts while the query is blank — the stocks this
 * user viewed most recently, then the popular ones — and debounced results from the persisted
 * securities universe once it is not. Every set shares the same row shape and the same selection
 * paths (mouse, touch, keyboard) so switching between them is not a mode change for the user.
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
  const { securities: recent } = useRecentSecurities();
  const showingShortcuts = query.trim() === "";

  const sections: readonly SearchSection[] = useMemo(() => {
    if (!showingShortcuts) {
      return [
        {
          key: "results",
          label: "Results",
          options: results.map((result) => ({
            symbol: result.symbol,
            name: result.name,
            exchange: result.exchangeName ?? result.exchangeCode,
          })),
        },
      ];
    }
    // Recents render exactly like the popular shortcuts they sit above — ticker and company name,
    // no exchange badge — so the only difference between the two sections is the heading.
    const recentOptions = recent.map((security) => ({
      symbol: security.symbol,
      name: security.name,
    }));
    const popular = popularStockSearches(
      recentOptions.map((option) => option.symbol),
    );
    return [
      // An empty recent set contributes no section at all, so a user with no history sees exactly
      // the dropdown that existed before this feature.
      ...(recentOptions.length > 0
        ? [{ key: "recent", label: "Recent Searches", options: recentOptions }]
        : []),
      ...(popular.length > 0
        ? [{ key: "popular", label: "Popular Searches", options: popular }]
        : []),
    ];
  }, [showingShortcuts, results, recent]);

  // Keyboard navigation and `aria-activedescendant` address one flat sequence; the headings are
  // presentation and never land on the highlight.
  const options = useMemo(
    () => sections.flatMap((section) => section.options),
    [sections],
  );

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
      // Search sits in the shared topbar, so it leaves a page exactly like a navigation link does:
      // a page holding unsaved work gets to ask first, and staying leaves the search as it was.
      if (!canNavigate()) {
        return;
      }
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
    if (showingShortcuts) {
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
              {sections[0]?.label ?? "Results"}
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
            {sections.map((section, sectionIndex) => (
              <Fragment key={section.key}>
                {sectionIndex > 0 ? (
                  <li className={styles.sectionHeader} role="presentation">
                    <span className={styles.groupLabel}>{section.label}</span>
                  </li>
                ) : null}
                {section.options.map((option, position) => {
                  const index = (sectionOffsets[sectionIndex] ?? 0) + position;
                  return (
                    <li
                      key={option.symbol}
                      id={`${listboxId}-option-${index}`}
                      className={styles.option}
                      role="option"
                      aria-selected={index === highlighted}
                      data-highlighted={index === highlighted}
                      onClick={() => select(option)}
                    >
                      {/* The shared identity treatment, so a stock looks the same here as it
                          does in a list, a monitor or a trade log. The catalog's search
                          projection carries no logo, so this renders the ticker monogram. */}
                      <StockIdentity
                        symbol={option.symbol}
                        name={option.name}
                        size="sm"
                      />
                      {option.exchange ? (
                        <span className={styles.exchange}>
                          {option.exchange}
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
