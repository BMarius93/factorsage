import {
  getAuthConfig,
  getGoogleOAuthConfig,
  type GoogleOAuthConfig,
} from "@intrinsic/config";
import { Global, Module } from "@nestjs/common";

export type AuthConfig = ReturnType<typeof getAuthConfig>;

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

/**
 * `null` when Google sign-in is not configured for this deployment. Partial configuration is
 * rejected by `getGoogleOAuthConfig` and fails startup rather than failing at the callback.
 */
export const GOOGLE_OAUTH_CONFIG = Symbol("GOOGLE_OAUTH_CONFIG");

export type GoogleOAuthConfigOrNull = GoogleOAuthConfig | null;

@Global()
@Module({
  providers: [
    {
      provide: AUTH_CONFIG,
      useFactory: getAuthConfig,
    },
    {
      provide: GOOGLE_OAUTH_CONFIG,
      useFactory: (): GoogleOAuthConfigOrNull => getGoogleOAuthConfig(),
    },
  ],
  exports: [AUTH_CONFIG, GOOGLE_OAUTH_CONFIG],
})
export class ConfigurationModule {}
