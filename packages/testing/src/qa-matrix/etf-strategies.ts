import {
  STRATEGY_SCHEMA_VERSION,
  type BuyLevelPercentage,
  type ConditionOperator,
  type FundamentalMetricId,
  type SelectableSeriesId,
  type SellLevelPercentage,
  type StrategyDefinition,
  type StrategyEtfSourceCode,
  type StrategyMetric,
  type StrategyMetricSource,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
  type TriggerOperator,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import {
  QA_MATRIX_NAME_PREFIX,
  type QaMatrixStrategyBehaviour,
  type QaMatrixStrategyFixture,
} from "./strategies.js";

/**
 * The two **data-source** QA-MATRIX Strategy dimensions: static ETF Conditions (`E01` … `E10`) and
 * Stock's Sector Conditions (`T01` … `T10`).
 *
 * Both arrived after the three recorded baselines (`S`, `A`, `F`), so — for the reason those exist
 * as separate dimensions — they get their own rather than edits to a baseline. A Condition here
 * reads its technical metric from one of the twenty Dashboard ETFs
 * (`docs/decisions/strategy-etf-conditions-v1.md`), or from the sector ETF the evaluated stock's own
 * FMP sector maps to (`STOCK_SECTOR`, `stock-sector-etfs.ts`). Every Metric / operator / Value
 * combination below is one the validator admits; `validateStrategyDefinition` is what proves it,
 * not this comment, and ETF-sourced Triggers stay absent because the product refuses them.
 *
 * **A zero-trade run proves nothing about an ETF rule.** So each dimension carries a control and
 * a probe that differ by exactly one ETF Condition whose truth the data fixes:
 *
 * - `E07` ⟷ `E08`: `E08` is `E07` with `SPY · RVOL 10 is above 0x` ANDed into every level. SPY
 *   never prints a zero-volume session, so that Condition is TRUE on every session either fixture
 *   simulates, and the two must produce **identical** trades, equity and positions.
 * - `E09` ⟷ `E10`: `E10` is `E09` plus a third BUY level gated by `SPY · RSI 14D is above 100`,
 *   which no RSI can satisfy. The level must never fire, and nothing else may move.
 * - `T09` ⟷ `T10`: `T09` reads `XLK` by name, `T10` the stock's sector. On a list whose every member
 *   is a Technology company (`L01`, AAPL) they are the same rule and must produce identical results.
 *
 * The runner compares each pair case by case (`matrix-metamorphic.ts`), and the independent ETF
 * oracle (`matrix-etf-oracle.ts`) re-derives every ETF Condition of every executed trade from the
 * stored ETF bars — so a dimension that never consulted its ETFs, or consulted the wrong one, fails.
 *
 * **Coverage.** Between them the twenty fixtures read all twenty ETFs (the eleven sector funds
 * through `L11`), Price and the daily and weekly SMA/EMA moving averages, all three RSI periods and
 * all three RVOL periods, `is close to`, every level kind and a two-rule FINAL EXIT, Stock + ETF,
 * ETF + ETF, ETF + Stock's Sector and Stock's Sector + Fundamentals / Valuation mixes, funds that
 * list inside the horizon (`HYG` 2007, `XLRE` 2015, `XLC` 2018) and a stock Trigger gated by ETF
 * Conditions.
 */

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

type Source = StrategyMetricSource | undefined;

const etf = (code: StrategyEtfSourceCode): StrategyMetricSource => ({
  kind: "ETF",
  code,
});
const SECTOR: StrategyMetricSource = { kind: "STOCK_SECTOR" };
const STOCK: Source = undefined;

const withSource = <T extends StrategyMetric>(metric: T, source: Source): T =>
  source === undefined ? metric : ({ ...metric, source } as T);

const price = (source: Source = STOCK): StrategyMetric =>
  withSource({ kind: "PRICE" }, source);
const ma = (
  seriesId: SelectableSeriesId,
  source: Source = STOCK,
): StrategyMetric => withSource({ kind: "MOVING_AVERAGE", seriesId }, source);
const rsi = (
  seriesId: SelectableSeriesId,
  source: Source = STOCK,
): StrategyMetric => withSource({ kind: "OSCILLATOR", seriesId }, source);
const rvol = (period: 10 | 20 | 50, source: Source = STOCK): StrategyMetric =>
  withSource({ kind: "RELATIVE_VOLUME", period }, source);
const fundamental = (metricId: FundamentalMetricId): StrategyMetric => ({
  kind: "FUNDAMENTAL",
  metricId,
});
const ratio = (ratioId: ValuationRatioId): StrategyMetric => ({
  kind: "VALUATION_RATIO",
  ratioId,
});
const mos = (sourceId: SelectableSeriesId): StrategyMetric => ({
  kind: "MARGIN_OF_SAFETY",
  sourceId,
});
const gain: StrategyMetric = { kind: "GAIN" };
const loss: StrategyMetric = { kind: "LOSS" };

const series = (seriesId: SelectableSeriesId): StrategyValue => ({
  kind: "SERIES",
  seriesId,
});
const number = (value: number): StrategyValue => ({ kind: "NUMBER", value });
const percent = (value: number): StrategyValue => ({ kind: "PERCENT", value });
const multiple = (value: number): StrategyValue => ({
  kind: "MULTIPLE",
  value,
});

type PredicateSpec<Operator> = {
  readonly metric: StrategyMetric;
  readonly operator: Operator;
  readonly value: StrategyValue;
};

const when = (
  metric: StrategyMetric,
  operator: ConditionOperator,
  value: StrategyValue,
): PredicateSpec<ConditionOperator> => ({ metric, operator, value });

const on = (
  metric: StrategyMetric,
  operator: TriggerOperator,
  value: StrategyValue,
): PredicateSpec<TriggerOperator> => ({ metric, operator, value });

type SignalSpec = {
  readonly conditions: readonly PredicateSpec<ConditionOperator>[];
  readonly trigger?: PredicateSpec<TriggerOperator>;
};
type LevelSpec<Percentage> = SignalSpec & { readonly percentage: Percentage };

type DefinitionSpec = {
  readonly buyLevels: readonly LevelSpec<BuyLevelPercentage>[];
  readonly sellLevels?: readonly LevelSpec<SellLevelPercentage>[];
  /** One entry per Exit Rule, ORed. */
  readonly finalExit?: readonly SignalSpec[];
};

/** Positional row ids, exactly as the other fixture sets build them, so a re-seed is idempotent. */
function buildSignal(prefix: string, spec: SignalSpec): StrategySignal {
  const signal: StrategySignal = {
    conditions: spec.conditions.map((condition, index) => ({
      id: `${prefix}-c${index + 1}`,
      metric: condition.metric,
      operator: condition.operator,
      value: condition.value,
    })),
  };
  if (spec.trigger) {
    signal.trigger = {
      id: `${prefix}-t1`,
      metric: spec.trigger.metric,
      operator: spec.trigger.operator,
      value: spec.trigger.value,
    } as StrategyTrigger;
  }
  return signal;
}

/**
 * Level ids are `<prefix>-buy1`, `<prefix>-sell1`, `<prefix>-exit` — with the prefix the fixture id
 * by default. A metamorphic probe passes its control's prefix instead, so the two documents name
 * the same levels identically and their trades can be compared column for column, `levelId`
 * included.
 */
function buildDefinition(
  levelPrefix: string,
  spec: DefinitionSpec,
): StrategyDefinition {
  const slug = levelPrefix.toLowerCase();
  const definition: StrategyDefinition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: spec.buyLevels.map((level, index) => {
      const id = `${slug}-buy${index + 1}`;
      return {
        id,
        signal: buildSignal(id, level),
        percentage: level.percentage,
      };
    }),
    sellLevels: (spec.sellLevels ?? []).map((level, index) => {
      const id = `${slug}-sell${index + 1}`;
      return {
        id,
        signal: buildSignal(id, level),
        percentage: level.percentage,
      };
    }),
  };
  if (spec.finalExit && spec.finalExit.length > 0) {
    const id = `${slug}-exit`;
    definition.finalExit = {
      id,
      rules: spec.finalExit.map((rule, index) => ({
        // The first rule reuses the level id, exactly as the other sets and the version-1 upcast do.
        id: index === 0 ? id : `${id}${index + 1}`,
        signal: buildSignal(index === 0 ? id : `${id}${index + 1}`, rule),
      })),
    };
  }
  return definition;
}

