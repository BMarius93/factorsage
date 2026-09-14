"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import styles from "./OverflowMenu.module.css";

export type OverflowMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
  /** `danger` tints the action once the popup is open. Use it only for destructive work. */
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
 * The product's one place for maintenance actions: Rename, Edit, Enable/Disable, Delete.
 *
 * Every collection row and every entity header uses this rather than exposing the same
 * actions as visible buttons. A destructive action is never a visible peer to the record
 * it destroys, and the trigger keeps one icon, one hit area, one accessible-label pattern
 * and one alignment across Lists, Strategies, Monitors and Backtests.
 *
 * **This is a disclosure, not an ARIA menu.** It is deliberately not `role="menu"`: that
 * role is a promise of menu keyboard semantics — arrow-key roving focus, Home/End, focus
 * moving into the menu on open — and this component does none of that. It reveals a small
 * stack of ordinary buttons, so it is built as the disclosure it actually is: a button that
 * owns `aria-expanded`, and real `<button>`s that take their natural place in the tab order.
 * Announcing a menu we do not implement is worse for a screen-reader user than announcing
 * nothing, because it sets up keys that will not work.
 *
 * Keyboard: Enter or Space on the trigger opens; Tab moves to the first enabled action and
 * on out of the last one, which closes it; Escape closes and returns focus to the trigger;
 * a pointer or focus move outside dismisses. If this ever needs true menu semantics, adopt
 * the full pattern — roles *and* key handling — rather than re-adding the roles alone.
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
        <div className={styles.menu} id={menuId}>
          {items.map((item) => (
            <Fragment key={item.label}>
              {item.separated ? (
                <div className={styles.separator} aria-hidden="true" />
              ) : null}
              <button
                type="button"
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
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
