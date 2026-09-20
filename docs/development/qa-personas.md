# Manual QA personas

Tooling for **hands-on release testing**: four clean accounts, one per access state worth checking,
each in its own visible browser window with its own persistent session, all signed in at once.

It exists so a release pass can be _done by hand_. Nothing here creates a Stock List, a Strategy, a
Monitor, a Backtest or a Signal — building those through the product's own screens is the test, and
anything seeded in advance would be a creation flow that never got exercised.

> Not to be confused with `pnpm test:personas:seed`, which prepares the **same accounts plus their
> entitlement fixtures** in the hermetic Playwright database (`TEST_DATABASE_URL`). That is for the
> automated suite. This is for a person clicking. They share one persona registry on purpose —
> `packages/testing/src/personas.ts` — so a persona cannot mean `PRO` in one and `STARTER` in the
> other.

## 1. The personas

| Handle    | Persona        | Plan      | Role    | Credentials                                |
| --------- | -------------- | --------- | ------- | ------------------------------------------ |
| `free`    | `FREE_USER`    | `FREE`    | `USER`  | `QA_FREE_EMAIL` / `QA_FREE_PASSWORD`       |
| `starter` | `STARTER_USER` | `STARTER` | `USER`  | `QA_STARTER_EMAIL` / `QA_STARTER_PASSWORD` |
| `pro`     | `PRO_USER`     | `PRO`     | `USER`  | `QA_USER_EMAIL` / `QA_USER_PASSWORD`       |
| `admin`   | `ADMIN_USER`   | `FREE`    | `ADMIN` | `QA_ADMIN_EMAIL` / `QA_ADMIN_PASSWORD`     |

`ADMIN_USER` is included because the product already has a real authorization role: built-in
`SYSTEM` content is editable only by `role = ADMIN` (`AGENTS.md` invariant 21). It is deliberately
`plan = FREE`, because plan and role are orthogonal columns and an administrator on the smallest
plan is the configuration that proves a capability comes from the role alone. No authorization
model was invented for this tooling.

`GUEST` needs no persona: it is the absence of a session, so any ordinary private window is one.

`DOWNGRADED_USER` is deliberately **not** part of this set. It exists to hold content created under
a higher plan — states unreachable through the UI by design — so it is the one persona that must
not be emptied. `pnpm test:entitlements:seed` owns it.

## 2. How the tier is assigned

`User.plan` is a persisted column, and it is the only thing the entitlement resolver reads
(`docs/decisions/entitlements-v1.md`, `ai/architecture/entitlements.md`). `pnpm qa:seed` writes that
column through the same `seedQaUsers` the Playwright seeder uses, and nothing else:

```text
User.plan  ->  resolveEntitlements()  ->  the guards at every canonical mutation boundary
```

So a QA persona is on exactly the code path a paying customer is on. There is no QA branch in the
resolver, no override, and **nothing is faked in the frontend** — `GET /entitlements` is advisory
for the UI, and every limit is enforced again server-side from the persisted plan.

**Stripe is not involved.** Billing may move `User.plan` and nothing else, and the direction is
one-way (`AGENTS.md` invariant 18): no entitlement question is ever answered by consulting Stripe.
Seeding the column directly is therefore the simplest mechanism the architecture already supports,
and it creates no Stripe customer, subscription or invoice. If you _do_ drive a persona through
test-mode Checkout, that persona gains a `BillingSubscription` mirror; `pnpm qa:reset` reports it
and re-asserts the declared plan, but the next billing reconciliation is authoritative and may move
the plan again. `pnpm qa:reset` never writes billing state, because `BillingReconciliationService`
is its only writer.

## 3. Setup

**Prerequisites**

- The repository installed (`pnpm install`) and infrastructure up (`pnpm infra:up`).
- The development database migrated (`pnpm db:migrate:deploy`).
- Chromium for Playwright, once per machine:
  `pnpm --filter @intrinsic/web exec playwright install chromium`

**Environment variables** — all in the git-ignored repository-root `.env`, all documented in
`.env.example`, none with a committed value:

