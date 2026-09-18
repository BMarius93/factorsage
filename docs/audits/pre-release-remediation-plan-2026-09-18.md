# FactorSage V2 Pre-Release Remediation Plan

- **Source audit:** `docs/audits/pre-release-product-audit-2026-09-18.md`, referred to below as
  "the audit". Its finding IDs are B-1, H-1…H-10, C-1…C-5, U-1…U-8, S-1, S-2, O-1, O-2, T-1…T-4,
  P-1, P-2, M-1 and D-1.
- **Code baseline:** `main` @ `6b642eb4`. Every file and line reference below was re-read at that
  commit while writing this plan.
- **Status:** planning only. No production code has changed. Nothing in this document is
  implemented.

## How to use this document

- Every remediation item has a **stable ID**, such as `AUTH-001`. Use it in branch names, commit
  subjects and PR titles, and never reuse or renumber an ID. If an item is dropped, mark it
  _Withdrawn_ and keep it in the document.
- Each item traces back to one of three sources: an **audit finding**, a **repository file**, or
  an **existing product/architecture document**. When the source is uncertain, the item says so
  under _Uncertainty_.
- Items are grouped into **five independent PRs**, plus the decision-driven items of §8, which get
  their own PRs once specified. A PR contains only its own items. Anything the audit found that is
  not in a PR is listed in §10 with its disposition.
- **Product decisions** are recorded in §8 (2026-09-18). An item created by a decision is
  _specification pending_ until the plan carries its full item.

## 1. Corrections to the audit found while planning

Re-reading the code for this plan exposed four places where the audit's recommended fix is wrong
or incomplete. Each item below follows the corrected version.

1. **After AUTH-001 the account cannot recover a password through "Forgot password".** The
   audit's B-1 fix says the owner can set a password there. They cannot:
   - `apps/api/src/auth/password-recovery.service.ts:41` silently skips any account with
     `passwordHash === null`. That is deliberate: a Google-only account gets the indistinguishable
     neutral response.
   - So once AUTH-001 clears an attacker-set password, the account is **Google-only**, and that is
     the correct outcome.
   - Adding a "set a password for a Google-only account" flow would be new scope and is **not**
     part of PR 1.
2. **"Blank `FMP_API_KEY` in the e2e scripts" (audit H-10) would stop the stack from starting.**
   `getFmpConfig` calls `required(env, "FMP_API_KEY")` (`packages/config/src/index.ts:835-840`).
   E2E-001 specifies a different mechanism.
3. **`next build` always runs with `NODE_ENV=production`.** That includes CI's `pnpm build` and
   the local validation gate. So "fail the production build when `NEXT_PUBLIC_API_BASE_URL` is
   unset" (audit H-6) cannot key on `NODE_ENV` alone without breaking the gate. PROD-002 uses an
   explicit release-build signal instead.
4. **Session revocation does not have to sign everybody out at deploy.** The audit's H-7 predicted
   a one-time mass sign-out. SESSION-002 accepts a token without the new claim only while the
   user's counter is still at its initial value, so existing sessions survive the deploy and are
   still revocable afterwards.

The audit also cross-referenced `/stocks` to H-10 instead of U-5. That is corrected in the audit
document in the same commit as this plan.

## 2. Item index

| ID          | Title                                                                             | Severity | PR  | Release-blocking                          | Audit ref      |
| ----------- | --------------------------------------------------------------------------------- | -------- | --- | ----------------------------------------- | -------------- |
| AUTH-001    | Google linking must not adopt an unverified account's password                    | P0       | 1   | **Yes**                                   | B-1            |
| PROD-001    | API/worker production config: refuse missing or localhost URLs and missing SMTP   | P1       | 2   | **Yes**                                   | H-6            |
| PROD-002    | Release builds of the web app must carry an explicit, non-localhost API URL       | P1       | 2   | **Yes**                                   | H-6            |
| CI-001      | Frozen lockfile in CI and all Dockerfiles                                         | P1       | 2   | **Yes**                                   | H-9            |
| CI-002      | CI fails when `schema.prisma` and the migration history disagree                  | P1       | 2   | **Yes**                                   | H-9            |
| SEC-001     | Baseline security headers on web and API responses                                | P1       | 2   | **Yes**                                   | H-8            |
| SEC-002     | Logo proxy responses cannot execute or be framed, and are bounded                 | P1       | 2   | **Yes**                                   | H-8            |
| SESSION-001 | Document the session model and every revocation scenario                          | P1       | 3   | **Yes** (document)                        | H-7            |
| SESSION-002 | Revocable sessions via `User.sessionVersion`                                      | P1       | 3   | **Yes** (DEC-003: implement)              | H-7            |
| UX-001      | Plan-limit and rate-limit refusals read as such on every mutation                 | P1       | 4   | **Yes**                                   | H-1            |
| UX-002      | Guest "Backtest this …" actions open the in-context prompt                        | P1       | 4   | **Yes**                                   | H-2            |
| UX-003      | Safe return destination through sign-in                                           | P1       | 4   | **Yes**                                   | H-2            |
| UX-004      | Monitor detail shows effective scanning state, not only the configured switch     | P1       | 4   | **Yes**                                   | H-3            |
| UX-005      | A missing stock logo is a non-error response with graceful fallback               | P2       | 4   | No (E2E-006 needs it)                     | H-10 / §7 #2–5 |
| UX-006      | Styled not-found page and application error boundaries                            | P1       | 4   | **Yes**                                   | H-4            |
| UX-007      | Dashboard ticker is legible at 1280 px                                            | P1       | 4   | **Yes**                                   | H-5            |
| E2E-001     | The E2E stack never reaches FMP and never depends on the wall clock for freshness | P1       | 5   | **Yes** (release gate)                    | H-10           |
| E2E-002     | Re-seeding removes provider-written rows from fixture series                      | P1       | 5   | **Yes** (release gate)                    | H-10           |
| E2E-003     | Resume test waits for a real drawing predicate and cleans up its run              | P1       | 5   | **Yes** (release gate)                    | §7 #1          |
| E2E-004     | PRO concurrency spec: timeouts, waits and counting are internally consistent      | P1       | 5   | **Yes** (release gate)                    | §7 #6–7        |
| E2E-005     | ENTF fixture securities declare complete empty coverage                           | P1       | 5   | **Yes** (release gate)                    | §7 #6          |
| E2E-006     | Shared Playwright logo stub; one `watchForIssues` helper                          | P1       | 5   | **Yes** (release gate)                    | §7 #2–5        |
| E2E-007     | Document the deterministic fixture boundaries                                     | P2       | 5   | No                                        | H-10           |
| TEST-001    | Investigate the intermittent `GET /backtests/:id` 404 in the API suite            | P2       | 5   | No, unless it reproduces as a product bug | T-4            |
| AUTH-002    | Verifying an email must not activate a password the verifier did not set          | P1       | own | **Yes** (classified 2026-09-18, DEC-005)  | B-1 ¶2         |
| AUTH-003    | Registration does not reveal whether an account exists                            | P1       | TBD | **Yes** (DEC-004)                         | S-2            |
| PRICING-001 | Public `/pricing` page for guests                                                 | P1       | TBD | **Yes** (DEC-001)                         | §2, §5         |
| DEMO-001    | Guest-viewable precomputed/static demo backtests                                  | P1       | TBD | **Yes** (DEC-002)                         | §2             |

The last four rows were created by the product decisions in §8. Each is _specification pending_:
its PR number is assigned once the plan carries a full item for it.

"Release-blocking" means it must be merged, or its decision recorded, before public production.
§9 is the gate.

---

## 3. PR 1: Google account takeover

**Scope rule:** this PR changes the Google-linking path and its tests, nothing else. It includes
no auth refactor, no registration or verification changes, and no session work. The related
email-verification variant is the separately tracked AUTH-002 (DEC-005) and is deliberately
**not** in this PR.

### AUTH-001: Google linking must not adopt an unverified account's password

**Severity:** P0 (audit B-1). It is a blocker whenever `GOOGLE_*` is configured in production.

**Observed behaviour:**

- `GoogleAuthService` (`apps/api/src/auth/google/google-auth.service.ts:148-186`) adopts an
  existing row when Google is authoritative for its address: Gmail, or a Workspace `hd` that
  matches.
- The adoption goes through `UsersService.linkOAuthAccount`
  (`apps/api/src/auth/users.service.ts:97-122`), a batch `$transaction` that:
  - creates the `OAuthAccount`;
  - sets `emailVerifiedAt`;
  - deletes the `EmailVerificationToken`.
- It never touches `passwordHash`. When the row was created by someone else's
  `POST /auth/register` and never verified, that stranger's password becomes valid:
  - `auth.service.ts:63` refused it only because `emailVerifiedAt` was null.
- The existing test (`google-auth.integration.test.ts:582-610`) asserts only that the address
  becomes verified and that the token is gone.

**Required behaviour:**

- When Google adopts a row **whose `emailVerifiedAt` is null at the moment of linking**, the same
  transaction must also:
  - set `passwordHash` to `null`;
  - delete any `PasswordResetToken` for that user.
- The result is a verified, Google-only account.
- Adopting an **already-verified** local account must stay exactly as it is today: the password
  is kept. The owner proved control of both the mailbox and the password.
- New-account creation and returning-subject sign-in are unchanged.

**Why it matters:**

- An attacker pre-registers `victim@gmail.com`. The victim later uses "Continue with Google". The
  attacker's password now opens the victim's account, including billing and the Stripe Customer
  Portal.
- It is a documented class of pre-account-takeover.

**Likely affected files:**

- `apps/api/src/auth/users.service.ts` (`linkOAuthAccount`).
- Possibly `google-auth.service.ts`, only if the verified/unverified distinction has to be passed
  in rather than decided inside the transaction.
- `apps/api/src/auth/google-auth.integration.test.ts`.
- `ai/architecture/authentication.md`: the account-linking section should state the rule.

**Implementation constraints:**

- **Decide "unverified" inside the writing transaction, not from the earlier `findByEmail` read.**
  An email-verification redemption can race the Google callback. Two acceptable shapes:
  - an interactive transaction that re-reads the row `FOR UPDATE`;
  - a conditional statement placed **before** the verification update in the same batch:
    `updateMany({ where: { id, emailVerifiedAt: null }, data: { passwordHash: null } })`.
- Do not change `google-email-authority.ts`, the OIDC provider, or the transaction cookie.
- Do not add a set-password flow for Google-only accounts. Correction 1 in §1 explains why the
  outcome is acceptable.
- No schema change and no migration.
- Existing sessions do not need revoking:
  - the attacker could never have held one, because login refuses unverified accounts at
    `auth.service.ts:63`;
  - registration issues no session.
  - This dependency-free property should be stated in the PR description.

**Automated tests required**, in `google-auth.integration.test.ts` (real DB, faked identity port
only, as in the existing suite):

1. **The full attack scenario, end to end through HTTP:**
   1. `POST /auth/register` with a Gmail-domain address and password `P`. Expect 202, and the row
      is unverified.
   2. `POST /auth/login` with `P`. Expect 403 `EMAIL_NOT_VERIFIED`, which is the pre-condition.
   3. Complete the Google flow for that address. Expect a 302 to the post-login path and a session
      cookie.
   4. `POST /auth/login` with `P`. Expect **401** with the generic invalid-credentials body, the
      same shape as an unknown account.
   5. The row now has `passwordHash = null`, `emailVerifiedAt` set, one `OAuthAccount`, and no
      `EmailVerificationToken` or `PasswordResetToken`.
2. **The same scenario with an outstanding `PasswordResetToken`** on the unverified row: the token
   is deleted.
3. **Regression, verified local account:** a verified row with a password, adopted by Google,
   still logs in with its password.
4. **Regression, Workspace `hd` match:** the unverified-account rule applies identically.
5. **Refusal path unchanged:** a non-authoritative email (the `oauth_link_not_allowed` case) leaves
   `passwordHash` untouched.
6. **Race, deterministic.** Assert that a verification redemption committed _before_ the link
   leaves the password intact:
   - redeem the verification token first, then run the Google link;
   - the password must still be valid, because the row was verified when the link happened.

