import type { AuthUser, StockSearchResultResponse } from "@intrinsic/contracts";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  parseRecentSecurityIds,
  parseRecordSecurityViewRequest,
} from "./recent-search-requests";
import {
  RecentSecuritiesService,
  UnsupportedSecurityError,
} from "./recent-securities.service";

/**
 * The securities the caller viewed most recently — the RECENT SEARCHES section of the global
 * search dropdown.
 *
 * A top-level resource rather than a `/stocks/...` route on purpose: `StocksController` matches
 * `:symbol` and a sibling controller cannot guarantee it is consulted first, so a `/stocks/`
 * sub-path declared elsewhere would be one module-ordering change away from resolving as a ticker
 * lookup.
 *
 * Rows are a projection of the same `StockSearchResultResponse` search itself returns: the dropdown
 * renders one kind of row, so there is one wire shape for it.
 */
@Controller("recent-searches")
export class RecentSearchesController {
  constructor(
    @Inject(RecentSecuritiesService)
    private readonly recents: RecentSecuritiesService,
  ) {}

  /**
   * The caller's recents, newest first, at most `RECENT_SECURITY_LIMIT`.
   *
   * Readable without a session, because a Guest has recents too — they just live in that browser
   * rather than in PostgreSQL (`docs/decisions/entitlements-v1.md` keeps the guest state stateless,
   * so there is no anonymous row to store them in). A Guest therefore sends the ids it stored and
   * this resolves them against the live catalog; an authenticated caller's set comes from the
   * database and `ids` is ignored entirely, so nothing a client sends can add to or reorder it.
   */
  @RateLimit("stock-search")
  @Get()
  @UseGuards(OptionalCookieAuthGuard)
  async list(
    @Req() request: AuthenticatedRequest,
    @Query("ids") ids?: string | string[],
  ): Promise<StockSearchResultResponse[]> {
    const user: AuthUser | undefined = request.authUser;
    if (user) {
      return this.recents.listForUser(user.id);
    }
    return this.recents.resolveIds(parseRecentSecurityIds(ids));
  }

  /**
   * Records that the caller opened one security's Stock Details page.
   *
   * Authenticated-only: a Guest's recents never reach the server, so there is nothing here for one
   * to do and a silent 204 would be a write that pretends to have happened. Guests get a 401, which
   * the client treats the same way it treats every other failure of this call — it is convenience
   * UI, and nothing about the page depends on it succeeding.
   */
  @RateLimit("mutation")
  @Post()
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async record(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<void> {
    const { securityId } = parseRecordSecurityViewRequest(body);
    try {
      await this.recents.recordView(user.id, securityId);
    } catch (error) {
      if (error instanceof UnsupportedSecurityError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