| Variable                                   | Required | Meaning                                                                  |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `QA_FREE_EMAIL` / `QA_FREE_PASSWORD`       | yes      | `FREE_USER` credentials                                                  |
| `QA_STARTER_EMAIL` / `QA_STARTER_PASSWORD` | yes      | `STARTER_USER` credentials                                               |
| `QA_USER_EMAIL` / `QA_USER_PASSWORD`       | yes      | `PRO_USER` credentials                                                   |
| `QA_ADMIN_EMAIL` / `QA_ADMIN_PASSWORD`     | yes      | `ADMIN_USER` credentials                                                 |
| `DATABASE_URL`                             | yes      | Where the personas are seeded — the database `pnpm dev:api` serves       |
| `QA_PERSONA_DATABASE_URL`                  | no       | Overrides the target, for a second local QA database                     |
| `QA_PERSONA_ALLOW_REMOTE_HOST`             | no       | `true` allows a non-local database host. Nothing sets it                 |
| `QA_BASE_URL`                              | no       | The running web app the launcher opens (default `http://localhost:3000`) |

Passwords must be at least twelve characters, which is the product's own registration policy, so a
persona can always sign in through the real form. Use addresses on a domain you control that is
clearly not a customer's — the repository convention is `qa-<persona>@factorsage.test`.

## 4. Commands

```bash
pnpm qa:seed        # create/repair the four personas and assert their plans; creates no content
pnpm qa:reset       # preview, confirm, then empty them and re-assert their plans
pnpm qa:personas    # open all four in isolated, persistent, visible browsers
```

Options:

```bash
pnpm qa:reset --dry-run              # print what would be deleted and stop
pnpm qa:reset --yes                  # skip the confirmation (required in a non-interactive shell)

pnpm qa:personas -- --route=/lists   # every persona on the same route, for side-by-side comparison
pnpm qa:personas --route=/lists      # the same; the `--` is optional
pnpm qa:personas -- --base-url=http://localhost:4000

pnpm qa:persona free                 # one persona
pnpm qa:persona pro -- --route=/backtests/new
```

`pnpm qa:persona` and `pnpm qa:personas` are the same launcher; the first simply reads better with
a persona handle after it. Useful routes to compare tiers on: `/dashboard`, `/lists`, `/strategies`,
`/monitors`, `/backtests`, `/backtests/new`, `/billing`.

## 5. First-time use

```bash
pnpm infra:up
pnpm qa:seed

# three terminals (there is no single `pnpm dev`)
pnpm dev:web
pnpm dev:api
pnpm dev:worker      # needed for Backtests and Monitor scans

pnpm qa:personas
```

On the first launch each persona's browser profile is empty, so the launcher **signs it in through
the product's own `/login` form** with that persona's credentials from `.env` — the same form, the
same API call, the same HttpOnly cookie a customer gets. There is no test-only login route, no
injected cookie and no bypass, so this tooling cannot weaken production authentication: there is
nothing in the application for it to weaken. You will see `signing in (first launch of this
profile)…` once per persona. Personas sign in one at a time on purpose, because the API rate-limits
credential endpoints per client IP.

If the sign-in fails, the usual causes are: `pnpm qa:seed` has not been run against the database the
API is serving; the credentials in `.env` changed since the last seed (rerun `pnpm qa:seed`); or the
API is not up yet.

## 6. Subsequent use

```bash
pnpm qa:personas
```

Each persona has a real Chromium profile directory under `.qa/browser/<handle>`, so cookies,
`localStorage`, `sessionStorage`, IndexedDB and service workers live on disk under that persona and
nowhere else. Relaunching restores the session without a sign-in — there is no `signing in…` line
the second time.

Sessions last `AUTH_TOKEN_TTL_SECONDS` (eight hours by default); after that the launcher signs the
persona in again by itself.

Persona windows are tiled and each tab title carries its persona:

```text
[FREE] Lists · FactorSage
[STARTER] Lists · FactorSage
[PRO] Lists · FactorSage
[ADMIN] Lists · FactorSage
```

That badge is written into the page by the launcher, from outside the application. Nothing in
`apps/web/src` knows it exists, so there is no dev-only branch in the product UI and nothing that
could reach a real user.

**To clear browser state deliberately** — to test a first sign-in, or after changing a password:

```bash
rm -rf .qa/browser              # every persona
rm -rf .qa/browser/free         # one persona
```

The next launch recreates the profile and signs in again. `.qa/` is git-ignored; a signed-in profile
holds a live session cookie and must never be committed.

## 7. A release-testing pass

