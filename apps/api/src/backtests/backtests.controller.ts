import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type {
  AuthUser,
  BacktestProgressResponse,
  BacktestRunDetailResponse,
  BacktestRunPageResponse,
  BacktestRunStrategyResponse,
  BacktestRunSummaryResponse,
  BacktestShareResponse,
  BacktestTradePageResponse,
} from "@intrinsic/contracts";
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  ServiceUnavailableException,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  backtestInvalid,
  parseCreateBacktestRunRequest,
  parseRunListRequest,
  parseTradeLogQuery,
  parseTradePageRequest,
} from "./backtest-requests";
import {
  BacktestNotShareableError,
  BacktestSharingService,
} from "./backtest-sharing.service";
import {
  BacktestConfigurationError,
  BacktestRunNotFoundError,
  BacktestsService,
  BacktestUnavailableError,
} from "./backtests.service";

/**
 * User-owned backtest runs. Every route requires an authenticated session and operates strictly on
 * the caller's own rows: the service scopes each query by the authenticated user id, and a run
 * that exists but belongs to someone else answers exactly like one that does not exist. There is
 * intentionally no ADMIN bypass.
 *
 * A run is durable asynchronous work, so submission answers 202 with the queued run rather than
 * blocking until results exist. The client then polls `/progress`.
 */
@Controller("backtests")
@UseGuards(CookieAuthGuard)
export class BacktestsController {
  constructor(
    @Inject(BacktestsService) private readonly backtests: BacktestsService,
    @Inject(BacktestSharingService)
    private readonly sharing: BacktestSharingService,
  ) {}

  @RateLimit("backtest-execution")
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<BacktestRunDetailResponse> {
    const input = parseCreateBacktestRunRequest(body);
    return this.execute(() => this.backtests.submitRun(user, input));
  }

  /**
   * The caller's runs. With `page` or `pageSize`, one page of them with its counts (the
   * collection's read); without, every matching run as a plain array, as this route has always
   * answered — what the New backtest form reads, with `status=ACTIVE`, to show the runs holding a
   * concurrency slot. Either way searched, filtered and ordered in the database, without opening a
   * single run's snapshot.
   */
  @RateLimit("standard-read")
  @Get()
  async listOwn(
    @CurrentUser() user: AuthUser,
    @Query("page") page?: unknown,
    @Query("pageSize") pageSize?: unknown,
    @Query("q") q?: unknown,
    @Query("status") status?: unknown,
    @Query("sort") sort?: unknown,
  ): Promise<BacktestRunSummaryResponse[] | BacktestRunPageResponse> {
    const { paged, ...request } = parseRunListRequest({
      page,
      pageSize,
      q,
      status,
      sort,
    });
    return paged
      ? this.backtests.pageForUser(user.id, request)
      : this.backtests.listForUser(user.id, request);
  }

  @RateLimit("standard-read")
  @Get(":runId")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestRunDetailResponse> {
    return this.execute(() => this.backtests.getRun(user.id, runId));
  }

