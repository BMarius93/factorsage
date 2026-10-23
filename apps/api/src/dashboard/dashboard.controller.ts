import type {
  AuthUser,
  DashboardActivityResponse,
  DashboardResponse,
} from "@intrinsic/contracts";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  UseGuards,
} from "@nestjs/common";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { parseActivityQuery } from "./dashboard-requests";
import {
  DashboardService,
  InvalidActivityCursorError,
} from "./dashboard.service";

/**
 * The Dashboard: the Monitors the viewer can see and the activity of those Enabled for them
 * (`docs/decisions/builtin-dashboard-signals-v1.md`, `docs/decisions/monitor-eod-v2.md` §12).
 *
 * Both reads accept a Guest, who sees the published built-ins, all enabled by default. Enabling or
 * disabling any Monitor — a built-in for one's own account included — is `PATCH /monitors/:id`, so
 * nothing here writes and nothing anonymous is ever stored.
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
   * The Monitor Activity feed: end-of-day activations and market resolutions of the Monitors this
   * viewer has enabled, over the rolling 30-day window, newest session first. Readable by a Guest,
   * like the Dashboard.
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
}
