import type {
  AdminHealthResponse,
  SecurityCatalogSyncResponse,
} from "@intrinsic/contracts";
import type { SecurityCatalogService } from "@intrinsic/stock-data";
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SECURITY_CATALOG_SERVICE } from "../stocks/stock-data.tokens";

@Controller("admin")
@UseGuards(CookieAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  constructor(
    @Inject(SECURITY_CATALOG_SERVICE)
    private readonly securityCatalog: SecurityCatalogService,
  ) {}

  @Get("health")
  health(): AdminHealthResponse {
    return {
      status: "ok",
      role: "ADMIN",
    };
  }

  /**
   * Explicitly synchronizes the supported stock catalog from the provider universe.
   *
   * `Security` is the catalog of supported stocks, and this is the only path that adds to it.
   * Catalog identity only: prices, fundamentals, derived state and intrinsic values stay lazy and
   * load when a stock is actually opened.
   */
  @Post("securities/sync")
  // Synchronization reconciles an existing catalog rather than creating a resource at this URL.
  @HttpCode(HttpStatus.OK)
  async syncSecurities(): Promise<SecurityCatalogSyncResponse> {
    const startedAt = Date.now();
    try {
      const { summary } = await this.securityCatalog.sync();
      return { ...summary, durationMs: Date.now() - startedAt };
    } catch {
      // The decorator already logged the original error with its stack; the client only needs to
      // know the provider-backed synchronization could not complete.
      throw new ServiceUnavailableException(
        "Security catalog synchronization is temporarily unavailable",
      );
    }
  }
}
