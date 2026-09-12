import type { AuthUser, BacktestRunSnapshot } from "@intrinsic/contracts";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BacktestsModule } from "../backtests/backtests.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { BacktestsService } from "../backtests/backtests.service";
import { parseCreateBacktestRunRequest } from "../backtests/backtest-requests";
import type { QaMatrixCase } from "./matrix-case";
import type {
  EvidenceEquity,
  EvidencePosition,
  EvidenceSummary,
  EvidenceTrade,
  RunEvidence,
} from "./matrix-invariants";

/**
 * The matrix's half of the real application path.
 *
 * Submission goes through the product's own `BacktestsService.submitRun`, resolved from the real
 * `BacktestsModule` in a real Nest application context — the same provider graph the HTTP process
 * builds, with the same request parser in front of it. So the matrix gets the real validation, the
 * real ownership scoping, the real immutable snapshot and, critically, the real durable work: one
 * transaction creating `BacktestRun`, `BacktestJob` and `BacktestRunProgress` together.
 *
 * What it deliberately does **not** do is call the simulation. Nothing in the runner imports
 * `simulateBacktest`. A run is created here, claimed by the real worker process, executed there and
 * read back from PostgreSQL; the runner never sees the engine, which is the only arrangement in
 * which its validation means anything.
 *
 * Driving Nest directly rather than over HTTP is the repository's established API-level pattern —
 * the same one `backtests.integration.test.ts` uses — and it skips only the cookie the guard would
 * have read. Authorization is not skipped: `submitRun` scopes every query by the user id it is
 * given, and a strategy or list belonging to someone else is invisible to it.
 *
 * **Entitlements are not skipped either.** The principal handed to `submitRun` is built from the
 * owner's persisted `plan` and `role` — read from the database here exactly as `CookieAuthGuard`
 * reads them per request — so the sweep is subject to the same symbol, depth and concurrency
 * limits as any other caller. That is why the fixtures are owned by the **QA_ADMIN** persona:
 * `ADMIN_ENTITLEMENTS` is the decision document's own mechanism for operator capability, and the
 * matrix is operator tooling that runs a thousand backtests at a concurrency no commercial plan
 * sells. The alternative — a bypass flag on the submission service — is exactly the unconditional
 * bypass the decision document forbids, and it would have made the matrix stop exercising the real
 * path.
 */

@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule, BacktestsModule],
})
class MatrixExecutionModule {}

export type MatrixExecutionContext = {
  readonly prisma: PrismaClient;
  readonly backtests: BacktestsService;
  close(): Promise<void>;
};

export async function createMatrixExecutionContext(): Promise<MatrixExecutionContext> {
  const context: INestApplicationContext =
    await NestFactory.createApplicationContext(MatrixExecutionModule, {
      logger: false,
    });
  const prisma = context.get(PrismaService, { strict: false });
  const backtests = context.get(BacktestsService, { strict: false });
  return {
    prisma: prisma as unknown as PrismaClient,
    backtests,
    async close(): Promise<void> {
      await context.close();
    },
  };
}

/** Persisted identities of the fixtures, resolved once for the whole sweep. */
export type MatrixFixtureIds = {
  readonly ownerUserId: string;
  /**
   * The owner as the entitlement resolver sees them: plan and role straight from PostgreSQL, never
   * assembled from anything the runner decided.
   */
  readonly owner: AuthUser;
  readonly strategyIdByFixtureId: ReadonlyMap<string, string>;
  readonly stockListIdByFixtureId: ReadonlyMap<string, string>;
};

