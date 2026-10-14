"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./PickerPopover.module.css";

/** The gap between the trigger and the popover, in pixels. */
const GAP = 6;

/**
 * The room a content-sized popover wants on the side it opens: enough for its controls and a
 * useful stretch of list. With less than this below the trigger and more above, it opens above.
 */
const CONTENT_ROOM = 320;

/** A content-sized popover never shrinks below this, however little room the viewport leaves. */
const CONTENT_MINIMUM = 200;

type Placement = {
  readonly side: "below" | "above";
  /** From the anchor's top edge (below) or bottom edge (above) to the popover's near edge. */
  readonly offset: number;
  /** A held popover keeps one height above its trigger, so a longer category never moves its top. */
  readonly height?: number;
  /** A content-sized popover is capped to the room its side of the viewport really has. */
  readonly maxHeight?: number;
};

/**
 * How an open popover is sized against the viewport, above a phone.
 *
 * - **A measuring function** — *held*: the popover opens on the side that fits the height the
 *   function reports (its tallest state), and above its trigger it keeps exactly that height. For a
 *   popover whose top row is its navigation, so browsing never moves that row under the pointer.
 * - **`"content"`** — the popover is always as tall as what it shows, never taller: it opens below
 *   unless the viewport has clearly more room above, and its height is capped to the room on that
 *   side so its own list scrolls instead of the page. Nothing is ever held open as blank space.
 */
export type PickerSizing = "content" | ((panel: HTMLElement) => number);

export type PickerPopoverApi = {
  /** Closes the popover; `returnFocus` hands focus back to the trigger. */
  readonly close: (returnFocus: boolean) => void;
};

type PickerPopoverProps = {
  /** Names the trigger and the popover: `Metric` or `Value`. */
  readonly label: string;
  /** The trigger's test id; the popover and its scrim derive theirs from it. */
  readonly testId: string;
  /** The identity the control holds, published as the trigger's `data-value`. */
  readonly value: string;
  /** What the trigger reads: the choice's label, or a prompt or an unavailable label. */
  readonly display: string;
  /** `display` is a prompt rather than a choice, and reads as one. */
  readonly placeholder?: boolean;
  /**
   * Which edge of the fields the popover lines up with: the start for the first operand, the end for
   * the last, so each opens beneath the control that opened it.
   */
  readonly align?: "start" | "end";
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly sizing: PickerSizing;
  /** Called as the popover opens: where a caller returns to the rule from wherever it last browsed. */
  readonly onOpen?: () => void;
  /** The element focus moves to as the popover opens. */
  readonly initialFocus: (panel: HTMLElement) => HTMLElement | null | undefined;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  readonly children: (api: PickerPopoverApi) => ReactNode;
};

/**
 * The shell of a rule's pickers: a trigger that reads like the product's select, and one panel.
 *
 * Above a phone the panel is a popover anchored to the rule's fields; on a phone the same panel is a
 * bottom sheet over a scrim. It closes on Escape (returning focus to the trigger), on a press outside
 * it, and when focus leaves it. What the panel *holds* is the caller's: the Value picker's category
 * tiles and the Metric picker's source, families and library are both drawn inside this one shell, so
 * opening, closing, focus and placement are decided once.
 */