**Manual verification:**

- On the dev stack, with Google configured:
  1. Register a throwaway Gmail address you control, and do not verify it.
  2. Sign in with Google as that address.
  3. Confirm that password login now fails with the generic message.
- Confirm that a Google sign-in to an already-verified account keeps its password.

**Release-blocking:** yes, unconditionally. DEC-006 records that Google sign-in is enabled for
launch.

**Dependencies:** none.

---

## 4. PR 2: Production configuration and CI hardening

**Scope rule:** configuration validation, build-time guarantees, CI steps and response headers.

This PR contains no auth behaviour changes and no Docker multi-stage rework. Image hardening is O-1
in §8.

`SEC-002` and `UX-005` (PR 4) both edit `apps/web/src/app/api/logo/[symbol]/route.ts`. Merge PR 2
first, or rebase whichever lands second.

### PROD-001: API/worker production config refuses missing or localhost URLs and missing SMTP

**Severity:** P1 (audit H-6).

**Observed behaviour** (`packages/config/src/index.ts`):

- `WEB_BASE_URL` defaults to `http://localhost:3000` (`:241-243`). It builds verification and
  reset links, the Google redirect, and Stripe success/cancel/portal URLs.
- `CORS_ORIGINS` defaults to `["http://localhost:3000"]` (`:136-138`).
- SMTP is optional (`getSmtpConfig`, `:329-351`). With it absent,
  `apps/api/src/email/email.module.ts:15-16` binds `UnconfiguredEmailSender`, and registration
  creates the user and then answers 503 (`registration.service.ts:118`).
- None of this is refused when `NODE_ENV=production`, although the same file already refuses
  other unsafe production configurations:
  - Stripe mode mismatch (`:507-517`);
  - the debug archive (`:719-721`).

**Required behaviour.** When `NODE_ENV=production`, API and worker startup fails with the file's
existing `Invalid application configuration: …` message form if:

- `WEB_BASE_URL` is unset, is not `https:`, or has a loopback/`localhost` host;
- `CORS_ORIGINS` is unset or contains a loopback/`localhost` origin;
- the SMTP group is absent. `SMTP_HOST` and `SMTP_FROM` are required, and the credential pair
  keeps its existing all-or-nothing rule.

Development and test behaviour are unchanged.

**Why it matters:** a production stack missing one variable boots "healthy" and then cannot
verify users, send reset links or return from Checkout. The failure is silent and customer-facing.

**Likely affected files:**

- `packages/config/src/index.ts` and `packages/config/src/index.test.ts`.
- `.env.example`, to document that these are required in production.
- `docs/local-development.md` (if it lists production variables).
- `ai/architecture/observability.md` or the config doc section that lists refusals (check which
  owns it).

**Implementation constraints:**

- Keep it inside `packages/config`. Business code must not read `process.env` (AGENTS invariants
  and dependency rules).
- Do not change the development defaults.
- Do not make SMTP required for `test`. Integration suites construct senders explicitly.
- **Verified during planning:** `apps/worker/src` calls none of `getWebBaseUrl`, `getSmtpConfig`,
  `getAuthConfig` or `getApiConfig`. The production requirements therefore bind the **API
  process only**. Enforce them in the getters the API calls, and do not force SMTP or web URLs
  onto the worker.

**Automated tests required** (`packages/config/src/index.test.ts`):

- **Production refuses:**
  - missing `WEB_BASE_URL`;
  - `http://` `WEB_BASE_URL`;
  - `localhost`, `127.0.0.1` and `[::1]` hosts;
  - missing `CORS_ORIGINS`;
  - a localhost CORS origin;
  - an absent SMTP group.
- **Production accepts** a complete https configuration.
- **Development and test** accept today's defaults, unchanged.
- **Secret exposure:** error messages name variables, never values. The existing
  secret-exposure tests in that file cover the pattern.

**Manual verification:**

- `NODE_ENV=production` with the dev `.env` fails fast at API start with a readable message.
- With the variables set to https values, it starts.

**Release-blocking:** yes.

**Dependencies:** none.

### PROD-002: Release builds of the web app carry an explicit, non-localhost API URL

**Severity:** P1 (audit H-6).

**Observed behaviour:**

- `apps/web/src/lib/api/client.ts:8-9`:
  `API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"`.
- `NEXT_PUBLIC_*` values are inlined at `next build`.
- `docker/web.Dockerfile` runs `pnpm --filter @intrinsic/web build` with no `ARG`/`ENV` for the
  variable, and `.dockerignore` excludes `.env`.
- `docker-compose.yml:44` sets it only under `environment:` (runtime), which cannot affect the
  compiled client.
- `apps/web/next.config.ts` has no validation.
- `packages/config`'s `getWebPublicConfig` (`:890-895`) duplicates the same fallback but is not
  used by the web app. The web app may not import `@intrinsic/config`
  (`AGENTS.md` dependency rules: `web -> contracts` only).

**Required behaviour:**

- A **release build** of the web app fails when `NEXT_PUBLIC_API_BASE_URL` is unset, empty, not
  `https:`, or loopback.
- A normal `pnpm build` (the validation gate, CI) and `next dev` keep working exactly as today.
- `docker/web.Dockerfile` accepts the value as a build argument and **is** a release build.
- `docker-compose.yml` passes it under `build.args`.

**Why it matters:** an image built today sends every visitor's API calls to their own machine. The
whole app is broken, and nothing warns at build time.

**Likely affected files:**

- `apps/web/next.config.ts`, which gets the validation.
- `docker/web.Dockerfile`: add `ARG NEXT_PUBLIC_API_BASE_URL`, `ENV …`, and the release-build flag
  before the build step.
- `docker-compose.yml` (`build.args`).
- `.env.example`, documenting that the value is build-time.
- Optionally `apps/web/src/lib/api/client.ts`, to treat an empty string like unset. Today `??`
  lets `""` through.

**Implementation constraints:**

- **Do not key the check on `NODE_ENV === "production"`.** Correction 3 in §1 explains why.
- Key it on an explicit variable set only by release builds. Proposed name
  `FACTORSAGE_RELEASE_BUILD=true`, set by the Dockerfile. The name is to be confirmed in the PR.
- Use Next's `phase` argument (`PHASE_PRODUCTION_BUILD`) so `next start` of an already-built
  bundle is not re-validated.
- Do not add `@intrinsic/config` to the web app.
- Remove or keep `getWebPublicConfig` consistently. It is dead code today, so remove it only if a
  repository search confirms it has no caller. It is out of scope otherwise.

**Automated tests required:**

- A unit test of the extracted validation function (`apps/web/src/lib/…`, a pure function taking
  `(env, phase)`) covering:
  - unset, empty, `http://`, `localhost` and `127.0.0.1`: refused in a release build;
  - valid `https`: accepted;
  - no release flag: accepted, including unset.
- The gate's own `pnpm build` must continue to pass without the variable. That proves the
  non-release path.

**Manual verification:**

- `docker build -f docker/web.Dockerfile .` **fails** with a clear message.
- `docker build -f docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.test .`
  **succeeds**.
- Then run
  `docker run --rm <image> sh -c 'grep -rl "localhost:3001" apps/web/.next/static || echo clean'`,
  which should print `clean`.

**Release-blocking:** yes, if the release artifact is built from `docker/web.Dockerfile`.

If you deploy the web app another way (for example Vercel), the platform's build must set the
variable, and the same `next.config.ts` check protects it once the platform sets the release flag.
**Uncertainty:** the deploy platform is not chosen (audit §8).

**Dependencies:** none.

### CI-001: Frozen lockfile in CI and all Dockerfiles

**Severity:** P1 (audit H-9).

**Observed behaviour:**

- `.github/workflows/ci.yml` runs `pnpm install --no-frozen-lockfile`.
- So do `docker/api.Dockerfile:7`, `docker/worker.Dockerfile:7` and `docker/web.Dockerfile:7`.
- The flag dates from the initial commit (`7219a903`); no later commit explains it.

**Required behaviour:** every install that produces something tested or shipped uses
`--frozen-lockfile` and fails when `pnpm-lock.yaml` is out of step with the manifests.

**Why it matters:** dependency versions can change between the reviewed commit and the shipped
image without any diff.

**Likely affected files:** the four files above.

**Implementation constraints:**

- **Verified during planning:** `pnpm install --frozen-lockfile --lockfile-only` succeeds on this
  lockfile with the local pnpm (11.22.0) and leaves the tree unchanged.
- **Uncertainty:**
  - CI pins `pnpm/action-setup` `version: 10`, and the repo has no `packageManager` field.
  - The PR's own CI run is what proves frozen installs work under pnpm 10.
  - If it fails on a lockfile-format difference, pin the pnpm version (add `packageManager`) in
    this PR rather than reverting to `--no-frozen-lockfile`.

**Automated tests required:** none beyond CI itself. The CI install step is the test.

**Manual verification:**

- Deliberately edit a `package.json` version range on a scratch branch and confirm CI's install
  step fails.
- Do not merge that scratch branch.

**Release-blocking:** yes.

**Dependencies:** none.

### CI-002: CI fails when `schema.prisma` and the migration history disagree

**Severity:** P1 (audit H-9).

**Observed behaviour:**

- CI runs `pnpm db:validate` (syntax only) and `pnpm db:migrate:deploy`, which applies
  migrations.
- Neither detects a `schema.prisma` edit that has no migration.

**Required behaviour:**

- A CI step runs `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code`
  against a **throwaway shadow database**.
- The job fails when the diff is non-empty.

**Why it matters:** a schema change without its migration passes CI today and would then fail, or
drift, at `migrate deploy` in production.

**Likely affected files:**

- `.github/workflows/ci.yml`.
- Possibly a small script next to `packages/database/scripts/prisma-command.mjs`, if the existing
  wrapper is how Prisma commands are run.
- `ai/workflows/validation.md`, to document the step.

**Implementation constraints:**

- Use a **separate** database on the existing CI Postgres service as the shadow, created and
  dropped by the step. Never point it at `DATABASE_URL`.
- The local recipe already exists in the project's migration notes:
  `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url … --script`.
- Use `--exit-code` rather than `--script` in CI.
- **Uncertainty:** confirm the installed Prisma CLI version supports
  `--from-migrations`/`--to-schema-datamodel` with `--exit-code`. The audit's reviewer reported
  Prisma 6.19, where both exist.

**Automated tests required:** the CI step itself.

**Manual verification:**

- On a scratch branch, add a nullable column to `schema.prisma` without a migration.
- CI must fail at this step.
- Revert the change.

**Release-blocking:** yes.

**Dependencies:** none.

### SEC-001: Baseline security headers on web and API responses

**Severity:** P1 (audit H-8).

**Observed behaviour:**

- `apps/web/next.config.ts` has only `reactStrictMode`. There is no `headers()`.
- `apps/api/src/main.ts:29-50` configures CORS and `rawBody` and sets no security headers.
- Express still sends `X-Powered-By`.
- `helmet` is not a dependency.

**Required behaviour.**

- **Web**, on every route:
  - `Content-Security-Policy: frame-ancestors 'none'`, the framing directive only. A full CSP is
    deliberately deferred; see §8.
  - `X-Frame-Options: DENY`, for older browsers.
  - `X-Content-Type-Options: nosniff`.
  - `Referrer-Policy: strict-origin-when-cross-origin`.
  - `Strict-Transport-Security`, **only when served over HTTPS in production**.
- **API**:
  - `X-Content-Type-Options: nosniff`;
  - `X-Frame-Options: DENY` (or `frame-ancestors 'none'`);
  - no `X-Powered-By`.

**Why it matters:**

- Billing and destructive confirmations can be framed (clickjacking).
- These are the minimum expected headers for a public product handling payments.

**Likely affected files:**

- `apps/web/next.config.ts`.
- `apps/api/src/main.ts`, or a small middleware file alongside `installHttpObservability`.

**Implementation constraints:**

- **Prefer no new dependency.** Four headers and `disable("x-powered-by")` do not justify
  `helmet` (`AGENTS.md`: "Add dependencies only when there is a concrete use"). If `helmet` is
  chosen anyway, record why in the PR.
