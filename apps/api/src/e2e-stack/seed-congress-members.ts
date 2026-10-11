import type { PrismaClient } from "@intrinsic/database";
import { CONGRESS_MEMBER_CATALOG_SYNC_ID } from "@intrinsic/stock-data";
import { QA_CONGRESS_MEMBER_LIST } from "@intrinsic/testing";

/**
 * The fictional members of Congress an E2E run can select: `pnpm test:securities:seed`.
 *
 * The hermetic stack ingests no disclosure, so without this the actor catalog a Strategy Builder
 * searches would be empty and the selection could only be tested against a mocked API. These are
 * catalog rows and nothing else — no trade is written, so a rule selecting one reads no activity,
 * which is all a builder, save, reload and duplicate flow needs.
 *
 * Keyed by `externalId`, which is the catalog's identity, so a reseed finds the rows it wrote and
 * restores their labels rather than adding more. The caller connects to the **test** database; the
 * entry script refuses anything else before a connection is opened.
 *
 * It also records the catalog as synchronized. A deployment's catalog is filled from the provider's
 * member directory by `pnpm data:congress-members:sync`; the hermetic stack reaches no provider, so
 * this seed stands in for that run — and the browser suites then see the picker a deployment shows,
 * not the one an unsynchronized catalog shows. The members are written here rather than through the
 * synchronization on purpose: their identifiers are deliberately not bioguide ids, and the
 * synchronization admits nothing else.
 */
export async function seedQaCongressMembers(
  prisma: PrismaClient,
): Promise<{ externalId: string; id: string }[]> {
  const seeded: { externalId: string; id: string }[] = [];
  for (const member of QA_CONGRESS_MEMBER_LIST) {
    const data = {
      displayName: member.displayName,
      profileName: member.directoryName ?? null,
      chamber: member.chamber,
      state: member.state,
      district: member.district ?? null,
    };
    const row = await prisma.alternativeDataActor.upsert({
      where: { externalId: member.externalId },
      create: { externalId: member.externalId, ...data },
      update: data,
      select: { id: true, externalId: true },
    });
    seeded.push(row);
  }

  const now = new Date();
  await prisma.congressMemberCatalogSync.upsert({
    where: { id: CONGRESS_MEMBER_CATALOG_SYNC_ID },
    create: {
      id: CONGRESS_MEMBER_CATALOG_SYNC_ID,
      runSequence: 1,
      lastStartedAt: now,
      lastCompletedAt: now,
    },
    // A claim or a failure a test run left behind is cleared: the fixture stack starts every run
    // from a synchronized catalog that nothing is holding.
    update: {
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      lastCompletedAt: now,
      consecutiveFailures: 0,
      lastError: null,
    },
  });
  return seeded;
}
