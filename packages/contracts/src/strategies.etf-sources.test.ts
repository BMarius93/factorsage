import { describe, expect, it } from "vitest";
import {
  checkStrategyValue,
  collectStrategyEtfSources,
  conditionOperatorsFor,
  defaultValueFor,
  describeCondition,
  describeStrategy,
  ETF_COMPATIBLE_METRIC_KINDS,
  normalizeStrategyDefinition,
  rekeyStrategyDefinition,
  STRATEGY_METRIC_KINDS,
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionFingerprint,
  strategyMetricFamilies,
  strategyMetricHelp,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricCategories,
  strategyMetricOptions,
  strategyMetricSource,
  strategySignalFingerprint,
  triggerOperatorsFor,
  validateStrategyDefinition,
  valueSpecFor,
  withoutMetricSource,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategyMetricSource,
  type StrategySignal,
  type StrategyValidationIssue,
} from "./strategies.js";
import {
  findStrategyEtfSource,
  isStrategyEtfSourceCode,
  STRATEGY_ETF_SOURCE_GROUPS,
  STRATEGY_ETF_SOURCES,
  type StrategyEtfSourceCode,
} from "./strategy-etf-sources.js";
import {
  MOVING_AVERAGE_SERIES,
  OSCILLATOR_SERIES,
  PRICE_COMPARABLE_SERIES,
} from "./selectable-series.js";

const XLK: StrategyMetricSource = { kind: "ETF", code: "ETF_XLK" };
const SPY: StrategyMetricSource = { kind: "ETF", code: "SP500" };
const GLD: StrategyMetricSource = { kind: "ETF", code: "ETF_GLD" };

function definitionOf(
  conditions: StrategyCondition[],
  extra: Partial<StrategyDefinition> = {},
): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", signal: { conditions }, percentage: 25 }],
    sellLevels: [],
    ...extra,
  };
}

function codesOf(issues: readonly StrategyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function etfRsi(
  code: StrategyEtfSourceCode,
  value: number,
  id = "condition-1",
): StrategyCondition {
  return {
    id,
    metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source: { kind: "ETF", code } },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value },
  };
}

describe("the ETF source catalog", () => {
  it("offers exactly the twenty Dashboard ETFs in their three groups", () => {
    expect(STRATEGY_ETF_SOURCES).toHaveLength(20);
    expect(STRATEGY_ETF_SOURCE_GROUPS.map((group) => group.id)).toEqual([
      "BENCHMARKS",
      "US_SECTORS",
      "MACRO_ALTERNATIVES",
    ]);
    expect(
      STRATEGY_ETF_SOURCE_GROUPS.map((group) => group.etfs.length),
    ).toEqual([5, 11, 4]);
    expect(STRATEGY_ETF_SOURCES.map((etf) => etf.ticker)).toEqual([
      "SPY", "QQQ", "DIA", "IWM", "RSP",
      "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
      "GLD", "USO", "TLT", "HYG",
    ]);
  });

  it("stores the benchmark code, with SPY naming the existing SP500 series", () => {
    expect(findStrategyEtfSource("SP500")?.ticker).toBe("SPY");
    expect(isStrategyEtfSourceCode("SP500")).toBe(true);
    expect(isStrategyEtfSourceCode("ETF_XLK")).toBe(true);
    // The ticker is display identity, never the stored one.
    expect(isStrategyEtfSourceCode("SPY")).toBe(false);
    expect(isStrategyEtfSourceCode("XLK")).toBe(false);
    expect(isStrategyEtfSourceCode("^GSPC")).toBe(false);
  });
});

