# Claude cloud environment

How a Claude Code cloud session ("Claude Remote") becomes a complete FactorSage development and QA
machine, and how to configure the Claude environment that runs it. The scripts live in
`scripts/cloud/`; the SessionStart hook in `.claude/settings.json` runs them.

A cloud session is a disposable Ubuntu 24.04 VM (4 vCPU, 16 GB RAM, 30 GB disk) with this
repository cloned. Nothing in it is production, and nothing in it can become production:

- PostgreSQL 16 and Redis 7 run natively on loopback, with three local databases;
- every outbound integration is either faked, absent, or reachable only through an explicit
  wrapper that refuses anything but test mode;
- the environment guard refuses to provision or start anything when a variable points at a
  non-local database, production mode or a live Stripe key.

## 1. What a session provides

| Component           | Where                                          | Notes                                                                                                                           |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Node                | `/opt/node-v<.nvmrc>`                          | The exact pinned version: pnpm refuses to install a project whose own `engines` do not match                                    |
| pnpm                | Corepack, from `packageManager`                | Same mechanism as the Dockerfiles                                                                                               |
| PostgreSQL 16       | `127.0.0.1:5432`                               | Role `intrinsic` (`LOGIN CREATEDB`, never superuser) owning `intrinsic_value`, `intrinsic_value_test`, `intrinsic_value_matrix` |
| Redis 7             | `127.0.0.1:6379`                               | Logical db 0 for dev and test (namespaced), db 3 for the matrix                                                                 |
| Mailpit             | SMTP `127.0.0.1:1025`, UI/API `127.0.0.1:8025` | Catches everything the development stack sends                                                                                  |
| Playwright Chromium | `/opt/ms-playwright`                           | The revision the lockfile's `@playwright/test` pins, never a preinstalled browser                                               |
| Stripe CLI          | `/opt/factorsage-cloud/bin/stripe`             | Pinned image digest and binary checksum                                                                                         |
| `gh`                | preinstalled                                   | Authenticated by Claude's GitHub proxy; it rejects tag pushes and branch deletion                                               |

The stacks you can run:

| Mode                                     | Database | FMP                                                   | Stripe                                                            | Mail                                        |
| ---------------------------------------- | -------- | ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `pnpm test`                              | test     | fakes; live suites stay gated by `RUN_LIVE_FMP_TESTS` | fake gateway; sandbox smoke stays gated by `STRIPE_SANDBOX_SMOKE` | in-memory sender                            |
| `scripts/cloud/stack.sh up e2e`          | test     | fixture server `:3011`                                | inert placeholders                                                | off                                         |
| `scripts/cloud/stack.sh up e2e --mail`   | test     | fixture server `:3011`                                | inert placeholders                                                | Mailpit, API only, for `pnpm test:e2e:mail` |
| `scripts/cloud/stack.sh up dev`          | dev      | **none**                                              | none                                                              | Mailpit                                     |
| `scripts/cloud/stack.sh up dev --stripe` | dev      | **none**                                              | cloud sandbox, webhooks through `stripe listen`                   | Mailpit                                     |

**No stack ever holds an FMP key.** The runtime environment never has one under a name the
application reads. Live provider data is reachable through exactly one command,
`scripts/cloud/fmp-live.sh`, which hydrates the full supported history of **at most three
securities** into the development database, inside a total request budget
(`docs/development/fmp-live-hydration.md`). It is not a wrapper for other commands: it cannot start
a stack, a worker or a test run with the provider configured. `financialmodelingprep.com` stays off
the network allowlist except while that command is being used.

The development database starts **empty** in every new session: no securities, no market data.
Use the hermetic E2E stack for UI work; it seeds its own deterministic fixtures. To look at real
data for a few securities, hydrate them with `scripts/cloud/fmp-live.sh` and then start
`stack.sh up dev`, which reads what was stored and still has no provider key.

## 2. Configuring the Claude environment (once, by the owner)

At [claude.ai/code](https://claude.ai/code), create a **new, personal** environment (for example
`FactorSage QA`). Do not make it an organization-shared environment: anyone who can use an
environment can read its variables and setup script.

