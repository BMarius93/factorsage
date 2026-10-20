"use client";

import {
  findFundamentalMetric,
  findValuationRatio,
  FUNDAMENTAL_METRICS_LABEL,
  VALUATION_RATIO_CATALOG,
  VALUATION_RATIOS_LABEL,
  type FundamentalMetricId,
  type SelectableSeriesId,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FUNDAMENTAL_GROUPS } from "../utils/fundamental-series";
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
  /** The one valuation ratio drawn in its own pane, or `null`. */
  readonly valuation: ValuationRatioId | null;
  readonly onChooseValuation: (id: ValuationRatioId | null) => void;
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
 * valuation ratios and then the Fundamental Metrics follow them as two more sections — one ratio
 * and one metric at a time, so each is one native radio group over its own catalog, led by "None"
 * to clear it. The fifteen metrics stay **one** group however they are headed: the category
 * headings are sub-fieldsets of the same radio name, so the arrow keys move across every metric and
 * choosing one always replaces the previous one. The chosen entry's own catalog summary and formula
 * explain what is being drawn. The two choices are independent. On a wide screen the overlays and
 * the two single-choice families sit side by side so every family is visible at once; the panel is
 * bounded to the viewport and scrolls inside itself. It closes on Escape or an outside pointer press
 * and returns focus to the trigger.
 */
export function IndicatorsMenu({
  selected,
  available,
  onToggle,
  colorOf,
  valuation,
  onChooseValuation,
  fundamental,
  onChooseFundamental,
}: IndicatorsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const panelId = `${baseId}-indicators`;
  const valuationHintId = `${baseId}-valuation-hint`;
  const fundamentalHintId = `${baseId}-fundamentals-hint`;
  // One radio name per family: the valuation ratios are one group, and so are all fifteen metrics.
  const valuationName = `${baseId}-valuation`;
  const fundamentalName = `${baseId}-fundamental`;

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

  // Opened low on a short screen, the panel would run past the bottom of the viewport (on a phone,
  // under the bottom navigation). Bring all of it into view, moving the page no more than needed;
  // the panel's scroll margins keep it clear of the top bar and the bottom navigation.
  useEffect(() => {
    if (open) {
      panelRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open]);

  const count =
    selected.size +
    (valuation === null ? 0 : 1) +
    (fundamental === null ? 0 : 1);
  const chosenRatio =
    valuation === null ? undefined : findValuationRatio(valuation);
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
        ref={panelRef}
        id={panelId}
        data-testid="indicators-panel"
        className={styles.panel}
        role="dialog"
        aria-label="Indicators"
        hidden={!open}
      >
        <div className={styles.column}>
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
                        <span className={styles.optionLabel}>
                          {series.label}
                        </span>
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
        <div className={styles.column}>
          <fieldset
            className={styles.group}
            data-testid="valuation-section"
            aria-describedby={valuationHintId}
          >
            <legend className={styles.groupLabel}>
              {VALUATION_RATIOS_LABEL}
            </legend>
            <p className={styles.groupHint} id={valuationHintId}>
              One ratio at a time, in its own pane below the price.
            </p>
            <ul className={styles.options}>
              <li>
                <RadioOption
                  name={valuationName}
                  label="None"
                  checked={valuation === null}
                  onChoose={() => onChooseValuation(null)}
                />
              </li>
              {VALUATION_RATIO_CATALOG.map((ratio) => (
                <li key={ratio.id}>
                  <RadioOption
                    name={valuationName}
                    label={ratio.label}
                    value={ratio.id}
                    checked={valuation === ratio.id}
                    onChoose={() => onChooseValuation(ratio.id)}
                  />
                </li>
              ))}
            </ul>
            {chosenRatio ? (
              <div className={styles.choiceHelp} data-testid="valuation-help">
                <p className={styles.choiceSummary}>{chosenRatio.summary}</p>
                <p className={styles.choiceFormula}>{chosenRatio.formula}</p>
              </div>
            ) : null}
          </fieldset>
          <fieldset
            className={styles.group}
            data-testid="fundamentals-section"
            aria-describedby={fundamentalHintId}
          >
            <legend className={styles.groupLabel}>
              {FUNDAMENTAL_METRICS_LABEL}
            </legend>
            <p className={styles.groupHint} id={fundamentalHintId}>
              One metric at a time, in its own pane below the price.
            </p>
            <ul className={styles.options}>
              <li>
                <RadioOption
                  name={fundamentalName}
                  label="None"
                  checked={fundamental === null}
                  onChoose={() => onChooseFundamental(null)}
                />
              </li>
            </ul>
            {FUNDAMENTAL_GROUPS.map((group) => (
              // A heading for the category, not a group of its own: every radio here shares the
              // one name, so there is one choice across all fifteen.
              <fieldset className={styles.subgroup} key={group.id}>
                <legend className={styles.subgroupLabel}>{group.label}</legend>
                <ul className={styles.options}>
                  {group.metrics.map((metric) => (
                    <li key={metric.id}>
                      <RadioOption
                        name={fundamentalName}
                        label={metric.label}
                        value={metric.id}
                        checked={fundamental === metric.id}
                        onChoose={() => onChooseFundamental(metric.id)}
                      />
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
            {chosenMetric ? (
              <div className={styles.choiceHelp} data-testid="fundamental-help">
                <p className={styles.choiceSummary}>{chosenMetric.summary}</p>
                <p className={styles.choiceFormula}>{chosenMetric.formula}</p>
              </div>
            ) : null}
          </fieldset>
        </div>
      </div>
    </div>
  );
}

/**
 * One native radio option. The whole row is its label, so tapping anywhere chooses it, and the arrow
 * keys move between the options of its group as the platform does.
 */
function RadioOption({
  name,
  label,
  value = "",
  checked,
  onChoose,
}: {
  readonly name: string;
  readonly label: string;
  /** The catalog identity, or empty for "None". */
  readonly value?: string;
  readonly checked: boolean;
  readonly onChoose: () => void;
}) {
  return (
    <label className={styles.option}>
      <input
        type="radio"
        className={styles.radio}
        name={name}
        value={value}
        checked={checked}
        onChange={onChoose}
      />
      <span className={styles.optionLabel}>{label}</span>
    </label>
  );
}
