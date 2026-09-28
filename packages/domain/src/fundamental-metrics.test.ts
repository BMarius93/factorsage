import { describe, expect, it } from "vitest";
import {
  FUNDAMENTAL_METRIC_FIELDS,
  FUNDAMENTAL_METRIC_IDS,
  FUNDAMENTAL_METRIC_UNITS,
  FUNDAMENTAL_METRICS,
  fundamentalMetricDefinition,
} from "./fundamental-metrics.js";

describe("Fundamental Metrics V1 registry", () => {
  it("is exactly the fifteen metrics of the methodology decision, in its order", () => {
    // The one deliberately hard-coded table: identity, storage field and unit as written in
    // `docs/decisions/fundamental-metrics-v1.md`. Every other assertion derives from the registry.
    expect(FUNDAMENTAL_METRICS).toEqual([
      {
        id: "REVENUE_GROWTH_TTM_YOY",
        field: "revenueGrowthTtmYoy",
        unit: "PERCENT",
      },
      { id: "EPS_GROWTH_TTM_YOY", field: "epsGrowthTtmYoy", unit: "PERCENT" },
      { id: "FCF_GROWTH_TTM_YOY", field: "fcfGrowthTtmYoy", unit: "PERCENT" },
      { id: "GROSS_MARGIN_TTM", field: "grossMarginTtm", unit: "PERCENT" },
      {
        id: "OPERATING_MARGIN_TTM",
        field: "operatingMarginTtm",
        unit: "PERCENT",
      },
      { id: "NET_MARGIN_TTM", field: "netMarginTtm", unit: "PERCENT" },
      { id: "FCF_MARGIN_TTM", field: "fcfMarginTtm", unit: "PERCENT" },
      { id: "ROIC_TTM", field: "roicTtm", unit: "PERCENT" },
      { id: "ROE_TTM", field: "roeTtm", unit: "PERCENT" },
      { id: "ROA_TTM", field: "roaTtm", unit: "PERCENT" },
      { id: "DEBT_TO_EQUITY", field: "debtToEquity", unit: "MULTIPLE" },
      { id: "CURRENT_RATIO", field: "currentRatio", unit: "MULTIPLE" },
      {
        id: "NET_DEBT_TO_EBITDA_TTM",
        field: "netDebtToEbitdaTtm",
        unit: "MULTIPLE",
      },
      {
        id: "INTEREST_COVERAGE_TTM",
        field: "interestCoverageTtm",
        unit: "MULTIPLE",
      },
      {
        id: "ASSET_TURNOVER_TTM",
        field: "assetTurnoverTtm",
        unit: "MULTIPLE",
      },
    ]);
  });

  it("keeps every identity and every storage field unique", () => {
    expect(FUNDAMENTAL_METRIC_IDS).toHaveLength(15);
    expect(new Set(FUNDAMENTAL_METRIC_IDS).size).toBe(15);
    expect(FUNDAMENTAL_METRIC_FIELDS).toHaveLength(15);
    expect(new Set(FUNDAMENTAL_METRIC_FIELDS).size).toBe(15);
  });

  it("derives the id and field lists from the registry, in registry order", () => {
    expect(FUNDAMENTAL_METRIC_IDS).toEqual(
      FUNDAMENTAL_METRICS.map((metric) => metric.id),
    );
    expect(FUNDAMENTAL_METRIC_FIELDS).toEqual(
      FUNDAMENTAL_METRICS.map((metric) => metric.field),
    );
  });

  it("gives every metric one of the two units, and ten of them percentage points", () => {
    expect(FUNDAMENTAL_METRIC_UNITS).toEqual(["PERCENT", "MULTIPLE"]);
    expect(
      FUNDAMENTAL_METRICS.filter((metric) => metric.unit === "PERCENT").map(
        (metric) => metric.id,
      ),
    ).toEqual([
      "REVENUE_GROWTH_TTM_YOY",
      "EPS_GROWTH_TTM_YOY",
      "FCF_GROWTH_TTM_YOY",
      "GROSS_MARGIN_TTM",
      "OPERATING_MARGIN_TTM",
      "NET_MARGIN_TTM",
      "FCF_MARGIN_TTM",
      "ROIC_TTM",
      "ROE_TTM",
      "ROA_TTM",
    ]);
    expect(
      FUNDAMENTAL_METRICS.filter((metric) => metric.unit === "MULTIPLE").map(
        (metric) => metric.id,
      ),
    ).toEqual([
      "DEBT_TO_EQUITY",
      "CURRENT_RATIO",
      "NET_DEBT_TO_EBITDA_TTM",
      "INTEREST_COVERAGE_TTM",
      "ASSET_TURNOVER_TTM",
    ]);
  });

  it("contains no valuation ratio: those need a market price and their own methodology", () => {
    for (const metric of FUNDAMENTAL_METRICS) {
      expect(metric.id).not.toMatch(/(^|_)(PE|PS|P_FCF|EV|PRICE)(_|$)/);
      expect(metric.field.toLowerCase()).not.toMatch(
        /price|earningsyield|evtoebitda|ptoe|pe$/,
      );
    }
  });

  it("resolves an identity to its explicit storage field and refuses an unknown one", () => {
    for (const metric of FUNDAMENTAL_METRICS) {
      expect(fundamentalMetricDefinition(metric.id)).toBe(metric);
    }
    expect(fundamentalMetricDefinition("ROIC_TTM").field).toBe("roicTtm");
    expect(() => fundamentalMetricDefinition("PE_TTM" as never)).toThrow(
      "Unsupported fundamental metric PE_TTM",
    );
  });
});
