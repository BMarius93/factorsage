"use client";

import { useCallback, useRef, type RefObject } from "react";

type ScrollAnchorOptions = {
  /** The rows the reader's place is measured by, e.g. `[data-event-id]`. */
  readonly rowSelector: string;
  /** The attribute on each row that identifies it across renders. */
  readonly idAttribute: string;
  /**
   * The bottom edge of whatever sticks over the top of the list (a topbar, a sticky heading), in
   * viewport pixels: rows hidden beneath it are not what the reader is looking at.
   */
  readonly insetTop: () => number;
};

/**
 * Keeps the row a reader is looking at still while rows are added above it.
 *
 * `capture` notes the first row under the sticky inset and where it sits; call it while the page
 * still shows the old list. `restore`, from a layout effect after the new list is committed, scrolls
 * the document by however far that row moved. When the first row of the list is itself in view the
 * reader is at the top, nothing is held, and new rows push down into sight as they should.
 *
 * Done by hand rather than left to the browser's own scroll anchoring, which Safari does not
 * implement: the list sets `overflow-anchor: none` so the two never both correct one change.
 */
export function useScrollAnchor(
  rootRef: RefObject<HTMLElement | null>,
  { rowSelector, idAttribute, insetTop }: ScrollAnchorOptions,
) {
  const captured = useRef<{ id: string; top: number } | null>(null);

  const capture = useCallback(() => {
    captured.current = null;
    const root = rootRef.current;
    if (!root) return;
    const inset = Math.max(0, insetTop());
    const rows = root.querySelectorAll<HTMLElement>(rowSelector);
    const first = rows[0];
    if (!first || first.getBoundingClientRect().top >= inset) return;
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      const id = row.getAttribute(idAttribute);
      if (box.bottom > inset && id) {
        captured.current = { id, top: box.top };
        return;
      }
    }
  }, [rootRef, rowSelector, idAttribute, insetTop]);

  const restore = useCallback(() => {
    const anchor = captured.current;
    captured.current = null;
    const root = rootRef.current;
    if (!anchor || !root) return;
    const row = [...root.querySelectorAll<HTMLElement>(rowSelector)].find(
      (candidate) => candidate.getAttribute(idAttribute) === anchor.id,
    );
    if (!row) return;
    const moved = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) >= 1) {
      window.scrollBy(0, moved);
    }
  }, [rootRef, rowSelector, idAttribute]);

  return { capture, restore };
}
