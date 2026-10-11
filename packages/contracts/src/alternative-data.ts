import type { ContentOwnershipResponse } from "./builtins.js";
import { sha256Hex } from "./digest.js";

/**
 * The alternative-data product vocabulary: Insider Activity and Congressional Trading.
 *
 * `docs/alternative-data-signals.md` is the product decision this file implements.
 *
 * It lives in `@intrinsic/contracts` for the same reason the selectable-series catalog does: this is
 * the only package the web app may depend on, and the Strategy Builder and the backend validator
 * must share one definition of what a metric is, what may configure it, and what it reads
 * (`AGENTS.md` invariant 11). `@intrinsic/domain` owns the *normalization* of provider facts into
 * these enums; `apps/api/src/alternative-data/alternative-data-vocabulary.test.ts` is the drift
 * guard between the two.
 *
 * ## Why these are metrics and not a new subsystem
 *
 * Every entry here resolves to one number per eligible trading session, exactly like `RSI 14D` or
 * `RVOL 20`, so it is an ordinary Strategy Metric in the existing
 * `[metric] [condition] [value]` grammar. What is new is that they carry **configuration** — a
 * lookback, an actor scope, a role or owner filter — which belongs to the metric itself and never
 * becomes a fourth column in the condition row. The measure is the metric's identity; the
 * configuration is not part of its label (`strategyMetricLabel`) and is rendered beside it by
 * {@link describeAlternativeDataConfiguration}.
 *
 * ## Why the lookback window is measured on the observable session
 *
 * A disclosure has two dates: when the trade happened and when the filing became public. A
 * backtest may only ever see the second. `Congress purchases` over a 30-session lookback therefore
 * counts the purchases **disclosed** in the last thirty sessions, not the purchases *made* in them — a congressional
 * disclosure routinely lags its transaction by up to forty-five days, so windowing on the
 * transaction date would produce a metric that is almost always zero while still looking correct.
 * The transaction date is preserved on every row and is what the product reports; it is simply not
 * what the window is measured on. The same rule gives one definition for a historical backtest and
 * a live Monitor, which is what `docs/alternative-data-signals.md` requires.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary — mirrored in `@intrinsic/domain`, drift-guarded by a test
// ---------------------------------------------------------------------------

export const CONGRESS_CHAMBERS = ["HOUSE", "SENATE"] as const;
export type CongressChamber = (typeof CONGRESS_CHAMBERS)[number];

export const INSIDER_ROLES = [
  "CEO",
  "CFO",
  "COO",
  "PRESIDENT",
  "CHAIRMAN",
  "DIRECTOR",
  "OFFICER",
  "TEN_PERCENT_OWNER",
  "OTHER",
] as const;

export type InsiderRole = (typeof INSIDER_ROLES)[number];

/**
 * The insider roles the Builder offers as a filter.
 *
 * `OTHER` is deliberately absent: it is the bucket for a `typeOfOwner` string that states nothing
 * recognizable, so offering it as a filter would ask a user to select "we could not tell". It is
 * still a persisted value and still readable; it is simply never a filter choice.
 */
export const SELECTABLE_INSIDER_ROLES = INSIDER_ROLES.filter(
  (role) => role !== "OTHER",
) as readonly Exclude<InsiderRole, "OTHER">[];

export const INSIDER_ROLE_LABELS = {
  CEO: "CEO",
  CFO: "CFO",
  COO: "COO",
  PRESIDENT: "President",
  CHAIRMAN: "Chairman",
  DIRECTOR: "Director",
  OFFICER: "Officer",
  TEN_PERCENT_OWNER: "10% owner",
  OTHER: "Other",
} as const satisfies Record<InsiderRole, string>;

export const CONGRESS_OWNERS = [
  "SELF",
  "SPOUSE",
  "JOINT",
  "CHILD",
  "DEPENDENT",
  "OTHER",
  "UNSPECIFIED",
] as const;

export type CongressOwner = (typeof CONGRESS_OWNERS)[number];

/**
 * The owners the Builder offers as a filter.
 *
 * `UNSPECIFIED` is excluded for the same reason `OTHER` is excluded from the role filter: a filing
 * that names no owner has not made a statement to filter on. Such a row is preserved and counted
 * under an unfiltered metric, and is simply never selected by an owner filter.
 */
export const SELECTABLE_CONGRESS_OWNERS = [
  "SELF",
  "SPOUSE",
  "JOINT",
  "CHILD",
  "DEPENDENT",
  "OTHER",
] as const satisfies readonly CongressOwner[];

export const CONGRESS_OWNER_LABELS = {
  SELF: "Self",
  SPOUSE: "Spouse",
  JOINT: "Joint",
  CHILD: "Child",
  DEPENDENT: "Dependent",
  OTHER: "Other",
  UNSPECIFIED: "Not stated",
} as const satisfies Record<CongressOwner, string>;

// ---------------------------------------------------------------------------
// Lookback
// ---------------------------------------------------------------------------

/**
 * The lookback windows an alternative-data metric may name, in **trading sessions**.
 *
 * A closed preset list, exactly like `RELATIVE_VOLUME_PERIODS`, and for the same reason: an
 * arbitrary user-entered window would be a parameter nothing validates and a label nothing can
 * render consistently. The values span a fortnight to a year so a quarterly domain (13F) and a
 * two-business-day one (Form 4) both have a natural window.
 */
