/**
 * Legal, privacy and consumer-protection contracts — the pure half.
 *
 * `docs/legal/implementation-spec.md` is the specification this file carries, and
 * `docs/legal/owner-inputs-and-review.md` is the register of facts nobody in this repository is
 * allowed to invent. Everything below is pure: no I/O, no clock, no database, no `process.env`.
 * That is what lets the API, the web application and the release-readiness check share one answer
 * to "which document version is required", "which storage is optional" and "which owner facts are
 * still missing" instead of three.
 *
 * **Three statuses are kept apart throughout, exactly as the specification requires.**
 *
 * - *Verified current fact* — something this repository can prove, such as the storage keys the
 *   application actually writes.
 * - *Proposed behaviour* — implemented mechanics whose wording is not approved. Everything in
 *   `legal-documents.ts` is currently in this state and is marked `DRAFT`.
 * - *Owner or legal decision outstanding* — an `OwnerInputId` below. It is never guessed, never
 *   defaulted to something plausible, and never allowed into a release build unresolved.
 *
 * **Nothing here claims a disclaimer removes liability or regulatory obligation.** The copy limits
 * liability only to the extent applicable law permits and says so in terms.
 */

// ---------------------------------------------------------------------------
// Owner inputs still outstanding
// ---------------------------------------------------------------------------

/**
 * The identifiers used by `docs/legal/owner-inputs-and-review.md`.
 *
 * Every placeholder in the draft copy points at one of these, so "what is still missing, and who
 * owns it" is answerable from the code rather than only from a document.
 */
export const OWNER_INPUT_IDS = [
  "O1",
  "O2",
  "O3",
  "O4",
  "O5",
  "O6",
  "O7",
  "O8",
  "O9",
  "O10",
  "O11",
  "O12",
] as const;

export type OwnerInputId = (typeof OWNER_INPUT_IDS)[number];

/**
 * One fact about the operator that the product cannot invent.
 *
 * A fact is resolved by deployment configuration, never by a value committed here: the repository
 * is public, and `docs/legal/copilot-handoff.md` forbids publishing the owner's real identity,
 * address or contact details into it. Unresolved, a fact renders as a visible draft marker; a
 * release build refuses to compile while a `requiredForRelease` fact is unresolved.
 */
export type LegalOwnerFact = {
  readonly id: LegalOwnerFactId;
  /** Short human label, used in the draft marker and in the readiness report. */
  readonly label: string;
  /**
   * The browser-visible environment variable that resolves it. Inlined by `next build`, so a
   * release carries whatever was present at build time and nothing at runtime can change it.
   */
  readonly envVariable: string;
  /** The owner-input register entry that owns it. */
  readonly ownerInput: OwnerInputId;
  /** Whether a public release may ship without it. */
  readonly requiredForRelease: boolean;
};

export const LEGAL_OWNER_FACT_IDS = [
  "LEGAL_ENTITY_NAME",
  "REGISTERED_ADDRESS",
  "REGISTRATION_IDENTIFIER",
  "TAX_IDENTIFIER",
  "SUPPORT_CONTACT",
  "PRIVACY_CONTACT",
  "COMPLAINTS_CONTACT",
  "SUPERVISORY_AUTHORITY",
  "GOVERNING_LAW",
  "ADR_INFORMATION",
] as const;

export type LegalOwnerFactId = (typeof LEGAL_OWNER_FACT_IDS)[number];

/**
 * Every operator fact the public pages reference, and what still blocks each one.
 *
 * `requiredForRelease` is `true` for everything an operator must publish before selling to
 * consumers in the EEA: who is contracting, where they are, how to reach them, and where to
 * complain. `GOVERNING_LAW` and `ADR_INFORMATION` are also required because publishing a paid
 * service without them is what the Consumer Rights and E-commerce directives are about.
 */
export const LEGAL_OWNER_FACTS: Readonly<
  Record<LegalOwnerFactId, LegalOwnerFact>