describe("the ETF metric menu", () => {
  it("offers exactly the 21 technical metrics per ETF, from the registry itself", () => {
    for (const etf of STRATEGY_ETF_SOURCES) {
      const source: StrategyMetricSource = { kind: "ETF", code: etf.code };
      const options = strategyMetricOptions("BUY", "CONDITION", source);
      expect(options).toHaveLength(21);
      // 1 Price + 14 moving averages + 3 RSI + 3 RVOL, in canonical category order.
      expect(options.map((option) => option.metric.kind)).toEqual([
        "PRICE",
        ...Array.from({ length: 14 }, () => "MOVING_AVERAGE"),
        ...Array.from({ length: 3 }, () => "OSCILLATOR"),
        ...Array.from({ length: 3 }, () => "RELATIVE_VOLUME"),
      ]);
      for (const option of options) {
        expect(strategyMetricSource(option.metric)).toEqual(source);
      }
    }
  });

  it("offers only the four technical categories, in every level kind", () => {
    for (const levelKind of ["BUY", "SELL", "FINAL_EXIT"] as const) {
      const categories = strategyMetricCategories(levelKind, "CONDITION", XLK);
      expect(categories.map((category) => category.id)).toEqual([
        "PRICE",
        "MOVING_AVERAGES",
        "OSCILLATORS",
        "VOLUME",
      ]);
    }
  });

  it("offers nothing as a Trigger under an ETF source", () => {
    expect(strategyMetricOptions("BUY", "TRIGGER", XLK)).toHaveLength(0);
    expect(strategyMetricCategories("SELL", "TRIGGER", SPY)).toHaveLength(0);
  });

  it("partitions the families: only Technical for an ETF, the full set for Stock", () => {
    expect(
      strategyMetricFamilies("BUY", "CONDITION", XLK).map((family) => family.id),
    ).toEqual(["TECHNICAL"]);
    expect(
      strategyMetricFamilies("BUY", "CONDITION").map((family) => family.id),
    ).toEqual(["TECHNICAL", "FUNDAMENTALS", "VALUATION", "ACTIVITY"]);
    expect(
      strategyMetricFamilies("SELL", "CONDITION").map((family) => family.id),
    ).toEqual([
      "TECHNICAL",
      "FUNDAMENTALS",
      "VALUATION",
      "ACTIVITY",
      "POSITION",
    ]);
    const technical = strategyMetricFamilies("BUY", "CONDITION")[0];
    expect(technical?.categories.map((category) => category.id)).toEqual([
      "PRICE",
      "MOVING_AVERAGES",
      "OSCILLATORS",
      "VOLUME",
    ]);
  });

  it("leaves the stock menus byte-identical to what they were", () => {
    const stock = strategyMetricOptions("BUY", "CONDITION");
    for (const option of stock) {
      expect(strategyMetricSource(option.metric)).toBeUndefined();
    }
  });
});

