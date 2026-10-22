import { randomBytes } from "node:crypto";
import {
  BACKTEST_SHARE_TOKEN_BYTES,
  backtestSharePath,
  isBacktestShareToken,
  sampleSharedBacktestPreview,
  SHARED_BACKTEST_SUMMARY_FIELDS,
  strategyRuleCount,
  withCanonicalStrategyDefinition,
  type BacktestResultSummaryResponse,
  type BacktestRunSnapshot,
  type BacktestShareResponse,
  type SharedBacktestConfigurationResponse,
  type SharedBacktestPreviewResponse,
  type SharedBacktestReportResponse,
  type SharedBacktestSummaryResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import { benchmarkDisplayName } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { PrismaService } from "../database/prisma.service";
import {
  annualReturnsOf,
  BacktestRunNotFoundError,
  curvePointOf,
  CURVE_EQUITY_SELECT,
  downsampleCurve,
  fromDatabaseDate,
  readSnapshot,
  resultSummaryOf,
} from "./backtests.service";
import { BACKTESTS_LOGGER } from "./backtests.tokens";

/**
 * Public backtest sharing (`docs/decisions/backtest-sharing-v1.md`).
 *
 * Two audiences, two halves, and they never share a code path that could leak:
 *
 * - **The owner** turns a completed run's link on and off. Every owner operation is scoped by the
 *   authenticated user id, so another user's run answers exactly like a run that does not exist.
 * - **A public reader** holds a token and gets the allowlisted report. That half never reads a
 *   user id, a strategy or list row, a trade, a position, a stock history or the provider: it reads
 *   the share row, the frozen run it points at, the run's stored summary and its persisted daily
 *   equity, and projects them through the same functions the owner's page uses. Nothing here
 *   depends on the reader's plan, because nothing here asks who the reader is.
 */

/** A run that cannot be shared in its current state — only a completed run with a result can. */
export class BacktestNotShareableError extends Error {
  constructor() {
    super("Only a completed backtest can be shared.");
    this.name = "BacktestNotShareableError";
  }
}

/**
 * Raised for a token that is malformed, unknown, revoked or points at a run with no result. The
 * cases are deliberately indistinguishable, so a probe learns nothing about which tokens existed.
 */
export class SharedBacktestNotFoundError extends Error {
  constructor() {
    super("Shared backtest was not found");
    this.name = "SharedBacktestNotFoundError";
  }
}

/** What a public read loads from the run, and nothing more: no user id, no failure detail. */
const SHARED_RUN_SELECT = {
  id: true,
  status: true,
  startDate: true,
  endDate: true,
  completedAt: true,
  snapshot: true,
  summary: true,
} satisfies Prisma.BacktestRunSelect;

type SharedRunRow = Prisma.BacktestRunGetPayload<{
  select: typeof SHARED_RUN_SELECT;
}>;

type ShareRow = { token: string; createdAt: Date };

function newShareToken(): string {
  return randomBytes(BACKTEST_SHARE_TOKEN_BYTES).toString("base64url");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    (error as Prisma.PrismaClientKnownRequestError | undefined)?.code ===
    "P2002"
  );
}

/**
 * The public summary, field by field from the allowlist. Anything the stored summary gains later
 * stays private until somebody adds it to `SHARED_BACKTEST_SUMMARY_FIELDS` on purpose.
 */
function sharedSummaryOf(
  summary: BacktestResultSummaryResponse,
): SharedBacktestSummaryResponse {
  const shared: Partial<Record<keyof SharedBacktestSummaryResponse, unknown>> =
    {};
  for (const field of SHARED_BACKTEST_SUMMARY_FIELDS) {
    shared[field] = summary[field];
  }
  return shared as SharedBacktestSummaryResponse;
}

/**
 * The general simulation parameters, read from the immutable snapshot like the owner's
 * configuration is. The rule count is taken over the canonical projection of the frozen
 * definition, so a run frozen under an older definition schema counts as its upcast does.
 */
