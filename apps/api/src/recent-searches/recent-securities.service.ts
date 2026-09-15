import {
  RECENT_SECURITY_LIMIT,
  type StockSearchResultResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RECENT_SEARCHES_LOGGER } from "./recent-searches.tokens";

/**
 * A submitted security id that is not in the `Security` catalog.
 *
 * Same rule as stock lists: the catalog is the identity authority, and this slice never creates a
 * catalog row and never consults the provider.
 */
export class UnsupportedSecurityError extends Error {
  constructor() {
    super("That security is not in the supported catalog");
    this.name = "UnsupportedSecurityError";
  }
}

const SECURITY_SELECT = {
  id: true,
  symbol: true,
  name: true,
  exchangeCode: true,
  exchangeName: true,
  // Same projection the search endpoint returns, mark included, so a recent row and a result row
  // for the same stock cannot look different.
  profile: { select: { logoUrl: true } },
} satisfies Prisma.SecuritySelect;

type SecurityRow = Prisma.SecurityGetPayload<{
  select: typeof SECURITY_SELECT;
}>;

function securityResponse(security: SecurityRow): StockSearchResultResponse {
  return {
    id: security.id,
    symbol: security.symbol,
    name: security.name,
    exchangeCode: security.exchangeCode,
    ...(security.exchangeName ? { exchangeName: security.exchangeName } : {}),
    ...(security.profile?.logoUrl ? { logoUrl: security.profile.logoUrl } : {}),
  };
}

/**
 * Deterministic recency order.
 *
 * `viewedAt` alone is not a total order — two views inside the same millisecond, or a restored
 * backup with coarse timestamps, would leave the dropdown reordering itself between renders. The
 * id tiebreak is arbitrary but stable, and the read and the trim below use the same one so they
 * can never disagree about which row is sixth.
 */
const RECENCY_ORDER = [
  { viewedAt: "desc" as const },
  { securityId: "asc" as const },
];

/**
 * Recently viewed securities: the data behind the global search dropdown's RECENT SEARCHES.
 *
 * Reads the `Security` catalog directly through Prisma rather than through `StockDataService`,
 * exactly as stock lists do — this slice only needs canonical identity rows, and going through the
 * stock-data service would drag Redis, the FMP gate and hydration into a convenience surface.
 */
@Injectable()
export class RecentSecuritiesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RECENT_SEARCHES_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /** The authenticated user's recents, newest first, already resolved against the catalog. */
  async listForUser(userId: string): Promise<StockSearchResultResponse[]> {
    const rows = await this.prisma.recentSecurityView.findMany({
      where: { userId },
      orderBy: RECENCY_ORDER,
      take: RECENT_SECURITY_LIMIT,
      select: { security: { select: SECURITY_SELECT } },
    });
    return rows.map((row) => securityResponse(row.security));
  }

  /**
   * Resolves a Guest's browser-stored ids against the catalog, preserving the caller's order.
   *
   * The browser stores ids and nothing else, so this is where a Guest's recents get their labels —
   * from the live catalog, never from whatever a previous visit cached. An id the catalog no longer
   * holds simply produces no row: the dropdown shows the rest and never a broken entry.
   */
  async resolveIds(
    securityIds: readonly string[],
  ): Promise<StockSearchResultResponse[]> {
    if (securityIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.security.findMany({
      where: { id: { in: [...securityIds] } },
      select: SECURITY_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return securityIds.slice(0, RECENT_SECURITY_LIMIT).flatMap((id) => {
      const row = byId.get(id);
      return row ? [securityResponse(row)] : [];
    });
  }

  /**
   * Records that this user opened a security's Stock Details page.
   *
   * Recency, not history: the (user, security) primary key means a second view of the same stock
   * moves `viewedAt` instead of adding a row, and the trim keeps only what the product shows. Both
   * happen in one transaction so a concurrent view can never leave the set above the limit.
   */
  async recordView(userId: string, securityId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const security = await tx.security.findUnique({
        where: { id: securityId },
        select: { id: true },
      });
      if (!security) {
        throw new UnsupportedSecurityError();
      }

      await tx.recentSecurityView.upsert({
        where: { userId_securityId: { userId, securityId } },
        create: { userId, securityId },
        update: { viewedAt: new Date() },
      });

      const surplus = await tx.recentSecurityView.findMany({
        where: { userId },
        orderBy: RECENCY_ORDER,
        skip: RECENT_SECURITY_LIMIT,
        select: { securityId: true },
      });
      if (surplus.length > 0) {
        await tx.recentSecurityView.deleteMany({
          where: {
            userId,
            securityId: { in: surplus.map((row) => row.securityId) },
          },
        });
      }
    });

    // `debug`, not `info`: this fires on every Stock Details view and is convenience UI, so it is
    // operational detail rather than a lifecycle boundary worth carrying at the default level.
    this.logger.debug({
      event: "recent-security-view.recorded",
      actorUserId: userId,
      securityId,
    });
  }
}
