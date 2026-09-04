# Authentication testing workflow

Operational source of truth for agents and engineers working on FactorSage authentication tests.
Read this before changing auth tests, adding E2E coverage, or running anything against a live
stack.

`ai/architecture/authentication.md` describes what the system does. This document describes how to
exercise it.

> Never commit real emails, passwords, cookies, JWTs, OAuth tokens, SMTP credentials, or Playwright
> storage state. Every credential comes from an environment variable. This file names variables
> only; it must never contain a value.

## 1. Required infrastructure

| Layer | Requirement |
|---|---|
| API integration tests | PostgreSQL and Redis reachable (`pnpm infra:up`), plus a migrated `TEST_DATABASE_URL` database |
| Playwright | A fully running stack: PostgreSQL, Redis, the API on its port, and the web app on `E2E_BASE_URL` |
| Live API smoke | The same running stack as Playwright |

Playwright deliberately defines no `webServer`: it never starts, rebuilds, or resets a stack, so a
suite run cannot destroy a developer's database.

## 2. Environment variable names

Auth behaviour is configured only through `packages/config/src/index.ts`. Business code never reads
`process.env` directly.

Application:

- `AUTH_JWT_SECRET`
- `AUTH_TOKEN_TTL_SECONDS`
- `AUTH_COOKIE_NAME`
- `AUTH_EMAIL_VERIFICATION_TTL_SECONDS`
- `WEB_BASE_URL`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`

Testing:

- `TEST_DATABASE_URL` — dedicated PostgreSQL database for every DB-backed suite
- `E2E_BASE_URL` — the running web app Playwright drives (defaults to `http://localhost:3000`)
- `QA_USER_EMAIL`, `QA_USER_PASSWORD`
- `QA_ADMIN_EMAIL`, `QA_ADMIN_PASSWORD`

All of these live in the git-ignored repository-root `.env`. `.env.example` documents every one
of them and leaves the optional `GOOGLE_*` and `SMTP_*` groups, the `QA_*` personas, `ADMIN_*` and
`FMP_API_KEY` empty, so `cp .env.example .env` yields a stack that boots with Google and email
simply not offered. Both groups are all-or-nothing: setting only part of one is rejected at
startup rather than silently disabled, so do not put a default back into an otherwise empty
group.

## 3. QA personas

Two persistent accounts exist for browser and live-stack testing. They are referred to by logical
name, never by address.

| Persona | Role | Email variable | Password variable | Email state |
|---|---|---|---|---|
| `QA_USER` | `USER` | `QA_USER_EMAIL` | `QA_USER_PASSWORD` | verified |
| `QA_ADMIN` | `ADMIN` | `QA_ADMIN_EMAIL` | `QA_ADMIN_PASSWORD` | verified |

Both passwords must be at least 12 characters, which is also the registration policy
(`PASSWORD_MIN_LENGTH` in `@intrinsic/contracts`).

Personas are for Playwright and live API smoke testing **only**. API integration tests must keep
creating isolated randomized users inside `TEST_DATABASE_URL`; do not convert them to depend on
persistent accounts.

## 4. Seeding the QA personas

```bash
pnpm test:users:seed
```

The command reads the four `QA_*` variables, creates or updates exactly those two accounts, marks
both email-verified, re-asserts their roles, and removes any leftover verification token. It
touches no other row and is safe to rerun. It targets `DATABASE_URL`, which is the database the
running stack uses, so run it against the development stack Playwright will drive.

It refuses outright when `NODE_ENV=production`, before reading any credential or opening a
connection. The `QA_ADMIN` persona is a real administrator account whose password lives in a
developer environment file, so it must never exist in a production database. This guard is
specific to the QA seeder; `pnpm db:seed`, which exists to bootstrap a genuine administrator, is
unaffected.

Implementation: `apps/api/src/seed-qa-users.ts` and `apps/api/src/auth/seed-qa-users.ts`.

## 5. API auth integration tests

```bash
pnpm infra:up
TEST_DATABASE_URL=... pnpm db:test:prepare      # once, after a schema change
pnpm --filter @intrinsic/api test
```

