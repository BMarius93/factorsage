/**
 * Strategy ⇄ canonical JSON.
 *
 * The canonical Strategy logic is the persisted Strategy document's own grammar — the same metric,
 * operator and Value shapes, validated by the same `validateStrategyDefinition` — with the parts that
 * are identity rather than meaning taken out: row ids are dropped, and a Congress scope names
 * members by bioguide id instead of by this database's actor id. Everything that carries meaning —
 * level order, percentages, the Condition order inside a Signal, the optional Trigger, the Exit Rule
 * alternatives, every metric parameter and every Value — is carried over exactly, so
 * `Strategy → JSON → Strategy` reproduces the platform's own `strategyDefinitionFingerprint`.
 */

import {
  ActorGroupScopeUnresolvedError,
  canonicalActorIds,
  embedActorGroupScopes,
  isActorScopeId,
  normalizeStrategyDefinition,
  STRATEGY_DESCRIPTION_MAX_LENGTH,
  STRATEGY_NAME_MAX_LENGTH,
  STRATEGY_SCHEMA_VERSION,
  StrategyValidationError,
  validateStrategyDefinition,
  type ActorScope,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyDraft,
  type StrategyIssuePath,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValidationIssue,
  type StrategyValue,
} from "@intrinsic/contracts";
import {
  CanonicalDefinitionError,
  childPath,
  isRecord,
  IssueCollector,
  rejectUnknownKeys,
  type CanonicalDefinitionIssue,
} from "./issues.js";
import {
  canonicalProvenance,
  validateHeader,
  validateMetadata,
  validateProvenance,
} from "./envelope.js";
import {
  CANONICAL_DEFINITION_FORMAT,
  CANONICAL_DEFINITION_SCHEMA_VERSION,
  type CanonicalActorReference,
  type CanonicalActorScope,
  type CanonicalCondition,
  type CanonicalMetadata,
  type CanonicalProvenance,
  type CanonicalSignal,
  type CanonicalStrategyDefinition,
  type CanonicalStrategyDocument,
  type CanonicalStrategyMetric,
  type CanonicalTrigger,
} from "./types.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Who one actor id is, independently of this database. */
export type StrategyActorIdentity = {
  /** The bioguide id: the actor's portable identity. */
  externalId: string;
  displayName: string;
};

export type SerializeStrategyInput = {
  metadata: CanonicalMetadata;
  provenance: CanonicalProvenance;
  /**
   * The persisted Strategy document — schema version 1 or 2 — or an already-normalized one. It is
   * validated and canonicalized here, so a document the Strategy rules refuse is refused.
   */
  definition: unknown;
  /** Every actor the rules select, by this database's actor id. A missing one is refused. */
  actors?: ReadonlyMap<string, StrategyActorIdentity>;
  /**
   * The membership of each legacy actor-group scope, by group id, in member order — available where
   * it is frozen, as in a backtest snapshot. A group scope without one is refused, never read as
   * nobody.
   */
  actorGroups?: ReadonlyMap<string, readonly string[]>;
};

/**
 * Writes a Strategy as its canonical document.
 *
 * Throws {@link CanonicalDefinitionError} when the definition breaks a Strategy rule, names an
 * actor or a legacy group whose identity was not supplied, or carries anything else the format
 * cannot hold. The result is validated before it is returned, so every document this writes reads
 * back.
 */
