import type {
  RegisterRequest,
  ResendVerificationRequest,
  VerifyEmailRequest,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  acceptanceRows,
  assertRequiredTermsVersion,
} from "../legal/legal-acceptance-records";
import { AUTH_LOGGER } from "./auth.tokens";
import { AuthEmailService } from "./auth-email.service";
import { BackgroundEmailDispatcher } from "./background-email-dispatcher";
import { EmailVerificationService } from "./email-verification.service";
import { PasswordService } from "./password.service";
import { type ActivationCandidate, UsersService } from "./users.service";

export const INVALID_VERIFICATION_TOKEN_MESSAGE =
  "This verification link is invalid or has expired";

/**
 * How long one registration or resend email to an address blocks the next (AUTH-003).
 *
 * The bound on how much mail anybody can make FactorSage send to one address, whoever asks and
 * from however many IPs: at most one message per window. Long enough that registering a stranger's
 * address in a loop is useless as a mail bomb, short enough that an owner whose message went to
 * spam can ask again in the same sitting. It never refuses a request — a request inside the window
 * gets the same `202` and simply sends nothing, and the link already in the inbox stays valid.
 */
export const REGISTRATION_EMAIL_COOLDOWN_SECONDS = 5 * 60;

/** Whether a claim taken at `previous` still blocks a new one at `now`. */
export function isRegistrationEmailCoolingDown(
  previous: Date | null,
  now: Date,
): boolean {
  return (
    previous !== null &&
    now.getTime() - previous.getTime() <
      REGISTRATION_EMAIL_COOLDOWN_SECONDS * 1000
  );
}

type ActivationRequestSource = "register" | "resend";

/**
 * Internal outcome of an activation request. Logged, never returned: the public answer is the same
 * `202` for every one of them.
 */
type ActivationOutcome =
  | "account_created"
  | "activation_claimed"
  | "notice_claimed"
  | "cooldown"
  | "claim_lost"
  | "not_eligible";