export const ALTERNATIVE_DATA_LOOKBACKS = [
  5, 10, 20, 30, 60, 90, 120, 180, 250,
] as const;

export type AlternativeDataLookback =
  (typeof ALTERNATIVE_DATA_LOOKBACKS)[number];

/** The one product label for a lookback. No surface keeps a second map. */
export function alternativeDataLookbackLabel(
  lookback: AlternativeDataLookback,
): string {
  return `${lookback}D`;
}

// ---------------------------------------------------------------------------
// Actor scope
// ---------------------------------------------------------------------------

/**
 * Every scope shape a stored document may hold, current shapes first.
 *
 * `ACTOR` and `GROUP` are **legacy**: they are read and executed for as long as a strategy version
 * or a backtest snapshot holds one, and nothing writes a new one (see {@link ActorScope}).
 */
export const ACTOR_SCOPE_KINDS = ["ANY", "ACTORS", "ACTOR", "GROUP"] as const;
export type ActorScopeKind = (typeof ACTOR_SCOPE_KINDS)[number];

/** The scope shapes the Builder offers. The legacy two are never offered, only read. */
export const SELECTABLE_ACTOR_SCOPE_KINDS = [
  "ANY",
  "ACTORS",
] as const satisfies readonly ActorScopeKind[];

/**
 * The most actors one `ACTORS` scope may select.
 *
 * A structural bound on the model, like `STRATEGY_MAX_BUY_LEVELS`, and deliberately **not** an
 * entitlement. It equals {@link ACTOR_GROUP_MAX_MEMBERS}, so every group a legacy rule references can
 * be embedded without losing a member.
 */
export const ACTOR_SCOPE_MAX_ACTORS = 250;

/**
 * Whose activity a metric counts.
 *
 * Scope is a **membership filter over one metric**, never a metric of its own and never an OR
 * between separately evaluated rules: the disclosures of every selected actor are pooled, and the
 * measure aggregates the pool. `Congress purchases is above 1` scoped to two members who each
 * disclosed one purchase is therefore true — the count is two.
 *
 * - `ANY` — every member of Congress.
 * - `ACTORS` — the members the rule itself selects, by this product's own canonical actor ids. The
 *   list is the rule: it is part of the strategy version, so nothing outside the strategy can change
 *   what the rule counts. Canonically it is sorted and de-duplicated, holding between one and
 *   {@link ACTOR_SCOPE_MAX_ACTORS} ids.
 * - `ACTOR` — **legacy**: one member. It means exactly what a one-entry `ACTORS` means, and
 *   normalization rewrites it to that; the two serialize identically, so no stored
 *   `definitionHash` and no Monitor latch moves.
 * - `GROUP` — **legacy**: a reusable Congress group, by id. Groups left the product on 2026-10-11.
 *   A stored version or snapshot naming one still reads and still executes — a backtest from the
 *   membership frozen in its snapshot, a Monitor from the group as it stands — but the write
 *   boundary refuses a new one.
 */
export type ActorScope =
  | { kind: "ANY" }
  | { kind: "ACTORS"; actorIds: readonly string[] }
  | { kind: "ACTOR"; actorId: string }
  | { kind: "GROUP"; groupId: string };

/**
 * A list of actor ids in canonical form: de-duplicated and sorted by code unit.
 *
 * Deterministic on every runtime — no locale is consulted — so one selection written in any order
 * persists, serializes and fingerprints once.
 */
export function canonicalActorIds(actorIds: readonly string[]): string[] {
  return [...new Set(actorIds)].sort();
}

/**
 * The canonical actor ids a scope selects, or `undefined` when it selects by something else — every
 * member (`ANY`) or a group (`GROUP`), whose membership is not in the document.
 *
 * The one place `ACTOR` and `ACTORS` are read as the same thing.
 */
export function actorScopeActorIds(scope: ActorScope): string[] | undefined {
  switch (scope.kind) {
    case "ACTORS":
      return canonicalActorIds(scope.actorIds);
    case "ACTOR":
      return [scope.actorId];
    case "ANY":
    case "GROUP":
      return undefined;
    default:
      return refuseUnknownScope(scope);
  }
}

/**
 * Refuses a scope whose kind this build does not define.
 *
 * Reached only by a document a newer build wrote. It throws rather than falling through to a
 * neighbouring shape, because the alternative is the failure this function exists to prevent: an
 * unknown scope read as a group with no id resolves to nobody, and the rule then reports a
 * confident zero for activity it never looked at.
 */
function refuseUnknownScope(scope: never): never {
  throw new Error(
    `Unsupported actor scope kind '${String((scope as { kind?: unknown }).kind)}'`,
  );
}

export const CONGRESS_CHAMBER_FILTERS = ["ANY", "HOUSE", "SENATE"] as const;
export type CongressChamberFilter =
  (typeof CONGRESS_CHAMBER_FILTERS)[number];

export const CONGRESS_CHAMBER_FILTER_LABELS = {
  ANY: "Any chamber",
  HOUSE: "House",
  SENATE: "Senate",
} as const satisfies Record<CongressChamberFilter, string>;

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

export const INSIDER_MEASURES = [
  "BUYERS",
  "SELLERS",
  "PURCHASE_VALUE",
  "SALE_VALUE",
] as const;

export type InsiderMeasure = (typeof INSIDER_MEASURES)[number];

export const CONGRESS_MEASURES = [
  "PURCHASES",
  "SALES",
  "BUYERS",
  "SELLERS",
  "MINIMUM_PURCHASE_VALUE",
] as const;

