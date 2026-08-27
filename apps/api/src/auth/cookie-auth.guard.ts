import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { setLogContext } from "@intrinsic/observability";
import { parse } from "cookie";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { AuthService } from "./auth.service";
import type { AuthenticatedRequest } from "./authenticated-request";

@Injectable()
export class CookieAuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookieHeader = request.headers.cookie;

    let token: string | undefined;
    try {
      token = cookieHeader
        ? parse(cookieHeader)[this.config.cookieName]
        : undefined;
    } catch {
      throw new UnauthorizedException();
    }

    if (!token) {
      throw new UnauthorizedException();
    }

    request.authUser = await this.auth.authenticateToken(token);
    setLogContext({ actorUserId: request.authUser.id });
    return true;
  }
}
