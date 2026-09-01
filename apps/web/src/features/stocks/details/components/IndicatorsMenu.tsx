"use client";

import type { SelectableSeriesId } from "@intrinsic/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { INDICATOR_GROUPS } from "../utils/series-catalog";
import styles from "./IndicatorsMenu.module.css";

type IndicatorsMenuProps = {
  /** Currently enabled overlays. Price is always drawn and is never one of these. */
  readonly selected: ReadonlySet<SelectableSeriesId>;
  /** Entries the loaded data can actually draw; everything else renders disabled. */
  readonly available: ReadonlySet<SelectableSeriesId>;
  readonly onToggle: (id: SelectableSeriesId) => void;
  /** Colour the chart paints an enabled series with, so the picker matches the legend. */
  readonly colorOf: (id: SelectableSeriesId) => string | undefined;
};

/**
 * The grouped multi-select `Indicators` control.
 *
 * Groups, ordering, labels and identifiers come from the canonical selectable-series catalog; this
 * component keeps no list of its own, so a catalog change reaches the UI without editing it. Every
 * one of the 21 entries stays discoverable: an entry the security has no data for is rendered
 * disabled and explicitly marked unavailable rather than hidden or silently substituted.
 *
 * The options are native checkboxes inside labelled fieldsets, so keyboard traversal, screen-reader
 * grouping and touch targets are the platform's rather than a re-implementation. The popover closes
 * on Escape or an outside pointer press and returns focus to the trigger.
 */
export function IndicatorsMenu({
  selected,
  available,
  onToggle,
  colorOf,
}: IndicatorsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = `${useId()}-indicators`;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const count = selected.size;

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        data-testid="indicators-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        Indicators
        {count > 0 ? <span className={styles.badge}>{count}</span> : null}
        <span className={styles.caret} aria-hidden="true" />
      </button>

      <div
        id={panelId}
        data-testid="indicators-panel"
        className={styles.panel}
        role="dialog"
        aria-label="Indicators"
        hidden={!open}
      >
        <p className={styles.hint}>
          Price is always shown. Select any number of overlays.
        </p>
        {INDICATOR_GROUPS.map((group) => (
          <fieldset className={styles.group} key={group.id}>
            <legend className={styles.groupLabel}>{group.label}</legend>
            <ul className={styles.options}>
              {group.series.map((series) => {
                const isAvailable = available.has(series.id);
                const isSelected = selected.has(series.id);
                const color = colorOf(series.id);
                return (
                  <li key={series.id}>
                    <label
                      className={styles.option}
                      data-unavailable={isAvailable ? undefined : "true"}
                    >
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={isSelected}
                        disabled={!isAvailable}
                        onChange={() => onToggle(series.id)}
                      />
                      <span
                        className={styles.swatch}
                        style={color ? { backgroundColor: color } : undefined}
                        data-on={isSelected ? "true" : undefined}
                        aria-hidden="true"
                      />
                      <span className={styles.optionLabel}>{series.label}</span>
                      {isAvailable ? null : (
                        <>
                          {/* Explicit separator so the accessible name reads
                              "SMA 200W Unavailable" rather than running together. */}{" "}
                          <span className={styles.unavailable}>
                            Unavailable
                          </span>
                        </>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
