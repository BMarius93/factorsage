"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./OverflowMenu.module.css";

export type OverflowMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
  /** `danger` tints the item once the menu is open. Use it only for destructive work. */
  readonly tone?: "default" | "danger";
  readonly disabled?: boolean;
  /** Draws a divider above this item, separating maintenance from destruction. */
  readonly separated?: boolean;
  readonly testId?: string;
};

type OverflowMenuProps = {
  /**
   * What this menu acts on, e.g. the list's name. Becomes the trigger's accessible name
   * ("More actions for Dow Jones List"), because "More actions" repeated down a column
   * tells a screen-reader user nothing about which row they are on.
   */
  readonly label: string;
  readonly items: readonly OverflowMenuItem[];
  readonly testId?: string;
};

/**
 * The product's one maintenance-action menu: Rename, Edit, Enable/Disable, Delete.
 *
 * Every collection row and every entity header uses this rather than exposing the same
 * actions as visible buttons. A destructive action is never a visible peer to the record
 * it destroys, and the trigger keeps one icon, one hit area, one accessible-label pattern
 * and one alignment across Lists, Strategies, Monitors and Backtests.
 *
 * Keyboard: the trigger is a normal button; Escape closes and returns focus to it, and a
 * click or focus move outside dismisses. Items are real buttons, so they take tab stops in
 * visible order.
 */
export function OverflowMenu({ label, items, testId }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Deliberately no scroll-to-close: the menu is absolutely positioned against its own
    // trigger, so it travels with the row rather than being stranded mid-page. Closing on
    // scroll also fought anything that scrolls an item into view before clicking it.
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className={styles.root}
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${label}`}
        onClick={() => setOpen((value) => !value)}
        {...(testId ? { "data-testid": testId } : {})}
      >
        <span className={styles.glyph} aria-hidden="true">
          …
        </span>
      </button>
      {open ? (
        <div className={styles.menu} id={menuId} role="menu">
          {items.map((item) => (
            <div key={item.label} role="none">
              {item.separated ? (
                <div className={styles.separator} role="none" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                data-tone={item.tone === "danger" ? "danger" : undefined}
                disabled={item.disabled}
                {...(item.testId ? { "data-testid": item.testId } : {})}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
