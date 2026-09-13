import type { AuthUser } from "@intrinsic/contracts";
import { OAuthProvider, type Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AUTH_LOGGER } from "../auth.tokens";
import { isValidEmail, normalizeEmail } from "../email";
import { UsersService } from "../users.service";
import {
  mayLinkToExistingAccount,
  resolveGoogleEmailAuthority,
} from "./google-email-authority";
import {
  GOOGLE_IDENTITY_PROVIDER,
  GoogleAuthError,
  type GoogleAuthorizationRequest,
  type GoogleCodeExchange,
  type GoogleIdentity,
  type GoogleIdentityProvider,
} from "./google-identity";

/**
 * Google sign-in orchestration.
 *
 * The Nest API owns the whole flow: it builds the authorization URL, exchanges the code through
 * the identity port, and resolves the provider identity to a FactorSage `User`. The browser only
 * ever receives the normal FactorSage auth cookie.
 *
 * Identity resolution answers three different questions and holds each to its own bar: a known
 * subject signs in, an unclaimed address may open a new account, and an address a FactorSage
 * account already holds may only be adopted when Google is actually authoritative for it
 * (`google-email-authority.ts`).
 */
@Injectable()
export class GoogleAuthService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
    @Optional()
    @Inject(GOOGLE_IDENTITY_PROVIDER)
    private readonly provider: GoogleIdentityProvider | null = null,
  ) {}

  get isEnabled(): boolean {
    return this.provider !== null;
  }

  buildAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    if (!this.provider) {
      throw new GoogleAuthError(
        "oauth_unavailable",
        "Google sign-in is not configured",
      );
    }
    return this.provider.buildAuthorizationUrl(request);
  }

  async authenticate(exchange: GoogleCodeExchange): Promise<AuthUser> {
    if (!this.provider) {
      throw new GoogleAuthError(
        "oauth_unavailable",
        "Google sign-in is not configured",
      );
    }

    const startedAt = Date.now();
    let identity: GoogleIdentity;
    try {
      identity = await this.provider.exchangeCode(exchange);
    } catch (err) {
      this.logger.warn({
        event: "auth.google.exchange.failed",
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err instanceof GoogleAuthError
        ? err
        : new GoogleAuthError(
            "oauth_provider",
            "Google identity could not be established",
            { cause: err },
          );
    }

    const user = await this.resolveIdentity(identity);
    this.logger.info({
      event: "auth.google.callback.completed",
      actorUserId: user.id,
      durationMs: Date.now() - startedAt,
    });
    return user;
  }

  /**
   * Resolves a verified provider identity to a FactorSage user, retrying once on a write race.
   *
   * Two callbacks for the same brand-new identity can both find nothing and both try to write it.
   * PostgreSQL's uniqueness — one user per email, one account per `(provider, sub)` — settles that,
   * and the loser simply resolves again, at which point the row the winner wrote is the answer. The
   * retry is bounded at one because the second pass reads a state that already exists.
   */
  private async resolveIdentity(identity: GoogleIdentity): Promise<AuthUser> {
    try {
      return await this.resolveIdentityOnce(identity);
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) {
        throw err;
      }
      this.logger.info({ event: "auth.google.identity.write-race" });
      return this.resolveIdentityOnce(identity);
    }
  }

  private async resolveIdentityOnce(
    identity: GoogleIdentity,
  ): Promise<AuthUser> {
    const linked = await this.users.findByOAuthAccount(
      OAuthProvider.GOOGLE,
      identity.providerAccountId,
    );

    // Repeat sign-in for an identity we already know is idempotent: no new user, no new link.
    // The subject is the identity, so this path asks nothing of the email claim.
    if (linked) {
      const user = linked.emailVerifiedAt
        ? linked
        : await this.users.markEmailVerified(linked.id);
      return this.users.toAuthUser(user);
    }

    const email = normalizeEmail(identity.email ?? "");
    if (!isValidEmail(email)) {
      throw new GoogleAuthError(
        "oauth_email_unverified",
        "Google did not provide a usable email address",
      );
    }

    // An unverified provider email is worthless for both creating and linking: anyone able to
    // type an address into a Google sign-up form could otherwise claim it here.
    if (!identity.emailVerified) {
      this.logger.warn({ event: "auth.google.email.unverified" });
      throw new GoogleAuthError(
        "oauth_email_unverified",
        "Google has not verified this email address",
      );
    }

    const existing = await this.users.findByEmail(email);
    if (!existing) {
      // Nobody holds this address here, so there is no account to take over. A verified Google
      // email is enough to open a new one.
      const created = await this.users.createOAuthUser({
        email,
        provider: OAuthProvider.GOOGLE,
        providerAccountId: identity.providerAccountId,
      });
      this.logger.info({
        event: "auth.google.user.created",
        actorUserId: created.id,
        emailAuthority: resolveGoogleEmailAuthority(identity),
      });
      return this.users.toAuthUser(created);
    }

    // Adopting an account that already exists is where `email_verified` stops being enough:
    // Google will report a third-party address as verified for a consumer account built around
    // it, and silently linking that would hand over the FactorSage account behind the address.
    const authority = resolveGoogleEmailAuthority(identity);
    if (!mayLinkToExistingAccount(authority)) {
      this.logger.warn({
        event: "auth.google.account.link.refused",
        actorUserId: existing.id,
        reason: "email_not_authoritative",
        emailAuthority: authority,
      });
      throw new GoogleAuthError(
        "oauth_link_not_allowed",
        "Google is not authoritative for this email address",
      );
    }

    const user = await this.users.linkOAuthAccount({
      userId: existing.id,
      provider: OAuthProvider.GOOGLE,
      providerAccountId: identity.providerAccountId,
    });
    this.logger.info({
      event: "auth.google.account.linked",
      actorUserId: user.id,
      emailAuthority: authority,
    });
    return this.users.toAuthUser(user);
  }
}

/**
 * Whether a write lost a uniqueness race rather than failing for its own reasons.
 *
 * Both constraints that can fire here — `User.email` and `OAuthAccount(provider,
 * providerAccountId)` — mean the same thing: a concurrent sign-in already wrote this identity.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    (error as Prisma.PrismaClientKnownRequestError | undefined)?.code === "P2002"
  );
}