  @RateLimit("progress-poll")
  @Get(":runId/progress")
  async getProgress(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestProgressResponse> {
    return this.execute(() => this.backtests.getProgress(user.id, runId));
  }

  /**
   * One page of the run's trade log, newest first unless `order=asc`, optionally narrowed to one
   * stock and one action.
   *
   * Its own route rather than a field of the result: a long run executes tens of thousands of
   * trades, so the log is read a page at a time from the database and the result payload stays the
   * size of a page whatever the run's length. Out-of-range paging is clamped, not refused, and an
   * unrecognised filter is ignored rather than refused — the response reports what was applied.
   */
  @RateLimit("standard-read")
  @Get(":runId/trades")
  async getTrades(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
    @Query("page") page?: unknown,
    @Query("pageSize") pageSize?: unknown,
    @Query("symbol") symbol?: unknown,
    @Query("action") action?: unknown,
    @Query("order") order?: unknown,
  ): Promise<BacktestTradePageResponse> {
    const request = parseTradePageRequest({
      page,
      pageSize,
      symbol,
      action,
      order,
    });
    return this.execute(() =>
      this.backtests.getTrades(user.id, runId, request),
    );
  }

  /**
   * The run's whole trade log — or the part one filter selects — as a CSV download.
   *
   * The same filter and order as the page, read by the same parser, so the file holds exactly the
   * trades the table could page through. Streamed a batch at a time, so a twenty-thousand-trade run
   * never sits in memory as one document. `no-store`: the file is the caller's own data.
   *
   * Its own rate-limit class: one request reads a whole run's log, where a page reads fifty rows.
   */
  @RateLimit("data-export")
  @Get(":runId/trades/export")
  @Header("Cache-Control", "no-store")
  async exportTrades(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
    @Query("symbol") symbol?: unknown,
    @Query("action") action?: unknown,
    @Query("order") order?: unknown,
  ): Promise<StreamableFile> {
    const query = parseTradeLogQuery({ symbol, action, order });
    const { filename, content } = await this.execute(() =>
      this.backtests.exportTrades(user.id, runId, query),
    );
    // At most one chunk read ahead: the next batch is fetched only once the client has taken the
    // last one, which is what keeps the memory an export holds to a batch.
    return new StreamableFile(Readable.from(content, { highWaterMark: 1 }), {
      type: "text/csv; charset=utf-8",
      // Built from ASCII letters, digits and hyphens only, so it needs no escaping here.
      disposition: `attachment; filename="${filename}"`,
    }).setErrorHandler(cutOffExport);
  }

  @RateLimit("standard-read")
  @Get(":runId/strategy")
  async getStrategy(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestRunStrategyResponse> {
    return this.execute(() => this.backtests.getRunStrategy(user.id, runId));
  }

  /**
   * Whether the run is shared, and its public link when it is
   * (`docs/decisions/backtest-sharing-v1.md`). Owner only, like every route here.
   */
  @RateLimit("standard-read")
  @Get(":runId/share")
  async getShare(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestShareResponse> {
    return this.execute(() => this.sharing.getShare(user.id, runId));
  }

  /**
   * Shares a completed run: creates its public link, or returns the one it already has. `PUT`
   * because it is idempotent — a run holds at most one active link. A run that is not completed
   * answers `409`: its state, not the request, is what prevents it.
   */
  @RateLimit("mutation")
  @Put(":runId/share")
  async enableShare(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestShareResponse> {
    return this.execute(() => this.sharing.enableShare(user.id, runId));
  }

  /**
   * Stops sharing. The link stops working at once and is never revived; sharing again creates a
   * new one. Idempotent.
   */
  @RateLimit("mutation")
  @Delete(":runId/share")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeShare(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.execute(() => this.sharing.revokeShare(user.id, runId));
  }

  /**
   * Maps the service's product errors onto HTTP. A rejected configuration answers 400 carrying the
   * stable `BACKTEST_INVALID` code, so the submission form can tell "you cannot run this" from an
   * infrastructure failure. Anything unrecognized stays an internal error: a database failure must
   * not masquerade as a client mistake.
   */
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BacktestRunNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof BacktestConfigurationError) {
        throw backtestInvalid(error.message);
      }
      if (error instanceof BacktestNotShareableError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof BacktestUnavailableError) {
        // Not the caller's fault, so not a 400: the run cannot be created under the methodology it
        // would have to record, and retrying the same request later is the right response.
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }
}

/** What Nest hands a stream's error handler: the HTTP response, typed more narrowly than it is. */
type StreamErrorResponse = Parameters<
  Parameters<StreamableFile["setErrorHandler"]>[0]
>[1];

/**
 * What an export does when reading the log fails part-way through.
 *
 * Nest's default ends the response normally once headers are out, which would hand the caller a
 * truncated file that looks complete. Before anything is sent this is an ordinary `500`; after,
 * the connection is cut, so the download fails visibly instead of quietly ending early. The
 * service has already logged the failure with the run and the rows written.
 */
function cutOffExport(error: Error, handed: StreamErrorResponse): void {
  // Under the Express adapter this is the Node response itself.
  const response = handed as StreamErrorResponse &
    Pick<ServerResponse, "setHeader" | "destroy">;
  if (response.destroyed) {
    return;
  }
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  response.statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Disposition", "inline");
  response.send(
    JSON.stringify({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "Internal server error",
    }),
  );
}
