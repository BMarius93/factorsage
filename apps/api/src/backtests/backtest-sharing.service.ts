import { randomBytes } from "node:crypto";
import {
  BACKTEST_SHARE_TOKEN_BYTES,
  backtestSharePath,
  definitionDescriptionPublication,
  DEMO_BACKTESTS_MAX,
  isBacktestShareToken,
  sampleSharedBacktestPreview,
  SHARED_BACKTEST_SUMMARY_FIELDS,
  strategyRuleCount,
  withCanonicalStrategyDefinition,
  type BacktestResultSummaryResponse,
  type BacktestRunSnapshot,
  type BacktestShareDefinitionResponse,
  type BacktestShareResponse,
  type DemoBacktestListResponse,
  type DemoBacktestResponse,
  type SharedBacktestConfigurationResponse,
  type SharedBacktestDefinitionsResponse,
  type SharedBacktestPreviewResponse,
  type SharedBacktestReportResponse,
  type SharedBacktestSummaryResponse,
  type SharedDefinitionResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import { benchmarkDisplayName } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  CanonicalDefinitionError,
  describeDefinition,
  serializeSnapshotList,
  serializeSnapshotStrategy,
  validateDefinition,
  type CanonicalDefinitionDocument,
  type CanonicalListDocument,
  type CanonicalProvenance,
  type CanonicalStrategyDocument,
  type DefinitionDescription,
} from "@intrinsic/strategy";
import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { PrismaService } from "../database/prisma.service";
import { DefinitionProvenanceResolver } from "../definitions/definition-provenance";
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
 *   Creating a link records the canonical definitions of the Strategy and List the run executed —
 *   from its frozen snapshot, with provenance read from the Strategy and List rows' recorded
 *   origin — and their descriptions, all in the same write (`docs/decisions/canonical-definitions-v1.md`).
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
 * The run's Strategy or List could not be written as a canonical definition, so no link is created:
 * a share is recorded whole — its definitions and their descriptions — or not at all.
 */
