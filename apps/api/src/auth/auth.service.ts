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
import {
  isCurrentSession,
  parseSessionClaims,
  SESSION_VERSION_CLAIM,
} from "./session-token";
import { UsersService } from "./users.service";

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

export const EMAIL_NOT_VERIFIED_MESSAGE =
  "Verify your email address before signing in";

type LoginResult = {
  token: string;
  user: AuthUser;
};

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

    // The version comes from the row read that found the password valid, not from a later read:
    // a reset that commits while Argon2id runs must leave this token already revoked.
    return {
      token: await this.issueToken(user.id, user.sessionVersion),
      user: this.users.toAuthUser(user),
    };
  }

  /**
   * Signs the standard FactorSage session token; every authenticated path issues it here.
   *
   * `sessionVersion` must be the value on the same row read that authorised the sign-in. The
   * claim is always written, including `0`, so no newly issued token is ever a legacy one.
   */
  issueToken(userId: string, sessionVersion: number): Promise<string> {
    return this.jwt.signAsync({
      sub: userId,
      [SESSION_VERSION_CLAIM]: sessionVersion,
    });
  }

  /**
   * Resolves a session token to its user, or throws the generic `401`.
   *
   * Every failure — bad signature, expiry, malformed claims, a missing account, a revoked session
   * — throws the same detail-free exception, so a caller cannot tell a revoked token from an
   * expired or forged one. Both cookie guards call this and nothing else validates a session.
   */
  async authenticateToken(token: string): Promise<AuthUser> {
    let payload: unknown;

    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    const claims = parseSessionClaims(payload);
    if (!claims) {
      throw new UnauthorizedException();
    }

    // The same single read as before the version existed; the column rides on its select.
    const user = await this.users.findAuthUserById(claims.subject);
    if (
      !user ||
      !isCurrentSession(claims.sessionVersion, user.sessionVersion)
    ) {
      throw new UnauthorizedException();
    }

    return this.users.toAuthUser(user);
  }

  /**
   * "Sign out everywhere": ends every session of the account, including the caller's.
   *
   * One atomic increment. Tokens issued before it carry an older version and fail their next
   * request; concurrent calls may increment more than once, which only moves the version further
   * from every revoked token.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.users.incrementSessionVersion(userId);
    this.logger.info({
      event: "auth.sessions.revoked",
      actorUserId: userId,
      reason: "sign_out_everywhere",
    });
  }
}