type SourceStrategySpec = {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixStrategyBehaviour[];
  readonly definition: DefinitionSpec;
  /** The control fixture whose level ids this one reuses, for a metamorphic pair. */
  readonly levelPrefix?: string;
};

/**
 * One metamorphic pair: `probe` must reproduce `control`'s persisted results exactly, on the lists
 * named (every list when absent).
 */
export type QaMatrixMetamorphicPair = {
  readonly control: string;
  readonly probe: string;
  /** `null`: the equivalence holds on every list the dimension runs. */
  readonly listIds: readonly string[] | null;
  readonly reason: string;
};

// ---------------------------------------------------------------------------
// E01 … E10 — static ETF Conditions
// ---------------------------------------------------------------------------

const SPY = etf("SP500");

/** `E07`'s RSI ladder, which `E08` repeats with an always-TRUE ETF gate. */
const E07_LADDER: DefinitionSpec = {
  buyLevels: [
    {
      percentage: 50,
      conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(40))],
    },
    {
      percentage: 100,
      conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(30))],
    },
  ],
  sellLevels: [
    {
      percentage: 50,
      conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(70))],
    },
  ],
  finalExit: [{ conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(80))] }],
};

/** SPY has no zero-volume session in its history, so this is TRUE wherever it is evaluable. */
const ALWAYS_TRUE = when(rvol(10, SPY), "IS_ABOVE", multiple(0));
/** RSI lives in [0, 100]: nothing is ever above 100. */
const NEVER_TRUE = when(rsi("RSI_14D", SPY), "IS_ABOVE", number(100));

