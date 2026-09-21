import type {
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { BuyWindowValidationError } from "@intrinsic/domain";
import {
  BadRequestException,
  ConflictException,
  Body,
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
import type { AuthUser } from "@intrinsic/contracts";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  parseAddStockListItemsRequest,
  parseCreateStockListRequest,
  parseDuplicateStockListRequest,
  parseReplaceBuyWindowsRequest,
  parseUpdateStockListRequest,
} from "./stock-list-requests";
import {
  StockListInUseByMonitorError,
  StockListItemNotFoundError,
  StockListNotFoundError,
  StockListsService,
  UnsupportedSecurityError,
} from "./stock-lists.service";

/**
 * Stock lists: the caller's own, plus the platform's built-ins.
 *
 * Reads accept a Guest, who sees built-ins only (`docs/decisions/entitlements-v1.md` lets every
 * viewer see built-in content). Every write requires a session. A list that exists but belongs to
 * another customer answers exactly like one that does not exist, for administrators too; a
 * built-in may be changed by an administrator only, and is never deleted.
 */
@Controller("lists")
export class ListsController {
  constructor(
    @Inject(StockListsService) private readonly lists: StockListsService,
  ) {}

  @RateLimit("standard-read")
  @Get()
  @UseGuards(OptionalCookieAuthGuard)
  async listOwn(
    @Viewer() viewer: AuthUser | null,
  ): Promise<StockListSummaryResponse[]> {
    return this.lists.listForUser(viewer);
  }

  @RateLimit("mutation")
  @Post()
  @UseGuards(CookieAuthGuard)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<StockListDetailResponse> {
    const input = parseCreateStockListRequest(body);
    return this.execute(() => this.lists.createList(user, input));
  }

  /**
   * Copies a list the caller can read — their own, or a built-in — into a new list they own, and
   * answers with the copy. The source is only read.
   */
  @RateLimit("mutation")
  @Post(":listId/duplicate")
  @UseGuards(CookieAuthGuard)
  async duplicate(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Body() body: unknown,
  ): Promise<StockListDetailResponse> {
    const input = parseDuplicateStockListRequest(body);
    return this.execute(() => this.lists.duplicateList(user, listId, input));
  }

  @RateLimit("standard-read")
  @Get(":listId")
  @UseGuards(OptionalCookieAuthGuard)
  async getOne(
    @Viewer() viewer: AuthUser | null,
    @Param("listId") listId: string,
  ): Promise<StockListDetailResponse> {
    return this.execute(() => this.lists.getList(viewer, listId));
  }

  @RateLimit("mutation")
  @Patch(":listId")
  @UseGuards(CookieAuthGuard)
  async update(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Body() body: unknown,
  ): Promise<StockListSummaryResponse> {
    const patch = parseUpdateStockListRequest(body);
    return this.execute(() => this.lists.updateList(user, listId, patch));
  }

  @RateLimit("mutation")
  @Delete(":listId")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
  ): Promise<void> {
    await this.execute(() => this.lists.deleteList(user, listId));
  }

  /**
   * Batch membership add. Idempotent — already-member securities are skipped, so the handler
   * reconciles state rather than creating a resource, and answers 200 with the updated list.
   */
  @RateLimit("mutation")
  @Post(":listId/items")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.OK)
  async addItems(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Body() body: unknown,
  ): Promise<StockListDetailResponse> {
    const input = parseAddStockListItemsRequest(body);
    return this.execute(() =>
      this.lists.addItems(user, listId, input.securityIds),
    );
  }

  @RateLimit("mutation")
  @Delete(":listId/items/:itemId")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeItem(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Param("itemId") itemId: string,
  ): Promise<void> {
    await this.execute(() => this.lists.removeItem(user, listId, itemId));
  }

  /** Replaces the item's complete buy-window configuration and returns the canonical result. */
  @RateLimit("mutation")
  @Put(":listId/items/:itemId/buy-windows")
  @UseGuards(CookieAuthGuard)
  async replaceBuyWindows(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
  ): Promise<StockListItemResponse> {
    const input = parseReplaceBuyWindowsRequest(body);
    return this.execute(() =>
      this.lists.replaceBuyWindows(user, listId, itemId, input),
    );
  }

  /**
   * Maps the service's product errors onto HTTP. Anything unrecognized stays an internal error:
   * a database failure must not masquerade as a client mistake.
   */
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof StockListNotFoundError ||
        error instanceof StockListItemNotFoundError
      ) {
        throw new NotFoundException(error.message);
      }
      // The list exists and is the caller's; something still references it. That is a conflict with
      // the current state, not a malformed request.
      if (error instanceof StockListInUseByMonitorError) {
        throw new ConflictException(error.message);
      }
      if (
        error instanceof UnsupportedSecurityError ||
        error instanceof BuyWindowValidationError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
