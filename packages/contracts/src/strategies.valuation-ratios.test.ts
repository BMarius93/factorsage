import { describe, expect, it } from "vitest";
import {
  conditionOperatorsFor,
  defaultValueFor,
  describeCondition,
  normalizeStrategyDefinition,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_METRIC_CATEGORY_LABELS,
  STRATEGY_METRIC_HELP,
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionFingerprint,
  strategyMetricCategories,
  strategyMetricHelp,
  strategyMetricLabel,
  strategyMetricOptions,
  strategySignalFingerprint,
  triggerOperatorsFor,
  validateStrategyDefinition,
  valueSpecFor,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
  type StrategyValidationIssue,
  type StrategyValue,
} from "./strategies.js";
import {
  findValuationRatio,
  isValuationRatioId,
  VALUATION_RATIO_CATALOG,
  VALUATION_RATIO_IDS,
  VALUATION_RATIOS_LABEL,
  type ValuationRatioId,
} from "./valuation-ratios.js";

/**
 * The five Valuation Ratios as Strategy Conditions (`docs/decisions/valuation-ratios-v1.md`,
 * "Strategy Conditions, backtests and Monitors"): one kind in the Valuation category, Conditions
 * only with the strict pair, raw multiples floored where the ratio's mathematics is, the identity in
 * the fingerprint, and nothing about how availability is decided in the document.
 */

function ratio(ratioId: ValuationRatioId): StrategyMetric {
  return { kind: "VALUATION_RATIO", ratioId };
}

function multiple(value: number): StrategyValue {
  return { kind: "MULTIPLE", value };
}

function condition(
  metric: StrategyMetric,
  value: StrategyValue,
  id = "condition-1",
  operator: StrategyCondition["operator"] = "IS_BELOW",
): StrategyCondition {
  return { id, metric, operator, value };
}

function definitionOf(signal: StrategySignal): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", signal, percentage: 25 }],
    sellLevels: [],
  };
}

function codesOf(issues: readonly StrategyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("the Valuation Ratio catalog", () => {
  it("names exactly five ratios, in canonical order, by the owner's labels", () => {
    expect(VALUATION_RATIO_CATALOG.map((entry) => entry.label)).toEqual([
      "P/E",
      "P/S",
      "P/B",
      "P/FCF",
      "EV/EBITDA",
    ]);
    expect(VALUATION_RATIO_IDS).toEqual([
      "PRICE_TO_EARNINGS_TTM",
      "PRICE_TO_SALES_TTM",
      "PRICE_TO_BOOK",
      "PRICE_TO_FCF_TTM",
      "EV_TO_EBITDA_TTM",
    ]);
  });

  it("recognises an identity only by exact match", () => {
    expect(isValuationRatioId("PRICE_TO_BOOK")).toBe(true);
    for (const value of ["P/B", "price_to_book", "PE", "", null, 3]) {
      expect(isValuationRatioId(value)).toBe(false);
    }
    expect(findValuationRatio("P/E")).toBeUndefined();
  });

  it("names the family once, for every surface that offers it", () => {
    // The Strategy Builder's category and the Stock Details chart's section read one label.
    expect(VALUATION_RATIOS_LABEL).toBe("Valuation");
    expect(STRATEGY_METRIC_CATEGORY_LABELS.VALUATION).toBe(
      VALUATION_RATIOS_LABEL,
    );
  });
});

describe("Valuation Ratios in the Strategy Builder", () => {
  it("sit in the Valuation category after Margin of Safety, in every level, and never in a Trigger", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      const valuation = strategyMetricCategories(levelKind, "CONDITION").find(
        (category) => category.id === "VALUATION",
      );
      const labels = valuation!.options.map((option) => option.label);
      expect(labels.slice(-5)).toEqual([
        "P/E",
        "P/S",
        "P/B",
        "P/FCF",
        "EV/EBITDA",
      ]);
      expect(labels[0]).toMatch(/^Margin of Safety/);
      expect(
        strategyMetricOptions(levelKind, "TRIGGER").some(
          (option) => option.metric.kind === "VALUATION_RATIO",
        ),
      ).toBe(false);
    }
  });

  it("offers the strict comparison pair and no Trigger operator", () => {
    for (const id of VALUATION_RATIO_IDS) {
      expect(conditionOperatorsFor(ratio(id))).toEqual([
        "IS_ABOVE",
        "IS_BELOW",
      ]);
      expect(triggerOperatorsFor(ratio(id))).toEqual([]);
    }
  });

  it("takes a raw multiple, floored at zero except for EV/EBITDA, starting at 1x", () => {
    for (const id of VALUATION_RATIO_IDS) {
      const spec = valueSpecFor(ratio(id));
      expect(spec).toEqual(
        id === "EV_TO_EBITDA_TTM"
          ? { kind: "MULTIPLE", step: 0.1 }
          : { kind: "MULTIPLE", min: 0, step: 0.1 },
      );
      expect(defaultValueFor(ratio(id))).toEqual(multiple(1));
    }
  });

  it("reads `P/E is below 15` and shows no availability machinery", () => {
    expect(strategyMetricLabel(ratio("PRICE_TO_EARNINGS_TTM"))).toBe("P/E");
    expect(
      describeCondition(
        condition(ratio("PRICE_TO_EARNINGS_TTM"), multiple(15)),
      ),
    ).toBe("P/E is below 15.0x");
  });

  it("explains each ratio with its own summary and formula, and says an unavailable ratio does not match", () => {
    const help = strategyMetricHelp(ratio("EV_TO_EBITDA_TTM"));
    expect(help.summary).toBe(findValuationRatio("EV_TO_EBITDA_TTM")!.summary);
    expect(help.formula).toBe(findValuationRatio("EV_TO_EBITDA_TTM")!.formula);
    expect(help.notes).toEqual(STRATEGY_METRIC_HELP.VALUATION_RATIO.notes);
    expect(help.notEvaluableWhen).toContain("a condition on it never matches");
  });
});

