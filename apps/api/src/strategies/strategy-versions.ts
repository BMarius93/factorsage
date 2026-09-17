import { createHash } from "node:crypto";
import {
  strategyDefinitionFingerprint,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";

/**
 * Strategy version persistence, shared by the Strategies API and built-in bootstrap so a built-in
 * is versioned exactly like a customer's Strategy.
 */

/** The persisted `definitionHash`: sha256 of the id-free canonical fingerprint. */
export function definitionHashOf(definition: StrategyDefinition): string {
  return createHash("sha256")
    .update(strategyDefinitionFingerprint(definition))
    .digest("hex");
}

/**
 * Appends `definition` as the Strategy's next version unless its logic equals the current one.
 *
 * The caller holds the Strategy row lock (`SELECT … FOR UPDATE`): the next version number is read
 * and then written, so two concurrent replacements would otherwise collide on
 * `(strategyId, versionNumber)`. Existing versions are never updated. Returns whether a version was
 * appended.
 */
export async function appendStrategyVersionIfChanged(
  tx: Prisma.TransactionClient,
  strategyId: string,
  definition: StrategyDefinition,
): Promise<boolean> {
  const hash = definitionHashOf(definition);
  const current = await tx.strategyVersion.findFirst({
    where: { strategyId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true, definitionHash: true },
  });
  if (current?.definitionHash === hash) {
    return false;
  }
  await tx.strategyVersion.create({
    data: {
      strategyId,
      versionNumber: (current?.versionNumber ?? 0) + 1,
      definition: definition as unknown as Prisma.InputJsonValue,
      definitionHash: hash,
    },
  });
  return true;
}
