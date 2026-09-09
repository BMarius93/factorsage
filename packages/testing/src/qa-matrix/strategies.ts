import {
  STRATEGY_SCHEMA_VERSION,
  type BuyLevelPercentage,
  type ConditionOperator,
  type SellLevelPercentage,
  type SelectableSeriesId,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
  type StrategyValue,
  type TriggerOperator,
} from "@intrinsic/contracts";

/**
 * The ten persistent QA-MATRIX Strategy fixtures.
 *
 * They are designed for coverage of Backtest V1 semantics, not sampled at random: between them
 * they use every Condition operator, both Trigger operators, every Metric family the V1
 * compatibility table admits, every BUY and SELL percentage, FINAL EXIT, and the execution
 * behaviours `ai/architecture/backtest-execution.md` decides — the strongest eligible BUY level,
 * the position lifecycle reset, and the contribution-date top-up.
 *
 * Nothing here invents product surface. Every Metric / operator / Value combination below is one
 * `ai/product/strategies.md` already permits, and `validateStrategy` from `@intrinsic/contracts`
 * is what proves it rather than this comment.
 */

// ---------------------------------------------------------------------------
// Behaviour tags
// ---------------------------------------------------------------------------

/**
 * What a fixture is intended to exercise.
 *
 * The tags in {@link STRUCTURAL_STRATEGY_BEHAVIOURS} are readable straight off the definition, so a
 * fixture cannot claim one it does not contain — `deriveStrategyBehaviours` recomputes them and the
 * fixture suite requires the two sets to be identical. The remaining tags describe how the strategy
 * behaves once the engine runs it, which no static check can settle; they are documented intent.
 */
export const QA_MATRIX_STRATEGY_BEHAVIOURS = [
  // Structural — provable from the definition document.
  "SIMPLE_CONDITION",
  "AND_CONDITIONS",
  "TRIGGER_CROSSES_ABOVE",
  "TRIGGER_CROSSES_BELOW",
  "IS_CLOSE_TO",
  "DAILY_MOVING_AVERAGE",
  "WEEKLY_MOVING_AVERAGE",
  "RSI",
  "MARGIN_OF_SAFETY",
  "GAIN",
  "LOSS",
  "MULTIPLE_BUY_LEVELS",
  "BUY_25",
  "BUY_50",
  "BUY_75",
  "BUY_100",
  "SELL_25",
  "SELL_50",
  "SELL_75",
  "FINAL_EXIT",
  "NO_SELL_LEVELS",
  // Behavioural — intent, settled by executing the matrix rather than by a static check.
  "STRONGEST_ELIGIBLE_BUY",
  "LIFECYCLE_RESET",
  "CONTRIBUTION_TOP_UP",
  "PERSISTENT_SIGNAL",
  "ONE_DAY_TRIGGER",
  "HIGH_TURNOVER",
  "SPARSE_SIGNAL",
  "SAME_DAY_SELL_THEN_BUY",
] as const;

export type QaMatrixStrategyBehaviour =
  (typeof QA_MATRIX_STRATEGY_BEHAVIOURS)[number];

/** The tags `deriveStrategyBehaviours` is responsible for; the rest are documented intent. */
export const STRUCTURAL_STRATEGY_BEHAVIOURS = [
  "SIMPLE_CONDITION",
  "AND_CONDITIONS",
  "TRIGGER_CROSSES_ABOVE",
  "TRIGGER_CROSSES_BELOW",
  "IS_CLOSE_TO",
  "DAILY_MOVING_AVERAGE",
  "WEEKLY_MOVING_AVERAGE",
  "RSI",
  "MARGIN_OF_SAFETY",
  "GAIN",
  "LOSS",
  "MULTIPLE_BUY_LEVELS",
  "BUY_25",
  "BUY_50",
  "BUY_75",
  "BUY_100",
  "SELL_25",
  "SELL_50",
  "SELL_75",
  "FINAL_EXIT",
  "NO_SELL_LEVELS",
] as const satisfies readonly QaMatrixStrategyBehaviour[];

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