> = {
  LEGAL_ENTITY_NAME: {
    id: "LEGAL_ENTITY_NAME",
    label: "Contracting legal entity",
    envVariable: "NEXT_PUBLIC_LEGAL_ENTITY_NAME",
    ownerInput: "O1",
    requiredForRelease: true,
  },
  REGISTERED_ADDRESS: {
    id: "REGISTERED_ADDRESS",
    label: "Registered address",
    envVariable: "NEXT_PUBLIC_LEGAL_REGISTERED_ADDRESS",
    ownerInput: "O1",
    requiredForRelease: true,
  },
  REGISTRATION_IDENTIFIER: {
    id: "REGISTRATION_IDENTIFIER",
    label: "Company registration identifier",
    envVariable: "NEXT_PUBLIC_LEGAL_REGISTRATION_IDENTIFIER",
    ownerInput: "O1",
    requiredForRelease: true,
  },
  TAX_IDENTIFIER: {
    id: "TAX_IDENTIFIER",
    label: "Tax identification",
    envVariable: "NEXT_PUBLIC_LEGAL_TAX_IDENTIFIER",
    ownerInput: "O8",
    requiredForRelease: true,
  },
  SUPPORT_CONTACT: {
    id: "SUPPORT_CONTACT",
    label: "Monitored support contact",
    envVariable: "NEXT_PUBLIC_LEGAL_SUPPORT_CONTACT",
    ownerInput: "O2",
    requiredForRelease: true,
  },
  PRIVACY_CONTACT: {
    id: "PRIVACY_CONTACT",
    label: "Monitored privacy contact",
    envVariable: "NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT",
    ownerInput: "O2",
    requiredForRelease: true,
  },
  COMPLAINTS_CONTACT: {
    id: "COMPLAINTS_CONTACT",
    label: "Complaints contact",
    envVariable: "NEXT_PUBLIC_LEGAL_COMPLAINTS_CONTACT",
    ownerInput: "O2",
    requiredForRelease: true,
  },
  SUPERVISORY_AUTHORITY: {
    id: "SUPERVISORY_AUTHORITY",
    label: "Data-protection supervisory authority",
    envVariable: "NEXT_PUBLIC_LEGAL_SUPERVISORY_AUTHORITY",
    ownerInput: "O3",
    requiredForRelease: true,
  },
  GOVERNING_LAW: {
    id: "GOVERNING_LAW",
    label: "Governing law and jurisdiction",
    envVariable: "NEXT_PUBLIC_LEGAL_GOVERNING_LAW",
    ownerInput: "O9",
    requiredForRelease: true,
  },
  ADR_INFORMATION: {
    id: "ADR_INFORMATION",
    label: "Alternative dispute resolution information",
    envVariable: "NEXT_PUBLIC_LEGAL_ADR_INFORMATION",
    ownerInput: "O12",
    requiredForRelease: true,
  },
};

export const LEGAL_OWNER_FACT_LIST: readonly LegalOwnerFact[] =
  LEGAL_OWNER_FACT_IDS.map((id) => LEGAL_OWNER_FACTS[id]);

/**
 * Owner facts appear in document text as `{{FACT_ID}}`.
 *
 * The template is what is hashed and what an acceptance event resolves to, so a fact is
 * substituted at render time and never baked into the stored text. Resolving a fact therefore
 * changes what a reader sees, which is why publishing approved copy requires a version bump —
 * `LEGAL_DOCUMENT_STATUSES` below.
 */
const FACT_PLACEHOLDER_PATTERN = /\{\{([A-Z_]+)\}\}/g;

