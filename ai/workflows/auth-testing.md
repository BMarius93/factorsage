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

| Layer                 | Requirement                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| API integration tests | PostgreSQL and Redis reachable (`pnpm infra:up`), plus a migrated `TEST_DATABASE_URL` database   |
| Playwright            | A fully running stack: PostgreSQL, Redis, the API on its port, and the web app on `E2E_BASE_URL` |
| Live API smoke        | The same running stack as Playwright                                                             |

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
- `AUTH_PASSWORD_RESET_TTL_SECONDS`
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

| Persona           | Role    | Plan      | Email variable         | Password variable         |
| ----------------- | ------- | --------- | ---------------------- | ------------------------- |
| `FREE_USER`       | `USER`  | `FREE`    | `QA_FREE_EMAIL`        | `QA_FREE_PASSWORD`        |
| `STARTER_USER`    | `USER`  | `STARTER` | `QA_STARTER_EMAIL`     | `QA_STARTER_PASSWORD`     |
| `PRO_USER`        | `USER`  | `PRO`     | `QA_USER_EMAIL`        | `QA_USER_PASSWORD`        |
| `ADMIN_USER`      | `ADMIN` | `FREE`    | `QA_ADMIN_EMAIL`       | `QA_ADMIN_PASSWORD`       |
| `DOWNGRADED_USER` | `USER`  | `FREE`    | `QA_DOWNGRADED_EMAIL`  | `QA_DOWNGRADED_PASSWORD`  |

All are email-verified. `GUEST` is a sixth access state with no row at all: it is derived from the
absence of a session (`docs/decisions/entitlements-v1.md`), so there is nothing to seed and nothing
to sign in as.

The registry is `packages/testing/src/personas.ts`, and it is the only place a persona's plan, role
or storage-state path is written down. The seeders and the Playwright projects both read it, so a
persona cannot mean `PRO` in one and `STARTER` in the other. `PRO_USER` and `ADMIN_USER` keep the
historical `QA_USER_*` / `QA_ADMIN_*` variable names, so an existing `.env` and an existing CI
secret keep working.

**Which persona to use**

- **`PRO_USER` is the account for normal local development and manual testing**, and the one every
  non-entitlement E2E spec signs in as. It is deliberately a commercial customer and *not* an
  administrator: developing against an account with entitlement overrides hides every commercial
  capacity bug until production.
- **`ADMIN_USER` is for internal and QA scenarios only** — administrative surfaces, and the
  developer QA validation matrix, which submits at a concurrency no commercial plan sells. It is
  seeded `plan=FREE`, `role=ADMIN` on purpose: plan and role are orthogonal, and an administrator on
  the smallest plan is the configuration that proves the capability comes from the role alone. Do
  not reach for it because something was refused.
- **`FREE_USER` and `STARTER_USER`** exist for the entitlement boundaries. Their fixtures sit
  exactly on a limit, so they are the wrong accounts for anything else.
- **`DOWNGRADED_USER`** holds content created under a higher tier. Nothing else should touch it.

**Never mutate a persona's plan in a test.** Personas are fixed points: a spec signs in as the plan
it is about. Moving one user between plans makes every test order-dependent and every parallel run
a race, which is the problem this table exists to remove.

Both passwords must be at least 12 characters, which is also the registration policy
(`PASSWORD_MIN_LENGTH` in `@intrinsic/contracts`).

Personas are for Playwright and live API smoke testing **only**. API integration tests must keep
creating isolated randomized users inside `TEST_DATABASE_URL`; do not convert them to depend on
persistent accounts.

## 4. Seeding the QA personas

```bash
pnpm test:personas:seed     # personas + QA securities + entitlement fixtures, in order
```

Or the three steps on their own:

```bash
pnpm test:users:seed          # the five personas
pnpm test:securities:seed     # the deterministic QA catalog rows
pnpm test:entitlements:seed   # the entitlement fixtures the entitlement specs run against
```