const price: StrategyMetric = { kind: "PRICE" };
const gain: StrategyMetric = { kind: "GAIN" };
const loss: StrategyMetric = { kind: "LOSS" };
const ma = (seriesId: SelectableSeriesId): StrategyMetric => ({
  kind: "MOVING_AVERAGE",
  seriesId,
});
const rsi = (seriesId: SelectableSeriesId): StrategyMetric => ({
  kind: "OSCILLATOR",
  seriesId,
});
const mos = (sourceId: SelectableSeriesId): StrategyMetric => ({
  kind: "MARGIN_OF_SAFETY",
  sourceId,
});

const series = (seriesId: SelectableSeriesId): StrategyValue => ({
  kind: "SERIES",
  seriesId,
});
const number = (value: number): StrategyValue => ({ kind: "NUMBER", value });
const percent = (value: number): StrategyValue => ({ kind: "PERCENT", value });

type PredicateSpec<Operator> = {
  readonly metric: StrategyMetric;
  readonly operator: Operator;
  readonly value: StrategyValue;
};

type ConditionSpec = PredicateSpec<ConditionOperator>;
type TriggerSpec = PredicateSpec<TriggerOperator>;

const when = (
  metric: StrategyMetric,
  operator: ConditionOperator,
  value: StrategyValue,
): ConditionSpec => ({ metric, operator, value });

const onCross = (
  metric: StrategyMetric,
  operator: TriggerOperator,
  value: StrategyValue,
): TriggerSpec => ({ metric, operator, value });

type SignalSpec = {
  readonly conditions?: readonly ConditionSpec[];
  readonly trigger?: TriggerSpec;
};

type LevelSpec<Percentage> = SignalSpec & { readonly percentage: Percentage };

type DefinitionSpec = {
  readonly buyLevels: readonly LevelSpec<BuyLevelPercentage>[];
  readonly sellLevels?: readonly LevelSpec<SellLevelPercentage>[];
  readonly finalExit?: SignalSpec;
};

/**
 * Materializes a definition with **positional** row ids: `s04-buy2-c1`, never a UUID.
 *
 * Row ids are part of the persisted document, so a fixture whose ids moved between two seeds would
 * write a different document each time and break idempotency. Deriving them from the fixture id and
 * the row's position makes them stable by construction, and makes a fixture's meaning independent
 * of anything generated at seed time.
 */
