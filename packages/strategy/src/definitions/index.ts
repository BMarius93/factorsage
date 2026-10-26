/**
 * The Canonical Definition Codec (`docs/decisions/canonical-definitions-v1.md`): a portable,
 * versioned JSON form of Strategies and Stock Lists, read and written losslessly, validated with
 * the platform's own rules, and described in deterministic English.
 */
export * from "./types.js";
export {
  CANONICAL_DEFINITION_ISSUE_CODES,
  CanonicalDefinitionError,
  type CanonicalDefinitionIssue,
  type CanonicalDefinitionIssueCode,
} from "./issues.js";
export {
  serializeStrategy,
  deserializeStrategy,
  strategyDefinitionOf,
  type SerializeStrategyInput,
  type DeserializeStrategyOptions,
  type DeserializedStrategy,
  type StrategyActorIdentity,
} from "./strategy-codec.js";
export {
  serializeList,
  deserializeList,
  canonicalMembersDigest,
  type ListMemberInput,
  type SerializeListInput,
  type DeserializeListOptions,
  type DeserializedList,
  type DeserializedListMember,
} from "./list-codec.js";
export {
  validateDefinition,
  type DefinitionValidationResult,
} from "./validate.js";
export { describeDefinition } from "./describe.js";
export {
  serializeSnapshotStrategy,
  serializeSnapshotList,
  snapshotListMembers,
  snapshotIndexMembershipResolver,
} from "./snapshot.js";