export async function resolveMatrixFixtureIds(
  prisma: PrismaClient,
  ownerEmail: string,
  fixtures: {
    readonly strategies: readonly { id: string; name: string }[];
    readonly lists: readonly { id: string; name: string }[];
  },
): Promise<MatrixFixtureIds> {
  const owner = await prisma.user.findFirst({
    where: { email: ownerEmail.trim().toLowerCase() },
    select: { id: true, email: true, role: true, plan: true },
  });
  if (!owner) {
    throw new Error(
      `The QA persona \`${ownerEmail}\` does not exist in the matrix database.`,
    );
  }
  const strategies = await prisma.strategy.findMany({
    where: { userId: owner.id },
    select: { id: true, name: true },
  });
  const lists = await prisma.stockList.findMany({
    where: { userId: owner.id },
    select: { id: true, name: true },
  });
  const strategyByName = new Map(strategies.map((row) => [row.name, row.id]));
  const listByName = new Map(lists.map((row) => [row.name, row.id]));

  const strategyIdByFixtureId = new Map<string, string>();
  for (const fixture of fixtures.strategies) {
    const id = strategyByName.get(fixture.name);
    if (!id) {
      throw new Error(`Strategy fixture \`${fixture.name}\` is not seeded.`);
    }
    strategyIdByFixtureId.set(fixture.id, id);
  }
  const stockListIdByFixtureId = new Map<string, string>();
  for (const fixture of fixtures.lists) {
    const id = listByName.get(fixture.name);
    if (!id) {
      throw new Error(`Stock list fixture \`${fixture.name}\` is not seeded.`);
    }
    stockListIdByFixtureId.set(fixture.id, id);
  }
  return {
    ownerUserId: owner.id,
    owner: {
      id: owner.id,
      email: owner.email,
      role: owner.role,
      plan: owner.plan,
    },
    strategyIdByFixtureId,
    stockListIdByFixtureId,
  };
}

/**
 * Submits one combination exactly as the API would.
 *
 * The body is built from the configuration fixture and put through `parseCreateBacktestRunRequest`
 * first, so a configuration the product would reject is rejected here too — with the same message,
 * for the same reason.
 */
export async function submitMatrixCase(
  context: MatrixExecutionContext,
  ids: MatrixFixtureIds,
  matrixCase: QaMatrixCase,
): Promise<string> {
  const strategyId = ids.strategyIdByFixtureId.get(matrixCase.strategyId);
  const stockListId = ids.stockListIdByFixtureId.get(matrixCase.listId);
  if (!strategyId || !stockListId) {
    throw new Error(
      `${matrixCase.caseId}: the seeded fixtures do not include ${matrixCase.strategyId} / ${matrixCase.listId}.`,
    );
  }
  const input = parseCreateBacktestRunRequest({
    strategyId,
    stockListId,
    ...matrixCase.combination.config.request,
  });
  const run = await context.backtests.submitRun(ids.owner, input);
  return run.id;
}

const TERMINAL = new Set(["COMPLETED", "FAILED"]);

/**
 * Waits for the persisted run to reach a terminal status.
 *
 * Polls the run row rather than listening for anything: the run is the durable record, a worker
 * that dies mid-execution leaves its job to lease recovery, and the runner must observe the same
 * outcome a user polling `/backtests/{id}/progress` would.
 */