const gated = (spec: DefinitionSpec): DefinitionSpec => ({
  buyLevels: spec.buyLevels.map((level) => ({
    ...level,
    conditions: [...level.conditions, ALWAYS_TRUE],
  })),
  sellLevels: (spec.sellLevels ?? []).map((level) => ({
    ...level,
    conditions: [...level.conditions, ALWAYS_TRUE],
  })),
  finalExit: (spec.finalExit ?? []).map((rule) => ({
    ...rule,
    conditions: [...rule.conditions, ALWAYS_TRUE],
  })),
});

/** `E09`'s ladder, which `E10` extends with a third level no session can satisfy. */
const E09_LADDER: DefinitionSpec = {
  buyLevels: [
    {
      percentage: 25,
      conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(40))],
    },
    {
      percentage: 50,
      conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(30))],
    },
  ],
  sellLevels: [
    {
      percentage: 50,
      conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(70))],
    },
  ],
  finalExit: [{ conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(80))] }],
};

const ETF_STRATEGY_SPECS: readonly SourceStrategySpec[] = [
  {
    id: "E01",
    slug: "spy-trend-gate",
    description:
      "BUY 100% on `SPY · Price is above SPY · SMA 200D`; no SELL, no FINAL EXIT. The simplest " +
      "static ETF rule: one Condition that is the same for every candidate on a session, TRUE for " +
      "long stretches, so whole universes become eligible together and contribution-date top-ups " +
      "apply while the market trend holds.",
    behaviours: [
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "DAILY_MOVING_AVERAGE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "PERSISTENT_SIGNAL",
      "CONTRIBUTION_TOP_UP",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [when(price(SPY), "IS_ABOVE", series("SMA_200D"))],
        },
      ],
    },
  },
  {
    id: "E02",
    slug: "xlk-same-fund-stack",
    description:
      "BUY 100% on three Conditions that all read XLK — Price above SMA 50D, SMA 50D above SMA 200D " +
      "and RSI 14D below 70; FINAL EXIT when XLK closes below its SMA 200D. Several Conditions on one " +
      "fund in one Signal, and an ETF-only FINAL EXIT that closes every holding on the same session.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "SAME_SOURCE_MULTIPLE_CONDITIONS",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "LIFECYCLE_RESET",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(price(etf("ETF_XLK")), "IS_ABOVE", series("SMA_50D")),
            when(ma("SMA_50D", etf("ETF_XLK")), "IS_ABOVE", series("SMA_200D")),
            when(rsi("RSI_14D", etf("ETF_XLK")), "IS_BELOW", number(70)),
          ],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(price(etf("ETF_XLK")), "IS_BELOW", series("SMA_200D")),
          ],
        },
      ],
    },
  },
  {
    id: "E03",
    slug: "cross-asset-risk-on",
    description:
      "BUY 50% on `QQQ · RSI 14D above 50 AND HYG · Price above HYG · SMA 200D AND TLT · Price below " +
      "TLT · SMA 50D`; BUY 100% adds `IWM · Price above IWM · EMA 50D AND SPY · RVOL 50 below 3x`; " +
      "SELL 50% on `GLD · Price above GLD · SMA 50W`; FINAL EXIT when HYG closes below its SMA 200D. " +
      "Six different funds, a weekly average on gold, and HYG — which lists in 2007 — so a thirty-year " +
      "run cannot enter for its first decade.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "MULTIPLE_ETF_SOURCES",
      "MIXED_DATA_SOURCES",
      "DAILY_MOVING_AVERAGE",
      "WEEKLY_MOVING_AVERAGE",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "YOUNGER_ETF_SOURCE",
      "STRONGEST_ELIGIBLE_BUY",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [
            when(rsi("RSI_14D", etf("ETF_QQQ")), "IS_ABOVE", number(50)),
            when(price(etf("ETF_HYG")), "IS_ABOVE", series("SMA_200D")),
            when(price(etf("ETF_TLT")), "IS_BELOW", series("SMA_50D")),
          ],
        },
        {
          percentage: 100,
          conditions: [
            when(rsi("RSI_14D", etf("ETF_QQQ")), "IS_ABOVE", number(50)),
            when(price(etf("ETF_HYG")), "IS_ABOVE", series("SMA_200D")),
            when(price(etf("ETF_TLT")), "IS_BELOW", series("SMA_50D")),
            when(price(etf("ETF_IWM")), "IS_ABOVE", series("EMA_50D")),
            when(rvol(50, SPY), "IS_BELOW", multiple(3)),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [
            when(price(etf("ETF_GLD")), "IS_ABOVE", series("SMA_50W")),
          ],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(price(etf("ETF_HYG")), "IS_BELOW", series("SMA_200D")),
          ],
        },
      ],
    },
  },
  {
    id: "E04",
    slug: "stock-ladder-market-filter",
    description:
      "BUY 50% on `RSI 14D below 35 AND SPY · Price above SPY · SMA 200D`; BUY 100% on `RSI 14D below " +
      "25 AND RSP · Price above RSP · SMA 50D`; SELL 50% on `RSI 14D above 65 AND SPY · Price is close " +
      "to SPY · SMA 50D`; FINAL EXIT on `Price below SMA 200D`. The stock's own oversold ladder gated " +
      "by market-breadth Conditions: Stock and ETF rules in one Signal at every level, the only " +
      "ETF `is close to`, and RSP, which lists in 2003.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "MULTIPLE_ETF_SOURCES",
      "MIXED_DATA_SOURCES",
      "IS_CLOSE_TO",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "STRONGEST_ELIGIBLE_BUY",
      "YOUNGER_ETF_SOURCE",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [
            when(rsi("RSI_14D"), "IS_BELOW", number(35)),
            when(price(SPY), "IS_ABOVE", series("SMA_200D")),
          ],
        },
        {
          percentage: 100,
          conditions: [
            when(rsi("RSI_14D"), "IS_BELOW", number(25)),
            when(price(etf("ETF_RSP")), "IS_ABOVE", series("SMA_50D")),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [
            when(rsi("RSI_14D"), "IS_ABOVE", number(65)),
            when(price(SPY), "IS_CLOSE_TO", series("SMA_50D")),
          ],
        },
      ],
      finalExit: [
        { conditions: [when(price(), "IS_BELOW", series("SMA_200D"))] },
      ],
    },
  },
  {
    id: "E05",
    slug: "weekly-etf-regime",
    description:
      "BUY 100% on `DIA · Price above DIA · SMA 20W AND IWM · SMA 20W above IWM · SMA 50W AND QQQ · " +
      "RSI 21D above 45 AND Price above SMA 50W`; SELL 25% on `IWM · Price below IWM · EMA 20W`; " +
      "FINAL EXIT on `DIA · Price below DIA · SMA 50W`. Weekly averages on funds as Metric and Value — " +
      "the week-completion rule applied to ETF bars — beside the stock's own weekly trend.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "MULTIPLE_ETF_SOURCES",
      "MIXED_DATA_SOURCES",
      "WEEKLY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "SELL_25",
      "FINAL_EXIT",
      "PERSISTENT_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(price(etf("ETF_DIA")), "IS_ABOVE", series("SMA_20W")),
            when(ma("SMA_20W", etf("ETF_IWM")), "IS_ABOVE", series("SMA_50W")),
            when(rsi("RSI_21D", etf("ETF_QQQ")), "IS_ABOVE", number(45)),
            when(price(), "IS_ABOVE", series("SMA_50W")),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 25,
          conditions: [
            when(price(etf("ETF_IWM")), "IS_BELOW", series("EMA_20W")),
          ],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(price(etf("ETF_DIA")), "IS_BELOW", series("SMA_50W")),
          ],
        },
      ],
    },
  },
  {
    id: "E06",
    slug: "fund-volume-and-oversold",
    description:
      "BUY 100% on `XLE · RVOL 20 above 1.5x AND XLRE · RSI 7D below 35`, with the stock's own " +
      "Trigger `Price crosses above SMA 20D`; FINAL EXIT on either Exit Rule: `XLRE · RSI 7D above " +
      "70` or `USO · RSI 14D above 75 AND Loss above 10%`. RVOL and the shortest RSI on funds, a stock " +
      "Trigger gated by ETF Conditions (an ETF can never be the Trigger), a two-rule FINAL EXIT, and " +
      "XLRE — which lists in 2015 — so nothing enters before its RSI warms up.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "MULTIPLE_ETF_SOURCES",
      "MIXED_DATA_SOURCES",
      "TRIGGER_CROSSES_ABOVE",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "LOSS",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "YOUNGER_ETF_SOURCE",
      "SPARSE_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(rvol(20, etf("ETF_XLE")), "IS_ABOVE", multiple(1.5)),
            when(rsi("RSI_7D", etf("ETF_XLRE")), "IS_BELOW", number(35)),
          ],
          trigger: on(price(), "CROSSES_ABOVE", series("SMA_20D")),
        },
      ],
      finalExit: [
        {
          conditions: [
            when(rsi("RSI_7D", etf("ETF_XLRE")), "IS_ABOVE", number(70)),
          ],
        },
        {
          conditions: [
            when(rsi("RSI_14D", etf("ETF_USO")), "IS_ABOVE", number(75)),
            when(loss, "IS_ABOVE", percent(10)),
          ],
        },
      ],
    },
  },
  {
    id: "E07",
    slug: "rsi-ladder-control",
    description:
      "BUY 50% / 100% on the stock's RSI 14D below 40 / 30; SELL 50% above 70; FINAL EXIT above 80. " +
      "No ETF at all: the **control** of the always-TRUE pair. `E08` must reproduce its results " +
      "exactly on every list and configuration.",
    behaviours: [
      "SIMPLE_CONDITION",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "METAMORPHIC_CONTROL",
      "STRONGEST_ELIGIBLE_BUY",
    ],
    definition: E07_LADDER,
  },
  {
    id: "E08",
    slug: "rsi-ladder-always-true-etf",
    description:
      "`E07` with `SPY · RVOL 10 is above 0x` ANDed into every level, the FINAL EXIT included. SPY " +
      "never prints a zero-volume session, so the Condition is TRUE on every session a run " +
      "simulates; the results must equal `E07`'s trade for trade, so an ETF Condition that is TRUE " +
      "can neither suppress nor add a decision.",
    behaviours: [
      "AND_CONDITIONS",
      "ETF_SOURCE",
      "MIXED_DATA_SOURCES",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "ALWAYS_TRUE_PROBE",
      "STRONGEST_ELIGIBLE_BUY",
    ],
    definition: gated(E07_LADDER),
    levelPrefix: "E07",
  },
  {
    id: "E09",
    slug: "rsi-ladder-control-two-levels",
    description:
      "BUY 25% / 50% on the stock's RSI 14D below 40 / 30; SELL 50% above 70; FINAL EXIT above 80. " +
      "No ETF at all: the **control** of the always-FALSE pair.",
    behaviours: [
      "SIMPLE_CONDITION",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_25",
      "BUY_50",
      "SELL_50",
      "FINAL_EXIT",
      "METAMORPHIC_CONTROL",
    ],
    definition: E09_LADDER,
  },
  {
    id: "E10",
    slug: "rsi-ladder-never-true-etf-level",
    description:
      "`E09` plus a third BUY level, 100%, on `RSI 14D below 20 AND SPY · RSI 14D is above 100`. " +
      "No RSI is ever above 100, so that level can never fire — it must not trade, must not take the " +
      "strongest-eligible slot from the two levels below it, and must leave every result identical " +
      "to `E09`'s.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "MIXED_DATA_SOURCES",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_25",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "ALWAYS_FALSE_PROBE",
    ],
    definition: {
      ...E09_LADDER,
      buyLevels: [
        ...E09_LADDER.buyLevels,
        {
          percentage: 100,
          conditions: [
            when(rsi("RSI_14D"), "IS_BELOW", number(20)),
            NEVER_TRUE,
          ],
        },
      ],
    },
    levelPrefix: "E09",
  },
];

