import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";

/**
 * The fixture strategies the backtest benchmarks run, shared so that every harness measures the
 * same definitions: `bench:pit-backtests` (the S&P 500 point-in-time universe) and
 * `bench:scale-backtests` (synthetic universes at plan-limit sizes).
 *
 * They span the engine's cost range: `simple` reads one moving average; `monthly` adds monthly
 * contributions and a position cap; `complex` reads fundamentals, an oscillator and a valuation;
 * `sector` reads the Stock's Sector ETF beside the stock's own technicals.
 */

export type BenchmarkStrategyKey = "simple" | "complex" | "monthly" | "sector";

export const BENCHMARK_STRATEGIES: Record<
  BenchmarkStrategyKey,
  {
    /** Stable suffix of the fixture strategy's name; each harness adds its own prefix. */
    readonly slug: string;
    readonly description: string;
    readonly definition: StrategyDefinition;
    readonly capital: {
      readonly initialCapital: number;
      readonly monthlyContribution: number;
      readonly maximumPositions: number;
    };
  }
> = {
  simple: {
    slug: "simple-sma200-cross",
    description:
      "BUY 100% when Price crosses above SMA 200D; FINAL EXIT when Price crosses below SMA 200D.",
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "simple-buy1",
          percentage: 100,
          signal: {
            conditions: [],
            trigger: {
              id: "simple-buy1-t1",
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          },
        },
      ],
      sellLevels: [],
      finalExit: {
        id: "simple-exit",
        rules: [
          {
            id: "simple-exit",
            signal: {
              conditions: [],
              trigger: {
                id: "simple-exit-t1",
                metric: { kind: "PRICE" },
                operator: "CROSSES_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            },
          },
        ],
      },
    } as StrategyDefinition,
    capital: {
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 20,
    },
  },
  complex: {
    slug: "complex-quality-pullback",
    description:
      "BUY 50% on Price above SMA 200D AND RSI 14D below 45 AND ROIC TTM above 12% AND " +
      "Debt / Equity below 1.5x AND Margin of Safety (Balanced) above 0%, triggered by RSI 14D " +
      "crossing above 35; BUY 50% more on Price above SMA 50D AND ROIC TTM above 15%. SELL 50% " +
      "on RSI 14D above 75; FINAL EXIT on Price below SMA 200D, or ROIC TTM below 8%.",
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "complex-buy1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "complex-buy1-c1",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
              {
                id: "complex-buy1-c2",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 45 },
              },
              {
                id: "complex-buy1-c3",
                metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 12 },
              },
              {
                id: "complex-buy1-c4",
                metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
                operator: "IS_BELOW",
                value: { kind: "MULTIPLE", value: 1.5 },
              },
              {
                id: "complex-buy1-c5",
                metric: { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 0 },
              },
            ],
            trigger: {
              id: "complex-buy1-t1",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "CROSSES_ABOVE",
              value: { kind: "NUMBER", value: 35 },
            },
          },
        },
        {
          id: "complex-buy2",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "complex-buy2-c1",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_50D" },
              },
              {
                id: "complex-buy2-c2",
                metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 15 },
              },
            ],
          },
        },
      ],
      sellLevels: [
        {
          id: "complex-sell1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "complex-sell1-c1",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 75 },
              },
            ],
          },
        },
      ],
      finalExit: {
        id: "complex-exit",
        rules: [
          {
            id: "complex-exit",
            signal: {
              conditions: [
                {
                  id: "complex-exit-c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_BELOW",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
            },
          },
          {
            id: "complex-exit2",
            signal: {
              conditions: [
                {
                  id: "complex-exit2-c1",
                  metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                  operator: "IS_BELOW",
                  value: { kind: "PERCENT", value: 8 },
                },
              ],
            },
          },
        ],
      },
    } as StrategyDefinition,
    capital: {
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 20,
    },
  },
  monthly: {
    slug: "monthly-contributions-10",
    description:
      "BUY 100% when Price crosses above SMA 50D while above SMA 200D; FINAL EXIT when Price " +
      "crosses below SMA 200D. Run with monthly contributions and at most ten positions.",
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "monthly-buy1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "monthly-buy1-c1",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
            trigger: {
              id: "monthly-buy1-t1",
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
          },
        },
      ],
      sellLevels: [],
      finalExit: {
        id: "monthly-exit",
        rules: [
          {
            id: "monthly-exit",
            signal: {
              conditions: [],
              trigger: {
                id: "monthly-exit-t1",
                metric: { kind: "PRICE" },
                operator: "CROSSES_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            },
          },
        ],
      },
    } as StrategyDefinition,
    capital: {
      initialCapital: 10_000,
      monthlyContribution: 1_000,
      maximumPositions: 10,
    },
  },
  sector: {
    slug: "sector-trend-rsi",
    description:
      "BUY 50% when Price crosses above SMA 50D while the Stock's Sector ETF is above its SMA 200D " +
      "and RSI 14D is below 70; BUY 50% more when RSI 14D crosses above 50. FINAL EXIT when Price " +
      "crosses below SMA 200D, or the Stock's Sector ETF falls below its SMA 200D.",
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "sector-buy1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "sector-buy1-c1",
                metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
                operator: "IS_ABOVE",
                // A series value is the metric's own source's series: the sector ETF's SMA 200D.
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
              {
                id: "sector-buy1-c2",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 70 },
              },
            ],
            trigger: {
              id: "sector-buy1-t1",
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
          },
        },
        {
          id: "sector-buy2",
          percentage: 50,
          signal: {
            conditions: [],
            trigger: {
              id: "sector-buy2-t1",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "CROSSES_ABOVE",
              value: { kind: "NUMBER", value: 50 },
            },
          },
        },
      ],
      sellLevels: [],
      finalExit: {
        id: "sector-exit",
        rules: [
          {
            id: "sector-exit",
            signal: {
              conditions: [],
              trigger: {
                id: "sector-exit-t1",
                metric: { kind: "PRICE" },
                operator: "CROSSES_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            },
          },
          {
            id: "sector-exit2",
            signal: {
              conditions: [
                {
                  id: "sector-exit2-c1",
                  metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
                  operator: "IS_BELOW",
                  value: { kind: "SERIES", seriesId: "SMA_200D" },
                },
              ],
            },
          },
        ],
      },
    } as StrategyDefinition,
    capital: {
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 20,
    },
  },
};
