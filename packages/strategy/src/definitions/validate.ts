/**
 * The one entry point that decides whether a JSON value is a canonical definition this build reads.
 */

import { validateHeader } from "./envelope.js";
import {
  isRecord,
  IssueCollector,
  type CanonicalDefinitionIssue,
} from "./issues.js";
import { validateListDocument } from "./list-codec.js";
import { validateStrategyDocument } from "./strategy-codec.js";
import type { CanonicalDefinitionDocument } from "./types.js";

export type DefinitionValidationResult =
  | { valid: true; document: CanonicalDefinitionDocument }
  | { valid: false; issues: readonly CanonicalDefinitionIssue[] };

/**
 * Every issue in a canonical Strategy or List document, structural and semantic, or the document
 * itself typed when there are none.
 *
 * Strict: an unknown format, schema version or type is refused before anything else is read, every
 * container has a closed key set, the Strategy logic is checked by the platform's own Strategy
 * validator, and a List's members and windows must already be in canonical order and form.
 */
export function validateDefinition(input: unknown): DefinitionValidationResult {
  const issues = new IssueCollector();
  if (!isRecord(input)) {
    issues.add("SHAPE_INVALID", "", "A definition must be a JSON object.");
    return { valid: false, issues: issues.issues };
  }
  const header = new IssueCollector();
  const type = validateHeader(input, header);
  if (type === undefined) {
    return { valid: false, issues: header.issues };
  }
  if (type === "strategy") {
    validateStrategyDocument(input, issues);
  } else {
    validateListDocument(input, issues);
  }
  return issues.empty
    ? { valid: true, document: input as CanonicalDefinitionDocument }
    : { valid: false, issues: issues.issues };
}
