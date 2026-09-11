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
import {
  StrategiesService,
  StrategyInUseByMonitorError,
  StrategyNotFoundError,
} from "./strategies.service";
import {
  parseCreateStrategyRequest,
  parseReplaceStrategyDefinitionRequest,
  parseUpdateStrategyRequest,
} from "./strategy-requests";

/**
 * User-owned strategies. Every route requires an authenticated session and operates strictly on
 * the caller's own rows: the service scopes each query by the authenticated user id, and a
 * strategy that exists but belongs to someone else answers exactly like one that does not exist.
 * There is intentionally no ADMIN bypass.
 */
@Controller("strategies")
@UseGuards(CookieAuthGuard)
export class StrategiesController {
  constructor(
    @Inject(StrategiesService) private readonly strategies: StrategiesService,
  ) {}

  @Get()
  async listOwn(
    @CurrentUser() user: AuthUser,
  ): Promise<StrategySummaryResponse[]> {
    return this.strategies.listForUser(user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<StrategyDetailResponse> {
    const input = parseCreateStrategyRequest(body);
    return this.execute(() => this.strategies.createStrategy(user.id, input));
  }

  @Get(":strategyId")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
  ): Promise<StrategyDetailResponse> {
    return this.execute(() => this.strategies.getStrategy(user.id, strategyId));
  }

  @Patch(":strategyId")
  async update(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
    @Body() body: unknown,
  ): Promise<StrategySummaryResponse> {
    const patch = parseUpdateStrategyRequest(body);
    return this.execute(() =>
      this.strategies.updateStrategy(user.id, strategyId, patch),
    );
  }

  /** Replaces the COMPLETE definition atomically and returns the canonical normalized result. */
  @Put(":strategyId/definition")
  async replaceDefinition(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
    @Body() body: unknown,
  ): Promise<StrategyDetailResponse> {
    const definition = parseReplaceStrategyDefinitionRequest(body);
    return this.execute(() =>
      this.strategies.replaceDefinition(user.id, strategyId, definition),
    );
  }

  @Delete(":strategyId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("strategyId") strategyId: string,
  ): Promise<void> {
    await this.execute(() =>
      this.strategies.deleteStrategy(user.id, strategyId),
    );
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
