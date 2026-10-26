/**
 * Why a canonical definition could not be written, read or validated.
 *
 * Path-addressed and non-throwing at the validator, thrown as one {@link CanonicalDefinitionError}
 * by the codec: a definition the format cannot carry is refused naming what it is and where, never
 * shortened to something that can be carried.
 */

export const CANONICAL_DEFINITION_ISSUE_CODES = [
  /** Not the shape the format describes: a missing field, a wrong type, an empty name. */
  "SHAPE_INVALID",
  /** A field the format does not define. Refused, never dropped. */
  "UNKNOWN_FIELD",
  "FORMAT_UNSUPPORTED",
  "SCHEMA_VERSION_UNSUPPORTED",
  "TYPE_UNSUPPORTED",
  /** The Strategy logic breaks a Strategy rule; the message is the Strategy validator's own. */
  "STRATEGY_INVALID",
  /** A rule selects an actor whose portable identity was not supplied or cannot be resolved. */
  "ACTOR_UNRESOLVED",
  /** A legacy actor-group scope whose frozen membership was not supplied. */
  "ACTOR_GROUP_UNRESOLVED",
  /** The `actors` references do not describe exactly the actors the rules select. */
  "ACTOR_REFERENCES_INVALID",
  "SECURITY_INVALID",
  "SECURITY_DUPLICATE",
  /** A security reference no catalog row answers to. */
  "SECURITY_UNRESOLVED",
  "BUY_WINDOW_INVALID",
  /** Valid ranges in a form other than the canonical normalized one. */
  "BUY_WINDOW_NOT_CANONICAL",
  /** Members out of canonical order. */
  "MEMBERS_NOT_CANONICAL",
  /** A point-in-time universe this build does not define. */
  "INDEX_UNIVERSE_UNSUPPORTED",
  /** A pinned membership no source can supply. */
  "INDEX_MEMBERSHIP_UNAVAILABLE",
  /** A source supplied a membership whose digest or counts differ from the pinned one. */
  "INDEX_MEMBERSHIP_MISMATCH",
  "PROVENANCE_INVALID",
] as const;

export type CanonicalDefinitionIssueCode =
  (typeof CANONICAL_DEFINITION_ISSUE_CODES)[number];

export type CanonicalDefinitionIssue = {
  code: CanonicalDefinitionIssueCode;
  /** Where in the document, e.g. `definition.buyLevels[0].signal.conditions[1].metric`. */
  path: string;
  message: string;
};

export class CanonicalDefinitionError extends Error {
  readonly issues: readonly CanonicalDefinitionIssue[];

  constructor(issues: readonly CanonicalDefinitionIssue[]) {
    super(
      issues.length === 0
        ? "The definition is not valid"
        : issues
            .slice(0, 3)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ") +
            (issues.length > 3 ? ` (+${issues.length - 3} more)` : ""),
    );
    this.name = "CanonicalDefinitionError";
    this.issues = issues;
  }
}

/** Collects issues while a document is walked. */
export class IssueCollector {
  readonly issues: CanonicalDefinitionIssue[] = [];

  add(code: CanonicalDefinitionIssueCode, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }

  get empty(): boolean {
    return this.issues.length === 0;
  }

  throwIfAny(): void {
    if (!this.empty) {
      throw new CanonicalDefinitionError(this.issues);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuses every key outside `allowed`, so nothing a document carries is silently ignored. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: IssueCollector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add(
        "UNKNOWN_FIELD",
        path === "" ? key : `${path}.${key}`,
        `\`${key}\` is not a field of this definition format.`,
      );
    }
  }
}

export function childPath(path: string, key: string | number): string {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }
  return path === "" ? key : `${path}.${key}`;
}
