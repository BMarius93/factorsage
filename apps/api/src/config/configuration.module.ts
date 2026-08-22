import { getAuthConfig } from "@intrinsic/config";
import { Global, Module } from "@nestjs/common";

export type AuthConfig = ReturnType<typeof getAuthConfig>;

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

@Global()
@Module({
  providers: [
    {
      provide: AUTH_CONFIG,
      useFactory: getAuthConfig,
    },
  ],
  exports: [AUTH_CONFIG],
})
export class ConfigurationModule {}
