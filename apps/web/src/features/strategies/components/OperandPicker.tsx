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
} from "react";
import styles from "./OperandPicker.module.css";

export type OperandPickerOption = {
  /** The option's identity: a metric key or a series id, exactly as the registry spells it. */
  readonly key: string;
  readonly label: string;
};

export type OperandPickerCategory = {
  readonly id: string;
  readonly label: string;
  readonly options: readonly OperandPickerOption[];
};

type OperandPickerProps = {
  /** Names the trigger and the popover: `Metric` or `Compare with`. */
  readonly label: string;
  /** The trigger's test id; the popover, its categories and its options derive theirs from it. */
  readonly testId: string;
  /** What the popover offers, already partitioned and ordered by the registry or the catalog. */
  readonly categories: readonly OperandPickerCategory[];
  /** The chosen option's key, or `""` when nothing is chosen yet. */
  readonly selectedKey: string;
  /**
   * The category the current choice belongs to. Passed rather than searched for, so a choice the
   * popover no longer offers still reopens on its own category when that category is offered.
   */
  readonly selectedCategoryId?: string;
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
  readonly onSelect: (key: string) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
};

/** The gap between the trigger and the popover, in pixels. */
const GAP = 6;

type Placement = {
  readonly side: "below" | "above";
  /** From the anchor's top edge (below) or bottom edge (above) to the popover's near edge. */
  readonly offset: number;
  /** Above the trigger the popover keeps one height, so a longer category never moves its top. */
  readonly height?: number;
};

/**
 * The height the popover would need to show its longest category without scrolling: its height now,
 * plus the option rows the longest category has beyond the shown one. Read from the rendered grid —
 * its columns, one option's height and the row gap — so the stylesheet stays the only place the
 * layout is decided.
 */
function tallestHeight(panel: HTMLElement, mostOptions: number): number {
  const grid = panel.querySelector<HTMLElement>("[data-option-grid]");
  const option = grid?.firstElementChild;
  if (!grid || !(option instanceof HTMLElement)) {
    return panel.offsetHeight;
  }
  const style = getComputedStyle(grid);
  const columns = Math.max(
    1,
    style.gridTemplateColumns.split(" ").filter(Boolean).length,
  );
  const pitch = option.offsetHeight + (Number.parseFloat(style.rowGap) || 0);
  const shownRows = Math.ceil(grid.children.length / columns);
  const mostRows = Math.ceil(mostOptions / columns);
  return panel.offsetHeight + Math.max(0, mostRows - shownRows) * pitch;
}

/**
 * One operand of a rule, chosen in two steps inside one popover: a category, then an option of it.
 *
 * Every category is visible at once as a grid of tiles; the active one's options sit below in a
 * two-column grid, and only that options area scrolls. Browsing a category changes nothing — choosing
 * an option is the one edit, and it closes the popover. Reopening starts on the category of the
 * current choice with that choice marked, so the popover always opens where the rule already is.
 *
 * The component keeps no catalog: categories, their order, their options and every label are handed
 * in by the caller, which reads them from the registry or the series catalog.
 *
 * Above a phone it is a popover anchored to the rule's fields; on a phone the same panel is a bottom
 * sheet over a scrim, which is what keeps every category and a useful number of options in reach of
 * a thumb. It closes on Escape (returning focus to the trigger), on a press outside it, and when focus
 * leaves it.
 */
export function OperandPicker({
  label,
  testId,
  categories,
  selectedKey,
  selectedCategoryId,
  display,
  placeholder = false,
  align = "start",
  invalid,
  describedBy,
  onSelect,
  onFocus,
  onBlur,
}: OperandPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set between a press on the trigger and its click; see the trigger's `onFocus`.
  const pressingRef = useRef(false);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const optionsLabelId = `${baseId}-options`;

  const homeCategoryId =
    (selectedCategoryId !== undefined &&
    categories.some((category) => category.id === selectedCategoryId)
      ? selectedCategoryId
      : categories.find((category) =>
          category.options.some((option) => option.key === selectedKey),
        )?.id) ?? categories[0]?.id;
  const active =
    categories.find((category) => category.id === activeId) ??
    categories.find((category) => category.id === homeCategoryId) ??
    categories[0];

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPlacement(null);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const openPanel = () => {
    // Every opening starts where the rule is, not where the last browse was left.
    setActiveId(homeCategoryId ?? null);
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

  // Focus goes to the current choice when it is on show, otherwise to the category being shown.
  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>('[data-option][aria-pressed="true"]') ??
      panel?.querySelector<HTMLElement>('[data-category][aria-pressed="true"]');
    target?.focus();
    // Only on opening: browsing categories keeps focus on the tile the user pressed.
  }, [open]);

  // Above a phone the popover is anchored to the fields it belongs to, below the trigger unless the
  // viewport has more room above it. Decided once per opening, from the height the tallest category
  // would need, so switching categories never flips it; above the trigger it is held at that height,
  // so a longer category never moves the category grid either. A phone's bottom sheet is fixed and
  // has no anchor, so it is left to the stylesheet.
  const mostOptions = Math.max(
    0,
    ...categories.map((category) => category.options.length),
  );
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
    const maxHeight = Number.parseFloat(getComputedStyle(panel).maxHeight);
    const height = Math.min(
      Number.isFinite(maxHeight) ? maxHeight : Number.POSITIVE_INFINITY,
      tallestHeight(panel, mostOptions),
    );
    const triggerBox = trigger.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerBox.bottom;
    const spaceAbove = triggerBox.top;
    setPlacement(
      spaceBelow < height + GAP && spaceAbove > spaceBelow
        ? {
            side: "above",
            offset: anchorBox.bottom - triggerBox.top + GAP,
            height: Math.min(height, spaceAbove - 2 * GAP),
          }
        : { side: "below", offset: triggerBox.bottom - anchorBox.top + GAP },
    );
  }, [open, mostOptions]);

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

  const choose = (key: string) => {
    if (key !== selectedKey) {
      onSelect(key);
    }
    close(true);
  };

  const panelStyle =
    placement === null
      ? undefined
      : ({
          "--picker-offset": `${placement.offset}px`,
          ...(placement.height === undefined
            ? {}
            : { "--picker-height": `${placement.height}px` }),
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
        data-value={selectedKey}
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

      {open && active ? (
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

            <div
              className={styles.categories}
              role="group"
              aria-label="Categories"
            >
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={styles.category}
                  data-category=""
                  data-testid={`${testId}-category`}
                  data-value={category.id}
                  // Marks where the current choice lives while another category is being browsed.
                  data-current={
                    category.id === homeCategoryId && selectedKey !== ""
                      ? "true"
                      : undefined
                  }
                  aria-pressed={category.id === active.id}
                  onClick={() => setActiveId(category.id)}
                >
                  {category.label}
                </button>
              ))}
            </div>

            <div className={styles.options} data-testid={`${testId}-options`}>
              <p className={styles.optionsLabel} id={optionsLabelId}>
                {active.label}
              </p>
              <ul
                className={styles.optionGrid}
                data-option-grid=""
                aria-labelledby={optionsLabelId}
              >
                {active.options.map((option) => (
                  <li key={option.key}>
                    <button
                      type="button"
                      className={styles.option}
                      data-option=""
                      data-testid={`${testId}-option`}
                      data-value={option.key}
                      aria-pressed={option.key === selectedKey}
                      title={option.label}
                      onClick={() => choose(option.key)}
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
