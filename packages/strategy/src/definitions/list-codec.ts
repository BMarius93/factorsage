/**
 * Stock List ⇄ canonical JSON.
 *
 * An ordinary List is written member by member: each security by its portable `symbol` and
 * `exchange`, with its buy window in the one canonical normalized form `normalizeBuyWindowRanges`
 * defines. A **point-in-time index universe** is written as a pinned reference instead — the index,
 * the universe, its floor, the period it was selected for and a digest of the exact membership —
 * and reconstructing it requires a source whose membership has that digest. Nothing here can turn a
 * historical membership into today's.
 */

import {
  BUY_WINDOW_MAX_RANGES,
  STOCK_LIST_DESCRIPTION_MAX_LENGTH,
  STOCK_LIST_NAME_MAX_LENGTH,
  sha256Hex,
} from "@intrinsic/contracts";
import {
  BuyWindowValidationError,
  isMarketIndexKey,
  normalizeBuyWindowConfiguration,
  normalizeBuyWindowRanges,
  peakSimultaneousMembers,
  pointInTimeIndexUniverse,
  type BuyWindowConfiguration,
} from "@intrinsic/domain";
import {
  canonicalProvenance,
  validateHeader,
  validateMetadata,
  validateProvenance,
} from "./envelope.js";
import {
  CanonicalDefinitionError,
  childPath,
  isRecord,
  IssueCollector,
  rejectUnknownKeys,
} from "./issues.js";
import {
  CANONICAL_DEFINITION_FORMAT,
  CANONICAL_DEFINITION_SCHEMA_VERSION,
  type CanonicalBuyWindow,
  type CanonicalIndexMembership,
  type CanonicalListDocument,
  type CanonicalListMember,
  type CanonicalMetadata,
  type CanonicalProvenance,
  type CanonicalSecurityReference,
} from "./types.js";

/** One List member as the platform holds it, with its security named portably. */
export type ListMemberInput = {
  security: CanonicalSecurityReference;
  buyWindow: BuyWindowConfiguration;
};

export type SerializeListInput = {
  metadata: CanonicalMetadata;
  provenance: CanonicalProvenance;
  membership:
    | { kind: "members"; members: readonly ListMemberInput[] }
    | {
        kind: "point_in_time_index";
        /** The index (`MarketIndexKey`); its universe must be one this build defines. */
        index: string;
        /** The period the membership was selected for, when it was selected for a backtest. */
        period?: { startDate: string; endDate: string };
        /** The exact membership to pin, as frozen. */
        members: readonly ListMemberInput[];
      };
};

/** The last date `peakSimultaneousMembers` is asked about for a membership with no period. */
const OPEN_PERIOD_END = "9999-12-31";

/**
 * Writes a Stock List as its canonical document.
 *
 * Every buy window is normalized through the domain's one normalizer, members are sorted by
 * symbol then exchange (code units, no locale), and a security named twice is refused rather than
 * merged. Throws {@link CanonicalDefinitionError}.
 */
export function serializeList(
  input: SerializeListInput,
): CanonicalListDocument {
  const issues = new IssueCollector();
  const members = canonicalMembers(
    input.membership.members,
    "definition.membership.members",
    issues,
  );
  issues.throwIfAny();

  let membership: CanonicalListDocument["definition"]["membership"];
  if (input.membership.kind === "members") {
    membership = { kind: "members", members };
  } else {
    const index = input.membership.index;
    if (!isMarketIndexKey(index)) {
      throw new CanonicalDefinitionError([
        {
          code: "INDEX_UNIVERSE_UNSUPPORTED",
          path: "definition.membership.index",
          message: `No point-in-time universe is defined for index \`${index}\`.`,
        },
      ]);
    }
    const universe = pointInTimeIndexUniverse(index);
    const period = input.membership.period;
    membership = {
      kind: "point_in_time_index",
      index,
      universe: universe.listSystemKey,
      membershipFloor: universe.membershipFloor,
      ...(period
        ? { period: { startDate: period.startDate, endDate: period.endDate } }
        : {}),
      membership: pinnedMembership(members, period, universe.membershipFloor),
    };
  }

  const document: CanonicalListDocument = {
    format: CANONICAL_DEFINITION_FORMAT,
    schemaVersion: CANONICAL_DEFINITION_SCHEMA_VERSION,
    type: "list",
    metadata: canonicalListMetadata(input.metadata),
    provenance: canonicalProvenance(input.provenance),
    definition: { membership },
  };
  const check = new IssueCollector();
  validateListDocument(document, check);
  check.throwIfAny();
  return document;
}

