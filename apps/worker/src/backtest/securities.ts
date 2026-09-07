import type { PrismaClient } from "@intrinsic/database";
import type { Security, SecurityId } from "@intrinsic/domain";

/** Reads the catalog rows a run's frozen securities still reference. */
export interface BacktestSecurityCatalog {
  findByIds(ids: readonly SecurityId[]): Promise<Map<SecurityId, Security>>;
}

export class PrismaBacktestSecurityCatalog implements BacktestSecurityCatalog {
  constructor(private readonly prisma: PrismaClient) {}

  async findByIds(
    ids: readonly SecurityId[],
  ): Promise<Map<SecurityId, Security>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.security.findMany({
      where: { id: { in: [...ids] } },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          symbol: row.symbol,
          name: row.name,
          exchangeCode: row.exchangeCode,
          ...(row.exchangeName ? { exchangeName: row.exchangeName } : {}),
          currency: row.currency,
          ...(row.cik ? { cik: row.cik } : {}),
          ...(row.isin ? { isin: row.isin } : {}),
          ...(row.cusip ? { cusip: row.cusip } : {}),
          ...(row.country ? { country: row.country } : {}),
          ...(row.sector ? { sector: row.sector } : {}),
          ...(row.industry ? { industry: row.industry } : {}),
          ...(row.ipoDate
            ? { ipoDate: row.ipoDate.toISOString().slice(0, 10) }
            : {}),
          type: row.type,
          isAdr: row.isAdr,
          isActivelyTrading: row.isActivelyTrading,
        } satisfies Security,
      ]),
    );
  }
}
