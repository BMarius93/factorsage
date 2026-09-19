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
pnpm test:personas:seed     # personas + QA securities + QA built-ins + entitlement fixtures, in order
```

Or the steps on their own:

```bash
pnpm test:users:seed          # the five personas
pnpm test:securities:seed     # QA catalog rows, prices, SP500, the market references; prunes leaked fixture benchmarks
pnpm test:builtins:seed       # QA built-in lists/strategy/monitors with exact Dashboard state
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
  single use, expiry, resend rotation, login gating, and the rotation races: a resend that reuses
  the row between the redemption transaction's read and its write must neither be consumed by the
  superseded link nor deleted by its cleanup
- `apps/api/src/auth/registration-enumeration.integration.test.ts` — AUTH-003: the response matrix
  (new, pending, verified password, Google-only, password + Google and cooling-down addresses get an
  identical status, body, content type, header set and no cookie), the protected state of every
  existing account (credential, verification, session version, role, plan, OAuth rows, reset link,
  live session), the new-address flow from captured link to sign-in, pending and pre-AUTH-003
  pending rows, the per-address cooldown (every state, normalization, neighbours, re-opening, shared
  with resend, no rotation inside it), simulated provider failure / delay / recovery, repeated
  concurrent registrations and registration racing verification, non-enumerating login and
  recovery for pending accounts, and log-leak assertions
- `apps/api/src/auth/email-verification.integration.test.ts` — AUTH-002: the full pre-account
  takeover (an attacker registers the victim's address; the victim's verification installs the
  victim's chosen password; the attacker's gets the generic `401`), unknown / malformed / expired /
  used tokens changing nothing, the pre-AUTH-002 `{ token }` request refused, a rollback injected
  after every write of the redemption, two concurrent redemptions with different passwords, a
  pending reset link dropped, resent links, session revocation on a signed-in account holding a
  late link, log-leak assertions and the response shape
- `apps/api/src/auth/password-reset.integration.test.ts` — forgot/reset password: the
  indistinguishable response for unknown, Google-only and real addresses, hash-only storage,
  single use, rotation, expiry, concurrent redemption, the password policy, what a reset does and
  does not change, log-leak assertions, and the cost of redemption — an unknown, expired or
  superseded token must not reach the Argon2id hash, a real one must reach it exactly once, and
  the cheap pre-check must still lose to the transaction when the token is taken mid-hash, and the
  same rotation races the verification suite covers
- `apps/api/src/auth/google-auth.integration.test.ts` — Google identity resolution, the
  authoritative-email linking rule (Gmail, matching `hd`, mismatched `hd`, external), OAuth state
  and PKCE transaction binding, transaction-cookie clearing, provider failures, uniqueness under
  concurrent first sign-in, registration racing a Google link or a first Google sign-in (AUTH-003),
  log-leak assertions, and the return destination (UX-003): a valid `next` returns to
  `WEB_BASE_URL` + that path, every hostile or malformed `next` lands on `/dashboard`, a
  transaction cookie rewritten to carry a hostile destination is re-validated at the callback, and
  state/PKCE/nonce binding and failure redirects are unchanged when a destination is carried
- `apps/api/src/auth/return-path.test.ts` and `apps/web/src/features/auth/utils/return-path.test.ts`
  — the two `safeReturnPath` validators against the one shared corpus in
  `packages/testing/src/return-path-corpus.ts`
- `apps/api/src/email/no-real-email.guard.test.ts` — proves the package-wide `nodemailer`
  replacement is live, so no API test can reach a real mail server
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
5. `POST /auth/logout` — expect `204`, then `GET /auth/me` **from that client** returns `401`
   (its cookie was cleared). Ordinary logout revokes nothing: a second session of the same account,
   or a copy of the cleared token, still answers `200`.
6. Sign in twice (two cookie jars), then `POST /auth/logout-all` with one — expect `204` and a
   cleared cookie; `GET /auth/me` with **either** saved token now returns `401` (SESSION-002).

### Revocation check with two browser profiles

Manual verification of SESSION-002 against a running stack (`ai/architecture/authentication.md`,
*What a session is, and what ends it*):

1. Sign in to the same account in browser profile A and browser profile B.
2. **Sign out** (account menu) in A — B stays signed in on reload.
3. Sign in again in A.
4. **Sign out everywhere** (account menu) in A — A lands on `/login`; reloading any authenticated
   page in B also ends on `/login`.
