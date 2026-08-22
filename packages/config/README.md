# Centralized runtime configuration

`@intrinsic/config` is the single application-level configuration boundary.

## Sources

- Local development: one repository-root `.env` file, ignored by Git.
- Deployed environments: environment variables / secret-store injection from the hosting platform.
- Application code consumes the same typed config functions in both cases.

`loadRootEnv()` searches upward for `pnpm-workspace.yaml` and loads the root `.env` only when that file exists. A deployed container normally has no `.env`, so already-injected environment variables are used unchanged.

## Server-only configuration

Use dedicated accessors for server-side integrations:

- `getDatabaseConfig()`
- `getRedisConfig()`
- `getFmpConfig()`
- `getStripeConfig()`
- `getApiConfig()`
- `getWorkerConfig()`

Required integration secrets fail fast when the corresponding accessor is called.

## Browser-safe configuration

Only `getWebPublicConfig()` is intended for values that may cross the browser boundary. Never expose server config objects or spread `process.env` into a browser response.

Stripe secret keys and webhook secrets are server-only. A Stripe publishable key may be exposed through the public web config.

## Domain boundary

`packages/domain` and `packages/valuation` must not import this package. Runtime/application layers read configuration and pass explicit values into pure business logic.