export type CongressMeasure = (typeof CONGRESS_MEASURES)[number];

/**
 * How one measure turns the observable facts inside its window into a number.
 *
 * Declared once, here, and consumed by the pure column builder in `@intrinsic/strategy`. Keeping
 * the aggregation beside the measure is what stops an evaluator deciding that
 * `Insider buyers` counts rows rather than distinct people.
 *
 * - `DISTINCT_ACTORS` — how many different people acted at least once.
 * - `EVENT_COUNT` — how many disclosures there were, however many actors made them.
 * - `SUM_AMOUNT` — the total of each fact's own amount; facts with no amount contribute nothing.
 */
export const ALTERNATIVE_DATA_AGGREGATIONS = [
  "DISTINCT_ACTORS",
  "EVENT_COUNT",
  "SUM_AMOUNT",
] as const;

export type AlternativeDataAggregation =
  (typeof ALTERNATIVE_DATA_AGGREGATIONS)[number];

/**
 * Which normalized facts a measure reads.
 *
 * A selector, not a query: `@intrinsic/stock-data` maps it onto indexed columns, and the pure
 * evaluator never re-derives it. Keeping it here is what lets one registry state the whole meaning
 * of a measure — which facts, aggregated how, valued in what unit.
 */
export const ALTERNATIVE_DATA_FACT_FILTERS = [
  "INSIDER_OPEN_MARKET_PURCHASE",
  "INSIDER_OPEN_MARKET_SALE",
  "CONGRESS_PURCHASE",
  "CONGRESS_SALE",
] as const;

export type AlternativeDataFactFilter =
  (typeof ALTERNATIVE_DATA_FACT_FILTERS)[number];

/**
 * The largest threshold a count metric may name.
 *
 * A product bound rather than a data one: no security sees a thousand distinct insiders or a thousand
 * congressional disclosures inside a single lookback window, so this rejects nothing a user could mean
 * while keeping the validator's message readable and the control's range finite. The *reading* itself is never clamped — only the threshold a rule may ask
 * for.
 */
export const ALTERNATIVE_DATA_COUNT_MAX = 1_000;

/** The unit a measure reads in, which decides its permitted `StrategyValue`. */
export const ALTERNATIVE_DATA_UNITS = ["COUNT", "MONEY"] as const;
export type AlternativeDataUnit = (typeof ALTERNATIVE_DATA_UNITS)[number];

export type AlternativeDataMeasureDefinition = {
  /**
   * The measure's product label, which is the metric's whole identity label. The lookback is
   * configuration and is never part of it.
   */
  label: string;
  filter: AlternativeDataFactFilter;
  aggregation: AlternativeDataAggregation;
  unit: AlternativeDataUnit;
  /** The lookback a freshly selected measure starts from. */
  defaultLookback: AlternativeDataLookback;
};

/**
 * Insider measures.
 *
 * Twenty sessions is the default window — roughly a trading month, and far longer than the two
 * business days a Form 4 is due in, so a purchase is essentially always inside the window that
 * follows it.
 */
export const INSIDER_MEASURE_DEFINITIONS = {
  BUYERS: {
    label: "Insider buyers",
    filter: "INSIDER_OPEN_MARKET_PURCHASE",
    aggregation: "DISTINCT_ACTORS",
    unit: "COUNT",
    defaultLookback: 20,
  },
  SELLERS: {
    label: "Insider sellers",
    filter: "INSIDER_OPEN_MARKET_SALE",
    aggregation: "DISTINCT_ACTORS",
    unit: "COUNT",
    defaultLookback: 20,
  },
  PURCHASE_VALUE: {
    label: "Insider purchase value",
    filter: "INSIDER_OPEN_MARKET_PURCHASE",
    aggregation: "SUM_AMOUNT",
    unit: "MONEY",
    defaultLookback: 20,
  },
  SALE_VALUE: {
    label: "Insider sale value",
    filter: "INSIDER_OPEN_MARKET_SALE",
    aggregation: "SUM_AMOUNT",
    unit: "MONEY",
    defaultLookback: 20,
  },
} as const satisfies Record<InsiderMeasure, AlternativeDataMeasureDefinition>;

/**
 * Congressional measures.
 *
 * Thirty sessions is the default: disclosure is due within forty-five *calendar* days of a trade, so
 * a shorter window would mostly report the reporting cadence rather than the activity.
 *
 * `MINIMUM_PURCHASE_VALUE` sums the **lower bound** of each disclosed band and is named for exactly
 * that. A band of `$15,001 - $50,000` contributes `15,001`, never a midpoint: the filing discloses a
 * range, and a single figure presented as fact would be invented precision.
 */
export const CONGRESS_MEASURE_DEFINITIONS = {
  PURCHASES: {
    label: "Congress purchases",
    filter: "CONGRESS_PURCHASE",
    aggregation: "EVENT_COUNT",
    unit: "COUNT",
    defaultLookback: 30,
  },
  SALES: {
    label: "Congress sales",
    filter: "CONGRESS_SALE",
    aggregation: "EVENT_COUNT",
    unit: "COUNT",
    defaultLookback: 30,
  },
  BUYERS: {
    label: "Congress buyers",
    filter: "CONGRESS_PURCHASE",
    aggregation: "DISTINCT_ACTORS",
    unit: "COUNT",
    defaultLookback: 30,
  },
  SELLERS: {
    label: "Congress sellers",
    filter: "CONGRESS_SALE",
    aggregation: "DISTINCT_ACTORS",
    unit: "COUNT",
    defaultLookback: 30,
  },
  MINIMUM_PURCHASE_VALUE: {
    label: "Congress minimum disclosed purchase value",
    filter: "CONGRESS_PURCHASE",
    aggregation: "SUM_AMOUNT",
    unit: "MONEY",
    defaultLookback: 30,
  },
} as const satisfies Record<CongressMeasure, AlternativeDataMeasureDefinition>;

