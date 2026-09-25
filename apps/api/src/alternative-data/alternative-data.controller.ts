import type {
  ActorGroupDetailResponse,
  ActorGroupSummaryResponse,
  AlternativeDataActorResponse,
  AuthUser,
} from "@intrinsic/contracts";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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
import {
  SystemContentProtectedError,
  SystemContentReadOnlyError,
} from "../builtins/content-access";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import {
  parseAddActorGroupMembersRequest,
  parseCreateActorGroupRequest,
  parseUpdateActorGroupRequest,
} from "./actor-group-requests";
import {
  ActorGroupFullError,
  ActorGroupInUseError,
  ActorGroupNotFoundError,
  ActorGroupsService,
  UnsupportedActorError,
} from "./actor-groups.service";

/**
 * The canonical actor catalog: members of Congress.
 *
 * Readable without a session, like the built-in lists: it is platform reference data grown by
 * ingestion rather than anybody's content, and the Strategy Builder needs it to label a saved rule's
 * scope before it knows who is looking.
 */
@Controller("alternative-data")
export class AlternativeDataController {
  constructor(
    @Inject(ActorGroupsService) private readonly groups: ActorGroupsService,
  ) {}

  @RateLimit("stock-search")
  @Get("actors")
  @UseGuards(OptionalCookieAuthGuard)
  async searchActors(
    @Query("q") term?: string,
    @Query("limit") limit?: string,
  ): Promise<AlternativeDataActorResponse[]> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
      throw new BadRequestException("Invalid request: limit must be a number");
    }
    return this.groups.searchActors({
      ...(term === undefined ? {} : { term }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
  }

  /**
   * Actors by id.
   *
   * It exists so the Strategy Builder can render the name behind a saved `ACTOR` scope without
   * guessing or searching for it. Ids are opaque, so an unknown one is simply absent from the result
   * rather than an error.
   */
  @RateLimit("standard-read")
  @Get("actors/resolve")
  @UseGuards(OptionalCookieAuthGuard)
  async resolveActors(
    @Query("ids") ids?: string,
  ): Promise<AlternativeDataActorResponse[]> {
    const requested = (ids ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (requested.length === 0) {
      return [];
    }
    return this.groups.findActors(requested);
  }
}

/**
 * Congress groups.
 *
 * A separate controller because they are a collection in their own right, mounted on their own path —
 * while the *product* presents them inside the Lists area rather than as a new top-level section, which
 * is a web-app composition decision and not an API one.
 *
 * Every rule here is the one `ListsController` follows: a Guest reads built-ins, a write needs a
 * session, another customer's group reads as missing, and a built-in is administrator-only and never
 * deleted.
 */
@Controller("actor-groups")
export class ActorGroupsController {
  constructor(
    @Inject(ActorGroupsService) private readonly groups: ActorGroupsService,
  ) {}

  @RateLimit("standard-read")
  @Get()
  @UseGuards(OptionalCookieAuthGuard)
  async list(
    @Viewer() viewer: AuthUser | null,
  ): Promise<ActorGroupSummaryResponse[]> {
    return this.groups.listForUser(viewer);
  }

  @RateLimit("mutation")
  @Post()
  @UseGuards(CookieAuthGuard)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<ActorGroupDetailResponse> {
    const input = parseCreateActorGroupRequest(body);
    return this.execute(() => this.groups.createGroup(user, input));
  }

  @RateLimit("standard-read")
  @Get(":groupId")
  @UseGuards(OptionalCookieAuthGuard)
  async getOne(
    @Viewer() viewer: AuthUser | null,
    @Param("groupId") groupId: string,
  ): Promise<ActorGroupDetailResponse> {
    return this.execute(() => this.groups.getGroup(viewer, groupId));
  }

  @RateLimit("mutation")
  @Patch(":groupId")
  @UseGuards(CookieAuthGuard)
  async update(
    @CurrentUser() user: AuthUser,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<ActorGroupSummaryResponse> {
    const patch = parseUpdateActorGroupRequest(body);
    return this.execute(() => this.groups.updateGroup(user, groupId, patch));
  }

  @RateLimit("mutation")
  @Delete(":groupId")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("groupId") groupId: string,
  ): Promise<void> {
    await this.execute(() => this.groups.deleteGroup(user, groupId));
  }

  /** Batch membership add. Idempotent, so it reconciles state and answers 200 with the group. */
  @RateLimit("mutation")
  @Post(":groupId/members")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.OK)
  async addMembers(
    @CurrentUser() user: AuthUser,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<ActorGroupDetailResponse> {
    const input = parseAddActorGroupMembersRequest(body);
    return this.execute(() =>
      this.groups.addMembers(user, groupId, input.actorIds),
    );
  }

  @RateLimit("mutation")
  @Delete(":groupId/members/:actorId")
  @UseGuards(CookieAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param("groupId") groupId: string,
    @Param("actorId") actorId: string,
  ): Promise<void> {
    await this.execute(() =>
      this.groups.removeMember(user, groupId, actorId),
    );
  }

  /**
   * Maps the service's product errors onto HTTP. Anything unrecognized stays an internal error: a
   * database failure must not masquerade as a client mistake.
   */
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ActorGroupNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof SystemContentReadOnlyError) {
        throw new ForbiddenException(error.message);
      }
      if (
        error instanceof SystemContentProtectedError ||
        error instanceof ActorGroupInUseError
      ) {
        // The group plainly exists and is the caller's; something still references it, or it is
        // platform content. Both are conflicts with the current state, not malformed requests.
        throw new ConflictException(error.message);
      }
      if (
        error instanceof UnsupportedActorError ||
        error instanceof ActorGroupFullError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