export class BacktestShareDefinitionsUnavailableError extends Error {
  constructor() {
    super(
      "This backtest's strategy or list could not be recorded for sharing, so no link was created.",
    );
    this.name = "BacktestShareDefinitionsUnavailableError";
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

/**
 * What a public read loads from the run, and nothing more: no user id, no failure detail. `id` is
 * read to find the run's equity rows and is never projected into a public response.
 */
const SHARED_RUN_SELECT = {
  id: true,
  runNumber: true,
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

/** What a share holds beside its token: the recorded definitions and the owner's choice. */
const SHARE_SELECT = {
  token: true,
  createdAt: true,
  definitions: true,
  descriptions: true,
  publishDescriptions: true,
} satisfies Prisma.BacktestShareSelect;

type ShareRow = Prisma.BacktestShareGetPayload<{ select: typeof SHARE_SELECT }>;

/** The canonical documents and their descriptions, as one share records them. */
type ShareDefinitions = {
  definitions: {
    strategy: CanonicalStrategyDocument;
    list: CanonicalListDocument;
  };
  descriptions: {
    strategy: DefinitionDescription;
    list: DefinitionDescription;
  };
};

function isDescription(value: unknown): value is DefinitionDescription {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DefinitionDescription).short === "string" &&
    typeof (value as DefinitionDescription).detailed === "string"
  );
}

/**
 * The definitions a share recorded, read back and checked, or `null` for a share created before
 * definitions were recorded. A stored document this build cannot read is reported and treated as
 * absent — never served half-understood.
 */
function recordedDefinitions(
  share: Pick<ShareRow, "definitions" | "descriptions">,
  logger: StructuredLogger,
  runId: string,
): ShareDefinitions | null {
  if (share.definitions === null || share.descriptions === null) {
    return null;
  }
  const definitions = share.definitions as Record<string, unknown>;
  const descriptions = share.descriptions as Record<string, unknown>;
  const strategy = validateDefinition(definitions.strategy);
  const list = validateDefinition(definitions.list);
  if (
    !strategy.valid ||
    strategy.document.type !== "strategy" ||
    !list.valid ||
    list.document.type !== "list" ||
    !isDescription(descriptions.strategy) ||
    !isDescription(descriptions.list)
  ) {
    logger.error({
      event: "backtest.share.definitions.unreadable",
      runId,
      issues: [
        ...(strategy.valid ? [] : strategy.issues),
        ...(list.valid ? [] : list.issues),
      ].slice(0, 5),
    });
    return null;
  }
  return {
    definitions: { strategy: strategy.document, list: list.document },
    descriptions: { strategy: descriptions.strategy, list: descriptions.list },
  };
}

/** The built-in a definition is, or was derived from, when there is one. */
function builtInReferenceOf(provenance: CanonicalProvenance) {
  return provenance.origin === "built_in"
    ? provenance.builtIn
    : provenance.origin === "derived"
      ? provenance.derivedFrom
      : undefined;
}

function publicationOf(document: CanonicalDefinitionDocument) {
  return definitionDescriptionPublication({
    type: document.type,
    origin: document.provenance.origin,
    premium: builtInReferenceOf(document.provenance)?.premium === true,
  });
}

/** The owner's view of one recorded definition. */
function ownerDefinitionOf(
  document: CanonicalDefinitionDocument,
  description: DefinitionDescription,
): BacktestShareDefinitionResponse {
  const builtIn = builtInReferenceOf(document.provenance);
  return {
    origin: document.provenance.origin,
    ...(builtIn ? { builtInName: builtIn.name } : {}),
    publication: publicationOf(document),
    short: description.short,
  };
}

/**
 * The public view of one recorded definition: its origin, the official name of the built-in behind
 * it, and its description only where the publication rule and the owner's choice allow. The
 * canonical document itself, its metadata — the customer's own name for their content — and every
 * member never leave this function.
 */
function sharedDefinitionOf(
  document: CanonicalDefinitionDocument,
  description: DefinitionDescription,
  publishDescriptions: boolean,
): SharedDefinitionResponse {
  const builtIn = builtInReferenceOf(document.provenance);
  const publication = publicationOf(document);
  const published =
    publication === "always" ||
    (publication === "opt_in" && publishDescriptions);
  return {
    origin: document.provenance.origin,
    ...(builtIn ? { builtInName: builtIn.name } : {}),
    description: published
      ? {
          status: "published",
          short: description.short,
          detailed: description.detailed,
        }
      : {
          status: "withheld",
          reason: publication === "never" ? "premium" : "owner",
        },
  };
}

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
  private readonly provenance: DefinitionProvenanceResolver;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(BACKTESTS_LOGGER) private readonly logger: StructuredLogger,
  ) {
    this.provenance = new DefinitionProvenanceResolver(prisma);
  }

  // -------------------------------------------------------------------------
  // The owner
  // -------------------------------------------------------------------------

  /**
   * The run's link, if it has one, and what the public report shows about its Strategy and List.
   *
   * Before the run is shared, the definitions are computed from its frozen snapshot so the owner can
   * see what sharing would publish — computed only, never stored: nothing is recorded until the
   * owner creates the link.
   */
  async getShare(
    userId: string,
    runId: string,
  ): Promise<BacktestShareResponse> {
    const run = await this.ownedRun(userId, runId);
    if (run.share) {
      return this.responseOf(run.id, run.share);
    }
    if (run.status !== "COMPLETED" || run.summary === null) {
      return this.responseOf(run.id, null);
    }
    let preview: ShareDefinitions | null = null;
    try {
      preview = await this.recordableDefinitions(run.id, run.snapshot);
    } catch (error) {
      if (!(error instanceof BacktestShareDefinitionsUnavailableError)) {
        throw error;
      }
    }
    return this.responseOf(run.id, null, preview);
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
    options: { publishDescriptions?: boolean } = {},
  ): Promise<BacktestShareResponse> {
    const run = await this.ownedRun(userId, runId);
    if (run.status !== "COMPLETED" || run.summary === null) {
      throw new BacktestNotShareableError();
    }
    if (run.share) {
      if (options.publishDescriptions === undefined) {
        return this.responseOf(run.id, run.share);
      }
      return this.updatePublication(
        userId,
        run,
        run.share,
        options.publishDescriptions,
      );
    }

    // Everything the share records is computed before anything is written, so a definition that
    // cannot be serialized leaves no link behind — never one with half of what it should hold.
    const recorded = await this.recordableDefinitions(run.id, run.snapshot);
    const publishDescriptions = options.publishDescriptions ?? false;
    let share: ShareRow;
    try {
      share = await this.prisma.backtestShare.create({
        data: {
          runId: run.id,
          token: newShareToken(),
          definitions: recorded.definitions as unknown as Prisma.InputJsonValue,
          descriptions:
            recorded.descriptions as unknown as Prisma.InputJsonValue,
          publishDescriptions,
        },
        select: SHARE_SELECT,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.prisma.backtestShare.findUnique({
        where: { runId: run.id },
        select: SHARE_SELECT,
      });
      if (!existing) {
        throw error;
      }
      return this.responseOf(run.id, existing);
    }
    // Never the token: it is the link itself.
    this.logger.info({
      event: "backtest.share.enabled",
      actorUserId: userId,
      runId: run.id,
      strategyOrigin: recorded.definitions.strategy.provenance.origin,
      listOrigin: recorded.definitions.list.provenance.origin,
      publishDescriptions,
    });
    return this.responseOf(run.id, share);
  }

  /**
   * Changes whether an existing link publishes the owner's descriptions. A link created before
   * definitions were recorded gets them now, from the same frozen snapshot — the owner asked for
   * this link's report to change, so this is the one moment it may.
   */
  private async updatePublication(
    userId: string,
    run: { id: string; snapshot: Prisma.JsonValue },
    share: ShareRow,
    publishDescriptions: boolean,
  ): Promise<BacktestShareResponse> {
    const recorded =
      share.definitions === null
        ? await this.recordableDefinitions(run.id, run.snapshot)
        : null;
    const updated = await this.prisma.backtestShare.update({
      where: { runId: run.id },
      data: {
        publishDescriptions,
        ...(recorded
          ? {
              definitions:
                recorded.definitions as unknown as Prisma.InputJsonValue,
              descriptions:
                recorded.descriptions as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
      select: SHARE_SELECT,
    });
    this.logger.info({
      event: "backtest.share.descriptions.updated",
      actorUserId: userId,
      runId: run.id,
      publishDescriptions,
      definitionsRecorded: recorded !== null,
    });
    return this.responseOf(run.id, updated);
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
    const { run, share } = await this.sharedRunWithShare(token);
    const equity = await this.prisma.backtestDailyEquity.findMany({
      where: { runId: run.id },
      orderBy: { date: "asc" },
      select: CURVE_EQUITY_SELECT,
    });
    const snapshot = readSnapshot(run.snapshot);
    const report: SharedBacktestReportResponse = {
      runNumber: run.runNumber,
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
    const definitions = this.publicDefinitionsOf(run.id, share);
    if (definitions) {
      report.definitions = definitions;
    }
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

  /**
   * The operator-featured demonstrations, in display order (`docs/decisions/entitlements-v2.md` §4).
   *
   * Public and precomputed: each is an active shared report of a completed run, projected through
   * the same allowlist the report itself uses, so a demonstration can never publish more than its
   * link already does. Nothing is executed — two indexed reads and the stored summaries. A demo whose
   * run no longer has a result is left out rather than answered half-empty.
   */
  async listDemos(): Promise<DemoBacktestListResponse> {
    const startedAt = Date.now();
    const rows = await this.prisma.demoBacktest.findMany({
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      take: DEMO_BACKTESTS_MAX,
      select: {
        title: true,
        description: true,
        share: { select: { token: true, run: { select: SHARED_RUN_SELECT } } },
      },
    });
    const demos: DemoBacktestResponse[] = [];
    for (const row of rows) {
      const run = row.share.run;
      if (
        run.status !== "COMPLETED" ||
        run.summary === null ||
        run.completedAt === null
      ) {
        continue;
      }
      const configuration = sharedConfigurationOf(readSnapshot(run.snapshot));
      const summary = resultSummaryOf(run.summary);
      demos.push({
        title: row.title,
        description: row.description,
        path: backtestSharePath(row.share.token),
        url: this.publicUrl(row.share.token),
        completedAt: run.completedAt.toISOString(),
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
      });
    }
    this.logger.debug({
      event: "backtest.demos.read",
      demos: demos.length,
      durationMs: Date.now() - startedAt,
    });
    return { demos };
  }

  /**
   * Features one of a user's completed runs as a demonstration: shares it if it is not shared yet
   * (the same idempotent path the owner's button takes), then records or updates the demo. An
   * operator action, run from `pnpm --filter @intrinsic/api demo-backtests`.
   */
  async featureDemo(input: {
    userId: string;
    runId: string;
    title: string;
    description: string | null;
    position: number;
  }): Promise<DemoBacktestResponse | null> {
    await this.enableShare(input.userId, input.runId);
    await this.prisma.demoBacktest.upsert({
      where: { runId: input.runId },
      create: {
        runId: input.runId,
        title: input.title,
        description: input.description,
        position: input.position,
      },
      update: {
        title: input.title,
        description: input.description,
        position: input.position,
      },
    });
    const { demos } = await this.listDemos();
    const share = await this.prisma.backtestShare.findUnique({
      where: { runId: input.runId },
      select: { token: true },
    });
    return (
      demos.find(
        (demo) => share && demo.path === backtestSharePath(share.token),
      ) ?? null
    );
  }

  /** Stops featuring a run. Its share link, if any, is left exactly as it was. */
  async unfeatureDemo(runId: string): Promise<boolean> {
    const deleted = await this.prisma.demoBacktest.deleteMany({
      where: { runId },
    });
    return deleted.count > 0;
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
        snapshot: true,
        summary: { select: { runId: true } },
        share: { select: SHARE_SELECT },
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
    return (await this.sharedRunWithShare(token)).run;
  }

  private async sharedRunWithShare(token: string): Promise<{
    run: SharedRunRow;
    share: Pick<
      ShareRow,
      "definitions" | "descriptions" | "publishDescriptions"
    >;
  }> {
    if (!isBacktestShareToken(token)) {
      throw new SharedBacktestNotFoundError();
    }
    const share = await this.prisma.backtestShare.findUnique({
      where: { token },
      select: {
        definitions: true,
        descriptions: true,
        publishDescriptions: true,
        run: { select: SHARED_RUN_SELECT },
      },
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
    return { run, share };
  }

  /**
   * The canonical documents and descriptions a new share records for this run: serialized from its
   * frozen snapshot — never from the current Strategy or List — with provenance resolved for each
   * independently, validated, and described. Throws {@link BacktestShareDefinitionsUnavailableError}
   * when either cannot be written; the codec's reason is logged, never shown.
   */
  private async recordableDefinitions(
    runId: string,
    rawSnapshot: Prisma.JsonValue,
  ): Promise<ShareDefinitions> {
    const startedAt = Date.now();
    const snapshot = readSnapshot(rawSnapshot);
    try {
      const [strategyProvenance, listProvenance] = await Promise.all([
        this.provenance.strategyProvenance(snapshot),
        this.provenance.listProvenance(snapshot),
      ]);
      const strategy = serializeSnapshotStrategy(snapshot, strategyProvenance);
      const list = serializeSnapshotList(snapshot, listProvenance);
      const recorded: ShareDefinitions = {
        definitions: { strategy, list },
        descriptions: {
          strategy: describeDefinition(strategy),
          list: describeDefinition(list),
        },
      };
      this.logger.debug({
        event: "backtest.share.definitions.recorded",
        runId,
        strategyOrigin: strategyProvenance.origin,
        listOrigin: listProvenance.origin,
        durationMs: Date.now() - startedAt,
      });
      return recorded;
    } catch (error) {
      if (error instanceof CanonicalDefinitionError) {
        this.logger.error({
          event: "backtest.share.definitions.failed",
          runId,
          issues: error.issues.slice(0, 5),
          durationMs: Date.now() - startedAt,
          err: error,
        });
        throw new BacktestShareDefinitionsUnavailableError();
      }
      throw error;
    }
  }

  private publicDefinitionsOf(
    runId: string,
    share: Pick<
      ShareRow,
      "definitions" | "descriptions" | "publishDescriptions"
    >,
  ): SharedBacktestDefinitionsResponse | undefined {
    const recorded = recordedDefinitions(share, this.logger, runId);
    if (!recorded) {
      return undefined;
    }
    return {
      strategy: sharedDefinitionOf(
        recorded.definitions.strategy,
        recorded.descriptions.strategy,
        share.publishDescriptions,
      ),
      list: sharedDefinitionOf(
        recorded.definitions.list,
        recorded.descriptions.list,
        share.publishDescriptions,
      ),
    };
  }

  private publicUrl(token: string): string {
    return `${this.config.webBaseUrl}${backtestSharePath(token)}`;
  }

  private responseOf(
    runId: string,
    share: ShareRow | null,
    preview: ShareDefinitions | null = null,
  ): BacktestShareResponse {
    const recorded = share
      ? recordedDefinitions(share, this.logger, runId)
      : preview;
    const definitions = recorded
      ? {
          definitions: {
            strategy: ownerDefinitionOf(
              recorded.definitions.strategy,
              recorded.descriptions.strategy,
            ),
            list: ownerDefinitionOf(
              recorded.definitions.list,
              recorded.descriptions.list,
            ),
          },
        }
      : {};
    return share
      ? {
          shared: true,
          url: this.publicUrl(share.token),
          sharedAt: share.createdAt.toISOString(),
          publishDescriptions: share.publishDescriptions,
          ...definitions,
        }
      : {
          shared: false,
          url: null,
          sharedAt: null,
          publishDescriptions: false,
          ...definitions,
        };
  }
}
