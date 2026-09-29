import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_SCHEMA_VERSION,
  strategyMetricOptions,
  type FundamentalMetricId,
  type StrategyCondition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { operandAlternativeDataMetric } from "./alternative-data.js";
import {
  collectOperands,
  fundamentalMetricOperand,
  isPositionDependentMetric,
  marginOfSafetyOperand,
  metricOperand,
  operandFundamentalMetricId,
  operandRelativeVolumePeriod,
  operandSeriesId,
  PRICE_OPERAND,
  relativeVolumeOperand,
  seriesOperand,
} from "./operands.js";
import { isMarketDerivedPredicate } from "./predicates.js";

/**
 * The Fundamental Metric operand family: one canonical encoding, owned by `operands.ts`, with its
 * inverse beside it. Nothing else in the repository builds or slices one of these keys.
 */
describe("the fundamental metric operand family", () => {
  it("keys each metric by its stable identity, deterministically", () => {
    expect(fundamentalMetricOperand("ROIC_TTM")).toBe("fundamental:ROIC_TTM");
    expect(fundamentalMetricOperand("REVENUE_GROWTH_TTM_YOY")).toBe(
      "fundamental:REVENUE_GROWTH_TTM_YOY",
    );
    expect(fundamentalMetricOperand("DEBT_TO_EQUITY")).toBe(
      "fundamental:DEBT_TO_EQUITY",
    );
    // The same identity always gives the same key, so two runs request identical projections.
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(fundamentalMetricOperand(id)).toBe(fundamentalMetricOperand(id));
    }
  });

  it("gives fifteen metrics fifteen distinct keys", () => {
    const keys = FUNDAMENTAL_METRIC_IDS.map(fundamentalMetricOperand);
    expect(keys).toHaveLength(15);
    expect(new Set(keys).size).toBe(15);
  });

  it("decodes every key it builds back to the same identity", () => {
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      expect(operandFundamentalMetricId(fundamentalMetricOperand(id))).toBe(id);
    }
  });

  it("never encodes a label or a storage field", () => {
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const key = fundamentalMetricOperand(entry.id);
      expect(key).not.toContain(entry.label);
      expect(key).toBe(`fundamental:${entry.id}`);
    }
  });

  it("decodes nothing that is not one of the catalog's identities", () => {
    for (const key of [
      "fundamental:PE_TTM",
      "fundamental:roic_ttm",
      "fundamental:Roic_Ttm",
      "fundamental:ROIC TTM",
      "fundamental:roicTtm",
      "fundamental:ROIC",
      "fundamental: ROIC_TTM",
      "fundamental:ROIC_TTM ",
      "fundamental:",
      "fundamental",
      "Fundamental:ROIC_TTM",
      "FUNDAMENTAL:ROIC_TTM",
      "fundamentals:ROIC_TTM",
      "ROIC_TTM",
      "",
    ]) {
      expect(operandFundamentalMetricId(key), key).toBeNull();
    }
  });

  it("is disjoint from every other operand family", () => {
    const others = [
      PRICE_OPERAND,
      seriesOperand("SMA_200D"),
      seriesOperand("BALANCED"),
      relativeVolumeOperand(20),
      marginOfSafetyOperand("DCF_FCFF"),
    ];
    for (const key of others) {
      expect(operandFundamentalMetricId(key), key).toBeNull();
    }
    for (const id of FUNDAMENTAL_METRIC_IDS) {
      const key = fundamentalMetricOperand(id);
      expect(operandSeriesId(key), key).toBeNull();
      expect(operandRelativeVolumePeriod(key), key).toBeNull();
      expect(operandAlternativeDataMetric(key), key).toBeNull();
      expect(key).not.toBe(PRICE_OPERAND);
    }
  });
});

function fundamentalCondition(
  metricId: FundamentalMetricId,
  id: string,
): StrategyCondition {
  return {
    id,
    metric: { kind: "FUNDAMENTAL", metricId },
    operator: "IS_ABOVE",
    value: { kind: "PERCENT", value: 1 },
  };
}

function definition(input: {
  buy: StrategyCondition[];
  sell?: StrategyCondition[];
  exit?: StrategyCondition[][];
}): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      { id: "buy-1", percentage: 50, signal: { conditions: input.buy } },
    ],
    sellLevels: input.sell
      ? [{ id: "sell-1", percentage: 50, signal: { conditions: input.sell } }]
      : [],
    ...(input.exit
      ? {
          finalExit: {
            id: "exit-1",
            rules: input.exit.map((conditions, index) => ({
              id: `exit-rule-${index + 1}`,
              signal: { conditions },
            })),
          },
        }
      : {}),
  };
}

