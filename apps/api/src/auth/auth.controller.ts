import type {
  AuthProvidersResponse,
  AuthUser,
  OAuthErrorCode,
  RegisterResponse,
  ResendVerificationResponse,
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
  parseLoginRequest,
  parseRegisterRequest,
  parseResendVerificationRequest,
  parseVerifyEmailRequest,
} from "./auth-requests";
import { AuthService } from "./auth.service";
import { AUTH_LOGGER } from "./auth.tokens";
import { CookieAuthGuard } from "./cookie-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { GoogleAuthService } from "./google/google-auth.service";
import { GoogleAuthError } from "./google/google-identity";
import {
  codeChallengeFor,
  createOAuthTransaction,
  decodeOAuthTransaction,
  encodeOAuthTransaction,
  oauthSecretsMatch,
  type OAuthTransaction,
} from "./google/oauth-transaction";
import { RegistrationService } from "./registration.service";

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
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(AUTH_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /** Non-secret capability probe so the UI only offers providers this deployment configured. */
  @Get("providers")
  providers(): AuthProvidersResponse {
    return { google: this.google.isEnabled };
  }

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown): Promise<RegisterResponse> {
    await this.registration.register(parseRegisterRequest(body));
    return { status: "verification_sent" };
  }

  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() body: unknown): Promise<VerifyEmailResponse> {
    await this.registration.verifyEmail(parseVerifyEmailRequest(body));
    return { status: "verified" };
  }

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

  @Get("me")
  @UseGuards(CookieAuthGuard)
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) response: Response): void {
    response.clearCookie(
      this.config.cookieName,
      authCookieOptions(this.config, false),
    );
  }

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

    let user: AuthUser;
    try {
      user = await this.google.authenticate({
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

    // Google sign-in ends in exactly the same session as password sign-in.
    response.cookie(
      this.config.cookieName,
      await this.auth.issueToken(user.id),
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

  private redirectToLogin(response: Response, error: OAuthErrorCode): void {
    response.redirect(
      `${this.config.webBaseUrl}${LOGIN_PATH}?error=${encodeURIComponent(error)}`,
    );
  }
}
