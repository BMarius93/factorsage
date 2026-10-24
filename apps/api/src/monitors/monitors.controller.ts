import type {
  AuthUser,
  MonitorDetailResponse,
  MonitorDetailSummaryResponse,
  MonitorSignalPageResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { MONITOR_FAIR_USE_LIMIT_CODE } from "@intrinsic/contracts";
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
  Query,
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { Viewer } from "../auth/viewer.decorator";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  parseCreateMonitorRequest,
  parseSignalTableQuery,
  parseUpdateMonitorRequest,
} from "./monitor-requests";
import {
  InvalidSignalCursorError,
  SignalTableChangedError,
} from "./monitor-signal-table";
import {
  MonitorNotFoundError,
  MonitorFairUseLimitError,
  MonitorReferenceNotFoundError,
  MonitorRequestError,
  MonitorsService,
} from "./monitors.service";

/**
 * Monitors. A customer's own Monitors, plus the platform's built-ins: a published built-in is
 * readable by anyone, Guests included; only an administrator may change one, and none is ever
 * deleted. A monitor that belongs to another customer answers exactly like one that does not exist,
 * for administrators too.
 *
 * There is deliberately no route that triggers a scan. Cadence is an application decision
 * (`ai/product/monitors.md`), and a "scan now" endpoint would be a user-facing cadence control by
 * another name.
 */
@Controller("monitors")
export class MonitorsController {
  constructor(
    @Inject(MonitorsService) private readonly monitors: MonitorsService,
  ) {}

  /**
   * Readable by a Guest, who receives the published built-ins alone. A signed-in caller also
   * receives their own Monitors, and each built-in carries their Dashboard visibility preference.
   */
  @RateLimit("standard-read")
  @Get()
  @UseGuards(OptionalCookieAuthGuard)
  async listOwn(
    @Viewer() viewer: AuthUser | null,
  ): Promise<MonitorSummaryResponse[]> {
    return this.monitors.listForUser(viewer);
  }

  @RateLimit("monitor-mutation")
  @Post()
  @UseGuards(CookieAuthGuard)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<MonitorDetailResponse> {
    const input = parseCreateMonitorRequest(body);
    return this.execute(() => this.monitors.createMonitor(user, input));
  }

  /** Readable by a Guest for a published built-in; everything else needs its owner. */
  @RateLimit("standard-read")
  @Get(":monitorId")
  @UseGuards(OptionalCookieAuthGuard)
  async getOne(
    @Viewer() viewer: AuthUser | null,
    @Param("monitorId") monitorId: string,
    @Query("view") view?: unknown,
  ): Promise<MonitorDetailResponse | MonitorDetailSummaryResponse> {
    // `?view=summary` is the page as it renders: no per-member rows, no newest Signals, the
    // members counted. Without it, the full detail, unchanged.
    return view === "summary"
      ? this.execute(() => this.monitors.getMonitorSummary(viewer, monitorId))
      : this.execute(() => this.monitors.getMonitor(viewer, monitorId));
  }

  /**
   * The Monitor's Signal table: active occurrences first, then resolved ones, each with its Why;
   * waiting setups when asked for. Visible exactly where the Monitor is.
   */
  @RateLimit("standard-read")
  @Get(":monitorId/signals")
  @UseGuards(OptionalCookieAuthGuard)
  async signals(
    @Viewer() viewer: AuthUser | null,
    @Param("monitorId") monitorId: string,
    @Query() query: unknown,
  ): Promise<MonitorSignalPageResponse> {
    const parsed = parseSignalTableQuery(query);
    return this.execute(() =>
      this.monitors.getSignalTable(viewer, monitorId, parsed),
    );
  }

  /**
   * The user controls: the name, whether it is enabled, and which Strategy and Stock List it
   * watches. Changing either reference rebinds the Monitor, which the service handles as a
   * configuration boundary. There is still no cadence to set.
   */
  @RateLimit("monitor-mutation")
  @Patch(":monitorId")
  @UseGuards(CookieAuthGuard)
  async update(
    @CurrentUser() user: AuthUser,
    @Param("monitorId") monitorId: string,
    @Body() body: unknown,
  ): Promise<MonitorSummaryResponse> {
    const patch = parseUpdateMonitorRequest(body);
    return this.execute(() =>
      this.monitors.updateMonitor(user, monitorId, patch),
    );
  }

  @RateLimit("monitor-mutation")
  @Delete(":monitorId")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("monitorId") monitorId: string,
  ): Promise<void> {
    await this.execute(() => this.monitors.deleteMonitor(user, monitorId));
  }

  /**
   * Maps the service's product errors onto HTTP. A missing monitor is a 404; a monitor referencing
   * a strategy or list the caller does not own is a 400 naming which reference failed, because the
   * monitor itself is not what is missing. Anything unrecognized stays an internal error: a
   * database failure must not masquerade as a client mistake.
   */
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MonitorNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (
        error instanceof MonitorReferenceNotFoundError ||
        error instanceof MonitorRequestError ||
        error instanceof InvalidSignalCursorError
      ) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof SignalTableChangedError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof MonitorFairUseLimitError) {
        // Capacity protection, not a plan limit: a 409 with its own code, never an entitlement 403.
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          message: error.message,
          code: MONITOR_FAIR_USE_LIMIT_CODE,
          limit: error.limit,
        });
      }
      throw error;
    }
  }
}