/** Every owner fact a piece of document text refers to, in order of first appearance. */
export function legalFactsReferencedBy(
  text: string,
): readonly LegalOwnerFactId[] {
  const found: LegalOwnerFactId[] = [];
  for (const match of text.matchAll(FACT_PLACEHOLDER_PATTERN)) {
    const id = match[1] as LegalOwnerFactId;
    if (LEGAL_OWNER_FACT_IDS.includes(id) && !found.includes(id)) {
      found.push(id);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * The public legal documents. Each has exactly one canonical route; there is no second copy of a
 * subject anywhere in the product.
 */
export const LEGAL_DOCUMENT_KINDS = [
  "TERMS",
  "PRIVACY",
  "COOKIES",
  "RISK_DISCLOSURE",
  "CANCELLATION_AND_REFUNDS",
  "CONTACT",
] as const;

export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

/**
 * Whether a document's wording has been through owner and counsel review.
 *
 * `DRAFT` is not a soft warning: a draft document renders a visible preview banner, and
 * `legalReleaseReadiness` refuses a public release while one exists. Nothing in this repository
 * may move a document to `APPROVED` on its own initiative — that is `O9`, `O7`, `O10` and `O12`.
 */
export const LEGAL_DOCUMENT_STATUSES = ["DRAFT", "APPROVED"] as const;

export type LegalDocumentStatus = (typeof LEGAL_DOCUMENT_STATUSES)[number];

/** One block of a document. `list` renders as an unordered list, one entry per paragraph. */
export type LegalDocumentSection = {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly list?: readonly string[];
  /**
   * What is still unresolved in this section, if anything. Rendered inline as an explicit review
   * marker so a reviewer sees the gap on the page rather than only in a checklist.
   */
  readonly pending?: {
    readonly ownerInput: OwnerInputId;
    readonly note: string;
  };
};

export type LegalDocument = {
  readonly kind: LegalDocumentKind;
  readonly route: string;
  readonly title: string;
  /** Short sentence under the title. Not part of the hashed body. */
  readonly summary: string;
  /**
   * Immutable version identifier. Changing any hashed text without changing this is a test
   * failure, which is what makes "an acceptance event resolves to the exact accepted text" true.
   */
  readonly version: string;
  /** ISO date the version takes effect. Draft versions carry the date they were drafted. */
  readonly effectiveDate: string;
  readonly status: LegalDocumentStatus;
  readonly sections: readonly LegalDocumentSection[];
  /**
   * SHA-256, lowercase hex, of `canonicalLegalDocumentText(document)`.
   *
   * Stored on every acceptance event. Pinned by `legal-documents.test.ts`, so editing the copy
   * without bumping the version and the digest fails the build rather than silently changing what
   * past users are recorded as having accepted.
   */
  readonly contentHash: string;
};

/**
 * The exact bytes a document's hash covers, and the only definition of "the document text".
 *
 * Deliberately excludes the title, the summary, the route and the status: those are presentation
 * and lifecycle, and changing a page's subtitle must not invalidate an acceptance record. It
 * includes the kind and the version, so two documents can never hash alike, and every heading,
 * paragraph, list entry and pending marker in order.
 */
export function canonicalLegalDocumentText(
  document: Pick<LegalDocument, "kind" | "version" | "sections">,
): string {
  const lines: string[] = [`${document.kind}@${document.version}`];
  for (const section of document.sections) {
    lines.push(`## ${section.id} ${section.heading}`);
    for (const paragraph of section.paragraphs) {
      lines.push(paragraph);
    }
    for (const entry of section.list ?? []) {
      lines.push(`- ${entry}`);
    }
    if (section.pending) {
      lines.push(`! ${section.pending.ownerInput} ${section.pending.note}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/**
 * What a recorded legal event actually is.
 *
 * Kept apart on purpose: accepting the Terms is contractual acceptance, and being shown the
 * Privacy Policy is information. Recording the second as the first would misrepresent a notice as
 * a blanket consent to every processing purpose, which is exactly what the specification and the
 * EDPB consent guidance forbid.
 */
export const LEGAL_RECORD_KINDS = ["ACCEPTED", "NOTICE_PRESENTED"] as const;

export type LegalRecordKind = (typeof LEGAL_RECORD_KINDS)[number];

/**
 * Where an acceptance was given. Decided server-side from persisted state, never submitted by a
 * client: the surface is evidence, and evidence a caller can choose is not evidence.
 */
export const LEGAL_ACCEPTANCE_SURFACES = [
  /** The holder of an activation link chose a password and accepted, in one transaction. */
  "EMAIL_ACTIVATION",
  /** A Google identity signed in, had no acceptance, and completed legal onboarding. */
  "GOOGLE_ONBOARDING",
  /** An account that already existed accepted a required version. */
  "EXISTING_ACCOUNT",
] as const;

export type LegalAcceptanceSurface = (typeof LEGAL_ACCEPTANCE_SURFACES)[number];

/**
 * The Terms version a session must have accepted to use the product.
 *
 * Deliberately a separate constant from `TERMS_DOCUMENT.version`. A typo fix or a Privacy Policy
 * update bumps a document's own version without moving this, so it does not force every customer
 * through an acceptance screen; only a **material** change moves this one, which is the explicit
 * required-version policy the specification asks for.
 */
export const REQUIRED_TERMS_VERSION = "0.1.0-draft";

/**
 * What one acceptance action records.
 *
 * The Risk Disclosure is recorded as accepted alongside the Terms because the Terms say it forms
 * part of them; recording it separately is what makes that claim auditable. The Privacy Policy is
 * recorded as presented, never as accepted.
 */
export const LEGAL_ACCEPTANCE_BUNDLE: readonly {
  readonly kind: LegalDocumentKind;
  readonly record: LegalRecordKind;
}[] = [
  { kind: "TERMS", record: "ACCEPTED" },
  { kind: "RISK_DISCLOSURE", record: "ACCEPTED" },
  { kind: "PRIVACY", record: "NOTICE_PRESENTED" },
];

/**
 * `POST /legal/acceptance`.
 *
 * The version is required and is checked against `REQUIRED_TERMS_VERSION` server-side: a client
 * that omits it, sends `false`, sends an unknown value or sends a superseded one is refused, and
 * nothing is written. There is no boolean "I agree" field, because a boolean carries no evidence
 * of *what* was agreed to.
 */
export type LegalAcceptanceRequest = {
  readonly termsVersion: string;
};

/** One recorded event, as the owner of the account may read it back. */
export type LegalAcceptanceRecordView = {
  readonly documentKind: LegalDocumentKind;
  readonly documentVersion: string;
  readonly documentHash: string;
  readonly record: LegalRecordKind;
  readonly surface: LegalAcceptanceSurface;
  /** ISO 8601, server clock. */
  readonly recordedAt: string;
};

/**
 * `GET /legal/acceptance`.
 *
 * `outstanding` is the one field enforcement depends on, and the API decides it; the browser
 * renders it and never computes its own answer.
 */
export type LegalAcceptanceStatusResponse = {
  readonly requiredTermsVersion: string;
  readonly outstanding: boolean;
  readonly records: readonly LegalAcceptanceRecordView[];
};

export const LEGAL_ERROR_CODES = [
  /** A signed-in caller has not accepted the required Terms version. `403`. */
  "LEGAL_ACCEPTANCE_REQUIRED",
  /** The submitted version is not the one currently required. `400`; nothing is written. */
  "LEGAL_TERMS_VERSION_MISMATCH",
  /** A legal request could not be accepted as submitted. `400`. */
  "LEGAL_REQUEST_INVALID",
] as const;

export type LegalReasonCode = (typeof LEGAL_ERROR_CODES)[number];

export type LegalErrorDetail = {
  readonly code: LegalReasonCode;
  /** The version the server requires, when the failure is about one. */
  readonly requiredTermsVersion?: string;
};

/**
 * A legal-gate refusal.
 *
 * Carries a safe message and a stable code, exactly like `EntitlementError` and `BillingError`,
 * and never a request body, a document text or anything about another account.
 */
export class LegalError extends Error {
  readonly detail: LegalErrorDetail;

  constructor(message: string, detail: LegalErrorDetail) {
    super(message);
    this.name = "LegalError";
    this.detail = detail;
  }

  get code(): LegalReasonCode {
    return this.detail.code;
  }
}

export function isLegalError(value: unknown): value is LegalError {
  return value instanceof LegalError;
}

// ---------------------------------------------------------------------------
// Rights, withdrawal and support requests
// ---------------------------------------------------------------------------

/**
 * The request channels the product actually operates.
 *
 * Four kinds, kept apart because conflating them is the failure the specification is most
 * explicit about: cancelling a renewal is a billing action, statutory withdrawal is a consumer
 * right with its own period, a nonconformity claim survives that period, and a data-protection
 * request is a different law entirely.
 */
export const LEGAL_REQUEST_KINDS = [
  /** GDPR access, rectification, erasure, restriction, objection or portability. */
  "PRIVACY_REQUEST",
  /** Statutory right of withdrawal from a distance contract, where it applies. */
  "WITHDRAWAL",
  /** The service does not conform to the contract or to applicable legal requirements. */
  "NONCONFORMITY",
  /** Anything else the operator must answer, including complaints. */
  "SUPPORT",
] as const;

export type LegalRequestKind = (typeof LEGAL_REQUEST_KINDS)[number];

/**
 * What a submitted request is, and nothing more.
 *
 * `RECEIVED` is deliberately the only state this implementation writes. The product records that a
 * request arrived and acknowledges it; deciding it is operator work whose rules are `O7` and `O2`,
 * and a status of `RESOLVED` written by software nobody reviewed would be a statement about a
 * legal outcome that has not happened.
 */
export const LEGAL_REQUEST_STATUSES = ["RECEIVED"] as const;

export type LegalRequestStatus = (typeof LEGAL_REQUEST_STATUSES)[number];

/** Maximum length of the free-text detail on a request. Bounded input, not a product limit. */
export const LEGAL_REQUEST_DETAILS_MAX_LENGTH = 4000;

export type LegalRequestSubmission = {
  readonly kind: LegalRequestKind;
  /** What the person is asking for, in their own words. */
  readonly details: string;
};

/**
 * The durable receipt for one submitted request.
 *
 * It is an acknowledgment of receipt and says so: it is never a statement that a refund has been
 * made, that data has been erased, or that a withdrawal has been accepted. `reference` is what a
 * person quotes when they follow up.
 */
export type LegalRequestReceipt = {
  readonly reference: string;
  readonly kind: LegalRequestKind;
  readonly status: LegalRequestStatus;
  readonly details: string;
  /** ISO 8601, server clock — the submission time the receipt attests to. */
  readonly submittedAt: string;
};

export type LegalRequestListResponse = {
  readonly requests: readonly LegalRequestReceipt[];
};

// ---------------------------------------------------------------------------
// Browser storage inventory and consent
// ---------------------------------------------------------------------------

/**
 * Storage categories, as the ePrivacy Directive article 5(3) exemption actually divides them.
 *
 * `NECESSARY` means strictly necessary to provide the service the user explicitly requested —
 * not "useful", not "first-party", and not "we would rather not ask". Everything else is
 * `PREFERENCES` and needs consent before it is read or written.
 */
export const STORAGE_CATEGORIES = [
  "NECESSARY",
  "PREFERENCES",
  /**
   * Storage a third party sets on its own origin, under its own policy. Listed for honesty and
   * deliberately **not** claimed to be governed by the local control.
   */
  "OUT_OF_SCOPE",
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export type StorageMechanism =
  "COOKIE" | "LOCAL_STORAGE" | "SESSION_STORAGE" | "THIRD_PARTY_PAGE";

/**
 * One entry of the verified browser-storage inventory.
 *
 * `evidence` names where the claim comes from — a source file, or the runtime inspection recorded
 * in `docs/legal/storage-inventory.md`. An entry with no evidence is a guess, and a guess in a
 * cookie policy is a misstatement.
 */
export type StorageInventoryEntry = {
  readonly id: string;
  readonly name: string;
  readonly mechanism: StorageMechanism;
  readonly provider: string;
  readonly purpose: string;
  readonly trigger: string;
  readonly duration: string;
  readonly category: StorageCategory;
  readonly evidence: string;
};

/**
 * Everything this application stores in, or reads from, a visitor's browser.
 *
 * Verified by inspecting the running application rather than by searching the source alone —
 * `docs/legal/storage-inventory.md` records the method and the observations. Two consequences the
 * specification asks to be honest about:
 *
 * - the guest recent-securities key is **not** declared strictly necessary. It is a convenience
 *   that makes a dropdown nicer; the product works without it, so it is a preference and is gated;
 * - Stripe Checkout and Google's sign-in pages run on their own origins under their own policies.
 *   They are listed so the boundary is visible, and the local control explicitly does not claim to
 *   govern them.
 */
export const STORAGE_INVENTORY: readonly StorageInventoryEntry[] = [
  {
    id: "auth-session",
    name: "Configured authentication cookie (default `intrinsic_auth`)",
    mechanism: "COOKIE",
    provider: "FactorSage",
    purpose:
      "Keeps a signed-in session authenticated. HttpOnly, SameSite=Lax, Secure in production.",
    trigger: "Signing in with a password or with Google.",
    duration:
      "The configured session lifetime (AUTH_TOKEN_TTL_SECONDS, 8 hours by default).",
    category: "NECESSARY",
    evidence: "apps/api/src/auth/auth-cookie.ts; packages/config/src/index.ts",
  },
  {
    id: "oauth-transaction",
    name: "Authentication cookie name with the `_oauth_tx` suffix",
    mechanism: "COOKIE",
    provider: "FactorSage",
    purpose:
      "Binds one Google sign-in attempt to this browser (anti-CSRF state, PKCE verifier, OIDC nonce).",
    trigger: "Starting a Google sign-in. Not written otherwise.",
    duration: "10 minutes, and cleared at the callback whatever its outcome.",
    category: "NECESSARY",
    evidence:
      "apps/api/src/auth/auth-cookie.ts; apps/api/src/auth/auth.controller.ts",
  },
  {
    id: "storage-consent",
    name: "`factorsage.storage-consent.v1` (localStorage)",
    mechanism: "LOCAL_STORAGE",
    provider: "FactorSage",
    purpose:
      "Remembers the storage choice you made, so you are not asked again and the choice is honoured.",
    trigger: "Choosing Accept, Reject or a custom selection.",
    duration:
      "Until you change it or clear this browser's site data. No automatic expiry is claimed; see O6.",
    category: "NECESSARY",
    evidence: "apps/web/src/features/legal/consent/storage-consent.ts",
  },
  {
    id: "guest-recent-securities",
    name: "`factorsage.recent-securities.v1` (localStorage)",
    mechanism: "LOCAL_STORAGE",
    provider: "FactorSage",
    purpose:
      "Remembers which securities a signed-out visitor viewed, so the search box can offer them again. Only catalog ids are stored.",
    trigger:
      "Opening a Stock Details page while signed out, and only once optional storage is allowed.",
    duration:
      "Until you withdraw permission or clear this browser's site data; the newest 10 ids at most.",
    category: "PREFERENCES",
    evidence:
      "apps/web/src/features/stocks/recent/utils/guest-recent-securities.ts",
  },
  {
    id: "stripe-checkout",
    name: "Cookies set by Stripe on checkout.stripe.com",
    mechanism: "THIRD_PARTY_PAGE",
    provider: "Stripe",
    purpose:
      "Operating and securing Stripe's own hosted payment page. FactorSage embeds no Stripe script and sets none of these cookies.",
    trigger:
      "Being redirected to Stripe Checkout or the Stripe Customer Portal.",
    duration: "Set and controlled by Stripe on its own domain.",
    category: "OUT_OF_SCOPE",
    evidence:
      "apps/api/src/billing/stripe.gateway.ts (hosted redirect only); no Stripe SDK in apps/web",
  },
  {
    id: "google-sign-in",
    name: "Cookies set by Google on accounts.google.com",
    mechanism: "THIRD_PARTY_PAGE",
    provider: "Google",
    purpose:
      "Operating and securing Google's own sign-in page. FactorSage loads no Google script and sets none of these cookies.",
    trigger: "Choosing Continue with Google and being redirected to Google.",
    duration: "Set and controlled by Google on its own domain.",
    category: "OUT_OF_SCOPE",
    evidence:
      "apps/api/src/auth/auth.controller.ts (server-side redirect); no Google script in apps/web",
  },
];

/** The entries a local control can actually govern — first-party storage on this origin. */
export const FIRST_PARTY_STORAGE_INVENTORY: readonly StorageInventoryEntry[] =
  STORAGE_INVENTORY.filter((entry) => entry.mechanism !== "THIRD_PARTY_PAGE");

/**
 * Whether the verified inventory contains anything that needs consent.
 *
 * This is what decides whether a consent control is shown at all. If the product ever stops
 * writing optional storage, the control disappears rather than becoming a banner that asks for
 * permission it does not need — the specification forbids a fake Accept banner.
 */
export const OPTIONAL_STORAGE_EXISTS: boolean =
  FIRST_PARTY_STORAGE_INVENTORY.some(
    (entry) => entry.category === "PREFERENCES",
  );

/** The version of the consent question. A material change to the purposes invalidates a choice. */
export const STORAGE_CONSENT_VERSION = "1";

export const STORAGE_CONSENT_KEY = "factorsage.storage-consent.v1";

/** A visitor's recorded choice. `null` anywhere means "not decided", never "allowed". */
export type StorageConsentChoice = {
  readonly version: string;
  readonly preferences: boolean;
  /** ISO 8601, the browser's clock — this record never leaves the device. */
  readonly decidedAt: string;
};

// ---------------------------------------------------------------------------
// Reusable disclosure copy
// ---------------------------------------------------------------------------

/**
 * The short contextual disclosures, in one place.
 *
 * Every surface that needs one imports from here rather than writing its own sentence, which is
 * what stops four screens drifting into four slightly different claims about the same thing.
 *
 * Each is written against what the engine actually does: an ACTIVE signal may be latched rather
 * than newly fired, a pending setup is not a signal, a backtest includes only the costs its
 * methodology describes, and a valuation is a model output rather than a price.
 */
export const LEGAL_DISCLOSURES = {
  footer:
    "Research and simulation tools. Not investment advice. Data may contain errors or delays.",
  signals:
    "Signals reflect automated strategy conditions and lifecycle rules, not instructions to trade. An active signal may be latched from an earlier trigger, and a pending setup has not become a signal. Verify current market information before making an investment decision.",
  backtests:
    "Hypothetical historical results. They depend on the selected data, assumptions and simulation methodology, include only the costs that methodology describes, and do not represent actual trading performance. Past or simulated performance does not guarantee future returns.",
  valuations:
    "Model-based estimates, not guaranteed market prices or investment outcomes. Different assumptions and models produce different results.",
  marketData:
    "Market data comes from an external provider and may contain errors, omissions or delays. Displayed times describe the observation identified on this screen and are not a guarantee of an executable price.",
  subscription:
    "Subscriptions renew automatically until cancelled. Cancelling a renewal is not the same as a statutory withdrawal or a refund claim.",
} as const;

export type LegalDisclosureId = keyof typeof LEGAL_DISCLOSURES;

// ---------------------------------------------------------------------------
// Release readiness
// ---------------------------------------------------------------------------

export type LegalReadinessBlocker = {
  readonly kind: "OWNER_FACT" | "DRAFT_DOCUMENT";
  readonly subject: string;
  readonly ownerInput: OwnerInputId | null;
  readonly detail: string;
};

/**
 * Everything that still blocks publishing these pages, computed from the code rather than read
 * from a checklist.
 *
 * Used by the web release-build guard and by `pnpm legal:check`. It deliberately does **not** run
 * in development: a draft page must stay reviewable locally, and a check that broke `pnpm dev`
 * would be a check somebody switches off.
 */
export function legalReleaseReadiness(
  resolvedFacts: Readonly<
    Partial<Record<LegalOwnerFactId, string | undefined>>
  >,
  documents: readonly Pick<LegalDocument, "kind" | "version" | "status">[],
): readonly LegalReadinessBlocker[] {
  const blockers: LegalReadinessBlocker[] = [];

  for (const fact of LEGAL_OWNER_FACT_LIST) {
    if (!fact.requiredForRelease) {
      continue;
    }
    const value = resolvedFacts[fact.id]?.trim();
    if (!value) {
      blockers.push({
        kind: "OWNER_FACT",
        subject: fact.id,
        ownerInput: fact.ownerInput,
        detail: `${fact.label} is unresolved. Set ${fact.envVariable} at build time (owner input ${fact.ownerInput}).`,
      });
    }
  }

  for (const document of documents) {
    if (document.status !== "APPROVED") {
      blockers.push({
        kind: "DRAFT_DOCUMENT",
        subject: document.kind,
        ownerInput: null,
        detail: `${document.kind} ${document.version} is still DRAFT. Owner and counsel approval is required before it is published.`,
      });
    }
  }

  return blockers;
}