Auth suites:

- `apps/api/src/auth/auth.integration.test.ts` — login, session cookie, `/auth/me`, logout, role
  authorization, verified/unverified and external-only login behaviour
- `apps/api/src/auth/registration.integration.test.ts` — registration, token issuing, verification,
  single use, expiry, resend rotation, login gating
- `apps/api/src/auth/google-auth.integration.test.ts` — Google identity resolution, account
  linking, OAuth state and PKCE transaction binding, transaction-cookie clearing, provider
  failures, and log-leak assertions
- `apps/api/src/auth/google/google-oidc-identity-provider.test.ts` — the real provider: S256 PKCE
  challenge, verifier use at the token exchange, `verifyIdToken` audience, and refusal on
  signature/audience/issuer/expiry validation failures
- `packages/config/src/index.test.ts` — configuration validation and secret exposure

Every DB-backed file calls `useTestDatabase()` at module scope, before any Prisma client is
constructed. There is no fallback to `DATABASE_URL`.

## 6. Live API smoke testing

There is no dedicated live auth smoke suite. Against a running stack, the QA personas support a
manual check with any HTTP client:

1. `POST /auth/login` with the `QA_USER` variables — expect `200` and a `Set-Cookie` for the
   configured `AUTH_COOKIE_NAME`.
2. `GET /auth/me` with that cookie — expect `200` and only `id`, `email`, `role`.
3. `GET /admin/health` with that cookie — expect `403`.
4. Repeat with the `QA_ADMIN` variables — expect `200` from `GET /admin/health`.
5. `POST /auth/logout` — expect `204`, then `GET /auth/me` returns `401`.

Never paste a real cookie, token, or password into a document, a commit message, or a log.

## 7. Playwright

Everything lives in the web workspace: `apps/web/playwright.config.ts` and `apps/web/e2e/`.

Projects:

| Project | Auth | Spec pattern |
|---|---|---|
| `setup` | signs both personas in through the UI | `e2e/setup/auth.setup.ts` |
| `guest` | none | `*.guest.spec.ts` |
| `user` | `QA_USER` storage state | `*.user.spec.ts` |
| `admin` | `QA_ADMIN` storage state | `*.admin.spec.ts` |

Commands:

```bash
pnpm test:e2e            # full suite
pnpm test:e2e:auth       # the auth suite (e2e/auth)
pnpm test:e2e:smoke      # @smoke-tagged tests only
pnpm test:e2e:headed     # headed browser
pnpm test:e2e:report     # open the last HTML report
```

First run on a machine needs browsers:

```bash
pnpm --filter @intrinsic/web exec playwright install chromium
```

Preconditions for every run: the stack is up, migrations are applied, and `pnpm test:users:seed`
has been run at least once since the personas' credentials last changed. The lists suite
(`e2e/lists`) and the Stock Details suite (`e2e/stocks`) additionally need the deterministic
fictional QA catalog rows: run `pnpm test:securities:seed` (idempotent, refuses
`NODE_ENV=production`; seeds `QATEST1`/`QATEST2`). E2E never assumes real market symbols exist in
an environment's catalog.

`pnpm test:securities:seed` also seeds `QATEST1`'s market data: a deterministic synthetic price
history, the derived state the production calculators build from it (daily and weekly moving
averages, carried-forward completed weeks), fixture intrinsic-value model/blend results, and the
dataset coverage/state watermarks that tell the canonical loader nothing is missing. That is what
lets `e2e/stocks` drive real Stock Details without a market-data provider. The watermarks carry the
seed's own timestamp and the loader treats a price tail older than
`STOCK_RECENT_PRICE_FRESHNESS_MS` (default 6 hours) as stale, so **run the seed shortly before the
Stock Details suite** rather than relying on a seed from a previous day. Rerunning is safe and
produces the same data for the same day. `QATEST2` deliberately stays identity-only.

