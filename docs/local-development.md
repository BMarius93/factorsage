# Local Development

Recommended development topology:

```text
Docker:
  PostgreSQL
  Redis

Host:
  Next.js web
  NestJS API
  Node worker
```

This makes debugging easier than running every process inside Docker.

Commands:

```bash
cp .env.example .env
pnpm install
pnpm infra:up

# Apply pending migrations and bootstrap the initial administrator.
pnpm db:migrate:deploy
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<temporary-value>' pnpm db:seed

# terminal 1
pnpm dev:web

# terminal 2
pnpm dev:api

# terminal 3
pnpm dev:worker
```

Stock-data misses use `FMP_API_KEY` from the same root `.env`. Canonical hydration defaults to 30
years through `STOCK_HISTORY_YEARS`. Cache residency defaults to 100 complete stocks and can be
changed with `STOCK_CACHE_MAX_RESIDENT_STOCKS`; eviction removes all registered yearly chunks for
the selected security. FMP retries, provider-wide limiting, and recent-tail freshness settings are
listed in `.env.example`. Deterministic and real-Redis tests do not require FMP. Run Redis coverage
with `pnpm --filter @intrinsic/stock-data test:redis`. When a local key is present, run the
deliberately small AAPL verification suite with:

```bash
pnpm --filter @intrinsic/stock-data test:live
```

Local browser authentication runs from web `:3000` to API `:3001`. Keep
`NEXT_PUBLIC_API_BASE_URL=http://localhost:3001` and
`CORS_ORIGINS=http://localhost:3000`; the browser client sends credentialed requests. Use a
development-only `AUTH_JWT_SECRET` of at least 32 characters. Production must supply a unique
secret and uses a Secure auth cookie automatically.

Stop infrastructure:

```bash
pnpm infra:down
```
