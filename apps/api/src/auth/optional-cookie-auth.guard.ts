import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { setLogContext } from "@intrinsic/observability";
import { parse } from "cookie";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { AuthService } from "./auth.service";
import type { AuthenticatedRequest } from "./authenticated-request";

/**
 * Resolves the session when there is one, and admits the request either way.
 *
 * The companion of `CookieAuthGuard` for routes whose answer differs for a Guest rather than being
 * refused to one. It never creates anything: "no session" resolves to the Guest access state, and
 * `docs/decisions/entitlements-v1.md` requires that to stay stateless — no anonymous `User` row,
 * no temporary account, nothing to merge or clean up.
 *
 * An invalid, expired or forged token is treated exactly like no token at all. It must not be an
 * error here — a stale cookie would otherwise make a public page fail instead of rendering the
 * signed-out view — and it must not be trusted either, so it resolves to Guest.
 */
@Injectable()
export class OptionalCookieAuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) {
      return true;
    }

    let token: string | undefined;
    try {
      token = parse(cookieHeader)[this.config.cookieName];
    } catch {
      return true;
    }
    if (!token) {
      return true;
    }

    try {
      request.authUser = await this.auth.authenticateToken(token);
      setLogContext({ actorUserId: request.authUser.id });
    } catch {
      // Deliberately silent: an unusable cookie is the signed-out state, not a failure.
    }
    return true;
  }
}
