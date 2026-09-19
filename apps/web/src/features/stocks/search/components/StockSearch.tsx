"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { canNavigate } from "../../../../components/layout/unsaved-changes";
import { useSecurityCombobox } from "../hooks/use-security-combobox";
import { stockDetailsHref } from "../utils/stock-routes";
import { ClearIcon, SearchIcon } from "./search-icons";
import { SecurityListbox } from "./SecurityListbox";
import styles from "./StockSearch.module.css";

/**
 * Global stock search for the application topbar.
 *
 * The `single` mode of the shared stock combobox (`useSecurityCombobox`): shortcuts while the
 * query is blank — the stocks this user viewed most recently, then the popular ones — and
 * debounced catalog results once it is not. Picking any row opens that stock. Below 380px the
 * field collapses behind an icon trigger and expands over the topbar.
 */
export function StockSearch() {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  const combobox = useSecurityCombobox({
    mode: "single",
    id: "topbar-stock-search",
    onPick: (option) => {
      // Search sits in the shared topbar, so it leaves a page exactly like a navigation link does:
      // a page holding unsaved work gets to ask first, and staying leaves the search as it was.
      if (!canNavigate()) {
        return;
      }
      combobox.clear();
      collapse();
      combobox.inputRef.current?.blur();
      router.push(stockDetailsHref(option.symbol));
    },
  });
  const { close, inputRef, containerRef, query } = combobox;

  const collapse = useCallback(() => {
    close();
    setExpanded(false);
  }, [close]);

  // The compact surface closes on an outside press even when its list is already closed.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [containerRef, expanded]);

  // The compact surface is only useful with the caret already in it.
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    }
  }, [expanded, inputRef]);

  return (
    <div className={styles.search} data-expanded={expanded} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-label="Search stocks"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(true);
          combobox.setOpen(true);
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
          {...combobox.inputProps}
        />
        {query === "" ? null : (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            onClick={() => {
              combobox.clear();
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

      <SecurityListbox combobox={combobox} className={styles.panel} />
    </div>
  );
}