describe("a Valuation Ratio in a stored or submitted document", () => {
  it("accepts every ratio below and above a threshold, in every level kind", () => {
    for (const id of VALUATION_RATIO_IDS) {
      expect(
        validateStrategyDefinition(
          definitionOf({ conditions: [condition(ratio(id), multiple(15))] }),
        ),
      ).toEqual([]);
    }
  });

  it("refuses an identity the catalog does not define, and anything beside the identity", () => {
    const raw = (metric: unknown): unknown => ({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 25,
          signal: {
            conditions: [
              { id: "c1", metric, operator: "IS_BELOW", value: multiple(15) },
            ],
          },
        },
      ],
      sellLevels: [],
    });
    expect(
      codesOf(
        validateStrategyDefinition(
          raw({
            kind: "VALUATION_RATIO",
            ratioId: "P/E",
          }) as StrategyDefinition,
        ),
      ),
    ).toEqual(["VALUATION_RATIO_UNSUPPORTED"]);
    expect(
      codesOf(
        validateStrategyDefinition(
          raw({
            kind: "VALUATION_RATIO",
            ratioId: "PRICE_TO_BOOK",
            label: "P/B",
          }) as StrategyDefinition,
        ),
      ),
    ).not.toEqual([]);
  });

  it("refuses a negative threshold where the ratio cannot be negative, and allows one for EV/EBITDA", () => {
    expect(
      codesOf(
        validateStrategyDefinition(
          definitionOf({
            conditions: [
              condition(ratio("PRICE_TO_EARNINGS_TTM"), multiple(-1)),
            ],
          }),
        ),
      ),
    ).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    expect(
      validateStrategyDefinition(
        definitionOf({
          conditions: [condition(ratio("EV_TO_EBITDA_TTM"), multiple(-1))],
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a Valuation Ratio as a Trigger", () => {
    const issues = validateStrategyDefinition(
      definitionOf({
        conditions: [condition(ratio("PRICE_TO_SALES_TTM"), multiple(2))],
        trigger: {
          id: "t1",
          metric: ratio("PRICE_TO_EARNINGS_TTM"),
          operator: "CROSSES_BELOW",
          value: multiple(15),
        },
      }),
    );
    expect(codesOf(issues)).toContain("METRIC_NOT_ALLOWED_IN_PART");
  });
});

describe("a Valuation Ratio's identity in the fingerprint and in duplicate detection", () => {
  const signalWith = (id: ValuationRatioId): StrategySignal => ({
    conditions: [condition(ratio(id), multiple(15))],
  });

  it("serializes the identity as the metric's third element, byte for byte", () => {
    expect(
      strategyDefinitionFingerprint(
        definitionOf(signalWith("PRICE_TO_EARNINGS_TTM")),
      ),
    ).toBe(
      '[1,[[25,[[[["VALUATION_RATIO",null,"PRICE_TO_EARNINGS_TTM"],"IS_BELOW",["MULTIPLE",15]]],null]]],[],null]',
    );
  });

  it("gives the five ratios five different fingerprints under one rule", () => {
    const fingerprints = VALUATION_RATIO_IDS.map((id) =>
      strategySignalFingerprint(signalWith(id)),
    );
    expect(new Set(fingerprints).size).toBe(5);
  });

  it("is stable across a serialize-and-reload", () => {
    const definition = definitionOf(signalWith("PRICE_TO_BOOK"));
    expect(
      strategyDefinitionFingerprint(
        normalizeStrategyDefinition(JSON.parse(JSON.stringify(definition))),
      ),
    ).toBe(strategyDefinitionFingerprint(definition));
  });

  it("accepts two ratios under one rule and rejects one ratio written twice", () => {
    expect(
      validateStrategyDefinition(
        definitionOf({
          conditions: [
            condition(ratio("PRICE_TO_EARNINGS_TTM"), multiple(15), "c1"),
            condition(ratio("PRICE_TO_SALES_TTM"), multiple(15), "c2"),
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      codesOf(
        validateStrategyDefinition(
          definitionOf({
            conditions: [
              condition(ratio("PRICE_TO_EARNINGS_TTM"), multiple(15), "c1"),
              condition(ratio("PRICE_TO_EARNINGS_TTM"), multiple(15), "c2"),
            ],
          }),
        ),
      ),
    ).toEqual(["DUPLICATE_CONDITION"]);
  });
});
