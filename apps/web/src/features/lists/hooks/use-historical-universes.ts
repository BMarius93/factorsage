"use client";

import type { HistoricalUniverseCatalogResponse } from "@intrinsic/contracts";
import { useCallback, useEffect, useState } from "react";
import { fetchHistoricalUniverses } from "../api/stock-lists-api";

export type HistoricalUniversesState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly retry: () => void }
  | {
      readonly status: "ready";
      readonly catalog: HistoricalUniverseCatalogResponse;
    };

/** Loads the historical universe catalog once: a few hundred bytes of metadata, no membership. */
export function useHistoricalUniverses(): HistoricalUniversesState {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; catalog: HistoricalUniverseCatalogResponse }
  >({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchHistoricalUniverses({ signal: controller.signal })
      .then((catalog) => {
        if (!controller.signal.aborted && catalog) {
          setState({ status: "ready", catalog });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [attempt]);

  return state.status === "error" ? { status: "error", retry } : state;
}
