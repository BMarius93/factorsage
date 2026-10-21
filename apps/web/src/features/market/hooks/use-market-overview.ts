"use client";

import {
  MARKET_OVERVIEW_GROUP_IDS,
  type MarketOverviewResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useState } from "react";
import { fetchMarketOverview } from "../api/market-api";

export type MarketOverviewStatus = "loading" | "ready" | "error";

export type MarketOverviewState = {
  readonly status: MarketOverviewStatus;
  readonly overview: MarketOverviewResponse | null;
  /** Asks again after a failure. */
  readonly reload: () => void;
};

/**
 * The ETF market overview behind the Dashboard's Market watch sidebar.
 *
 * Its own request, deliberately separate from `useDashboard`: the market is the same for everybody
 * and the Dashboard's rows are not, and a failure on either side must not blank the other. It is
 * read once per mount and not polled — these are end-of-day closes, and a timer would suggest a
 * liveness the data does not have. One response carries every period's return and line, so
 * changing the period on screen never asks again. Unmounting aborts a read still in flight, and an
 * aborted read never updates anything.
 */
export function useMarketOverview(): MarketOverviewState {
  const [status, setStatus] = useState<MarketOverviewStatus>("loading");
  const [overview, setOverview] = useState<MarketOverviewResponse | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchMarketOverview({ signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) {
          return;
        }
        if (!isMarketOverviewResponse(loaded)) {
          // An API on a different contract version — mid-deploy, the web app ahead of or behind
          // the API. Reported as this section's failure, never rendered: a body this component
          // cannot read must not take the rest of the Dashboard down with it.
          setOverview(null);
          setStatus("error");
          return;
        }
        setOverview(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, []);

  return { status, overview, reload };
}

/**
 * Whether a body has the shape this release reads: the three groups, in order, each with a list of
 * instruments carrying a returns object and a per-period lines object. Only structure, never
 * values — the API owns those.
 */
export function isMarketOverviewResponse(
  value: unknown,
): value is MarketOverviewResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const groups = (value as { groups?: unknown }).groups;
  return (
    Array.isArray(groups) &&
    groups.length === MARKET_OVERVIEW_GROUP_IDS.length &&
    groups.every(
      (group: unknown, index) =>
        typeof group === "object" &&
        group !== null &&
        (group as { id?: unknown }).id === MARKET_OVERVIEW_GROUP_IDS[index] &&
        Array.isArray((group as { instruments?: unknown }).instruments) &&
        (group as { instruments: unknown[] }).instruments.every(
          (instrument) =>
            typeof instrument === "object" &&
            instrument !== null &&
            typeof (instrument as { ticker?: unknown }).ticker === "string" &&
            typeof (instrument as { returns?: unknown }).returns === "object" &&
            (instrument as { returns?: unknown }).returns !== null &&
            typeof (instrument as { sparklines?: unknown }).sparklines ===
              "object" &&
            (instrument as { sparklines?: unknown }).sparklines !== null,
        ),
    )
  );
}
