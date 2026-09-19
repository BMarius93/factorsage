"use client";

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
 *
 * **Placement is collision-aware** (UI-006). The popup right-aligns under its trigger, which is
 * right for a trigger at the end of a row; where that would cross the left edge of the viewport
 * it left-aligns instead, and where it would drop under the bottom edge — or under the phone's
 * fixed bottom navigation — it opens upwards. Placement is measured before paint, so the popup
 * never flashes in the wrong place.
 */
export function OverflowMenu({ label, items, testId }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement>(DEFAULT_PLACEMENT);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(DEFAULT_PLACEMENT);
      return;
    }
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (trigger && menu) {
      setPlacement(placeMenu(trigger, menu, viewportBounds()));
    }
  }, [open]);

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
      data-overflow-menu=""
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
        <div
          className={styles.menu}
          id={menuId}
          ref={menuRef}
          data-align={placement.align}
          data-side={placement.side}
        >
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

export type MenuPlacement = {
  /** `end`: the popup's right edge meets the trigger's. `start`: its left edge does. */
  readonly align: "end" | "start";
  readonly side: "below" | "above";
};

const DEFAULT_PLACEMENT: MenuPlacement = { align: "end", side: "below" };

/** Space kept between a popup and the edge it would otherwise touch. */
const EDGE_MARGIN = 8;
/** The popup's distance from its trigger, matching the stylesheet. */
const TRIGGER_GAP = 6;

type Box = Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width" | "height">;

type ViewportBounds = { readonly width: number; readonly bottom: number };

/** The usable viewport: its width, and how far down a popup may reach. */
function viewportBounds(): ViewportBounds {
  const root = document.documentElement;
  // The phone shell pins a navigation bar to the bottom of the screen; a popup under it is as
  // unreachable as one off-screen. It exists exactly below the 880px shell breakpoint.
  const bottomNav = window.matchMedia?.("(max-width: 879px)").matches
    ? Number.parseFloat(
        getComputedStyle(root).getPropertyValue("--bottom-nav-height"),
      ) || 0
    : 0;
  return {
    width: root.clientWidth || window.innerWidth,
    bottom: window.innerHeight - bottomNav,
  };
}

/**
 * Where a popup of the measured size fits next to its trigger. Pure, so the rule is testable
 * without a layout engine.
 */
export function placeMenu(
  trigger: Box,
  menu: Box,
  viewport: ViewportBounds,
): MenuPlacement {
  if (menu.width === 0 && menu.height === 0) {
    return DEFAULT_PLACEMENT;
  }
  const endLeft = trigger.right - menu.width;
  const startRight = trigger.left + menu.width;
  const align =
    endLeft < EDGE_MARGIN && startRight <= viewport.width - EDGE_MARGIN
      ? "start"
      : "end";
  const belowBottom = trigger.bottom + TRIGGER_GAP + menu.height;
  const aboveTop = trigger.top - TRIGGER_GAP - menu.height;
  const side =
    belowBottom > viewport.bottom - EDGE_MARGIN && aboveTop >= EDGE_MARGIN
      ? "above"
      : "below";
  return { align, side };
}