function canonicalListMetadata(metadata: CanonicalMetadata): CanonicalMetadata {
  const description = metadata.description?.trim();
  return description
    ? { name: metadata.name.trim(), description }
    : { name: metadata.name.trim() };
}

function canonicalBuyWindow(
  configuration: BuyWindowConfiguration,
): CanonicalBuyWindow {
  const normalized = normalizeBuyWindowConfiguration(configuration);
  return normalized.mode === "FULL"
    ? { mode: "FULL" }
    : {
        mode: "CUSTOM",
        ranges: normalized.ranges.map((range) => ({
          startDate: range.startDate,
          endDate: range.endDate,
        })),
      };
}

function canonicalMembers(
  inputs: readonly ListMemberInput[],
  path: string,
  issues: IssueCollector,
): CanonicalListMember[] {
  const members: CanonicalListMember[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const memberPath = childPath(path, index);
    const symbol = input.security.symbol.trim();
    const exchange = input.security.exchange.trim();
    if (symbol.length === 0 || exchange.length === 0) {
      issues.add(
        "SECURITY_INVALID",
        childPath(memberPath, "security"),
        "A member names its security by symbol and exchange.",
      );
      return;
    }
    const key = securityKey({ symbol, exchange });
    if (seen.has(key)) {
      issues.add(
        "SECURITY_DUPLICATE",
        childPath(memberPath, "security"),
        `${symbol} on ${exchange} is listed more than once.`,
      );
      return;
    }
    seen.add(key);
    let buyWindow: CanonicalBuyWindow;
    try {
      buyWindow = canonicalBuyWindow(input.buyWindow);
    } catch (error) {
      if (error instanceof BuyWindowValidationError) {
        issues.add(
          "BUY_WINDOW_INVALID",
          childPath(memberPath, "buyWindow"),
          error.message,
        );
        return;
      }
      throw error;
    }
    members.push({ security: { symbol, exchange }, buyWindow });
  });
  return members.sort(compareMembers);
}

function securityKey(security: CanonicalSecurityReference): string {
  return `${security.symbol}\u0000${security.exchange}`;
}