### 2.1 Setup script

Paste exactly:

```bash
#!/usr/bin/env bash
# FactorSage cloud VM provisioning. The logic is versioned in scripts/cloud/setup.sh.
# Revision 1 — change this line to force the environment cache to rebuild.
set -uo pipefail
repo="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ ! -f "$repo/scripts/cloud/setup.sh" ]; then
  candidate="$(find / -maxdepth 6 \( -path /proc -o -path /sys -o -name node_modules \) -prune \
    -o -path '*/scripts/cloud/setup.sh' -print 2>/dev/null | head -n1)"
  [ -n "$candidate" ] && repo="$(cd "$(dirname "$candidate")/../.." && pwd)"
fi
if [ -f "$repo/scripts/cloud/setup.sh" ]; then
  bash "$repo/scripts/cloud/setup.sh"
else
  echo "FactorSage: scripts/cloud/setup.sh is not in this checkout; skipping VM provisioning."
fi
exit 0
```

It always exits 0: a VM whose setup fails cannot even be opened to debug it. `setup.sh` records each
step in `/var/lib/factorsage-cloud/setup-status`, and the SessionStart hook reports and repairs
failed steps.

### 2.2 Network access

Choose **Custom**, check **Also include default list of common package managers**, and allow:

```text
binaries.prisma.sh
cdn.playwright.dev
playwright.download.prss.microsoft.com
*.stripe.com
*.stripe.network
*.stripecdn.com
```

| Domain                                                         | Needed for                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `binaries.prisma.sh`                                           | Prisma engines, downloaded by `pnpm install`                         |
| `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` | The pinned Chromium, headless shell and ffmpeg                       |
| `*.stripe.com`                                                 | The Stripe API, the CLI's webhook tunnel, hosted Checkout and Portal |
| `*.stripe.network`, `*.stripecdn.com`                          | Assets of the hosted Checkout page, when a browser drives it         |

Everything else the scripts download comes from the default list: Node from `nodejs.org`, pnpm and
packages from `registry.npmjs.org`, Ubuntu packages, and the Mailpit and Stripe CLI images from
Google's Docker Hub mirror (`mirror.gcr.io`, which has no anonymous pull limit) or Docker Hub
itself. GitHub release assets are not used: the GitHub proxy serves them only for the repository
attached to the session.

`financialmodelingprep.com` is deliberately **not** on that list. Add it only immediately before
using `scripts/cloud/fmp-live.sh`, and remove it afterwards. The allowlist is environment-level: a
domain on it is reachable by every process in the VM, not by one command, so while it is there the
network stops nothing and the boundary is the one `docs/development/fmp-live-hydration.md`
describes — no key under a name the application reads, a per-command opt-in, a three-security
scope, a request budget and the database guard.

### 2.3 Environment variables

`.env` format. Values marked `<…>` are yours to fill in; everything else is literal.

```text
LOG_LEVEL=info
DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value
TEST_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_test
QA_MATRIX_DATABASE_URL=postgresql://intrinsic:intrinsic_dev_password@localhost:5432/intrinsic_value_matrix
QA_MATRIX_REDIS_DB=3
REDIS_URL=redis://localhost:6379
WEB_BASE_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
E2E_BASE_URL=http://localhost:3000
AUTH_JWT_SECRET=<64 random hex characters>
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=no-reply@factorsage.test
QA_FREE_EMAIL=qa-free@factorsage.test
QA_FREE_PASSWORD=<at least 12 characters>
QA_STARTER_EMAIL=qa-starter@factorsage.test
QA_STARTER_PASSWORD=<at least 12 characters>
QA_USER_EMAIL=qa-pro@factorsage.test
QA_USER_PASSWORD=<at least 12 characters>
QA_ADMIN_EMAIL=qa-admin@factorsage.test
QA_ADMIN_PASSWORD=<at least 12 characters>
QA_DOWNGRADED_EMAIL=qa-downgraded@factorsage.test
QA_DOWNGRADED_PASSWORD=<at least 12 characters>
QA_BILLING_PASSWORD=<at least 12 characters>
SANDBOX_STRIPE_SECRET_KEY=<sk_test_… of the cloud sandbox>
SANDBOX_STRIPE_PRICE_STARTER_MONTHLY=<price_…>
SANDBOX_STRIPE_PRICE_STARTER_YEARLY=<price_…>
SANDBOX_STRIPE_PRICE_PRO_MONTHLY=<price_…>
SANDBOX_STRIPE_PRICE_PRO_YEARLY=<price_…>
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
BASH_MAX_TIMEOUT_MS=14400000
```

