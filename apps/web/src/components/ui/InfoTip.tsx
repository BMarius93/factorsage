"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./InfoTip.module.css";

type InfoTipProps = {
  /**
   * What the tip explains, for the button's accessible name: "About price vs value" reads well
   * from `label="price vs value"`. Never the explanation itself — that is `children`.
   */
  readonly label: string;
  /** One or two sentences. Anything longer belongs on the page, not in a tip. */
  readonly children: ReactNode;
  readonly testId?: string;
};

/**
 * A small "i" button that explains the figure beside it — a *toggletip*.
 *
 * It replaces the native `title` attribute where an explanation matters: `title` is unreachable by
 * keyboard and by touch, and it is the one place a reader would otherwise have to guess.
 *
 * - **Pointer hover** opens it on a device that can hover, and leaving closes it again.
 * - **Click or tap** toggles it, so a phone and a keyboard reach exactly what a mouse does.
 * - **Escape**, a press outside, focus leaving the tip or a scroll closes it; Escape returns focus
 *   to the button.
 * - The bubble is fixed to the viewport, so a card that clips its overflow never cuts it off.
 *
 * The bubble is a `role="tooltip"` the button names through `aria-describedby` while it is open,
 * so a screen reader reads the explanation when it lands on the button and nothing announces
 * itself unasked.
 */
export function InfoTip({ label, children, testId }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const tipId = useId();
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  // A tap fires the emulated mouseenter before the click; without this the click would close the
  // tip the hover had just opened.
  const openedByHoverRef = useRef(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    // The bubble is placed against the viewport, so it cannot follow a scroll; it closes instead.
    const onScroll = () => close();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  // The bubble is fixed to the viewport, measured from the button after layout and before paint:
  // a card that clips its overflow (every SectionCard does) can therefore never cut it off. It opens
  // below the button, starting at its left edge and moved left as far as it must to stay on screen.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const button = buttonRef.current;
    const bubble = bubbleRef.current;
    if (!button || !bubble) {
      return;
    }
    const anchor = button.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const width = bubble.offsetWidth;
    setPosition({
      top: anchor.bottom + 6,
      left: Math.max(8, Math.min(anchor.left, viewport - width - 8)),
    });
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      className={styles.wrapper}
      onMouseEnter={(event) => {
        if (event.nativeEvent instanceof MouseEvent && canHover()) {
          openedByHoverRef.current = true;
          setOpen(true);
        }
      }}
      onMouseLeave={() => {
        if (openedByHoverRef.current) {
          openedByHoverRef.current = false;
          close();
        }
      }}
      onBlur={(event) => {
        if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
          close();
        }
      }}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => {
          if (openedByHoverRef.current) {
            // The pointer already opened it by hovering: the click pins it open instead of
            // closing it under the cursor.
            openedByHoverRef.current = false;
            setOpen(true);
            return;
          }
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            close();
            buttonRef.current?.focus();
          }
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open ? (
        <span
          ref={bubbleRef}
          id={tipId}
          role="tooltip"
          className={styles.bubble}
          style={
            position
              ? { top: position.top, left: position.left }
              : { visibility: "hidden" }
          }
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/** True on a device whose primary pointer can hover; a touch screen emulates hover on tap. */
function canHover(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}