export async function awaitTerminalRun(
  prisma: PrismaClient,
  runId: string,
  options: { readonly timeoutMs: number; readonly pollIntervalMs: number },
): Promise<{ status: string; failure: string | null }> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const run = await prisma.backtestRun.findUnique({
      where: { id: runId },
      select: {
        status: true,
        failureCode: true,
        failureMessage: true,
        failurePhase: true,
      },
    });
    if (!run) {
      return { status: "MISSING", failure: "The run row disappeared." };
    }
    if (TERMINAL.has(run.status)) {
      return {
        status: run.status,
        failure:
          run.status === "FAILED"
            ? `${run.failureCode ?? "UNKNOWN"} in ${run.failurePhase ?? "?"}: ${
                run.failureMessage ?? ""
              }`
            : null,
      };
    }
    if (Date.now() > deadline) {
      return {
        status: "TIMED_OUT",
        failure: `Still ${run.status} after ${Math.round(options.timeoutMs / 1000)}s.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

/**
 * Persisted decimals cross into the validator as **canonical strings**, never as numbers.
 *
 * The whole point of the validator is to check identities the database holds exactly. Converting a
 * `numeric(24,6)` to float64 on the way in would discard the digits at C08 magnitudes — a
 * $334bn portfolio needs 18 significant digits against float64's ~15.95 — and the validator would
 * then be measuring its own conversion rather than the run.
 */
const num = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed();
const required = (value: Prisma.Decimal): string => value.toFixed();
const day = (value: Date): string => value.toISOString().slice(0, 10);

/** Series data is identical for every run in a sweep, so it is read once and reused. */
export class MatrixSeriesCache {
  private readonly calendars = new Map<string, readonly string[]>();
  private readonly closes = new Map<
    string,
    readonly { date: string; close: string }[]
  >();
  private readonly firstPrices = new Map<string, string>();

  constructor(private readonly prisma: PrismaClient) {}

  async calendarDates(seriesId: string): Promise<readonly string[]> {
    const cached = this.calendars.get(seriesId);
    if (cached) {
      return cached;
    }
    const rows = await this.prisma.benchmarkDailyPrice.findMany({
      where: { seriesId },
      orderBy: { date: "asc" },
      select: { date: true },
    });
    const dates = rows.map((row) => day(row.date));
    this.calendars.set(seriesId, dates);
    return dates;
  }

  async benchmarkCloses(
    seriesId: string,
  ): Promise<readonly { date: string; close: string }[]> {
    const cached = this.closes.get(seriesId);
    if (cached) {
      return cached;
    }
    const rows = await this.prisma.benchmarkDailyPrice.findMany({
      where: { seriesId },
      orderBy: { date: "asc" },
      select: { date: true, close: true },
    });
    const bars = rows.map((row) => ({
      date: day(row.date),
      close: required(row.close),
    }));
    this.closes.set(seriesId, bars);
    return bars;
  }

  async firstPriceDates(
    securityIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unknown = securityIds.filter((id) => !this.firstPrices.has(id));
    if (unknown.length > 0) {
      const rows = await this.prisma.dailyPrice.groupBy({
        by: ["securityId"],
        where: { securityId: { in: unknown } },
        _min: { date: true },
      });
      for (const row of rows) {
        if (row._min.date) {
          this.firstPrices.set(row.securityId, day(row._min.date));
        }
      }
    }
    return new Map(
      securityIds
        .map((id) => [id, this.firstPrices.get(id)] as const)
        .filter(
          (entry): entry is readonly [string, string] => entry[1] !== undefined,
        ),
    );
  }
}

/**
 * Reads back everything the invariants are checked against.
 *
 * All of it comes from PostgreSQL. Nothing is carried over from submission, so a run whose stored
 * result disagreed with what was submitted would be caught rather than papered over by a value the
 * runner happened to still hold in memory.
 */
export async function collectRunEvidence(
  prisma: PrismaClient,
  series: MatrixSeriesCache,
  runId: string,
  caseId: string,
): Promise<RunEvidence> {
  const run = await prisma.backtestRun.findUnique({
    where: { id: runId },
    include: { summary: true },
  });
  if (!run) {
    throw new Error(`Run ${runId} does not exist.`);
  }

  const [trades, equity, positions] = await Promise.all([
    prisma.backtestTrade.findMany({
      where: { runId },
      orderBy: { sequence: "asc" },
    }),
    prisma.backtestDailyEquity.findMany({
      where: { runId },
      orderBy: { date: "asc" },
    }),
    prisma.backtestPosition.findMany({ where: { runId } }),
  ]);

  const snapshot = run.snapshot as unknown as BacktestRunSnapshot;
  const [calendarDates, benchmarkCloses, firstPriceDateBySecurityId] =
    await Promise.all([
      series.calendarDates(run.executionCalendarSeriesId),
      series.benchmarkCloses(run.benchmarkSeriesId),
      series.firstPriceDates(
        snapshot.securities.map((security) => security.securityId),
      ),
    ]);

  const summary: EvidenceSummary | null = run.summary
    ? {
        firstSimulatedDate: day(run.summary.firstSimulatedDate),
        lastSimulatedDate: day(run.summary.lastSimulatedDate),
        tradingDays: run.summary.tradingDays,
        investedCapital: required(run.summary.investedCapital),
        finalCash: required(run.summary.finalCash),
        finalPositionsValue: required(run.summary.finalPositionsValue),
        finalValue: required(run.summary.finalValue),
        netProfit: required(run.summary.netProfit),
        portfolioReturnPercent: required(run.summary.portfolioReturnPercent),
        benchmarkReturnPercent: num(run.summary.benchmarkReturnPercent),
        alphaPercent: num(run.summary.alphaPercent),
        portfolioCagrPercent: num(run.summary.portfolioCagrPercent),
        maxDrawdownPercent: required(run.summary.maxDrawdownPercent),
        benchmarkMaxDrawdownPercent: num(
          run.summary.benchmarkMaxDrawdownPercent,
        ),
        realizedPnl: required(run.summary.realizedPnl),
        unrealizedPnl: required(run.summary.unrealizedPnl),
        totalTrades: run.summary.totalTrades,
        buyTrades: run.summary.buyTrades,
        sellTrades: run.summary.sellTrades,
        finalExitTrades: run.summary.finalExitTrades,
        winningTrades: run.summary.winningTrades,
        losingTrades: run.summary.losingTrades,
        openPositions: run.summary.openPositions,
      }
    : null;

  return {
    runId,
    caseId,
    status: run.status,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    failurePhase: run.failurePhase,
    snapshot,
    startDate: day(run.startDate),
    endDate: day(run.endDate),
    initialCapital: required(run.initialCapital),
    monthlyContribution: required(run.monthlyContribution),
    maximumPositions: run.maximumPositions,
    summary,
    equity: equity.map((row): EvidenceEquity => ({
      date: day(row.date),
      cash: required(row.cash),
      positionsValue: required(row.positionsValue),
      totalValue: required(row.totalValue),
      investedCapital: required(row.investedCapital),
      returnIndex: required(row.returnIndex),
      benchmarkIndex: num(row.benchmarkIndex),
      benchmarkValue: num(row.benchmarkValue),
      cashBaselineValue: required(row.cashBaselineValue),
      openPositions: row.openPositions,
    })),
    trades: trades.map((row): EvidenceTrade => ({
      sequence: row.sequence,
      date: day(row.date),
      securityId: row.securityId,
      symbol: row.symbol,
      name: row.name,
      action: row.action as EvidenceTrade["action"],
      levelId: row.levelId,
      levelPercentage: row.levelPercentage,
      shares: required(row.shares),
      price: required(row.price),
      amount: required(row.amount),
      fees: required(row.fees),
      realizedPnl: num(row.realizedPnl),
      realizedPnlPercent: num(row.realizedPnlPercent),
      cashAfter: required(row.cashAfter),
      sharesAfter: required(row.sharesAfter),
      averageCostAfter: num(row.averageCostAfter),
    })),
    positions: positions.map((row): EvidencePosition => ({
      securityId: row.securityId,
      symbol: row.symbol,
      name: row.name,
      openedDate: day(row.openedDate),
      shares: required(row.shares),
      averageCost: required(row.averageCost),
      lastPrice: required(row.lastPrice),
      lastPriceDate: day(row.lastPriceDate),
      marketValue: required(row.marketValue),
      unrealizedPnl: required(row.unrealizedPnl),
      unrealizedPnlPercent: required(row.unrealizedPnlPercent),
      allocationPercent: required(row.allocationPercent),
    })),
    executionCalendarDates: calendarDates,
    benchmarkCloses,
    firstPriceDateBySecurityId,
  };
}
