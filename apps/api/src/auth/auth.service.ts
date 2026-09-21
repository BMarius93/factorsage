import type { AuthUser, LoginRequest } from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
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

type LoginResult = {
  token: string;
  user: AuthUser;
};

/**
 * A validated session: who the caller is, plus the compliance state the acceptance gate reads.
 *
 * `termsAccepted` rides on the identity read rather than being fetched separately, so the two
 * can never describe different moments. It is never a response field — `/auth/me` still returns
 * `id`, `email`, `role` and `plan` and nothing else; `GET /legal/acceptance` is where a client
 * asks about acceptance.
 */
export type AuthenticatedSession = {
  readonly user: AuthUser;
  readonly termsAccepted: boolean;
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

    // A missing account, a wrong password, an external-identity-only account without a local
    // password, and an account that has never been verified all take the same constant-work path
    // and produce the same failure (AUTH-003). An unverified account has no credential anybody
    // proved: since AUTH-003 it has no password at all, and a row registered before it holds only
    // a password chosen by whoever typed the address. Answering anything but the generic `401`
    // would tell the caller a pending account exists.
    if (!user || !passwordIsValid || !user.emailVerifiedAt) {
      this.logger.info({
        event: "auth.login.failed",
        reason:
          user && passwordIsValid
            ? "email_not_verified"
            : "invalid_credentials",
        ...(user && passwordIsValid ? { actorUserId: user.id } : {}),
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
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
  async authenticateToken(token: string): Promise<AuthenticatedSession> {
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

    return {
      user: this.users.toAuthUser(user),
      termsAccepted: this.users.hasAcceptedRequiredTerms(user),
    };
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
