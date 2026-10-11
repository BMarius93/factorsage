import type {
  AdminHealthResponse,
  BuiltInContentAdminResponse,
  CongressMemberCatalogSyncResponse,
  SecurityCatalogSyncResponse,
} from "@intrinsic/contracts";
import type {
  CongressMemberCatalogService,
  SecurityCatalogService,
} from "@intrinsic/stock-data";
import {
  ConflictException,
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
import { BuiltInAdminService } from "../builtins/builtin-admin.service";
import { RolesGuard } from "../auth/roles.guard";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  CONGRESS_MEMBER_CATALOG_SERVICE,
  SECURITY_CATALOG_SERVICE,
} from "../stocks/stock-data.tokens";

@Controller("admin")
@UseGuards(CookieAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  constructor(
    @Inject(SECURITY_CATALOG_SERVICE)
    private readonly securityCatalog: SecurityCatalogService,
    @Inject(CONGRESS_MEMBER_CATALOG_SERVICE)
    private readonly memberCatalog: CongressMemberCatalogService,
    @Inject(BuiltInAdminService)
    private readonly builtIns: BuiltInAdminService,
  ) {}

  /**
   * Every built-in List, Strategy and Monitor, published or not. They are edited through the
   * ordinary routes, which authorize an administrator for built-in content.
   */
  @RateLimit("standard-read")
  @Get("built-ins")
  async builtInContent(): Promise<BuiltInContentAdminResponse> {
    return this.builtIns.overview();
  }

  @RateLimit("standard-read")
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
  @RateLimit("admin-operation")
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

  /**
   * Explicitly synchronizes the member catalog — who a Congressional rule may select — with the
   * provider's member directory (`docs/development/congress-member-catalog.md`).
   *
   * Identity only, exactly as `securities/sync` is: it adds members and records the directory's
   * spelling of their names, and it loads no disclosure. It never removes a member. A run reads the
   * whole directory before it writes anything, so its answer is all three of these or none:
   *
   * - `200` — the directory was read whole and written; the counts say what changed.
   * - `409` — another run holds the claim. The provider was not asked.
   * - `503` — the directory could not be read whole. The catalog is exactly as it was; the code
   *   names why, and the run is in the log with its original error.
   */
  @RateLimit("admin-operation")
  @Post("congress-members/sync")
  // Like `securities/sync`, this reconciles a catalog rather than creating a resource at this URL.
  @HttpCode(HttpStatus.OK)
  async syncCongressMembers(): Promise<CongressMemberCatalogSyncResponse> {
    const startedAt = Date.now();
    const result = await this.memberCatalog.sync();
    switch (result.outcome) {
      case "COMPLETED":
        return {
          runSequence: result.runSequence,
          ...result.summary,
          durationMs: Date.now() - startedAt,
        };
      case "ALREADY_RUNNING":
        throw new ConflictException(
          "A member catalog synchronization is already running",
        );
      case "FAILED":
        // The decorator already logged the run with its original error. The code is this
        // product's own vocabulary, never anything a provider sent.
        throw new ServiceUnavailableException(
          `Member catalog synchronization could not complete (${result.code}); the catalog is unchanged`,
        );
      case "UP_TO_DATE":
        // Unreachable: this route asks for a run unconditionally. Stated so the switch is total.
        throw new ConflictException(
          "The member catalog is already synchronized",
        );
    }
  }
}
