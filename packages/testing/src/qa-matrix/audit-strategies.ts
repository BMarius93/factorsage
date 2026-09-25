import {
  STRATEGY_SCHEMA_VERSION,
  type BuyLevelPercentage,
  type ConditionOperator,
  type SelectableSeriesId,
  type SellLevelPercentage,
  type StrategyDefinition,
  type StrategyMetric,
  type StrategySignal,
  type StrategyValue,
} from "@intrinsic/contracts";
import {
  QA_MATRIX_NAME_PREFIX,
  type QaMatrixStrategyFixture,
} from "./strategies.js";

/**
 * The ten **audit-variant** QA-MATRIX Strategy fixtures: `A01` … `A10`.
 *
 * A second strategy dimension rather than a rewrite of the first. `S01` … `S10` are the historical
 * Backtest V1 baseline — a thousand recorded runs' worth of meaning — and editing them to make room
 * for new metric families would silently move that baseline, so this set sits beside them and is
 * selected explicitly (`--strategies audit`). Both sets run against the same ten Lists and the same
 * ten configurations, so either sweep is 1,000 runs and the two are directly comparable.
 *
 * What the ten cover, between them:
 *
 * - **Relative Volume** at all three periods, alone and combined — `RVOL 10 AND RVOL 20`,
 *   `RVOL 10 AND RVOL 50`, all three at once, the same threshold across two periods and different
 *   thresholds across two periods. That combination is the point: until the period became part of a
 *   metric's semantic identity, two RVOL rows in one Signal were refused as a duplicate condition and
 *   two RVOL levels fingerprinted alike. A definition that could not previously be authored is
 *   exactly what a regression sweep should be made of.
 * - **Insider activity**: buyer and seller counts at two thresholds, purchase and sale value, and a
 *   role-filtered buyer count.
 * - **Congressional trading**: purchase and sale counts, buyer counts, the minimum-disclosed-value
 *   measure, a House-only and a Senate-only scope, an owner filter, one named member, and one actor
 *   group — whose membership a submitted run freezes into its own snapshot.
 * - **Mixtures** with Price, SMA, RSI and Margin of Safety, including one strategy whose Signal
 *   deliberately reaches for a 250-session alternative-data window that is NOT_EVALUABLE across most
 *   of the horizon, so a run proves the engine withholds rather than reads zero.
 *
 * Every Metric / operator / Value combination below is one `ai/product/strategies.md` already
 * permits; `validateStrategy` is what proves it, not this comment.
 */

// ---------------------------------------------------------------------------
// Actor scopes
// ---------------------------------------------------------------------------

/**
 * The canonical identifiers an audit strategy's actor scope resolves to.
 *
 * A scope names this product's own ids, which are generated when a row is created, so the fixtures
 * cannot hold them as literals. What they *can* hold is the stable external identity behind each —
 * a bioguide id, and a reserved group name — which the seeder resolves against the database it is
 * seeding and passes back in. That keeps the fixture deterministic for one database while never
 * writing an id into the repository.
 */
export type QaMatrixActorScopes = {
  /** Canonical actor id of {@link QA_MATRIX_AUDIT_ACTOR}. */
  readonly actorId: string;
  /** Id of the reserved actor group named {@link QA_MATRIX_ACTOR_GROUP_NAME}. */
  readonly groupId: string;
};

/**
 * The member one audit strategy scopes to, by bioguide id.
 *
 * Chosen because the identity is stable and the coverage is real: in the matrix universe this member
 * has disclosed stock transactions in 32 of the 33 securities, over five years, in both directions —
 * so a specific-actor scope actually produces trades rather than an empty column that would pass for
 * the wrong reason.
 */
export const QA_MATRIX_AUDIT_ACTOR = {
  externalId: "K000389",
  displayName: "Ro Khanna",
} as const;

/** The reserved name of the actor group the audit fixtures reference. */
export const QA_MATRIX_ACTOR_GROUP_NAME = `${QA_MATRIX_NAME_PREFIX}congress-watchlist`;

/**
 * The group's membership, by bioguide id, in the order the seeder adds them.
 *
 * Both chambers on purpose: a group scope must be able to span a chamber boundary, and a
 * chamber-filtered metric scoped to a mixed group is the one place the two filters compose.
 */
