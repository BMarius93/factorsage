import type {
  ForgotPasswordRequest,
  ResetPasswordRequest,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { AUTH_LOGGER } from "./auth.tokens";
import { AuthEmailService } from "./auth-email.service";
import { PasswordResetService } from "./password-reset.service";
import { PasswordService } from "./password.service";
import { UsersService } from "./users.service";

export const INVALID_RESET_TOKEN_MESSAGE =
  "This password reset link is invalid or has expired";

/**
 * Forgotten-password recovery.
 *
 * The request half never tells the caller anything: an unknown address, an address whose account
 * signs in with Google and has no local password, and an address that really was mailed a link
 * are indistinguishable from outside, so this endpoint cannot be turned into an account
 * directory. The redemption half is where the actual proof happens — possession of a link that
 * only ever existed in that inbox.
 */
@Injectable()
export class PasswordRecoveryService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(PasswordResetService)
    private readonly resets: PasswordResetService,
    @Inject(AuthEmailService) private readonly email: AuthEmailService,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async requestReset(request: ForgotPasswordRequest): Promise<void> {
    const user = await this.users.findByEmail(request.email);

    // An account with no local password has nothing to reset: it signs in through Google, and
    // minting a password for it here would add a second credential its owner never asked for.
    if (!user || !user.passwordHash) {
      this.logger.debug({
        event: "auth.password.reset.requested.ignored",
        ...(user ? { actorUserId: user.id, reason: "no_local_password" } : {}),
      });
      return;
    }

    // Issuing rotates the user's outstanding token, so a previously mailed link stops working.
    const issued = await this.resets.issueToken(user.id);
    const startedAt = Date.now();

    try {
      await this.email.sendPasswordResetEmail({
        to: user.email,
        token: issued.token,
      });
    } catch (err) {
      // Deliberately not surfaced. Only an address that has a local account reaches the mail
      // transport at all, so failing the response here would answer the exact question this
      // endpoint exists not to answer. The failure is loud in the logs instead, and the caller
      // is free to ask again.
      this.logger.error({
        event: "auth.password.reset.send.failed",
        actorUserId: user.id,
        durationMs: Date.now() - startedAt,
        err,
      });
      return;
    }

    this.logger.info({
      event: "auth.password.reset.requested",
      actorUserId: user.id,
      durationMs: Date.now() - startedAt,
    });
  }

  async resetPassword(request: ResetPasswordRequest): Promise<void> {
    // Hashing is deliberately slow, so it happens before the transaction rather than inside it.
    // A hash computed for a token that turns out to be invalid is simply discarded.
    const passwordHash = await this.passwords.hash(request.password);
    const userId = await this.resets.redeemToken({
      token: request.token,
      passwordHash,
    });

    if (!userId) {
      this.logger.info({ event: "auth.password.reset.rejected" });
      throw new UnauthorizedException(INVALID_RESET_TOKEN_MESSAGE);
    }

    this.logger.info({
      event: "auth.password.reset.completed",
      actorUserId: userId,
    });
  }
}