// ---------------------------------------------------------------------------
// The two metric shapes
// ---------------------------------------------------------------------------

/**
 * Insider activity over a lookback, optionally narrowed to a set of roles.
 *
 * `roles` is absent — not an empty list — when every role counts. The distinction matters: an empty
 * list would be a filter that admits nobody, which is never what a user means by leaving it alone.
 *
 * There is deliberately no actor scope. `docs/alternative-data-signals.md` keeps insider person
 * groups out of V1, so there is nothing for a scope to reference.
 */
export type InsiderActivityMetric = {
  kind: "INSIDER_ACTIVITY";
  measure: InsiderMeasure;
  lookback: AlternativeDataLookback;
  roles?: readonly InsiderRole[];
};

export type CongressActivityMetric = {
  kind: "CONGRESS_ACTIVITY";
  measure: CongressMeasure;
  lookback: AlternativeDataLookback;
  scope: ActorScope;
  chamber: CongressChamberFilter;
  /** Absent when every disclosed owner counts. Never an empty list. */
  owners?: readonly CongressOwner[];
};

export type AlternativeDataMetric =
  | InsiderActivityMetric
  | CongressActivityMetric;

export type AlternativeDataMetricKind = AlternativeDataMetric["kind"];

export const ALTERNATIVE_DATA_METRIC_KINDS = [
  "INSIDER_ACTIVITY",
  "CONGRESS_ACTIVITY",
] as const satisfies readonly AlternativeDataMetricKind[];

export function isAlternativeDataMetricKind(
  kind: string,
): kind is AlternativeDataMetricKind {
  return (ALTERNATIVE_DATA_METRIC_KINDS as readonly string[]).includes(kind);
}

/** Every measure of one alternative-data kind, in canonical order. */
export function alternativeDataMeasures(
  kind: AlternativeDataMetricKind,
): readonly string[] {
  switch (kind) {
    case "INSIDER_ACTIVITY":
      return INSIDER_MEASURES;
    case "CONGRESS_ACTIVITY":
      return CONGRESS_MEASURES;
  }
}

/** The registry entry behind one metric instance. */
export function alternativeDataMeasureDefinition(
  metric: AlternativeDataMetric,
): AlternativeDataMeasureDefinition {
  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
      return INSIDER_MEASURE_DEFINITIONS[metric.measure];
    case "CONGRESS_ACTIVITY":
      return CONGRESS_MEASURE_DEFINITIONS[metric.measure];
  }
}

/** The registry entry for one kind and measure name, or `undefined` for an unknown measure. */
export function findAlternativeDataMeasure(
  kind: AlternativeDataMetricKind,
  measure: string,
): AlternativeDataMeasureDefinition | undefined {
  const table: Record<string, AlternativeDataMeasureDefinition> =
    kind === "INSIDER_ACTIVITY"
      ? INSIDER_MEASURE_DEFINITIONS
      : CONGRESS_MEASURE_DEFINITIONS;
  return table[measure];
}

/** Whether a metric kind is scoped by actor at all. Insiders are not — see V1 non-goals. */
export function alternativeDataSupportsScope(
  kind: AlternativeDataMetricKind,
): boolean {
  return kind !== "INSIDER_ACTIVITY";
}

/** A fresh instance of one measure, with every configurable field at its default. */
export function defaultAlternativeDataMetric(
  kind: AlternativeDataMetricKind,
  measure: string,
): AlternativeDataMetric | undefined {
  const definition = findAlternativeDataMeasure(kind, measure);
  if (!definition) {
    return undefined;
  }
  const lookback = definition.defaultLookback;
  switch (kind) {
    case "INSIDER_ACTIVITY":
      return {
        kind,
        measure: measure as InsiderMeasure,
        lookback,
      };
    case "CONGRESS_ACTIVITY":
      return {
        kind,
        measure: measure as CongressMeasure,
        lookback,
        scope: { kind: "ANY" },
        chamber: "ANY",
      };
  }
}

/**
 * The scope a metric carries, or `undefined` for a kind that has none.
 *
 * One accessor so no caller reaches for `scope` on a metric that structurally lacks it.
 */
export function alternativeDataScope(
  metric: AlternativeDataMetric,
): ActorScope | undefined {
  return metric.kind === "INSIDER_ACTIVITY" ? undefined : metric.scope;
}

/**
 * Every **legacy** actor-group id a strategy definition references, deduplicated and sorted.
 *
 * The one place that question is answered. A definition written since 2026-10-11 references none;
 * for one saved before, a backtest submission freezes exactly these groups' membership into its
 * snapshot, and the conversion command embeds exactly these groups' members into the rule.
 */
export function collectActorGroupIds(
  metrics: Iterable<AlternativeDataMetric>,
): string[] {
  const ids = new Set<string>();
  for (const metric of metrics) {
    const scope = alternativeDataScope(metric);
    if (scope?.kind === "GROUP") {
      ids.add(scope.groupId);
    }
  }
  return [...ids].sort();
}