export function serializeStrategy(
  input: SerializeStrategyInput,
): CanonicalStrategyDocument {
  let definition: StrategyDefinition;
  try {
    definition = normalizeStrategyDefinition(input.definition);
  } catch (error) {
    if (error instanceof StrategyValidationError) {
      throw new CanonicalDefinitionError(
        error.issues.map((issue) => strategyIssue(issue, "definition")),
      );
    }
    throw error;
  }

  if (input.actorGroups && input.actorGroups.size > 0) {
    try {
      definition = embedActorGroupScopes(definition, input.actorGroups);
    } catch (error) {
      if (error instanceof ActorGroupScopeUnresolvedError) {
        throw new CanonicalDefinitionError([
          {
            code: "ACTOR_GROUP_UNRESOLVED",
            path: "definition",
            message:
              error.reason === "MISSING"
                ? "A rule counts a legacy Congress group whose membership was not supplied."
                : "A rule counts a legacy Congress group with no members.",
          },
        ]);
      }
      if (error instanceof StrategyValidationError) {
        throw new CanonicalDefinitionError(
          error.issues.map((issue) => strategyIssue(issue, "definition")),
        );
      }
      throw error;
    }
  }

  const issues = new IssueCollector();
  const actorNames = new Map<string, string>();
  const writeMetric = (
    metric: StrategyMetric,
    path: string,
  ): CanonicalStrategyMetric =>
    canonicalMetricOf(metric, path, input.actors, actorNames, issues);

  const writeSignal = (
    signal: StrategySignal,
    path: string,
  ): CanonicalSignal => {
    const conditions = signal.conditions.map(
      (condition, index): CanonicalCondition => ({
        metric: writeMetric(
          condition.metric,
          childPath(childPath(childPath(path, "conditions"), index), "metric"),
        ),
        operator: condition.operator,
        value: canonicalValue(condition.value),
      }),
    );
    if (!signal.trigger) {
      return { conditions };
    }
    const trigger: CanonicalTrigger = {
      metric: writeMetric(
        signal.trigger.metric,
        childPath(childPath(path, "trigger"), "metric"),
      ),
      operator: signal.trigger.operator,
      value: canonicalValue(signal.trigger.value),
    };
    return { conditions, trigger };
  };

  const canonical: CanonicalStrategyDefinition = {
    buyLevels: definition.buyLevels.map((level, index) => ({
      percentage: level.percentage,
      signal: writeSignal(
        level.signal,
        `definition.buyLevels[${index}].signal`,
      ),
    })),
    sellLevels: definition.sellLevels.map((level, index) => ({
      percentage: level.percentage,
      signal: writeSignal(
        level.signal,
        `definition.sellLevels[${index}].signal`,
      ),
    })),
  };
  if (definition.finalExit) {
    canonical.finalExit = {
      rules: definition.finalExit.rules.map((rule, index) => ({
        signal: writeSignal(
          rule.signal,
          `definition.finalExit.rules[${index}].signal`,
        ),
      })),
    };
  }
  issues.throwIfAny();

  const document: CanonicalStrategyDocument = {
    format: CANONICAL_DEFINITION_FORMAT,
    schemaVersion: CANONICAL_DEFINITION_SCHEMA_VERSION,
    type: "strategy",
    metadata: canonicalMetadata(input.metadata),
    provenance: canonicalProvenance(input.provenance),
    definition: canonical,
  };
  if (actorNames.size > 0) {
    document.actors = [...actorNames.keys()]
      .sort(compareCodeUnits)
      .map((id): CanonicalActorReference => ({
        id,
        name: actorNames.get(id) as string,
      }));
  }

  // Lossless or refused: what was written must read back under the same rules.
  const check = new IssueCollector();
  validateStrategyDocument(document, check);
  check.throwIfAny();
  return document;
}

function canonicalMetadata(metadata: CanonicalMetadata): CanonicalMetadata {
  const description = metadata.description?.trim();
  return description
    ? { name: metadata.name.trim(), description }
    : { name: metadata.name.trim() };
}

function canonicalValue(value: StrategyValue): StrategyValue {
  return value.kind === "SERIES"
    ? { kind: "SERIES", seriesId: value.seriesId }
    : { kind: value.kind, value: value.value };
}

/**
 * One metric in canonical form, field by field in a fixed order. Every kind is spelled out so a
 * metric kind added to the platform later is a compile error here rather than a shape copied blind.
 */
