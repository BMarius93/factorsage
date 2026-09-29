"use client";

import {
  isFundamentalMetricId,
  type FundamentalMetricId,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import { useCallback, useMemo, useState } from "react";
import { DEFAULT_SELECTED_SERIES } from "../utils/series-catalog";

export type IndicatorSelection = {
  readonly selected: ReadonlySet<SelectableSeriesId>;
  readonly toggle: (id: SelectableSeriesId) => void;
  /** The one Fundamental Metric drawn in its own pane, or `null` for none. */
  readonly fundamental: FundamentalMetricId | null;
  readonly chooseFundamental: (id: FundamentalMetricId | null) => void;
};

/**
 * Chart series selection state.
 *
 * Presentation state only: enabling an overlay or choosing a fundamental changes what the chart
 * draws and never any stored strategy or backtest configuration. Like the overlays, the choice
 * lives with the page and is not persisted: a reload or another stock starts from the catalog's
 * defaults, with no fundamental chosen.
 *
 * `available` is applied on toggle so an entry the loaded payload cannot draw can never enter the
 * selection, including the default `Balanced` for a stock that has no blend history yet. A
 * fundamental's availability is not known before its history is asked for, so every catalog
 * metric may be chosen and an unavailable one says so where it would be drawn.
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

  return { selected, toggle, fundamental, chooseFundamental };
}
