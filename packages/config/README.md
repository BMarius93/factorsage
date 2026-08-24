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
- `getFmpTrafficConfig()` for non-secret provider limiter/retry settings
- `getStripeConfig()`
- `getApiConfig()`
- `getWorkerConfig()`

Required integration secrets fail fast when the corresponding accessor is called.

Stock-data coordination and provider traffic settings are deliberately separate:

- `STOCK_DATA_LOAD_LOCK_MS` is the renewable hydration lease duration (30 seconds by default).
- `STOCK_DATA_LOCK_WAIT_MS` is how long another API/worker caller may wait to acquire that lease
  (120 seconds by default). Long canonical loads can therefore exceed 10 seconds without duplicate
  provider work, while waiters still have a finite bound.
- `FMP_RETRY_MAX_DELAY_MS` caps exponential backoff only when FMP does not send `Retry-After`.
- `FMP_MAX_RETRY_WAIT_MS` bounds the current caller's cumulative retry-sleep budget. It does not
  shorten the provider-requested shared cooldown.
- `FMP_MAX_QUEUE_WAIT_MS` independently bounds local waiting for the shared traffic gate.

## Browser-safe configuration

Only `getWebPublicConfig()` is intended for values that may cross the browser boundary. Never expose server config objects or spread `process.env` into a browser response.

Stripe secret keys and webhook secrets are server-only. A Stripe publishable key may be exposed through the public web config.

## Domain boundary

`packages/domain` and `packages/valuation` must not import this package. Runtime/application layers read configuration and pass explicit values into pure business logic.