function canonicalMetricOf(
  metric: StrategyMetric,
  path: string,
  actors: ReadonlyMap<string, StrategyActorIdentity> | undefined,
  actorNames: Map<string, string>,
  issues: IssueCollector,
): CanonicalStrategyMetric {
  switch (metric.kind) {
    case "PRICE":
      return metric.source
        ? { kind: "PRICE", source: canonicalSource(metric.source) }
        : { kind: "PRICE" };
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return metric.source
        ? {
            kind: metric.kind,
            seriesId: metric.seriesId,
            source: canonicalSource(metric.source),
          }
        : { kind: metric.kind, seriesId: metric.seriesId };
    case "RELATIVE_VOLUME":
      return metric.source
        ? {
            kind: "RELATIVE_VOLUME",
            period: metric.period,
            source: canonicalSource(metric.source),
          }
        : { kind: "RELATIVE_VOLUME", period: metric.period };
    case "MARGIN_OF_SAFETY":
      return { kind: "MARGIN_OF_SAFETY", sourceId: metric.sourceId };
    case "VALUATION_RATIO":
      return { kind: "VALUATION_RATIO", ratioId: metric.ratioId };
    case "FUNDAMENTAL":
      return { kind: "FUNDAMENTAL", metricId: metric.metricId };
    case "GAIN":
      return { kind: "GAIN" };
    case "LOSS":
      return { kind: "LOSS" };
    case "INSIDER_ACTIVITY":
      return metric.roles === undefined
        ? {
            kind: "INSIDER_ACTIVITY",
            measure: metric.measure,
            lookback: metric.lookback,
          }
        : {
            kind: "INSIDER_ACTIVITY",
            measure: metric.measure,
            lookback: metric.lookback,
            roles: [...metric.roles],
          };
    case "CONGRESS_ACTIVITY": {
      const scope = canonicalScopeOf(
        metric.scope,
        childPath(path, "scope"),
        actors,
        actorNames,
        issues,
      );
      const base = {
        kind: "CONGRESS_ACTIVITY" as const,
        measure: metric.measure,
        lookback: metric.lookback,
        scope,
        chamber: metric.chamber,
      };
      return metric.owners === undefined
        ? base
        : { ...base, owners: [...metric.owners] };
    }
  }
}

function canonicalSource(
  source: NonNullable<Extract<StrategyMetric, { kind: "PRICE" }>["source"]>,
): NonNullable<Extract<StrategyMetric, { kind: "PRICE" }>["source"]> {
  return source.kind === "ETF"
    ? { kind: "ETF", code: source.code }
    : { kind: "STOCK_SECTOR" };
}

