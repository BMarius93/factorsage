"use client";

import type { StrategyScopeNames } from "@intrinsic/contracts";
import { createContext, useContext } from "react";

/**
 * Display names for the actors and groups the open strategy's rules reference.
 *
 * A context rather than a prop threaded through section, level and signal editor, for the same reason
 * `UnsetRowsContext` is one: only the row itself needs to know, and four intermediate components
 * carrying a prop they never read is how a builder accumulates noise.
 *
 * Empty is a legitimate state, not a loading failure: `describePredicateScope` falls back to
 * `Selected group`, which stays honest while the names are in flight and stays honest if the
 * reference has gone.
 */
export const ScopeNamesContext = createContext<StrategyScopeNames>({});

export function useScopeNames(): StrategyScopeNames {
  return useContext(ScopeNamesContext);
}
