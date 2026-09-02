"use client";

import type { SelectableSeriesId } from "@intrinsic/contracts";
import { useCallback, useMemo, useState } from "react";
import { DEFAULT_SELECTED_SERIES } from "../utils/series-catalog";

export type IndicatorSelection = {
  readonly selected: ReadonlySet<SelectableSeriesId>;
  readonly toggle: (id: SelectableSeriesId) => void;
  readonly clear: () => void;
};

/**
 * Chart overlay selection state.
 *
 * Presentation state only: enabling an overlay changes what the chart draws and never any stored
 * strategy or backtest configuration. `available` is applied on toggle so an entry the loaded
 * payload cannot draw can never enter the selection, including the default `Balanced` for a stock
 * that has no blend history yet.
 */
export function useIndicatorSelection(
  available: ReadonlySet<SelectableSeriesId>,
): IndicatorSelection {
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

  const clear = useCallback(() => setChosen(new Set()), []);

  return { selected, toggle, clear };
}