Current coverage: guest reaches sign-in and registration, a product route bounces an anonymous
browser to `/login`, invalid credentials show the expected failure, `QA_USER` keeps a session
across navigation and is denied the ADMIN route, `QA_ADMIN` reaches the ADMIN route, and signing
out ends the session. `e2e/lists` covers the full stock-list journey; `e2e/stocks` covers the
Stock Details `Indicators` catalog — every group and entry (counts derive from
`@intrinsic/contracts`, never a copy), the default `Balanced` selection,
daily/weekly/model/blend overlays together, deselection, the disabled unavailable state, the
always-visible price series, desktop and phone viewports, keyboard operation, and the absence of
console errors or failed requests — plus the RSI oscillator journey: the shared lower pane's full
selection lifecycle, the 30/50/70 levels, unitless legend readings beside price overlays, and
duplication-free repeated toggling.

## 8. Storage state

- `apps/web/playwright/.auth/user.json`
- `apps/web/playwright/.auth/admin.json`

These hold live session cookies. They are git-ignored and must never be committed, pasted, or
attached to an issue. Delete them to force a fresh sign-in; the `setup` project recreates them.

## 9. Cleanup and isolation

- API integration tests create users with a randomized suffix and delete exactly those rows in
  `afterAll`. They never truncate tables and never touch `DATABASE_URL`.
- Playwright signs in and reads. It creates no accounts, deletes nothing, and never talks to
  PostgreSQL directly — the browser UI and the public API are its only access paths.
- Do not give Playwright database credentials.
- Signing out inside a spec only affects that test's browser context; the stored state file is
  unchanged.

## 10. Google test policy

- Deterministic tests never call Google. `apps/api/src/auth/google-auth.integration.test.ts`
  replaces the `GOOGLE_IDENTITY_PROVIDER` port, so the token/profile exchange is the only faked
  part; transaction minting, PKCE derivation, state handling, linking rules, persistence, cookie
  issuing, and redirects all run for real. The provider unit test substitutes `OAuth2Client`
  instead, so ID-token validation is exercised without network access.
- Never weaken ID-token verification to make a test easier. Identity must always come from
  `verifyIdToken`, never from decoding a token.
- Do not automate Google's real login or consent screen in Playwright or CI. It is a third-party
  UI with bot protection and it would require storing real Google credentials.
- Optional manual smoke (never in CI), when a real Google client is configured:
  1. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` in the local `.env`
     and register that callback URL in the Google Cloud console.
  2. Restart the API and confirm `GET /auth/providers` reports `{"google":true}`.
  3. Open `/login`, choose **Continue with Google**, and complete consent with a personal test
     Google account.
  4. Confirm the authorization redirect carries `code_challenge_method=S256`, a `code_challenge`,
     and a `nonce`, and that no `code_verifier` appears in the address bar.
  5. Expect a redirect to `/dashboard`, an account menu showing that address, and a `User` row with
     a null `passwordHash`, a set `emailVerifiedAt`, and one `OAuthAccount`.
  6. Repeat the sign-in and confirm no second user or second `OAuthAccount` appears.
  7. Record only the outcome. Never record the account's password, the authorization code, the
     PKCE verifier, the ID token, or the session cookie.

## 11. Email test policy

- Automated tests never send real email. `EMAIL_SENDER` is replaced with
  `apps/api/src/email/in-memory-email-sender.ts`, and tests read the verification link out of the
  captured message.
- Never configure real SMTP credentials for a test run.
- For manual local testing, point `SMTP_HOST`/`SMTP_PORT` at a local catch-all relay such as
  Mailpit. `SMTP_USER`/`SMTP_PASSWORD` may stay empty for an unauthenticated local relay.
- Verification tokens are single-use and only their SHA-256 hash is stored. Never log, print, or
  paste a plaintext token.

## 12. Never commit

- `.env` or any file containing real credentials
- `apps/web/playwright/.auth/*.json`
- `playwright-report/`, `test-results/`, traces, videos, or screenshots containing a session
- Real emails, passwords, cookies, JWTs, OAuth tokens, authorization codes, or SMTP credentials in
  source, tests, fixtures, Markdown, or commit messages
