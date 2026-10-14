import type {
  AuthUser,
  DashboardActivityResponse,
  DashboardResponse,
} from "@intrinsic/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  parseActivityQuery,
  parseVisibilityRequest,
} from "./dashboard-requests";
import {
  BuiltInMonitorNotFoundError,
  DashboardService,
  InvalidActivityCursorError,
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

  /**
   * The Monitor Activity feed: observed activations and market resolutions on the Monitors this
   * viewer's Dashboard shows, newest session first. Readable by a Guest, like the Dashboard.
   */
  @RateLimit("standard-read")
  @Get("activity")
  @UseGuards(OptionalCookieAuthGuard)
  async activity(
    @Viewer() viewer: AuthUser | null,
    @Query() query: unknown,
  ): Promise<DashboardActivityResponse> {
    try {
      return await this.dashboard.getActivity(
        viewer,
        parseActivityQuery(query),
      );
    } catch (error) {
      if (error instanceof InvalidActivityCursorError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
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