function canonicalScopeOf(
  scope: ActorScope,
  path: string,
  actors: ReadonlyMap<string, StrategyActorIdentity> | undefined,
  actorNames: Map<string, string>,
  issues: IssueCollector,
): CanonicalActorScope {
  switch (scope.kind) {
    case "ANY":
      return { kind: "ANY" };
    case "ACTORS":
    case "ACTOR": {
      const ids = scope.kind === "ACTOR" ? [scope.actorId] : scope.actorIds;
      const externalIds: string[] = [];
      for (const actorId of ids) {
        const identity = actors?.get(actorId);
        if (!identity || !isActorScopeId(identity.externalId)) {
          issues.add(
            "ACTOR_UNRESOLVED",
            path,
            "A rule selects a member of Congress whose identity was not supplied.",
          );
          continue;
        }
        externalIds.push(identity.externalId);
        actorNames.set(identity.externalId, identity.displayName);
      }
      return { kind: "ACTORS", actors: canonicalActorIds(externalIds) };
    }
    case "GROUP":
      // Reached only when no membership was supplied for it: embedding replaced every group a
      // caller resolved. A group read as nobody would count nothing, so it is refused.
      issues.add(
        "ACTOR_GROUP_UNRESOLVED",
        path,
        "A rule counts a legacy Congress group whose membership was not supplied.",
      );
      return { kind: "ANY" };
  }
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

export type DeserializeStrategyOptions = {
  /** This database's actor id for a bioguide id, or undefined when none answers to it. */
  resolveActor: (externalId: string) => string | undefined;
  /**
   * The row id for each reconstructed level, Exit Rule, Condition and Trigger — a UUID per call, as
   * `rekeyStrategyDefinition` takes. Defaults to deterministic positional ids (`buy-1`,
   * `buy-1-condition-1`, `final-exit-rule-2`, …), so reading one document twice is byte-identical.
   */
  nextId?: () => string;
};

export type DeserializedStrategy = {
  /** Exactly what `validateStrategy` checks and the Strategy Builder saves. */
  draft: StrategyDraft;
  /** The document's provenance claim, as written. Trust is the reader's decision. */
  provenance: CanonicalProvenance;
};

/**
 * Reads a canonical Strategy document back into the platform's Strategy shape.
 *
 * Validates the document first, resolves every bioguide id through `resolveActor`, and returns a
 * normalized `StrategyDraft`. Writes nothing anywhere: persisting the result is the caller's act,
 * through the ordinary Strategy routes and their rules.
 */
export function deserializeStrategy(
  input: unknown,
  options: DeserializeStrategyOptions,
): DeserializedStrategy {
  const issues = new IssueCollector();
  validateStrategyDocument(input, issues);
  issues.throwIfAny();
  const document = input as CanonicalStrategyDocument;

  const unresolved = new IssueCollector();
  const definition = strategyDefinitionOf(document.definition, {
    nextId: options.nextId,
    actorId: (externalId, path) => {
      const actorId = options.resolveActor(externalId);
      if (actorId === undefined) {
        unresolved.add(
          "ACTOR_UNRESOLVED",
          path,
          `No member of Congress answers to bioguide id \`${externalId}\`.`,
        );
        return externalId;
      }
      return actorId;
    },
  });
  unresolved.throwIfAny();

  let normalized: StrategyDefinition;
  try {
    normalized = normalizeStrategyDefinition(definition);
  } catch (error) {
    if (error instanceof StrategyValidationError) {
      throw new CanonicalDefinitionError(
        error.issues.map((issue) => strategyIssue(issue, "definition")),
      );
    }
    throw error;
  }

  const draft: StrategyDraft = document.metadata.description
    ? {
        name: document.metadata.name,
        description: document.metadata.description,
        definition: normalized,
      }
    : { name: document.metadata.name, definition: normalized };
  return { draft, provenance: document.provenance };
}

/**
 * The platform's Strategy document for a canonical definition, with fresh row ids.
 *
 * `actorId` maps each selected bioguide id; validation passes the bioguide ids themselves, which
 * are valid actor identifiers for the Strategy validator, so one walk serves both.
 */
export function strategyDefinitionOf(
  canonical: CanonicalStrategyDefinition,
  options: {
    nextId?: () => string;
    actorId?: (externalId: string, path: string) => string;
  } = {},
): StrategyDefinition {
  const idOf = (positional: string): string =>
    options.nextId ? options.nextId() : positional;
  const actorId =
    options.actorId ?? ((externalId: string): string => externalId);

  const metricOf = (
    metric: CanonicalStrategyMetric,
    path: string,
  ): StrategyMetric => {
    if (metric.kind !== "CONGRESS_ACTIVITY") {
      return metric;
    }
    const scope: ActorScope =
      metric.scope.kind === "ANY"
        ? { kind: "ANY" }
        : {
            kind: "ACTORS",
            actorIds: canonicalActorIds(
              metric.scope.actors.map((externalId) =>
                actorId(externalId, childPath(path, "scope")),
              ),
            ),
          };
    return { ...metric, scope };
  };

  const signalOf = (
    signal: CanonicalSignal,
    prefix: string,
    path: string,
  ): StrategySignal => {
    const conditions = signal.conditions.map(
      (condition, index): StrategyCondition => ({
        id: idOf(`${prefix}-condition-${index + 1}`),
        metric: metricOf(
          condition.metric,
          `${path}.conditions[${index}].metric`,
        ),
        operator: condition.operator,
        value: condition.value,
      }),
    );
    if (!signal.trigger) {
      return { conditions };
    }
    const trigger: StrategyTrigger = {
      id: idOf(`${prefix}-trigger`),
      metric: metricOf(signal.trigger.metric, `${path}.trigger.metric`),
      operator: signal.trigger.operator,
      value: signal.trigger.value,
    };
    return { conditions, trigger };
  };

  const definition: StrategyDefinition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: canonical.buyLevels.map((level, index) => ({
      id: idOf(`buy-${index + 1}`),
      signal: signalOf(
        level.signal,
        `buy-${index + 1}`,
        `definition.buyLevels[${index}].signal`,
      ),
      percentage: level.percentage,
    })),
    sellLevels: canonical.sellLevels.map((level, index) => ({
      id: idOf(`sell-${index + 1}`),
      signal: signalOf(
        level.signal,
        `sell-${index + 1}`,
        `definition.sellLevels[${index}].signal`,
      ),
      percentage: level.percentage,
    })),
  };
  if (canonical.finalExit) {
    definition.finalExit = {
      id: idOf("final-exit"),
      rules: canonical.finalExit.rules.map((rule, index) => ({
        id: idOf(`final-exit-rule-${index + 1}`),
        signal: signalOf(
          rule.signal,
          `final-exit-rule-${index + 1}`,
          `definition.finalExit.rules[${index}].signal`,
        ),
      })),
    };
  }
  return definition;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const STRATEGY_DOCUMENT_KEYS = [
  "format",
  "schemaVersion",
  "type",
  "metadata",
  "provenance",
  "definition",
  "actors",
] as const;
const DEFINITION_KEYS = ["buyLevels", "sellLevels", "finalExit"] as const;
const LEVEL_KEYS = ["percentage", "signal"] as const;
const SIGNAL_KEYS = ["conditions", "trigger"] as const;
const PREDICATE_KEYS = ["metric", "operator", "value"] as const;
const FINAL_EXIT_KEYS = ["rules"] as const;
const RULE_KEYS = ["signal"] as const;
const ACTOR_REFERENCE_KEYS = ["id", "name"] as const;

/**
 * Every issue in a canonical Strategy document, structural and semantic.
 *
 * Structural: the envelope, the closed key set of every container, the portable actor scope and its
 * references. Semantic: the logic is rebuilt into the platform's Strategy document and checked by
 * `validateStrategyDefinition` itself — the one set of Strategy rules, never a second copy.
 */
export function validateStrategyDocument(
  input: unknown,
  issues: IssueCollector,
): void {
  if (!isRecord(input)) {
    issues.add("SHAPE_INVALID", "", "A definition must be a JSON object.");
    return;
  }
  const type = validateHeader(input, issues);
  if (type === "list") {
    issues.add(
      "TYPE_UNSUPPORTED",
      "type",
      "This is a list definition, not a strategy.",
    );
    return;
  }
  rejectUnknownKeys(input, STRATEGY_DOCUMENT_KEYS, "", issues);
  validateMetadata(input.metadata, "metadata", issues, {
    nameMaxLength: STRATEGY_NAME_MAX_LENGTH,
    descriptionMaxLength: STRATEGY_DESCRIPTION_MAX_LENGTH,
  });
  validateProvenance(input.provenance, "provenance", issues, {
    versioned: true,
  });

  const definition = input.definition;
  if (!isRecord(definition)) {
    issues.add(
      "SHAPE_INVALID",
      "definition",
      "A strategy definition must be an object.",
    );
    return;
  }
  rejectUnknownKeys(definition, DEFINITION_KEYS, "definition", issues);

  const selected = new Set<string>();
  const structureBefore = issues.issues.length;
  const checkLevels = (key: "buyLevels" | "sellLevels"): void => {
    const levels = definition[key];
    const path = childPath("definition", key);
    if (!Array.isArray(levels)) {
      issues.add("SHAPE_INVALID", path, "Levels must be a list.");
      return;
    }
    levels.forEach((level, index) => {
      const levelPath = childPath(path, index);
      if (!isRecord(level)) {
        issues.add("SHAPE_INVALID", levelPath, "A level must be an object.");
        return;
      }
      rejectUnknownKeys(level, LEVEL_KEYS, levelPath, issues);
      checkSignal(
        level.signal,
        childPath(levelPath, "signal"),
        selected,
        issues,
      );
    });
  };
  checkLevels("buyLevels");
  checkLevels("sellLevels");
  if (definition.finalExit !== undefined) {
    const path = "definition.finalExit";
    const finalExit = definition.finalExit;
    if (!isRecord(finalExit)) {
      issues.add("SHAPE_INVALID", path, "FINAL EXIT must be an object.");
    } else {
      rejectUnknownKeys(finalExit, FINAL_EXIT_KEYS, path, issues);
      if (!Array.isArray(finalExit.rules)) {
        issues.add(
          "SHAPE_INVALID",
          `${path}.rules`,
          "Exit Rules must be a list.",
        );
      } else {
        finalExit.rules.forEach((rule, index) => {
          const rulePath = `${path}.rules[${index}]`;
          if (!isRecord(rule)) {
            issues.add(
              "SHAPE_INVALID",
              rulePath,
              "An Exit Rule must be an object.",
            );
            return;
          }
          rejectUnknownKeys(rule, RULE_KEYS, rulePath, issues);
          checkSignal(rule.signal, `${rulePath}.signal`, selected, issues);
        });
      }
    }
  }
  validateActorReferences(input.actors, selected, issues);

  if (issues.issues.length > structureBefore) {
    // The structure is not one the Strategy rules can be asked about yet.
    return;
  }
  const rebuilt = strategyDefinitionOf(
    definition as unknown as CanonicalStrategyDefinition,
  );
  for (const issue of validateStrategyDefinition(rebuilt)) {
    issues.issues.push(strategyIssue(issue, "definition"));
  }
}

function checkSignal(
  signal: unknown,
  path: string,
  selected: Set<string>,
  issues: IssueCollector,
): void {
  if (!isRecord(signal)) {
    issues.add("SHAPE_INVALID", path, "A Signal must be an object.");
    return;
  }
  rejectUnknownKeys(signal, SIGNAL_KEYS, path, issues);
  if (!Array.isArray(signal.conditions)) {
    issues.add(
      "SHAPE_INVALID",
      `${path}.conditions`,
      "Conditions must be a list.",
    );
  } else {
    signal.conditions.forEach((condition, index) => {
      checkPredicate(
        condition,
        `${path}.conditions[${index}]`,
        selected,
        issues,
      );
    });
  }
  if (signal.trigger !== undefined) {
    checkPredicate(signal.trigger, `${path}.trigger`, selected, issues);
  }
}

function checkPredicate(
  predicate: unknown,
  path: string,
  selected: Set<string>,
  issues: IssueCollector,
): void {
  if (!isRecord(predicate)) {
    issues.add("SHAPE_INVALID", path, "A rule must be an object.");
    return;
  }
  rejectUnknownKeys(predicate, PREDICATE_KEYS, path, issues);
  const metric = predicate.metric;
  if (!isRecord(metric) || metric.kind !== "CONGRESS_ACTIVITY") {
    // Every other metric kind is the Strategy grammar verbatim; its closed key set is the Strategy
    // validator's to check.
    return;
  }
  const scopePath = `${path}.metric.scope`;
  const scope = metric.scope;
  if (!isRecord(scope)) {
    issues.add("SHAPE_INVALID", scopePath, "A Congress rule needs a scope.");
    return;
  }
  if (scope.kind === "ANY") {
    rejectUnknownKeys(scope, ["kind"], scopePath, issues);
    return;
  }
  if (scope.kind !== "ACTORS") {
    issues.add(
      "SHAPE_INVALID",
      scopePath,
      "A Congress scope is `ANY` or an `ACTORS` selection by bioguide id.",
    );
    return;
  }
  rejectUnknownKeys(scope, ["kind", "actors"], scopePath, issues);
  const actors = scope.actors;
  if (
    !Array.isArray(actors) ||
    actors.length === 0 ||
    !actors.every((actor) => isActorScopeId(actor))
  ) {
    issues.add(
      "SHAPE_INVALID",
      `${scopePath}.actors`,
      "A selection lists one or more bioguide ids.",
    );
    return;
  }
  const canonical = canonicalActorIds(actors as string[]);
  if (
    canonical.length !== actors.length ||
    canonical.some((actor, index) => actor !== actors[index])
  ) {
    issues.add(
      "SHAPE_INVALID",
      `${scopePath}.actors`,
      "A selection lists each bioguide id once, sorted.",
    );
    return;
  }
  for (const actor of canonical) {
    selected.add(actor);
  }
}

function validateActorReferences(
  references: unknown,
  selected: ReadonlySet<string>,
  issues: IssueCollector,
): void {
  if (references === undefined) {
    if (selected.size > 0) {
      issues.add(
        "ACTOR_REFERENCES_INVALID",
        "actors",
        "A strategy that selects members of Congress lists who each of them is.",
      );
    }
    return;
  }
  if (!Array.isArray(references) || references.length === 0) {
    issues.add(
      "ACTOR_REFERENCES_INVALID",
      "actors",
      "`actors` is a non-empty list, present only when a rule selects members.",
    );
    return;
  }
  const seen: string[] = [];
  references.forEach((reference, index) => {
    const path = `actors[${index}]`;
    if (!isRecord(reference)) {
      issues.add(
        "SHAPE_INVALID",
        path,
        "An actor reference must be an object.",
      );
      return;
    }
    rejectUnknownKeys(reference, ACTOR_REFERENCE_KEYS, path, issues);
    if (!isActorScopeId(reference.id)) {
      issues.add(
        "SHAPE_INVALID",
        `${path}.id`,
        "An actor reference names a bioguide id.",
      );
      return;
    }
    if (
      typeof reference.name !== "string" ||
      reference.name.trim().length === 0
    ) {
      issues.add(
        "SHAPE_INVALID",
        `${path}.name`,
        "An actor reference carries a name.",
      );
    }
    seen.push(reference.id);
  });
  const sorted = canonicalActorIds(seen);
  if (
    sorted.length !== seen.length ||
    sorted.some((id, index) => id !== seen[index])
  ) {
    issues.add(
      "ACTOR_REFERENCES_INVALID",
      "actors",
      "Actor references are listed once each, sorted by id.",
    );
    return;
  }
  const missing = [...selected].filter((id) => !seen.includes(id));
  const unused = seen.filter((id) => !selected.has(id));
  if (missing.length > 0 || unused.length > 0) {
    issues.add(
      "ACTOR_REFERENCES_INVALID",
      "actors",
      "Actor references describe exactly the members the rules select.",
    );
  }
}

/** A Strategy validator issue at its place in the canonical document. */
function strategyIssue(
  issue: StrategyValidationIssue,
  root: string,
): CanonicalDefinitionIssue {
  return {
    code: "STRATEGY_INVALID",
    path: strategyIssuePath(issue.path, root),
    message: issue.message,
  };
}

function strategyIssuePath(path: StrategyIssuePath, root: string): string {
  let result = root;
  if (path.levelKind === "BUY" || path.levelKind === "SELL") {
    result = `${result}.${path.levelKind === "BUY" ? "buyLevels" : "sellLevels"}`;
    if (path.levelIndex !== undefined) {
      result = `${result}[${path.levelIndex}]`;
    }
  } else if (path.levelKind === "FINAL_EXIT") {
    result = `${result}.finalExit`;
    if (path.ruleIndex !== undefined) {
      result = `${result}.rules[${path.ruleIndex}]`;
    }
  }
  if (path.part === "PERCENTAGE") {
    return `${result}.percentage`;
  }
  if (path.part === "CONDITION" || path.part === "TRIGGER") {
    result =
      path.part === "CONDITION"
        ? `${result}.signal.conditions${
            path.conditionIndex === undefined ? "" : `[${path.conditionIndex}]`
          }`
        : `${result}.signal.trigger`;
    if (path.field) {
      result = `${result}.${path.field.toLowerCase()}`;
    }
  }
  return result;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
