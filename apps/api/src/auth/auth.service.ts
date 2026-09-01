import {
  EMAIL_NOT_VERIFIED_CODE,
  type AuthUser,
  type LoginRequest,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AUTH_LOGGER } from "./auth.tokens";
import { PasswordService } from "./password.service";
import { UsersService } from "./users.service";

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

export const EMAIL_NOT_VERIFIED_MESSAGE =
  "Verify your email address before signing in";

type LoginResult = {
  token: string;
  user: AuthUser;
};

function subjectFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("sub" in payload)) {
    return undefined;
  }

  return typeof payload.sub === "string" ? payload.sub : undefined;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async login(request: LoginRequest): Promise<LoginResult> {
    const user = await this.users.findForPasswordLogin(request.email);
    const passwordIsValid = await this.passwords.verify(
      user?.passwordHash,
      request.password,
    );

    // A missing account, a wrong password, and an external-identity-only account without a
    // local password all take the same constant-work path and produce the same failure.
    if (!user || !passwordIsValid) {
      this.logger.info({
        event: "auth.login.failed",
        reason: "invalid_credentials",
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    if (!user.emailVerifiedAt) {
      this.logger.info({
        event: "auth.login.failed",
        reason: "email_not_verified",
        actorUserId: user.id,
      });
      // Reaching this branch already required the correct password, so naming the reason does
      // not disclose anything the caller does not know, and it lets the UI offer a resend.
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: EMAIL_NOT_VERIFIED_MESSAGE,
        code: EMAIL_NOT_VERIFIED_CODE,
      });
    }

    this.logger.info({ event: "auth.login.succeeded", actorUserId: user.id });

    return {
      token: await this.issueToken(user.id),
      user: this.users.toAuthUser(user),
    };
  }

  /** Signs the standard FactorSage session token; every authenticated path issues it here. */
  issueToken(userId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId });
  }

  async authenticateToken(token: string): Promise<AuthUser> {
    let payload: unknown;

    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    const subject = subjectFromPayload(payload);
    if (!subject) {
      throw new UnauthorizedException();
    }

    const user = await this.users.findAuthUserById(subject);
    if (!user) {
      throw new UnauthorizedException();
    }

    return this.users.toAuthUser(user);
  }
}
