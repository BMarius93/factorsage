import { describe, expect, it } from "vitest";
import {
  findFundamentalMetric,
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_GROUP_LABELS,
  FUNDAMENTAL_METRIC_GROUPED,
  FUNDAMENTAL_METRIC_GROUPS,
  FUNDAMENTAL_METRIC_IDS,
  FUNDAMENTAL_METRIC_UNITS,
  FUNDAMENTAL_METRICS_LABEL,
  isFundamentalMetricId,
} from "./fundamental-metrics.js";
import { STRATEGY_METRIC_CATEGORY_LABELS } from "./strategies.js";

/**
 * The one deliberate catalog snapshot.
 *
 * Transcribed from the table in `docs/decisions/fundamental-metrics-v1.md` — identity, label, group
 * and unit, in the decision's order — plus the threshold floor each metric's own mathematics gives.
 * Every other assertion below derives from the catalog, so changing a metric means changing the
 * decision and this table together, and nothing else here.
 */
const EXPECTED_CATALOG = [
  [
    "REVENUE_GROWTH_TTM_YOY",
    "Revenue Growth TTM YoY",
    "GROWTH",
    "PERCENT",
    -100,
  ],
  ["EPS_GROWTH_TTM_YOY", "EPS Growth TTM YoY", "GROWTH", "PERCENT", -100],
  ["FCF_GROWTH_TTM_YOY", "FCF Growth TTM YoY", "GROWTH", "PERCENT", -100],
  [
    "GROSS_MARGIN_TTM",
    "Gross Margin TTM",
    "PROFITABILITY",
    "PERCENT",
    undefined,
  ],
  [
    "OPERATING_MARGIN_TTM",
    "Operating Margin TTM",
    "PROFITABILITY",
    "PERCENT",
    undefined,
  ],
  ["NET_MARGIN_TTM", "Net Margin TTM", "PROFITABILITY", "PERCENT", undefined],
  ["FCF_MARGIN_TTM", "FCF Margin TTM", "PROFITABILITY", "PERCENT", undefined],
  ["ROIC_TTM", "ROIC TTM", "QUALITY", "PERCENT", undefined],
  ["ROE_TTM", "ROE TTM", "QUALITY", "PERCENT", undefined],
  ["ROA_TTM", "ROA TTM", "QUALITY", "PERCENT", undefined],
  ["DEBT_TO_EQUITY", "Debt / Equity", "LEVERAGE", "MULTIPLE", 0],
  ["CURRENT_RATIO", "Current Ratio", "LIQUIDITY", "MULTIPLE", 0],
  [
    "NET_DEBT_TO_EBITDA_TTM",
    "Net Debt / EBITDA TTM",
    "LEVERAGE",
    "MULTIPLE",
    undefined,
  ],
  [
    "INTEREST_COVERAGE_TTM",
    "Interest Coverage TTM",
    "SOLVENCY",
    "MULTIPLE",
    undefined,
  ],
  ["ASSET_TURNOVER_TTM", "Asset Turnover TTM", "EFFICIENCY", "MULTIPLE", 0],
] as const;

