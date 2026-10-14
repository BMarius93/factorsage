import { describe, expect, it } from "vitest";
import {
  checkStrategyValue,
  collectStrategyEtfSources,
  defaultValueFor,
  describeCondition,
  normalizeStrategyDefinition,
  rekeyStrategyDefinition,
  STOCK_SECTOR_SOURCE_LABEL,
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionFingerprint,
  strategyMetricCategories,
  strategyMetricFamilies,
  strategyMetricHelp,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategyMetricSource,
  strategyMetricSourceKey,
  strategyMetricUnderSource,
  strategyReadsStockSector,
  strategySignalFingerprint,
  validateStrategyDefinition,
  valueSpecFor,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategyMetricSource,
  type StrategySignal,
  type StrategyValidationIssue,
} from "./strategies.js";
import { MOVING_AVERAGE_SERIES } from "./selectable-series.js";

const SECTOR: StrategyMetricSource = { kind: "STOCK_SECTOR" };
const XLK: StrategyMetricSource = { kind: "ETF", code: "ETF_XLK" };

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

function rsi(
  source: StrategyMetricSource | undefined,
  value: number,
  id = "condition-1",
): StrategyCondition {
  return {
    id,
    metric: source
      ? { kind: "OSCILLATOR", seriesId: "RSI_14D", source }
      : { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value },
  };
}

describe("the Stock's Sector metric menu", () => {
  it("offers exactly the same 21 technical metrics an ETF does, carrying the sector source", () => {
    for (const levelKind of ["BUY", "SELL", "FINAL_EXIT"] as const) {
      const sector = strategyMetricOptions(levelKind, "CONDITION", SECTOR);
      const etf = strategyMetricOptions(levelKind, "CONDITION", XLK);
      expect(sector).toHaveLength(21);
      // Same metrics in the same order: only the source differs.
      expect(
        sector.map((option) => strategyMetricKey({ ...option.metric, source: undefined } as StrategyMetric)),
      ).toEqual(
        etf.map((option) => strategyMetricKey({ ...option.metric, source: undefined } as StrategyMetric)),
      );
      for (const option of sector) {
        expect(strategyMetricSource(option.metric)).toEqual(SECTOR);
      }
      expect(
        strategyMetricCategories(levelKind, "CONDITION", SECTOR).map(
          (category) => category.id,
        ),
      ).toEqual(["PRICE", "MOVING_AVERAGES", "OSCILLATORS", "VOLUME"]);
      expect(
        strategyMetricFamilies(levelKind, "CONDITION", SECTOR).map(
          (family) => family.id,
        ),
      ).toEqual(["TECHNICAL"]);
    }
  });

  it("offers nothing as a Trigger", () => {
    expect(strategyMetricOptions("BUY", "TRIGGER", SECTOR)).toHaveLength(0);
    expect(strategyMetricOptions("SELL", "TRIGGER", SECTOR)).toHaveLength(0);
  });

  it("keeps the ETF menu and the stock menu what they were (separate cache entries)", () => {
    // The sector menu is built after and beside the ETF ones; neither may answer for the other.
    strategyMetricOptions("BUY", "CONDITION", SECTOR);
    for (const option of strategyMetricOptions("BUY", "CONDITION", XLK)) {
      expect(strategyMetricSource(option.metric)).toEqual(XLK);
    }
    for (const option of strategyMetricOptions("BUY", "CONDITION")) {
      expect(strategyMetricSource(option.metric)).toBeUndefined();
    }
  });

  it("narrows Price to the moving averages and keeps the ETF Value rules", () => {
    expect(valueSpecFor({ kind: "PRICE", source: SECTOR })).toEqual({
      kind: "SERIES",
      seriesIds: MOVING_AVERAGE_SERIES.map((series) => series.id),
    });
    const intrinsic = checkStrategyValue(
      { kind: "PRICE", source: SECTOR },
      { kind: "SERIES", seriesId: "BALANCED" },
    );
    expect(intrinsic.compatible).toBe(false);
    expect(
      defaultValueFor({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: SECTOR }),
    ).toEqual({ kind: "NUMBER", value: 50 });
    expect(
      defaultValueFor({ kind: "RELATIVE_VOLUME", period: 20, source: SECTOR }),
    ).toEqual({ kind: "MULTIPLE", value: 1 });
  });
});

