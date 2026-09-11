import type {
  AuthUser,
  MonitorDetailResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
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
  UseGuards,
} from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import {
  parseCreateMonitorRequest,
  parseUpdateMonitorRequest,
} from "./monitor-requests";
import {
  MonitorNotFoundError,
  MonitorReferenceNotFoundError,
  MonitorsService,
} from "./monitors.service";

/**
 * User-owned monitors. Every route requires an authenticated session and operates strictly on the
 * caller's own rows: the service scopes each query by the authenticated user id, and a monitor that
 * exists but belongs to someone else answers exactly like one that does not exist. There is
 * intentionally no ADMIN bypass.
 *
 * There is deliberately no route that triggers a scan. Cadence is an application decision
 * (`ai/product/monitors.md`), and a "scan now" endpoint would be a user-facing cadence control by
 * another name.
 */
@Controller("monitors")
@UseGuards(CookieAuthGuard)
export class MonitorsController {
  constructor(
    @Inject(MonitorsService) private readonly monitors: MonitorsService,
  ) {}

  @Get()
  async listOwn(
    @CurrentUser() user: AuthUser,
  ): Promise<MonitorSummaryResponse[]> {
    return this.monitors.listForUser(user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<MonitorDetailResponse> {
    const input = parseCreateMonitorRequest(body);
    return this.execute(() => this.monitors.createMonitor(user.id, input));
  }

  @Get(":monitorId")
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param("monitorId") monitorId: string,
  ): Promise<MonitorDetailResponse> {
    return this.execute(() => this.monitors.getMonitor(user.id, monitorId));
  }

  /** Name and `enabled` are the only user controls. */
  @Patch(":monitorId")
  async update(
    @CurrentUser() user: AuthUser,
    @Param("monitorId") monitorId: string,
    @Body() body: unknown,
  ): Promise<MonitorSummaryResponse> {
    const patch = parseUpdateMonitorRequest(body);
    return this.execute(() =>
      this.monitors.updateMonitor(user.id, monitorId, patch),
    );
  }

  @Delete(":monitorId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("monitorId") monitorId: string,
  ): Promise<void> {
    await this.execute(() => this.monitors.deleteMonitor(user.id, monitorId));
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
      if (error instanceof MonitorReferenceNotFoundError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
