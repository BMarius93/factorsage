import { FUNDAMENTAL_METRIC_IDS } from "@intrinsic/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDailyFundamentalHistory } from "./stock-details-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchDailyFundamentalHistory", () => {
  it("names the metric by its stable identity alone, for exactly the window asked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ date: "2026-08-28", value: 18.25 }],
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const metric of FUNDAMENTAL_METRIC_IDS) {
      await fetchDailyFundamentalHistory(
        "BRK.B",
        { from: "2025-08-28", to: "2026-08-28" },
        metric,
      );
      const url = new URL(fetchMock.mock.lastCall?.[0] as string);
      expect(url.pathname).toBe("/stocks/BRK.B/fundamentals/daily");
      // Exactly three parameters, and the metric is the catalog identity itself: never a label,
      // never a storage field, never anything the client derived from it.
      expect([...url.searchParams.keys()].sort()).toEqual([
        "from",
        "metric",
        "to",
      ]);
      expect(url.searchParams.get("metric")).toBe(metric);
      expect(url.searchParams.get("from")).toBe("2025-08-28");
      expect(url.searchParams.get("to")).toBe("2026-08-28");
    }
    expect(fetchMock).toHaveBeenCalledTimes(FUNDAMENTAL_METRIC_IDS.length);
  });

  it("passes the abort signal through, so a superseded request can be cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchDailyFundamentalHistory(
      "AAPL",
      { from: "2026-01-02", to: "2026-08-28" },
      "DEBT_TO_EQUITY",
      { signal: controller.signal },
    );

    expect((fetchMock.mock.lastCall?.[1] as RequestInit).signal).toBe(
      controller.signal,
    );
  });
});