`pnpm test:users:seed` walks the registry, creates or updates exactly those accounts, marks them
email-verified, re-asserts their roles and plans, and removes any leftover verification
token. It
touches no other row and is safe to rerun. It targets **`TEST_DATABASE_URL`**, resolved explicitly
rather than inherited, which is the database the deterministic Playwright stack runs against
(`pnpm dev:api:e2e` / `pnpm dev:worker:e2e`).

It refuses outright when `NODE_ENV=production`, before reading any credential or opening a
connection. The `QA_ADMIN` persona is a real administrator account whose password lives in a
developer environment file, so it must never exist in a production database. This guard is
specific to the QA seeder; `pnpm db:seed`, which exists to bootstrap a genuine administrator, is
unaffected.

Implementation: `apps/api/src/seed-qa-users.ts` and `apps/api/src/auth/seed-qa-users.ts`.

`QA_ADMIN` owns the persistent QA-MATRIX Strategy and Stock List fixtures for the Backtest V1
validation matrix, seeded separately with `pnpm test:matrix:seed` after this command has run. The
administrator persona, because the sweep submits through the product's real entitlement-enforced
path at a concurrency no commercial plan sells — see `docs/development/qa-matrix-fixtures.md`. They
live in the reserved `QA-MATRIX-` namespace so they cannot collide with anything a suite creates;
`../../docs/development/qa-matrix-fixtures.md` documents them.

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
- `apps/api/src/auth/password-reset.integration.test.ts` — forgot/reset password: the
  indistinguishable response for unknown, Google-only and real addresses, hash-only storage,
  single use, rotation, expiry, concurrent redemption, the password policy, what a reset does and
  does not change, and log-leak assertions
- `apps/api/src/auth/google-auth.integration.test.ts` — Google identity resolution, the
  authoritative-email linking rule (Gmail, matching `hd`, mismatched `hd`, external), OAuth state
  and PKCE transaction binding, transaction-cookie clearing, provider failures, uniqueness under
  concurrent first sign-in, and log-leak assertions
- `apps/api/src/auth/google/google-email-authority.test.ts` — the pure authority rule on its own:
  Google-operated mailboxes, `hd` matching, casing and trailing-dot normalization, malformed
  addresses, and the refusal to promote an unverified address
- `apps/api/src/auth/google/google-auth.service.test.ts` — resolution against a scripted identity
  repository, including the `P2002` retry that a real concurrent run cannot be asked to produce on
  demand
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

**A spec's filename chooses its persona.** There is one project per persona, each starting from
that persona's saved storage state, so a spec never signs in and never switches accounts:

| Project      | Signed in as      | Spec pattern              |
| ------------ | ----------------- | ------------------------- |
| `setup`      | signs every persona in through the UI | `e2e/setup/auth.setup.ts` |
| `guest`      | nobody            | `*.guest.spec.ts`         |
| `user`       | `PRO_USER`        | `*.user.spec.ts`          |
| `admin`      | `ADMIN_USER`      | `*.admin.spec.ts`         |
| `free`       | `FREE_USER`       | `*.free.spec.ts`          |
| `starter`    | `STARTER_USER`    | `*.starter.spec.ts`       |
| `pro`        | `PRO_USER`        | `*.pro.spec.ts`           |
| `downgraded` | `DOWNGRADED_USER` | `*.downgraded.spec.ts`    |

`user` and `pro` are the same account: `user` is the historical project every non-entitlement spec
uses, `pro` is where the entitlement cases for that plan live. The split is by subject, not by
identity.

`loginAs(page, "FREE_USER")` exists in `e2e/utils/sign-in.ts` for the two cases a storage state
cannot cover — switching persona inside a test, and the guest project asserting what signing in
changes. Most specs never need it.

**Execution is serial** (`workers: 1`). The personas are persistent shared accounts and several
fixtures are capacity states — a list exactly at its limit, an account already at its active-monitor
count — so two workers touching one persona would produce entitlement failures that are real
refusals but not the ones under test. That choice predates entitlements and is load-bearing rather
than caution.

Within that, specs are independent: none changes a plan, none reads another's state, and every test
that mutates a fixture puts it back. The one exception is documented in the file that owns it —
`entitlements.downgraded.spec.ts` is `describe.serial`, because its last case proves an
over-capacity account may switch a monitor off but not back on, which the product deliberately
offers no way to undo.

