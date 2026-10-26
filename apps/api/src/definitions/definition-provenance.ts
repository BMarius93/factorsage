import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import type {
  CanonicalBuiltInReference,
  CanonicalProvenance,
} from "@intrinsic/strategy";
import type { PrismaService } from "../database/prisma.service";
import { listMembershipFingerprint } from "./content-origin";

/**
 * Where the Strategy and the List a backtest executed came from
 * (`docs/decisions/canonical-definitions-v1.md` §5).
 *
 * Built-in status is never decided by a name. The evidence, strongest first:
 *
 * 1. **Ownership.** SYSTEM content is official FactorSage content; a SYSTEM row is never deleted
 *    and its ownership never changes, so the row the snapshot names answers it for good.
 * 2. **The copy record.** A customer's content created since origins were recorded says whether it
 *    was written from scratch or copied, and from which built-in and in what state. A copy whose
 *    frozen logic (or membership) still equals what it copied is the built-in unchanged; any other
 *    is derived.
 * 3. **Strategy version history**, for a strategy saved before origins were recorded: a duplicate's
 *    first version is always its source's logic, so a first version whose `definitionHash` is a
 *    built-in version's began as that built-in. A deleted strategy's frozen logic can still match a
 *    built-in version's exactly.
 *
 * Anything else is `unknown` — a List saved before origins were recorded, a strategy whose history
 * matches no built-in or several. Nothing is guessed in either direction.
 */
export class DefinitionProvenanceResolver {
  constructor(private readonly prisma: PrismaService) {}

  async strategyProvenance(
    snapshot: BacktestRunSnapshot,
  ): Promise<CanonicalProvenance> {
    const frozenHash = snapshot.strategy.definitionHash;
    const row = await this.prisma.strategy.findUnique({
      where: { id: snapshot.strategy.strategyId },
      select: {
        ownership: true,
        systemKey: true,
        premium: true,
        createdAt: true,
        origin: true,
        originSystemKey: true,
        originVersionNumber: true,
        originDefinitionHash: true,
        versions: {
          where: { versionNumber: 1 },
          select: { definitionHash: true, createdAt: true },
        },
      },
    });

    if (row?.ownership === "SYSTEM" && row.systemKey) {
      return {
        origin: "built_in",
        evidence: "system_content",
        builtIn: reference(
          row.systemKey,
          snapshot.strategy.name,
          row.premium,
          snapshot.strategy.versionNumber,
        ),
      };
    }

    if (row?.origin === "AUTHORED") {
      return { origin: "custom", evidence: "authored_record" };
    }
    if (row?.origin === "COPIED") {
      if (
        !row.originSystemKey ||
        row.originVersionNumber === null ||
        row.originDefinitionHash === null
      ) {
        // Copied from customer content that was itself custom.
        return { origin: "custom", evidence: "copy_record" };
      }
      const source = await this.builtInStrategy(row.originSystemKey);
      if (!source) {
        return { origin: "unknown" };
      }
      const builtIn = reference(
        row.originSystemKey,
        source.name,
        source.premium,
        row.originVersionNumber,
      );
      return frozenHash === row.originDefinitionHash
        ? { origin: "built_in", evidence: "copy_record", builtIn }
        : { origin: "derived", evidence: "copy_record", derivedFrom: builtIn };
    }

    // Not recorded: saved before origins were, or deleted since the run.
    const firstVersion = row?.versions[0];
    const evidenceHash = firstVersion?.definitionHash ?? frozenHash;
    const matches = await this.prisma.strategyVersion.findMany({
      where: {
        definitionHash: evidenceHash,
        strategy: { ownership: "SYSTEM", systemKey: { not: null } },
      },
      orderBy: { versionNumber: "asc" },
      select: {
        versionNumber: true,
        createdAt: true,
        strategy: { select: { systemKey: true, name: true, premium: true } },
      },
    });
    const systemKeys = new Set(
      matches.map((match) => match.strategy.systemKey),
    );
    if (matches.length === 0 || systemKeys.size !== 1) {
      return { origin: "unknown" };
    }
    // The built-in version that existed when this strategy began, when there is one.
    const startedAt = firstVersion?.createdAt;
    const existing = startedAt
      ? matches.filter((match) => match.createdAt <= startedAt)
      : [];
    const match = existing[existing.length - 1] ?? matches[0];
    if (!match?.strategy.systemKey) {
      return { origin: "unknown" };
    }
    const builtIn = reference(
      match.strategy.systemKey,
      match.strategy.name,
      match.strategy.premium,
      match.versionNumber,
    );
    if (!firstVersion) {
      return { origin: "built_in", evidence: "content_match", builtIn };
    }
    return frozenHash === firstVersion.definitionHash
      ? { origin: "built_in", evidence: "version_history", builtIn }
      : {
          origin: "derived",
          evidence: "version_history",
          derivedFrom: builtIn,
        };
  }

  async listProvenance(
    snapshot: BacktestRunSnapshot,
  ): Promise<CanonicalProvenance> {
    const row = await this.prisma.stockList.findUnique({
      where: { id: snapshot.stockList.stockListId },
      select: {
        ownership: true,
        systemKey: true,
        premium: true,
        origin: true,
        originSystemKey: true,
        originMembershipDigest: true,
      },
    });
    if (row?.ownership === "SYSTEM" && row.systemKey) {
      return {
        origin: "built_in",
        evidence: "system_content",
        builtIn: reference(
          row.systemKey,
          snapshot.stockList.name,
          // Every point-in-time universe is premium, whatever its column says.
          row.premium || snapshot.stockList.universe !== undefined,
        ),
      };
    }
    if (row?.origin === "AUTHORED") {
      return { origin: "custom", evidence: "authored_record" };
    }
    if (row?.origin === "COPIED") {
      if (!row.originSystemKey || row.originMembershipDigest === null) {
        return { origin: "custom", evidence: "copy_record" };
      }
      const source = await this.prisma.stockList.findUnique({
        where: { systemKey: row.originSystemKey },
        select: { ownership: true, name: true, premium: true },
      });
      if (source?.ownership !== "SYSTEM") {
        return { origin: "unknown" };
      }
      const builtIn = reference(
        row.originSystemKey,
        source.name,
        source.premium,
      );
      const frozen = listMembershipFingerprint(
        snapshot.securities.map((security) => ({
          securityId: security.securityId,
          buyWindowMode: security.buyWindowMode,
          buyWindows: security.buyWindows,
        })),
      );
      return frozen === row.originMembershipDigest
        ? { origin: "built_in", evidence: "copy_record", builtIn }
        : { origin: "derived", evidence: "copy_record", derivedFrom: builtIn };
    }
    // A List saved before origins were recorded, or deleted since: Lists keep no history to
    // read an origin from, so it is not guessed.
    return { origin: "unknown" };
  }

  private async builtInStrategy(systemKey: string) {
    const row = await this.prisma.strategy.findUnique({
      where: { systemKey },
      select: { ownership: true, name: true, premium: true },
    });
    return row?.ownership === "SYSTEM" ? row : null;
  }
}

function reference(
  systemKey: string,
  name: string,
  premium: boolean,
  version?: number,
): CanonicalBuiltInReference {
  return {
    systemKey,
    name,
    ...(version === undefined ? {} : { version }),
    ...(premium ? { premium: true as const } : {}),
  };
}