function buildSignal(prefix: string, spec: SignalSpec): StrategySignal {
  const signal: StrategySignal = {
    conditions: (spec.conditions ?? []).map((condition, index) => ({
      id: `${prefix}-c${index + 1}`,
      metric: condition.metric,
      operator: condition.operator,
      value: condition.value,
    })),
  };
  if (spec.trigger) {
    signal.trigger = {
      id: `${prefix}-t`,
      metric: spec.trigger.metric,
      operator: spec.trigger.operator,
      value: spec.trigger.value,
    };
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
  if (spec.finalExit) {
    const id = `${slug}-exit`;
    definition.finalExit = { id, signal: buildSignal(id, spec.finalExit) };
  }
  return definition;
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

export type QaMatrixStrategyFixture = {
  /** `S01` … `S10`; the stable half of a `QA-MATRIX-Sxx-Lxx-Cxx` run identity. */
  readonly id: string;
  /** The persisted `Strategy.name`, and the reserved-namespace key the seeder reconciles on. */
  readonly name: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixStrategyBehaviour[];
  readonly definition: StrategyDefinition;
};

type StrategyFixtureSpec = {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixStrategyBehaviour[];
  readonly definition: DefinitionSpec;
};

const STRATEGY_SPECS: readonly StrategyFixtureSpec[] = [
  {
    id: "S01",
    slug: "price-above-sma200-hold",
    description:
      "One BUY 100% on a single Price-above-SMA 200D Condition, no SELL and no FINAL EXIT. The " +
      "simplest possible strategy, and the reference case for a signal that stays TRUE for long " +
      "stretches: a level already fired is reconsidered only on a date that actually deposits a " +
      "monthly contribution, which is what the top-up configurations exercise.",
    behaviours: [
      "SIMPLE_CONDITION",
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
          conditions: [when(price, "IS_ABOVE", series("SMA_200D"))],
        },
      ],
    },
  },
  {
    id: "S02",
    slug: "golden-cross-triggers",
    description:
      "Trigger-only entry and exit: SMA 50D crossing above SMA 200D opens a full position, the " +
      "reverse cross closes it. Both Signals are one-day events, so the position lifecycle resets " +
      "on every cross pair and no contribution-date top-up can ever apply — the Trigger is false " +
      "on virtually every deposit date.",
    behaviours: [
      "TRIGGER_CROSSES_ABOVE",
      "TRIGGER_CROSSES_BELOW",
      "DAILY_MOVING_AVERAGE",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "ONE_DAY_TRIGGER",
      "LIFECYCLE_RESET",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          trigger: onCross(ma("SMA_50D"), "CROSSES_ABOVE", series("SMA_200D")),
        },
      ],
      finalExit: {
        trigger: onCross(ma("SMA_50D"), "CROSSES_BELOW", series("SMA_200D")),
      },
    },
  },
  {
    id: "S03",
    slug: "weekly-trend-ladder",
    description:
      "Weekly moving averages as both Metric and Value, ANDed with a daily confirmation. Two BUY " +
      "levels (50% then 100%) scale into a confirmed weekly uptrend, a partial SELL trims it, and " +
      "FINAL EXIT closes on the weekly trend breaking. Weekly values come from completed weeks " +
      "carried forward, so its signals persist for many consecutive daily rows.",
    behaviours: [
      "SIMPLE_CONDITION",
      "AND_CONDITIONS",
      "WEEKLY_MOVING_AVERAGE",
      "DAILY_MOVING_AVERAGE",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "PERSISTENT_SIGNAL",
      "CONTRIBUTION_TOP_UP",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [
            when(price, "IS_ABOVE", series("SMA_50W")),
            when(ma("SMA_20W"), "IS_ABOVE", series("SMA_100W")),
          ],
        },
        {
          percentage: 100,
          conditions: [
            when(price, "IS_ABOVE", series("SMA_50W")),
            when(ma("SMA_20W"), "IS_ABOVE", series("SMA_100W")),
            when(price, "IS_ABOVE", series("EMA_20D")),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(price, "IS_BELOW", series("SMA_50W"))],
        },
      ],
      finalExit: {
        conditions: [when(ma("SMA_20W"), "IS_BELOW", series("SMA_100W"))],
      },
    },
  },
  {
    id: "S04",
    slug: "rsi-nested-buy-ladder",
    description:
      "Three nested RSI 14D thresholds — below 40 buys 25%, below 30 buys 50%, below 20 buys " +
      "100% — so a deeply oversold date satisfies every level at once. That is the strongest " +
      "eligible BUY level case: candidate ordering runs the 100% level first and the weaker levels " +
      "settle as already satisfied without a second trade. A partial SELL and a FINAL EXIT above " +
      "give it a complete, repeatable position lifecycle.",
    behaviours: [
      "SIMPLE_CONDITION",
      "RSI",
      "MULTIPLE_BUY_LEVELS",
      "BUY_25",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "STRONGEST_ELIGIBLE_BUY",
      "LIFECYCLE_RESET",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 25,
          conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(40))],
        },
        {
          percentage: 50,
          conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(30))],
        },
        {
          percentage: 100,
          conditions: [when(rsi("RSI_14D"), "IS_BELOW", number(20))],
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(70))],
        },
      ],
      finalExit: { conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(80))] },
    },
  },
  {
    id: "S05",
    slug: "rsi7-high-turnover-swing",
    description:
      "The high-turnover fixture. A short-period RSI 7D cross opens a full position, two Gain " +
      "thresholds trim it in definition order, and an RSI 7D cross the other way closes it — so " +
      "positions turn over quickly and the same date routinely closes one symbol while opening " +
      "another. Exits run before entries, so the freed slot and the released cash are usable that " +
      "same date.",
    behaviours: [
      "SIMPLE_CONDITION",
      "TRIGGER_CROSSES_ABOVE",
      "TRIGGER_CROSSES_BELOW",
      "RSI",
      "GAIN",
      "BUY_100",
      "SELL_25",
      "SELL_50",
      "FINAL_EXIT",
      "HIGH_TURNOVER",
      "LIFECYCLE_RESET",
      "SAME_DAY_SELL_THEN_BUY",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          trigger: onCross(rsi("RSI_7D"), "CROSSES_BELOW", number(35)),
        },
      ],
      sellLevels: [
        { percentage: 25, conditions: [when(gain, "IS_ABOVE", percent(5))] },
        { percentage: 50, conditions: [when(gain, "IS_ABOVE", percent(10))] },
      ],
      finalExit: {
        trigger: onCross(rsi("RSI_7D"), "CROSSES_ABOVE", number(65)),
      },
    },
  },
  {
    id: "S06",
    slug: "sparse-confluence",
    description:
      "The rare-signal fixture. Four Conditions spanning two RSI periods, a daily and a weekly " +
      "moving average, ANDed with a Trigger that must fire on the same date — the maximum breadth " +
      "of a V1 Signal, and a combination that comes true only a handful of times per decade. It is " +
      "the control case for a matrix run that legitimately produces very few trades, and for a " +
      "FINAL EXIT driven by realized Gain rather than by market data.",
    behaviours: [
      "SIMPLE_CONDITION",
      "AND_CONDITIONS",
      "TRIGGER_CROSSES_BELOW",
      "RSI",
      "DAILY_MOVING_AVERAGE",
      "WEEKLY_MOVING_AVERAGE",
      "GAIN",
      "BUY_100",
      "NO_SELL_LEVELS",
      "FINAL_EXIT",
      "SPARSE_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 100,
          conditions: [
            when(rsi("RSI_14D"), "IS_BELOW", number(20)),
            when(price, "IS_BELOW", series("SMA_200D")),
            when(price, "IS_BELOW", series("SMA_100W")),
            when(ma("SMA_20D"), "IS_BELOW", series("SMA_200D")),
          ],
          trigger: onCross(rsi("RSI_21D"), "CROSSES_BELOW", number(25)),
        },
      ],
      finalExit: { conditions: [when(gain, "IS_ABOVE", percent(50))] },
    },
  },
  {
    id: "S07",
    slug: "persistent-dca-ladder",
    description:
      "The contribution-top-up fixture. Three Condition-only BUY levels at 25%, 50% and 75% sit " +
      "on top of a very slow weekly trend filter, so their Signals stay TRUE across long runs of " +
      "consecutive dates. Nothing ever sells, so positions hold their slots for the whole run and " +
      "every deposit date reconsiders each fired level against the larger portfolio, buying only " +
      "the shortfall to its recalculated target.",
    behaviours: [
      "SIMPLE_CONDITION",
      "AND_CONDITIONS",
      "WEEKLY_MOVING_AVERAGE",
      "DAILY_MOVING_AVERAGE",
      "MULTIPLE_BUY_LEVELS",
      "BUY_25",
      "BUY_50",
      "BUY_75",
      "NO_SELL_LEVELS",
      "PERSISTENT_SIGNAL",
      "CONTRIBUTION_TOP_UP",
      "STRONGEST_ELIGIBLE_BUY",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 25,
          conditions: [when(price, "IS_ABOVE", series("SMA_200W"))],
        },
        {
          percentage: 50,
          conditions: [
            when(price, "IS_ABOVE", series("SMA_200W")),
            when(price, "IS_BELOW", series("SMA_50D")),
          ],
        },
        {
          percentage: 75,
          conditions: [
            when(price, "IS_ABOVE", series("SMA_200W")),
            when(price, "IS_BELOW", series("SMA_200D")),
          ],
        },
      ],
    },
  },
  {
    id: "S08",
    slug: "close-to-ema-reversion",
    description:
      "The `is close to` fixture, and the only one using Loss. Price within the fixed 2% tolerance " +
      "of EMA 200D opens half a position, the same state with a calmer RSI 21D takes it to full, a " +
      "75% partial SELL banks a gain once price has run past EMA 20D, and a Loss stop ends the " +
      "position. Market-derived and position-dependent Metrics appear inside one Signal.",
    behaviours: [
      "SIMPLE_CONDITION",
      "AND_CONDITIONS",
      "IS_CLOSE_TO",
      "DAILY_MOVING_AVERAGE",
      "RSI",
      "GAIN",
      "LOSS",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_75",
      "FINAL_EXIT",
      "PERSISTENT_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [when(price, "IS_CLOSE_TO", series("EMA_200D"))],
        },
        {
          percentage: 100,
          conditions: [
            when(price, "IS_CLOSE_TO", series("EMA_200D")),
            when(rsi("RSI_21D"), "IS_BELOW", number(45)),
          ],
        },
      ],
      sellLevels: [
        {
          percentage: 75,
          conditions: [
            when(price, "IS_ABOVE", series("EMA_20D")),
            when(gain, "IS_ABOVE", percent(15)),
          ],
        },
      ],
      finalExit: { conditions: [when(loss, "IS_ABOVE", percent(20))] },
    },
  },
  {
    id: "S09",
    slug: "margin-of-safety",
    description:
      "The valuation fixture: Margin of Safety against two different intrinsic-value sources, plus " +
      "Price compared with an intrinsic-value series and a MOS Trigger crossing a negative " +
      "threshold. It is also the deliberate NOT_EVALUABLE probe — MOS reads point-in-time " +
      "intrinsic values through the provenance gate, so on a security whose fundamentals are not " +
      "hydrated every predicate here is unavailable and the strategy correctly trades nothing.",
    behaviours: [
      "SIMPLE_CONDITION",
      "MARGIN_OF_SAFETY",
      "TRIGGER_CROSSES_ABOVE",
      "TRIGGER_CROSSES_BELOW",
      "MULTIPLE_BUY_LEVELS",
      "BUY_50",
      "BUY_100",
      "SELL_50",
      "FINAL_EXIT",
      "SPARSE_SIGNAL",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 50,
          conditions: [when(mos("DCF_FCFF"), "IS_ABOVE", percent(25))],
        },
        {
          percentage: 100,
          conditions: [when(mos("BALANCED"), "IS_ABOVE", percent(40))],
          trigger: onCross(price, "CROSSES_ABOVE", series("GRAHAM")),
        },
      ],
      sellLevels: [
        {
          percentage: 50,
          conditions: [when(mos("BALANCED"), "IS_BELOW", percent(0))],
        },
      ],
      finalExit: {
        trigger: onCross(mos("DCF_FCFF"), "CROSSES_BELOW", percent(-10)),
      },
    },
  },
  {
    id: "S10",
    slug: "same-day-rotation",
    description:
      "The rotation fixture. Loose RSI 14D crosses on both sides fire somewhere in a thirty-name " +
      "list on most dates, so exits and entries collide constantly — most visibly under " +
      "maximumPositions = 1, where the slot a FINAL EXIT frees is taken by a different symbol at " +
      "the same close. Same-symbol re-entry on the closing date stays forbidden by engine " +
      "methodology; the rotation this exercises is across the universe, not within one security.",
    behaviours: [
      "SIMPLE_CONDITION",
      "TRIGGER_CROSSES_ABOVE",
      "TRIGGER_CROSSES_BELOW",
      "RSI",
      "GAIN",
      "MULTIPLE_BUY_LEVELS",
      "BUY_25",
      "BUY_100",
      "SELL_25",
      "FINAL_EXIT",
      "HIGH_TURNOVER",
      "ONE_DAY_TRIGGER",
      "SAME_DAY_SELL_THEN_BUY",
      "LIFECYCLE_RESET",
    ],
    definition: {
      buyLevels: [
        {
          percentage: 25,
          trigger: onCross(rsi("RSI_14D"), "CROSSES_BELOW", number(45)),
        },
        {
          percentage: 100,
          trigger: onCross(rsi("RSI_14D"), "CROSSES_BELOW", number(30)),
        },
      ],
      sellLevels: [
        { percentage: 25, conditions: [when(gain, "IS_ABOVE", percent(8))] },
        { percentage: 25, conditions: [when(gain, "IS_ABOVE", percent(20))] },
      ],
      finalExit: {
        trigger: onCross(rsi("RSI_14D"), "CROSSES_ABOVE", number(55)),
      },
    },
  },
];

