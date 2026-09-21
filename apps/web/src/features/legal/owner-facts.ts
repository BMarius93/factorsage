import { LEGAL_OWNER_FACTS, type LegalOwnerFactId } from "@intrinsic/contracts";

/**
 * The operator facts a public legal page renders, resolved from build-time configuration.
 *
 * **Why they are read literally.** `next build` inlines `process.env.NEXT_PUBLIC_*` only where it
 * can see the property name in the source, so `process.env[fact.envVariable]` would compile to
 * `undefined` in the browser and every page would silently show a placeholder in production. The
 * map below therefore spells each variable out.
 *
 * That duplication is held to the registry two ways rather than by review: the map is typed as a
 * total `Record<LegalOwnerFactId, …>`, so a fact added to the registry without an entry here is a
 * **compile error**, and each entry carries the variable name it read, which `owner-facts.test.ts`
 * compares with the registry's — so an entry that reads the wrong variable is a test failure.
 *
 * **Why none of them is committed.** This repository is public. Committing the operator's real
 * name, address, identifiers or mailboxes would publish them; inventing plausible ones would be
 * worse. So the repository ships them unresolved, a page renders a visible draft marker in their
 * place, and a release build refuses to compile while one is missing
 * (`lib/legal-release.ts`).
 */
type ResolvedFact = {
  /** The variable this entry reads, spelled the same way the literal access below does. */
  readonly variable: string;
  readonly value: string | undefined;
};

export const RESOLVED_OWNER_FACT_SOURCES: Readonly<
  Record<LegalOwnerFactId, ResolvedFact>
> = {
  LEGAL_ENTITY_NAME: {
    variable: "NEXT_PUBLIC_LEGAL_ENTITY_NAME",
    value: process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME,
  },
  REGISTERED_ADDRESS: {
    variable: "NEXT_PUBLIC_LEGAL_REGISTERED_ADDRESS",
    value: process.env.NEXT_PUBLIC_LEGAL_REGISTERED_ADDRESS,
  },
  REGISTRATION_IDENTIFIER: {
    variable: "NEXT_PUBLIC_LEGAL_REGISTRATION_IDENTIFIER",
    value: process.env.NEXT_PUBLIC_LEGAL_REGISTRATION_IDENTIFIER,
  },
  TAX_IDENTIFIER: {
    variable: "NEXT_PUBLIC_LEGAL_TAX_IDENTIFIER",
    value: process.env.NEXT_PUBLIC_LEGAL_TAX_IDENTIFIER,
  },
  SUPPORT_CONTACT: {
    variable: "NEXT_PUBLIC_LEGAL_SUPPORT_CONTACT",
    value: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_CONTACT,
  },
  PRIVACY_CONTACT: {
    variable: "NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT",
    value: process.env.NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT,
  },
  COMPLAINTS_CONTACT: {
    variable: "NEXT_PUBLIC_LEGAL_COMPLAINTS_CONTACT",
    value: process.env.NEXT_PUBLIC_LEGAL_COMPLAINTS_CONTACT,
  },
  SUPERVISORY_AUTHORITY: {
    variable: "NEXT_PUBLIC_LEGAL_SUPERVISORY_AUTHORITY",
    value: process.env.NEXT_PUBLIC_LEGAL_SUPERVISORY_AUTHORITY,
  },
  GOVERNING_LAW: {
    variable: "NEXT_PUBLIC_LEGAL_GOVERNING_LAW",
    value: process.env.NEXT_PUBLIC_LEGAL_GOVERNING_LAW,
  },
  ADR_INFORMATION: {
    variable: "NEXT_PUBLIC_LEGAL_ADR_INFORMATION",
    value: process.env.NEXT_PUBLIC_LEGAL_ADR_INFORMATION,
  },
};

/** The value an operator supplied for a fact, or `undefined` while it is unresolved. */
export function ownerFact(id: LegalOwnerFactId): string | undefined {
  const value = RESOLVED_OWNER_FACT_SOURCES[id].value?.trim();
  return value ? value : undefined;
}

/** One run of document text: either literal words, or a placeholder in place of a missing fact. */
export type LegalTextRun =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "fact";
      readonly id: LegalOwnerFactId;
      /** Present once the operator has supplied it. */
      readonly value: string | undefined;
    };

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

/**
 * Splits a paragraph into literal text and owner-fact runs.
 *
 * A resolved fact renders as its value, inline and unremarkable. An unresolved one renders as a
 * visible marker naming the fact and the owner-input entry that owns it, so a reviewer reading
 * the page sees exactly what is missing rather than a sentence with a hole in it — and nobody can
 * mistake a draft page for a published one.
 */
export function legalTextRuns(paragraph: string): readonly LegalTextRun[] {
  const runs: LegalTextRun[] = [];
  let cursor = 0;

  for (const match of paragraph.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      runs.push({ kind: "text", value: paragraph.slice(cursor, start) });
    }
    const id = match[1] as LegalOwnerFactId;
    if (id in LEGAL_OWNER_FACTS) {
      runs.push({ kind: "fact", id, value: ownerFact(id) });
    } else {
      // An unknown placeholder is a typo in the copy, not a fact. Render it verbatim so it is
      // obvious on the page rather than silently disappearing.
      runs.push({ kind: "text", value: match[0] });
    }
    cursor = start + match[0].length;
  }

  if (cursor < paragraph.length) {
    runs.push({ kind: "text", value: paragraph.slice(cursor) });
  }
  return runs;
}
