import { getApiConfig } from "@intrinsic/config";
import {
  createLogger,
  type StructuredLogger,
} from "@intrinsic/observability";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import {
  AUTH_CONFIG,
  ConfigurationModule,
  GOOGLE_OAUTH_CONFIG,
  type AuthConfig,
  type GoogleOAuthConfigOrNull,
} from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { EmailModule } from "../email/email.module";
import { AuthEmailService } from "./auth-email.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AUTH_LOGGER } from "./auth.tokens";
import { CookieAuthGuard } from "./cookie-auth.guard";
import { EmailVerificationService } from "./email-verification.service";
import { GoogleAuthService } from "./google/google-auth.service";
import {
  GOOGLE_IDENTITY_PROVIDER,
  type GoogleIdentityProvider,
} from "./google/google-identity";
import { GoogleOidcIdentityProvider } from "./google/google-oidc-identity-provider";
import { PasswordService } from "./password.service";
import { RegistrationService } from "./registration.service";
import { RolesGuard } from "./roles.guard";
import { UsersService } from "./users.service";

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    EmailModule,
    JwtModule.registerAsync({
      imports: [ConfigurationModule],
      inject: [AUTH_CONFIG],
      useFactory: (config: AuthConfig) => ({
        secret: config.jwtSecret,
        signOptions: {
          algorithm: "HS256",
          expiresIn: config.tokenTtlSeconds,
        },
        verifyOptions: {
          algorithms: ["HS256"],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "auth" },
        });
      },
    },
    {
      // Null when Google sign-in is not configured; `GoogleAuthService` then reports the
      // provider as unavailable instead of the API failing to start.
      provide: GOOGLE_IDENTITY_PROVIDER,
      inject: [GOOGLE_OAUTH_CONFIG],
      useFactory: (
        config: GoogleOAuthConfigOrNull,
      ): GoogleIdentityProvider | null =>
        config ? new GoogleOidcIdentityProvider(config) : null,
    },
    AuthEmailService,
    AuthService,
    CookieAuthGuard,
    EmailVerificationService,
    GoogleAuthService,
    PasswordService,
    RegistrationService,
    RolesGuard,
    UsersService,
  ],
  exports: [
    AuthService,
    CookieAuthGuard,
    EmailVerificationService,
    PasswordService,
    RolesGuard,
    UsersService,
  ],
})
export class AuthModule {}