/** The reserved namespace every matrix fixture name begins with. */
export const QA_MATRIX_NAME_PREFIX = "QA-MATRIX-";

export const QA_MATRIX_STRATEGIES: readonly QaMatrixStrategyFixture[] =
  STRATEGY_SPECS.map((spec) => ({
    id: spec.id,
    name: `${QA_MATRIX_NAME_PREFIX}${spec.id}-${spec.slug}`,
    description: spec.description,
    behaviours: spec.behaviours,
    definition: buildDefinition(spec.id, spec.definition),
  }));

// ---------------------------------------------------------------------------
// Derived behaviour tags
// ---------------------------------------------------------------------------

function signalsOf(definition: StrategyDefinition): StrategySignal[] {
  return [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit ? [definition.finalExit.signal] : []),
  ];
}

function isWeekly(seriesId: SelectableSeriesId): boolean {
  return seriesId.endsWith("W");
}

/**
 * The structural behaviour tags one definition actually contains.
 *
 * Recomputed from the document rather than trusted from the fixture, so a hand-written
 * `behaviours` list cannot drift away from the strategy it describes.
 */
export function deriveStrategyBehaviours(
  definition: StrategyDefinition,
): Set<QaMatrixStrategyBehaviour> {
  const tags = new Set<QaMatrixStrategyBehaviour>();
  const add = (tag: QaMatrixStrategyBehaviour): void => void tags.add(tag);

  for (const signal of signalsOf(definition)) {
    if (signal.conditions.length === 1 && !signal.trigger) {
      add("SIMPLE_CONDITION");
    }
    if (signal.conditions.length > 1) {
      add("AND_CONDITIONS");
    }
    for (const predicate of [
      ...signal.conditions,
      ...(signal.trigger ? [signal.trigger] : []),
    ]) {
      if (predicate.operator === "IS_CLOSE_TO") {
        add("IS_CLOSE_TO");
      }
      if (predicate.operator === "CROSSES_ABOVE") {
        add("TRIGGER_CROSSES_ABOVE");
      }
      if (predicate.operator === "CROSSES_BELOW") {
        add("TRIGGER_CROSSES_BELOW");
      }
      const { metric, value } = predicate;
      if (metric.kind === "MOVING_AVERAGE") {
        add(
          isWeekly(metric.seriesId)
            ? "WEEKLY_MOVING_AVERAGE"
            : "DAILY_MOVING_AVERAGE",
        );
      }
      if (metric.kind === "OSCILLATOR") {
        add("RSI");
      }
      if (metric.kind === "MARGIN_OF_SAFETY") {
        add("MARGIN_OF_SAFETY");
      }
      if (metric.kind === "GAIN") {
        add("GAIN");
      }
      if (metric.kind === "LOSS") {
        add("LOSS");
      }
      if (value.kind === "SERIES" && value.seriesId.startsWith("SMA_")) {
        add(
          isWeekly(value.seriesId)
            ? "WEEKLY_MOVING_AVERAGE"
            : "DAILY_MOVING_AVERAGE",
        );
      }
      if (value.kind === "SERIES" && value.seriesId.startsWith("EMA_")) {
        add(
          isWeekly(value.seriesId)
            ? "WEEKLY_MOVING_AVERAGE"
            : "DAILY_MOVING_AVERAGE",
        );
      }
    }
  }

  if (definition.buyLevels.length > 1) {
    add("MULTIPLE_BUY_LEVELS");
  }
  for (const level of definition.buyLevels) {
    add(`BUY_${level.percentage}` as QaMatrixStrategyBehaviour);
  }
  for (const level of definition.sellLevels) {
    add(`SELL_${level.percentage}` as QaMatrixStrategyBehaviour);
  }
  if (definition.sellLevels.length === 0) {
    add("NO_SELL_LEVELS");
  }
  if (definition.finalExit) {
    add("FINAL_EXIT");
  }
  return tags;
}
