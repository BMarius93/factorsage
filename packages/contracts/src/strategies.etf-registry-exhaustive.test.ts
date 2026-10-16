import { describe, expect, it } from "vitest";
import { SELECTABLE_SERIES_CATALOG } from "./selectable-series.js";
import {
  checkStrategyValue,
  CONDITION_OPERATORS,
  conditionOperatorsFor,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_METRIC_KINDS,
  STRATEGY_SCHEMA_VERSION,
  strategyMetricOptions,
  TRIGGER_OPERATORS,
  validateStrategyDefinition,
  type ConditionOperator,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyMetricSource,
  type StrategyTrigger,
  type StrategyValue,
} from "./strategies.js";
import { STRATEGY_ETF_SOURCES } from "./strategy-etf-sources.js";

/**
 * Every allowed ETF / metric / level / operator / Value combination, enumerated from the registry,
 * held to the validator — and everything outside it refused.
 *
 * AGENTS.md invariant 11 requires the Strategy Builder and backend validation to share one
 * compatibility definition. The Builder offers what `strategyMetricOptions`,
 * `conditionOperatorsFor` and `checkStrategyValue` say; the API accepts what
 * `validateStrategyDefinition` says. They are separate code paths, so this suite walks the whole
 * product surface of data-sourced Conditions — the twenty Dashboard ETFs and Stock's Sector, in
 * every level kind — and requires the two to agree on **every** cell: a combination the menu
 * offers must validate, and one it does not must be refused. Then it walks what must never be
 * accepted at all: an ETF Trigger, a source the catalog does not define, a forged source shape, and
 * a source on a metric kind that cannot carry one.
 *
 * Exhaustive rather than sampled (the space is a few hundred thousand documents and validates in
 * seconds), so there is no seed to reproduce: a failure names its cell.
 */

const SOURCES: readonly { label: string; source: StrategyMetricSource }[] = [
  ...STRATEGY_ETF_SOURCES.map((etf) => ({
    label: etf.code,
    source: { kind: "ETF", code: etf.code } as StrategyMetricSource,
  })),
  { label: "STOCK_SECTOR", source: { kind: "STOCK_SECTOR" } },
];

/** Every Value a Condition could be written with: each catalog series and a spread of numbers. */
const CANDIDATE_VALUES: readonly StrategyValue[] = [
  ...SELECTABLE_SERIES_CATALOG.map(
    (series) => ({ kind: "SERIES", seriesId: series.id }) as StrategyValue,
  ),
  ...[-5, 0, 1, 50, 99.5, 100, 101].map(
    (value) => ({ kind: "NUMBER", value }) as StrategyValue,
  ),
  ...[-1, 0, 1.5, 1_000].map(
    (value) => ({ kind: "MULTIPLE", value }) as StrategyValue,
  ),
  ...[-10, 0, 25].map((value) => ({ kind: "PERCENT", value }) as StrategyValue),
];

const BASE_BUY = {
  id: "base-buy",
  percentage: 100,
  signal: {
    conditions: [
      {
        id: "base-c1",
        metric: { kind: "PRICE" },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
    ],
  },
} as const;

/** One document holding `condition` (or `trigger`) in the level kind under test. */
function documentWith(
  level: StrategyLevelKind,
  part: { conditions: StrategyCondition[]; trigger?: StrategyTrigger },
): StrategyDefinition {
  const signal = {
    conditions: part.conditions,
    ...(part.trigger ? { trigger: part.trigger } : {}),
  };
  const definition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels:
      level === "BUY" ? [{ id: "probe", percentage: 100, signal }] : [BASE_BUY],
    sellLevels:
      level === "SELL" ? [{ id: "probe", percentage: 50, signal }] : [],
    ...(level === "FINAL_EXIT"
      ? { finalExit: { id: "probe", rules: [{ id: "probe", signal }] } }
      : {}),
  };
  return definition as unknown as StrategyDefinition;
}

const condition = (
  metric: StrategyMetric,
  operator: string,
  value: StrategyValue,
): StrategyCondition =>
  ({ id: "probe-c1", metric, operator, value }) as unknown as StrategyCondition;

