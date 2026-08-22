import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import {
  AUTH_CONFIG,
  type AuthConfig,
  ConfigurationModule,
} from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { CookieAuthGuard } from "./cookie-auth.guard";
import { PasswordService } from "./password.service";
import { RolesGuard } from "./roles.guard";
import { UsersService } from "./users.service";

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
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
    AuthService,
    CookieAuthGuard,
    PasswordService,
    RolesGuard,
    UsersService,
  ],
  exports: [AuthService, CookieAuthGuard, PasswordService, RolesGuard],
})
export class AuthModule {}
