"use client";

import {
  isFundamentalMetricId,
  isValuationRatioId,
  type FundamentalMetricId,
  type SelectableSeriesId,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { useCallback, useMemo, useState } from "react";
import { DEFAULT_SELECTED_SERIES } from "../utils/series-catalog";

export type IndicatorSelection = {
  readonly selected: ReadonlySet<SelectableSeriesId>;
  readonly toggle: (id: SelectableSeriesId) => void;
  /** The one Fundamental Metric drawn in its own pane, or `null` for none. */
  readonly fundamental: FundamentalMetricId | null;
  readonly chooseFundamental: (id: FundamentalMetricId | null) => void;
  /** The one valuation ratio drawn in its own pane, or `null` for none. */
  readonly valuation: ValuationRatioId | null;
  readonly chooseValuation: (id: ValuationRatioId | null) => void;
};

/**
 * Chart series selection state.
 *
 * Presentation state only: enabling an overlay or choosing a fundamental or a valuation ratio
 * changes what the chart draws and never any stored strategy or backtest configuration. Like the
 * overlays, the choice lives with the page and is not persisted: a reload or another stock starts
 * from the catalog's defaults, with no fundamental and no valuation ratio chosen.
 *
 * `available` is applied on toggle so an entry the loaded payload cannot draw can never enter the
 * selection, including the default `Balanced` for a stock that has no blend history yet. A
 * fundamental's or a ratio's availability is not known before its history is asked for, so every
 * catalog entry may be chosen and an unavailable one says so where it would be drawn. The two
 * single choices are independent: choosing, changing or clearing one never touches the other.
 */
export function useIndicatorSelection(
  available: ReadonlySet<SelectableSeriesId>,
): IndicatorSelection {
  const [chosen, setChosen] = useState<ReadonlySet<SelectableSeriesId>>(
    () => new Set(DEFAULT_SELECTED_SERIES),
  );
  const [fundamental, setFundamental] = useState<FundamentalMetricId | null>(
    null,
  );
  const [valuation, setValuation] = useState<ValuationRatioId | null>(null);

  const selected = useMemo(
    () => new Set([...chosen].filter((id) => available.has(id))),
    [chosen, available],
  );

  const toggle = useCallback(
    (id: SelectableSeriesId) => {
      setChosen((current) => {
        const next = new Set(current);
        if (next.has(id)) {
          next.delete(id);
        } else if (available.has(id)) {
          next.add(id);
        }
        return next;
      });
    },
    [available],
  );

  // One metric at a time: choosing another replaces it. Anything that is not a catalog identity
  // clears the choice rather than being kept as a metric no request could name.
  const chooseFundamental = useCallback((id: FundamentalMetricId | null) => {
    setFundamental(isFundamentalMetricId(id) ? id : null);
  }, []);

  // One ratio at a time, by the same rule: an exact catalog identity, or none.
  const chooseValuation = useCallback((id: ValuationRatioId | null) => {
    setValuation(isValuationRatioId(id) ? id : null);
  }, []);

  return {
    selected,
    toggle,
    fundamental,
    chooseFundamental,
    valuation,
    chooseValuation,
  };
}