function sharedConfigurationOf(
  snapshot: BacktestRunSnapshot,
): SharedBacktestConfigurationResponse {
  const canonical = withCanonicalStrategyDefinition(snapshot);
  return {
    startDate: snapshot.period.startDate,
    endDate: snapshot.period.endDate,
    initialCapital: snapshot.capital.initialCapital,
    monthlyContribution: snapshot.capital.monthlyContribution,
    maximumPositions: snapshot.allocation.maximumPositions,
    fullPositionPercent: snapshot.allocation.fullPositionFraction * 100,
    benchmark: {
      code: snapshot.benchmark.code,
      name: benchmarkDisplayName(snapshot.benchmark),
    },
    securityCount: snapshot.securities.length,
    strategyRuleCount: strategyRuleCount(canonical.strategy.definition),
  };
}

@Injectable()
export class BacktestSharingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(BACKTESTS_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  // -------------------------------------------------------------------------
  // The owner
  // -------------------------------------------------------------------------

  async getShare(
    userId: string,
    runId: string,
  ): Promise<BacktestShareResponse> {
    const run = await this.ownedRun(userId, runId);
    return this.responseOf(run.share);
  }

  /**
   * Shares a completed run, or hands back the link it already has.
   *
   * Idempotent: a run holds at most one active link — `runId` is the share row's key — so asking
   * twice returns the same URL rather than minting a second one. Two concurrent first requests race
   * on that key; the loser reads the winner's row.
   */
  async enableShare(
    userId: string,
    runId: string,
  ): Promise<BacktestShareResponse> {
    const run = await this.ownedRun(userId, runId);
    if (run.status !== "COMPLETED" || run.summary === null) {
      throw new BacktestNotShareableError();
    }
    if (run.share) {
      return this.responseOf(run.share);
    }
    let share: ShareRow;
    try {
      share = await this.prisma.backtestShare.create({
        data: { runId: run.id, token: newShareToken() },
        select: { token: true, createdAt: true },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.prisma.backtestShare.findUnique({
        where: { runId: run.id },
        select: { token: true, createdAt: true },
      });
      if (!existing) {
        throw error;
      }
      return this.responseOf(existing);
    }
    // Never the token: it is the link itself.
    this.logger.info({
      event: "backtest.share.enabled",
      actorUserId: userId,
      runId: run.id,
    });
    return this.responseOf(share);
  }

  /**
   * Stops sharing. The row is deleted, so the token stops resolving on the very next request —
   * the page, the API and the preview image alike — and nothing can revive it: sharing again
   * mints a new token. Idempotent; revoking an unshared run changes nothing.
   */
  async revokeShare(userId: string, runId: string): Promise<void> {
    const run = await this.ownedRun(userId, runId);
    const { count } = await this.prisma.backtestShare.deleteMany({
      where: { runId: run.id },
    });
    if (count > 0) {
      this.logger.info({
        event: "backtest.share.revoked",
        actorUserId: userId,
        runId: run.id,
      });
    }
  }

  // -------------------------------------------------------------------------
  // The public reader
  // -------------------------------------------------------------------------

  /**
   * The allowlisted report behind a token.
   *
   * The chart curve and the annual returns are the owner's page's own projections of the same
   * persisted equity, and the summary is the same stored row through the same reader, so a public
   * figure can never disagree with the private one.
   */
  async readReport(token: string): Promise<SharedBacktestReportResponse> {
    const startedAt = Date.now();
    const run = await this.sharedRun(token);
    const equity = await this.prisma.backtestDailyEquity.findMany({
      where: { runId: run.id },
      orderBy: { date: "asc" },
      select: CURVE_EQUITY_SELECT,
    });
    const snapshot = readSnapshot(run.snapshot);
    const report: SharedBacktestReportResponse = {
      runId: run.id,
      url: this.publicUrl(token),
      completedAt: (run.completedAt as Date).toISOString(),
      configuration: sharedConfigurationOf(snapshot),
      result: {
        summary: sharedSummaryOf(
          resultSummaryOf(run.summary as NonNullable<SharedRunRow["summary"]>),
        ),
        annualReturns: annualReturnsOf(equity, run),
        curve: downsampleCurve(equity.map(curvePointOf)),
      },
    };
    this.logger.debug({
      event: "backtest.share.report.read",
      runId: run.id,
      durationMs: Date.now() - startedAt,
    });
    return report;
  }

  /**
   * What the link-preview card is drawn from: the stored headline figures and the two absolute
   * scenario lines, thinned for drawing with their peaks and troughs kept. Reads two columns of
   * the persisted equity and nothing else.
   */
  async readPreview(token: string): Promise<SharedBacktestPreviewResponse> {
    const startedAt = Date.now();
    const run = await this.sharedRun(token);
    const equity = await this.prisma.backtestDailyEquity.findMany({
      where: { runId: run.id },
      orderBy: { date: "asc" },
      select: { date: true, totalValue: true, benchmarkValue: true },
    });
    const configuration = sharedConfigurationOf(readSnapshot(run.snapshot));
    const summary = resultSummaryOf(
      run.summary as NonNullable<SharedRunRow["summary"]>,
    );
    const preview: SharedBacktestPreviewResponse = {
      configuration: {
        startDate: configuration.startDate,
        endDate: configuration.endDate,
        benchmark: configuration.benchmark,
        securityCount: configuration.securityCount,
        strategyRuleCount: configuration.strategyRuleCount,
      },
      headline: {
        portfolioCagrPercent: summary.portfolioCagrPercent,
        benchmarkCagrPercent: summary.benchmarkCagrPercent,
        portfolioReturnPercent: summary.portfolioReturnPercent,
        benchmarkReturnPercent: summary.benchmarkReturnPercent,
        maxDrawdownPercent: summary.maxDrawdownPercent,
      },
      series: sampleSharedBacktestPreview(
        equity.map((row) => ({
          date: fromDatabaseDate(row.date),
          strategyValue: row.totalValue.toNumber(),
          benchmarkValue:
            row.benchmarkValue === null ? null : row.benchmarkValue.toNumber(),
        })),
      ),
    };
    this.logger.debug({
      event: "backtest.share.preview.read",
      runId: run.id,
      points: preview.series.length,
      durationMs: Date.now() - startedAt,
    });
    return preview;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async ownedRun(userId: string, runId: string) {
    const run = await this.prisma.backtestRun.findFirst({
      where: { id: runId, userId },
      select: {
        id: true,
        status: true,
        summary: { select: { runId: true } },
        share: { select: { token: true, createdAt: true } },
      },
    });
    if (!run) {
      throw new BacktestRunNotFoundError();
    }
    return run;
  }

  /**
   * The completed run a token points at. A malformed token is refused before any query; an
   * unknown or revoked one finds no row; a run without a stored result is not a report. All four
   * answer the same.
   */
  private async sharedRun(token: string): Promise<SharedRunRow> {
    if (!isBacktestShareToken(token)) {
      throw new SharedBacktestNotFoundError();
    }
    const share = await this.prisma.backtestShare.findUnique({
      where: { token },
      select: { run: { select: SHARED_RUN_SELECT } },
    });
    const run = share?.run;
    if (
      !run ||
      run.status !== "COMPLETED" ||
      run.summary === null ||
      run.completedAt === null
    ) {
      throw new SharedBacktestNotFoundError();
    }
    return run;
  }

  private publicUrl(token: string): string {
    return `${this.config.webBaseUrl}${backtestSharePath(token)}`;
  }

  private responseOf(share: ShareRow | null): BacktestShareResponse {
    return share
      ? {
          shared: true,
          url: this.publicUrl(share.token),
          sharedAt: share.createdAt.toISOString(),
        }
      : { shared: false, url: null, sharedAt: null };
  }
}
