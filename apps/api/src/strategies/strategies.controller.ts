import {
  STRATEGY_INVALID_CODE,
  StrategyValidationError,
  type AuthUser,
  type StrategyDetailResponse,
  type StrategySummaryResponse,
  type StrategyValidationErrorResponse,
} from "@intrinsic/contracts";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  StrategiesService,
  StrategyInUseByMonitorError,
  StrategyNotFoundError,
} from "./strategies.service";
import {
  parseCreateStrategyRequest,
  parseDuplicateStrategyRequest,
  parseReplaceStrategyDefinitionRequest,
  parseUpdateStrategyRequest,
} from "./strategy-requests";

/**
 * Strategies: the caller's own, plus the platform's built-ins.
 *
 * Reads accept a Guest, who sees built-ins only. Every write requires a session. A strategy that
 * exists but belongs to another customer answers exactly like one that does not exist, for
 * administrators too; a built-in may be changed by an administrator only — appending a version
 * exactly like a customer edit — and is never deleted.
 */
@Controller("strategies")
export class StrategiesController {
  constructor(
    @Inject(StrategiesService) private readonly strategies: StrategiesService,
  ) {}

  @RateLimit("standard-read")
  @Get()
  @UseGuards(OptionalCookieAuthGuard)
  async listOwn(
    @Viewer() viewer: AuthUser | null,
  ): Promise<StrategySummaryResponse[]> {
    return this.strategies.listForUser(viewer);
  }

  @RateLimit("mutation")
  @Post()
  @UseGuards(CookieAuthGuard)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<StrategyDetailResponse> {
    const input = parseCreateStrategyRequest(body);
    return this.execute(() => this.strategies.createStrategy(user, input));
  }

  /**
   * Copies a strategy the caller can read — their own, or a built-in — into a new one they own, and
   * answers with the copy. The source is only read.
   */
  @RateLimit("mutation")
  @Post(":strategyId/duplicate")
  @UseGuards(CookieAuthGuard)
  async duplicate(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
    @Body() body: unknown,
  ): Promise<StrategyDetailResponse> {
    const input = parseDuplicateStrategyRequest(body);
    return this.execute(() =>
      this.strategies.duplicateStrategy(user, strategyId, input),
    );
  }

  @RateLimit("standard-read")
  @Get(":strategyId")
  @UseGuards(OptionalCookieAuthGuard)
  async getOne(
    @Viewer() viewer: AuthUser | null,
    @Param("strategyId") strategyId: string,
  ): Promise<StrategyDetailResponse> {
    return this.execute(() => this.strategies.getStrategy(viewer, strategyId));
  }

  @RateLimit("mutation")
  @Patch(":strategyId")
  @UseGuards(CookieAuthGuard)
  async update(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
    @Body() body: unknown,
  ): Promise<StrategySummaryResponse> {
    const patch = parseUpdateStrategyRequest(body);
    return this.execute(() =>
      this.strategies.updateStrategy(user, strategyId, patch),
    );
  }

  /** Replaces the COMPLETE definition atomically and returns the canonical normalized result. */
  @RateLimit("mutation")
  @Put(":strategyId/definition")
  @UseGuards(CookieAuthGuard)
  async replaceDefinition(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
    @Body() body: unknown,
  ): Promise<StrategyDetailResponse> {
    const definition = parseReplaceStrategyDefinitionRequest(body);
    return this.execute(() =>
      this.strategies.replaceDefinition(user, strategyId, definition),
    );
  }

  @RateLimit("mutation")
  @Delete(":strategyId")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
  ): Promise<void> {
    await this.execute(() => this.strategies.deleteStrategy(user, strategyId));
  }

  /**
   * Maps the service's product errors onto HTTP. A rejected strategy answers 400 carrying the
   * canonical validator's path-addressed issues, so the Builder can attach each one to the row
   * that produced it instead of showing a dead-end banner. Anything unrecognized stays an
   * internal error: a database failure must not masquerade as a client mistake.
   */
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StrategyNotFoundError) {
        throw new NotFoundException(error.message);
      }
      // The strategy exists and is the caller's; something still references it. That is a conflict
      // with the current state, not a malformed request.
      if (error instanceof StrategyInUseByMonitorError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof StrategyValidationError) {
        const body: StrategyValidationErrorResponse = {
          message: error.message,
          code: STRATEGY_INVALID_CODE,
          issues: [...error.issues],
        };
        throw new BadRequestException(body);
      }
      throw error;
    }
  }
}
