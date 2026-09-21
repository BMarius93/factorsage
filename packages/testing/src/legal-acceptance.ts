import {
  LEGAL_ACCEPTANCE_BUNDLE,
  legalDocument,
  type LegalAcceptanceSurface,
  type LegalDocumentKind,
  type LegalRecordKind,
} from "@intrinsic/contracts";

/**
 * Structurally what this needs from a Prisma client, so the helper stays in `@intrinsic/testing`
 * without that package taking a dependency on the database layer. The literal unions come from
 * `@intrinsic/contracts` and are the same strings the generated Prisma enums use, so a real
 * client satisfies this.
 */
export type LegalRecordWriter = {
  legalRecord: {
    createMany(args: {
      data: {
        userId: string;
        documentKind: LegalDocumentKind;
        documentVersion: string;
        documentHash: string;
        record: LegalRecordKind;
        surface: LegalAcceptanceSurface;
      }[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
};

/**
 * Records Terms acceptance for accounts a test created.
 *
 * ## Why a suite needs this
 *
 * Every mounted route is gated on the required Terms version
 * (`ai/architecture/legal-compliance.md`), so a user a suite inserts straight into the database
 * is in the same state as a brand-new Google account: authenticated, and refused `403
 * LEGAL_ACCEPTANCE_REQUIRED` on everything outside the allowlist. A suite about lists, monitors
 * or billing wants a customer who has accepted, because that is the customer whose behaviour it
 * is describing — so it says so here, in one line, rather than each suite hand-writing three
 * rows or, worse, the gate being weakened to let it pass.
 *
 * ## What it is not
 *
 * It is not a bypass. There is no flag, header, environment variable or route that skips the
 * gate; this writes the same rows `POST /legal/acceptance` writes, through the same bundle and
 * the same digests, and only for user ids the caller already owns. A suite that wants to observe
 * the gate simply does not call it — `apps/api/src/legal/legal-acceptance.integration.test.ts`
 * is the one that does.
 *
 * Idempotent, so a suite may call it again after re-creating a fixture.
 */
export async function acceptCurrentTermsForTestUsers(
  prisma: LegalRecordWriter,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  await prisma.legalRecord.createMany({
    data: userIds.flatMap((userId) =>
      LEGAL_ACCEPTANCE_BUNDLE.map(({ kind, record }) => ({
        userId,
        documentKind: kind,
        documentVersion: legalDocument(kind).version,
        documentHash: legalDocument(kind).contentHash,
        record,
        // Synthetic, and the honest label for it: these accounts existed before the suite
        // asked them to accept anything.
        surface: "EXISTING_ACCOUNT" as const,
      })),
    ),
    skipDuplicates: true,
  });
}

/**
 * The same, for a suite that knows its users only by email.
 *
 * Most integration suites insert with `createMany`, which returns no ids, so resolving them here
 * keeps the call one line at the point of use.
 */
export type LegalUserLookup = LegalRecordWriter & {
  user: {
    findMany(args: {
      where: { email: { in: string[] } };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
};

export async function acceptCurrentTermsByEmail(
  prisma: LegalUserLookup,
  emails: readonly string[],
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { in: [...emails] } },
    select: { id: true },
  });
  await acceptCurrentTermsForTestUsers(
    prisma,
    users.map((user) => user.id),
  );
}
