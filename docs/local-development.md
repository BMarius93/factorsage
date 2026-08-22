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

# terminal 1
pnpm dev:web

# terminal 2
pnpm dev:api

# terminal 3
pnpm dev:worker
```

Stop infrastructure:

```bash
pnpm infra:down
```