5. Sign in again in both.
6. Request a reset from `/forgot-password` and complete it from the emailed link.
7. Reload an authenticated page in A and in B — both are signed out.
8. Sign in with the new password (the old one is refused).
9. Sign in with Google (where configured) — the session works, and "Sign out everywhere" ends it.

The same flows over HTTP: `POST /auth/logout-all` needs only the session cookie and no body; a
reset is `POST /auth/forgot-password` followed by `POST /auth/reset-password`.

### Email-verification takeover check (AUTH-002)

Against a running stack with a local catch-all SMTP relay (section 11). Since AUTH-003 the
registration form takes no password, so there is no attacker password left to activate; the check
now confirms that only the link holder's password exists:

1. Register a fresh address on `/register` (email only, playing the attacker).
2. Sign in with that address and any password **A** — expect the generic "Unable to sign in with
   those credentials.", exactly as for an unknown address.
3. Open the verification link from the relay (playing the mailbox owner). The page shows **New
   password** and **Confirm password** and has verified nothing yet; the address bar holds only
   `?token=…`.
4. Enter a mismatched confirmation — expect the inline mismatch error and no request in the
   network panel. Then enter password **B** twice and submit — expect "Your email address is
   verified and your password is set." and a **Continue to sign in** link to `/login`. The
   network panel shows one `POST /auth/verify-email` whose JSON body carries `token` and
   `password`, and no password in any URL.
5. Sign in with **A** — expect the generic failure. Sign in with **B** — expect the dashboard.
6. Open the same link again and submit any password — expect "This verification link is invalid,
   expired, or has already been used." with the resend form.
7. Repeat steps 3–4 at 390 px width; the form must fit without horizontal scroll.

Over HTTP, `POST /auth/verify-email` with `{ "token": "…" }` alone must answer `400` and leave the
link redeemable.

### Registration enumeration check (AUTH-003)

**Not executed in the AUTH-003 PR.** It was deferred on purpose to preserve the Mailtrap sandbox's
message quota; every automated check used the in-memory mailer. Run it once, by hand, against a
local capture relay (preferred) or the sandbox, with synthetic addresses on a domain you control in
that relay:

1. Pick three addresses: **N** (never used), **P** (register it once and leave it unverified) and
   **V** (an account that is verified — sign in with it once to be sure). Wait five minutes after
   creating **P** so its cooldown has passed.
2. On `/register`, submit **N**, then **P**, then **V**. Each time expect the identical page — "If
   this address can be used, you'll receive an email with the next step." — and, in the network
   panel, `202 {"status":"accepted"}` with no `Set-Cookie`.
3. In the relay: **N** and **P** each received one "Finish creating your FactorSage account" email
   whose only link is `WEB_BASE_URL/verify-email?token=…`; **V** received one "You already have a
   FactorSage account" email with sign-in (and, for a password account, recovery) links and no
   `token=` anywhere. No email contains a password.
4. Submit **N**, **P** and **V** again immediately. Expect the same page and **no** new email for any
   of them; **P**'s link from step 3 still works.
5. Open **N**'s link, choose a password, sign in with it. Sign in as **V** and confirm nothing
   changed (same password, same sessions on another browser).
6. Sign in with **P** and any password before activating it — expect "Unable to sign in with those
   credentials.", exactly as for an unknown address.
7. Repeat step 2 at 390 px width; the form and the confirmation fit without horizontal scroll.

Record only outcomes. Never paste a token, link, password or cookie into a document or log.

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
lets `e2e/stocks` drive real Stock Details without a market-data provider. `QATEST2` has no market
data and is declared complete and empty. Rerunning is safe and is the reset (below).

### The deterministic fixture boundary (E2E-001…E2E-007)

The E2E stack is **hermetic**: everything it talks to runs on this machine, and that is enforced
and checked rather than assumed.

**What is real and what is faked**

