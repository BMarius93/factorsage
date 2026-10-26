/**
 * The parts every canonical document shares: its header, its metadata and its provenance.
 */

import {
  childPath,
  isRecord,
  IssueCollector,
  rejectUnknownKeys,
} from "./issues.js";
import {
  CANONICAL_DEFINITION_FORMAT,
  CANONICAL_DEFINITION_SCHEMA_VERSION,
  CANONICAL_DEFINITION_TYPES,
  DEFINITION_ORIGINS,
  PROVENANCE_EVIDENCE,
  type CanonicalBuiltInReference,
  type CanonicalDefinitionType,
  type CanonicalProvenance,
} from "./types.js";

/**
 * Checks the header and answers which kind of document this is, or `undefined` when the header
 * alone already rules the document out.
 */
export function validateHeader(
  input: Record<string, unknown>,
  issues: IssueCollector,
): CanonicalDefinitionType | undefined {
  let ok = true;
  if (input.format !== CANONICAL_DEFINITION_FORMAT) {
    issues.add(
      "FORMAT_UNSUPPORTED",
      "format",
      `This is not a \`${CANONICAL_DEFINITION_FORMAT}\` document.`,
    );
    ok = false;
  }
  if (input.schemaVersion !== CANONICAL_DEFINITION_SCHEMA_VERSION) {
    issues.add(
      "SCHEMA_VERSION_UNSUPPORTED",
      "schemaVersion",
      typeof input.schemaVersion === "number"
        ? `Schema version ${input.schemaVersion} is not supported; this build reads version ${CANONICAL_DEFINITION_SCHEMA_VERSION}.`
        : "A definition names its schema version.",
    );
    ok = false;
  }
  const type = input.type;
  if (
    typeof type !== "string" ||
    !(CANONICAL_DEFINITION_TYPES as readonly string[]).includes(type)
  ) {
    issues.add(
      "TYPE_UNSUPPORTED",
      "type",
      "A definition is a `strategy` or a `list`.",
    );
    ok = false;
  }
  return ok ? (type as CanonicalDefinitionType) : undefined;
}

export function validateMetadata(
  metadata: unknown,
  path: string,
  issues: IssueCollector,
  limits: { nameMaxLength: number; descriptionMaxLength: number },
): void {
  if (!isRecord(metadata)) {
    issues.add("SHAPE_INVALID", path, "A definition carries its metadata.");
    return;
  }
  rejectUnknownKeys(metadata, ["name", "description"], path, issues);
  const name = metadata.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    issues.add(
      "SHAPE_INVALID",
      childPath(path, "name"),
      "A definition needs a name.",
    );
  } else if (name !== name.trim() || name.length > limits.nameMaxLength) {
    issues.add(
      "SHAPE_INVALID",
      childPath(path, "name"),
      `A name is trimmed and at most ${limits.nameMaxLength} characters.`,
    );
  }
  const description = metadata.description;
  if (description !== undefined) {
    if (
      typeof description !== "string" ||
      description.trim().length === 0 ||
      description !== description.trim() ||
      description.length > limits.descriptionMaxLength
    ) {
      issues.add(
        "SHAPE_INVALID",
        childPath(path, "description"),
        `A description, when present, is trimmed, non-empty and at most ${limits.descriptionMaxLength} characters.`,
      );
    }
  }
}

const BUILT_IN_REFERENCE_KEYS = ["systemKey", "name", "version", "premium"];

function validateBuiltInReference(
  reference: unknown,
  path: string,
  issues: IssueCollector,
  versioned: boolean,
): void {
  if (!isRecord(reference)) {
    issues.add(
      "PROVENANCE_INVALID",
      path,
      "A built-in is referenced as an object.",
    );
    return;
  }
  rejectUnknownKeys(reference, BUILT_IN_REFERENCE_KEYS, path, issues);
  if (
    typeof reference.systemKey !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reference.systemKey)
  ) {
    issues.add(
      "PROVENANCE_INVALID",
      childPath(path, "systemKey"),
      "A built-in is referenced by its systemKey.",
    );
  }
  if (
    typeof reference.name !== "string" ||
    reference.name.trim().length === 0
  ) {
    issues.add(
      "PROVENANCE_INVALID",
      childPath(path, "name"),
      "A built-in reference carries the built-in's name.",
    );
  }
  if (reference.version !== undefined) {
    if (
      !versioned ||
      typeof reference.version !== "number" ||
      !Number.isInteger(reference.version) ||
      reference.version < 1
    ) {
      issues.add(
        "PROVENANCE_INVALID",
        childPath(path, "version"),
        versioned
          ? "A built-in version is a positive whole number."
          : "Lists have no built-in version.",
      );
    }
  }
  if (reference.premium !== undefined && reference.premium !== true) {
    issues.add(
      "PROVENANCE_INVALID",
      childPath(path, "premium"),
      "`premium` is present only as `true`.",
    );
  }
}

export function validateProvenance(
  provenance: unknown,
  path: string,
  issues: IssueCollector,
  options: { versioned: boolean },
): void {
  if (!isRecord(provenance)) {
    issues.add(
      "PROVENANCE_INVALID",
      path,
      "A definition states its provenance.",
    );
    return;
  }
  const origin = provenance.origin;
  if (
    typeof origin !== "string" ||
    !(DEFINITION_ORIGINS as readonly string[]).includes(origin)
  ) {
    issues.add(
      "PROVENANCE_INVALID",
      childPath(path, "origin"),
      "Provenance is `built_in`, `custom`, `derived` or `unknown`.",
    );
    return;
  }
  if (origin === "unknown") {
    rejectUnknownKeys(provenance, ["origin"], path, issues);
    return;
  }
  const evidence = provenance.evidence;
  if (
    typeof evidence !== "string" ||
    !(PROVENANCE_EVIDENCE as readonly string[]).includes(evidence)
  ) {
    issues.add(
      "PROVENANCE_INVALID",
      childPath(path, "evidence"),
      "A provenance claim names the evidence it rests on.",
    );
  }
  if (origin === "custom") {
    rejectUnknownKeys(provenance, ["origin", "evidence"], path, issues);
    return;
  }
  const referenceKey = origin === "built_in" ? "builtIn" : "derivedFrom";
  rejectUnknownKeys(
    provenance,
    ["origin", "evidence", referenceKey],
    path,
    issues,
  );
  validateBuiltInReference(
    provenance[referenceKey],
    childPath(path, referenceKey),
    issues,
    options.versioned,
  );
}

/** Provenance with its fields in canonical order and nothing else. */
export function canonicalProvenance(
  provenance: CanonicalProvenance,
): CanonicalProvenance {
  const reference = (
    input: CanonicalBuiltInReference,
  ): CanonicalBuiltInReference => ({
    systemKey: input.systemKey,
    name: input.name,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.premium ? { premium: true as const } : {}),
  });
  switch (provenance.origin) {
    case "built_in":
      return {
        origin: "built_in",
        evidence: provenance.evidence,
        builtIn: reference(provenance.builtIn),
      };
    case "derived":
      return {
        origin: "derived",
        evidence: provenance.evidence,
        derivedFrom: reference(provenance.derivedFrom),
      };
    case "custom":
      return { origin: "custom", evidence: provenance.evidence };
    case "unknown":
      return { origin: "unknown" };
  }
}