describe("validation of Stock's Sector conditions", () => {
  it("accepts each technical kind, in every level kind, mixed with Stock and ETF rules", () => {
    const signal = (prefix: string): StrategySignal => ({
      conditions: [
        rsi(undefined, 40, `${prefix}-stock`),
        rsi(XLK, 50, `${prefix}-etf`),
        rsi(SECTOR, 50, `${prefix}-sector`),
        {
          id: `${prefix}-price`,
          metric: { kind: "PRICE", source: SECTOR },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
        {
          id: `${prefix}-ma`,
          metric: { kind: "MOVING_AVERAGE", seriesId: "EMA_20D", source: SECTOR },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_50D" },
        },
        {
          id: `${prefix}-rvol`,
          metric: { kind: "RELATIVE_VOLUME", period: 20, source: SECTOR },
          operator: "IS_ABOVE",
          value: { kind: "MULTIPLE", value: 1.5 },
        },
      ],
    });
    expect(
      validateStrategyDefinition({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [{ id: "buy-1", signal: signal("buy"), percentage: 25 }],
        sellLevels: [{ id: "sell-1", signal: signal("sell"), percentage: 50 }],
        finalExit: {
          id: "exit-1",
          rules: [{ id: "rule-1", signal: signal("exit") }],
        },
      }),
    ).toEqual([]);
  });

  it("refuses a forged code, ticker or any other key on the Stock's Sector source", () => {
    for (const source of [
      { kind: "STOCK_SECTOR", code: "ETF_XLK" },
      { kind: "STOCK_SECTOR", ticker: "XLK" },
      { kind: "STOCK_SECTOR", sector: "Technology" },
    ]) {
      const issues = validateStrategyDefinition(
        definitionOf([
          {
            id: "c-1",
            metric: { kind: "OSCILLATOR", seriesId: "RSI_14D", source } as unknown as StrategyMetric,
            operator: "IS_ABOVE",
            value: { kind: "NUMBER", value: 50 },
          },
        ]),
      );
      expect(codesOf(issues)).toEqual(["UNKNOWN_FIELD"]);
    }
    // Spelling matters: the kind is closed.
    const misspelled = validateStrategyDefinition(
      definitionOf([
        {
          id: "c-1",
          metric: {
            kind: "PRICE",
            source: { kind: "SECTOR" },
          } as unknown as StrategyMetric,
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
      ]),
    );
    expect(codesOf(misspelled)).toEqual(["SOURCE_INVALID"]);
  });

  it("refuses the source on every stock-only kind", () => {
    for (const metric of [
      { kind: "FUNDAMENTAL", metricId: "ROIC_TTM", source: SECTOR },
      { kind: "VALUATION_RATIO", ratioId: "PRICE_TO_EARNINGS_TTM", source: SECTOR },
      { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED", source: SECTOR },
      { kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 20, source: SECTOR },
    ]) {
      const issues = validateStrategyDefinition(
        definitionOf([
          {
            id: "c-1",
            metric: metric as unknown as StrategyMetric,
            operator: "IS_ABOVE",
            value:
              metric.kind === "VALUATION_RATIO"
                ? { kind: "MULTIPLE", value: 15 }
                : metric.kind === "INSIDER_ACTIVITY"
                  ? { kind: "NUMBER", value: 1 }
                  : { kind: "PERCENT", value: 10 },
          },
        ]),
      );
      expect(codesOf(issues)).toEqual(["UNKNOWN_FIELD"]);
    }
  });

  it("refuses a Stock's Sector Trigger and says what it reads", () => {
    const issues = validateStrategyDefinition(
      definitionOf([], {
        buyLevels: [
          {
            id: "buy-1",
            signal: {
              conditions: [],
              trigger: {
                id: "t-1",
                metric: { kind: "PRICE", source: SECTOR },
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
    expect(issues[0]?.message).toBe(
      "Stock's Sector · Price reads the stock's sector ETF, so it can be used as a condition only, not as a trigger.",
    );
  });

  it("holds the same value domains as the stock and an ETF", () => {
    expect(codesOf(validateStrategyDefinition(definitionOf([rsi(SECTOR, 101)])))).toEqual([
      "VALUE_OUT_OF_DOMAIN",
    ]);
  });
});

describe("identity: keys, duplicates, normalization, fingerprints", () => {
  it("keys Stock, one ETF and Stock's Sector apart, stock keys unchanged", () => {
    const stock: StrategyMetric = { kind: "OSCILLATOR", seriesId: "RSI_14D" };
    expect(strategyMetricKey(stock)).toBe("OSCILLATOR:RSI_14D");
    expect(strategyMetricKey({ ...stock, source: XLK })).toBe(
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );
    expect(strategyMetricKey({ ...stock, source: SECTOR })).toBe(
      "STOCK_SECTOR|OSCILLATOR:RSI_14D",
    );
    expect(strategyMetricSourceKey(undefined)).toBe("STOCK");
    expect(strategyMetricSourceKey(XLK)).toBe("ETF:ETF_XLK");
    expect(strategyMetricSourceKey(SECTOR)).toBe("STOCK_SECTOR");
  });

  it("treats Stock's Sector as its own condition beside the stock and XLK, and repeats as duplicates", () => {
    expect(
      validateStrategyDefinition(
        definitionOf([rsi(undefined, 50, "c-1"), rsi(XLK, 50, "c-2"), rsi(SECTOR, 50, "c-3")]),
      ),
    ).toEqual([]);
    expect(
      codesOf(
        validateStrategyDefinition(
          definitionOf([rsi(SECTOR, 50, "c-1"), rsi(SECTOR, 50, "c-2")]),
        ),
      ),
    ).toEqual(["DUPLICATE_CONDITION"]);
  });

  it("survives normalization, re-keying (duplicate) and a second normalization intact", () => {
    const definition = definitionOf([
      rsi(SECTOR, 50, "c-1"),
      {
        id: "c-2",
        metric: { kind: "PRICE", source: SECTOR },
        operator: "IS_CLOSE_TO",
        value: { kind: "SERIES", seriesId: "EMA_200D" },
      },
    ]);
    const normalized = normalizeStrategyDefinition(definition);
    expect(
      normalized.buyLevels[0]?.signal.conditions.map((condition) => condition.metric),
    ).toEqual([
      { kind: "OSCILLATOR", seriesId: "RSI_14D", source: { kind: "STOCK_SECTOR" } },
      { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
    ]);
    expect(normalizeStrategyDefinition(normalized)).toEqual(normalized);
    let next = 0;
    const rekeyed = rekeyStrategyDefinition(normalized, () => `new-${next++}`);
    expect(
      rekeyed.buyLevels[0]?.signal.conditions.map((condition) =>
        strategyMetricSource(condition.metric),
      ),
    ).toEqual([SECTOR, SECTOR]);
    expect(strategyDefinitionFingerprint(rekeyed)).toBe(
      strategyDefinitionFingerprint(normalized),
    );
  });

  it("pins the serialization: `stock-sector`, distinct from the stock and every ETF", () => {
    const sector: StrategySignal = { conditions: [rsi(SECTOR, 50)] };
    expect(strategySignalFingerprint(sector)).toBe(
      '[[[["OSCILLATOR","RSI_14D","stock-sector"],"IS_ABOVE",["NUMBER",50]]],null]',
    );
    // The stock literal never moves.
    expect(strategySignalFingerprint({ conditions: [rsi(undefined, 50)] })).toBe(
      '[[[["OSCILLATOR","RSI_14D"],"IS_ABOVE",["NUMBER",50]]],null]',
    );
    const fingerprints = new Set([
      strategySignalFingerprint(sector),
      strategySignalFingerprint({ conditions: [rsi(undefined, 50)] }),
      strategySignalFingerprint({ conditions: [rsi(XLK, 50)] }),
      strategySignalFingerprint({ conditions: [rsi({ kind: "ETF", code: "ETF_XLF" }, 50)] }),
    ]);
    expect(fingerprints.size).toBe(4);
  });

  it("is not a named ETF: collectStrategyEtfSources ignores it, strategyReadsStockSector finds it anywhere", () => {
    const sectorOnly = definitionOf([rsi(SECTOR, 50)]);
    expect(collectStrategyEtfSources(sectorOnly)).toEqual([]);
    expect(strategyReadsStockSector(sectorOnly)).toBe(true);
    expect(
      collectStrategyEtfSources(
        definitionOf([rsi(SECTOR, 50, "c-1"), rsi(XLK, 50, "c-2")]),
      ),
    ).toEqual(["ETF_XLK"]);
    expect(strategyReadsStockSector(definitionOf([rsi(XLK, 50)]))).toBe(false);
    expect(strategyReadsStockSector(definitionOf([rsi(undefined, 50)]))).toBe(false);
    // In a SELL level and in a Final Exit rule only.
    const buyStock: StrategyDefinition["buyLevels"][number] = {
      id: "buy-1",
      signal: { conditions: [rsi(undefined, 50)] },
      percentage: 25,
    };
    expect(
      strategyReadsStockSector({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [buyStock],
        sellLevels: [
          { id: "sell-1", signal: { conditions: [rsi(SECTOR, 70)] }, percentage: 50 },
        ],
      }),
    ).toBe(true);
    expect(
      strategyReadsStockSector({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [buyStock],
        sellLevels: [],
        finalExit: {
          id: "exit-1",
          rules: [{ id: "rule-1", signal: { conditions: [rsi(SECTOR, 30)] } }],
        },
      }),
    ).toBe(true);
  });
});

describe("labels, help and switching", () => {
  it("names the metric `Stock's Sector · RSI 14D`", () => {
    expect(STOCK_SECTOR_SOURCE_LABEL).toBe("Stock's Sector");
    expect(
      strategyMetricLabel({ kind: "OSCILLATOR", seriesId: "RSI_14D", source: SECTOR }),
    ).toBe("Stock's Sector · RSI 14D");
    expect(strategyMetricLabel({ kind: "PRICE", source: SECTOR })).toBe(
      "Stock's Sector · Price",
    );
    expect(
      strategyMetricLabel({ kind: "RELATIVE_VOLUME", period: 20, source: SECTOR }),
    ).toBe("Stock's Sector · RVOL 20");
    expect(describeCondition(rsi(SECTOR, 50))).toBe(
      "Stock's Sector · RSI 14D is above 50",
    );
  });

  it("explains the per-stock resolution, the current-sector limitation and the not-evaluable cases", () => {
    const help = strategyMetricHelp({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: SECTOR,
    });
    expect(help.notes?.[0]).toContain("Technology reads XLK");
    expect(help.notes?.[1]).toContain("The stock's current FMP sector is used for every date");
    expect(help.notEvaluableWhen).toContain("has no FMP sector");
    expect(help.notEvaluableWhen).toContain("Another fund is never used instead.");
  });

  it("keeps the metric identity across Stock → Stock's Sector → ETF → Stock", () => {
    const stock: StrategyMetric = { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" };
    const sector = strategyMetricUnderSource("BUY", "CONDITION", stock, SECTOR);
    expect(sector).toEqual({ kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: SECTOR });
    const etf = strategyMetricUnderSource("SELL", "CONDITION", sector!, XLK);
    expect(etf).toEqual({ kind: "MOVING_AVERAGE", seriesId: "SMA_50D", source: XLK });
    const back = strategyMetricUnderSource("FINAL_EXIT", "CONDITION", etf!, undefined);
    expect(back).toEqual(stock);
    expect(Object.keys(back!)).not.toContain("source");
    // A stock-only metric has no Stock's Sector form, and a Trigger has none at all.
    expect(
      strategyMetricUnderSource(
        "BUY",
        "CONDITION",
        { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
        SECTOR,
      ),
    ).toBeUndefined();
    expect(
      strategyMetricUnderSource("BUY", "TRIGGER", { kind: "PRICE" }, SECTOR),
    ).toBeUndefined();
  });
});
