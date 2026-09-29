"use client";

import {
  findFundamentalMetric,
  FUNDAMENTAL_METRICS_LABEL,
  isFundamentalMetricId,
  type FundamentalMetricId,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Select } from "../../../../components/ui/Select";
import { FUNDAMENTAL_GROUPS } from "../utils/fundamental-series";
import { INDICATOR_GROUPS } from "../utils/series-catalog";
import styles from "./IndicatorsMenu.module.css";

/** The select's option groups, built once from the catalog's own grouping. */
const FUNDAMENTAL_OPTION_GROUPS = FUNDAMENTAL_GROUPS.map((group) => ({
  label: group.label,
  options: group.metrics.map((metric) => ({
    value: metric.id,
    label: metric.label,
  })),
}));

type IndicatorsMenuProps = {
  /** Currently enabled overlays. Price is always drawn and is never one of these. */
  readonly selected: ReadonlySet<SelectableSeriesId>;
  /** Entries the loaded data can actually draw; everything else renders disabled. */
  readonly available: ReadonlySet<SelectableSeriesId>;
  readonly onToggle: (id: SelectableSeriesId) => void;
  /** Colour the chart paints an enabled series with, so the picker matches the legend. */
  readonly colorOf: (id: SelectableSeriesId) => string | undefined;
  /** The one Fundamental Metric drawn in its own pane, or `null`. */
  readonly fundamental: FundamentalMetricId | null;
  readonly onChooseFundamental: (id: FundamentalMetricId | null) => void;
};

/**
 * The grouped `Indicators` control.
 *
 * Groups, ordering, labels and identifiers come from the canonical catalogs; this component keeps
 * no list of its own, so a catalog change reaches the UI without editing it. Every selectable series
 * stays discoverable: an entry the security has no data for is rendered disabled and explicitly
 * marked unavailable rather than hidden or silently substituted.
 *
 * The overlays are native checkboxes inside labelled fieldsets, so keyboard traversal,
 * screen-reader grouping and touch targets are the platform's rather than a re-implementation. The
 * Fundamental Metrics follow them as one more section — one metric at a time, so it is a native
 * select grouped by the Fundamentals catalog, with "None" to clear it — and the chosen metric's own
 * catalog summary and formula explain what is being drawn. The popover closes on Escape or an
 * outside pointer press and returns focus to the trigger.
 */
export function IndicatorsMenu({
  selected,
  available,
  onToggle,
  colorOf,
  fundamental,
  onChooseFundamental,
}: IndicatorsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();
  const panelId = `${baseId}-indicators`;
  const fundamentalHintId = `${baseId}-fundamentals-hint`;

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

  const count = selected.size + (fundamental === null ? 0 : 1);
  const chosenMetric =
    fundamental === null ? undefined : findFundamentalMetric(fundamental);

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
        <fieldset className={styles.group} data-testid="fundamentals-section">
          <legend className={styles.groupLabel}>
            {FUNDAMENTAL_METRICS_LABEL}
          </legend>
          <p className={styles.groupHint} id={fundamentalHintId}>
            One metric at a time, in its own pane below the price.
          </p>
          <Select
            value={fundamental ?? ""}
            onValueChange={(value) =>
              onChooseFundamental(isFundamentalMetricId(value) ? value : null)
            }
            placeholder="None"
            groups={FUNDAMENTAL_OPTION_GROUPS}
            density="compact"
            aria-label="Fundamental metric"
            aria-describedby={fundamentalHintId}
            testId="fundamental-select"
          />
          {chosenMetric ? (
            <div
              className={styles.fundamentalHelp}
              data-testid="fundamental-help"
            >
              <p className={styles.fundamentalSummary}>
                {chosenMetric.summary}
              </p>
              <p className={styles.fundamentalFormula}>
                {chosenMetric.formula}
              </p>
            </div>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
}
