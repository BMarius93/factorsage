import {
  STRATEGY_SCHEMA_VERSION,
  type BuyLevelPercentage,
  type ConditionOperator,
  type FundamentalMetricId,
  type SelectableSeriesId,
  type SellLevelPercentage,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
  type TriggerOperator,
} from "@intrinsic/contracts";
import {
  QA_MATRIX_NAME_PREFIX,
  type QaMatrixStrategyBehaviour,
  type QaMatrixStrategyFixture,
} from "./strategies.js";

/**
 * The ten **Fundamentals** QA-MATRIX Strategy fixtures: `F01` … `F10`.
 *
 * A third strategy dimension beside the core baseline (`S01` … `S10`) and the Relative Volume /
 * alternative-data audit variant (`A01` … `A10`), for the reason the second one exists: the core
 * set is a recorded baseline, and editing it to make room for a new metric family would silently
 * move a thousand runs' worth of meaning. Selected explicitly (`--strategies fundamentals`), it runs
 * against the same ten Lists and ten configurations, so a sweep is 1,000 real runs through the
 * application and worker path.
 *
 * **The coverage model is the family's rules, not its fifteen instances multiplied.** Every
 * Fundamental Metric goes through one operand family and one projector, so a 15 x 10 x 10 cube would
 * add runtime without adding a distinct path. What varies between metrics is exactly what the ten
 * fixtures below vary:
 *
 * - **unit** — percentage points (growth, margins, returns) against raw multiples (leverage,
 *   liquidity, coverage, turnover), in both directions;
 * - **sign and zero** — a negative threshold (`Net Debt / EBITDA is below 0x`, net cash), a zero
 *   threshold (`Revenue Growth is below 0%`), and strict comparison throughout;
 * - **availability** — growth across a loss, a cross-family margin, a solvency ratio without
 *   interest expense, and a deliberate probe (`F10`) whose four conditions are rarely all decidable,
 *   so a run proves the engine withholds rather than reads zero;
 * - **combination** — several Fundamentals ANDed, and Fundamentals ANDed with Price, a moving
 *   average, RSI, Relative Volume and Margin of Safety (whose intrinsic value comes from the very
 *   statements the Fundamentals do), and a Fundamental Condition beside a technical Trigger;
 * - **level** — BUY, SELL and FINAL EXIT, a two-rule FINAL EXIT, and a Fundamental beside a
 *   position-dependent exit.
 *
 * Every one of the fifteen identities appears at least once, so a sweep projects all fifteen
 * `fundamental:*` columns; `qa-matrix-fundamental-fixtures.test.ts` fails if a metric is ever left
 * out.
 *
 * Every Metric / operator / Value combination below is one `ai/product/strategies.md` permits;
 * `validateStrategy` is what proves it, not this comment.
 */

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

const price: StrategyMetric = { kind: "PRICE" };
const loss: StrategyMetric = { kind: "LOSS" };
const fundamental = (metricId: FundamentalMetricId): StrategyMetric => ({
  kind: "FUNDAMENTAL",
  metricId,
});
const rsi = (seriesId: SelectableSeriesId): StrategyMetric => ({
  kind: "OSCILLATOR",
  seriesId,
});
const mos = (sourceId: SelectableSeriesId): StrategyMetric => ({
  kind: "MARGIN_OF_SAFETY",
  sourceId,
});
const rvol = (period: 10 | 20 | 50): StrategyMetric => ({
  kind: "RELATIVE_VOLUME",
  period,
});

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