export function PickerPopover({
  label,
  testId,
  value,
  display,
  placeholder = false,
  align = "start",
  invalid,
  describedBy,
  sizing,
  onOpen,
  initialFocus,
  onFocus,
  onBlur,
  children,
}: PickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set between a press on the trigger and its click; see the trigger's `onFocus`.
  const pressingRef = useRef(false);
  // Read when the popover opens, never a reason to place or focus it again. Kept current by a layout
  // effect declared before the two that read them, so an opening always sees this render's values.
  const sizingRef = useRef(sizing);
  const initialFocusRef = useRef(initialFocus);
  useLayoutEffect(() => {
    sizingRef.current = sizing;
    initialFocusRef.current = initialFocus;
  });
  const panelId = `${useId()}-panel`;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPlacement(null);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const openPanel = () => {
    // Every opening starts where the rule is, not where the last browse was left.
    onOpen?.();
    setOpen(true);
  };

  // A press anywhere outside closes without stealing focus back from wherever the user went.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  // Only on opening: browsing inside the popover keeps focus on whatever the user pressed.
  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    if (panel) {
      initialFocusRef.current(panel)?.focus();
    }
  }, [open]);

  // Above a phone the popover is anchored to the fields it belongs to, below the trigger unless the
  // viewport has more room above it. Decided once per opening, so browsing never flips it. A phone's
  // bottom sheet is fixed and has no anchor, so it is left to the stylesheet.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    const anchor = panel?.offsetParent;
    if (!panel || !trigger || !(anchor instanceof HTMLElement)) {
      return;
    }
    const declared = Number.parseFloat(getComputedStyle(panel).maxHeight);
    const limit = Number.isFinite(declared)
      ? declared
      : Number.POSITIVE_INFINITY;
    const triggerBox = trigger.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerBox.bottom;
    const spaceAbove = triggerBox.top;
    const below = {
      side: "below",
      offset: triggerBox.bottom - anchorBox.top + GAP,
    } as const;
    const above = {
      side: "above",
      offset: anchorBox.bottom - triggerBox.top + GAP,
    } as const;
    const measure = sizingRef.current;

    if (measure === "content") {
      const wanted = Math.min(limit, CONTENT_ROOM) + GAP;
      const side = spaceBelow < wanted && spaceAbove > spaceBelow ? above : below;
      const room = (side === above ? spaceAbove : spaceBelow) - 2 * GAP;
      setPlacement({ ...side, maxHeight: Math.max(CONTENT_MINIMUM, room) });
      return;
    }

    const height = Math.min(limit, measure(panel));
    setPlacement(
      spaceBelow < height + GAP && spaceAbove > spaceBelow
        ? { ...above, height: Math.min(height, spaceAbove - 2 * GAP) }
        : below,
    );
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  // Tabbing out of the popover closes it. A blur with no destination — a press on the panel's own
  // padding, the window losing focus — is not leaving it.
  const onBlurWithin = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (open && next instanceof Node && !rootRef.current?.contains(next)) {
      close(false);
    }
  };

  const panelStyle =
    placement === null
      ? undefined
      : ({
          "--picker-offset": `${placement.offset}px`,
          ...(placement.height === undefined
            ? {}
            : { "--picker-height": `${placement.height}px` }),
          ...(placement.maxHeight === undefined
            ? {}
            : { "--picker-max-height": `${placement.maxHeight}px` }),
        } as CSSProperties);

  return (
    <div
      className={styles.picker}
      ref={rootRef}
      onKeyDown={onKeyDown}
      onBlur={onBlurWithin}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        data-testid={testId}
        data-value={value}
        data-placeholder={placeholder ? "true" : undefined}
        aria-label={`${label}: ${display}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        // A long label truncates in a narrow row; the whole of it stays readable on hover.
        title={display}
        onPointerDown={() => {
          pressingRef.current = true;
        }}
        onClick={() => {
          const pressed = pressingRef.current;
          pressingRef.current = false;
          if (open) {
            close(true);
          } else {
            openPanel();
          }
          if (pressed) {
            onFocus?.();
          }
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openPanel();
          }
        }}
        // A press reports focus with its click, not on the way down. On a phone the explanation is
        // drawn under the focused row, so moving it between press and release would shift this
        // row, and the browser would deliver the click to an ancestor and never open the picker.
        onFocus={() => {
          if (!pressingRef.current) {
            onFocus?.();
          }
        }}
        onBlur={() => {
          pressingRef.current = false;
          onBlur?.();
        }}
      >
        <span className={styles.triggerText}>{display}</span>
        <span className={styles.chevron} aria-hidden="true" />
      </button>

      {open ? (
        <>
          <div
            className={styles.scrim}
            data-testid={`${testId}-scrim`}
            aria-hidden="true"
            onClick={() => close(true)}
          />
          <div
            ref={panelRef}
            id={panelId}
            className={styles.panel}
            role="dialog"
            aria-label={label}
            data-testid={`${testId}-panel`}
            data-placement={placement?.side}
            data-align={align}
            data-sizing={sizing === "content" ? "content" : "held"}
            style={panelStyle}
          >
            <div className={styles.header}>
              <span className={styles.title}>{label}</span>
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${label.toLowerCase()}`}
                onClick={() => close(true)}
              >
                ×
              </button>
            </div>
            {children({ close })}
          </div>
        </>
      ) : null}
    </div>
  );
}