describe("the data-sourced Condition surface, cell by cell", () => {
  it("offers exactly the 21 technical metrics for every source and level, each carrying its source", () => {
    for (const { label, source } of SOURCES) {
      for (const level of STRATEGY_LEVEL_KINDS) {
        const options = strategyMetricOptions(level, "CONDITION", source);
        expect(options, `${label} ${level}`).toHaveLength(21);
        for (const option of options) {
          expect(
            "source" in option.metric && option.metric.source,
            `${label} ${level}`,
          ).toEqual(source);
        }
        expect(
          strategyMetricOptions(level, "TRIGGER", source),
          `${label} ${level} trigger`,
        ).toEqual([]);
      }
    }
  });

  it("validates exactly the combinations the menu and the compatibility helpers admit", () => {
    let accepted = 0;
    let refused = 0;
    const disagreements: string[] = [];
    for (const { label, source } of SOURCES) {
      for (const level of STRATEGY_LEVEL_KINDS) {
        for (const option of strategyMetricOptions(
          level,
          "CONDITION",
          source,
        )) {
          const allowedOperators = new Set<string>(
            conditionOperatorsFor(option.metric),
          );
          for (const operator of CONDITION_OPERATORS) {
            for (const value of CANDIDATE_VALUES) {
              const expected =
                allowedOperators.has(operator) &&
                checkStrategyValue(option.metric, value).compatible;
              const issues = validateStrategyDefinition(
                documentWith(level, {
                  conditions: [
                    condition(
                      option.metric,
                      operator as ConditionOperator,
                      value,
                    ),
                  ],
                }),
              );
              const actual = issues.length === 0;
              if (actual !== expected) {
                disagreements.push(
                  `${label} ${level} ${option.label} ${operator} ${JSON.stringify(value)}: menu says ${
                    expected ? "allowed" : "refused"
                  }, validator ${actual ? "accepted" : `refused (${issues.map((issue) => issue.code).join(",")})`}`,
                );
              }
              if (actual) accepted += 1;
              else refused += 1;
            }
          }
        }
      }
    }
    expect(disagreements.slice(0, 20)).toEqual([]);
    // Both halves of the space are genuinely exercised.
    expect(accepted).toBeGreaterThan(10_000);
    expect(refused).toBeGreaterThan(10_000);
  });

  it("refuses every sourced Trigger, for every source, level, metric, operator and comparable Value", () => {
    let checked = 0;
    for (const { label, source } of SOURCES) {
      for (const level of STRATEGY_LEVEL_KINDS) {
        for (const option of strategyMetricOptions(
          level,
          "CONDITION",
          source,
        )) {
          for (const operator of TRIGGER_OPERATORS) {
            for (const value of CANDIDATE_VALUES.filter(
              (candidate) =>
                checkStrategyValue(option.metric, candidate).compatible,
            )) {
              const trigger = {
                id: "probe-t1",
                metric: option.metric,
                operator,
                value,
              } as unknown as StrategyTrigger;
              const issues = validateStrategyDefinition(
                documentWith(level, { conditions: [], trigger }),
              );
              expect(
                issues.length,
                `${label} ${level} ${option.label} ${operator}`,
              ).toBeGreaterThan(0);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});

describe("sources the product does not define are refused, never read as the stock", () => {
  const TECHNICAL: readonly StrategyMetric[] = [
    { kind: "PRICE" },
    { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
    { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    { kind: "RELATIVE_VOLUME", period: 20 },
  ];
  const valueFor = (metric: StrategyMetric): StrategyValue =>
    metric.kind === "PRICE" || metric.kind === "MOVING_AVERAGE"
      ? { kind: "SERIES", seriesId: "SMA_200D" }
      : metric.kind === "OSCILLATOR"
        ? { kind: "NUMBER", value: 50 }
        : { kind: "MULTIPLE", value: 1.5 };

  const FORGED: readonly unknown[] = [
    // Active benchmark series that are deliberately not Strategy sources.
    { kind: "ETF", code: "SP500_INDEX" },
    { kind: "ETF", code: "DJIA_INDEX" },
    { kind: "ETF", code: "VIX_INDEX" },
    // A ticker is display only; the identity is the benchmark code.
    { kind: "ETF", code: "XLK" },
    { kind: "ETF", code: "SPY" },
    { kind: "ETF", code: "etf_xlk" },
    { kind: "ETF", code: "" },
    { kind: "ETF" },
    { kind: "ETF", code: "ETF_XLK", ticker: "XLK" },
    { kind: "STOCK_SECTOR", code: "ETF_XLK" },
    { kind: "SECTOR" },
    { kind: "INDEX", code: "SP500" },
    { kind: "stock_sector" },
    "ETF_XLK",
    null,
  ];

  it("for every technical metric kind in every level", () => {
    for (const forged of FORGED) {
      for (const base of TECHNICAL) {
        for (const level of STRATEGY_LEVEL_KINDS) {
          const metric = {
            ...base,
            source: forged,
          } as unknown as StrategyMetric;
          const issues = validateStrategyDefinition(
            documentWith(level, {
              conditions: [condition(metric, "IS_ABOVE", valueFor(base))],
            }),
          );
          expect(
            issues.length,
            `${JSON.stringify(forged)} on ${base.kind} in ${level}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("and any source at all on a metric kind that cannot carry one", () => {
    const technical = new Set<string>([
      "PRICE",
      "MOVING_AVERAGE",
      "OSCILLATOR",
      "RELATIVE_VOLUME",
    ]);
    const others = STRATEGY_METRIC_KINDS.filter((kind) => !technical.has(kind));
    expect(others.length).toBeGreaterThan(0);
    for (const level of ["SELL", "FINAL_EXIT"] as const) {
      // Every non-technical kind has at least one instance in a SELL or FINAL EXIT menu.
      const instances = strategyMetricOptions(level, "CONDITION").filter(
        (option) => !technical.has(option.metric.kind),
      );
      for (const option of instances) {
        for (const { source } of SOURCES) {
          const metric = { ...option.metric, source } as StrategyMetric;
          const value =
            CANDIDATE_VALUES.find(
              (candidate) =>
                checkStrategyValue(option.metric, candidate).compatible,
            ) ?? ({ kind: "NUMBER", value: 1 } as StrategyValue);
          const issues = validateStrategyDefinition(
            documentWith(level, {
              conditions: [condition(metric, "IS_ABOVE", value)],
            }),
          );
          expect(
            issues.length,
            `${option.label} with ${JSON.stringify(source)}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });
});