function buildDefinition(
  fixtureId: string,
  spec: DefinitionSpec,
): StrategyDefinition {
  const slug = fixtureId.toLowerCase();
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

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

type FundamentalStrategySpec = {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixStrategyBehaviour[];
  readonly definition: DefinitionSpec;
};

const FUNDAMENTAL_STRATEGY_SPECS: readonly FundamentalStrategySpec[] = [
  {
    id: "F01",
    slug: "roic-quality",
    description:
      "BUY 100% on `ROIC TTM is above 15%`; FINAL EXIT on `ROIC TTM is below 8%`. The simplest " +
      "percentage-point Fundamental, entered and left on the same metric: a statement event that " +
      "moves ROIC across either threshold is the only thing that can trade.",
    behaviours: [
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_PERCENT",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [when(fundamental("ROIC_TTM"), "IS_ABOVE", percent(15))],
        },
      ],
      finalExit: [
        { conditions: [when(fundamental("ROIC_TTM"), "IS_BELOW", percent(8))] },
      ],
    },
  },
  {
    id: "F02",
    slug: "balance-sheet-strength",
    description:
      "BUY 100% on `Debt / Equity is below 1.0x AND Current Ratio is above 1.2x`; SELL 50% on " +
      "`Debt / Equity is above 2.0x`. Two raw multiples from the latest balance sheet: an " +
      "unavailable Debt / Equity (negative equity) must never read as a zero that satisfies " +
      "`is below 1.0x`.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_MULTIPLE",
      "BUY_100",
      "SELL_50",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(fundamental("DEBT_TO_EQUITY"), "IS_BELOW", multiple(1)),
            when(fundamental("CURRENT_RATIO"), "IS_ABOVE", multiple(1.2)),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [
            when(fundamental("DEBT_TO_EQUITY"), "IS_ABOVE", multiple(2)),
          ],
        },
      ],
    },
  },
  {
    id: "F03",
    slug: "growth-ladder",
    description:
      "BUY 50% on `Revenue Growth TTM YoY is above 10% AND EPS Growth TTM YoY is above 10%`, BUY " +
      "100% on `FCF Growth TTM YoY is above 15%`; FINAL EXIT on `Revenue Growth TTM YoY is below " +
      "0%`. Eight-quarter chains in two statement families, a growth rate that is unavailable " +
      "across a loss, and a zero threshold.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_PERCENT",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [
            when(
              fundamental("REVENUE_GROWTH_TTM_YOY"),
              "IS_ABOVE",
              percent(10),
            ),
            when(fundamental("EPS_GROWTH_TTM_YOY"), "IS_ABOVE", percent(10)),
          ],
        },
        {
          percentage: 100,
          conditions: [
            when(fundamental("FCF_GROWTH_TTM_YOY"), "IS_ABOVE", percent(15)),
          ],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(fundamental("REVENUE_GROWTH_TTM_YOY"), "IS_BELOW", percent(0)),
          ],
        },
      ],
    },
  },
  {
    id: "F04",
    slug: "margin-stack",
    description:
      "BUY 100% on `Gross Margin TTM is above 40% AND Operating Margin TTM is above 15% AND Net " +
      "Margin TTM is above 10% AND FCF Margin TTM is above 10%`. Four margins ANDed, the last of " +
      "them needing the Income and Cash Flow families aligned on one newest quarter.",
    behaviours: [
      "AND_CONDITIONS",
      "FUNDAMENTAL_PERCENT",
      "BUY_100",
      "NO_SELL_LEVELS",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(fundamental("GROSS_MARGIN_TTM"), "IS_ABOVE", percent(40)),
            when(fundamental("OPERATING_MARGIN_TTM"), "IS_ABOVE", percent(15)),
            when(fundamental("NET_MARGIN_TTM"), "IS_ABOVE", percent(10)),
            when(fundamental("FCF_MARGIN_TTM"), "IS_ABOVE", percent(10)),
          ],
        },
      ],
    },
  },
  {
    id: "F05",
    slug: "returns-with-stop",
    description:
      "BUY 75% on `ROE TTM is above 15% AND ROA TTM is above 5%`; SELL 25% on `ROE TTM is below " +
      "10%`; FINAL EXIT on `Loss is above 20%`. Two averaged-state returns and a position-dependent " +
      "exit beside them.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_PERCENT",
      "LOSS",
      "BUY_75",
      "SELL_25",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 75,
          conditions: [
            when(fundamental("ROE_TTM"), "IS_ABOVE", percent(15)),
            when(fundamental("ROA_TTM"), "IS_ABOVE", percent(5)),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 25,
          conditions: [when(fundamental("ROE_TTM"), "IS_BELOW", percent(10))],
        },
      ],
      finalExit: [{ conditions: [when(loss, "IS_ABOVE", percent(20))] }],
    },
  },
  {
    id: "F06",
    slug: "net-cash-solvency",
    description:
      "BUY 100% on `Net Debt / EBITDA TTM is below 0x` (net cash); FINAL EXIT on `Interest " +
      "Coverage TTM is below 3x` OR `Net Debt / EBITDA TTM is above 3x`. A negative threshold on a " +
      "signed multiple and a two-rule FINAL EXIT made of Fundamentals.",
    behaviours: [
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_MULTIPLE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(
              fundamental("NET_DEBT_TO_EBITDA_TTM"),
              "IS_BELOW",
              multiple(0),
            ),
          ],
        },
      ],
      finalExit: [
        {
          conditions: [
            when(fundamental("INTEREST_COVERAGE_TTM"), "IS_BELOW", multiple(3)),
          ],
        },
        {
          conditions: [
            when(
              fundamental("NET_DEBT_TO_EBITDA_TTM"),
              "IS_ABOVE",
              multiple(3),
            ),
          ],
        },
      ],
    },
  },
  {
    id: "F07",
    slug: "turnover-in-uptrend",
    description:
      "BUY 100% on `Asset Turnover TTM is above 0.8x AND Price is above SMA 200D AND RSI 14D is " +
      "below 70`; SELL 50% on `Price is below SMA 50D`. A Fundamental ANDed with a moving average " +
      "and an oscillator: the daily technicals change every session, the Fundamental only on a " +
      "statement event.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_MULTIPLE",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_100",
      "SELL_50",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(fundamental("ASSET_TURNOVER_TTM"), "IS_ABOVE", multiple(0.8)),
            when(price, "IS_ABOVE", series("SMA_200D")),
            when(rsi("RSI_14D"), "IS_BELOW", number(70)),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(price, "IS_BELOW", series("SMA_50D"))],
        },
      ],
    },
  },
  {
    id: "F08",
    slug: "value-with-quality",
    description:
      "BUY 100% on `Margin of Safety (Balanced) is above 10% AND ROIC TTM is above 10% AND Debt / " +
      "Equity is below 1.5x`; FINAL EXIT on `Margin of Safety (Balanced) is below -20%`. Intrinsic " +
      "value and Fundamental Metrics are materialized from the same statement revisions on the same " +
      "sessions; this is where a revision that moved one and not the other would show.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "FUNDAMENTAL_PERCENT",
      "FUNDAMENTAL_MULTIPLE",
      "MARGIN_OF_SAFETY",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(mos("BALANCED"), "IS_ABOVE", percent(10)),
            when(fundamental("ROIC_TTM"), "IS_ABOVE", percent(10)),
            when(fundamental("DEBT_TO_EQUITY"), "IS_BELOW", multiple(1.5)),
          ],
        },
      ],
      finalExit: [
        { conditions: [when(mos("BALANCED"), "IS_BELOW", percent(-20))] },
      ],
    },
  },
  {
    id: "F09",
    slug: "margin-breakout",
    description:
      "BUY 50% on `Operating Margin TTM is above 20% AND RVOL 20 is above 1.2x`, with the Trigger " +
      "`Price crosses above SMA 50D`; SELL 75% on `RSI 14D is above 75`. A Fundamental Condition " +
      "ANDed with Relative Volume beside a technical Trigger — a Fundamental can never be the " +
      "Trigger, but it can gate one.",
    behaviours: [
      "AND_CONDITIONS",
      "SIMPLE_CONDITION",
      "TRIGGER_CROSSES_ABOVE",
      "FUNDAMENTAL_PERCENT",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "BUY_50",
      "SELL_75",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [
            when(fundamental("OPERATING_MARGIN_TTM"), "IS_ABOVE", percent(20)),
            when(rvol(20), "IS_ABOVE", multiple(1.2)),
          ],
          trigger: on(price, "CROSSES_ABOVE", series("SMA_50D")),
        },
      ],
      sellLevels: [
        {
          percentage: 75,
          conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(75))],
        },
      ],
    },
  },
  {
    id: "F10",
    slug: "unavailable-probe",
    description:
      "BUY 100% on `EPS Growth TTM YoY is above 25% AND FCF Growth TTM YoY is above 25% AND " +
      "Interest Coverage TTM is above 50x AND Current Ratio is above 3x`; no SELL, no FINAL EXIT. " +
      "The deliberate NOT_EVALUABLE probe: growth is unavailable across a loss, coverage without " +
      "interest expense, a current ratio for a balance sheet without current liabilities — so this " +
      "strategy must trade rarely, and never because an undecidable operand was read as zero.",
    behaviours: [
      "AND_CONDITIONS",
      "FUNDAMENTAL_PERCENT",
      "FUNDAMENTAL_MULTIPLE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "SPARSE_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(fundamental("EPS_GROWTH_TTM_YOY"), "IS_ABOVE", percent(25)),
            when(fundamental("FCF_GROWTH_TTM_YOY"), "IS_ABOVE", percent(25)),
            when(
              fundamental("INTEREST_COVERAGE_TTM"),
              "IS_ABOVE",
              multiple(50),
            ),
            when(fundamental("CURRENT_RATIO"), "IS_ABOVE", multiple(3)),
          ],
        },
      ],
    },
  },
];

/** The ten Fundamentals fixtures. Pure: unlike the audit set, nothing here names a database id. */
export const QA_MATRIX_FUNDAMENTAL_STRATEGIES: readonly QaMatrixStrategyFixture[] =
  FUNDAMENTAL_STRATEGY_SPECS.map((spec) => ({
    id: spec.id,
    name: `${QA_MATRIX_NAME_PREFIX}${spec.id}-${spec.slug}`,
    description: spec.description,
    behaviours: spec.behaviours,
    definition: buildDefinition(spec.id, spec.definition),
  }));

/** The Fundamentals fixture ids, for a runner that needs them before the database is reachable. */
export const QA_MATRIX_FUNDAMENTAL_STRATEGY_IDS: readonly string[] =
  QA_MATRIX_FUNDAMENTAL_STRATEGIES.map((fixture) => fixture.id);