| Dependency | On the E2E stack | Where it is set |
| --- | --- | --- |
| PostgreSQL | Real — `TEST_DATABASE_URL` (`intrinsic_value_test`), never `DATABASE_URL` | launcher: `DATABASE_URL=$TEST_DATABASE_URL` |
| Redis | Real — the same `REDIS_URL` instance; see namespaces below | `.env` |
| API, worker, web | Real applications, ordinary dev commands (`dev:api`, `dev:worker`, `dev:web`) | `apps/api/src/e2e-stack/launch.ts` |
| FMP (market data, profiles, statements, quotes, holidays) | **Faked**: fixture server on `127.0.0.1:3011` | `FMP_BASE_URL`, `FMP_API_KEY=e2e-fixture-provider` |
| Company-logo CDN | **Faked in the browser**: every `/api/logo/*` answers the UX-005 miss (`204`) | `apps/web/e2e/fixtures.ts` |
| SMTP / Mailtrap | **Off**: the `SMTP_*` group is blanked, so the API uses its unconfigured sender | launcher |
| Google OAuth | **Off**: the `GOOGLE_*` group is blanked; `/auth/providers` reports no Google | launcher |
| Stripe | **Inert**: test-mode placeholder key and price ids, so billing pages render; any SDK call is blocked by the guard | launcher |
| Anything else | **Blocked** by the egress guard | `packages/testing/egress-guard.cjs` |

The overlay is one function, `e2eStackEnvironment` in `packages/testing/src/e2e-stack.ts`, laid
over the developer's `.env` (a shell value — even an empty one — beats `.env`, so a blank really
switches an integration off). No real provider credential is present in an E2E process. Production
configuration is untouched: `FMP_BASE_URL` is unset there, and production refuses a loopback or
plain-http value.

**Where fixture responses live.** `apps/api/src/e2e-stack/fake-fmp.ts`. It answers only the fixture
namespace (`apps/api/src/e2e-stack/fixture-boundary.ts`, derived from the seeds themselves):

- daily bars for a fixture security (`QATEST1`, `QATEST2`, `ENTF001`…`ENTF100`) or fixture
  benchmark (`SPY`, `^GSPC`, `^DJI`, `^VIX`): `[]` — "no bars beyond what the seed wrote". An empty
  answer never deletes a persisted row;
- profile and the three financial statements of a fixture security: `[]`;
- current quotes (`batch-quote`) of fixture securities: `[]`, as the real provider answers a
  fictional ticker;
- exchange holidays: NYSE's rule-based full closures for the requested years.

Anything else — another endpoint, a real symbol, the wrong key — gets `404`/`401` naming the
missing fixture, an `UNEXPECTED` line on the server's stderr, and a journal entry that fails the
Playwright run. The client treats those statuses as non-retryable, so a gap fails at once.

In a clean run the server sees only: the Monitor worker's `batch-quote` for the fixture universe
(current quotes cannot be seeded), and — once per reseed — the thirty-year PRO run's request for
`SPY` bars older than the seeded window. Nothing hydrates a fixture security from it.

**How time and freshness are controlled.** The seeds anchor every series to the day they run and
stamp their watermarks with the seed time. The launcher sets `STOCK_RECENT_PRICE_FRESHNESS_MS` and
`STOCK_FUNDAMENTALS_FRESHNESS_MS` to thirty days for the API and worker only, so a seed from this
morning, yesterday or last week is still fresh and nothing re-reads a tail. Were a tail ever re-read,
the fixture server would answer it with no bars, which changes nothing. There is no fake clock: the
product, the browser and the seeds all use the real date, and the fixture window moves with the seed.

**What reseeding deletes.** `pnpm test:personas:seed` (and its parts) is reset → write → evict:

- for every fixture security: `DailyPrice`, `WeeklyPrice`, `DailyDerivedState`,
  `FinancialStatement`, `SecurityProfile`, `StockDatasetCoverage`, `StockDatasetState`;
- for the current series of `SP500`, `SP500_INDEX`, `DJIA_INDEX`, `VIX_INDEX`: `BenchmarkDailyPrice`,
  `BenchmarkDatasetCoverage`, `BenchmarkDatasetState`;
- the Redis projections of all of them (`stock-data:v2:*` per security, `benchmark:v1:*` per series);
- orphaned non-catalog benchmarks left by integration suites (`pruneOrphanedFixtureBenchmarks`);
- the entitlement fixtures' own runs, lists, monitors and strategies, which it reconciles.

