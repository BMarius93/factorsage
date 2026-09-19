"use client";

import type { StockSearchResultResponse } from "@intrinsic/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRecentSecurities } from "../../recent/hooks/use-recent-securities";
import { popularStockSearches } from "../utils/popular-stocks";
import {
  SEARCH_UNAVAILABLE,
  useStockSearch,
  type StockSearchStatus,
} from "./use-stock-search";

/**
 * `single`: picking an option is the whole interaction (the topbar opens that stock).
 * `multi`: options toggle in and out of a selection held by the caller (a list's members).
 */
export type SecurityComboboxMode = "single" | "multi";

export type SecurityOption = {
  /** Stable per option: the catalog id when there is one, the ticker for a static shortcut. */
  readonly key: string;
  readonly symbol: string;
  readonly name: string;
  readonly exchange?: string;
  readonly logoUrl?: string;
  /**
   * The catalog row behind the option. Results and recents have one; the popular shortcuts are a
   * static frontend list and do not, which is why only `single` mode offers them.
   */
  readonly security?: StockSearchResultResponse;
};

/** One labelled run of options inside the single listbox. */
export type SecurityOptionSection = {
  readonly key: string;
  readonly label: string;
  readonly options: readonly SecurityOption[];
};

type UseSecurityComboboxOptions = {
  readonly mode: SecurityComboboxMode;
  /** Called with the chosen option; the caller decides what picking means, including clearing. */
  readonly onPick: (option: SecurityOption) => void;
  /** Backspace in an empty field (multi: remove the last chip). */
  readonly onBackspaceEmpty?: () => void;
  /**
   * A fixed id base for a surface that exists once per page (the topbar search). Its listbox id is
   * then the same on the server and the client whatever the surrounding tree renders, which is
   * what keeps `aria-controls` from ever hydrating differently (UI-054). Other surfaces use
   * `useId`.
   */
  readonly id?: string;
};

function fromSecurity(
  security: StockSearchResultResponse,
  withExchange: boolean,
): SecurityOption {
  return {
    key: security.id,
    symbol: security.symbol,
    name: security.name,
    ...(withExchange
      ? { exchange: security.exchangeName ?? security.exchangeCode }
      : {}),
    ...(security.logoUrl ? { logoUrl: security.logoUrl } : {}),
    security,
  };
}

/**
 * The product's one stock-search behaviour, for both the topbar and the list picker (UI-035).
 *
 * Owns everything the two surfaces must agree on: the debounced catalog search and its throttling
 * rules, what a blank field offers (recently viewed stocks, and in `single` mode the popular
 * shortcuts), the option sequence, arrow-key wrap, Enter, Escape, Backspace, the status copy, and
 * the combobox/listbox ARIA wiring. The surfaces own only their shell — a compact topbar field or
 * a chip field — and what picking an option means.
 */
export function useSecurityCombobox({
  mode,
  onPick,
  onBackspaceEmpty,
  id,
}: UseSecurityComboboxOptions) {
  const [query, setQueryState] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const labelId = `${baseId}-label`;

  const search = useStockSearch(query);
  const { securities: recent } = useRecentSecurities();
  const showingShortcuts = query.trim() === "";

  const sections: readonly SecurityOptionSection[] = useMemo(() => {
    if (!showingShortcuts) {
      return [
        {
          key: "results",
          label: "Results",
          options: search.results.map((result) => fromSecurity(result, true)),
        },
      ];
    }
    // Recents render exactly like the popular shortcuts they sit above — ticker and company name,
    // no exchange badge — so the only difference between the two sections is the heading.
    const recentOptions = recent.map((security) =>
      fromSecurity(security, false),
    );
    const popular =
      mode === "single"
        ? popularStockSearches(
            recentOptions.map((option) => option.symbol),
          ).map((shortcut) => ({
            key: shortcut.symbol,
            symbol: shortcut.symbol,
            name: shortcut.name,
          }))
        : [];
    return [
      // An empty set contributes no section at all, never a heading over nothing.
      ...(recentOptions.length > 0
        ? [{ key: "recent", label: "Recently Viewed", options: recentOptions }]
        : []),
      ...(popular.length > 0
        ? [{ key: "popular", label: "Popular Stocks", options: popular }]
        : []),
    ];
  }, [showingShortcuts, search.results, recent, mode]);

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

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setActiveIndex(-1);
    setOpen(true);
  }, []);

  const clear = useCallback(() => {
    setQueryState("");
    setActiveIndex(-1);
  }, []);

  const pick = useCallback(
    (option: SecurityOption) => {
      onPick(option);
    },
    [onPick],
  );

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

  const statusMessage = (() => {
    if (showingShortcuts) {
      return null;
    }
    if (search.status === "error") {
      return search.errorMessage ?? SEARCH_UNAVAILABLE;
    }
    if (search.status === "loading" && search.results.length === 0) {
      return "Searching…";
    }
    if (search.status === "ready" && search.results.length === 0) {
      return `No stocks match “${query.trim()}”.`;
    }
    return null;
  })();

  // What the user can see: an open list with something in it. A blank field with no shortcuts has
  // nothing to show, so it is not "expanded", and Escape there belongs to the surrounding dialog.
  const expanded = open && (options.length > 0 || statusMessage !== null);

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

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      // Never submits an enclosing form while a search is in play, and never turns free text into
      // a pick: it acts only when it resolves to a real option. With nothing highlighted it takes
      // the strongest match, which is what someone who typed a full ticker is asking for.
      if (expanded || query.trim() !== "") {
        event.preventDefault();
      }
      const option = options[highlighted >= 0 ? highlighted : 0];
      if (expanded && option) {
        pick(option);
      }
      return;
    }
    if (event.key === "Escape") {
      // Only an open list is closed here. A closed one lets Escape through, so the dialog around a
      // picker still closes on it.
      if (expanded) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }
    if (event.key === "Backspace" && query === "") {
      onBackspaceEmpty?.();
    }
  };

  const inputProps = {
    role: "combobox" as const,
    "aria-expanded": expanded,
    "aria-controls": listboxId,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant":
      open && highlighted >= 0
        ? `${listboxId}-option-${highlighted}`
        : undefined,
    autoComplete: "off",
    spellCheck: false,
    value: query,
    onChange: (event: { target: { value: string } }) =>
      setQuery(event.target.value),
    onFocus: () => setOpen(true),
    // Tabbing away closes the list, so an open dropdown never sits over the next control. A row
    // press keeps focus in the field (the panel prevents the mousedown), so it does not count.
    onBlur: (event: { relatedTarget: EventTarget | null }) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && containerRef.current?.contains(next))) {
        close();
      }
    },
    // Focus alone is not enough: after Escape the input is still focused, and clicking it again
    // must reopen the list rather than look inert.
    onClick: () => setOpen(true),
    onKeyDown,
  };

  return {
    mode,
    query,
    clear,
    open,
    expanded,
    setOpen,
    close,
    highlighted,
    sections,
    options,
    status: search.status as StockSearchStatus,
    statusMessage,
    retryable: search.status === "error" && search.retryable,
    retry: search.retry,
    pick,
    inputProps,
    inputRef,
    containerRef,
    listboxId,
    labelId,
  };
}

export type SecurityCombobox = ReturnType<typeof useSecurityCombobox>;