// ---------------------------------------------------------------------------
// T01 … T10 — Stock's Sector Conditions
// ---------------------------------------------------------------------------

/** `T09` reads XLK by name; `T10` is the same rule reading each stock's own sector fund. */
const XLK_RULE = (source: StrategyMetricSource): DefinitionSpec => ({
  buyLevels: [
    {
      percentage: 100,
      conditions: [
        when(price(source), "IS_ABOVE", series("SMA_50D")),
        when(rsi("RSI_14D", source), "IS_BELOW", number(70)),
      ],
    },
  ],
  finalExit: [
    { conditions: [when(price(source), "IS_BELOW", series("SMA_200D"))] },
  ],
});

const SECTOR_STRATEGY_SPECS: readonly SourceStrategySpec[] = [
  {
    id: "T01",
    slug: "sector-trend-gate",
    description:
      "BUY 100% on `Stock's Sector · Price is above Stock's Sector · SMA 200D`; no SELL, no FINAL " +
      "EXIT. One rule, one fund per stock: AAPL reads XLK, JPM XLF, NEE XLU, PLD XLRE — so on one " +
      "session the same rule can be TRUE for one member, FALSE for another and NOT_EVALUABLE for a " +
      "third whose fund has not listed yet.",
    behaviours: [
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "DAILY_MOVING_AVERAGE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "PERSISTENT_SIGNAL",
      "CONTRIBUTION_TOP_UP",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [when(price(SECTOR), "IS_ABOVE", series("SMA_200D"))],
        },
      ],
    },
  },
  {
    id: "T02",
    slug: "sector-and-stock-trend",
    description:
      "BUY 100% on `Stock's Sector · Price above SMA 50D AND Price above SMA 200D` (the second is the " +
      "stock's own); FINAL EXIT when the sector fund closes below its SMA 200D. The stock and its " +
      "sector in one Signal, and a sector-driven exit.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "MIXED_DATA_SOURCES",
      "DAILY_MOVING_AVERAGE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "LIFECYCLE_RESET",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(price(SECTOR), "IS_ABOVE", series("SMA_50D")),
            when(price(), "IS_ABOVE", series("SMA_200D")),
          ],
        },
      ],
      finalExit: [
        { conditions: [when(price(SECTOR), "IS_BELOW", series("SMA_200D"))] },
      ],
    },
  },
  {
    id: "T03",
    slug: "sector-weekly-ladder",
    description:
      "BUY 50% on `Stock's Sector · SMA 20W above SMA 50W`; BUY 100% adds `Stock's Sector · Price " +
      "above EMA 20W AND Price above SMA 50W`; SELL 50% when the sector closes below its SMA 20W; " +
      "FINAL EXIT when its SMA 20W falls below its SMA 50W. Several sector Conditions in one Signal, " +
      "weekly averages on the sector fund, and a ladder.",
    behaviours: [
      "SIMPLE_CONDITION",
      "AND_CONDITIONS",
      "STOCK_SECTOR_SOURCE",
      "SAME_SOURCE_MULTIPLE_CONDITIONS",
      "MIXED_DATA_SOURCES",
      "WEEKLY_MOVING_AVERAGE",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "PERSISTENT_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [
            when(ma("SMA_20W", SECTOR), "IS_ABOVE", series("SMA_50W")),
          ],
        },
        {
          percentage: 100,
          conditions: [
            when(ma("SMA_20W", SECTOR), "IS_ABOVE", series("SMA_50W")),
            when(price(SECTOR), "IS_ABOVE", series("EMA_20W")),
            when(price(), "IS_ABOVE", series("SMA_50W")),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(price(SECTOR), "IS_BELOW", series("SMA_20W"))],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(ma("SMA_20W", SECTOR), "IS_BELOW", series("SMA_50W")),
          ],
        },
      ],
    },
  },
  {
    id: "T04",
    slug: "sector-rsi-ladder",
    description:
      "BUY 25 / 50 / 100% on `Stock's Sector · RSI 14D below 45 / 40 / 35 AND RSI 14D below 40 / 35 " +
      "/ 30`; SELL 50% on `Stock's Sector · RSI 14D above 65`; FINAL EXIT on `Stock's Sector · RSI " +
      "21D above 70`. Nested sector and stock oscillators and the strongest-eligible-BUY rule.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "MIXED_DATA_SOURCES",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_25",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "STRONGEST_ELIGIBLE_BUY",
    ],
    definition: {
      buyLevels: [25, 50, 100].map((percentage, index) => ({
        percentage: percentage as BuyLevelPercentage,
        conditions: [
          when(rsi("RSI_14D", SECTOR), "IS_BELOW", number(45 - index * 5)),
          when(rsi("RSI_14D"), "IS_BELOW", number(40 - index * 5)),
        ],
      })),
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(rsi("RSI_14D", SECTOR), "IS_ABOVE", number(65))],
        },
      ],
      finalExit: [
        { conditions: [when(rsi("RSI_21D", SECTOR), "IS_ABOVE", number(70))] },
      ],
    },
  },
  {
    id: "T05",
    slug: "sector-volume-breakout",
    description:
      "BUY 100% on `Stock's Sector · RVOL 20 above 1.3x AND Stock's Sector · RSI 7D above 55`, with " +
      "the stock's Trigger `Price crosses above SMA 50D`; SELL 25% on `Gain above 15%`; FINAL EXIT on " +
      "`Stock's Sector · RVOL 10 above 3x` or on `Stock's Sector · RVOL 50 above 2.5x AND Loss above " +
      "10%`. Every RVOL period on the sector fund, a stock Trigger gated by sector Conditions and " +
      "position-dependent exits.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "SAME_SOURCE_MULTIPLE_CONDITIONS",
      "MIXED_DATA_SOURCES",
      "TRIGGER_CROSSES_ABOVE",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "GAIN",
      "LOSS",
      "BUY_100",
      "SELL_25",
      "FINAL_EXIT",
      "SPARSE_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(rvol(20, SECTOR), "IS_ABOVE", multiple(1.3)),
            when(rsi("RSI_7D", SECTOR), "IS_ABOVE", number(55)),
          ],
          trigger: on(price(), "CROSSES_ABOVE", series("SMA_50D")),
        },
      ],
      sellLevels: [
        { percentage: 25, conditions: [when(gain, "IS_ABOVE", percent(15))] },
      ],
      finalExit: [
        { conditions: [when(rvol(10, SECTOR), "IS_ABOVE", multiple(3))] },
        {
          conditions: [
            when(rvol(50, SECTOR), "IS_ABOVE", multiple(2.5)),
            when(loss, "IS_ABOVE", percent(10)),
          ],
        },
      ],
    },
  },
  {
    id: "T06",
    slug: "sector-and-static-fund",
    description:
      "BUY 100% on `Stock's Sector · Price above SMA 200D AND SPY · Price above SPY · SMA 200D AND XLK · " +
      "RSI 14D below 70`; FINAL EXIT when SPY closes below its SMA 200D. Static ETFs beside the sector " +
      "source — for a Technology stock XLK is read twice, once by name and once as its sector, and the " +
      "two must agree.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "STOCK_SECTOR_SOURCE",
      "MULTIPLE_ETF_SOURCES",
      "MIXED_DATA_SOURCES",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(price(SECTOR), "IS_ABOVE", series("SMA_200D")),
            when(price(SPY), "IS_ABOVE", series("SMA_200D")),
            when(rsi("RSI_14D", etf("ETF_XLK")), "IS_BELOW", number(70)),
          ],
        },
      ],
      finalExit: [
        { conditions: [when(price(SPY), "IS_BELOW", series("SMA_200D"))] },
      ],
    },
  },
  {
    id: "T07",
    slug: "sector-with-fundamentals",
    description:
      "BUY 100% on `Stock's Sector · Price above SMA 50D AND ROIC TTM above 10% AND Debt / Equity " +
      "below 2.0x`; SELL 50% on `Stock's Sector · RSI 14D above 75`; FINAL EXIT on `ROIC TTM below " +
      "5%`. A sector rule beside point-in-time Fundamentals on the same session.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "MIXED_DATA_SOURCES",
      "FUNDAMENTAL_PERCENT",
      "FUNDAMENTAL_MULTIPLE",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(price(SECTOR), "IS_ABOVE", series("SMA_50D")),
            when(fundamental("ROIC_TTM"), "IS_ABOVE", percent(10)),
            when(fundamental("DEBT_TO_EQUITY"), "IS_BELOW", multiple(2)),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(rsi("RSI_14D", SECTOR), "IS_ABOVE", number(75))],
        },
      ],
      finalExit: [
        { conditions: [when(fundamental("ROIC_TTM"), "IS_BELOW", percent(5))] },
      ],
    },
  },
  {
    id: "T08",
    slug: "sector-with-valuation",
    description:
      "BUY 100% on `Stock's Sector · SMA 50D above EMA 200D AND P/E below 25x AND Margin of Safety " +
      "(Balanced) above 0%`; FINAL EXIT on `P/E above 40x`. A sector trend beside a valuation ratio " +
      "and an intrinsic-value margin, each of which can be unavailable on its own sessions.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "MIXED_DATA_SOURCES",
      "MARGIN_OF_SAFETY",
      "DAILY_MOVING_AVERAGE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(ma("SMA_50D", SECTOR), "IS_ABOVE", series("EMA_200D")),
            when(ratio("PRICE_TO_EARNINGS_TTM"), "IS_BELOW", multiple(25)),
            when(mos("BALANCED"), "IS_ABOVE", percent(0)),
          ],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(ratio("PRICE_TO_EARNINGS_TTM"), "IS_ABOVE", multiple(40)),
          ],
        },
      ],
    },
  },
  {
    id: "T09",
    slug: "xlk-by-name-control",
    description:
      "BUY 100% on `XLK · Price above XLK · SMA 50D AND XLK · RSI 14D below 70`; FINAL EXIT when XLK " +
      "closes below its SMA 200D. The **control** of the sector-equivalence pair: on `L01`, whose one " +
      "member is a Technology company, `T10` must reproduce it exactly.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "ETF_SOURCE",
      "SAME_SOURCE_MULTIPLE_CONDITIONS",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "METAMORPHIC_CONTROL",
    ],
    definition: XLK_RULE(etf("ETF_XLK")),
  },
  {
    id: "T10",
    slug: "xlk-as-sector-probe",
    description:
      "`T09` reading Stock's Sector instead of XLK. For a Technology stock the two are the same " +
      "fund, so on `L01` the results must be identical; on every other list they legitimately " +
      "differ, because each member then reads its own sector.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "STOCK_SECTOR_SOURCE",
      "SAME_SOURCE_MULTIPLE_CONDITIONS",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "EQUIVALENCE_PROBE",
    ],
    definition: XLK_RULE(SECTOR),
    levelPrefix: "T09",
  },
];

