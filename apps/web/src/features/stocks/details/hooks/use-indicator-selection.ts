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

export type OverlaySelection = {
  readonly selected: ReadonlySet<SelectableSeriesId>;
  readonly toggle: (id: SelectableSeriesId) => void;
};

export type PaneSelection = {
  /** The one Fundamental Metric drawn in its own pane, or `null` for none. */
  readonly fundamental: FundamentalMetricId | null;
  readonly chooseFundamental: (id: FundamentalMetricId | null) => void;
  /** The one valuation ratio drawn in its own pane, or `null` for none. */
  readonly valuation: ValuationRatioId | null;
  readonly chooseValuation: (id: ValuationRatioId | null) => void;
};

/**
 * The chart's overlay selection: any number of moving averages, oscillators and intrinsic-value
 * series drawn over the price.
 *
 * Presentation state only: enabling an overlay changes what the chart draws and never any stored
 * strategy or backtest configuration, and it is not persisted — a reload or another stock starts
 * from the catalog's defaults. It lives with the chart, because which overlays exist depends on the
 * loaded history.
 *
 * `available` is applied on toggle so an entry the loaded payload cannot draw can never enter the
 * selection, including the default `Balanced` for a stock that has no blend history yet.
 */
export function useIndicatorSelection(
  available: ReadonlySet<SelectableSeriesId>,
): OverlaySelection {
  const [chosen, setChosen] = useState<ReadonlySet<SelectableSeriesId>>(
    () => new Set(DEFAULT_SELECTED_SERIES),
  );

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

  return { selected, toggle };
}

/**
 * The two single-choice panes: one valuation ratio and one Fundamental Metric, each drawn in its
 * own pane below the price.
 *
 * Owned by the page rather than the chart, because the financial cards choose them too — and may do
 * so before the chart's history has arrived; the choice is then simply waiting for the chart, which
 * applies it when it mounts. Every catalog entry may be chosen: a ratio's or a metric's availability
 * is not known before its history is asked for, and an unavailable one says so where it would be
 * drawn. The two choices are independent: choosing, changing or clearing one never touches the
 * other. Choosing the entry already chosen changes nothing, so it asks for nothing again. Like the
 * overlays, the choice is not persisted.
 */
export function usePaneSelection(): PaneSelection {
  const [fundamental, setFundamental] = useState<FundamentalMetricId | null>(
    null,
  );
  const [valuation, setValuation] = useState<ValuationRatioId | null>(null);

  // One metric at a time: choosing another replaces it. Anything that is not a catalog identity
  // clears the choice rather than being kept as a metric no request could name.
  const chooseFundamental = useCallback((id: FundamentalMetricId | null) => {
    setFundamental(isFundamentalMetricId(id) ? id : null);
  }, []);

  // One ratio at a time, by the same rule: an exact catalog identity, or none.
  const chooseValuation = useCallback((id: ValuationRatioId | null) => {
    setValuation(isValuationRatioId(id) ? id : null);
  }, []);

  return { fundamental, chooseFundamental, valuation, chooseValuation };
}