It deletes nothing else: never a `Security` or `Benchmark` row, never a user, never a symbol outside
the namespace (`resetE2eFixtureSecurityData` refuses one before any statement runs), and never the
development database. Seeding twice leaves identical rows; only sync timestamps move
(`fixture-reseed.integration.test.ts`).

**Adding a stock or provider fixture.**

1. Add the security to a seed (`QA_SECURITIES`, or the entitlement universe). It joins the namespace
   automatically, so reseeding resets it and the fixture server answers it.
2. Give it data: seeded rows plus coverage (`seedQaStockData` is the model), or declare it complete
   and empty with `seedEmptyStockCoverage`. Either way the loader must have nothing to ask.
3. A new *kind* of provider request (endpoint) needs an answer in `answerFakeFmpRequest`, and a test
   in `fake-fmp.test.ts`. Prefer making the loader not ask — seed the dataset state — over answering.
4. Run the suite; the teardown names any request that was still unanswered.

**How to run the stack.**

```bash
pnpm infra:up
set -a && . ./.env && set +a && pnpm db:test:prepare   # migrations only; never a reset
pnpm dev:fmp:e2e        # terminal 1: fixture FMP server, 127.0.0.1:3011
pnpm dev:api:e2e        # terminal 2: API on :3001, test DB
pnpm dev:worker:e2e     # terminal 3: two backtest children + one Monitor child
pnpm dev:web:e2e        # terminal 4: web on :3000 (the API's CORS origin)
pnpm test:personas:seed # reset and seed every fixture
pnpm test:e2e
pnpm test:entitlements:seed && pnpm test:e2e   # every further run
```

Market data never needs reseeding between runs: the second run finds exactly what the first left
(verified: `SP500` still ends on its seeded close, no fixture security gained a row, only the
pinned runs in flight). The **entitlement** fixtures do, and always have: the last case of
`entitlements.downgraded.spec.ts` switches a Monitor off on an over-capacity account, which the
product deliberately offers no way to undo, so a second run without `pnpm test:entitlements:seed`
fails that file on "Enabled". `pnpm test:e2e:entitlements` reseeds them for you.

Stop the development stack first (same ports) and never run `pnpm test` at the same time — they
share the test database (audit T-1). Do not edit `apps/api/src` while a run is in progress: the API
watcher restarts and requests in that window fail as network errors.

**How the egress guard proves isolation.** Every E2E process — the launchers, pnpm, `tsc`, Nest,
Next and both worker children — starts with `NODE_OPTIONS=--require=…/egress-guard.cjs`. The guard
patches `net.Socket.prototype.connect`, which every Node socket goes through (`fetch`/undici, `http`,
`tls`, drivers): a loopback destination proceeds; anything else is refused with
`E2E_EGRESS_BLOCKED` *before* a DNS lookup or a packet leaves, and recorded in
`.e2e-stack/egress.jsonl` (git-ignored) together with every process that armed it. The Playwright
global setup (`apps/web/e2e/global-setup.ts`) refuses to start unless the listeners on `:3001` and
`:3000` and a backtest worker child have armed the guard; its teardown fails the run on any
unanswered fixture request, any blocked connection, or any persona run left in flight, and prints
the counts. The one blocked destination it tolerates (and still prints) is `registry.npmjs.org`
from the web process: `next dev`'s own version check.

**Databases, Redis namespaces and ports.** PostgreSQL `intrinsic_value_test`. Redis: the shared
instance from `REDIS_URL`; stock and benchmark projections are keyed by row id (`stock-data:v2:*`,
`benchmark:v1:*`) so they cannot collide with the development database's ids, the FMP request gate
`stock-data:v2:fmp:*` is shared (harmless — the fixture server is the only destination), and HTTP
rate-limit counters use their own `rate-limit:e2e` namespace. Ports: web `3000`, API `3001`, fixture
FMP `3011`, PostgreSQL `5432`, Redis `6379`.

**Cleanup expectations after a run.** Every spec that submits a backtest waits, in `afterEach` or
inline, for its runs to reach `COMPLETED` or `FAILED` (`e2e/utils/backtests.ts`), so a run is never
left holding a persona's concurrency slot; the teardown checks it. Afterwards the only non-terminal
runs are the entitlement fixtures' pinned `ENT-In Flight` runs (lease 2099, never claimed). Lists and
strategies a spec creates are deleted by that spec. Stop the stack with Ctrl-C in each terminal (the
worker supervisor first); `ps`, `lsof -nP -iTCP:3000,3001,3011 -sTCP:LISTEN` and
`pg_stat_activity` should then show nothing attached to the test database.

