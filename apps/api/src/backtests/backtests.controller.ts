import type {
  AuthUser,
  BacktestProgressResponse,
  BacktestRunDetailResponse,
  BacktestRunStrategyResponse,
  BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  ServiceUnavailableException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import {
  backtestInvalid,
  parseCreateBacktestRunRequest,
} from "./backtest-requests";
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
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<BacktestRunDetailResponse> {
    const input = parseCreateBacktestRunRequest(body);
    return this.execute(() => this.backtests.submitRun(user.id, input));
  }

  @Get()
  async listOwn(
    @CurrentUser() user: AuthUser,
  ): Promise<BacktestRunSummaryResponse[]> {
    return this.backtests.listForUser(user.id);
  }

  @Get(":runId")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestRunDetailResponse> {
    return this.execute(() => this.backtests.getRun(user.id, runId));
  }

  @Get(":runId/progress")
  async getProgress(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestProgressResponse> {
    return this.execute(() => this.backtests.getProgress(user.id, runId));
  }

  @Get(":runId/strategy")
  async getStrategy(
    @CurrentUser() user: AuthUser,
    @Param("runId") runId: string,
  ): Promise<BacktestRunStrategyResponse> {
    return this.execute(() => this.backtests.getRunStrategy(user.id, runId));
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
      if (error instanceof BacktestUnavailableError) {
        // Not the caller's fault, so not a 400: the run cannot be created under the methodology it
        // would have to record, and retrying the same request later is the right response.
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }
}
