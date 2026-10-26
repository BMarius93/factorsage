/**
 * The canonical, versioned JSON form of a Strategy and of a Stock List
 * (`docs/decisions/canonical-definitions-v1.md`).
 *
 * A **portable representation**, never a source of truth: Strategies stay `Strategy` and
 * `StrategyVersion` rows, Lists stay `StockList` rows, and a backtest still executes its own frozen
 * snapshot. A canonical document is what one of them *means*, written so it can leave the database —
 * into a shared backtest today, into an export, a template or an import later — and be read back to
 * the same meaning.
 *
 * Four properties hold for every document this module writes, and the tests hold them:
 *
 * 1. **Self-describing.** `format`, `schemaVersion` and `type` lead every document; a reader refuses
 *    a format, version or type it does not know instead of guessing.
 * 2. **Portable.** No database id: row ids are dropped (they are identity, not meaning — the
 *    platform's own fingerprint ignores them), a security is its `symbol` and `exchange`, a member of
 *    Congress their bioguide id, an ETF its benchmark code and a series its catalog id.
 * 3. **Deterministic.** One meaning, one document: members, actors and windows are in canonical
 *    order, optional fields are omitted rather than written empty, and key order is fixed.
 * 4. **Lossless or refused.** A definition holding something this format cannot carry is rejected
 *    with an issue naming it; nothing is dropped on the way in or out.
 */

import type {
  BuyLevelPercentage,
  ConditionOperator,
  CongressActivityMetric,
  SellLevelPercentage,
  StrategyMetric,
  StrategyValue,
  TriggerOperator,
} from "@intrinsic/contracts";

/** The `format` every canonical definition document carries. */
export const CANONICAL_DEFINITION_FORMAT = "factorsage.definition" as const;

/**
 * The canonical document's own schema version.
 *
 * Independent of `STRATEGY_SCHEMA_VERSION`, the persisted Strategy document's version: this one
 * describes the portable envelope and the List form as well. A reader of version 1 refuses any
 * other version.
 */
export const CANONICAL_DEFINITION_SCHEMA_VERSION = 1 as const;

export const CANONICAL_DEFINITION_TYPES = ["strategy", "list"] as const;
export type CanonicalDefinitionType =
  (typeof CANONICAL_DEFINITION_TYPES)[number];

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a definition comes from.
 *
 * - `built_in` — an official FactorSage definition, unchanged: a SYSTEM Strategy or List, or a copy
 *   of one whose logic or membership is still exactly the official one.
 * - `custom` — written by a customer.
 * - `derived` — created from a built-in and changed since.
 * - `unknown` — what is recorded cannot establish which of those it is. Never a guess.
 */
export const DEFINITION_ORIGINS = [
  "built_in",
  "custom",
  "derived",
  "unknown",
] as const;
export type DefinitionOrigin = (typeof DEFINITION_ORIGINS)[number];

/**
 * What a provenance claim rests on, so a reader can judge it.
 *
 * - `system_content` — the definition is SYSTEM-owned content (`ownership = SYSTEM`).
 * - `copy_record` — the copy's origin was recorded when it was duplicated.
 * - `authored_record` — the content was recorded as written from scratch when it was created.
 * - `version_history` — content saved before origins were recorded: its first version is
 *   byte-for-byte the logic of a built-in version (`definitionHash`), so it began as that built-in.
 * - `content_match` — the definition's logic is identical to a built-in version's.
 */
export const PROVENANCE_EVIDENCE = [
  "system_content",
  "copy_record",
  "authored_record",
  "version_history",
  "content_match",
] as const;
export type ProvenanceEvidence = (typeof PROVENANCE_EVIDENCE)[number];

/** One built-in, by its immutable `systemKey` — never by its name. */
export type CanonicalBuiltInReference = {
  systemKey: string;
  /** The built-in's official name, for presentation. Never the identity. */
  name: string;
  /** Strategies only: the built-in's `StrategyVersion` number the definition is, or began as. */
  version?: number;
  /** The built-in is premium content (`docs/decisions/entitlements-v2.md` §6). */
  premium?: true;
};

export type CanonicalProvenance =
  | {
      origin: "built_in";
      evidence: ProvenanceEvidence;
      builtIn: CanonicalBuiltInReference;
    }
  | {
      origin: "derived";
      evidence: ProvenanceEvidence;
      derivedFrom: CanonicalBuiltInReference;
    }
  | { origin: "custom"; evidence: ProvenanceEvidence }
  | { origin: "unknown" };

/** Identity fields a reconstruction needs. Never a user id, an email or a timestamp. */
export type CanonicalMetadata = {
  name: string;
  description?: string;
};

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * Whose Congressional activity a rule counts, portably: every member, or the members it selects by
 * **bioguide id**, sorted and de-duplicated.
 *
 * The platform's `ACTORS` scope holds this database's actor ids; the legacy `ACTOR` scope is one of
 * them and is written as a one-member selection, which is what it means. A legacy `GROUP` scope is
 * written as the selection of the members its membership held — available only where that
 * membership is frozen, as in a backtest snapshot — and is refused otherwise.
 */
export type CanonicalActorScope =
  { kind: "ANY" } | { kind: "ACTORS"; actors: string[] };

export type CanonicalCongressActivityMetric = Omit<
  CongressActivityMetric,
  "scope"