function compareMembers(
  left: CanonicalListMember,
  right: CanonicalListMember,
): number {
  return compareCodeUnits(
    securityKey(left.security),
    securityKey(right.security),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The digest a pinned membership is identified by: SHA-256 of the members' canonical JSON, with
 * `sha256:` in front. The members must already be canonical — sorted, normalized — which is what
 * makes two sources holding the same membership produce the same digest.
 */
export function canonicalMembersDigest(
  members: readonly CanonicalListMember[],
): string {
  return `sha256:${sha256Hex(JSON.stringify(members))}`;
}

function pinnedMembership(
  members: readonly CanonicalListMember[],
  period: { startDate: string; endDate: string } | undefined,
  floor: string,
): CanonicalIndexMembership["membership"] {
  const configurations = members.map(buyWindowConfigurationOf);
  return {
    digest: canonicalMembersDigest(members),
    securities: members.length,
    windows: members.reduce(
      (total, member) =>
        total +
        (member.buyWindow.mode === "CUSTOM"
          ? member.buyWindow.ranges.length
          : 0),
      0,
    ),
    peakSimultaneousMembers: peakSimultaneousMembers(configurations, {
      from: period?.startDate ?? floor,
      to: period?.endDate ?? OPEN_PERIOD_END,
    }).peak,
  };
}

function buyWindowConfigurationOf(
  member: CanonicalListMember,
): BuyWindowConfiguration {
  return member.buyWindow.mode === "FULL"
    ? { mode: "FULL", ranges: [] }
    : { mode: "CUSTOM", ranges: member.buyWindow.ranges };
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

export type DeserializeListOptions = {
  /** This database's security id for a portable reference, or undefined when none answers to it. */
  resolveSecurity: (security: CanonicalSecurityReference) => string | undefined;
  /**
   * The exact membership a pinned point-in-time reference names — from the backtest snapshot that
   * froze it, or a projection that has not moved — or undefined when this source cannot supply it.
   * Whatever it returns is checked against the pinned digest; it is never trusted.
   */
  resolveIndexMembership?: (
    reference: CanonicalIndexMembership,
  ) => readonly ListMemberInput[] | undefined;
};

export type DeserializedListMember = {
  securityId: string;
  security: CanonicalSecurityReference;
  buyWindow: BuyWindowConfiguration;
};

export type DeserializedList = {
  name: string;
  description?: string;
  /** In canonical order: by symbol, then exchange. */
  members: DeserializedListMember[];
  /** Present for a point-in-time universe: which one, and what its membership was pinned to. */
  universe?: Omit<CanonicalIndexMembership, "kind">;
  provenance: CanonicalProvenance;
};

/**
 * Reads a canonical List document back into members with this database's security ids.
 *
 * A pinned point-in-time membership is reconstructed only from a source whose canonical membership
 * has the pinned digest and counts; anything else — no source, a moved projection, today's
 * constituents — is refused with `INDEX_MEMBERSHIP_UNAVAILABLE` or `INDEX_MEMBERSHIP_MISMATCH`.
 * Every unresolved security is refused, never skipped. Writes nothing anywhere.
 */
export function deserializeList(
  input: unknown,
  options: DeserializeListOptions,
): DeserializedList {
  const issues = new IssueCollector();
  validateListDocument(input, issues);
  issues.throwIfAny();
  const document = input as CanonicalListDocument;
  const membership = document.definition.membership;

  let members: readonly CanonicalListMember[];
  let universe: DeserializedList["universe"];
  if (membership.kind === "members") {
    members = membership.members;
  } else {
    const supplied = options.resolveIndexMembership?.(membership);
    if (supplied === undefined) {
      throw new CanonicalDefinitionError([
        {
          code: "INDEX_MEMBERSHIP_UNAVAILABLE",
          path: "definition.membership",
          message:
            "The pinned historical membership is not available here, so this universe cannot be reconstructed.",
        },
      ]);
    }
    const resolving = new IssueCollector();
    const canonical = canonicalMembers(
      supplied,
      "definition.membership",
      resolving,
    );
    resolving.throwIfAny();
    const pinned = pinnedMembership(
      canonical,
      membership.period,
      membership.membershipFloor,
    );
    if (
      pinned.digest !== membership.membership.digest ||
      pinned.securities !== membership.membership.securities ||
      pinned.windows !== membership.membership.windows ||
      pinned.peakSimultaneousMembers !==
        membership.membership.peakSimultaneousMembers
    ) {
      throw new CanonicalDefinitionError([
        {
          code: "INDEX_MEMBERSHIP_MISMATCH",
          path: "definition.membership.membership",
          message:
            "The membership available here is not the pinned one; reconstructing from it would change history.",
        },
      ]);
    }
    members = canonical;
    universe = {
      index: membership.index,
      universe: membership.universe,
      membershipFloor: membership.membershipFloor,
      ...(membership.period ? { period: { ...membership.period } } : {}),
      membership: { ...membership.membership },
    };
  }

  const unresolved = new IssueCollector();
  const resolved: DeserializedListMember[] = [];
  members.forEach((member, index) => {
    const securityId = options.resolveSecurity(member.security);
    if (securityId === undefined) {
      unresolved.add(
        "SECURITY_UNRESOLVED",
        `definition.membership.members[${index}].security`,
        `No security answers to ${member.security.symbol} on ${member.security.exchange}.`,
      );
      return;
    }
    resolved.push({
      securityId,
      security: { ...member.security },
      buyWindow: buyWindowConfigurationOf(member),
    });
  });
  unresolved.throwIfAny();
  const duplicateIds =
    resolved.length - new Set(resolved.map((member) => member.securityId)).size;
  if (duplicateIds > 0) {
    throw new CanonicalDefinitionError([
      {
        code: "SECURITY_DUPLICATE",
        path: "definition.membership",
        message: "Two references resolve to the same security.",
      },
    ]);
  }

  return {
    name: document.metadata.name,
    ...(document.metadata.description
      ? { description: document.metadata.description }
      : {}),
    members: resolved,
    ...(universe ? { universe } : {}),
    provenance: document.provenance,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LIST_DOCUMENT_KEYS = [
  "format",
  "schemaVersion",
  "type",
  "metadata",
  "provenance",
  "definition",
] as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateListDocument(
  input: unknown,
  issues: IssueCollector,
): void {
  if (!isRecord(input)) {
    issues.add("SHAPE_INVALID", "", "A definition must be a JSON object.");
    return;
  }
  const type = validateHeader(input, issues);
  if (type === "strategy") {
    issues.add(
      "TYPE_UNSUPPORTED",
      "type",
      "This is a strategy definition, not a list.",
    );
    return;
  }
  rejectUnknownKeys(input, LIST_DOCUMENT_KEYS, "", issues);
  validateMetadata(input.metadata, "metadata", issues, {
    nameMaxLength: STOCK_LIST_NAME_MAX_LENGTH,
    descriptionMaxLength: STOCK_LIST_DESCRIPTION_MAX_LENGTH,
  });
  validateProvenance(input.provenance, "provenance", issues, {
    versioned: false,
  });

  const definition = input.definition;
  if (!isRecord(definition)) {
    issues.add(
      "SHAPE_INVALID",
      "definition",
      "A list definition must be an object.",
    );
    return;
  }
  rejectUnknownKeys(definition, ["membership"], "definition", issues);
  const membership = definition.membership;
  const path = "definition.membership";
  if (!isRecord(membership)) {
    issues.add(
      "SHAPE_INVALID",
      path,
      "A list definition states its membership.",
    );
    return;
  }
  if (membership.kind === "members") {
    rejectUnknownKeys(membership, ["kind", "members"], path, issues);
    validateMembers(membership.members, `${path}.members`, issues);
    return;
  }
  if (membership.kind === "point_in_time_index") {
    validateIndexMembership(membership, path, issues);
    return;
  }
  issues.add(
    "SHAPE_INVALID",
    `${path}.kind`,
    "Membership is `members` or a `point_in_time_index` reference.",
  );
}

function validateMembers(
  members: unknown,
  path: string,
  issues: IssueCollector,
): void {
  if (!Array.isArray(members)) {
    issues.add("SHAPE_INVALID", path, "Members must be a list.");
    return;
  }
  let previous: string | undefined;
  members.forEach((member, index) => {
    const memberPath = childPath(path, index);
    if (!isRecord(member)) {
      issues.add("SHAPE_INVALID", memberPath, "A member must be an object.");
      return;
    }
    rejectUnknownKeys(member, ["security", "buyWindow"], memberPath, issues);
    const security = member.security;
    const securityPath = childPath(memberPath, "security");
    if (!isRecord(security)) {
      issues.add(
        "SECURITY_INVALID",
        securityPath,
        "A member names its security.",
      );
      return;
    }
    rejectUnknownKeys(security, ["symbol", "exchange"], securityPath, issues);
    const symbol = security.symbol;
    const exchange = security.exchange;
    if (
      typeof symbol !== "string" ||
      typeof exchange !== "string" ||
      symbol.trim().length === 0 ||
      exchange.trim().length === 0 ||
      symbol !== symbol.trim() ||
      exchange !== exchange.trim()
    ) {
      issues.add(
        "SECURITY_INVALID",
        securityPath,
        "A security is a trimmed symbol and a trimmed exchange code.",
      );
      return;
    }
    const key = securityKey({ symbol, exchange });
    if (previous !== undefined) {
      if (key === previous) {
        issues.add(
          "SECURITY_DUPLICATE",
          securityPath,
          `${symbol} on ${exchange} is listed twice.`,
        );
      } else if (key < previous) {
        issues.add(
          "MEMBERS_NOT_CANONICAL",
          securityPath,
          "Members are sorted by symbol, then exchange.",
        );
      }
    }
    previous = key;
    validateBuyWindow(
      member.buyWindow,
      childPath(memberPath, "buyWindow"),
      issues,
    );
  });
}

function validateBuyWindow(
  buyWindow: unknown,
  path: string,
  issues: IssueCollector,
): void {
  if (!isRecord(buyWindow)) {
    issues.add("BUY_WINDOW_INVALID", path, "A member states its buy window.");
    return;
  }
  if (buyWindow.mode === "FULL") {
    rejectUnknownKeys(buyWindow, ["mode"], path, issues);
    return;
  }
  if (buyWindow.mode !== "CUSTOM") {
    issues.add(
      "BUY_WINDOW_INVALID",
      childPath(path, "mode"),
      "A buy window is `FULL` or `CUSTOM`.",
    );
    return;
  }
  rejectUnknownKeys(buyWindow, ["mode", "ranges"], path, issues);
  const ranges = buyWindow.ranges;
  if (!Array.isArray(ranges) || ranges.length === 0) {
    issues.add(
      "BUY_WINDOW_INVALID",
      childPath(path, "ranges"),
      "A CUSTOM buy window has at least one range.",
    );
    return;
  }
  if (ranges.length > BUY_WINDOW_MAX_RANGES) {
    issues.add(
      "BUY_WINDOW_INVALID",
      childPath(path, "ranges"),
      `A buy window has at most ${BUY_WINDOW_MAX_RANGES} ranges.`,
    );
    return;
  }
  const shaped: { startDate: string; endDate: string | null }[] = [];
  for (const [index, range] of ranges.entries()) {
    const rangePath = childPath(childPath(path, "ranges"), index);
    if (!isRecord(range)) {
      issues.add("BUY_WINDOW_INVALID", rangePath, "A range is an object.");
      return;
    }
    rejectUnknownKeys(range, ["startDate", "endDate"], rangePath, issues);
    if (
      typeof range.startDate !== "string" ||
      !(range.endDate === null || typeof range.endDate === "string")
    ) {
      issues.add(
        "BUY_WINDOW_INVALID",
        rangePath,
        "A range has a start date and an end date or null.",
      );
      return;
    }
    shaped.push({ startDate: range.startDate, endDate: range.endDate });
  }
  let normalized: { startDate: string; endDate: string | null }[];
  try {
    normalized = normalizeBuyWindowRanges(shaped);
  } catch (error) {
    if (error instanceof BuyWindowValidationError) {
      issues.add(
        "BUY_WINDOW_INVALID",
        childPath(path, "ranges"),
        error.message,
      );
      return;
    }
    throw error;
  }
  const canonical =
    normalized.length === shaped.length &&
    normalized.every(
      (range, index) =>
        range.startDate === shaped[index]?.startDate &&
        range.endDate === shaped[index]?.endDate,
    );
  if (!canonical) {
    issues.add(
      "BUY_WINDOW_NOT_CANONICAL",
      childPath(path, "ranges"),
      "Ranges are sorted, non-overlapping and non-adjacent, with at most one open-ended range, last.",
    );
  }
}

function validateIndexMembership(
  membership: Record<string, unknown>,
  path: string,
  issues: IssueCollector,
): void {
  rejectUnknownKeys(
    membership,
    ["kind", "index", "universe", "membershipFloor", "period", "membership"],
    path,
    issues,
  );
  const index = membership.index;
  if (!isMarketIndexKey(index)) {
    issues.add(
      "INDEX_UNIVERSE_UNSUPPORTED",
      childPath(path, "index"),
      "No point-in-time universe is defined for this index.",
    );
    return;
  }
  const universe = pointInTimeIndexUniverse(index);
  if (membership.universe !== universe.listSystemKey) {
    issues.add(
      "INDEX_UNIVERSE_UNSUPPORTED",
      childPath(path, "universe"),
      `The ${universe.indexName} universe is \`${universe.listSystemKey}\`.`,
    );
  }
  if (membership.membershipFloor !== universe.membershipFloor) {
    issues.add(
      "INDEX_UNIVERSE_UNSUPPORTED",
      childPath(path, "membershipFloor"),
      `The ${universe.indexName} universe is projected from ${universe.membershipFloor}.`,
    );
  }
  if (membership.period !== undefined) {
    const period = membership.period;
    const periodPath = childPath(path, "period");
    if (!isRecord(period)) {
      issues.add(
        "SHAPE_INVALID",
        periodPath,
        "A period has a start and an end date.",
      );
    } else {
      rejectUnknownKeys(period, ["startDate", "endDate"], periodPath, issues);
      if (
        typeof period.startDate !== "string" ||
        typeof period.endDate !== "string" ||
        !DATE_PATTERN.test(period.startDate) ||
        !DATE_PATTERN.test(period.endDate) ||
        period.startDate > period.endDate
      ) {
        issues.add(
          "SHAPE_INVALID",
          periodPath,
          "A period is two YYYY-MM-DD dates, the start not after the end.",
        );
      }
    }
  }
  const pinned = membership.membership;
  const pinnedPath = childPath(path, "membership");
  if (!isRecord(pinned)) {
    issues.add("SHAPE_INVALID", pinnedPath, "A reference pins its membership.");
    return;
  }
  rejectUnknownKeys(
    pinned,
    ["digest", "securities", "windows", "peakSimultaneousMembers"],
    pinnedPath,
    issues,
  );
  if (
    typeof pinned.digest !== "string" ||
    !DIGEST_PATTERN.test(pinned.digest)
  ) {
    issues.add(
      "SHAPE_INVALID",
      childPath(pinnedPath, "digest"),
      "A pinned membership has a `sha256:` digest.",
    );
  }
  const count = (
    key: "securities" | "windows" | "peakSimultaneousMembers",
  ): number | undefined => {
    const value = pinned[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.add(
        "SHAPE_INVALID",
        childPath(pinnedPath, key),
        `\`${key}\` is a whole number.`,
      );
      return undefined;
    }
    return value;
  };
  const securities = count("securities");
  count("windows");
  const peak = count("peakSimultaneousMembers");
  if (securities !== undefined && peak !== undefined && peak > securities) {
    issues.add(
      "SHAPE_INVALID",
      childPath(pinnedPath, "peakSimultaneousMembers"),
      "No more members can be eligible at once than the membership holds.",
    );
  }
}
