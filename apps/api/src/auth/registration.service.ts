import type {
  RegisterRequest,
  ResendVerificationRequest,
  VerifyEmailRequest,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AUTH_LOGGER } from "./auth.tokens";
import { AuthEmailService } from "./auth-email.service";
import { EmailVerificationService } from "./email-verification.service";
import { PasswordService } from "./password.service";
import { UsersService } from "./users.service";

/**
 * Identical for an existing local account and for an existing external-identity-only account, so
 * registration never reveals which kind of account holds the address and never attaches a
 * password to an account the caller has not proven they own.
 */
export const EMAIL_TAKEN_MESSAGE = "An account with this email already exists";

export const INVALID_VERIFICATION_TOKEN_MESSAGE =
  "This verification link is invalid or has expired";

export const VERIFICATION_EMAIL_FAILED_MESSAGE =
  "The verification email could not be sent. Please request a new link.";

/**
 * Local email/password registration and the email-verification lifecycle.
 *
 * A new local user always starts unverified and cannot password-login until a verification token
 * from their inbox is redeemed. Redeeming it sets the account's password: the one given at
 * registration only lets the registrant be told to verify, and never becomes a working credential
 * (AUTH-002).
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(EmailVerificationService)
    private readonly verification: EmailVerificationService,
    @Inject(AuthEmailService) private readonly email: AuthEmailService,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async register(request: RegisterRequest): Promise<void> {
    const existing = await this.users.findByEmail(request.email);
    if (existing) {
      this.logger.info({
        event: "auth.register.rejected",
        reason: existing.passwordHash ? "local_account_exists" : "external_account_exists",
      });
      throw new ConflictException(EMAIL_TAKEN_MESSAGE);
    }

    const passwordHash = await this.passwords.hash(request.password);
    const user = await this.users.createLocalUser({
      email: request.email,
      passwordHash,
    });
    this.logger.info({
      event: "auth.register.completed",
      actorUserId: user.id,
    });

    await this.sendVerification(user.id, user.email);
  }

  /**
   * Redeems a verification link and installs the password its holder chose (AUTH-002).
   *
   * The password registration stored is never what this activates: anyone can register an
   * address, and only the holder of the link has proven control of the mailbox.
   */
  async verifyEmail(request: VerifyEmailRequest): Promise<void> {
    // Cheap first, expensive second, exactly as a reset: a SHA-256 and one indexed read keep
    // invented tokens from costing a full Argon2id each. Not authoritative — the transaction
    // re-checks everything, and both rejection paths answer identically.
    if (!(await this.verification.hasRedeemableToken(request.token))) {
      this.logger.info({
        event: "auth.email.verification.rejected",
        reason: "no_redeemable_token",
      });
      throw new UnauthorizedException(INVALID_VERIFICATION_TOKEN_MESSAGE);
    }

    // Hashed before the transaction, which must not be held open across Argon2id. A hash
    // computed for a token that is consumed in the meantime is simply discarded.
    const passwordHash = await this.passwords.hash(request.password);
    // Consuming the token, installing the password, verifying the address and revoking earlier
    // sessions are one atomic step.
    const userId = await this.verification.redeemToken({
      token: request.token,
      passwordHash,
    });
    if (!userId) {
      this.logger.info({
        event: "auth.email.verification.rejected",
        reason: "token_not_redeemed",
      });
      throw new UnauthorizedException(INVALID_VERIFICATION_TOKEN_MESSAGE);
    }

    this.logger.info({
      event: "auth.email.verification.completed",
      actorUserId: userId,
    });
    this.logger.info({
      event: "auth.sessions.revoked",
      actorUserId: userId,
      reason: "email_verification",
    });
  }

  /**
   * Rotates and resends a verification token.
   *
   * Callers always receive the same accepted response: an unknown address, an already-verified
   * account, and an external-identity-only account are all silently no-ops so this endpoint
   * cannot be used to enumerate accounts.
   */
  async resendVerification(request: ResendVerificationRequest): Promise<void> {
    const user = await this.users.findByEmail(request.email);
    if (!user || !user.passwordHash || user.emailVerifiedAt) {
      this.logger.debug({ event: "auth.email.verification.resend.ignored" });
      return;
    }

    await this.sendVerification(user.id, user.email);
  }

  private async sendVerification(userId: string, email: string): Promise<void> {
    // Issuing rotates the user's outstanding token, so a previously mailed link stops working.
    const issued = await this.verification.issueToken(userId);
    const startedAt = Date.now();

    try {
      await this.email.sendVerificationEmail({ to: email, token: issued.token });
    } catch (err) {
      this.logger.error({
        event: "auth.email.verification.send.failed",
        actorUserId: userId,
        durationMs: Date.now() - startedAt,
        err,
      });
      throw new ServiceUnavailableException(VERIFICATION_EMAIL_FAILED_MESSAGE);
    }

    this.logger.info({
      event: "auth.email.verification.sent",
      actorUserId: userId,
      durationMs: Date.now() - startedAt,
    });
  }
}
