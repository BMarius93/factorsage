import type {
  DefinitionDescriptionPublication,
  SharedDefinitionOrigin,
} from "@intrinsic/contracts";

/**
 * How a shared run's Strategy and List say where they come from
 * (`docs/decisions/canonical-definitions-v1.md`). One wording for the owner's Share dialog and the
 * public report, so the two can never describe the same origin differently.
 */

export type DefinitionKind = "strategy" | "list";

export function definitionKindLabel(kind: DefinitionKind): string {
  return kind === "strategy" ? "Strategy" : "List";
}

/**
 * The provenance line: `Built-in · Official FactorSage Strategy`, `Custom`,
 * `Derived from Value & Trend`. `Derived from …` names the built-in only because the API names it
 * only when its record of the copy is trustworthy; an origin nothing records says so plainly.
 */
export function definitionOriginLabel(
  kind: DefinitionKind,
  origin: SharedDefinitionOrigin,
  builtInName?: string,
): string {
  switch (origin) {
    case "built_in":
      return `Built-in · Official FactorSage ${definitionKindLabel(kind)}`;
    case "custom":
      return "Custom";
    case "derived":
      return builtInName
        ? `Derived from ${builtInName}`
        : "Derived from a built-in";
    case "unknown":
      return "Origin not recorded";
  }
}

/** What the owner is told about one definition's description, given their current choice. */
export function definitionPublicationText(
  kind: DefinitionKind,
  publication: DefinitionDescriptionPublication,
  publishDescriptions: boolean,
): string {
  switch (publication) {
    case "always":
      return "Its description is public: it is official FactorSage content.";
    case "opt_in":
      return publishDescriptions
        ? "Its description is published on the report."
        : "Its description stays private unless you publish it.";
    case "never":
      return kind === "strategy"
        ? "Its premium rules are never published."
        : "Its description is never published.";
  }
}

/** What a public reader is told when a description is not published. */
export function definitionWithheldText(
  kind: DefinitionKind,
  reason: "owner" | "premium",
): string {
  if (reason === "premium") {
    return "The rules of this premium FactorSage strategy are not published.";
  }
  return kind === "strategy"
    ? "The owner keeps this strategy's rules private."
    : "The owner keeps this list's composition private.";
}