```bash
pnpm qa:reset      # start from four genuinely empty accounts
pnpm dev:web / pnpm dev:api / pnpm dev:worker
pnpm qa:personas
```

Then, per persona, and comparing the windows as you go:

1. **Lists** — create one, add symbols, edit membership, reach the plan's symbol limit, read the
   refusal and the upgrade path it offers.
2. **Strategies** — create, edit, rename, reload, delete; check the validation surface.
3. **Monitors** — create one over that list and strategy, enable it, reach the plan's active-monitor
   limit, inspect matches after a worker scan.
4. **Backtests** — submit from `/backtests/new`, watch progress, read the results; try a date range
   and a symbol count past the plan's limit.
5. **Billing** — `/billing` on each tier.
6. **Admin** — on `admin` only, edit a built-in and confirm the other three cannot.

`pnpm qa:personas -- --route=<path>` puts all four on the same screen at once, which is the fastest
way to see what a tier actually changes.

When you want to start over, `pnpm qa:reset` again.

## 8. Mobile

**Resize the window, or use DevTools responsive mode.** There is deliberately no second matrix of
mobile persona sessions: the launcher opens each window with no fixed viewport, so the page follows
whatever size you drag it to, and device emulation is one keystroke away in a browser that is
already signed in as the right persona. Duplicating four windows to get four more would double the
setup and prove nothing extra.

## 9. Safety

**Why this cannot touch production users**

- `NODE_ENV=production` is refused outright by both commands, before a credential is read or a
  connection is opened. One of these personas is a real administrator account whose password lives
  in a developer `.env`, so the refusal is unconditional rather than a prompt.
- The target database must be on **this machine** (`localhost`, `127.0.0.1`, `::1`,
  `host.docker.internal`, `postgres`). A remote host is refused by name, and only a deliberate
  `QA_PERSONA_ALLOW_REMOTE_HOST=true` lifts it. Nothing sets that.
- The target must be a PostgreSQL URL that names a database; anything else fails before a client
  exists.
- Credentials come only from the environment. No password, address or session is committed, and
  failures name the missing _variable_, never its value.
- The launcher drives a browser against a URL. It has no database credentials at all.

**What `pnpm qa:reset` deletes**

For **each of the four persona accounts, and only those**, located by the exact email in `.env`:

- Monitors (and with them their signal state, signals and transition history)
- Backtest runs (and their jobs, progress, milestones, trades, equity, positions and summaries)
- Strategies (and their versions)
- Stock Lists (and their memberships and buy windows)
- per-user visibility preferences for built-in Monitors
- recently-viewed securities

Every statement is scoped by `userId: { in: <the resolved persona ids> }`; there is no code path
that issues a delete without it, and if no persona resolves, nothing runs. `SYSTEM`-owned built-in
content has a null `userId`, so it is matched by none of them and survives untouched — which is
correct, because that is also what a real customer sees.

**What it does not delete or change**

- the persona `User` rows — they are kept, so their ids and therefore the browser sessions survive
- any other user's content, on any plan
- built-in Lists, Strategies and Monitors
- the `Security` catalog, market data, benchmarks or anything in Redis
- `BillingSubscription` — reported, never written (see section 2)

Before deleting anything it prints the per-persona counts and waits for a `y`. `PRO_USER` is also
the long-standing default local development account, so in a development database those numbers are
usually a developer's own manual work rather than leftovers from a previous QA pass. `--dry-run`
prints and stops; `--yes` skips the prompt and is required in a non-interactive shell.

## 10. Where the code is

| Piece                                                       | File                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| The persona registry (plans, roles, handles, profile paths) | `packages/testing/src/personas.ts`                                      |
| Which target database is allowed, and the refusals          | `apps/api/src/qa/qa-persona-environment.ts`                             |
| What a reset deletes, and its scoping                       | `apps/api/src/qa/qa-personas.ts`                                        |
| `pnpm qa:seed` / `pnpm qa:reset`                            | `apps/api/src/qa-personas-seed.ts`, `apps/api/src/qa-personas-reset.ts` |
| The browser launcher                                        | `apps/web/qa/personas.ts`, `apps/web/qa/launcher-options.ts`            |
| The shared account writer (also used by Playwright)         | `apps/api/src/auth/seed-qa-users.ts`                                    |

`ai/workflows/auth-testing.md` remains the operational source of truth for personas, the automated
suites and the hermetic E2E stack.