function fixturesOf(
  specs: readonly SourceStrategySpec[],
): readonly QaMatrixStrategyFixture[] {
  return specs.map((spec) => ({
    id: spec.id,
    name: `${QA_MATRIX_NAME_PREFIX}${spec.id}-${spec.slug}`,
    description: spec.description,
    behaviours: spec.behaviours,
    definition: buildDefinition(spec.levelPrefix ?? spec.id, spec.definition),
  }));
}

/** The ten static-ETF fixtures. Pure: nothing here names a database id. */
export const QA_MATRIX_ETF_STRATEGIES: readonly QaMatrixStrategyFixture[] =
  fixturesOf(ETF_STRATEGY_SPECS);

/** The ten Stock's Sector fixtures. Pure: nothing here names a database id. */
export const QA_MATRIX_SECTOR_STRATEGIES: readonly QaMatrixStrategyFixture[] =
  fixturesOf(SECTOR_STRATEGY_SPECS);

/** The equivalences each data-source dimension must hold, case by case. */
export const QA_MATRIX_METAMORPHIC_PAIRS: readonly QaMatrixMetamorphicPair[] = [
  {
    control: "E07",
    probe: "E08",
    listIds: null,
    reason:
      "E08 is E07 with `SPY · RVOL 10 is above 0x` — TRUE on every session — ANDed into every level.",
  },
  {
    control: "E09",
    probe: "E10",
    listIds: null,
    reason:
      "E10 is E09 plus a BUY level gated by `SPY · RSI 14D is above 100`, which no session satisfies.",
  },
  {
    control: "T09",
    probe: "T10",
    listIds: ["L01"],
    reason:
      "T10 reads Stock's Sector where T09 reads XLK; L01's only member is a Technology company.",
  },
];