/**
 * Local registration and the email-verification lifecycle.
 *
 * **Registration is email-first (AUTH-003).** `POST /auth/register` takes an address and nothing
 * else, and answers the same `202` whether the address is new, pending, verified, signed in with
 * Google, or was submitted a moment ago. What happens behind that answer depends on the account,
 * and none of it is observable from the response:
 *
 * - no account — a pending, unverified user **without a password** is created and mailed an
 *   activation link;
 * - pending — a fresh activation link is mailed (rotating the old one);
 * - verified (password, Google or both) — nothing about the account changes; the owner is mailed a
 *   neutral "you already have an account" notice with no token in it;
 * - any of those within `REGISTRATION_EMAIL_COOLDOWN_SECONDS` of the previous email — nothing is
 *   written, issued or sent, so the link already in the inbox stays valid.
 *
 * Only the holder of an activation link ever sets the account's first password, on
 * `/verify-email` (AUTH-002). Registration never reads or writes a verified account's credential,
 * role, plan, session version or linked identities.
 *
 * The request path only decides and claims. Token issuance and delivery run after the response on
 * `BackgroundEmailDispatcher`, so neither the transport's latency nor its failure can distinguish
 * one state from another, and no transaction is ever held open across a send.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(EmailVerificationService)
    private readonly verification: EmailVerificationService,
    @Inject(AuthEmailService) private readonly email: AuthEmailService,
    @Inject(BackgroundEmailDispatcher)
    private readonly background: BackgroundEmailDispatcher,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /** Email-first registration. Always returns normally for a well-formed address. */
  async register(request: RegisterRequest): Promise<void> {
    await this.requestActivation(request.email, "register");
  }

  /**
   * Redeems a verification link and installs the password its holder chose (AUTH-002).
   *
   * The password registration stored is never what this activates: anyone can register an
   * address, and only the holder of the link has proven control of the mailbox.
   */
  async verifyEmail(request: VerifyEmailRequest): Promise<void> {
    // Before anything is looked up or hashed. A missing, unknown or superseded Terms version is
    // a `400` that redeems nothing and activates nothing, so the link stays usable and the
    // account stays pending — the failure mode the acceptance checklist requires.
    assertRequiredTermsVersion(request.termsVersion);

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
      // Bound to the account the token belongs to, inside the same transaction. Whoever
      // submitted the address at registration never accepted anything on the mailbox owner's
      // behalf: this is the first and only acceptance on the email path, and it belongs to the
      // person who proved control of the mailbox by holding this link.
      acceptance: acceptanceRows({
        // Replaced with the token's real owner inside the transaction; the redeemer is the only
        // thing that knows which account the link belongs to.
        userId: "",
        surface: "EMAIL_ACTIVATION",
      }),
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
      event: "legal.acceptance.recorded",
      actorUserId: userId,
      surface: "EMAIL_ACTIVATION",
    });
    this.logger.info({
      event: "auth.sessions.revoked",
      actorUserId: userId,
      reason: "email_verification",
    });
  }

  /**
   * Resends an activation link to a pending account.
   *
   * The same operation as registration — the same claim, cooldown and out-of-band delivery — minus
   * creating an account and minus the existing-account notice: an unknown address and a verified
   * account are silent no-ops, so this endpoint cannot be used to enumerate accounts either.
   */
  async resendVerification(request: ResendVerificationRequest): Promise<void> {
    await this.requestActivation(request.email, "resend");
  }

  /**
   * The one activation-request operation behind both register and resend.
   *
   * Every branch returns normally; what happened is logged under `auth.activation.requested` with
   * an internal `outcome` and never reaches the caller.
   */
  private async requestActivation(
    email: string,
    source: ActivationRequestSource,
  ): Promise<void> {
    const startedAt = Date.now();
    const outcome = await this.decideActivation(email, source);
    this.logger.info({
      event: "auth.activation.requested",
      source,
      outcome: outcome.kind,
      ...(outcome.userId ? { actorUserId: outcome.userId } : {}),
      durationMs: Date.now() - startedAt,
    });
  }

  private async decideActivation(
    email: string,
    source: ActivationRequestSource,
  ): Promise<{ kind: ActivationOutcome; userId?: string }> {
    const now = new Date();
    let account = await this.users.findActivationCandidate(email);

    if (!account) {
      if (source !== "register") {
        return { kind: "not_eligible" };
      }
      // Created already holding the claim, so a concurrent request for the same address — which
      // loses the unique index and reads this row instead — finds it cooling down.
      const created = await this.users.createPendingUser({
        email,
        claimedAt: now,
      });
      if (created) {
        this.dispatchActivation(created.id, now, null);
        return { kind: "account_created", userId: created.id };
      }
      account = await this.users.findActivationCandidate(email);
      if (!account) {
        // Created and removed again between two statements; there is nothing to act on.
        return { kind: "not_eligible" };
      }
    }

    return this.claimForExistingAccount(account, source, now);
  }

  private async claimForExistingAccount(
    account: ActivationCandidate,
    source: ActivationRequestSource,
    now: Date,
  ): Promise<{ kind: ActivationOutcome; userId: string }> {
    const pending = account.emailVerifiedAt === null;
    // Resend only ever re-sends an activation link; the existing-account notice answers
    // registration alone.
    if (!pending && source !== "register") {
      return { kind: "not_eligible", userId: account.id };
    }
    if (
      isRegistrationEmailCoolingDown(account.registrationEmailClaimedAt, now)
    ) {
      return { kind: "cooldown", userId: account.id };
    }

    const previous = account.registrationEmailClaimedAt;
    const claimed = await this.users.claimRegistrationEmail({
      userId: account.id,
      previous,
      claimedAt: now,
      accountState: pending ? "pending" : "verified",
    });
    if (!claimed) {
      // A concurrent request took the claim first, or the account was verified since the read.
      return { kind: "claim_lost", userId: account.id };
    }

    if (pending) {
      this.dispatchActivation(account.id, now, previous);
      return { kind: "activation_claimed", userId: account.id };
    }
    this.dispatchExistingAccountNotice(account.id, now, previous);
    return { kind: "notice_claimed", userId: account.id };
  }

  /**
   * Issues a fresh activation token and mails it, after the response.
   *
   * Issuing rotates the account's outstanding link, which is why it happens only after a claim:
   * a request inside the cooldown never invalidates the link already in the inbox. If the account
   * was verified in the meantime — by the previous link, a reset or a Google link — the new token is
   * withdrawn rather than mailed, so no live verification token is left on a verified account.
   */
  private dispatchActivation(
    userId: string,
    claimedAt: Date,
    previous: Date | null,
  ): void {
    this.runReleasingOnError(
      "auth.email.verification.dispatch",
      { userId, claimedAt, previous },
      async () => {
        const issued = await this.verification.issueToken(userId);
        if (!(await this.users.isPendingActivation(userId))) {
          await this.verification.discardIssuedToken(userId, issued.token);
          this.logger.info({
            event: "auth.email.verification.withdrawn",
            actorUserId: userId,
            reason: "verified_meanwhile",
          });
          return;
        }

        const recipient = await this.users.findEmailRecipient(userId);
        if (!recipient) {
          return;
        }
        await this.deliver({
          event: "auth.email.verification",
          userId,
          claimedAt,
          previous,
          send: () =>
            this.email.sendVerificationEmail({
              to: recipient.email,
              token: issued.token,
            }),
        });
      },
    );
  }

  /** Mails a verified account's owner the neutral notice, after the response. No token exists. */
  private dispatchExistingAccountNotice(
    userId: string,
    claimedAt: Date,
    previous: Date | null,
  ): void {
    this.runReleasingOnError(
      "auth.email.account_notice.dispatch",
      { userId, claimedAt, previous },
      async () => {
        const recipient = await this.users.findEmailRecipient(userId);
        if (!recipient) {
          return;
        }
        await this.deliver({
          event: "auth.email.account_notice",
          userId,
          claimedAt,
          previous,
          send: () =>
            this.email.sendExistingAccountNotice({
              to: recipient.email,
              methods: recipient.methods,
            }),
        });
      },
    );
  }

  /**
   * Runs a dispatch task in the background and, if it fails before its message could be handed to
   * the transport (a database error while issuing, say), gives the claim back before the failure is
   * logged — the same guarantee `deliver` gives for a transport failure.
   */
  private runReleasingOnError(
    event: string,
    claim: { userId: string; claimedAt: Date; previous: Date | null },
    task: () => Promise<void>,
  ): void {
    this.background.run(event, async () => {
      try {
        await task();
      } catch (err) {
        await this.users.releaseRegistrationEmail(claim);
        throw err;
      }
    });
  }

  /**
   * Sends one message and records the outcome. A failure is logged with the original error and
   * gives the claim back, so the owner's next request can send at once instead of waiting out a
   * cooldown for a message that never left — a new account is never stranded by a transport error.
   */
  private async deliver(input: {
    event: string;
    userId: string;
    claimedAt: Date;
    previous: Date | null;
    send: () => Promise<void>;
  }): Promise<void> {
    const startedAt = Date.now();
    try {
      await input.send();
    } catch (err) {
      this.logger.error({
        event: `${input.event}.send.failed`,
        actorUserId: input.userId,
        durationMs: Date.now() - startedAt,
        err,
      });
      await this.users.releaseRegistrationEmail({
        userId: input.userId,
        claimedAt: input.claimedAt,
        previous: input.previous,
      });
      return;
    }

    this.logger.info({
      event: `${input.event}.sent`,
      actorUserId: input.userId,
      durationMs: Date.now() - startedAt,
    });
  }
}
