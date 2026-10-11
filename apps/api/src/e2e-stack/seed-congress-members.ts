import type { PrismaClient } from "@intrinsic/database";
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
 */
export async function seedQaCongressMembers(
  prisma: PrismaClient,
): Promise<{ externalId: string; id: string }[]> {
  const seeded: { externalId: string; id: string }[] = [];
  for (const member of QA_CONGRESS_MEMBER_LIST) {
    const data = {
      displayName: member.displayName,
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
  return seeded;
}
