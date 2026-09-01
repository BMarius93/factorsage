import type {
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { BuyWindowValidationError } from "@intrinsic/domain";
import {
  BadRequestException,
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
import {
  parseAddStockListItemsRequest,
  parseCreateStockListRequest,
  parseReplaceBuyWindowsRequest,
  parseUpdateStockListRequest,
} from "./stock-list-requests";
import {
  StockListItemNotFoundError,
  StockListNotFoundError,
  StockListsService,
  UnsupportedSecurityError,
} from "./stock-lists.service";

/**
 * User-owned stock lists. Every route requires an authenticated session and operates strictly on
 * the caller's own rows: the service scopes each query by the authenticated user id, and a list
 * that exists but belongs to someone else answers exactly like one that does not exist. There is
 * intentionally no ADMIN bypass.
 */
@Controller("lists")
@UseGuards(CookieAuthGuard)
export class ListsController {
  constructor(
    @Inject(StockListsService) private readonly lists: StockListsService,
  ) {}

  @Get()
  async listOwn(
    @CurrentUser() user: AuthUser,
  ): Promise<StockListSummaryResponse[]> {
    return this.lists.listForUser(user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<StockListDetailResponse> {
    const input = parseCreateStockListRequest(body);
    return this.execute(() => this.lists.createList(user.id, input));
  }

  @Get(":listId")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
  ): Promise<StockListDetailResponse> {
    return this.execute(() => this.lists.getList(user.id, listId));
  }

  @Patch(":listId")
  async update(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Body() body: unknown,
  ): Promise<StockListSummaryResponse> {
    const patch = parseUpdateStockListRequest(body);
    return this.execute(() => this.lists.updateList(user.id, listId, patch));
  }

  @Delete(":listId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
  ): Promise<void> {
    await this.execute(() => this.lists.deleteList(user.id, listId));
  }

  /**
   * Batch membership add. Idempotent — already-member securities are skipped, so the handler
   * reconciles state rather than creating a resource, and answers 200 with the updated list.
   */
  @Post(":listId/items")
  @HttpCode(HttpStatus.OK)
  async addItems(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Body() body: unknown,
  ): Promise<StockListDetailResponse> {
    const input = parseAddStockListItemsRequest(body);
    return this.execute(() =>
      this.lists.addItems(user.id, listId, input.securityIds),
    );
  }

  @Delete(":listId/items/:itemId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeItem(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Param("itemId") itemId: string,
  ): Promise<void> {
    await this.execute(() => this.lists.removeItem(user.id, listId, itemId));
  }

  /** Replaces the item's complete buy-window configuration and returns the canonical result. */
  @Put(":listId/items/:itemId/buy-windows")
  async replaceBuyWindows(
    @CurrentUser() user: AuthUser,
    @Param("listId") listId: string,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
  ): Promise<StockListItemResponse> {
    const input = parseReplaceBuyWindowsRequest(body);
    return this.execute(() =>
      this.lists.replaceBuyWindows(user.id, listId, itemId, input),
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
