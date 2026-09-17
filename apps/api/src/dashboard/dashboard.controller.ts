import type { AuthUser, DashboardResponse } from "@intrinsic/contracts";
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { parseVisibilityRequest } from "./dashboard-requests";
import {
  BuiltInMonitorNotFoundError,
  DashboardService,
} from "./dashboard.service";

/**
 * The Dashboard: every current Monitor match and setup the viewer can see
 * (`docs/decisions/builtin-dashboard-signals-v1.md`).
 *
 * The read accepts a Guest, who sees the published built-ins with their default visibility. Hiding
 * or showing a built-in is a signed-in customer's own preference, so a Guest is refused with a 401
 * and nothing anonymous is ever stored.
 */
@Controller("dashboard")
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @RateLimit("standard-read")
  @Get()
  @UseGuards(OptionalCookieAuthGuard)
  async read(@Viewer() viewer: AuthUser | null): Promise<DashboardResponse> {
    return this.dashboard.getDashboard(viewer);
  }

  @RateLimit("mutation")
  @Put("monitors/:monitorId/visibility")
  @UseGuards(CookieAuthGuard)
  async setVisibility(
    @CurrentUser() user: AuthUser,
    @Param("monitorId") monitorId: string,
    @Body() body: unknown,
  ): Promise<{ monitorId: string; visible: boolean }> {
    const { visible } = parseVisibilityRequest(body);
    try {
      return await this.dashboard.setBuiltInVisibility(
        user,
        monitorId,
        visible,
      );
    } catch (error) {
      if (error instanceof BuiltInMonitorNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
