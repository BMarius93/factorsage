import type { AuthUser, DashboardActivityResponse } from "@intrinsic/contracts";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { parseMonitorActivityQuery } from "./dashboard-requests";
import {
  DashboardService,
  InvalidActivityCursorError,
  MonitorActivityNotFoundError,
} from "./dashboard.service";

/**
 * One Monitor's Activity history: the Dashboard feed's events, over that Monitor alone.
 *
 * Served from the Dashboard's module because it *is* the Dashboard's feed — the same reader, the
 * same events, cursors and `through` re-reads — while it lives at the Monitor's own address. It is
 * visible exactly where the Monitor's page is, so a Guest reads a published built-in's history.
 */
@Controller("monitors")
export class MonitorActivityController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @RateLimit("standard-read")
  @Get(":monitorId/activity")
  @UseGuards(OptionalCookieAuthGuard)
  async activity(
    @Viewer() viewer: AuthUser | null,
    @Param("monitorId") monitorId: string,
    @Query() query: unknown,
  ): Promise<DashboardActivityResponse> {
    try {
      return await this.dashboard.getMonitorActivity(
        viewer,
        monitorId,
        parseMonitorActivityQuery(query),
      );
    } catch (error) {
      if (error instanceof InvalidActivityCursorError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof MonitorActivityNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