const fundamentalKeys = (keys: readonly string[]) =>
  keys.filter((key) => operandFundamentalMetricId(key) !== null);

describe("a Fundamental Strategy metric's operand", () => {
  it("maps every offered Fundamental option to its own column, and never to position state", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      for (const option of strategyMetricOptions(levelKind, "CONDITION")) {
        const key = metricOperand(option.metric);
        if (option.metric.kind === "GAIN" || option.metric.kind === "LOSS") {
          expect(key).toBeNull();
          continue;
        }
        // Every market-derived metric reads a column; none falls through to "no column".
        expect(key, JSON.stringify(option.metric)).not.toBeNull();
        if (option.metric.kind === "FUNDAMENTAL") {
          expect(key).toBe(fundamentalMetricOperand(option.metric.metricId));
          expect(isPositionDependentMetric(option.metric)).toBe(false);
          expect(
            isMarketDerivedPredicate(
              fundamentalCondition(option.metric.metricId, "c"),
            ),
          ).toBe(true);
        }
      }
    }
  });
});

describe("collecting the operands of a strategy with Fundamental Metrics", () => {
  it("collects a metric used twice once", () => {
    const keys = collectOperands(
      definition({
        buy: [fundamentalCondition("ROIC_TTM", "c1")],
        sell: [fundamentalCondition("ROIC_TTM", "c2")],
        exit: [[fundamentalCondition("ROIC_TTM", "c3")]],
      }),
    );
    expect(keys).toEqual([fundamentalMetricOperand("ROIC_TTM"), PRICE_OPERAND]);
  });

  it("collects two metrics as two columns, and none it does not name", () => {
    const keys = collectOperands(
      definition({
        buy: [
          fundamentalCondition("ROIC_TTM", "c1"),
          fundamentalCondition("DEBT_TO_EQUITY", "c2"),
        ],
      }),
    );
    expect(fundamentalKeys(keys)).toEqual([
      fundamentalMetricOperand("DEBT_TO_EQUITY"),
      fundamentalMetricOperand("ROIC_TTM"),
    ]);
    expect(keys).not.toContain(fundamentalMetricOperand("ROE_TTM"));
  });

  it("collects all fifteen as exactly fifteen columns", () => {
    // A Signal holds at most ten Conditions, so the fifteen are spread over the three level kinds.
    const conditions = FUNDAMENTAL_METRIC_IDS.map((id, index) =>
      fundamentalCondition(id, `c${index}`),
    );
    const keys = collectOperands(
      definition({
        buy: conditions.slice(0, 10),
        sell: conditions.slice(10, 13),
        exit: [conditions.slice(13)],
      }),
    );
    expect(fundamentalKeys(keys)).toHaveLength(15);
    expect(new Set(fundamentalKeys(keys))).toEqual(
      new Set(FUNDAMENTAL_METRIC_IDS.map(fundamentalMetricOperand)),
    );
    // Price is always projected, and nothing else was named.
    expect(keys).toHaveLength(16);
    expect(keys).toContain(PRICE_OPERAND);
  });

  it("collects no Fundamental column for a strategy that names none", () => {
    const keys = collectOperands(
      definition({
        buy: [
          {
            id: "c1",
            metric: { kind: "PRICE" },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
        ],
      }),
    );
    expect(fundamentalKeys(keys)).toEqual([]);
    expect(keys).toEqual([PRICE_OPERAND, seriesOperand("SMA_200D")]);
  });

  it("keeps the ascending, deterministic order beside every other family", () => {
    const mixed = definition({
      buy: [
        {
          id: "c1",
          metric: { kind: "PRICE" },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
        fundamentalCondition("ROIC_TTM", "c2"),
        {
          id: "c3",
          metric: { kind: "RELATIVE_VOLUME", period: 20 },
          operator: "IS_ABOVE",
          value: { kind: "MULTIPLE", value: 1.5 },
        },
      ],
    });
    const keys = collectOperands(mixed);
    expect(keys).toEqual([
      fundamentalMetricOperand("ROIC_TTM"),
      PRICE_OPERAND,
      relativeVolumeOperand(20),
      seriesOperand("SMA_200D"),
    ]);
    expect(keys).toEqual([...keys].sort());
    expect(collectOperands(mixed)).toEqual(keys);
  });
});