- `openssl rand -hex 32` makes a JWT secret; `openssl rand -hex 16` makes a persona password. Avoid
  `#` in any value: it starts a comment in `.env` format.
- The database password is the local-development default already committed in `.env.example`;
  PostgreSQL listens on loopback only.
- `QA_USER_*` is `PRO_USER` (the historical name), as everywhere else.
- `QA_BILLING_PASSWORD` is optional: the one password the billing QA personas sign in with
  (`docs/development/billing-qa-personas.md`). Their addresses are fixed in the registry. Without
  it they can still be seeded, inspected and removed; only the browser suite needs it.
- `SANDBOX_STRIPE_*` are deliberately **not** the names the application reads. `pnpm test`, a plain
  `pnpm dev:api` and Playwright therefore run without Stripe, exactly as CI does; only
  `scripts/cloud/with-stripe.sh` and `stack.sh up dev --stripe` map them onto `STRIPE_*`.
- Leave `NODE_ENV` unset: the application defaults to `development`, Vitest to `test`, and
  `next build` must choose `production` itself — an ambient `NODE_ENV=development` makes `pnpm build`
  fail while prerendering.
- `BASH_MAX_TIMEOUT_MS` lets Claude give long commands (a full E2E run, the matrix) up to four hours.

Secrets: `SANDBOX_STRIPE_SECRET_KEY` (test mode only) and, only if live hydration is wanted,
`LIVE_FMP_API_KEY` — a separate FMP key for the cloud if the plan allows one. Like the sandbox key
it is held under a name the application does not read, so every ordinary command runs without a
provider credential; `scripts/cloud/fmp-live.sh` is the only thing that uses it. Low sensitivity, because they only protect
accounts and sessions inside a throwaway VM: `AUTH_JWT_SECRET` and the persona passwords — never
reuse a real password. Everything else is not secret.

**Never set** in this environment — the guard blanks or refuses each one:
`NODE_ENV=production`, `CI`, `FMP_API_KEY`, `FMP_BASE_URL`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `STRIPE_API_KEY`, `RUN_LIVE_FMP_TESTS`,
`RUN_LIVE_FMP_HYDRATION`, `STRIPE_SANDBOX_SMOKE`, `STRIPE_BILLING_PERSONAS`, `QA_PERSONA_ALLOW_REMOTE_HOST`,
`QA_MATRIX_ALLOW_REMOTE_HOST`,
`FACTORSAGE_RELEASE_BUILD`, and any database or Redis URL that is not `localhost`/`127.0.0.1`.
Google sign-in stays off: leave the `GOOGLE_*` group unset.

### 2.4 The Stripe sandbox

The cloud uses its **own** Stripe sandbox, so nothing it creates can touch your local sandbox or live
account and the two `stripe listen` sessions never see each other's events. Create it in the Stripe
Dashboard:

1. Account picker → **Sandboxes** → **Create sandbox**, named `FactorSage Claude Cloud`, starting
   empty rather than copying another environment.
2. Inside it, **Developers → API keys**: the secret key (`sk_test_…`) is
   `SANDBOX_STRIPE_SECRET_KEY`.