- **Do not add a full `script-src`/`style-src` CSP in this PR.** It needs testing against Next.js
  and Lightweight Charts (audit H-8).
- Do not touch CORS or cookie settings.
- HSTS must not be emitted on `http://localhost`. Tie it to the production build or runtime.

**Automated tests required:**

- **API:** one Nest test asserting the headers on a representative route (for example `/health`),
  and the absence of `X-Powered-By`.
- **Web:** a unit test of the exported `headers()` result from `next.config.ts`, or a Playwright
  assertion in E2E on `/dashboard` response headers. Either is acceptable. The Playwright form
  also proves Next serves them.

**Manual verification:**

- `curl -sI http://localhost:3000/dashboard` and `curl -sI http://localhost:3001/health` show the
  headers.
- The app still works in a browser, including charts, Stripe redirects and the Google redirect.
  `frame-ancestors` does not affect outbound navigation.

**Release-blocking:** yes.

**Dependencies:** none.

### SEC-002: Logo proxy responses cannot execute or be framed, and are bounded

**Severity:** P1 (audit H-8).

**Observed behaviour:** `apps/web/src/app/api/logo/[symbol]/route.ts:91-100` passes any
`image/*` content type through on the FactorSage origin, **SVG included**, with:

- no CSP;
- no `nosniff`;
- an unbounded `arrayBuffer()`;
- default redirect-following `fetch`.

The host is fixed and the symbol is regex-validated, so there is no SSRF (verified by the
frontend reviewer and by `route.test.ts`).

**Required behaviour.** Upstream-served logo responses carry:

- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`;
- `X-Content-Type-Options: nosniff`.

The upstream fetch must:

- use `redirect: "error"`;
- abort on bodies above a fixed cap (about 512 KB).

A cap or redirect failure is treated like any other upstream failure: the existing `502 no-store`
path.

**Why it matters:**

- A hostile SVG from the provider CDN, opened directly at `/api/logo/X`, would run script on the
  origin that holds the session. That origin makes credentialed API calls.
- The likelihood is low; the fix is small.

**Likely affected files:** `apps/web/src/app/api/logo/[symbol]/route.ts` and
`apps/web/src/app/api/logo/[symbol]/route.test.ts`.

**Implementation constraints:**

- Keep the cache policies, including `CACHE_CONTROL` and `MISSING_CACHE_CONTROL` at `:31` and
  `:41`, and the 502 `no-store`.
- Do not change the missing-logo response here. That is UX-005 in PR 4.

**Automated tests required** (`route.test.ts`):

- The success response carries both headers.
- An upstream 3xx is not followed and returns 502 `no-store`.
- An oversized body returns 502 without buffering it entirely.
- The existing SVG pass-through test still passes, now with the sandbox CSP asserted.

**Manual verification:** open `http://localhost:3000/api/logo/AAPL` directly and inspect the
response headers.

**Release-blocking:** yes.

**Dependencies:** none. It conflicts textually with UX-005; see the scope rule above.

---

## 5. PR 3: Session revocation

**Scope rule:** this PR contains SESSION-001 (documentation, first commit) and then SESSION-002
(implementation). DEC-003 (§8) records the decision to implement. The alternative of accepting the
eight-hour exposure is **not** selected.

### SESSION-001: Document the session model and every revocation scenario

**Severity:** P1. It is the first part of H-7.

**Current session model, verified at `6b642eb4`:**

- **Token.** An HS256 JWT signed by `JwtService` with `AUTH_JWT_SECRET` (at least 32 characters,
  algorithm pinned on verify).
  - Payload `{ sub: userId }` only (`auth.service.ts:87-89`).
  - Expiry `AUTH_TOKEN_TTL_SECONDS`, default **8 h** (`packages/config/src/index.ts:257`).
- **Transport.** An HttpOnly cookie named `AUTH_COOKIE_NAME` with:
  - `SameSite` = `cookieSameSite`;
  - `Secure` only when `NODE_ENV=production`;
  - path `/`;
  - `maxAge` = TTL (`auth-cookie.ts:15-19`).
- **Issuers:** exactly two.
  - Password login (`auth.service.ts:81`).
  - Google callback (`auth.controller.ts:250`).
- **Verification.** `CookieAuthGuard` (`cookie-auth.guard.ts:38`) and `OptionalCookieAuthGuard`
  (`optional-cookie-auth.guard.ts:50`) call `authenticateToken` (`auth.service.ts:91-112`). It
  does:
  1. signature and expiry check;
  2. `sub` extraction;
  3. **a per-request reload** of the user (`users.findAuthUserById`, `users.service.ts:55-60`).
  - Role and plan therefore take effect on the next request without re-login.
- **Logout.** `POST /auth/logout` (`auth.controller.ts:159-165`) clears the cookie **in the calling
  browser only**. The token itself stays valid until expiry.

**Revocation scenarios and today's behaviour:**

| #   | Scenario                                         | Exists today?                             | Does any other copy of the token stop working?                                                          |
| --- | ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| R1  | User signs out in this browser                   | Yes                                       | No. A copied or stolen token works until expiry (≤ 8 h).                                                |
| R2  | User wants to sign out every device              | **No action exists**                      | n/a                                                                                                     |
| R3  | User resets password via email link              | Yes (`password-reset.service.ts:155-166`) | **No.** An attacker's captured cookie survives the reset.                                               |
| R4  | Password change while signed in                  | **No endpoint exists**                    | n/a                                                                                                     |
| R5  | Role demoted (ADMIN → USER)                      | Only by direct DB edit or seed            | Effectively yes: the role is reloaded per request.                                                      |
| R6  | Plan change (Stripe)                             | Yes                                       | Not a revocation. The plan is reloaded per request by design.                                           |
| R7  | User row deleted                                 | No user-facing deletion exists            | Yes: the reload finds no row → 401.                                                                     |
| R8  | Google account unlinked / OAuth identity removed | **No such action exists**                 | n/a                                                                                                     |
| R9  | Administrator suspends an account                | **No such feature exists**                | n/a                                                                                                     |
| R10 | AUTH-001 clears an attacker-set password         | After PR 1                                | Not needed: the attacker never had a session (login refuses unverified accounts, `auth.service.ts:63`). |
| R11 | `AUTH_JWT_SECRET` rotated                        | Operational                               | Yes, for **all** users. It is the only global kill switch today.                                        |

**Deliverable:**

- Put this table and the model description into `ai/architecture/authentication.md`, replacing
  the prose under "Must do before public production" item 1.
- Correct item 2 there. It says rate limiting does not exist; it does
  (`apps/api/src/rate-limit`, audit D-1).
- This is documentation only.

**Tests:** none.

**Manual verification:** review against the code references above.

**Release-blocking:** yes (the documentation). It is small, and it is the reference SESSION-002 implements against.

**Dependencies:** none.

### SESSION-002: Revocable sessions via `User.sessionVersion`

**Severity:** P1 (audit H-7). `ai/architecture/authentication.md:363-370` lists it as "Must do
before public production" item 1.

**Observed behaviour:** see R1 and R3 above. A captured cookie keeps working for up to 8 h after
the victim resets the password or signs out.

**Required behaviour (the smallest correct implementation, as the auth doc proposes):**

1. **Schema.** `User.sessionVersion Int @default(0)`, with an explicit migration and a migration
   note (`AGENTS.md` database rules).
2. **Issue.** Both issuers put `sv: <current sessionVersion>` into the JWT. The value must come
   from the **same row read that authorised the sign-in**:
   - `findForPasswordLogin`;
   - the Google-resolved user.
   - A separate later read could skip a concurrent bump.
3. **Verify.** `authenticateToken` compares `payload.sv` with the reloaded row's
   `sessionVersion`, which is added to the existing select at no extra query. On a mismatch it
   returns 401, exactly like an expired token.
4. **Backward compatibility, no mass sign-out.** A token **without** `sv` is accepted only while
   the row's `sessionVersion === 0`.
   - Existing sessions survive the deploy.
   - The first bump revokes them, because `0 ≠ 1`.
   - After one TTL (8 h) no claimless tokens remain valid, and this branch can be removed in a
     follow-up.
5. **Bump on password reset.** Increment inside the existing reset transaction
   (`password-reset.service.ts:155-166`).
6. **"Sign out everywhere".** A new authenticated `POST /auth/logout-all`:
   - increments `sessionVersion`;
   - clears the caller's cookie;
   - answers 204.
   - A minimal entry in `AccountMenu`.

**Why it matters:**

- Password reset is the user's only recovery action after a compromise, and today it does not
  evict the attacker.
- The project's own auth document classifies this as a pre-production requirement.

**Likely affected files:**

- `packages/database/prisma/schema.prisma` and a new migration.
- `apps/api/src/auth/auth.service.ts`, `users.service.ts` (selects),
  `password-reset.service.ts`, `auth.controller.ts`.
- The rate-limit policy catalog `apps/api/src/rate-limit/rate-limit-policies.ts`.
- `docs/openapi.yaml`.
- `apps/web/src/features/auth/components/AccountMenu.tsx`.
- `ai/architecture/authentication.md`.

**Implementation constraints:**

- **`sessionVersion` must not appear in `/auth/me` or any contract response.** `/auth/me` returns
  only `id`, `email` and `role` (`ai/workflows/auth-testing.md` §6). Keep it out of
  `SAFE_USER_SELECT` if that select feeds responses, and use an auth-only select instead.
- **The new route must follow the API invariants:**
  - `@RateLimit(…)` with a policy from the catalog (`rate-limit-coverage.test.ts` fails
    otherwise);
  - documented in `docs/openapi.yaml` with its 401 and 429 (`openapi.contract.test.ts`);
  - `pnpm openapi:validate` passes.
- **Generate the migration without resetting the dev database.** The dev DB has known drift. Use
  `prisma migrate diff` against a throwaway shadow DB, then apply with `migrate deploy` (project
  migration notes). Never accept `migrate reset`.
- **No session table, no Redis, no refresh tokens.** Redis must not hold user state (AGENTS
  invariant 16).
- **Do not change the TTL** in this PR.

**Automated tests required** (`apps/api/src/auth/auth.integration.test.ts` and
`password-reset.integration.test.ts`):

1. **Password reset revokes every session.** Two cookies (two logins) are valid. Redeem a reset.
   Both now get 401 on `/auth/me`. A fresh login works.
2. **`POST /auth/logout-all`:**
   - the caller's cookie and a second session's cookie both get 401 afterwards;
   - the endpoint without a cookie returns 401;
   - it is rate-limited per the chosen policy.
3. **Plain logout does not revoke other sessions.** This documents that R1 is unchanged by design.
4. **Claimless compatibility:**
   - a token minted without `sv` is accepted at `sessionVersion 0`;
   - it is rejected after one bump.
5. **Google-issued tokens** carry `sv` and are revoked by a bump.
6. **`/auth/me` response shape is unchanged.** Snapshot the keys.
7. **Web:** the `AccountMenu` test covers the new action's call and its redirect to `/login`.

**Manual verification:**

1. Sign in on two browsers (or a normal and a private window).
2. Reset the password from one browser. The other is signed out on its next request.
3. Repeat with "Sign out everywhere".
4. Confirm that a session opened **before** the deploy keeps working after it.

**Release-blocking:** yes. DEC-003 decided to implement; no alternative is accepted.

**Dependencies:**

- SESSION-001 first (same PR).
- Independent of PR 1. Correction 1 in §1 and scenario R10 explain why.

---

## 6. PR 4: User-facing correctness

**Scope rule:** minimal changes that make existing surfaces tell the truth.

- No Dashboard redesign.
- No new shared component library.
- No React Query.
- Each item stays inside the files it names.

### UX-001: Plan-limit and rate-limit refusals read as such on every mutation

**Severity:** P1 (audit H-1).

**Observed behaviour:**

- Reproduced as FREE: creating an 11-stock list gets
  `403 ENTITLEMENT_LIST_SYMBOL_LIMIT`, and the dialog says "The list could not be saved right now.
  Try again in a moment."
  (`EV/v2-qa-stack/free-list-create-overlimit-1280.png`).
