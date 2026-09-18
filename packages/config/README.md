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

## Production refusals

Every refusal is an `Invalid application configuration: …` startup error that names the variable
and never echoes its value. With `NODE_ENV=production`:

| Variable | Required by | Rule in production |
| --- | --- | --- |
| `WEB_BASE_URL` | API (`getWebBaseUrl`, via `getAuthConfig` and Stripe URLs) | required; `https:`; not `localhost`, `*.localhost`, 127/8, `::1` or `0.0.0.0` |
| `CORS_ORIGINS` | API (`getApiConfig`) | required; no localhost or loopback origin |
| `SMTP_HOST`, `SMTP_FROM` | API (`getSmtpConfig`) | required; `SMTP_USER`/`SMTP_PASSWORD` stay all-or-nothing |
| `STRIPE_*` | API, when billing is on | live keys only (`getStripeBillingConfig`) |
| `BACKTEST_DEBUG_ARCHIVE` | worker | must be `off` |

Development and test keep their localhost defaults and may run without SMTP. The worker calls none
of the API accessors, so it never needs `WEB_BASE_URL`, `CORS_ORIGINS`, `SMTP_*` or `AUTH_*`.
API command-line tools that call `getApiConfig` (for example `pnpm billing:reconcile`) run with the
API's environment and therefore need `CORS_ORIGINS` in production too.

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

The web app may not import this package (`AGENTS.md` dependency rules). Its one configuration value
is `NEXT_PUBLIC_API_BASE_URL`, which `next build` compiles into the browser bundle, so it is a
**build-time** value: a release build (`FACTORSAGE_RELEASE_BUILD=true`, the default in
`docker/web.Dockerfile`) refuses to compile unless it is an https, non-loopback URL — see
`apps/web/src/lib/release-build.ts`. Never expose server config objects, put a secret in a
`NEXT_PUBLIC_*` variable, or spread `process.env` into a browser response.

Stripe secret keys and webhook secrets are server-only.

## Domain boundary

`packages/domain` and `packages/valuation` must not import this package. Runtime/application layers read configuration and pass explicit values into pure business logic.
