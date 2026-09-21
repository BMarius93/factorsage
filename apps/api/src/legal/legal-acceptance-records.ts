import {
  LEGAL_ACCEPTANCE_BUNDLE,
  LegalError,
  legalDocument,
  REQUIRED_TERMS_VERSION,
  type LegalAcceptanceSurface,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";

/**
 * What an acceptance **is**, as pure functions.
 *
 * Deliberately not a Nest provider. Two callers need these — `LegalService`, and the email
 * activation path inside `RegistrationService` — and making the second inject the first would
 * put a dependency edge from `AuthModule` to `LegalModule` while `LegalModule` already depends on
 * `AuthModule` for `CookieAuthGuard`. That is a cycle dressed up as a `@Global` module, and it
 * breaks every suite that compiles `AuthModule` on its own.
 *
 * Neither function touches the database, the clock or a request, so there is nothing for
 * injection to provide.
 */

export const TERMS_VERSION_MISMATCH_MESSAGE =
  "The Terms of Service have changed. Reload the page and accept the current version.";

/**
 * Refuses anything but the currently required Terms version.
 *
 * Called before any write on every acceptance path, including the one inside the email
 * activation transaction. A missing, false, unknown or superseded version is a `400` and nothing
 * is written — which, on the activation path, means the account is not activated either, because
 * the whole thing is one transaction.
 */
export function assertRequiredTermsVersion(submitted: unknown): void {
  if (typeof submitted !== "string" || submitted !== REQUIRED_TERMS_VERSION) {
    throw new LegalError(TERMS_VERSION_MISMATCH_MESSAGE, {
      code: "LEGAL_TERMS_VERSION_MISMATCH",
      requiredTermsVersion: REQUIRED_TERMS_VERSION,
    });
  }
}

/**
 * The rows one acceptance action writes.
 *
 * Three records, and the distinction between them is the point: the Terms and the Risk
 * Disclosure are **accepted** (the Terms say the Risk Disclosure forms part of them, and
 * recording it separately is what makes that auditable), while the Privacy Policy is recorded as
 * **presented**. A privacy notice is information; recording it as an acceptance would
 * misrepresent it as a blanket consent to every processing purpose.
 *
 * Every row carries the digest of the exact text of that version, so the event resolves to what
 * was actually shown even after the copy moves on.
 */
export function acceptanceRows(input: {
  userId: string;
  surface: LegalAcceptanceSurface;
}): Prisma.LegalRecordCreateManyInput[] {
  return LEGAL_ACCEPTANCE_BUNDLE.map(({ kind, record }) => {
    const document = legalDocument(kind);
    if (!document.contentHash) {
      // Unreachable while `legal-documents.test.ts` passes. An acceptance that cannot resolve to
      // a text is not evidence of anything, so it is refused rather than written empty.
      throw new Error(
        `Legal document ${kind}@${document.version} has no content digest; run \`pnpm legal:hashes\`.`,
      );
    }
    return {
      userId: input.userId,
      documentKind: kind,
      documentVersion: document.version,
      documentHash: document.contentHash,
      record,
      surface: input.surface,
    };
  });
}
