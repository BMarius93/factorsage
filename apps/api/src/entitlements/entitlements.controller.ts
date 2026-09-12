import type { AuthUser, EntitlementsResponse } from "@intrinsic/contracts";
import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { OptionalCookieAuthGuard } from "../auth/optional-cookie-auth.guard";
import { EntitlementsService } from "./entitlements.service";

/**
 * What the current caller is entitled to.
 *
 * Deliberately readable **without** a session: a Guest is an access state, not an account, so this
 * route resolves guest entitlements and creates nothing. That is what lets the marketing and stock
 * surfaces tell a signed-out visitor what they would get, with no anonymous row to clean up later.
 *
 * The response is advisory. `docs/decisions/entitlements-v1.md` section 13 is explicit that UI
 * checks are convenience only: a client that ignores this entirely, or forges a better-looking
 * copy of it, must still be unable to exceed a single limit, because every limit is enforced again
 * at the mutation boundary from persisted plan and role.
 */
@Controller("entitlements")
@UseGuards(OptionalCookieAuthGuard)
export class EntitlementsController {
  constructor(
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  read(@Req() request: AuthenticatedRequest): EntitlementsResponse {
    const user: AuthUser | undefined = request.authUser;
    if (!user) {
      return {
        principal: "GUEST",
        entitlements: this.entitlements.guestEntitlements(),
      };
    }
    return {
      principal: "AUTHENTICATED",
      plan: user.plan,
      role: user.role,
      entitlements: this.entitlements.entitlementsOf(user),
    };
  }
}