3. Two products and four recurring USD prices, `interval_count` 1, per unit: **Starter** at $9 /
   month and $99 / year, **Pro** at $29 / month and $299 / year. In the Dashboard (**Product
   catalog → Add product**), or with your local Stripe CLI without logging it in:

   ```bash
   read -rs STRIPE_API_KEY && export STRIPE_API_KEY      # paste the cloud sandbox sk_test_ key
   stripe products create --name "Starter" --description "FactorSage Starter"
   stripe prices create --product <prod_starter> --currency usd --unit-amount 900 \
     -d "recurring[interval]=month" --lookup-key factorsage_starter_monthly
   stripe prices create --product <prod_starter> --currency usd --unit-amount 9900 \
     -d "recurring[interval]=year" --lookup-key factorsage_starter_yearly
   stripe products create --name "Pro" --description "FactorSage Pro"
   stripe prices create --product <prod_pro> --currency usd --unit-amount 2900 \
     -d "recurring[interval]=month" --lookup-key factorsage_pro_monthly
   stripe prices create --product <prod_pro> --currency usd --unit-amount 29900 \
     -d "recurring[interval]=year" --lookup-key factorsage_pro_yearly
   unset STRIPE_API_KEY
   ```

   The four `price_…` ids are the four `SANDBOX_STRIPE_PRICE_*` values.

4. **Settings → Billing → Customer portal**, then save a configuration: payment-method update
   **on**, invoice history **on**, cancel subscriptions **on** and **at end of billing period**,
   customers may resume a scheduled cancellation **on**, switch plans **off**, promotion codes
   **off**. (Why each: `ai/architecture/billing.md`, _Stripe Dashboard configuration checklist_.)
5. **Settings → Billing → Revenue recovery**: Smart Retries **on**; when all retries fail,
   **cancel the subscription**.
6. Create **no** webhook endpoint. The VM accepts no inbound connections; `stripe listen` opens an
   outbound tunnel and its signing secret is derived in each session.

Verify from a cloud session with `scripts/cloud/with-stripe.sh pnpm billing:verify-catalog`.

### 2.5 The first session, and rebuilding the cache

The setup script runs in the first session of the environment and its result is cached for later
sessions (Anthropic rebuilds it when the setup script or the network list changes, and about every
seven days). Start that first session **on a branch that contains `scripts/cloud/`**: a checkout
without it caches a VM with nothing installed, and every session then installs everything in its
SessionStart hook instead, which works but is slow. To force a rebuild, change the `Revision` line
of the setup script.

## 3. What runs when

| When                                | Script                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Once per environment cache, as root | `setup.sh`                   | Exact Node and pnpm; `pnpm install --frozen-lockfile`; Prisma client; Mailpit and Stripe CLI (pinned digests and checksums, `fetch-image-file.py`); the lockfile's Playwright Chromium with its system packages; databases created and migrated (recorded `skipped` when the environment's variables are not visible to the setup script, as observed; `session-start.sh` then does it); services stopped so the snapshot is consistent |
| Every session start and resume      | `session-start.sh`           | Guard; Node/pnpm on `PATH` for every later command (`CLAUDE_ENV_FILE`); PostgreSQL, Redis and Mailpit started; role and databases ensured; this branch's dependencies installed, Prisma client generated, dev and test migrated; Playwright browser installed if the branch moved its version; a short summary for Claude                                                                                                               |
| On demand                           | `stack.sh`, `with-stripe.sh` | Below                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`session-start.sh` exits immediately unless `CLAUDE_CODE_REMOTE=true`, so local Claude Code sessions
are untouched. It never starts an application stack and never seeds. Its full log is
`.cloud/logs/session-start.log`; the setup log is `/var/lib/factorsage-cloud/setup.log`.

## 4. Working in a session

Everything in `AGENTS.md` and `ai/workflows/` applies unchanged; only the infrastructure differs.

