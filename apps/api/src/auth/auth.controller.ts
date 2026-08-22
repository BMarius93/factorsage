import type { AuthUser, LoginRequest } from "@intrinsic/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { CookieOptions, Response } from "express";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { AuthService } from "./auth.service";
import { CookieAuthGuard } from "./cookie-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { isValidEmail, normalizeEmail } from "./email";

function parseLoginRequest(body: unknown): LoginRequest {
  if (
    typeof body !== "object" ||
    body === null ||
    !("email" in body) ||
    !("password" in body)
  ) {
    throw new BadRequestException("Invalid login request");
  }

  if (typeof body.email !== "string" || typeof body.password !== "string") {
    throw new BadRequestException("Invalid login request");
  }

  const email = normalizeEmail(body.email);
  if (
    !isValidEmail(email) ||
    body.password.length === 0 ||
    body.password.length > 1024
  ) {
    throw new BadRequestException("Invalid login request");
  }

  return { email, password: body.password };
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

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
      this.cookieOptions(true),
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
    response.clearCookie(this.config.cookieName, this.cookieOptions(false));
  }

  private cookieOptions(includeMaxAge: boolean): CookieOptions {
    return {
      httpOnly: true,
      sameSite: this.config.cookieSameSite,
      secure: this.config.cookieSecure,
      path: "/",
      ...(includeMaxAge ? { maxAge: this.config.tokenTtlSeconds * 1000 } : {}),
    };
  }
}