Commands:

```bash
pnpm test:e2e                 # full suite
pnpm test:e2e:entitlements    # re-seeds the fixtures, then runs the entitlement projects
pnpm test:e2e:auth            # the auth suite (e2e/auth)
pnpm test:e2e:smoke           # @smoke-tagged tests only
pnpm test:e2e:headed          # headed browser
pnpm test:e2e:report          # open the last HTML report
```

Re-seed before running the entitlement projects — `pnpm test:e2e:entitlements` does it for you.
The fixtures are reconciled rather than merely inserted, so seeding again *is* the reset.

First run on a machine needs browsers:

```bash
pnpm --filter @intrinsic/web exec playwright install chromium
```

Preconditions for every run: the stack is up, migrations are applied, and `pnpm test:users:seed`
has been run at least once since the personas' credentials last changed. The lists suite
(`e2e/lists`) and the Stock Details suite (`e2e/stocks`) additionally need the deterministic
fictional QA catalog rows. `e2e/strategies` needs **neither** seed beyond the personas: a strategy
references the static series catalog in `@intrinsic/contracts`, so it touches no securities, no
market data and no provider. To seed the catalog rows the other two suites need: run `pnpm test:securities:seed` (idempotent, refuses
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

Current coverage: guest reaches sign-in, registration and password recovery — including the
neutral response for an address with no account, and both ways a reset link can be unusable
(`e2e/auth/password-recovery.guest.spec.ts`; the redeemable half needs the inbox and lives in the
API integration suite instead) — a product route bounces an anonymous
browser to `/login`, invalid credentials show the expected failure, `QA_USER` keeps a session
across navigation and is denied the ADMIN route, `QA_ADMIN` reaches the ADMIN route, and signing
out ends the session. `e2e/strategies` covers the Strategy Builder journey on desktop — create,
edit, reload, rename, delete, the not-found surface for a deleted strategy, and the
duplicate-condition rejection reached through the issue count — and on a 390px phone, asserting one
column with no horizontal scrolling, the save surface clear of the bottom navigation, contextual
help beside the edited row, and the canonical Margin of Safety explanation.
`e2e/lists` covers the full stock-list journey; `e2e/stocks` covers the
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
- Account linking depends on the address's **domain**, so the fake identities in the Google suite
  use `gmail.com`, `workspace.test` and `example.test` deliberately. Changing a test's domain
  changes which rule it exercises; do not swap one for another to make an assertion pass.
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
  7. To exercise the linking refusal by hand, register locally with an address that is neither a
     Gmail address nor in your `hd` domain, then sign in with a Google account that reports that
     same address: expect `/login?error=oauth_link_not_allowed`, no session cookie, and no new
     `OAuthAccount` row.
  8. Record only the outcome. Never record the account's password, the authorization code, the
     PKCE verifier, the ID token, or the session cookie.

## 11. Email test policy

- Automated tests never send real email. `EMAIL_SENDER` is replaced with
  `apps/api/src/email/in-memory-email-sender.ts`, and tests read the verification link out of the
  captured message.
- Never configure real SMTP credentials for a test run.
- For manual local testing, point `SMTP_HOST`/`SMTP_PORT` at a local catch-all relay such as
  Mailpit. `SMTP_USER`/`SMTP_PASSWORD` may stay empty for an unauthenticated local relay.
- Verification and password-reset tokens are single-use and only their SHA-256 hash is stored.
  Never log, print, or paste a plaintext token.
- Playwright cannot read an inbox, so no browser test redeems a real reset or verification link.
  Anything that needs the token is an API integration test, which reads it out of the message the
  in-memory sender captured.

## 12. Never commit

- `.env` or any file containing real credentials
- `apps/web/playwright/.auth/*.json`
- `playwright-report/`, `test-results/`, traces, videos, or screenshots containing a session
- Real emails, passwords, cookies, JWTs, OAuth tokens, authorization codes, or SMTP credentials in
  source, tests, fixtures, Markdown, or commit messages