```bash
# Unit and integration tests (stop any stack first: they share the test database and Redis)
pnpm test
pnpm --filter @intrinsic/stock-data test:redis

# Hermetic Playwright (give `up` a 10-minute timeout; a full E2E run up to an hour)
scripts/cloud/stack.sh up e2e
pnpm test:personas:seed
pnpm test:e2e
scripts/cloud/stack.sh down

# The email lifecycle suite: the same stack with the API delivering to Mailpit
scripts/cloud/stack.sh up e2e --mail
pnpm test:e2e:mail
scripts/cloud/stack.sh down

# Development stack on the (empty) dev database
pnpm qa:seed
scripts/cloud/stack.sh up dev            # or: up dev --stripe
scripts/cloud/stack.sh status | logs api | down

# One command against the cloud Stripe sandbox
scripts/cloud/with-stripe.sh pnpm billing:verify-catalog
STRIPE_SANDBOX_SMOKE=true scripts/cloud/with-stripe.sh pnpm test:billing:sandbox
scripts/cloud/with-stripe.sh pnpm billing:reconcile -- --user qa-pro@factorsage.test --dry-run

# The billing QA personas: real subscriptions in the sandbox, reconciled by the application
scripts/cloud/with-stripe.sh pnpm qa:billing:seed -- --database test
scripts/cloud/with-stripe.sh pnpm qa:billing:status -- --database test --check
STRIPE_BILLING_PERSONAS=true scripts/cloud/with-stripe.sh pnpm test:billing:personas
scripts/cloud/stack.sh up e2e && pnpm test:e2e:billing:personas; scripts/cloud/stack.sh down
scripts/cloud/with-stripe.sh pnpm qa:billing:cleanup -- --database test --yes

# Migrations: the dev database has no drift here, so `prisma migrate dev --create-only` is safe
pnpm db:migrate:deploy && pnpm db:test:prepare
```

`pnpm cloud:stack …` and `pnpm cloud:stripe -- …` are the same two scripts.

- **Stacks** run as daemons in their own process groups, so they outlive the command that started
  them and are not subject to the 30-minute limit on Claude's background commands. `down` stops
  every process tree, reports anything else still listening on `:3000`, `:3001` or `:3011`
  (`down --force` stops it), and restores the `apps/web/next-env.d.ts` drift `next dev` leaves.
  Logs are in `.cloud/logs/stack-<role>.log`.
- **Mail**: the dev stack sends to Mailpit. `curl -s 127.0.0.1:8025/api/v1/messages` lists what
  arrived; never paste a token or link from a message into a document or log. The ordinary E2E
  stack sends nothing; `up e2e --mail` is the one E2E mode that delivers, and only to this Mailpit
  (`ai/workflows/auth-testing.md` §7, _The email lifecycle suite_). Never delete the whole mailbox:
  the suite removes only messages addressed to its own `authmail-<n>@example.test` addresses.
- **`stack.sh up dev --stripe`** starts the API with the sandbox configured, then
  `stripe listen --forward-to 127.0.0.1:3001/webhooks/stripe`, which forwards every event of the
  sandbox. The API acknowledges unhandled types (`IGNORED_UNHANDLED_TYPE`), which is what makes a
  harmless probe possible. The signing secret is redacted from the listener's log.
- **Billing QA personas** (`docs/development/billing-qa-personas.md`) are the scripted form of the
  Test Clock runbook: five accounts with real sandbox subscriptions. Seeding and the opt-in
  validation suite go through `with-stripe.sh`; the browser suite runs on the ordinary `e2e` stack,
  which has no Stripe in it, because it only reads what reconciliation already produced. Without
  `--database test` the same commands target the development database, for `up dev --stripe`.
- **Test cards only.** Stripe test mode moves no money; `4242 4242 4242 4242` succeeds,
  `4000 0000 0000 0341` attaches and fails on charge (`ai/architecture/billing.md`).
- **Playwright artifacts** (`apps/web/test-results/`) can contain persona passwords in page
  snapshots: read the summary, then delete them. They are git-ignored.
- **Live FMP hydration** (`docs/development/fmp-live-hydration.md`):
  `RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL,MSFT,NVDA --full-history`.
  One to three securities, the opt-in on that command only, `--plan` to see what a run would ask
  without asking. It needs `LIVE_FMP_API_KEY` in the environment and `financialmodelingprep.com`
  on the allowlist for as long as it is used.
- **The QA matrix** needs real thirty-year history for thirty-three securities, which an empty
  cloud dev database does not have and live hydration, capped at three, does not provide. It is
  still not possible in the cloud; do not provision it.
- **Pull requests**: `gh pr create` works through the GitHub proxy. The proxy refuses tag pushes and
  branch deletion, so never push a branch you intend to delete.

## 5. Safety model

