import type {
  AuthProvidersResponse,
  AuthUser,
  ForgotPasswordResponse,
  OAuthErrorCode,
  RegisterResponse,
  ResendVerificationResponse,
  ResetPasswordResponse,
  VerifyEmailResponse,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { parse as parseCookies } from "cookie";
import type { Request, Response } from "express";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import {
  authCookieOptions,
  oauthTransactionCookieName,
  oauthTransactionCookieOptions,
} from "./auth-cookie";
import {
  parseForgotPasswordRequest,
  parseLoginRequest,
  parseRegisterRequest,
  parseResendVerificationRequest,
  parseResetPasswordRequest,
  parseVerifyEmailRequest,
} from "./auth-requests";
import { AuthService } from "./auth.service";
import { AUTH_LOGGER } from "./auth.tokens";
import { CookieAuthGuard } from "./cookie-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { GoogleAuthService } from "./google/google-auth.service";
import { GoogleAuthError } from "./google/google-identity";
import { PasswordRecoveryService } from "./password-recovery.service";
import {
  codeChallengeFor,
  createOAuthTransaction,
  decodeOAuthTransaction,
  encodeOAuthTransaction,
  oauthSecretsMatch,
  type OAuthTransaction,
} from "./google/oauth-transaction";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { RegistrationService } from "./registration.service";
import type { SessionGrant } from "./users.service";

/** Where the web app takes over after a successful external sign-in. */
const POST_LOGIN_PATH = "/dashboard";
const LOGIN_PATH = "/login";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RegistrationService)
    private readonly registration: RegistrationService,
    @Inject(GoogleAuthService) private readonly google: GoogleAuthService,
    @Inject(PasswordRecoveryService)
    private readonly recovery: PasswordRecoveryService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /** Non-secret capability probe so the UI only offers providers this deployment configured. */
  @RateLimit("session-probe")
  @Get("providers")
  providers(): AuthProvidersResponse {
    return { google: this.google.isEnabled };
  }

  @RateLimit("auth-sensitive")
  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown): Promise<RegisterResponse> {
    await this.registration.register(parseRegisterRequest(body));
    return { status: "verification_sent" };
  }

  @RateLimit("auth-sensitive")
  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() body: unknown): Promise<VerifyEmailResponse> {
    await this.registration.verifyEmail(parseVerifyEmailRequest(body));
    return { status: "verified" };
  }

  @RateLimit("auth-sensitive")
  @Post("resend-verification")
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(
    @Body() body: unknown,
  ): Promise<ResendVerificationResponse> {
    await this.registration.resendVerification(
      parseResendVerificationRequest(body),
    );
    return { status: "accepted" };
  }

  /**
   * Requests a password-reset link. Always `202`.
   *
   * An unknown address, a Google-only account and a real local account are indistinguishable
   * from here, so the endpoint cannot be used to enumerate accounts or to discover how somebody
   * signs in.
   */
  @RateLimit("auth-sensitive")
  @Post("forgot-password")
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body() body: unknown): Promise<ForgotPasswordResponse> {
    await this.recovery.requestReset(parseForgotPasswordRequest(body));
    return { status: "accepted" };
  }

  /** Redeems a reset token once and installs the new password. */
  @RateLimit("auth-sensitive")
  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: unknown): Promise<ResetPasswordResponse> {
    await this.recovery.resetPassword(parseResetPasswordRequest(body));
    return { status: "password_reset" };
  }

  @RateLimit("auth-sensitive")
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const result = await this.auth.login(parseLoginRequest(body));
    response.cookie(
      this.config.cookieName,
      result.token,
      authCookieOptions(this.config, true),
    );
    return result.user;
  }

  @RateLimit("session-probe")
  @Get("me")
  @UseGuards(CookieAuthGuard)
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  /**
   * Signs out **this browser**: clears its cookie and nothing else.
   *
   * Deliberately not a revocation. Other devices stay signed in, which is what "sign out" means
   * on a shared machine; `POST /auth/logout-all` is the action that ends every session.
   */
  @RateLimit("session-probe")
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) response: Response): void {
    this.clearSessionCookie(response);
  }

  /**
   * "Sign out everywhere": revokes every session of the signed-in account, then clears this
   * browser's cookie. Any other copy of a token — another device, or a captured cookie — gets the
   * generic `401` on its next request.
   */
  @RateLimit("mutation")
  @Post("logout-all")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CookieAuthGuard)
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.revokeAllSessions(user.id);
    this.clearSessionCookie(response);
  }

  @RateLimit("auth-sensitive")
  @Get("google")
  googleAuthorize(@Res() response: Response): void {
    if (!this.google.isEnabled) {
      this.redirectToLogin(response, "oauth_unavailable");
      return;
    }

    // State, PKCE verifier, and nonce are minted together and bound to this browser through one
    // short-lived HttpOnly cookie. Only the derived S256 challenge leaves the server.
    const transaction = createOAuthTransaction();
    response.cookie(
      oauthTransactionCookieName(this.config),
      encodeOAuthTransaction(transaction),
      oauthTransactionCookieOptions(this.config, true),
    );
    this.logger.info({ event: "auth.google.authorize.started" });
    response.redirect(
      this.google.buildAuthorizationUrl({
        state: transaction.state,
        codeChallenge: codeChallengeFor(transaction.codeVerifier),
        nonce: transaction.nonce,
      }),
    );
  }

  @RateLimit("auth-sensitive")
  @Get("google/callback")
  async googleCallback(
    @Query("code") code: unknown,
    @Query("state") state: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const transaction = this.readOAuthTransaction(request);
    // Single-use whatever happens next, so a replayed callback cannot reuse the transaction.
    response.clearCookie(
      oauthTransactionCookieName(this.config),
      oauthTransactionCookieOptions(this.config, false),
    );

    if (
      !transaction ||
      typeof state !== "string" ||
      !oauthSecretsMatch(state, transaction.state)
    ) {
      this.logger.warn({ event: "auth.google.callback.failed", reason: "state" });
      this.redirectToLogin(response, "oauth_state");
      return;
    }

    if (typeof code !== "string" || code.length === 0) {
      this.logger.warn({
        event: "auth.google.callback.failed",
        reason: "missing_code",
      });
      this.redirectToLogin(response, "oauth_provider");
      return;
    }

    let grant: SessionGrant;
    try {
      grant = await this.google.authenticate({
        code,
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
      });
    } catch (err) {
      const errorCode =
        err instanceof GoogleAuthError ? err.code : "oauth_provider";
      this.logger.warn({
        event: "auth.google.callback.failed",
        reason: errorCode,
        err,
      });
      this.redirectToLogin(response, errorCode);
      return;
    }

    // Google sign-in ends in exactly the same session as password sign-in, at the version read on
    // the row Google resolved to.
    response.cookie(
      this.config.cookieName,
      await this.auth.issueToken(grant.user.id, grant.sessionVersion),
      authCookieOptions(this.config, true),
    );
    response.redirect(`${this.config.webBaseUrl}${POST_LOGIN_PATH}`);
  }

  private readOAuthTransaction(request: Request): OAuthTransaction | null {
    const header = request.headers.cookie;
    if (!header) {
      return null;
    }

    let raw: string | undefined;
    try {
      raw = parseCookies(header)[oauthTransactionCookieName(this.config)];
    } catch {
      return null;
    }

    return decodeOAuthTransaction(raw);
  }

  private clearSessionCookie(response: Response): void {
    response.clearCookie(
      this.config.cookieName,
      authCookieOptions(this.config, false),
    );
  }

    private redirectToLogin(response: Response, error: OAuthErrorCode): void {
    response.redirect(
      `${this.config.webBaseUrl}${LOGIN_PATH}?error=${encodeURIComponent(error)}`,
    );
  }
}