- The canonical translator `requestFailureMessage(error, fallback)`
  (`apps/web/src/lib/api/entitlement-errors.ts`) handles:
  - 429, via `rateLimitMessage`;
  - entitlement reason codes;
  - 400.
- It is used by `MonitorsPage`, `MonitorFormDialog`, `NewBacktestForm` and `ListDetail`.
- These sites use their own translators, which pass only 400 (or 409) through:

| Site                          | Location                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| `ListFormDialog`              | `apps/web/src/features/lists/components/ListFormDialog.tsx:32-37` |
| `MonitorDetail` enable toggle | `…/monitors/components/MonitorDetail.tsx:173-175` and `:463-466`  |
| `ConfirmDialog`, every delete | `apps/web/src/components/ui/ConfirmDialog.tsx:26-31`              |
| `StrategyRenameDialog`        | `StrategyRenameDialog.tsx:23-28`                                  |
| `MembershipEditor`            | `MembershipEditor.tsx:98-104`                                     |
| `StrategyBuilder` save        | `StrategyBuilder.tsx:132-142`                                     |

**Required behaviour:**

- Every listed site shows the API's entitlement message for an entitlement reason code, and the
  shared rate-limit message for 429.
- The site's own fallback copy remains for genuinely unexpected failures.
- `ConfirmDialog` keeps passing a 409 message through, because deleting a referenced
  Strategy/List is refused with 409 by design.
- The same action gives the same message on the collection and on the detail page. Today enabling
  a monitor over its cap does not.

**Why it matters:** the most common commercial boundary reads as an outage, and a 429 invites the
exact retry the limiter refuses.

**Likely affected files:** the six components above and their `*.test.tsx`.

**Implementation constraints:**

