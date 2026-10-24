import type { PrismaClient } from "@intrinsic/database";
import type { MarketIndexKey } from "@intrinsic/domain";
import type { MappedFmpDividend } from "@intrinsic/fmp";
import type { StructuredLogger as Logger } from "@intrinsic/observability";
import {
  replaceDividendEvents,
  securitiesWithDividends,
  type DividendRow,
} from "@intrinsic/stock-data";
import { describeError, universeSecurities } from "./index-universe-ingest.js";

/**
 * The dividend history of an index universe's securities (`docs/decisions/historical-universes-v1.md`
 * §5): one `dividends` request per security, stored whole by `replaceDividendEvents`.
 *
 * - **Bounded.** The run's request budget (750 by default) is the guard's: when it is spent the guard
 *   closes, the run stops, and what it stored stays stored.
 * - **Resumable.** A security whose dividends were synchronized (`StockDatasetState` `DIVIDEND`) is
 *   skipped, so rerunning the command continues from the first security not yet done. `--refresh`
 *   repeats every security.
 * - **Shared.** Dividends are one dataset per security, whichever index names it: a Dow member the
 *   S&P 500 run synchronized is not asked for again.
 */

export type DividendIngestionSummary = {
  readonly universe: number;
  readonly alreadySynchronized: number;
  readonly selected: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stoppedEarly: boolean;
  readonly rowsStored: number;
  readonly rowsDropped: number;
  readonly securitiesWithoutDividends: number;
  readonly failures: readonly { symbol: string; error: string }[];
  readonly durationMs: number;
};

export type DividendProvider = {
  getDividends(
    symbol: string,
  ): Promise<{
    readonly rows: readonly MappedFmpDividend[];
    readonly dropped: number;
  }>;
};

export async function runDividendIngestion(input: {
  readonly prisma: PrismaClient;
  readonly indexKeys: readonly MarketIndexKey[];
  readonly provider: DividendProvider;
  readonly refresh: boolean;
  readonly symbols: readonly string[] | null;
  readonly limit: number | null;
  readonly concurrency: number;
  readonly logger: Logger;
  readonly shouldStop: () => boolean;
  readonly now?: () => Date;
}): Promise<DividendIngestionSummary> {
  const { prisma, logger } = input;
  const startedAt = Date.now();
  const bySecurity = new Map<
    string,
    { securityId: string; providerSymbol: string }
  >();
  for (const indexKey of input.indexKeys) {
    for (const entry of await universeSecurities(prisma, indexKey)) {
      bySecurity.set(entry.securityId, entry);
    }
  }
  const universe = [...bySecurity.values()].sort((left, right) =>
    left.providerSymbol < right.providerSymbol ? -1 : 1,
  );
  const synchronized = await securitiesWithDividends(
    prisma,
    universe.map((entry) => entry.securityId),
  );
  const wanted = input.symbols
    ? new Set(input.symbols.map((symbol) => symbol.toUpperCase()))
    : null;
  let work = universe.filter((entry) => {
    if (wanted) {
      return wanted.has(entry.providerSymbol);
    }
    return input.refresh || !synchronized.has(entry.securityId);
  });
  if (input.limit !== null) {
    work = work.slice(0, input.limit);
  }
  logger.info({
    event: "index.dividends.started",
    indexKeys: input.indexKeys,
    universe: universe.length,
    alreadySynchronized: synchronized.size,
    selected: work.length,
  });

  let succeeded = 0;
  let failed = 0;
  let done = 0;
  let rowsStored = 0;
  let rowsDropped = 0;
  let withoutDividends = 0;
  let stoppedEarly = false;
  const failures: { symbol: string; error: string }[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (input.shouldStop()) {
        stoppedEarly = true;
        return;
      }
      const entry = work[next];
      next += 1;
      if (!entry) {
        return;
      }
      try {
        const mapped = await input.provider.getDividends(entry.providerSymbol);
        const rows: DividendRow[] = mapped.rows.map((row) => ({
          exDate: row.exDate,
          recordDate: row.recordDate,
          paymentDate: row.paymentDate,
          declarationDate: row.declarationDate,
          amount: row.amount,
          adjustedAmount: row.adjustedAmount,
          frequency: row.frequency,
        }));
        const stored = await replaceDividendEvents(prisma, {
          securityId: entry.securityId,
          rows,
          syncedAt: (input.now ?? (() => new Date()))(),
        });
        rowsStored += stored.stored;
        rowsDropped += mapped.dropped;
        if (stored.stored === 0) {
          withoutDividends += 1;
        }
        succeeded += 1;
      } catch (error) {
        failed += 1;
        const detail = describeError(error);
        failures.push({ symbol: entry.providerSymbol, error: detail });
        logger.warn({
          event: "index.dividends.failed",
          symbol: entry.providerSymbol,
          err: error,
        });
      }
      done += 1;
      if (done % 50 === 0 || done === work.length) {
        logger.info({
          event: "index.dividends.progress",
          done,
          selected: work.length,
          succeeded,
          failed,
          rowsStored,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, input.concurrency) }, () => worker()),
  );
  return {
    universe: universe.length,
    alreadySynchronized: synchronized.size,
    selected: work.length,
    succeeded,
    failed,
    skipped: work.length - done,
    stoppedEarly,
    rowsStored,
    rowsDropped,
    securitiesWithoutDividends: withoutDividends,
    failures,
    durationMs: Date.now() - startedAt,
  };
}