**The shared Playwright infrastructure.** Every spec imports `test` from `e2e/fixtures.ts` (ESLint
enforces it). It stubs logos and blocks provider image hosts in every browser context, and exposes
`logoRequests`; a context opened by hand gets the same with `installBrowserStubs`. Console, page and
request failures are collected by the one `watchForIssues` in `e2e/utils/page-issues.ts`, which
filters nothing but the page's own aborted requests. `e2e/infra/hermetic-browser.guest.spec.ts`
proves both pieces against a page Playwright serves itself.

Return-destination coverage (UX-003) signs in as an existing persona through the real form and
creates nothing: `e2e/builtins/collections.guest.spec.ts` (a built-in strategy's prompt, then
signing in returns to the strategy with the backtest link prefilled) and
`e2e/auth/return-path.guest.spec.ts` (a bounce from `/backtests/new?strategyId=…` returns to that
exact URL; hostile `next` values land on `/dashboard` and the browser never contacts the hostile
host). `submitSignInForm` in `e2e/utils/sign-in.ts` fills the form already on screen so a
`?next=` URL is not replaced by a bare `/login`.

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
  9. Return destination (UX-003): as a Guest open a built-in Monitor, click **Backtest this
     monitor**, choose **Sign in** in the prompt, then **Continue with Google** — expect to land back
     on the same Monitor. Then open `/login?next=//example.com` directly and continue with Google —
     expect `/dashboard` on this site. Neither step was executed in the UX-003 PR, which had no real
     Google client; the automated suite above covers both through the fake identity provider.

## 11. Email test policy

- Automated tests never send real email. Two layers make that structural:
  - every suite that sends mail replaces `EMAIL_SENDER` with
    `apps/api/src/email/in-memory-email-sender.ts` and asserts in `beforeAll` that the application
    resolved that instance; tests read links out of the captured message and simulate failure with
    `failWith` (or a held `send` for delay);
  - `apps/api/vitest.config.ts` loads `src/email/no-real-email.setup.ts` before every API test file,
    which replaces `nodemailer` so a `SmtpEmailSender` built from a developer `.env` rejects every
    send before opening a socket. `no-real-email.guard.test.ts` fails if that ever stops being true.
- Registration and resend send **after** the response (`BackgroundEmailDispatcher`, AUTH-003). A
  test that inspects captured mail or token rows calls `dispatcher.drain()` first; `app.close()`
  drains too.
- Never configure real SMTP credentials for a test run.
- For manual local testing, point `SMTP_HOST`/`SMTP_PORT` at a local catch-all relay such as
  Mailpit. `SMTP_USER`/`SMTP_PASSWORD` may stay empty for an unauthenticated local relay.
- The Playwright stack is a real API: `e2e/entitlements/entitlements.admin.spec.ts` registers an
  `example.test` address. `pnpm dev:api:e2e` blanks the whole `SMTP_*` group, so that registration
  reaches the unconfigured sender and no message is sent, whatever the developer's `.env` holds; the
  egress guard would block an SMTP connection regardless.
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

## Rate limiting and the E2E stack

The API rate-limits credential endpoints at 20 attempts per five minutes **per client IP**
(`ai/architecture/rate-limiting.md`). Playwright drives everything from one loopback address and
signs in far more often than a person does — the auth setup alone authenticates every persona — so
the running API needs headroom or the suite fails on `429` in a way that looks like a broken login.

`pnpm dev:api:e2e` therefore starts the API with its own counter namespace and a wide allowance
multiplier (set by `e2eStackEnvironment`), exactly as it selects the test database:

```bash
RATE_LIMIT_KEY_NAMESPACE=rate-limit:e2e RATE_LIMIT_ALLOWANCE_MULTIPLIER=100
```

Enforcement stays **on**, which is deliberate: an endpoint that accidentally became unusable should
still fail the suite. If you start the API by another route and see `429` from `/auth/login`, that
is this — not a credential problem. Vitest suites handle the same thing themselves through
`useIsolatedRateLimits()` from `@intrinsic/testing`.