/**
 * Every actor id a strategy definition selects directly, deduplicated and sorted.
 *
 * Covers both the `ACTORS` list and the legacy single `ACTOR`; a group's members are not in the
 * document and are not collected here.
 */
export function collectActorIds(
  metrics: Iterable<AlternativeDataMetric>,
): string[] {
  const ids = new Set<string>();
  for (const metric of metrics) {
    const scope = alternativeDataScope(metric);
    for (const actorId of scope ? (actorScopeActorIds(scope) ?? []) : []) {
      ids.add(actorId);
    }
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * The canonical, deterministic serialization of one configured alternative-data metric.
 *
 * It is the identity a projected frame column is keyed by, so two strategies asking for the same
 * configured metric share one column, and a re-run of one definition requests byte-identical
 * columns. Fields appear in a fixed order and optional filters are sorted into canonical order, so
 * the same configuration written two ways serializes once.
 *
 * `@intrinsic/strategy` prefixes this to build an `OperandKey`; nothing parses it apart. It is
 * deliberately **not** the select control's option value — see `strategyMetricKey`, which ignores
 * configuration so changing a lookback does not deselect the metric.
 */
export function alternativeDataMetricSignature(
  metric: AlternativeDataMetric,
): string {
  return metricSignature(metric, scopeSignature);
}

/**
 * The same serialization for a **fingerprint**: identical for every scope but a selection of two or
 * more actors, which contributes its size and a digest of its ids instead of the ids themselves.
 *
 * A fingerprint is persisted — it becomes `StrategyVersion.definitionHash`, and a Monitor writes its
 * level's fingerprint on every state row, Signal and transition — while a frame column's key lives
 * only in memory. A selection of two hundred and fifty members would otherwise put about nine
 * kilobytes into each of those rows. The digest is over the canonical id list, so it changes exactly
 * when the selection does, which is the whole requirement: a different selection is different logic.
 *
 * It must **not** change what an existing document serializes to, and it does not: `ANY`, a group
 * and a single actor read exactly as {@link alternativeDataMetricSignature} reads them. Nothing
 * parses this string back; the parseable form is the signature.
 */
export function alternativeDataMetricFingerprint(
  metric: AlternativeDataMetric,
): string {
  return metricSignature(metric, (scope) => {
    const actorIds = actorScopeActorIds(scope);
    return actorIds !== undefined && actorIds.length > 1
      ? `${ACTORS_SIGNATURE_PREFIX}${actorIds.length}:${sha256Hex(actorIds.join(ACTOR_ID_SEPARATOR))}`
      : scopeSignature(scope);
  });
}

const ACTOR_SIGNATURE_PREFIX = "actor:";
const ACTORS_SIGNATURE_PREFIX = "actors:";
const GROUP_SIGNATURE_PREFIX = "group:";
/** Joins the ids of a multi-actor scope. `isActorScopeId` keeps it, and `|`, out of every id. */
const ACTOR_ID_SEPARATOR = "+";

/**
 * Whether a string may be an actor id inside an `ACTORS` scope.
 *
 * The signature joins fields with `|` and ids with `+`, so an id carrying either — or whitespace —
 * could not be read back out of a frame column's key. A canonical actor id is a UUID and carries
 * none of them; this only refuses text that could never have been one.
 */
export function isActorScopeId(value: unknown): value is string {
  return typeof value === "string" && /^[^\s|+]+$/.test(value);
}

/**
 * One scope's part of a signature.
 *
 * A selection of exactly one actor serializes as the legacy `actor:<id>` whichever shape holds it,
 * for the same reason a single-rule FINAL EXIT fingerprints as schema version 1 did: the two mean
 * the same thing, so a strategy saved before the multi-select existed keeps its `definitionHash`,
 * its frame column and every Monitor latch keyed to it.
 */
function scopeSignature(scope: ActorScope): string {
  if (scope.kind === "ANY") {
    return "any";
  }
  if (scope.kind === "GROUP") {
    return `${GROUP_SIGNATURE_PREFIX}${scope.groupId}`;
  }
  const actorIds = actorScopeActorIds(scope);
  if (actorIds === undefined || actorIds.length === 0) {
    // An `ACTORS` scope selecting nobody is not a rule the validator admits, and serializing it
    // would give it a column — one that reads zero forever. Refused, like an unknown kind.
    throw new Error("An actor scope must select at least one actor");
  }
  return actorIds.length === 1
    ? `${ACTOR_SIGNATURE_PREFIX}${actorIds[0]}`
    : `${ACTORS_SIGNATURE_PREFIX}${actorIds.join(ACTOR_ID_SEPARATOR)}`;
}

function metricSignature(
  metric: AlternativeDataMetric,
  serializeScope: (scope: ActorScope) => string,
): string {
  const parts: string[] = [metric.kind, metric.measure, String(metric.lookback)];
  const scope = alternativeDataScope(metric);
  parts.push(scope === undefined ? "-" : serializeScope(scope));
  if (metric.kind === "CONGRESS_ACTIVITY") {
    parts.push(metric.chamber);
    parts.push(
      metric.owners === undefined
        ? "-"
        : [...metric.owners]
            .slice()
            .sort((left, right) =>
              CONGRESS_OWNERS.indexOf(left) - CONGRESS_OWNERS.indexOf(right),
            )
            .join("+"),
    );
  }
  if (metric.kind === "INSIDER_ACTIVITY") {
    parts.push(
      metric.roles === undefined
        ? "-"
        : [...metric.roles]
            .slice()
            .sort(
              (left, right) =>
                INSIDER_ROLES.indexOf(left) - INSIDER_ROLES.indexOf(right),
            )
            .join("+"),
    );
  }
  return parts.join("|");
}

/**
 * Reads a signature produced by {@link alternativeDataMetricSignature} back into a metric, or
 * `undefined` when the text is not one.
 *
 * The inverse belongs beside the serializer for the same reason `operandSeriesId` belongs beside
 * `seriesOperand`: the encoding is this module's, and a consumer that needs the configuration behind
 * a projected frame column must ask rather than slice the string apart. Every field is re-validated
 * against the closed vocabularies on the way back, so a drifted or hand-written key is refused
 * rather than producing a metric this product does not define.
 */
export function parseAlternativeDataMetricSignature(
  signature: string,
): AlternativeDataMetric | undefined {
  const parts = signature.split("|");
  const [rawKind, measure, rawLookback] = parts;
  if (
    rawKind === undefined ||
    measure === undefined ||
    rawLookback === undefined ||
    !isAlternativeDataMetricKind(rawKind) ||
    !findAlternativeDataMeasure(rawKind, measure)
  ) {
    return undefined;
  }
  const lookback = Number(rawLookback);
  if (!(ALTERNATIVE_DATA_LOOKBACKS as readonly number[]).includes(lookback)) {
    return undefined;
  }

  const filterList = <T extends string>(
    raw: string | undefined,
    allowed: readonly T[],
  ): readonly T[] | undefined | "INVALID" => {
    if (raw === undefined || raw === "-") {
      return undefined;
    }
    const values = raw.split("+");
    return values.every((value) => (allowed as readonly string[]).includes(value))
      ? (values as T[])
      : "INVALID";
  };

  if (rawKind === "INSIDER_ACTIVITY") {
    if (parts.length !== 5 || parts[3] !== "-") {
      return undefined;
    }
    const roles = filterList(parts[4], INSIDER_ROLES);
    if (roles === "INVALID") {
      return undefined;
    }
    return {
      kind: rawKind,
      measure: measure as InsiderMeasure,
      lookback: lookback as AlternativeDataLookback,
      ...(roles === undefined ? {} : { roles }),
    };
  }

  const rawScope = parts[3];
  if (rawScope === undefined) {
    return undefined;
  }
  let scope: ActorScope;
  if (rawScope === "any") {
    scope = { kind: "ANY" };
  } else if (rawScope.startsWith(ACTOR_SIGNATURE_PREFIX)) {
    // A single actor reads back in the canonical shape, whichever shape wrote it.
    const actorId = rawScope.slice(ACTOR_SIGNATURE_PREFIX.length);
    if (actorId.length === 0) {
      return undefined;
    }
    scope = { kind: "ACTORS", actorIds: [actorId] };
  } else if (rawScope.startsWith(ACTORS_SIGNATURE_PREFIX)) {
    const actorIds = rawScope
      .slice(ACTORS_SIGNATURE_PREFIX.length)
      .split(ACTOR_ID_SEPARATOR);
    // Exactly the canonical multi-actor form and nothing else: two or more ids, within the bound,
    // already sorted and distinct. A key that is not what the serializer would have written is
    // refused rather than repaired, so a drifted key can never address a column.
    if (
      actorIds.length < 2 ||
      actorIds.length > ACTOR_SCOPE_MAX_ACTORS ||
      !actorIds.every(isActorScopeId) ||
      canonicalActorIds(actorIds).join(ACTOR_ID_SEPARATOR) !==
        actorIds.join(ACTOR_ID_SEPARATOR)
    ) {
      return undefined;
    }
    scope = { kind: "ACTORS", actorIds };
  } else if (rawScope.startsWith(GROUP_SIGNATURE_PREFIX)) {
    const groupId = rawScope.slice(GROUP_SIGNATURE_PREFIX.length);
    if (groupId.length === 0) {
      return undefined;
    }
    scope = { kind: "GROUP", groupId };
  } else {
    return undefined;
  }

  if (parts.length !== 6) {
    return undefined;
  }
  const chamber = parts[4];
  if (
    chamber === undefined ||
    !(CONGRESS_CHAMBER_FILTERS as readonly string[]).includes(chamber)
  ) {
    return undefined;
  }
  const owners = filterList(parts[5], CONGRESS_OWNERS);
  if (owners === "INVALID") {
    return undefined;
  }
  return {
    kind: rawKind,
    measure: measure as CongressMeasure,
    lookback: lookback as AlternativeDataLookback,
    scope,
    chamber: chamber as CongressChamberFilter,
    ...(owners === undefined ? {} : { owners }),
  };
}

/**
 * Canonicalizes one alternative-data metric: the same fields, every optional filter in canonical
 * order, and nothing else.
 *
 * Deterministic and idempotent, and it is what `normalizeStrategyDefinition` stores — so two
 * strategies expressing one rule persist identically and fingerprint identically.
 */
export function buildAlternativeDataMetric(
  metric: AlternativeDataMetric,
): AlternativeDataMetric {
  const scope = (input: ActorScope): ActorScope => {
    if (input.kind === "ANY") {
      return { kind: "ANY" };
    }
    if (input.kind === "GROUP") {
      // Legacy, and kept exactly as stored: its membership is not in the document, so there is
      // nothing here it could be rewritten to.
      return { kind: "GROUP", groupId: input.groupId };
    }
    // A legacy single `ACTOR` becomes the one-entry selection it always meant. The signature — and
    // therefore the fingerprint — is the same for both, so this moves no stored hash.
    return { kind: "ACTORS", actorIds: actorScopeActorIds(input) ?? [] };
  };

  switch (metric.kind) {
    case "INSIDER_ACTIVITY":
      return {
        kind: "INSIDER_ACTIVITY",
        measure: metric.measure,
        lookback: metric.lookback,
        ...(metric.roles === undefined
          ? {}
          : {
              roles: INSIDER_ROLES.filter((role) =>
                metric.roles?.includes(role),
              ),
            }),
      };
    case "CONGRESS_ACTIVITY":
      return {
        kind: "CONGRESS_ACTIVITY",
        measure: metric.measure,
        lookback: metric.lookback,
        scope: scope(metric.scope),
        chamber: metric.chamber,
        ...(metric.owners === undefined
          ? {}
          : {
              owners: CONGRESS_OWNERS.filter((owner) =>
                metric.owners?.includes(owner),
              ),
            }),
      };
  }
}

// ---------------------------------------------------------------------------
// Configuration summary
// ---------------------------------------------------------------------------

/**
 * How a scope reads in the row's secondary line, given the names a surface has resolved.
 *
 * Names are a parameter rather than something this function looks up, because the identifier is the
 * identity and the label is presentation: the same stored metric renders the members' current names
 * in the Builder and the names a completed backtest froze, from one function.
 */
export type ActorScopeNames = {
  /** Display names by actor id, for whichever of the scope's actors a surface has resolved. */
  actorNames?: Readonly<Record<string, string>>;
  groupName?: string;
};

/**
 * How many selected actors a summary names before it counts the rest.
 *
 * Two, because the line it sits on already carries a lookback and often a chamber and an owner list,
 * and the Strategy Logic sidebar prints it for every rule. The dialog is where the whole selection is
 * read; the summary only has to say whose activity this is.
 */
const ACTOR_SCOPE_NAMED_LIMIT = 2;

export function describeActorScope(
  scope: ActorScope,
  names: ActorScopeNames = {},
): string | null {
  switch (scope.kind) {
    case "ANY":
      return null;
    case "ACTORS":
    case "ACTOR":
      return describeSelectedActors(
        actorScopeActorIds(scope) ?? [],
        names.actorNames,
      );
    case "GROUP":
      return names.groupName ?? "Selected group";
    default:
      return refuseUnknownScope(scope);
  }
}

/**
 * A selection in words: `Nancy Pelosi`, `Nancy Pelosi, Tommy Tuberville`,
 * `Nancy Pelosi, Tommy Tuberville +3` — the first names alphabetically, then how many more.
 *
 * Names are sorted here rather than taken in id order, because an id is opaque and its order means
 * nothing to a reader; sorted by code unit so the same selection reads the same on every runtime.
 * A name that has not been resolved is counted, never invented: with none resolved the summary is
 * `5 selected members`, which stays true while names are in flight and when one has gone.
 */
function describeSelectedActors(
  actorIds: readonly string[],
  actorNames: Readonly<Record<string, string>> | undefined,
): string {
  const resolved = actorIds
    .map((actorId) => actorNames?.[actorId])
    .filter((name): name is string => name !== undefined && name.length > 0)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (resolved.length === 0) {
    return `${actorIds.length} selected ${actorIds.length === 1 ? "member" : "members"}`;
  }
  const named = resolved.slice(0, ACTOR_SCOPE_NAMED_LIMIT);
  const remaining = actorIds.length - named.length;
  return remaining > 0
    ? `${named.join(", ")} +${remaining}`
    : named.join(", ");
}

/**
 * One configured metric's configuration in words: the lookback first, then whatever the user
 * narrowed, joined by ` · `.
 *
 * The lookback always appears, because it is configuration rather than part of the metric's label —
 * `Insider sellers` reads `20D` or `180D` here and nowhere else. A scope, chamber, owner or role
 * filter appears only when one narrows the metric; "anyone" and "any chamber" add nothing.
 *
 * Examples: `20D`, `180D · CEO, CFO`, `30D · Nancy Pelosi, Ro Khanna +3 · Senate · Self, Spouse`.
 */
export function describeAlternativeDataConfiguration(
  metric: AlternativeDataMetric,
  names: ActorScopeNames = {},
): string {
  const parts: string[] = [alternativeDataLookbackLabel(metric.lookback)];
  const scope = alternativeDataScope(metric);
  if (scope) {
    const described = describeActorScope(scope, names);
    if (described) {
      parts.push(described);
    }
  }
  // Filters are listed in canonical order, never in the order a document happens to hold them: one
  // configuration reads one way before normalization, after it, and on every surface.
  if (metric.kind === "CONGRESS_ACTIVITY") {
    if (metric.chamber !== "ANY") {
      parts.push(CONGRESS_CHAMBER_FILTER_LABELS[metric.chamber]);
    }
    if (metric.owners && metric.owners.length > 0) {
      parts.push(
        CONGRESS_OWNERS.filter((owner) => metric.owners?.includes(owner))
          .map((owner) => CONGRESS_OWNER_LABELS[owner])
          .join(", "),
      );
    }
  }
  if (metric.kind === "INSIDER_ACTIVITY") {
    if (metric.roles && metric.roles.length > 0) {
      parts.push(
        INSIDER_ROLES.filter((role) => metric.roles?.includes(role))
          .map((role) => INSIDER_ROLE_LABELS[role])
          .join(", "),
      );
    }
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Actor and actor-group API contracts
// ---------------------------------------------------------------------------

/**
 * One row of the searchable actor picker: a member of Congress.
 *
 * There is no actor-kind discriminator. V1 has exactly one kind of canonical actor — insider persons
 * are deliberately not actors — and a field with one possible value is a distinction the product does
 * not make.
 */
export type AlternativeDataActorResponse = {
  id: string;
  /** The identifier this actor's identity **is**: the member's bioguide id. */
  externalId: string;
  displayName: string;
  chamber: CongressChamber;
  state?: string;
  district?: string;
};

/**
 * Whether the picker's catalog has been filled from the provider's member directory.
 *
 * - `SYNCHRONIZED` — a synchronization has read the whole directory and written it. The catalog
 *   holds every member the directory listed then, whether or not a disclosure of theirs has ever
 *   been loaded. It stays this state when a later run fails: the catalog still holds what the last
 *   complete run wrote.
 * - `NOT_SYNCHRONIZED` — no synchronization has run. The catalog holds only members some loaded
 *   disclosure named, so a member can be missing for no reason but that.
 * - `SYNCHRONIZATION_FAILED` — a synchronization was attempted and none has ever completed. The
 *   catalog is as incomplete as in `NOT_SYNCHRONIZED`, and an operator has something to look at.
 *
 * It exists so an empty search can be read correctly: "nobody matches" under `SYNCHRONIZED`, "the
 * member may simply not be here yet" under the other two.
 */
export const ACTOR_CATALOG_STATES = [
  "SYNCHRONIZED",
  "NOT_SYNCHRONIZED",
  "SYNCHRONIZATION_FAILED",
] as const;

export type ActorCatalogState = (typeof ACTOR_CATALOG_STATES)[number];

export type ActorCatalogStatusResponse = {
  state: ActorCatalogState;
  /** When the directory was last read whole and written. Present exactly when `SYNCHRONIZED`. */
  synchronizedAt?: string;
};

/**
 * Outcome of one administrator-triggered synchronization of the member catalog.
 *
 * Every identity the directory held is counted once: `received` is
 * `created + updated + unchanged + declined`. `relabelled` is a subset of `updated`, and
 * `retained` counts catalog members the directory did not hold — every one of them is kept.
 */
export type CongressMemberCatalogSyncResponse = {
  runSequence: number;
  /** HTTP requests asked of the provider's directory. */
  providerRequests: number;
  received: number;
  inOffice: number;
  former: number;
  created: number;
  updated: number;
  relabelled: number;
  unchanged: number;
  declined: number;
  /** Declined rows by reason, e.g. `NO_CHAMBER`. A reason nothing was declined for reads 0. */
  declinedByReason: Record<string, number>;
  repeatedRows: number;
  retained: number;
  durationMs: number;
};

export const ACTOR_SEARCH_MIN_TERM_LENGTH = 2;
export const ACTOR_SEARCH_DEFAULT_LIMIT = 20;
export const ACTOR_SEARCH_MAX_LIMIT = 50;
/**
 * Actor ids one `GET /alternative-data/actors/resolve` request may name.
 *
 * The ids travel in the query string, and a selection can hold {@link ACTOR_SCOPE_MAX_ACTORS} of
 * them — about nine kilobytes of URL, more than a proxy in front of the API need accept. A client
 * resolving a larger set asks in batches of this size; the bound keeps one request around two
 * kilobytes.
 */
export const ACTOR_RESOLVE_MAX_IDS = 50;

// ---------------------------------------------------------------------------
// Congress groups — legacy
//
// Groups left the product on 2026-10-11: a rule selects its members itself (`ActorScope` `ACTORS`),
// no surface manages a group and a strategy write naming one is refused. The contracts below stay
// because the routes do, and the routes stay because strategy versions saved before then still name
// groups: the Builder reads a legacy group's name and members through them to offer the rule's
// conversion. `docs/development/congress-group-scope-conversion.md` says when they can go.
// ---------------------------------------------------------------------------

export const ACTOR_GROUP_NAME_MAX_LENGTH = 120;
export const ACTOR_GROUP_DESCRIPTION_MAX_LENGTH = 500;
/**
 * Members one group may hold.
 *
 * A structural bound on the model, exactly like `STRATEGY_MAX_BUY_LEVELS`, and deliberately **not**
 * an entitlement: `docs/decisions/entitlements-v1.md` is the only place a plan limit may be defined,
 * and this is not one. It exists so a group stays something a person curated and a frame column
 * stays cheap to project.
 */
export const ACTOR_GROUP_MAX_MEMBERS = 250;
export const ACTOR_GROUP_MAX_MEMBERS_PER_ADD = 100;

export type ActorGroupSummaryResponse = ContentOwnershipResponse & {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ActorGroupDetailResponse = ActorGroupSummaryResponse & {
  members: AlternativeDataActorResponse[];
};

export type CreateActorGroupRequest = {
  name: string;
  description?: string;
  actorIds?: string[];
};

/** At least one field must be present. `description: null` clears the description. */
export type UpdateActorGroupRequest = {
  name?: string;
  description?: string | null;
};

export type AddActorGroupMembersRequest = {
  actorIds: string[];
};