> & { scope: CanonicalActorScope };

/** The Strategy metric grammar, verbatim, except that a Congress scope names actors portably. */
export type CanonicalStrategyMetric =
  | Exclude<StrategyMetric, { kind: "CONGRESS_ACTIVITY" }>
  | CanonicalCongressActivityMetric;

export type CanonicalCondition = {
  metric: CanonicalStrategyMetric;
  operator: ConditionOperator;
  value: StrategyValue;
};

export type CanonicalTrigger = {
  metric: CanonicalStrategyMetric;
  operator: TriggerOperator;
  value: StrategyValue;
};

/** Conditions ANDed, plus at most one Trigger ANDed with them for the same session. */
export type CanonicalSignal = {
  conditions: CanonicalCondition[];
  trigger?: CanonicalTrigger;
};

export type CanonicalBuyLevel = {
  percentage: BuyLevelPercentage;
  signal: CanonicalSignal;
};

export type CanonicalSellLevel = {
  percentage: SellLevelPercentage;
  signal: CanonicalSignal;
};

/** FINAL EXIT: one action, reached by any of its Exit Rules (OR of AND groups). */
export type CanonicalFinalExit = { rules: { signal: CanonicalSignal }[] };

/**
 * The Strategy document's logic in its canonical, id-free form: ordered BUY levels, ordered SELL
 * levels and an optional FINAL EXIT, exactly as the persisted Strategy document orders them.
 */
export type CanonicalStrategyDefinition = {
  buyLevels: CanonicalBuyLevel[];
  sellLevels: CanonicalSellLevel[];
  finalExit?: CanonicalFinalExit;
};

/** Who one bioguide id is. A label for descriptions; never matched on. */
export type CanonicalActorReference = { id: string; name: string };

export type CanonicalStrategyDocument = {
  format: typeof CANONICAL_DEFINITION_FORMAT;
  schemaVersion: typeof CANONICAL_DEFINITION_SCHEMA_VERSION;
  type: "strategy";
  metadata: CanonicalMetadata;
  provenance: CanonicalProvenance;
  definition: CanonicalStrategyDefinition;
  /**
   * Present exactly when a rule selects members of Congress: one entry per selected bioguide id, by
   * id. Required so a description can name whose activity a rule counts without a database.
   */
  actors?: CanonicalActorReference[];
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * One security, portably: its symbol and its exchange, the catalog's unique pair and the identity
 * the built-in catalog itself is written in. Never the database id.
 */
export type CanonicalSecurityReference = { symbol: string; exchange: string };

/** Buy eligibility: always, or only inside canonical normalized ranges (`endDate` null = open). */
export type CanonicalBuyWindow =
  | { mode: "FULL" }
  | {
      mode: "CUSTOM";
      ranges: { startDate: string; endDate: string | null }[];
    };

export type CanonicalListMember = {
  security: CanonicalSecurityReference;
  buyWindow: CanonicalBuyWindow;
};

/** A List written member by member, sorted by symbol then exchange. */
export type CanonicalMemberList = {
  kind: "members";
  members: CanonicalListMember[];
};

/**
 * A point-in-time index universe, by **pinned reference** rather than by its members.
 *
 * A reconstructed universe holds hundreds of securities and is re-projected whenever its canonical
 * membership is corrected, so writing it out member by member would copy the membership dataset
 * into every document and still not say which projection it was. Instead the document names the
 * universe and pins the exact membership with a digest: a reader may reconstruct it only from a
 * source whose canonical membership has the same digest — the backtest snapshot that froze it, or a
 * projection that has not moved since — and must refuse otherwise. A pinned reference can never
 * silently resolve to today's constituents.
 */
export type CanonicalIndexMembership = {
  kind: "point_in_time_index";
  /** The index (`MarketIndexKey`), e.g. `SP500`. */
  index: string;
  /** The built-in universe List's immutable `systemKey`, e.g. `sp500-historical-pit`. */
  universe: string;
  /** The earliest date the universe's membership is projected from. */
  membershipFloor: string;
  /**
   * Present when the membership was selected for a backtest: every member with a membership period
   * overlapping these dates, each with all of its periods. Absent for the whole projection.
   */
  period?: { startDate: string; endDate: string };
  membership: {
    /** `sha256:` plus the digest of the members' canonical form ({@link canonicalMembersDigest}). */
    digest: string;
    /** Distinct securities pinned. */
    securities: number;
    /** Membership periods (CUSTOM ranges) across them. */
    windows: number;
    /** The most members eligible on one date — over `period` when present. */
    peakSimultaneousMembers: number;
  };
};

export type CanonicalListDefinition = {
  membership: CanonicalMemberList | CanonicalIndexMembership;
};

export type CanonicalListDocument = {
  format: typeof CANONICAL_DEFINITION_FORMAT;
  schemaVersion: typeof CANONICAL_DEFINITION_SCHEMA_VERSION;
  type: "list";
  metadata: CanonicalMetadata;
  provenance: CanonicalProvenance;
  definition: CanonicalListDefinition;
};

export type CanonicalDefinitionDocument =
  CanonicalStrategyDocument | CanonicalListDocument;

/** A deterministic description: one sentence for a card, and the whole definition in words. */
export type DefinitionDescription = {
  short: string;
  detailed: string;
};
