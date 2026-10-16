import type { PrismaClient } from "@intrinsic/database";
import { listedFrom } from "./oracle/listing";

/**
 * The listing evidence of one security as the audit reads it from its own SQL: the stored IPO date
 * and the first stored price, combined by the oracle's `listedFrom` (DATA-02).
 */
export async function readListedFrom(
  prisma: PrismaClient,
  securityId: string,
): Promise<string | null> {
  const [row] = await prisma.$queryRawUnsafe<
    { ipo: string | null; first: string | null }[]
  >(
    `select to_char(s."ipoDate", 'YYYY-MM-DD') as ipo,
            (select to_char(min(p.date), 'YYYY-MM-DD') from "DailyPrice" p where p."securityId" = s.id) as first
       from "Security" s where s.id = $1`,
    securityId,
  );
  return listedFrom(row?.ipo, row?.first);
}
