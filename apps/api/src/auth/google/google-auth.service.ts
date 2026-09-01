import type { AuthUser } from "@intrinsic/contracts";
import { OAuthProvider } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AUTH_LOGGER } from "../auth.tokens";
import { isValidEmail, normalizeEmail } from "../email";
import { UsersService } from "../users.service";
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

  private async resolveIdentity(identity: GoogleIdentity): Promise<AuthUser> {
    const linked = await this.users.findByOAuthAccount(
      OAuthProvider.GOOGLE,
      identity.providerAccountId,
    );

    // Repeat sign-in for an identity we already know is idempotent: no new user, no new link.
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

    // Account linking is only safe when the provider itself vouches for the address. Linking an
    // unverified provider email would let anyone who can create a Google account with someone
    // else's address take over that FactorSage account.
    if (!identity.emailVerified) {
      this.logger.warn({ event: "auth.google.email.unverified" });
      throw new GoogleAuthError(
        "oauth_email_unverified",
        "Google has not verified this email address",
      );
    }

    const existing = await this.users.findByEmail(email);
    if (existing) {
      const user = await this.users.linkOAuthAccount({
        userId: existing.id,
        provider: OAuthProvider.GOOGLE,
        providerAccountId: identity.providerAccountId,
      });
      this.logger.info({
        event: "auth.google.account.linked",
        actorUserId: user.id,
      });
      return this.users.toAuthUser(user);
    }

    const created = await this.users.createOAuthUser({
      email,
      provider: OAuthProvider.GOOGLE,
      providerAccountId: identity.providerAccountId,
    });
    this.logger.info({
      event: "auth.google.user.created",
      actorUserId: created.id,
    });
    return this.users.toAuthUser(created);
  }
}
