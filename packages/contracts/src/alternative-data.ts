import type { ContentOwnershipResponse } from "./builtins.js";

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
 * `[metric] [condition] [value]` grammar. What is new is that some of them carry **configuration**
 * — a lookback, an actor scope, a role or owner filter — which belongs to the metric itself and
 * never becomes a fourth column in the condition row.
 *
 * ## Why the lookback window is measured on the observable session
 *
 * A disclosure has two dates: when the trade happened and when the filing became public. A
 * backtest may only ever see the second. `Congress purchases 30D` therefore counts the purchases
 * **disclosed** in the last thirty sessions, not the purchases *made* in them — a congressional
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

export const ACTOR_SCOPE_KINDS = ["ANY", "ACTOR", "GROUP"] as const;
export type ActorScopeKind = (typeof ACTOR_SCOPE_KINDS)[number];

/**
 * Whose activity a metric counts.
 *
 * Scope is a **filter over one metric**, never a metric of its own: there is no named-member signal,
 * only `Congress buyers` scoped to one member or to a group. That is what keeps the catalog small and
 * what lets a group be swapped without rewriting a strategy.
 *
 * `actorId` and `groupId` are this product's own identifiers, resolved at the API boundary the same
 * way a Monitor's stock-list reference is. A backtest freezes a referenced group's membership into
 * its snapshot, so editing the group later cannot change a run that already exists.
 */
export type ActorScope =
  | { kind: "ANY" }
  | { kind: "ACTOR"; actorId: string }
  | { kind: "GROUP"; groupId: string };

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
  /** The product label, without its lookback. `strategyMetricLabel` appends that. */
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
 * Every actor-group id a strategy definition references, deduplicated and sorted.
 *
 * The one place that question is answered: strategy validation resolves these against the caller's
 * groups, and a backtest submission freezes exactly these groups' membership into its snapshot.
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

/** Every specific actor id a strategy definition references, deduplicated and sorted. */
export function collectActorIds(
  metrics: Iterable<AlternativeDataMetric>,
): string[] {
  const ids = new Set<string>();
  for (const metric of metrics) {
    const scope = alternativeDataScope(metric);
    if (scope?.kind === "ACTOR") {
      ids.add(scope.actorId);
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
  const parts: string[] = [metric.kind, metric.measure, String(metric.lookback)];
  const scope = alternativeDataScope(metric);
  parts.push(
    scope === undefined
      ? "-"
      : scope.kind === "ANY"
        ? "any"
        : scope.kind === "ACTOR"
          ? `actor:${scope.actorId}`
          : `group:${scope.groupId}`,
  );
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
  } else if (rawScope.startsWith("actor:")) {
    scope = { kind: "ACTOR", actorId: rawScope.slice("actor:".length) };
  } else if (rawScope.startsWith("group:")) {
    scope = { kind: "GROUP", groupId: rawScope.slice("group:".length) };
  } else {
    return undefined;
  }
  if (
    (scope.kind === "ACTOR" && scope.actorId.length === 0) ||
    (scope.kind === "GROUP" && scope.groupId.length === 0)
  ) {
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
  const scope = (input: ActorScope): ActorScope =>
    input.kind === "ANY"
      ? { kind: "ANY" }
      : input.kind === "ACTOR"
        ? { kind: "ACTOR", actorId: input.actorId }
        : { kind: "GROUP", groupId: input.groupId };

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
 * identity and the label is presentation: the same stored metric renders "Superinvestors" in the
 * Builder and the frozen snapshot name in a completed backtest, from one function.
 */
export type ActorScopeNames = {
  actorName?: string;
  groupName?: string;
};

export function describeActorScope(
  scope: ActorScope,
  names: ActorScopeNames = {},
): string | null {
  switch (scope.kind) {
    case "ANY":
      return null;
    case "ACTOR":
      return names.actorName ?? "Selected actor";
    case "GROUP":
      return names.groupName ?? "Selected group";
  }
}

/**
 * The subtle secondary line under a configured first operand, or `null` when there is nothing to
 * add.
 *
 * Only what the user actually narrowed appears. The lookback is deliberately absent: it is already
 * part of the metric label (`Insider buyers 20D`), and repeating it would make the commonest case —
 * a metric with no filters at all — carry a redundant line.
 *
 * Examples: `Superinvestors`, `Congress Watchlist · Senate · Self, Spouse`, `CEO, CFO, Director`.
 */
export function describeAlternativeDataConfiguration(
  metric: AlternativeDataMetric,
  names: ActorScopeNames = {},
): string | null {
  const parts: string[] = [];
  const scope = alternativeDataScope(metric);
  if (scope) {
    const described = describeActorScope(scope, names);
    if (described) {
      parts.push(described);
    }
  }
  if (metric.kind === "CONGRESS_ACTIVITY") {
    if (metric.chamber !== "ANY") {
      parts.push(CONGRESS_CHAMBER_FILTER_LABELS[metric.chamber]);
    }
    if (metric.owners && metric.owners.length > 0) {
      parts.push(
        metric.owners.map((owner) => CONGRESS_OWNER_LABELS[owner]).join(", "),
      );
    }
  }
  if (metric.kind === "INSIDER_ACTIVITY") {
    if (metric.roles && metric.roles.length > 0) {
      parts.push(
        metric.roles.map((role) => INSIDER_ROLE_LABELS[role]).join(", "),
      );
    }
  }
  return parts.length === 0 ? null : parts.join(" · ");
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

export const ACTOR_SEARCH_MIN_TERM_LENGTH = 2;
export const ACTOR_SEARCH_DEFAULT_LIMIT = 20;
export const ACTOR_SEARCH_MAX_LIMIT = 50;

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

/**
 * The one product label for the actor-group collection, used as the Lists area's section heading.
 *
 * A constant rather than a per-kind map: V1 has one kind of group.
 */
export const ACTOR_GROUP_COLLECTION_LABEL = "Congress groups" as const;