describe("the Fundamental Metrics product catalog", () => {
  it("is exactly the fifteen metrics of the methodology decision, in its order", () => {
    expect(
      FUNDAMENTAL_METRIC_CATALOG.map((entry) => [
        entry.id,
        entry.label,
        entry.group,
        entry.unit,
        "minimum" in entry ? entry.minimum : undefined,
      ]),
    ).toEqual(EXPECTED_CATALOG.map((row) => [...row]));
  });

  it("keeps every identity and every label unique", () => {
    expect(FUNDAMENTAL_METRIC_IDS).toHaveLength(15);
    expect(new Set(FUNDAMENTAL_METRIC_IDS).size).toBe(15);
    const labels = FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(15);
    expect(FUNDAMENTAL_METRIC_IDS).toEqual(
      EXPECTED_CATALOG.map((row) => row[0]),
    );
  });

  it("never derives an identity from its label, nor a label from its identity", () => {
    // Identity and label are two independently written columns, not case transformations of one
    // another — `ROIC_TTM` is not `ROIC TTM` upper-cased and snake-cased by some helper.
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      expect(entry.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(entry.label).not.toBe(entry.id);
      expect(isFundamentalMetricId(entry.label)).toBe(false);
    }
  });

  it("uses only the two units and the methodology's groups, every group used", () => {
    expect(FUNDAMENTAL_METRIC_UNITS).toEqual(["PERCENT", "MULTIPLE"]);
    expect(FUNDAMENTAL_METRIC_GROUPS).toEqual([
      "GROWTH",
      "PROFITABILITY",
      "QUALITY",
      "LEVERAGE",
      "LIQUIDITY",
      "SOLVENCY",
      "EFFICIENCY",
    ]);
    expect(FUNDAMENTAL_METRIC_GROUP_LABELS).toEqual({
      GROWTH: "Growth",
      PROFITABILITY: "Profitability",
      QUALITY: "Quality",
      LEVERAGE: "Leverage",
      LIQUIDITY: "Liquidity",
      SOLVENCY: "Solvency",
      EFFICIENCY: "Efficiency",
    });
    expect(
      new Set(FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.group)),
    ).toEqual(new Set(FUNDAMENTAL_METRIC_GROUPS));
  });

  it("explains every metric with a summary and a formula of its own", () => {
    const summaries = new Set<string>();
    const formulas = new Set<string>();
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      expect(entry.summary.length, entry.id).toBeGreaterThan(20);
      expect(entry.formula.length, entry.id).toBeGreaterThan(10);
      // Help text is plain prose: the explanation panel renders it as text, so markdown would show.
      expect(`${entry.summary} ${entry.formula}`).not.toMatch(/[`*_]{1,2}\w/);
      summaries.add(entry.summary);
      formulas.add(entry.formula);
    }
    expect(summaries.size).toBe(15);
    expect(formulas.size).toBe(15);
    // Percentages are percentage points: every percentage formula scales by 100, and no multiple does.
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      expect(entry.formula.includes("* 100"), entry.id).toBe(
        entry.unit === "PERCENT",
      );
    }
  });

  it("contains no valuation ratio, which needs a market price and its own methodology", () => {
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      expect(entry.id).not.toMatch(/(^|_)(PE|PS|P_FCF|EV|PRICE)(_|$)/);
      expect(entry.label).not.toMatch(
        /\bP\/E\b|\bP\/S\b|P\/FCF|EV\/EBITDA|Price/,
      );
    }
  });

  it("recognizes an identity by exact match only", () => {
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(isFundamentalMetricId(id)).toBe(true);
      expect(findFundamentalMetric(id)?.id).toBe(id);
    }
    for (const candidate of [
      "roic_ttm",
      "Roic_Ttm",
      "ROIC TTM",
      " ROIC_TTM",
      "ROIC_TTM ",
      "ROIC",
      "PE_TTM",
      "",
      "roicTtm",
    ]) {
      expect(isFundamentalMetricId(candidate), candidate).toBe(false);
      expect(findFundamentalMetric(candidate), candidate).toBeUndefined();
    }
    for (const candidate of [undefined, null, 7, {}, ["ROIC_TTM"]]) {
      expect(isFundamentalMetricId(candidate)).toBe(false);
    }
  });

  it("groups every metric exactly once, in group order and catalog order", () => {
    // The shape a grouped surface renders, written out by hand: the two Leverage metrics sit
    // together although the flat catalog lists Current Ratio between them.
    expect(
      FUNDAMENTAL_METRIC_GROUPED.map((group) => [
        group.label,
        group.metrics.map((metric) => metric.id),
      ]),
    ).toEqual([
      [
        "Growth",
        ["REVENUE_GROWTH_TTM_YOY", "EPS_GROWTH_TTM_YOY", "FCF_GROWTH_TTM_YOY"],
      ],
      [
        "Profitability",
        [
          "GROSS_MARGIN_TTM",
          "OPERATING_MARGIN_TTM",
          "NET_MARGIN_TTM",
          "FCF_MARGIN_TTM",
        ],
      ],
      ["Quality", ["ROIC_TTM", "ROE_TTM", "ROA_TTM"]],
      ["Leverage", ["DEBT_TO_EQUITY", "NET_DEBT_TO_EBITDA_TTM"]],
      ["Liquidity", ["CURRENT_RATIO"]],
      ["Solvency", ["INTEREST_COVERAGE_TTM"]],
      ["Efficiency", ["ASSET_TURNOVER_TTM"]],
    ]);

    // Derived, not restated: the same entries as the flat catalog, each once.
    const grouped = FUNDAMENTAL_METRIC_GROUPED.flatMap(
      (group) => group.metrics,
    );
    expect(grouped).toHaveLength(FUNDAMENTAL_METRIC_CATALOG.length);
    expect(new Set(grouped.map((metric) => metric.id))).toEqual(
      new Set(FUNDAMENTAL_METRIC_IDS),
    );
    for (const group of FUNDAMENTAL_METRIC_GROUPED) {
      expect(group.label).toBe(FUNDAMENTAL_METRIC_GROUP_LABELS[group.id]);
      expect(group.metrics.every((metric) => metric.group === group.id)).toBe(
        true,
      );
      const positions = group.metrics.map((metric) =>
        FUNDAMENTAL_METRIC_IDS.indexOf(metric.id),
      );
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
    expect(FUNDAMENTAL_METRIC_GROUPED.map((group) => group.id)).toEqual(
      FUNDAMENTAL_METRIC_GROUPS,
    );
  });

  it("names the family once, for every surface that offers it", () => {
    expect(FUNDAMENTAL_METRICS_LABEL).toBe("Fundamentals");
    expect(STRATEGY_METRIC_CATEGORY_LABELS.FUNDAMENTALS).toBe(
      FUNDAMENTAL_METRICS_LABEL,
    );
  });
});