| Threat                               | Stopped by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production or a remote database      | The guard refuses any database or Redis URL whose host is not loopback, `NODE_ENV=production` and a shared dev/test database, before anything is provisioned or started, and blanks the offending variable for the rest of the session so no hand-typed command can use it either; `pnpm qa:seed`/`qa:reset`, the test seeders, the matrix and `useTestDatabase` keep their own refusals                                                                                                                                                        |
| Live Stripe                          | No live key may exist anywhere: the guard refuses `sk_live_`/`rk_live_` in any Stripe variable, `with-stripe.sh` accepts only `sk_test_`/`rk_test_`, and the application refuses a live key outside production                                                                                                                                                                                                                                                                                                                                  |
| Ambient provider credentials         | `FMP_API_KEY`, `STRIPE_*`, `STRIPE_API_KEY` and the per-run opt-ins are blanked for the whole session; Stripe exists only inside `with-stripe.sh` and the API process of `stack.sh up dev --stripe`                                                                                                                                                                                                                                                                                                                                             |
| Live FMP                             | No FMP key under a name the application reads; `LIVE_FMP_API_KEY` is used by one command only, after a per-command opt-in, for at most three securities, inside a request budget, with every other request refused at the client (`fmp-live-hydration.md`); the session guard blanks `FMP_API_KEY`, `FMP_BASE_URL` and both live opt-ins; `stack.sh` unsets the key and the hermetic launcher blanks it; the hermetic stack's egress guard; the `RUN_LIVE_FMP_TESTS` gate. FMP stays off the network allowlist except while the command is used |
| A webhook secret from somewhere else | Derived per session from `stripe listen --print-secret`; never stored in settings or on disk                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Secrets in the web build cache       | Every variable here is ambient in every shell, and `next dev` records its environment in `apps/web/.next/dev/cache`. It is therefore started only through `apps/web/dev-server/next-dev.ts`, with an allowlisted environment, in the `e2e` and `dev` stacks alike; the E2E launcher also blanks the persona passwords for the API and the worker                                                                                                                                                                                                |
| Leaking values                       | No script prints a variable's value; the Stripe listener's log is redacted                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The scripts create and migrate local databases; they never drop, truncate or reset anything, and
they never touch an external system except to download pinned tools.

## 6. Limits and troubleshooting

- Foreground commands get 2 minutes by default (up to 10); background commands 30 minutes (up to
  2 hours, four with `BASH_MAX_TIMEOUT_MS` above). An idle VM pauses and may later be reclaimed;
  a reclaimed VM comes back from the cache with empty databases.
- The 4-vCPU VM makes the known load-sensitive tests more likely to time out — re-run a failing
  file on its own before believing it.

| Symptom                                      | Cause / fix                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Summary says `REFUSED`                       | A variable named in the reasons is wrong; fix the environment and start a new session |
| `pnpm install` fails fetching Prisma engines | `binaries.prisma.sh` is not allowed                                                   |
| Playwright install fails                     | `cdn.playwright.dev` / `playwright.download.prss.microsoft.com` are not allowed       |
| `with-stripe.sh`: no webhook signing secret  | `*.stripe.com` is not allowed, or the key is wrong                                    |
| `stack.sh up`: ports already in use          | Another stack or a stray server; `scripts/cloud/stack.sh down --force`                |
| Setup steps failed in the snapshot           | `bash scripts/cloud/setup.sh` as root re-runs them; the summary lists which failed    |

## 7. Files

| File                                   | Role                                           |
| -------------------------------------- | ---------------------------------------------- |
| `scripts/cloud/setup.sh`               | VM provisioning (environment setup script)     |
| `scripts/cloud/session-start.sh`       | SessionStart hook                              |
| `scripts/cloud/provision-databases.sh` | Role and databases, create-only                |
| `scripts/cloud/stack.sh`               | Application stacks                             |
| `scripts/cloud/with-stripe.sh`         | One command with the Stripe sandbox            |
| `scripts/cloud/lib.sh`                 | Pins, toolchain, services, the guard           |
| `scripts/cloud/fetch-image-file.py`    | One file from a digest-pinned Docker Hub image |
| `.claude/settings.json`                | Registers the hook                             |
