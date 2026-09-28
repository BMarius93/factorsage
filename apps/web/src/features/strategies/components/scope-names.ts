"use client";

import type { StrategyScopeNames } from "@intrinsic/contracts";
import { createContext, useContext } from "react";

/**
 * Display names for the actors and groups the open strategy's rules reference.
 *
 * A context rather than a prop threaded through section, level and signal editor: only the row and
 * the explanation panel need to know, and four intermediate components carrying a prop they never
 * read is how a builder accumulates noise. (The Strategy logic sits beside the editor, not inside
 * it, so it takes the same names as a prop.)
 *
 * Empty is a legitimate state, not a loading failure: `describeMetricConfiguration` falls back to
 * `Selected group` / `Selected actor`, which stays honest while the names are in flight and stays
 * honest if the reference has gone.
 */
export const ScopeNamesContext = createContext<StrategyScopeNames>({});

export function useScopeNames(): StrategyScopeNames {
  return useContext(ScopeNamesContext);
}
