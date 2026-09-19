"use client";

import { createContext, useContext } from "react";

/**
 * The ids of rows still waiting for their Metric (`StrategyDraftState.unset`), for the rows that
 * render them. A context rather than a prop threaded through every section, level and signal
 * editor, because only the row itself needs to know.
 */
export const UnsetRowsContext = createContext<ReadonlySet<string>>(new Set());

export function useIsUnsetRow(rowId: string): boolean {
  return useContext(UnsetRowsContext).has(rowId);
}