- Reuse `requestFailureMessage`. Do not add a third translator.
- Handle 409 at the `ConfirmDialog` call site, before delegating.
- **A "View plans" link to `/billing` is optional and not required by this item.** If added, it
  must come from one place (the helper's caller), not six.
- Do not change API error codes or messages.

**Automated tests required.** One component test per site with a mocked `ApiError(403, …,
code: <entitlement code>)`, asserting that the API message renders:

- `ListFormDialog` with `ENTITLEMENT_LIST_SYMBOL_LIMIT`;
- `MonitorDetail` enable with `ENTITLEMENT_MONITOR_LIMIT`;
- `StrategyBuilder`, `StrategyRenameDialog`, `MembershipEditor` and `ConfirmDialog` with any
  entitlement code.

Plus one 429 case per shared path, asserting the rate-limit copy, and `ConfirmDialog` 409
unchanged.

**Manual verification:** as FREE on the QA stack:

1. Create an 11-stock list and see the plan message.
2. As DOWNGRADED, enable a blocked monitor from its **detail** page and see the same message as
   on the collection.

**Release-blocking:** yes.

**Dependencies:** none.

### UX-002: Guest "Backtest this …" actions open the in-context prompt

**Severity:** P1 (audit H-2, part 1).

**Observed behaviour:**

- `StrategyReadOnlyView.tsx:44-49` and `MonitorDetail.tsx:385-390` render
  `<Link href="/backtests/new?…">` for every non-editor, guests included.
- `/backtests/new` is not guest-readable (`features/auth/utils/guest-routes.ts`), so `RequireAuth`
  (`RequireAuth.tsx:26-30`) replaces the route with `/login`.
- Reproduced (`EV/v2-qa-stack/guest-backtest-this-strategy-result-1280.png`).
- The Dashboard card does this correctly:
  `DashboardOverview.tsx:29-31,163`, `gate.attempt(SIGN_IN_TO_BACKTEST, …)`.

**Required behaviour:**

- For a **guest**, both actions are buttons that open `SignInPrompt` with backtest copy. There is
  no navigation.
- For a signed-in viewer they stay links with the same prefill query as today.
- This is the rule in `guest-routes.ts:1-12`: "a Guest is never bounced to `/login` for
  navigating".

**Why it matters:** built-in content is how guests discover the product. Its main call to action
currently breaks the agreed guest behaviour.

**Likely affected files:**

- `StrategyReadOnlyView.tsx`, `MonitorDetail.tsx`.
- The prompt copy constant: reuse `SIGN_IN_TO_BACKTEST` by moving it out of
  `DashboardOverview.tsx` into a shared location such as `features/auth/utils`, rather than
  copying it.
- Their tests.

**Implementation constraints:**

- Use the existing `useSignInPrompt`/`gate.attempt` pattern.
- Respect `gate.resolved`, so no prompt opens while the session is still loading. That is audit
  U-6, but it applies here for free.
- Do not add `/backtests/new` to the guest routes.

**Automated tests required:**

- Component tests for both views:
  - guest: a button, clicking it opens a dialog, and the router is not called;
  - signed-in: a link with `strategyId=` / `strategyId=&stockListId=` preserved.
- E2E (`e2e/builtins/*.guest.spec.ts`): a guest on a built-in strategy clicks
  "Backtest this strategy", sees the prompt, and the URL is unchanged.

**Manual verification:**

- As a guest, click both actions: a prompt opens and there is no redirect.
- As PRO, both navigate to a prefilled New Backtest form.

**Release-blocking:** yes.

**Dependencies:** none. UX-003 builds on the prompt it opens.

### UX-003: Safe return destination through sign-in

**Severity:** P1 (audit H-2, part 2).

**Observed behaviour:**

- `SIGN_IN_TO_BACKTEST` promises "you will come straight back here" (`DashboardOverview.tsx:31`).
- But the prompt links bare `/login` and `/register` (`SignInPrompt.tsx:23-28`).
- `signInHref()` returns `"/login"`, and its docstring claims otherwise
  (`guest-routes.ts:28-31`).
- `LoginForm` always goes to `/dashboard` (`LoginForm.tsx:13,36`).
- The Google callback always redirects to `${webBaseUrl}${POST_LOGIN_PATH}`
  (`auth.controller.ts`, callback ~`:253`).
- `RequireAuth` drops the attempted URL (`RequireAuth.tsx:28`).

**Required behaviour:**

1. **One validator, `safeReturnPath(value)`.** It accepts only an **app-relative path**:
   - starts with a single `/`;
   - not `//` or `/\`;
   - no scheme, no backslashes, no control characters;
   - bounded length;
   - optionally restricted to known app route prefixes.
   - Anything else resolves to `/dashboard`.
   - The validator exists **on both sides**: web for the client redirect, API for the Google
     redirect. Neither trusts the other.
2. **Carrying the destination:**
   - `signInHref(next)` and the prompt's two links carry `?next=<current path + query>`.
   - `RequireAuth` appends `?next=` when it bounces a guest from a protected URL. This preserves,
     for example, `/backtests/new?strategyId=…`.
3. **Password login.** `LoginPanel` (which already reads `useSearchParams`) passes the validated
   `next` to `LoginForm`, which replaces the route with it on success.
4. **Google.**
   - `GET /auth/google?next=…` validates `next` server-side and stores it in the existing OAuth
     transaction cookie.
   - The callback redirects to `${webBaseUrl}${next}`, or to `POST_LOGIN_PATH` when it is absent
     or invalid.
   - `GoogleSignInButton` forwards `next`.
5. **Registration.**
   - The register page keeps `next` on its "Sign in" links, so a same-tab sign-in after
     verification returns correctly.
   - **Carrying `next` through the verification email is not required.** It would change the email
     link format; see _Uncertainty_.
6. **Prompt copy.** If any part of 2–4 is deferred, the copy "you will come straight back here"
   must be changed in this PR so it promises nothing that isn't implemented.

**Why it matters:**

- Every guest who signs in from a prompt currently lands on the Dashboard and loses their context,
  including the backtest prefill.
- The product text promises otherwise.

**Likely affected files:**

- Web:
  - `apps/web/src/features/auth/utils/guest-routes.ts` (with the new validator, or a sibling
    `return-path.ts`);
  - `SignInPrompt.tsx`, `RequireAuth.tsx`, `LoginForm.tsx`, `app/login/LoginPanel.tsx`,
    `RegisterForm.tsx`, `GoogleSignInButton.tsx`.
- API:
  - `apps/api/src/auth/auth.controller.ts` (Google start and callback);
  - `apps/api/src/auth/google/oauth-transaction.ts`.
- `docs/openapi.yaml`, for the new `next` query parameter on `GET /auth/google`.

**Implementation constraints:**

- **An open redirect is the main risk.** The validator must be a pure function with exhaustive
  tests, and the API must never redirect to anything but `webBaseUrl` + a validated path.
- The OAuth transaction cookie is **unsigned** (auth doc "Should do soon" item 4). Storing `next`
  there is acceptable **only because** the callback re-validates it. A tampered value can at worst
  choose another app path.
- `openapi.contract.test.ts` must stay green. Document the parameter.
- Do not change the post-login default (`/dashboard`) or the error redirect (`/login?error=…`).

**Automated tests required:**

- **Validator unit tests, web and API.** Accepts `/`, `/lists/abc`, `/backtests/new?strategyId=x`.
  Rejects:
  - `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:alert(1)`;
  - `%2F%2Fevil.com` after decoding;
  - an empty string;
  - an over-length path;
  - a path containing CR/LF.
- **API integration (`google-auth.integration.test.ts`):**
  - start with a valid `next` → callback `302` to `${WEB_BASE_URL}${next}`;
  - start with an invalid `next` → callback `302` to `${WEB_BASE_URL}/dashboard`;
  - a tampered transaction-cookie `next` is re-validated.
- **Web component tests:**
  - `LoginForm` redirects to a valid `next` and to `/dashboard` for an invalid one;
  - `RequireAuth` bounces with `?next=`;
  - `SignInPrompt` links carry `next`.
- **E2E (guest project):**
  1. From a built-in strategy, open the prompt.
  2. Click Sign in and log in as a persona (`loginAs`).
  3. The browser lands back on the strategy page.

**Manual verification:**

- Guest → built-in monitor → prompt → sign in with a password: you return to the monitor.
- The same with Google on the dev stack.
- Open `/login?next=//example.com` directly and sign in: you land on `/dashboard`.

**Uncertainty:** whether to carry `next` through the email-verification link. It is not required
here; it is listed as a follow-up in §8.

**Release-blocking:** yes. Deferring parts 2–4 while fixing the copy (part 6) satisfies the
blocking requirement, but that deferral must be written into the PR description.

**Dependencies:**

- UX-002 (the prompt it extends).
- Coordinate with PR 3 if both touch `auth.controller.ts`. They touch different handlers.

### UX-004: Monitor detail shows effective scanning state, not only the configured switch

**Severity:** P1 (audit H-3).

**Observed behaviour:**

- `MonitorDetail.tsx:363-372` renders only Enabled/Disabled from `enabled`.
- `MonitorsPage.tsx:265-279` renders "Not scanning" when
  `operationalStatus === "BLOCKED_BY_ENTITLEMENT"`, with `blockedExplanation(reason)`
  (`MonitorsPage.tsx:53-58`).
- `MonitorDetailResponse` extends `MonitorSummaryResponse`
  (`packages/contracts/src/monitors.ts:236`), so the detail page **already receives**
  `operationalStatus` and `blockedReason`.
- Reproduced:
  - `EV/v2-qa-stack/downgraded-monitors-1440.png`: "Enabled + Not scanning";
  - `…/downgraded-monitors_f31f583d-…-1440.png`: "Enabled" only.

**Required behaviour:**

- Monitor detail shows the configured state (Enabled/Disabled) **and**, when
  `operationalStatus === "BLOCKED_BY_ENTITLEMENT"`, the same "Not scanning" pill with the same
  explanation as the collection.
- Both surfaces render it from one shared helper.

**Why it matters:** after a downgrade, the one page meant to explain why nothing happens states the
opposite.

**Likely affected files:**

- `MonitorsPage.tsx` (move `blockedExplanation` and the pill out).
- `MonitorDetail.tsx`.
- `apps/web/src/features/monitors/utils/` (new helper next to `format.ts`).
- Tests for both.

**Implementation constraints:**

- **Web only.** No contract, API or worker change.
- Do not change the enable/disable semantics or entitlement logic.
- Do not unify the rest of the two surfaces' status vocabulary. That is audit U-1 (§8).

**Automated tests required:**

- `MonitorDetail.test.tsx`: a blocked monitor shows "Not scanning" and its explanation for **both**
  `MONITOR_CAPACITY` and `LIST_OVER_LIMIT`. An `ACTIVE` monitor does not.
- `MonitorsPage.test.tsx` stays green on the moved helper.
- E2E (`entitlements.downgraded.spec.ts`): assert "Not scanning" on the blocked monitor's detail
  page.

**Manual verification:** as DOWNGRADED, open "ENT-Downgraded Monitor 3" and compare with the
collection row.

**Release-blocking:** yes.

**Dependencies:** none.

### UX-005: A missing stock logo is a non-error response with graceful fallback

**Severity:** P2 for the product; it is required by E2E-006.

**Observed behaviour:**

- `route.ts:79-82` answers **404** (`MISSING_CACHE_CONTROL`, 1 h) when the provider CDN has no
  logo.
- `StockLogo` (`apps/web/src/components/ui/StockIdentity.tsx:67-107`) falls back to a monogram via
  `onError`, so the page looks right.
- But Chrome logs "Failed to load resource: 404" for **every logo-less ticker**. Real users hit
  this; guest dashboards logged it for QA tickers during the audit.
- This is the direct cause of 4 of the 7 E2E failures (audit §7 #2–5).

**Required behaviour:**

- A missing logo is answered with a **non-error**, cacheable response that the browser does not
  report as a failed resource, and that `StockLogo` still renders as the monogram.
- A real upstream failure stays `502 no-store`.

**Why it matters:**

- The console noise hides real errors.
- Error-monitoring tools count it.
- The E2E console assertion is right to flag it.

**Likely affected files:** `apps/web/src/app/api/logo/[symbol]/route.ts`, `route.test.ts`,
`apps/web/src/components/ui/StockIdentity.tsx`, and their tests.

**Implementation constraints:**

- **Recommended response:** `204 No Content` with the same `MISSING_CACHE_CONTROL`.
  - An `<img>` receiving 204 fires `error`, so the existing `onError` monogram path works.
- **The component's cache-hit path must also treat a zero-size decode as missing.**
  `StockIdentity.tsx:76-81` checks `image.complete && image.naturalWidth > 0` to catch an image
  that settled before hydration. A cached 204 settles as `complete && naturalWidth === 0`. Without
  handling it, a cached miss could render an empty box instead of the monogram.
- **Uncertainty:** that Chrome does not log a console error for a 204 image response is expected
  but **not verified**. The E2E console assertion (E2E-006) is the proof.
  - If Chrome does log it, the alternative is a transparent 1×1 image plus a response header
    (e.g. `X-Logo-Missing: 1`).
  - That alternative needs a different fallback trigger, because `onError` would not fire. Decide
    in the PR, with evidence.
- Keep SEC-002's headers on the image path.

**Automated tests required:**

- `route.test.ts`: an upstream miss returns 204 with the cache header and an empty body. A
  provider failure still returns 502.
- `StockIdentity` test:
  - `onError` shows the monogram;
  - a pre-hydration `complete && naturalWidth === 0` shows the monogram.
- E2E: covered by E2E-006's unfiltered console assertion.

**Manual verification:**

- Stock Details for a ticker without an upstream logo on the dev stack shows the monogram, with
  **no** console error, on first load and on a cached reload.

**Release-blocking:** no for the product, but E2E-006 depends on it and E2E-006 is part of the
release gate.

**Dependencies:** textual conflict with SEC-002 (PR 2).

### UX-006: Styled not-found page and application error boundaries

**Severity:** P1 (audit H-4).

**Observed behaviour:**

- No `error.tsx`, `global-error.tsx` or `not-found.tsx` exists under `apps/web/src/app` (verified
  by listing the route tree).
- An unknown URL renders Next's bare 404 (`EV/v2-qa-stack/guest-nope-404-1440.png`).
- Any render-time throw in a client component replaces the whole shell with Next's unstyled error.

**Required behaviour:**

- **Unknown URL:** a not-found page in the product's visual language (`EmptyState`, tokens) with a
  link to `/dashboard`.
- **A render error inside the app shell:** an in-shell error state (navigation still usable) with
  a "Try again" that calls `reset()`.
- **A root-layout failure:** a minimal `global-error.tsx`.
- None of these may leak error messages or stacks to the page. Log to the console only.

**Why it matters:** today one bad payload or chart exception strands the user with no navigation.

**Likely affected files:**

- New: `apps/web/src/app/not-found.tsx`, `apps/web/src/app/(app)/error.tsx`,
  `apps/web/src/app/global-error.tsx`.
- Reuse `components/ui/EmptyState` and existing shell components.

**Implementation constraints:**

- Next 16.1.6 / React 19 conventions.
- `error.tsx` and `global-error.tsx` must be client components; `global-error.tsx` must render its
  own `<html>`/`<body>`.
- **Uncertainty:** unmatched URLs are handled by the **root** `not-found.tsx`, which renders inside
  the root layout, not the `(app)` group layout. Decide in the PR whether it renders the shell
  explicitly or stands alone, and verify in the browser.
- Do not change routing or `RequireAuth`.

**Automated tests required:**

- Component tests: `error.tsx` renders the error state and `reset` is called on click;
  `not-found.tsx` renders the Dashboard link.
- E2E (guest): `/definitely-not-a-route` shows the styled page with a working link.
- There is no deterministic way to force a render error in E2E without test-only code. **Do not
  add a production crash trigger.** The component test covers `error.tsx`.

**Manual verification:**

- Visit an unknown URL at 1440 and 390.
- Temporarily throw in a component on a local branch, confirm the in-shell error state and
  "Try again", then discard the change.

**Release-blocking:** yes.

**Dependencies:** none.

### UX-007: Dashboard ticker is legible at 1280 px

**Severity:** P1 (audit H-5).

**Observed behaviour:**

- At 1280 px with real data the Stock column shows "U.", "R.", "M.", "H."
  (`EV/v2-dev-data/devfree-dashboard-1280.png`). It is fine at 1440.
- The Why column has `min-width: 14rem` (`DashboardPage.module.css:98-103`), and the Strategy, List
  and Monitor chips do not shrink.
- The Stock column (`DashboardPage.tsx:99-112`) has no width, so it absorbs all of the shrink.
- `DataTable` already supports a per-column `width` (`components/ui/DataTable.tsx:35,157`).

**Required behaviour:**

- From 880 px (the table breakpoint) up to 1440 px, every row shows the full ticker (at least 5
  characters) and a truncated company name.
- The other columns may truncate.

**Why it matters:** the column that identifies each signal is unreadable on a 13" laptop.

**Likely affected files:** `apps/web/src/features/dashboard/components/DashboardPage.tsx`
(column definition) and `DashboardPage.module.css`.

**Implementation constraints:**

- **Minimal:** set a width or min-width on the Stock column, and allow entity chips to truncate
  with ellipsis.
- **Do not** remove columns, reorder them, change the card strip or change the mobile composition.
- **Do not** change `DataTable` itself unless the column-level `width` proves insufficient.
- Check the choice against 1024, 1280 and 1440.

**Automated tests required:**

- Playwright at viewport 1280×900 and 1024×768 on the Dashboard with QA signals:
  - for each row, the ticker cell's rendered text equals the full symbol;
  - `scrollWidth <= clientWidth` for the ticker element, meaning no ellipsis on the ticker;
  - no horizontal document overflow.
- `QATEST1` (7 characters) is a stricter case than real tickers. Assert on it.

**Manual verification:** the dev stack with real signals at 1024, 1280, 1440 and 820 (the card
layout is unchanged).

**Release-blocking:** yes.

**Dependencies:** none.

---

## 7. PR 5: Deterministic E2E and test repairs

**Scope rule:** tests, seeds and E2E scripts only. It includes **no** product behaviour change.
UX-005 is the product half of the logo failures and lives in PR 4.

The baseline being repaired is 156 passed / 7 failed (`EV/e2e.log`). The target is **all green on
a freshly seeded stack, run twice in a row, with FMP unreachable**.

### E2E-001: The E2E stack never reaches FMP and never depends on the wall clock for freshness

**Severity:** P1 (audit H-10).

**Observed behaviour:**

- `dev:api:e2e` and `dev:worker:e2e` (`package.json`) inherit `FMP_API_KEY` from `.env`.
- The QA seed writes freshness watermarks stamped with the seed time (`syncedAt`/`freshThrough`,
  `apps/api/src/benchmarks/seed-qa-benchmark-data.ts:236-241`).
- The benchmark loader treats a tail older than 6 h as stale (`benchmark-service.ts:77-78,238-248`)
  and refreshes it from FMP.
- Stock data has the same pattern (`STOCK_RECENT_PRICE_FRESHNESS_MS`; `auth-testing.md` §7 tells
  you to "run the seed shortly before the Stock Details suite").
- The test DB's SPY series carried **real** FMP closes (757.39, 760.88 on 2026-09-14/15) after
  synthetic ones (≈470 through 2026-09-11). That produced a fake +78% benchmark
  (`EV/v2-qa-stack/pro-backtests_9fc43e7b-…-1440.png`).
- **Uncertainty:** the exact session in which those rows were written is not established. The 6 h
  stale-tail refresh is the only provider write path found; §1 correction 2 explains why blanking
  the key is not an option.

**Required behaviour:**

- With the E2E stack running, **zero requests reach FMP** for the whole suite, including
  backtests, Stock Details, market overview and monitor scans.
- Fixture freshness does not expire during a working day.

**Why it matters:** a release gate whose data mutates from a live provider is neither deterministic
nor trustworthy.

**Likely affected files:**

- `package.json` (`dev:api:e2e`, `dev:worker:e2e`).
- `packages/config/src/index.ts` (optional `FMP_BASE_URL`) and its test, plus the place that
  constructs the FMP client from `getFmpConfig()`.
- `apps/api/src/seed-qa-securities.ts`, `apps/api/src/benchmarks/seed-qa-benchmark-data.ts`, and
  any stock-data watermark writer in the QA seed.
- `ai/workflows/auth-testing.md` §7.

**Implementation constraints (choose in the PR, and record the choice in E2E-007):**

- **Freshness (verified wiring):** one variable, `STOCK_RECENT_PRICE_FRESHNESS_MS` from
  `getStockDataConfig()`, feeds both the stock loader and `BenchmarkDataService`, in the API
  (`stocks.module.ts:159`, `benchmark-data.composition.ts:42`) and in both worker children
  (`apps/worker/src/monitor/composition.ts:93`, `apps/worker/src/backtest/composition.ts:128,146`).
  Setting it to a long window in `dev:api:e2e` and `dev:worker:e2e` removes the wall-clock
  dependency. No product change is needed.
- **Egress:** set the e2e scripts' provider to a **non-routable, fail-fast** target so any
  accidental call fails loudly and immediately instead of reaching the internet.
  - **Verified:** the FMP client already accepts a `baseUrl` option (`packages/fmp/src/client.ts:36`,
    defaulting at `:363`).
  - But `getFmpConfig` (`packages/config/src/index.ts:835-840`) does not read one from the
    environment. The PR would add an optional `FMP_BASE_URL` to `packages/config`, defaulting to
    today's URL, and point the e2e scripts at an unroutable address. That is a configuration
    addition, not an offline-mode branch.
  - The fallback, if that is rejected, is a sentinel key (`FMP_API_KEY=e2e-offline`), which still
    makes a network call that FMP rejects.
- **Never** change production defaults, and never add an "offline mode" branch to product code.

**Automated tests required:**

- A **provider-egress guard** for the E2E run. For example, the E2E stack's FMP gate or client
  logs `fmp.request.*`, and a Playwright `globalTeardown` fails if the API or worker log shows any
  provider request.
  - The mechanism depends on existing logging. `local-stack-environment` notes that "nothing in
    the API logs records provider calls", so this may need a Redis-side check of
    `stock-data:v2:fmp:*` admissions during the run, restricted to the E2E Redis namespace.
- A unit test of any new seed-watermark computation.

**Manual verification:**

1. Run the full suite with the network to `financialmodelingprep.com` blocked (a hosts-file entry
   or a firewall rule). It must still be green.
2. Run it again the next morning without re-seeding stock data.

**Release-blocking:** yes, as a release gate.

**Dependencies:** E2E-002 (data repair) lands with or before it.

### E2E-002: Re-seeding removes provider-written rows from fixture series

**Severity:** P1 (audit H-10).

**Observed behaviour:** the QA benchmark seed writes the synthetic range, but rows a provider wrote
**outside** that range survive re-seeding. That is how the test DB's SPY series keeps its real
2026-09-14/15 closes.

**Required behaviour:**

- `pnpm test:securities:seed` leaves every fixture series (`SP500`, the market references, QA
  securities) containing **exactly** the seeded rows.
- Anything else in that series is deleted in the same transaction, and its coverage/state rows and
  Redis manifests are reset (the seed already invalidates manifests,
  `seed-qa-securities.ts:83,92`).

**Why it matters:** without it, E2E-001 prevents new contamination but the existing contamination
persists.

**Likely affected files:** `apps/api/src/benchmarks/seed-qa-benchmark-data.ts`,
`apps/api/src/seed-qa-securities.ts`, and the store method used (`saveDailyPriceSync` or a
dedicated replace).

**Implementation constraints:**

- The seed must keep refusing `NODE_ENV=production` (`assertQaSecuritySeedingAllowed`).
- Scope deletions to the fixture series ids **only**.
- Never touch the dev database. The seed targets `TEST_DATABASE_URL`.

**Automated tests required:** a seed integration test (test DB):

1. Insert a foreign row into the `SP500` series after the seeded range.
2. Re-seed.
3. The row is gone, and the coverage state matches the seeded range.

**Manual verification:** after re-seeding, run
`select max(date) from "BenchmarkDailyPrice" where "seriesId" = <SP500 series>`. It equals the
seeded end, and there are no values near 750.

**Release-blocking:** yes, as a release gate.

**Dependencies:** none.

### E2E-003: Resume test waits for a real drawing predicate and cleans up its run

**Severity:** P1 (audit §7 #1).

**Observed behaviour:**

- `apps/web/e2e/backtests/backtests.user.spec.ts:505-517` returns `"drawing"` as soon as
  `backtest-chart` **exists**.
- Since commit `be9ca337` the chart mounts at QUEUED/PREPARING with `data-strategy-points=0`, so
  the poll exits immediately and `:530` `expect(pointsBeforeReload).toBeGreaterThan(0)` fails. It
  failed in 3.6 s in the audit run.
- `test.afterEach` (`:305-308`) deletes the strategy and list but never waits for the submitted
  run, so a failing test leaves a PRO run in flight. That is a cause of E2E-004's failures.

**Required behaviour:**

- **The poll resolves on either:**
  - `data-strategy-points > 0` (drawing); or
  - a terminal status.
- **The test's assertion stays intact:** when it reached "drawing" before completion, points are
  greater than 0 and do not shrink after reload.
- **When the run completes before any mid-flight sample,** the test must say so with
  `test.info().annotations`, as the neighbouring progressive tests do, not pass silently.
  - **Uncertainty:** a truly mid-flight sample needs an e2e-only slowdown (audit T-3). That is not
    in scope here.
- **Cleanup:** every spec that submits a run waits, in `afterEach`, until that run reaches a
  terminal status, with a bounded timeout and a clear failure message.

**Why it matters:**

- The test currently fails for a reason unrelated to resuming.
- Its leftover run breaks an unrelated spec.

**Likely affected files:** `apps/web/e2e/backtests/backtests.user.spec.ts`, and possibly a shared
`waitForRunTerminal` helper in `apps/web/e2e/utils/`.

**Implementation constraints:** do not weaken `toBeGreaterThan(0)` or the no-shrink assertion. Do
not add product test hooks.

**Automated tests required:** the spec itself, green in two consecutive full runs.

**Manual verification:** run `pnpm test:e2e -- --project=user e2e/backtests` three times. Every run
passes, and afterwards no PRO run is in flight. Check with
`select status, count(*) from "BacktestRun" … where status in ('QUEUED','PREPARING_DATA','RUNNING','FINALIZING')`
on the test DB.

**Release-blocking:** yes, as a release gate.

**Dependencies:** E2E-001 (deterministic data), so run duration is predictable.

### E2E-004: PRO concurrency spec: timeouts, waits and counting are internally consistent

**Severity:** P1 (audit §7 #6–7).

**Observed behaviour** (`apps/web/e2e/entitlements/entitlements.pro.spec.ts`):

- `waitForFreeSlot` polls `countInFlight` with `timeout: 120_000` (`~:159-161`) inside tests
  running on the default **30 s** test timeout (`playwright.config.ts` sets none). The poll's
  budget can never be used, and the test dies at 30 s.
- `waitForFreeSlot` is called only **after** submitting (`:75`, `:104`), never before.
- `countInFlight` (`~:134-147`) reads grid page 1 of `/backtests` (25 rows, newest first). PRO_USER
  had 225 accumulated runs, so the pinned fixture run can fall off page 1.
- The header (`:22-23`) says "No run is pinned in flight for this persona". The fixture does pin
  one (`seed-entitlement-fixtures.ts:648-716`, lease 2099). The test at `~:79-85` depends on it.

**Required behaviour:**

- **Each test's timeout is set explicitly** to cover its own waits: `test.setTimeout`, at least the
  poll budget plus submission time.
- **Before submitting,** each concurrency test waits until only the pinned fixture run is in
  flight. On timeout it fails with a message naming the stray run's id and status.
- **In-flight counting uses the API** (`GET /backtests` through the page's request context, with
  the cookie), not the first grid page.
- **The header comment** describes the pinned run truthfully.

**Why it matters:** these two failures are artefacts of the test's own arithmetic plus fixture
residue. As things stand, the PRO concurrency guarantee is not actually being tested.

**Likely affected files:** `apps/web/e2e/entitlements/entitlements.pro.spec.ts`, possibly
`apps/web/e2e/utils/`.

**Implementation constraints:**

- Do not change a persona's plan.
- Do not mutate fixtures from the spec (`auth-testing.md` §3, §7).
- Keep `workers: 1`.

**Automated tests required:** the spec itself, green in two consecutive full runs **after**
`backtests.user.spec.ts`, the order that failed.

**Manual verification:** run `pnpm test:e2e` twice back to back. Both runs have the PRO project
green.

**Release-blocking:** yes, as a release gate.

**Dependencies:** E2E-003 (no leftover run) and E2E-005 (fast ENTF runs).

### E2E-005: ENTF fixture securities declare complete empty coverage

**Severity:** P1 (audit §7 #6).

**Observed behaviour:**

- "ENT-Pro Wide" holds 80 fictional `ENTF###` tickers with no coverage rows. The seeder's comment
  says "nothing here is executed" (`seed-entitlement-fixtures.ts` header).
- The PRO spec does execute them, so the worker hydrates each through FMP. In the audit it logged
  `backtest.security.skipped NO_DAILY_DATA` per ticker and stayed in `PREPARING_DATA` for minutes.

**Required behaviour:**

- The entitlement seed writes, for every `ENTF` security, the same kind of coverage and watermark
  rows QATEST1 has, declaring **"complete, and empty over the retained range"**.
- Preparation then skips them without a provider call, and a 30-year PRO run over "ENT-Pro Wide"
  reaches a terminal state in seconds.
- **Uncertainty:** confirm that the loader treats "coverage complete, zero rows" as settled and not
  as a gap to re-fetch. `missingBenchmarkCoverage`'s doc comment implies it does for benchmarks
  (`benchmark-service.ts:330-337`); the stock loader must be checked.

**Why it matters:** without this, E2E-001 turns these runs into failures instead of slow runs,
because there is no provider to reach.

**Likely affected files:** `apps/api/src/entitlements/seed-entitlement-fixtures.ts` and its test.

**Implementation constraints:**

- No product loader change.
- If the loader cannot express "complete and empty", stop and record that. Do not add a
  test-only branch to `stock-data`.

**Automated tests required:** a seed test asserting the coverage rows exist for all ENTF
securities. The E2E spec (E2E-004) proves the runtime effect.

**Manual verification:** submit a 30-year PRO run over "ENT-Pro Wide" on the E2E stack. It reaches
a terminal state within about 30 s, with no provider traffic.

**Release-blocking:** yes, as a release gate.

**Dependencies:** E2E-001.

### E2E-006: Shared Playwright logo stub; one `watchForIssues` helper

**Severity:** P1 (audit §7 #2–5).

**Observed behaviour:**

- `indicators.user.spec.ts:38` and `oscillators.user.spec.ts:28` each define their own
  `watchForIssues`.
- Both assert `consoleErrors` and `failedRequests` are empty, and both fail on
  `/api/logo/QATEST1` → 404, which is also a live CDN call.

**Required behaviour:**

- **One `watchForIssues`** in `apps/web/e2e/utils/`.
- **A shared fixture** routes `**/api/logo/**` to the **missing-logo response defined by UX-005**
  (for example 204), so E2E never contacts the CDN and exercises the same fallback path real users
  see.
- **The console and failed-request assertions stay unfiltered.**

**Why it matters:** these four failures hide any real console error on Stock Details.

**Likely affected files:** the two specs, `apps/web/e2e/utils/`, and possibly a Playwright fixture
file.

**Implementation constraints:**

- **Do not add a console filter for logos.** If a real 404 appears, the assertion should catch it
  (audit §7).
- The stub must use UX-005's exact status, so product and test agree.

**Automated tests required:** the four failing cases green. Add one new case asserting that a
logo-less ticker renders the monogram with no console error.

**Manual verification:** run `pnpm test:e2e -- e2e/stocks` with the network blocked.

**Release-blocking:** yes, as a release gate.

**Dependencies:** UX-005 (PR 4) must merge first.

### E2E-007: Document the deterministic fixture boundaries

**Severity:** P2.

**Required content:** add to `ai/workflows/auth-testing.md` §7 (and `ai/workflows/validation.md`
where it overlaps):

- **Which data each suite needs:** QATEST, the SP500 fixture, the market references, ENTF, and the
  built-ins.
- **Which process writes each dataset:** the seeds.
- **The guarantee** that the E2E stack makes no provider calls, and how E2E-001's guard checks it.
- **The freshness policy.**
- **The rule** that the E2E stack and `pnpm test` must not run at the same time against
  `TEST_DATABASE_URL`. That is audit T-1, which stays a known limitation in §8.
- **Worker requirements** per project.

Also correct the `validation.md` list of `useTestDatabase()` callers: it omits
`apps/api/src/monitors/monitors.integration.test.ts` (audit §7 P3).

**Tests:** none.

**Release-blocking:** no.

**Dependencies:** E2E-001…006 (it documents their outcome).

### TEST-001: Investigate the intermittent `GET /backtests/:id` 404 in the API suite

**Severity:** P2 (audit T-4).

**Observed behaviour:**

- `apps/api/src/backtests/backtests.integration.test.ts` › "keeps a submitted run unchanged when an
  administrator later edits the built-ins" got `404` at `:792`, in one serial per-package run
  (1011/1012).
- The file then passed 30/30 alone. It did not reproduce.

**What is known:**

- `getRun` is `findFirst({ id, userId })` (`backtests.service.ts:934-946`), so the 404 means the
  row was absent or belonged to another user at that moment.
- API test files run serially (`apps/api/vitest.config.*`: `fileParallelism: false`).
- The file's `afterEach` deletes runs only for its own two users (`:298-304`).
- The only non-test deleters of `BacktestRun` are scoped to fixture or matrix namespaces:
  `seed-entitlement-fixtures.ts:648` and `qa-matrix/matrix-cleanup.ts:72`.
- During the audit, **stale `nest --watch` processes from earlier sessions were alive, and at least
  one served `intrinsic_value_test`.**

**Cause:** unknown. Hypotheses, none confirmed:

1. An external process against the test DB. Note that an API or worker cannot _delete_ a run
   through any product path found.
2. An un-awaited async operation from an earlier test in the same file resolving late.
3. The `submit()` helper returning an id from an unexpected response under load.

**Required outcome:**

- Either a reproduced root cause with a fix, **or** a documented "not reproduced in N runs under
  load" with diagnostics left in place.
- **The assertion is never weakened.** No retry, no status tolerance, no skip.

**Investigation steps:**

1. Run the file 20× serially and 5× inside `pnpm --filter @intrinsic/api test`, with **no** other
   process connected to the test DB. Check `pg_stat_activity` beforehand.
2. Add a failure-only diagnostic in the test: on a non-200, query the row by id **without** the
   user filter and log its `userId` and existence, before failing. This preserves the assertion.
3. Audit the file for un-awaited promises (`no-floating-promises` is a lint rule candidate for
   test files).

**Likely affected files:** `apps/api/src/backtests/backtests.integration.test.ts` only.

**Release-blocking:** no, unless the investigation shows a product path can lose or mis-own a run.
In that case, raise it to P0 and stop the release.

**Dependencies:** none.

---

## 8. Product decisions

**Recorded 2026-09-18 by the product owner.** These decisions are recorded here, in the plan.

- **The canonical documents are not updated by this documentation PR.** Each implementing PR must
  copy its decision into the canonical document named under "Canonical record", in the same PR as
  the code.
- **Where a decision creates new work, the work has a stable ID.** Its status is **"specification
  pending"**: it is not implementation-ready until the plan carries a full item for it, in the same
  template as §3–§7 (observed/required behaviour, files, constraints, tests, verification,
  dependencies).

### DEC-001: Public pricing. Decided: YES

- **Decision:**
  - Guests must have access to a **public `/pricing` page**.
  - The authenticated `/billing` page may remain protected. It keeps redirecting guests to
    `/login` through `RequireAuth`.
- **Context:**
  - Today guests cannot see prices at all.
  - `ai/architecture/v1-visual-parity.md:52` described a public pricing page as future work "if
    one is ever built". That wording is superseded by this decision.
  - V1 has a public `/pricing` (audit §5).
- **New tracked item:** **PRICING-001, public `/pricing` page** (specification pending).
- **Constraints the specification must respect** (traced to existing documents):
  - **One pricing source.** Plan capacities come from `PLAN_ENTITLEMENTS` and amounts from
    `BILLING_CATALOG`, as the billing cards already do. `ai/architecture/billing.md:772,794` and
    `plan-presentation.test.ts` forbid a second source.
  - **Checkout from a guest session** opens the in-context sign-in prompt. It must not call
    Checkout, because Checkout requires an account.
  - **Sign-in returns to `/pricing`,** which depends on UX-003.
  - **`/pricing` becomes a guest-readable route** (`features/auth/utils/guest-routes.ts`).
  - **No trials, credits or top-ups** (`AGENTS.md` invariant 18). This is a presentation of the
    existing four-price catalog only.
- **Canonical record:** `docs/decisions/stripe-billing-v1.md`, with a pointer from
  `docs/decisions/entitlements-v1.md` §4. Also correct `v1-visual-parity.md:52`.
- **Release-blocking:** **yes**.

### DEC-002: Guest precomputed/static demo backtests. Decided: YES, launch scope

- **Decision:**
  - Guests can view **precomputed/static demo backtests** at launch.
  - Guests **must not execute live backtests** and **must not save custom content**.
- **Context:**
  - This matches the existing text of `docs/decisions/entitlements-v1.md`:
    - §4: "Guests may view demo Backtests that are precomputed/static";
    - §7: "Guests may only consume precomputed/static demo Backtests. They may not initiate live
      Backtest execution";
    - matrix row "Demo/precomputed Backtests: Guest = Yes".
  - No implementation exists today. Guests are redirected from `/backtests` (audit §2).
- **New tracked item:** **DEMO-001, guest-viewable precomputed demo backtests** (specification
  pending).
- **Questions the specification must answer** (none is decided by this plan):
  - **Where demo runs live.** For example, `BacktestRun` rows owned by the system, or static
    snapshots.
    - Invariant 12 still applies: a run's snapshot is immutable and never re-derived from current
      rows.
    - Invariant 21 describes SYSTEM ownership for Lists/Strategies/Monitors only. Extending it to
      runs is a design decision, not an assumption.
  - **How they are produced and refreshed.** They must be produced by the real engine, never
    fabricated.
  - **Which routes guests may read.** A guest may read demo runs only. Every other run must stay
    indistinguishable from missing (404), preserving the existing cross-user denial tests.
  - **How the guest UI presents them**, and how "run your own" opens the sign-in prompt.
- **Hard constraints:**
  - No guest submission path.
  - No guest-owned rows (entitlements §4: "do not create anonymous User rows").
  - Submission stays behind `CookieAuthGuard` and the entitlement guard.
  - Existing ownership filters are extended only by an explicit demo predicate.
- **Canonical record:** `docs/decisions/entitlements-v1.md` §4/§7, which already say this. Add the
  storage and presentation design, and remove any "if built" hedging, in the implementing PR.
- **Release-blocking:** **yes**.

### DEC-003: Session revocation. Decided: IMPLEMENT before public production

- **Decision:** implement SESSION-002 before public production.
- **The alternative that accepts the eight-hour exposure is not selected.** The analysis of that
  alternative is kept below for the record.
- **Consequences:**
  - SESSION-002 is **release-blocking without an alternative**.
  - PR 3 = SESSION-001 then SESSION-002.
- **Rejected alternative (Option B), for the record:** launch without revocation, accepting that:
  - a captured session cookie remains valid for up to `AUTH_TOKEN_TTL_SECONDS` (**8 h** by
    default) after the user signs out or resets the password (scenarios R1 and R3);
  - there is no "sign out everywhere" (R2);
  - the only global mitigation is rotating `AUTH_JWT_SECRET`, which signs **everyone** out (R11).
- **Canonical record:** `ai/architecture/authentication.md`. Replace "Must do before public
  production" item 1 with the implemented mechanism in the SESSION-002 PR.

### DEC-004: Registration account enumeration. Decided: required before public production

- **Decision:** follow the existing auth document, which lists it as "Must do before public
  production" item 3. The audit's P2 rating (S-2) is superseded.
- **Remedy (as that document states, `ai/architecture/authentication.md:377-381`):**
  - `POST /auth/register` answers `202` for an address that already exists, exactly as for a new
    one;
  - and mails the owner "someone tried to register with your address" instead of returning `409`.
- **New tracked item:** **AUTH-003, registration does not reveal whether an account exists**
  (specification pending).
- **Constraints the specification must respect:**
  - **Response parity.** Status, body and timing class for a new versus an existing address,
    matching the care recovery and resend already take.
  - **Existing-account email content** for all three kinds of existing row: local verified, local
    unverified, and Google-only.
  - **The web registration UX.** It must stop relying on the 409 message.
  - **SMTP is required** (PROD-001).
  - **Timing.** The auth doc's "Should do soon" item 5 (SMTP-timing side channel) applies to this
    path too. The specification must state whether mail is sent out of band.
  - **Interaction with AUTH-002.** It must be considered, because both change what happens when
    an address is registered twice.
- **Canonical record:** `ai/architecture/authentication.md`, in the AUTH-003 PR.
- **Release-blocking:** **yes**.

### DEC-005: The email-verification takeover variant. Decided: separately tracked

**Decision:** the email-verification variant of pre-account-takeover is a **separately tracked
auth-security item, AUTH-002**.

- It must not be silently deferred.
- It must not be merged into AUTH-001 unless the AUTH-002 PR description demonstrates that the
  combined change stays small and reviewable.
- PR 1 therefore remains AUTH-001 only.

**The path** (traced from audit B-1's second paragraph):

1. An attacker registers `victim@example.com` with the attacker's password.
2. The victim receives a verification email they did not request, and clicks it.
3. The attacker's password now works (`email-verification.service.ts:101-104` sets
   `emailVerifiedAt` only).

This path needs the victim to act on an unsolicited email, unlike the Google path, where the victim
is doing something normal.

**New tracked item:** **AUTH-002, verifying an email must not activate a password the verifier did
not set** (specification pending). Candidate designs from the earlier draft of this plan, none
chosen:

- (a) make the verification email's wording explicit ("If you didn't create this account, ignore
  this email");
- (b) require the password on verification, so only the person who set it can verify;
- (c) other designs.

**Release-blocking:** **not yet classified**, and it must be classified explicitly, with a date and
an owner, before public production. That classification is a release-gate item in §9. It may not
default to "deferred".

**Canonical record:** `ai/architecture/authentication.md`.

**Classification and design (2026-09-18, recorded in the AUTH-002 PR):**

- **Classified release-blocking**, P1, and implemented in its own PR, separate from AUTH-001 and
  AUTH-003. Before the fix a single click on the unsolicited email was enough.
- **Chosen design: (c)** — verification sets the password. The verification page asks the holder of
  the link for a new password; `POST /auth/verify-email` takes `{ token, password }` and, in one
  transaction, consumes the token, installs that password, sets `emailVerifiedAt`, increments
  `sessionVersion` and drops any outstanding reset token.
- (a) alone was rejected because wording does not stop a click. (b) was rejected because it makes
  the attacker's password the thing that unlocks verification, the opposite of the invariant.
- The invariant it establishes: redeeming a verification link never activates a password chosen
  before control of the mailbox was proven. `ai/architecture/authentication.md`, *The rule:
  verification sets the password*, carries the flow, transaction boundaries, concurrency and
  residual limitations.

### DEC-006: Google sign-in at launch. Decided: ENABLED

- **Decision:** Google sign-in is enabled for launch (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  and `GOOGLE_CALLBACK_URL` are configured in production).
- **Consequence:** **AUTH-001 is release-blocking unconditionally.** The Google Console callback
  registration is a required deployment step (§9).
- **Canonical record:** the deployment checklist (§9).

---

## 9. Release gate checklist

### Required before public production

**PR 1:**

- [ ] AUTH-001 merged. It is unconditional: DEC-006 enables Google for launch.

**PR 2:**

- [ ] PROD-001, PROD-002, CI-001, CI-002, SEC-001, SEC-002 merged.
- [ ] CI green with the frozen lockfile and the migration-drift step.

**PR 3:**

- [ ] SESSION-001 and SESSION-002 merged. DEC-003: implement; no alternative is accepted.

**PR 4:**

- [ ] UX-001, UX-002, UX-003 (or its documented copy-only deferral), UX-004, UX-006, UX-007
      merged.

**PR 5 (the release gate itself):**

- [ ] E2E-001…E2E-006 merged.
- [ ] `pnpm test:e2e` green **twice consecutively** on a freshly seeded stack with FMP unreachable.
- [ ] UX-005 merged (prerequisite of E2E-006).

**Decision-driven items (§8); each must first be specified in this plan, then merged:**

- [ ] AUTH-003 merged: registration no longer reveals existing accounts (DEC-004).
- [ ] PRICING-001 merged: public `/pricing`; `/billing` may stay protected (DEC-001).
- [ ] DEMO-001 merged: guests view precomputed/static demo backtests; no guest execution or saving
      (DEC-002).
- [ ] AUTH-002 **explicitly classified**, with date and owner, as release-blocking or not
      (DEC-005). If classified release-blocking, it must also be merged.
- [ ] Canonical documents updated by the implementing PRs:
      `ai/architecture/authentication.md` (DEC-003, DEC-004, DEC-005),
      `docs/decisions/entitlements-v1.md` (DEC-002),
      `docs/decisions/stripe-billing-v1.md` (DEC-001).

**Gate:**

- [ ] Standard gate green on the release commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
      `pnpm build`, `pnpm openapi:validate`.

**Deployment configuration (audit §8; this is configuration, not code):**

- [ ] Platform chosen; web and API on one registrable domain.
- [ ] `NODE_ENV=production`; unique `AUTH_JWT_SECRET`.
- [ ] `WEB_BASE_URL` / `CORS_ORIGINS` https (PROD-001 will refuse otherwise).
- [ ] The full SMTP group.
- [ ] `NEXT_PUBLIC_API_BASE_URL` passed at web build (PROD-002 will refuse otherwise).
- [ ] `RATE_LIMIT_TRUSTED_PROXY_HOPS` set to the real proxy count.
- [ ] `STOCK_CACHE_MAX_RESIDENT_STOCKS` sized (audit O-2).
- [ ] Deploy order: `pnpm db:migrate:deploy` → `pnpm builtins:bootstrap` → API and worker →
      `pnpm db:seed` once.
- [ ] Stripe live keys, the four live price ids, and this environment's `whsec`; Portal
      configured; `pnpm billing:verify-catalog` and `pnpm billing:reconcile -- --all --dry-run` clean.
- [ ] Google Console production callback registered (DEC-006: Google is enabled at launch).
- [ ] Probes: `/health` (liveness), `/health/ready` (readiness).
- [ ] Alerts: `MonitorScanSchedule.lastCompletedAt` age, `consecutiveFailures`, backtests
      in-flight for more than N hours.
- [ ] PostgreSQL point-in-time recovery confirmed.
- [ ] `BACKTEST_DEBUG_ARCHIVE` unset.

**Smoke test on the production-like environment (audit §10 Phase D):**

- [ ] Register → verify → sign in → reset password. This confirms another open session is signed
      out (SESSION-002). "Sign out everywhere" works.
- [ ] Registering an existing address answers exactly like a new one, and the owner receives the
      notice email (AUTH-003).
- [ ] Google sign-in: new account, link-verified-account, and the AUTH-001 attack scenario refused.
- [ ] FREE limits show plan messages (11-stock list, second backtest, second monitor).
- [ ] Checkout Starter → webhook → plan; Portal cancel → end-of-period.
- [ ] Strategy → 5-year backtest → result; monitor → one scan → Dashboard.
- [ ] Guest: browse built-ins; every restricted action opens the prompt; sign-in returns to the
      page.
- [ ] Guest: `/pricing` shows the four-price catalog; a plan action opens the sign-in prompt;
      `/billing` still requires sign-in.
- [ ] Guest: a demo backtest is viewable; no path lets a guest run or save one.
- [ ] 390 px pass on a real phone; 1280 px Dashboard.

### Required during launch stabilization (first 2–4 weeks)

- [ ] C-1: benchmark Redis year keys never partial (silent correctness, rare).
- [ ] C-2: backtest lease recovery on its own timer (stuck runs block a user's concurrency slot).
- [ ] O-1: production-grade images (multi-stage, non-root, `node` as PID 1 so SIGTERM reaches the
      shutdown hooks), if the repo's Dockerfiles are the deploy artifact.
- [ ] E2E job added to CI once PR 5 is stable (audit T-3 P2).
- [ ] TEST-001 concluded.
- [ ] S-1: login CSRF (reject non-JSON state-changing requests).
- [ ] C-4: market-overview failure backoff. Promote it if the provider is flaky in the first week.

### Safe to defer

- C-3 (bulk orphan sweep; raise if built-ins are restructured), C-5, P-1, P-2.
- U-1 (state vocabulary), U-2 (mobile "Why", 360 labels), U-3 (built-in back links), U-4 (resting
  chart legend), U-5 (`/stocks` redirect, trivial), U-6 (modal focus, prompt-while-loading,
  expired session, stale typeahead Enter), U-7 (formatting), U-8.
- M-1 (shared component consolidation), D-1 (stale docs; partly done by SESSION-001 and E2E-007).
- T-1, T-2, and the rest of T-3; a full application CSP; signed OAuth transaction cookie;
  `next` through the verification email.

## 10. Audit findings not assigned to a PR (traceability)

| Audit ID      | Disposition in this plan                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| C-1, C-2      | Stabilization (§9). Separate small PRs after launch-blocking work.                                                                   |
| C-3, C-4, C-5 | Stabilization / deferred (§9).                                                                                                       |
| U-1 … U-8     | Deferred, except the parts absorbed into UX-001…UX-007. U-6's prompt-while-loading is covered for the two actions touched by UX-002. |
| S-1           | Stabilization.                                                                                                                       |
| S-2           | AUTH-003 (DEC-004: required before public production).                                                                               |
| O-1           | Stabilization, conditional on the deploy artifact.                                                                                   |
| O-2           | Deployment configuration (§9).                                                                                                       |
| T-1           | Known limitation, documented by E2E-007.                                                                                             |
| T-2           | Deferred.                                                                                                                            |
| T-3           | Partly E2E-003 (cleanup); the rest is deferred.                                                                                      |
| T-4           | TEST-001.                                                                                                                            |
| P-1, P-2, M-1 | Deferred.                                                                                                                            |
| D-1           | Partly SESSION-001 (rate-limit line in `authentication.md`) and E2E-007 (`validation.md` list). The rest is deferred.                |

## 11. Non-goals

These are explicitly **out of scope** for every PR in this plan. A PR that needs one of them is out
of scope and must stop and ask.

- **No job-claim or lease redesign.**
  - `BacktestJob` and `MonitorScanSchedule` keep their PostgreSQL `FOR UPDATE SKIP LOCKED` plus
    renewable-lease protocol (AGENTS invariants 14–15).
  - No queue library, cron or Redis lock.
- **No entitlement architecture rewrite.** The central resolver, guards at canonical boundaries,
  the per-user advisory lock, and persona-based tests stay as they are (invariant 17). UX-001
  changes only how refusals are _displayed_.
- **No Monitor lifecycle or fingerprinting rewrite.** The pure reducer
  (`@intrinsic/strategy` `monitor-lifecycle.ts`) and fingerprint semantics are unchanged
  (invariant 15). UX-004 is presentation only.
- **No React Query or Server Components migration.** The client shell and hand-rolled fetch hooks
  stay.
- **No Dashboard redesign.** UX-007 is a column-width fix. The 5-card strip, VIX gauge, signals
  table and mobile cards are untouched.
- **No shared-component cleanup unrelated to a finding.** No `SegmentedControl` unification,
  chart-palette extraction, `lib/format` module or generic fetch hook in these PRs. UX-004's shared
  helper and UX-002's shared prompt copy are the only extractions, and each exists because two
  surfaces currently disagree.
- Also out of scope:
  - changing financial formulas;
  - touching the `SP500`/`SP500_INDEX` split;
  - changing Stripe's one-way direction;
  - adding dependencies without a concrete use (SEC-001 prefers none).

## 12. Proposed PR order

```text
PR 1  AUTH-001                                   (independent; merge first — smallest, highest severity)
PR 2  PROD-001 PROD-002 CI-001 CI-002 SEC-001 SEC-002   (independent; merge before PR 4 — shared logo route)
PR 3  SESSION-001 → SESSION-002                  (independent; needs a migration)
PR 4  UX-001 UX-002 UX-003 UX-004 UX-005 UX-006 UX-007  (after PR 2 for the logo route)
PR 5  E2E-001 E2E-002 E2E-003 E2E-005 E2E-004 E2E-006 E2E-007 TEST-001  (E2E-006 after PR 4's UX-005)
```

- PRs 1, 2 and 3 can be developed in parallel.
- PR 4 can be developed in parallel and rebased onto PR 2.
- PR 5's E2E-001/002/003/005 can start immediately. Only E2E-006 waits for UX-005.
- Run the full E2E suite as the final step **after** PR 5, on the combined main. Repeat it after
  the decision-driven PRs below.

**Decision-driven PRs** (§8). Each gets a full item and a PR number here before implementation:

```text
AUTH-003     registration enumeration        (after PR 2: needs PROD-001's required SMTP; coordinate with AUTH-002)
AUTH-002     email-verification variant      (classify first; its own PR unless its PR proves a combined scope stays reviewable)
PRICING-001  public /pricing                 (after PR 4: sign-in return to /pricing uses UX-003)
DEMO-001     guest demo backtests            (after its design is specified; after PR 4 for the guest prompt)
```

## 13. Validation commands for implementation PRs

Run from the repository root.

**Stack hygiene first:** no dev API or worker may be running against `TEST_DATABASE_URL` during
`pnpm test`. Check with:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
ps -eo pid,command | grep -E "[w]orker-process|[n]est.js start"
```

**Every PR, once settled (the standard gate, `AGENTS.md`):**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:validate
```

**Targeted, during iteration:**

```bash
# PR 1 — Google linking (DB-backed; needs TEST_DATABASE_URL in .env)
pnpm build:packages
pnpm --filter @intrinsic/api exec vitest run src/auth/google-auth.integration.test.ts src/auth/auth.integration.test.ts

# PR 2 — config, headers, logo route
pnpm --filter @intrinsic/config test
pnpm --filter @intrinsic/web exec vitest run src/app/api/logo
docker build -f docker/web.Dockerfile .                                                    # must FAIL
docker build -f docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.test .  # must pass
# migration drift (local equivalent of CI-002; shadow DB created and dropped explicitly)
docker exec factorsage-postgres-1 psql -U intrinsic -d postgres -c "CREATE DATABASE intrinsic_shadow_ci;"
(cd packages/database && npx prisma migrate diff --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "postgresql://intrinsic:<password>@localhost:5432/intrinsic_shadow_ci" --exit-code)
docker exec factorsage-postgres-1 psql -U intrinsic -d postgres -c "DROP DATABASE intrinsic_shadow_ci;"

# PR 3 — sessions (migration: generate with prisma migrate diff, never migrate reset on the dev DB)
set -a && . ./.env && set +a && pnpm db:test:prepare
pnpm db:generate && pnpm --filter @intrinsic/database build
pnpm --filter @intrinsic/api exec vitest run src/auth
pnpm --filter @intrinsic/api exec vitest run src/rate-limit src/openapi

# PR 4 — web
pnpm --filter @intrinsic/web exec vitest run src/features/lists src/features/monitors src/features/strategies src/features/auth src/features/dashboard src/components/ui
pnpm --filter @intrinsic/api exec vitest run src/auth/google-auth.integration.test.ts src/openapi   # UX-003 API half

# PR 5 — E2E stack (deterministic; see E2E-007 once written)
set -a && . ./.env && set +a
pnpm dev:api:e2e        # terminal 1
pnpm dev:worker:e2e     # terminal 2
pnpm dev:web            # terminal 3 (must be :3000 — CORS allowlist is WEB_BASE_URL)
pnpm test:personas:seed
pnpm test:e2e           # run twice; both must be green
pnpm --filter @intrinsic/api exec vitest run src/backtests/backtests.integration.test.ts   # TEST-001, repeat per its steps
```

**After any `next dev` run, before committing:**

```bash
git checkout -- apps/web/next-env.d.ts
```

**Uncertainty:** `pnpm --filter @intrinsic/api exec vitest run <files>` bypasses the package's
`test` script, which pre-builds workspace packages and excludes the live-FMP and Stripe-sandbox
suites. Run `pnpm build:packages` first, and never name those two excluded files explicitly.

---

## 14. Open uncertainties (collected)

**PR 2:**

- **PROD-002:** the deploy platform, and the release-build flag's final name.
- **CI-001:** whether frozen installs pass under CI's pnpm 10. Verified only with local pnpm 11.
- **CI-002:** the Prisma CLI flag support in the installed version.

**PR 4:**

- **UX-003:** carrying `next` through the email-verification link (not required).
- **UX-005:** Chrome's console behaviour for a 204 image response.
- **UX-006:** the root `not-found.tsx` relationship to the `(app)` shell.

**PR 5:**

- **E2E-001:**
  - the exact session in which live FMP rows entered the test DB;
  - how to observe provider egress deterministically.
  - Resolved during planning: the freshness window is configurable (one variable), and the FMP
    client has a `baseUrl` option that is not yet environment-wired.
- **E2E-003:** mid-flight sampling needs an e2e-only slowdown (deferred, T-3).
- **E2E-005:** whether "complete and empty" coverage is honoured by the stock loader.
- **TEST-001:** root cause unknown.
