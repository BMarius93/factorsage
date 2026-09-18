"use client";

import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { useEffect, useState } from "react";
import { fetchMarketOverview } from "../api/market-api";

export type MarketOverviewStatus = "loading" | "ready" | "error";

export type MarketOverviewState = {
  readonly status: MarketOverviewStatus;
  readonly overview: MarketOverviewResponse | null;
};

/**
 * The market references behind the Dashboard's index cards.
 *
 * Its own request, deliberately separate from `useDashboard`: the market is the same for everybody
 * and the Dashboard's rows are not, and a failure on either side must not blank the other. It is
 * read once per mount and not polled — these are end-of-day closes, and a timer would suggest a
 * liveness the data does not have.
 */
export function useMarketOverview(): MarketOverviewState {
  const [status, setStatus] = useState<MarketOverviewStatus>("loading");
  const [overview, setOverview] = useState<MarketOverviewResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchMarketOverview({ signal: controller.signal })
      .then((loaded) => {
        setOverview(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, []);

  return { status, overview };
}