export const QA_MATRIX_ACTOR_GROUP_MEMBERS: readonly string[] = [
  "K000389", // Ro Khanna, House
  "G000583", // Josh Gottheimer, House
  "W000802", // Sheldon Whitehouse, Senate
  "C001047", // Shelley M Capito, Senate
  "C001123", // Gilbert Cisneros, House
];

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

const price: StrategyMetric = { kind: "PRICE" };
const gain: StrategyMetric = { kind: "GAIN" };
const loss: StrategyMetric = { kind: "LOSS" };
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

type Lookback = 5 | 10 | 20 | 30 | 60 | 90 | 120 | 180 | 250;

const insider = (
  measure: "BUYERS" | "SELLERS" | "PURCHASE_VALUE" | "SALE_VALUE",
  lookback: Lookback,
  roles?: readonly ("CEO" | "CFO" | "DIRECTOR" | "OFFICER")[],
): StrategyMetric => ({
  kind: "INSIDER_ACTIVITY",
  measure,
  lookback,
  ...(roles ? { roles } : {}),
});

const congress = (
  measure:
    | "PURCHASES"
    | "SALES"
    | "BUYERS"
    | "SELLERS"
    | "MINIMUM_PURCHASE_VALUE",
  lookback: Lookback,
  options: {
    scope?: { kind: "ANY" } | { kind: "ACTOR"; actorId: string } | { kind: "GROUP"; groupId: string };
    chamber?: "ANY" | "HOUSE" | "SENATE";
    owners?: readonly ("SELF" | "SPOUSE" | "JOINT")[];
  } = {},
): StrategyMetric => ({
  kind: "CONGRESS_ACTIVITY",
  measure,
  lookback,
  scope: options.scope ?? { kind: "ANY" },
  chamber: options.chamber ?? "ANY",
  ...(options.owners ? { owners: options.owners } : {}),
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
const money = (value: number): StrategyValue => ({ kind: "MONEY", value });

type ConditionSpec = {
  readonly metric: StrategyMetric;
  readonly operator: ConditionOperator;
  readonly value: StrategyValue;
};

const when = (
  metric: StrategyMetric,
  operator: ConditionOperator,
  value: StrategyValue,
): ConditionSpec => ({ metric, operator, value });

type SignalSpec = { readonly conditions: readonly ConditionSpec[] };
type LevelSpec<Percentage> = SignalSpec & { readonly percentage: Percentage };

type DefinitionSpec = {
  readonly buyLevels: readonly LevelSpec<BuyLevelPercentage>[];
  readonly sellLevels?: readonly LevelSpec<SellLevelPercentage>[];
  readonly finalExit?: SignalSpec;
};

/** Positional row ids, exactly as the core fixtures build them, so a re-seed is idempotent. */
function buildSignal(prefix: string, spec: SignalSpec): StrategySignal {
  return {
    conditions: spec.conditions.map((condition, index) => ({
      id: `${prefix}-c${index + 1}`,
      metric: condition.metric,
      operator: condition.operator,
      value: condition.value,
    })),
  };
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
    definition.finalExit = {
      id,
      rules: [{ id, signal: buildSignal(id, spec.finalExit) }],
    };
  }
  return definition;
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

type AuditStrategySpec = {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly definition: DefinitionSpec;
};

function auditStrategySpecs(
  scopes: QaMatrixActorScopes,
): readonly AuditStrategySpec[] {
  return [
    {
      id: "A01",
      slug: "rvol10-spike",
      description:
        "BUY 100% on a single `RVOL 10 is above 2` Condition, no SELL and no FINAL EXIT. The " +
        "simplest Relative Volume strategy and the control case for the shortest period: its " +
        "baseline warms up after ten sessions, so it is the one RVOL fixture that has a value " +
        "almost everywhere and can be read against the stored column directly.",
      definition: {
        buyLevels: [
          { percentage: 100, conditions: [when(rvol(10), "IS_ABOVE", multiple(2))] },
        ],
      },
    },
    {
      id: "A02",
      slug: "rvol-multi-period-ladder",
      description:
        "BUY 50% on `RVOL 20 is above 2`; BUY 100% on `RVOL 10 is above 2 AND RVOL 20 is above 2 " +
        "AND RVOL 50 is above 1.5`; SELL 50% on Gain; FINAL EXIT on Loss. The definition the " +
        "period-identity defect made unauthorable: two levels whose Signals differ only by RVOL " +
        "period, and one Signal holding all three periods at once — including two rows at the " +
        "*same* threshold, which is what a duplicate-condition check keyed on the metric alone " +
        "would reject.",
      definition: {
        buyLevels: [
          { percentage: 50, conditions: [when(rvol(20), "IS_ABOVE", multiple(2))] },
          {
            percentage: 100,
            conditions: [
              when(rvol(10), "IS_ABOVE", multiple(2)),
              when(rvol(20), "IS_ABOVE", multiple(2)),
              when(rvol(50), "IS_ABOVE", multiple(1.5)),
            ],
          },
        ],
        sellLevels: [
          { percentage: 50, conditions: [when(gain, "IS_ABOVE", percent(25))] },
        ],
        finalExit: { conditions: [when(loss, "IS_ABOVE", percent(20))] },
      },
    },
    {
      id: "A03",
      slug: "rvol50-trend-confirmation",
      description:
        "BUY 100% on `RVOL 50 is above 3 AND Price is above SMA 200D`; FINAL EXIT on `Price is " +
        "below SMA 200D`. The longest RVOL period against the longest daily average: the warm-up " +
        "boundary that binds here is RVOL 50's, fifty sessions, and it is the fixture that proves " +
        "a long lookback is not silently shortened at a calendar-year execution boundary.",
      definition: {
        buyLevels: [
          {
            percentage: 100,
            conditions: [
              when(rvol(50), "IS_ABOVE", multiple(3)),
              when(price, "IS_ABOVE", series("SMA_200D")),
            ],
          },
        ],
        finalExit: {
          conditions: [when(price, "IS_BELOW", series("SMA_200D"))],
        },
      },
    },
    {
      id: "A04",
      slug: "rvol-rsi-capitulation",
      description:
        "BUY 25 / 50 / 100% on `RSI 14D is below 40 / 30 / 20` each ANDed with a rising Relative " +
        "Volume floor (`RVOL 10 above 1.2 / 1.5 / 2`); SELL 50% on Gain; FINAL EXIT on an RSI 14D " +
        "recovery. Different thresholds of one RVOL period across three levels, mixed with an " +
        "oscillator — and the strongest-eligible-BUY rule, because a deeply oversold heavy-volume " +
        "session satisfies all three at once.",
      definition: {
        buyLevels: [
          {
            percentage: 25,
            conditions: [
              when(rsi("RSI_14D"), "IS_BELOW", number(40)),
              when(rvol(10), "IS_ABOVE", multiple(1.2)),
            ],
          },
          {
            percentage: 50,
            conditions: [
              when(rsi("RSI_14D"), "IS_BELOW", number(30)),
              when(rvol(10), "IS_ABOVE", multiple(1.5)),
            ],
          },
          {
            percentage: 100,
            conditions: [
              when(rsi("RSI_14D"), "IS_BELOW", number(20)),
              when(rvol(10), "IS_ABOVE", multiple(2)),
            ],
          },
        ],
        sellLevels: [
          { percentage: 50, conditions: [when(gain, "IS_ABOVE", percent(20))] },
        ],
        finalExit: {
          conditions: [when(rsi("RSI_14D"), "IS_ABOVE", number(70))],
        },
      },
    },
    {
      id: "A05",
      slug: "insider-buyer-ladder",
      description:
        "BUY 50% on `Insider buyers 20D is at least 1`; BUY 100% on `Insider buyers 20D is at " +
        "least 2`; SELL 50% on Gain; FINAL EXIT on `Insider sellers 20D is at least 3`. The " +
        "inclusive operators the alternative-data metrics introduced, at two thresholds of one " +
        "measure, with the opposite measure driving the exit. Distinct-buyer counting is what this " +
        "fixture is really testing: one insider filing three purchases must move it by one.",
      definition: {
        buyLevels: [
          {
            percentage: 50,
            conditions: [when(insider("BUYERS", 20), "IS_AT_LEAST", number(1))],
          },
          {
            percentage: 100,
            conditions: [when(insider("BUYERS", 20), "IS_AT_LEAST", number(2))],
          },
        ],
        sellLevels: [
          { percentage: 50, conditions: [when(gain, "IS_ABOVE", percent(30))] },
        ],
        finalExit: {
          conditions: [when(insider("SELLERS", 20), "IS_AT_LEAST", number(3))],
        },
      },
    },
    {
      id: "A06",
      slug: "insider-value-and-roles",
      description:
        "BUY 100% on `Insider purchase value 60D is at least $1,000,000 AND role-filtered insider " +
        "buyers 20D (CEO, CFO, Director) is at least 1 AND Price is above SMA 50D`; SELL 25% on " +
        "Gain; FINAL EXIT on `Insider sale value 20D is at least $5,000,000`. The money-valued " +
        "measures and the role filter, mixed with a price condition. A line the Form 4 prices at " +
        "zero must contribute nothing here, so an award-heavy security must not reach the " +
        "million-dollar threshold on awards.",
      definition: {
        buyLevels: [
          {
            percentage: 100,
            conditions: [
              when(insider("PURCHASE_VALUE", 60), "IS_AT_LEAST", money(1_000_000)),
              when(
                insider("BUYERS", 20, ["CEO", "CFO", "DIRECTOR"]),
                "IS_AT_LEAST",
                number(1),
              ),
              when(price, "IS_ABOVE", series("SMA_50D")),
            ],
          },
        ],
        sellLevels: [
          { percentage: 25, conditions: [when(gain, "IS_ABOVE", percent(15))] },
        ],
        finalExit: {
          conditions: [
            when(insider("SALE_VALUE", 20), "IS_AT_LEAST", money(5_000_000)),
          ],
        },
      },
    },
    {
      id: "A07",
      slug: "congress-activity-ladder",
      description:
        "BUY 50% on `Congress purchases 30D is at least 1`; BUY 100% on `Congress purchases 30D is " +
        "at least 2 AND Congress buyers 30D is at least 2`; SELL 50% on Gain; FINAL EXIT on " +
        "`Congress sales 30D is at least 2`. Event counts and distinct-actor counts of the same " +
        "underlying disclosures in one Signal: two purchases by one member satisfy the first and " +
        "not the second, which is the whole difference between the two aggregations.",
      definition: {
        buyLevels: [
          {
            percentage: 50,
            conditions: [
              when(congress("PURCHASES", 30), "IS_AT_LEAST", number(1)),
            ],
          },
          {
            percentage: 100,
            conditions: [
              when(congress("PURCHASES", 30), "IS_AT_LEAST", number(2)),
              when(congress("BUYERS", 30), "IS_AT_LEAST", number(2)),
            ],
          },
        ],
        sellLevels: [
          { percentage: 50, conditions: [when(gain, "IS_ABOVE", percent(25))] },
        ],
        finalExit: {
          conditions: [when(congress("SALES", 30), "IS_AT_LEAST", number(2))],
        },
      },
    },
    {
      id: "A08",
      slug: "congress-scoped-filters",
      description:
        "BUY 25% on a House-only purchase count; BUY 50% on a Senate-only purchase count restricted " +
        "to self-owned holdings; BUY 100% on the named member's own purchases; SELL 50% on Gain; " +
        "FINAL EXIT on Loss. Every scope and filter the domain offers, each on its own level, so a " +
        "leak between two of them shows up as a level firing that should not have. The named member " +
        "is a canonical actor id resolved from a bioguide id, never a display name.",
      definition: {
        buyLevels: [
          {
            percentage: 25,
            conditions: [
              when(
                congress("PURCHASES", 30, { chamber: "HOUSE" }),
                "IS_AT_LEAST",
                number(1),
              ),
            ],
          },
          {
            percentage: 50,
            conditions: [
              when(
                congress("PURCHASES", 30, {
                  chamber: "SENATE",
                  owners: ["SELF"],
                }),
                "IS_AT_LEAST",
                number(1),
              ),
            ],
          },
          {
            percentage: 100,
            conditions: [
              when(
                congress("PURCHASES", 60, {
                  scope: { kind: "ACTOR", actorId: scopes.actorId },
                }),
                "IS_AT_LEAST",
                number(1),
              ),
            ],
          },
        ],
        sellLevels: [
          { percentage: 50, conditions: [when(gain, "IS_ABOVE", percent(20))] },
        ],
        finalExit: { conditions: [when(loss, "IS_ABOVE", percent(25))] },
      },
    },
    {
      id: "A09",
      slug: "congress-group-and-volume",
      description:
        "BUY 100% on `Congress purchases 60D scoped to the QA-MATRIX watchlist group is at least 1 " +
        "AND RVOL 20 is above 1.5`; SELL 25% on Gain; FINAL EXIT on the same group's minimum " +
        "disclosed purchase value 90D. The actor-group scope, which a submitted run freezes into its " +
        "own snapshot: the worker resolves it from there and never from the database, so editing or " +
        "deleting the group afterwards cannot move this run's result.",
      definition: {
        buyLevels: [
          {
            percentage: 100,
            conditions: [
              when(
                congress("PURCHASES", 60, {
                  scope: { kind: "GROUP", groupId: scopes.groupId },
                }),
                "IS_AT_LEAST",
                number(1),
              ),
              when(rvol(20), "IS_ABOVE", multiple(1.5)),
            ],
          },
        ],
        sellLevels: [
          { percentage: 25, conditions: [when(gain, "IS_ABOVE", percent(20))] },
        ],
        finalExit: {
          conditions: [
            when(
              congress("MINIMUM_PURCHASE_VALUE", 90, {
                scope: { kind: "GROUP", groupId: scopes.groupId },
              }),
              "IS_AT_MOST",
              money(0),
            ),
          ],
        },
      },
    },
    {
      id: "A10",
      slug: "valuation-volume-disclosure-confluence",
      description:
        "BUY 75% on `Margin of Safety (DCF) is above 20% AND RVOL 50 is above 1.5 AND Congress " +
        "purchases 250D is at least 1 AND Insider buyers 250D is at least 1`; no SELL; FINAL EXIT " +
        "on Gain. The deliberate NOT_EVALUABLE probe: the 250-session alternative-data windows " +
        "cannot be decided across most of a thirty-year horizon, and a valuation metric cannot be " +
        "decided where fundamentals are absent — so this strategy must trade rarely and must never " +
        "trade because an undecidable operand was read as zero.",
      definition: {
        buyLevels: [
          {
            percentage: 75,
            conditions: [
              when(mos("DCF_FCFF"), "IS_ABOVE", percent(20)),
              when(rvol(50), "IS_ABOVE", multiple(1.5)),
              when(congress("PURCHASES", 250), "IS_AT_LEAST", number(1)),
              when(insider("BUYERS", 250), "IS_AT_LEAST", number(1)),
            ],
          },
        ],
        finalExit: { conditions: [when(gain, "IS_ABOVE", percent(50))] },
      },
    },
  ];
}

/** The ten audit fixtures for one resolved set of actor scopes. */
export function qaMatrixAuditStrategies(
  scopes: QaMatrixActorScopes,
): readonly QaMatrixStrategyFixture[] {
  return auditStrategySpecs(scopes).map((spec) => ({
    id: spec.id,
    name: `${QA_MATRIX_NAME_PREFIX}${spec.id}-${spec.slug}`,
    description: spec.description,
    // Structural behaviour tags describe the core set's own vocabulary and are deliberately not
    // reused here: the audit set's distinguishing properties are its metric families, which
    // `deriveStrategyBehaviours` has no tags for, and inventing ten more tags would be a second
    // description of the definitions above.
    behaviours: [],
    definition: buildDefinition(spec.id, spec.definition),
  }));
}

/** The audit fixture ids, for a runner that needs them before the database is reachable. */
export const QA_MATRIX_AUDIT_STRATEGY_IDS: readonly string[] = [
  "A01",
  "A02",
  "A03",
  "A04",
  "A05",
  "A06",
  "A07",
  "A08",
  "A09",
  "A10",
];
