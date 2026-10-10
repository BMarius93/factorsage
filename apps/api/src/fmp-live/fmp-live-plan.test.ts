import {
  getAlternativeDataConfig,
  getFmpTrafficConfig,
  getStockDataConfig,
} from "@intrinsic/config";
import {
  FMP_ENDPOINT_CLASSES,
  FMP_EOD_MAX_ROWS_PER_RESPONSE,
  FmpClient,
} from "@intrinsic/fmp";
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_FMP_DEFAULT_REQUEST_BUDGET,
  LIVE_FMP_MAX_REQUEST_BUDGET,
  LIVE_FMP_MAX_SECURITIES,
} from "./fmp-live-arguments";
import {
  LIVE_FMP_EXCLUSIONS,
  liveFmpIncludedDatasets,
  liveFmpRequestCeiling,
} from "./fmp-live-plan";

/**
 * The dataset classification and the request budget's derivation.
 *
 * The budget constants are numbers somebody could change without thinking; these cases tie them
 * to what the loaders can actually send, computed from the product's own defaults.
 */

/** The ceiling under the documented defaults: an unset environment. */
function defaultCeiling(securities: number) {
  return liveFmpRequestCeiling({
    securities,
    productHistoryYears: getStockDataConfig({}).productHistoryYears,
    alternativeDataMaxPages: getAlternativeDataConfig({}).maxPagesPerIngest,
    maxRetries: getFmpTrafficConfig({}).maxRetries,
  });
}

describe("live FMP request ceiling", () => {
  it("is derived from the loaders' own bounds", () => {
    expect(defaultCeiling(1)).toEqual({
      perSecurity: {
        // Only for a symbol the catalog does not hold yet.
        identity: 1,
        profile: 1,
        // 34 retained years cannot exceed two 5,000-row pages.
        prices: 2,
        // Three statements, quarterly and annual.
        statements: 6,
        splits: 1,
        // Twelve pages per endpoint: one insider endpoint, two chambers.
        insider: 12,
        congress: 24,
      },
      perSecurityTotal: 47,
      total: 47,
      totalWithEveryRetry: 188,
    });
    expect(defaultCeiling(3)).toMatchObject({
      total: 141,
      totalWithEveryRetry: 564,
    });
  });

  it("bounds the price walk the client really makes", async () => {
    // The longest history the loader can ask for, answered with full pages until it runs out:
    // the client must stop within the number of requests the ceiling allows for prices.
    const years = getStockDataConfig({}).productHistoryYears + 4;
    const sessions = years * 262;
    const all = Array.from({ length: sessions }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 9) - index * 86_400_000);
      return {
        symbol: "AAPL",
        date: date.toISOString().slice(0, 10),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      };
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const to = new URL(String(input)).searchParams.get("to") ?? "9999-12-31";
      const page = all
        .filter((row) => row.date <= to)
        .slice(0, FMP_EOD_MAX_ROWS_PER_RESPONSE);
      return new Response(JSON.stringify(page), { status: 200 });
    });
    const client = new FmpClient(
      () => ({ apiKey: "test-secret-key", timeoutMs: 1_000 }),
      fetchMock,
    );

    const rows = await client.getDailyPrices("AAPL", "security", {
      from: "1900-01-01",
      to: "2026-10-09",
    });
    expect(rows).toHaveLength(sessions);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(
      defaultCeiling(1).perSecurity.prices,
    );
  });

  it("grows with what it is asked to cover", () => {
    const base = defaultCeiling(1);
    expect(
      liveFmpRequestCeiling({
        securities: 1,
        productHistoryYears: 30,
        alternativeDataMaxPages: 20,
        maxRetries: 3,
      }).perSecurityTotal,
    ).toBe(base.perSecurityTotal + 8 + 16);
    expect(
      liveFmpRequestCeiling({
        securities: 1,
        productHistoryYears: 60,
        alternativeDataMaxPages: 12,
        maxRetries: 0,
      }),
    ).toMatchObject({ perSecurity: { prices: 4 }, totalWithEveryRetry: 49 });
  });
});

describe("live FMP request budget", () => {
  const ceiling = defaultCeiling(LIVE_FMP_MAX_SECURITIES);

  it("defaults to enough for three cold securities at every page bound, with headroom", () => {
    expect(LIVE_FMP_DEFAULT_REQUEST_BUDGET).toBeGreaterThanOrEqual(
      ceiling.total,
    );
    // …and not so much more that the default stops being a bound.
    expect(LIVE_FMP_DEFAULT_REQUEST_BUDGET).toBeLessThanOrEqual(
      ceiling.total * 1.5,
    );
  });

  it("can be raised to cover every retry, and no further", () => {
    expect(LIVE_FMP_MAX_REQUEST_BUDGET).toBeGreaterThanOrEqual(
      ceiling.totalWithEveryRetry,
    );
    expect(LIVE_FMP_MAX_REQUEST_BUDGET).toBeLessThanOrEqual(
      ceiling.totalWithEveryRetry * 1.1,
    );
    expect(LIVE_FMP_DEFAULT_REQUEST_BUDGET).toBeLessThan(
      LIVE_FMP_MAX_REQUEST_BUDGET,
    );
  });
});

describe("live FMP dataset classification", () => {
  const included = liveFmpIncludedDatasets(30);

  it("includes only endpoints that answer for one security", () => {
    for (const dataset of included) {
      for (const endpoint of dataset.endpoints) {
        expect(FMP_ENDPOINT_CLASSES.get(endpoint)?.subject, endpoint).toBe(
          "SECURITY",
        );
      }
    }
  });

  it("accounts for every endpoint the client can ask", () => {
    // Each endpoint is either hydrated per security or named in an exclusion with its reason:
    // nothing the client can do is left unclassified.
    const hydrated = new Set(included.flatMap((dataset) => dataset.endpoints));
    const excluded = new Set(
      LIVE_FMP_EXCLUSIONS.flatMap((exclusion) => exclusion.endpoints),
    );
    for (const [endpoint, { subject }] of FMP_ENDPOINT_CLASSES) {
      if (subject === "SECURITY") {
        expect(hydrated, endpoint).toContain(endpoint);
      } else {
        expect(excluded, endpoint).toContain(endpoint);
        expect(hydrated, endpoint).not.toContain(endpoint);
      }
    }
    expect([...hydrated].sort()).toEqual(
      [...FMP_ENDPOINT_CLASSES]
        .filter(([, endpoint]) => endpoint.subject === "SECURITY")
        .map(([path]) => path)
        .sort(),
    );
  });

  it("states the retained horizons from the product's own arithmetic", () => {
    const text = JSON.stringify(included);
    expect(text).toContain("34 years");
    expect(text).toContain("37 years");
    expect(JSON.stringify(liveFmpIncludedDatasets(10))).toContain("14 years");
  });

  it("gives every exclusion a class and a reason", () => {
    expect(LIVE_FMP_EXCLUSIONS.length).toBeGreaterThanOrEqual(6);
    for (const exclusion of LIVE_FMP_EXCLUSIONS) {
      expect(["NOT_APPLICABLE", "PROVIDER_WIDE", "WIDENS_UNIVERSE"]).toContain(
        exclusion.classification,
      );
      expect(exclusion.reason.length, exclusion.operation).toBeGreaterThan(20);
    }
    const operations = LIVE_FMP_EXCLUSIONS.map((entry) => entry.operation).join(
      "\n",
    );
    for (const topic of [
      "catalog",
      "quotes",
      "calendar",
      "Benchmark",
      "Monitor",
      "Backtests",
      "13F",
    ]) {
      expect(operations).toContain(topic);
    }
  });
});