describe("validation of ETF-sourced conditions", () => {
  it("accepts each of the four technical kinds with an ETF source", () => {
    const conditions: StrategyCondition[] = [
      {
        id: "c-price",
        metric: { kind: "PRICE", source: SPY },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      {
        id: "c-ma",
        metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      etfRsi("ETF_XLK", 50, "c-rsi"),
      {
        id: "c-rvol",
        metric: { kind: "RELATIVE_VOLUME", period: 20, source: GLD },
        operator: "IS_ABOVE",
        value: { kind: "MULTIPLE", value: 1.5 },
      },
    ];
    expect(validateStrategyDefinition(definitionOf(conditions))).toEqual([]);
  });

  it("supports mixed Stock and ETF conditions in one Signal, in every level kind", () => {
    const signal = (prefix: string): StrategySignal => ({
      conditions: [
        {
          id: `${prefix}-stock`,
          metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
          operator: "IS_BELOW",
          value: { kind: "NUMBER", value: 40 },
        },
        etfRsi("ETF_XLK", 50, `${prefix}-etf`),
      ],
    });
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "buy-1", signal: signal("buy"), percentage: 25 }],
      sellLevels: [{ id: "sell-1", signal: signal("sell"), percentage: 50 }],
      finalExit: { id: "exit-1", rules: [{ id: "rule-1", signal: signal("exit") }] },
    };
    expect(validateStrategyDefinition(definition)).toEqual([]);
  });

  it("refuses a source on every non-technical metric kind, forged payloads included", () => {
    const incompatible = STRATEGY_METRIC_KINDS.filter(
      (kind) => !(ETF_COMPATIBLE_METRIC_KINDS as readonly string[]).includes(kind),
    );
    expect(incompatible).toEqual([
      "MARGIN_OF_SAFETY",
      "VALUATION_RATIO",
      "FUNDAMENTAL",
      "GAIN",
      "LOSS",
      "INSIDER_ACTIVITY",
      "CONGRESS_ACTIVITY",
    ]);
    const forged: Record<string, unknown>[] = [
      { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED", source: XLK },
      { kind: "VALUATION_RATIO", ratioId: "PE", source: XLK },
      { kind: "FUNDAMENTAL", metricId: "ROIC_TTM", source: XLK },
      { kind: "GAIN", source: XLK },
      {
        kind: "INSIDER_ACTIVITY",
        measure: "INSIDER_BUYERS",
        lookback: 20,
        source: XLK,
      },
    ];
    for (const metric of forged) {
      const issues = validateStrategyDefinition(
        definitionOf(
          [
            {
              id: "c-1",
              metric: metric as unknown as StrategyMetric,
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 10 },
            },
          ],
          metric.kind === "GAIN"
            ? {
              buyLevels: [
                {
                  id: "buy-1",
                  signal: {
                    conditions: [
                      {
                        id: "c-buy",
                        metric: { kind: "PRICE" },
                        operator: "IS_ABOVE",
                        value: { kind: "SERIES", seriesId: "SMA_200D" },
                      },
                    ],
                  },
                  percentage: 25,
                },
              ],
              sellLevels: [
                {
                  id: "sell-1",
                  signal: {
                    conditions: [
                      {
                        id: "c-1",
                        metric: metric as unknown as StrategyMetric,
                        operator: "IS_ABOVE",
                        value: { kind: "PERCENT", value: 10 },
                      },
                    ],
                  },
                  percentage: 50,
                },
              ],
            }
            : {},
        ),
      );
      expect(codesOf(issues)).toContain("UNKNOWN_FIELD");
    }
  });

  it("refuses an ETF the catalog does not define, never reading it as the stock", () => {
    const issues = validateStrategyDefinition(
      definitionOf([
        {
          id: "c-1",
          metric: {
            kind: "OSCILLATOR",
            seriesId: "RSI_14D",
            source: { kind: "ETF", code: "ETF_NOPE" },
          } as unknown as StrategyMetric,
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 50 },
        },
      ]),
    );
    expect(codesOf(issues)).toEqual(["SOURCE_INVALID"]);
    // A ticker is a display identity, not a stored one, so it is refused too.
    const byTicker = validateStrategyDefinition(
      definitionOf([
        {
          id: "c-1",
          metric: {
            kind: "PRICE",
            source: { kind: "ETF", code: "XLK" },
          } as unknown as StrategyMetric,
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
      ]),
    );
    expect(codesOf(byTicker)).toEqual(["SOURCE_INVALID"]);
  });

  it("refuses a malformed source: an unknown kind, a missing code, extra keys", () => {
    for (const source of [
      "ETF_XLK",
      { kind: "INDEX", code: "SP500_INDEX" },
      { kind: "ETF" },
      { kind: "ETF", code: "ETF_XLK", symbol: "XLK" },
    ]) {
      const issues = validateStrategyDefinition(
        definitionOf([
          {
            id: "c-1",
            metric: {
              kind: "PRICE",
              source,
            } as unknown as StrategyMetric,
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
        ]),
      );
      expect(
        codesOf(issues).some(
          (code) => code === "SOURCE_INVALID" || code === "UNKNOWN_FIELD",
        ),
      ).toBe(true);
    }
  });

  it("refuses an ETF-sourced Trigger: ETF sources are a Condition capability only", () => {
    const issues = validateStrategyDefinition(
      definitionOf([], {
        buyLevels: [
          {
            id: "buy-1",
            signal: {
              conditions: [],
              trigger: {
                id: "t-1",
                metric: { kind: "PRICE", source: XLK },
                operator: "CROSSES_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            },
            percentage: 25,
          },
        ],
      }),
    );
    expect(codesOf(issues)).toEqual(["SOURCE_NOT_ALLOWED_IN_PART"]);
    // A stock Trigger beside an ETF Condition stays exactly as supported as it was.
    const mixed = validateStrategyDefinition(
      definitionOf([], {
        buyLevels: [
          {
            id: "buy-1",
            signal: {
              conditions: [etfRsi("ETF_XLK", 50)],
              trigger: {
                id: "t-1",
                metric: { kind: "PRICE" },
                operator: "CROSSES_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            },
            percentage: 25,
          },
        ],
      }),
    );
    expect(mixed).toEqual([]);
  });

  it("holds ETF RSI to the same 1..100 domain and ETF RVOL to a non-negative multiple", () => {
    const high = validateStrategyDefinition(
      definitionOf([etfRsi("ETF_XLK", 101)]),
    );
    expect(codesOf(high)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
    const negative = validateStrategyDefinition(
      definitionOf([
        {
          id: "c-1",
          metric: { kind: "RELATIVE_VOLUME", period: 20, source: GLD },
          operator: "IS_ABOVE",
          value: { kind: "MULTIPLE", value: -1 },
        },
      ]),
    );
    expect(codesOf(negative)).toEqual(["VALUE_OUT_OF_DOMAIN"]);
  });
});

describe("ETF Value compatibility", () => {
  it("narrows ETF Price to the fourteen moving averages: intrinsic values are not ETF Values", () => {
    const spec = valueSpecFor({ kind: "PRICE", source: XLK });
    expect(spec).toEqual({
      kind: "SERIES",
      seriesIds: MOVING_AVERAGE_SERIES.map((series) => series.id),
    });
    // The stock spec is untouched and still offers the intrinsic series.
    expect(valueSpecFor({ kind: "PRICE" })).toEqual({
      kind: "SERIES",
      seriesIds: PRICE_COMPARABLE_SERIES.map((series) => series.id),
    });
    for (const intrinsicValue of ["BALANCED", "DCF_FCFF", "GRAHAM"] as const) {
      const result = checkStrategyValue(
        { kind: "PRICE", source: XLK },
        { kind: "SERIES", seriesId: intrinsicValue },
      );
      expect(result.compatible).toBe(false);
      if (!result.compatible) {
        expect(result.code).toBe("SERIES_NOT_COMPARABLE");
      }
    }
    const document = validateStrategyDefinition(
      definitionOf([
        {
          id: "c-1",
          metric: { kind: "PRICE", source: XLK },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "BALANCED" },
        },
      ]),
    );
    expect(codesOf(document)).toEqual(["SERIES_NOT_COMPARABLE"]);
  });

  it("keeps the moving-average rules under a source: same timeframe, never itself", () => {
    const sameTimeframe = checkStrategyValue(
      { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK },
      { kind: "SERIES", seriesId: "SMA_200D" },
    );
    expect(sameTimeframe.compatible).toBe(true);
    const itself = checkStrategyValue(
      { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK },
      { kind: "SERIES", seriesId: "SMA_50D" },
    );
    expect(itself.compatible).toBe(false);
    const crossTimeframe = checkStrategyValue(
      { kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK },
      { kind: "SERIES", seriesId: "SMA_50W" },
    );
    expect(crossTimeframe.compatible).toBe(false);
  });

  it("keeps the operator sets: is close to for price-scale, none for RVOL triggers", () => {
    expect(conditionOperatorsFor({ kind: "PRICE", source: XLK })).toEqual([
      "IS_ABOVE",
      "IS_BELOW",
      "IS_CLOSE_TO",
    ]);
    expect(
      conditionOperatorsFor({
        kind: "OSCILLATOR",
        seriesId: "RSI_14D",
        source: XLK,
      }),
    ).toEqual(["IS_ABOVE", "IS_BELOW"]);
    expect(
      triggerOperatorsFor({ kind: "RELATIVE_VOLUME", period: 20, source: GLD }),
    ).toEqual([]);
  });

  it("derives the same defaults: the first moving average, the RSI midpoint, 1x", () => {
    expect(defaultValueFor({ kind: "PRICE", source: XLK })).toEqual({
      kind: "SERIES",
      seriesId: MOVING_AVERAGE_SERIES[0]?.id,
    });
    expect(
      defaultValueFor({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK }),
    ).toEqual({ kind: "NUMBER", value: 50 });
    expect(
      defaultValueFor({ kind: "RELATIVE_VOLUME", period: 20, source: GLD }),
    ).toEqual({ kind: "MULTIPLE", value: 1 });
  });
});

describe("identity: duplicates, keys, normalization", () => {
  it("treats the stock and each ETF as different conditions, and same-ETF repeats as duplicates", () => {
    const stockAndEtfs = validateStrategyDefinition(
      definitionOf([
        {
          id: "c-stock",
          metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 50 },
        },
        etfRsi("ETF_XLK", 50, "c-xlk"),
        etfRsi("ETF_XLF", 50, "c-xlf"),
      ]),
    );
    expect(stockAndEtfs).toEqual([]);

    const repeated = validateStrategyDefinition(
      definitionOf([etfRsi("ETF_XLK", 50, "c-1"), etfRsi("ETF_XLK", 50, "c-2")]),
    );
    expect(codesOf(repeated)).toEqual(["DUPLICATE_CONDITION"]);
  });

  it("keys the select options apart while leaving stock keys unchanged", () => {
    expect(strategyMetricKey({ kind: "OSCILLATOR", seriesId: "RSI_14D" })).toBe(
      "OSCILLATOR:RSI_14D",
    );
    expect(
      strategyMetricKey({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK }),
    ).toBe("ETF(ETF_XLK)|OSCILLATOR:RSI_14D");
    expect(strategyMetricKey({ kind: "PRICE", source: SPY })).toBe(
      "ETF(SP500)|PRICE:",
    );
  });

  it("survives normalization, duplication and re-keying intact", () => {
    const definition = definitionOf([
      etfRsi("ETF_XLK", 50, "c-1"),
      {
        id: "c-2",
        metric: { kind: "PRICE", source: SPY },
        operator: "IS_CLOSE_TO",
        value: { kind: "SERIES", seriesId: "EMA_200D" },
      },
    ]);
    const normalized = normalizeStrategyDefinition(definition);
    expect(
      normalized.buyLevels[0]?.signal.conditions.map((condition) =>
        strategyMetricSource(condition.metric),
      ),
    ).toEqual([
      { kind: "ETF", code: "ETF_XLK" },
      { kind: "ETF", code: "SP500" },
    ]);
    // Normalizing twice is a fixed point, and a re-keyed copy keeps the source under new ids.
    expect(normalizeStrategyDefinition(normalized)).toEqual(normalized);
    let next = 0;
    const rekeyed = rekeyStrategyDefinition(normalized, () => `new-${next++}`);
    expect(
      rekeyed.buyLevels[0]?.signal.conditions.map((condition) => condition.id),
    ).toEqual(["new-1", "new-2"]);
    expect(
      rekeyed.buyLevels[0]?.signal.conditions.map((condition) =>
        strategyMetricSource(condition.metric),
      ),
    ).toEqual([
      { kind: "ETF", code: "ETF_XLK" },
      { kind: "ETF", code: "SP500" },
    ]);
    expect(strategyDefinitionFingerprint(rekeyed)).toBe(
      strategyDefinitionFingerprint(normalized),
    );
  });

  it("collects each definition's distinct sources in catalog order", () => {
    const definition = definitionOf([
      etfRsi("ETF_GLD", 50, "c-1"),
      etfRsi("ETF_XLK", 60, "c-2"),
      {
        id: "c-3",
        metric: { kind: "PRICE", source: SPY },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      {
        id: "c-4",
        metric: { kind: "RELATIVE_VOLUME", period: 20, source: XLK },
        operator: "IS_ABOVE",
        value: { kind: "MULTIPLE", value: 1.5 },
      },
    ]);
    expect(collectStrategyEtfSources(definition)).toEqual([
      "SP500",
      "ETF_XLK",
      "ETF_GLD",
    ]);
    expect(
      collectStrategyEtfSources(
        definitionOf([
          {
            id: "c-1",
            metric: { kind: "PRICE" },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("fingerprints", () => {
  const stockSignal: StrategySignal = {
    conditions: [
      {
        id: "c-1",
        metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 50 },
      },
    ],
  };
  const etfSignal: StrategySignal = {
    conditions: [etfRsi("ETF_XLK", 50)],
  };

  it("pins the serializations: stock rules unchanged, ETF rules appending etf:<code>", () => {
    // The stock literal is the serialization every persisted definitionHash and Monitor latch is
    // derived from; it must never move.
    expect(strategySignalFingerprint(stockSignal)).toBe(
      '[[[["OSCILLATOR","RSI_14D"],"IS_ABOVE",["NUMBER",50]]],null]',
    );
    expect(strategySignalFingerprint(etfSignal)).toBe(
      '[[[["OSCILLATOR","RSI_14D","etf:ETF_XLK"],"IS_ABOVE",["NUMBER",50]]],null]',
    );
    expect(
      strategySignalFingerprint({
        conditions: [
          {
            id: "c-1",
            metric: { kind: "PRICE", source: SPY },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
        ],
      }),
    ).toBe('[[[["PRICE",null,"etf:SP500"],"IS_ABOVE",["SERIES","SMA_200D"]]],null]');
    expect(
      strategySignalFingerprint({
        conditions: [
          {
            id: "c-1",
            metric: { kind: "RELATIVE_VOLUME", period: 20, source: GLD },
            operator: "IS_ABOVE",
            value: { kind: "MULTIPLE", value: 1.5 },
          },
        ],
      }),
    ).toBe(
      '[[[["RELATIVE_VOLUME",null,20,"etf:ETF_GLD"],"IS_ABOVE",["MULTIPLE",1.5]]],null]',
    );
  });

  it("fingerprints each source separately, so each latches and versions separately", () => {
    const fingerprints = [
      strategySignalFingerprint(stockSignal),
      strategySignalFingerprint(etfSignal),
      strategySignalFingerprint({ conditions: [etfRsi("ETF_XLF", 50)] }),
    ];
    expect(new Set(fingerprints).size).toBe(3);
  });
});

describe("labels and descriptions", () => {
  it("names an ETF-sourced metric by its ticker: XLK · RSI 14D", () => {
    expect(
      strategyMetricLabel({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: XLK }),
    ).toBe("XLK · RSI 14D");
    expect(strategyMetricLabel({ kind: "PRICE", source: SPY })).toBe(
      "SPY · Price",
    );
    expect(
      strategyMetricLabel({ kind: "RELATIVE_VOLUME", period: 20, source: GLD }),
    ).toBe("GLD · RVOL 20");
    expect(
      strategyMetricLabel({
        kind: "MOVING_AVERAGE",
        seriesId: "SMA_200D",
        source: SPY,
      }),
    ).toBe("SPY · SMA 200D");
  });

  it("carries the source into the canonical sentence and the preview", () => {
    expect(describeCondition(etfRsi("ETF_XLK", 50))).toBe(
      "XLK · RSI 14D is above 50",
    );
    const lines = describeStrategy(
      definitionOf([
        etfRsi("ETF_XLK", 50, "c-1"),
        {
          id: "c-2",
          metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
          operator: "IS_BELOW",
          value: { kind: "NUMBER", value: 40 },
        },
      ]),
    );
    const conditionLines = lines.filter((line) => line.kind === "CONDITION");
    expect(conditionLines.map((line) => line.text)).toEqual([
      "XLK · RSI 14D is above 50",
      "RSI 14D is below 40",
    ]);
  });

  it("explains the source in the metric's help, end-of-day semantics included", () => {
    const help = strategyMetricHelp({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: XLK,
    });
    expect(help.notes?.[0]).toContain("XLK (Technology)");
    expect(help.notEvaluableWhen).toContain("end-of-day bar is final");
    // The stock help is untouched.
    expect(
      strategyMetricHelp({ kind: "OSCILLATOR", seriesId: "RSI_14D" }).notes,
    ).toBeUndefined();
  });

  it("round-trips withoutMetricSource as the stock identity", () => {
    const metric: StrategyMetric = {
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: XLK,
    };
    expect(withoutMetricSource(metric)).toEqual({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
    });
    expect(Object.keys(withoutMetricSource(metric))).not.toContain("source");
  });
});

describe("drift guards inside contracts", () => {
  it("keeps every oscillator option an RSI the catalog defines", () => {
    // The ETF menu's oscillator and MA instances are the catalog's own, so a catalog change moves
    // both menus together.
    const etfOptions = strategyMetricOptions("BUY", "CONDITION", XLK);
    const oscillators = etfOptions.filter(
      (option) => option.metric.kind === "OSCILLATOR",
    );
    expect(oscillators.map((option) => option.label)).toEqual(
      OSCILLATOR_SERIES.map((series) => series.label),
    );
  });
});
