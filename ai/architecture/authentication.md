# Authentication Architecture

The Nest API is the authentication authority for V2. It owns credentials, sessions, email
verification, and the Google OpenID Connect exchange. The web application holds no authentication
authority; its auth state is presentation logic only. V2 does not use NextAuth and does not use
Pages Router.

For running auth tests, seeding QA personas, and Playwright, see
[`../workflows/auth-testing.md`](../workflows/auth-testing.md).

Supported ways to sign in, and nothing else:

| Method                       | Proof                                            |
| ---------------------------- | ------------------------------------------------ |
| Email + password             | Argon2id verification against `User.passwordHash` |
| Google (OIDC, PKCE)          | A fully verified Google ID token                  |
| Password recovery            | A single-use emailed reset token                  |

There is no magic-link sign-in, no MFA, no passkey and no second external provider.

## Identity model

`User` is the product identity:

- UUID `id`
- normalized unique `email`
- nullable `passwordHash`
- nullable `emailVerifiedAt`
- `USER` or `ADMIN` role
- `FREE`, `STARTER` or `PRO` commercial plan
- creation and update timestamps

Role and plan are orthogonal and both are authorization inputs: a user may be `plan=FREE` and
`role=ADMIN`. `role` is authorization and is never sold; `plan` is commercial and never grants
administrative access. Both are projected into `AuthUser` because the cookie guard reloads them on
every request, which is what lets the entitlement resolver read persisted state rather than
anything a client asserted. See `entitlements.md`.

Emails are trimmed and lowercased before lookup or storage. PostgreSQL enforces uniqueness.
Passwords are hashed with Argon2id and plaintext credentials are never persisted or logged.
`passwordHash` never appears in API contracts or responses.

Two satellite models complete the identity picture:

- `OAuthAccount` — `(provider, providerAccountId)` unique, related to `User`, with
  `OAuthProvider = GOOGLE`. FactorSage uses external providers for identity only, so provider
  access and refresh tokens are deliberately never persisted.
- `EmailVerificationToken` — one row per user (`userId` unique), storing only the SHA-256
  `tokenHash` plus `expiresAt`.
- `PasswordResetToken` — the same shape, for the same reasons, in its own table. Separate rather
  than a `kind` column, because the two lifecycles are independent: requesting a password reset
  must not cancel a pending verification link, and "one outstanding token per user" only means
  something when it holds per purpose.

The model represents all four identity states:

```text
local password only      passwordHash set,  no OAuthAccount
Google only              passwordHash null, one OAuthAccount
both                     passwordHash set,  one OAuthAccount
unverified local         passwordHash set,  emailVerifiedAt null
```

## Local registration and email verification

`POST /auth/register` normalizes the email, enforces the shared password policy
(`PASSWORD_MIN_LENGTH` in `@intrinsic/contracts`), hashes with Argon2id, and creates the user with
`emailVerifiedAt` null. It then issues a verification token and sends the link.

An address that already belongs to any account is rejected with the same `409` message whether the
existing account is local or external-only. Registration never attaches a password to an account
the caller has not proven they own.

Verification tokens:

- 256 bits of cryptographic randomness, encoded base64url
- only the SHA-256 hash is persisted; the plaintext exists solely inside the outbound email
- expire after `AUTH_EMAIL_VERIFICATION_TTL_SECONDS`
- single-use: redemption deletes the row and marks the address verified inside one database
  transaction, so the two effects cannot come apart and only the request that actually removed the
  row succeeds
- one outstanding token per user, so `POST /auth/resend-verification` rotates and invalidates the
  previous link

`POST /auth/resend-verification` always answers `202`. Unknown addresses, already-verified
accounts, and external-only accounts are silent no-ops so the endpoint cannot enumerate accounts.

The verification link points at the web application (`WEB_BASE_URL/verify-email?token=...`), which
redeems the token through `POST /auth/verify-email`.

## Google authentication

`GET /auth/google` mints one short-lived sign-in transaction — an anti-CSRF `state`, a PKCE
`code_verifier`, and an OIDC `nonce`, each 256 bits of cryptographic randomness — stores it in a
single HttpOnly cookie scoped to `/auth`, and redirects to Google requesting only `openid email`.
Only the derived S256 `code_challenge`, the `state`, and the `nonce` travel through the browser;
the verifier never leaves the server and is never readable by browser JavaScript. `plain` PKCE is
never used.

`GET /auth/google/callback` clears the transaction cookie, compares the returned `state` against
the transaction with a constant-time comparison, and exchanges the authorization code through the
`GoogleIdentityProvider` port, presenting the PKCE verifier.

The real implementation is `GoogleOidcIdentityProvider`, built on `google-auth-library`. Identity
claims are only ever taken from an ID token that `verifyIdToken` has fully validated:

- Google's signature against Google's published keys
- `aud` equal to this deployment's `GOOGLE_CLIENT_ID`
- a valid Google `iss`
- an unexpired `exp`

A token is never decoded and trusted, and Google's `tokeninfo` endpoint is never used. On top of
the library's checks the provider requires a usable `sub` and a `nonce` that matches this
browser's transaction, which blocks replaying an ID token minted for a different authorization
request. Every verification failure produces one fixed, detail-free error.

On top of `sub`, the provider also carries the verified `hd` claim — the Workspace/Cloud
organization domain, absent for a consumer account — because the linking rule below needs it.
`hd` is read only from a payload `verifyIdToken` already validated.

### The authoritative-email rule

`email_verified` does **not** mean Google owns the address. A consumer Google account can be
created around any third-party address, and Google will then report that address as verified: the
claim says Google's records show a delivery check happened, not that Google runs the mailbox
today. Treating it as proof of ownership would let anyone who once controlled an address — or who
controls it at Google without controlling it here — adopt the FactorSage account behind it.

`apps/api/src/auth/google/google-email-authority.ts` is the one place that decision is made. It is
pure, so sign-in and its tests cannot disagree, and it classifies a verified address as:

- `GOOGLE_MAILBOX` — `gmail.com` or `googlemail.com`. Google is the mail provider, so holding the
  Google account and holding the mailbox are the same thing.
- `WORKSPACE_DOMAIN` — the `hd` claim equals the address's own domain. `hd` is the only claim in
  the token that says an organization proved domain ownership to Google.
- `EXTERNAL` — verified at Google, on a domain somebody else runs.

`hd` is required to *equal* the address's domain. A Workspace whose primary domain differs from
the address's domain proved ownership of the former only, and nothing in the token distinguishes a
legitimately verified secondary domain from an unrelated one. The deliberate consequence: a
multi-domain Workspace user whose address is at a secondary domain is not auto-linked and signs in
with their password instead.

### Identity resolution

1. A known `(GOOGLE, sub)` returns its existing user. Repeat sign-in creates nothing, and the
   email claim decides nothing — the subject is the identity.
2. Otherwise the provider email must be present and reported verified. An unverified or missing
   provider email is refused outright, whatever domain it is in.
3. **No FactorSage account holds the address** — a new verified user is created with no local
   password. There is nothing to take over, so a verified address of any authority is enough.
   This is deliberately the weaker bar.
4. **A FactorSage account already holds the address** — it is adopted (a new `OAuthAccount`,
   `emailVerifiedAt` set, any pending local verification token removed) **only** when the
   authority is `GOOGLE_MAILBOX` or `WORKSPACE_DOMAIN`. An `EXTERNAL` address is refused with
   `oauth_link_not_allowed` and nothing is written: not the link, not the password, not the plan.
   The owner signs in with their password as before.

Resolution retries exactly once on a `P2002` uniqueness collision. Two callbacks for the same
brand-new identity can both find nothing and both try to write it; PostgreSQL decides, and the
loser resolves again and finds the row the winner wrote. The retry is bounded at one because the
second pass reads state that already exists.

Success issues the same HttpOnly session cookie as password login and redirects to
`WEB_BASE_URL/dashboard`. Every failure redirects to `WEB_BASE_URL/login?error=<code>` using the
stable `OAUTH_ERROR_CODES` contract and sets no session cookie. Provider detail never reaches the
browser.

Google is optional. With all three `GOOGLE_*` variables unset the provider is simply not offered;
partial configuration is rejected by centralized configuration at startup.

## Browser authentication

The API signs a short-lived HS256 JWT containing only the user ID. The JWT is stored only in the
`intrinsic_auth` HttpOnly cookie; browser JavaScript does not read it and auth is never stored in
`localStorage` or `sessionStorage`.

Cookie defaults:

- `HttpOnly`
- `SameSite=Lax`
- `Secure` in production and disabled for local HTTP development
- path `/`
- eight-hour expiration, configurable with `AUTH_TOKEN_TTL_SECONDS`

The JWT secret comes from centralized configuration and must contain at least 32 characters.
Local web-to-API requests use credentials and the API explicitly enables credentialed CORS only
for configured origins.

### What a session is, and what ends it

A session is exactly the signed cookie. The API keeps no server-side session record: every
request revalidates the token's signature and expiry, then **reloads `role` and `plan` from
PostgreSQL**, which is what lets the entitlement resolver read persisted state rather than
anything a client asserted. Deleting the user makes the next request `401`, because the reload
finds nothing.

`POST /auth/logout` clears the cookie and returns `204`. That ends the session in *that browser*.
It does not and cannot invalidate the token itself: a copy of the cookie captured beforehand stays
valid until it expires. The same limitation is why a password reset does not end other sessions.
Both follow from the stateless model and both are listed under production hardening below.

## API surface

- `GET /auth/providers`: non-secret capability probe (`{ google: boolean }`) so the UI only offers
  providers this deployment configured.
- `POST /auth/register`: creates an unverified local user and sends a verification link.
- `POST /auth/verify-email`: redeems a token once.
- `POST /auth/resend-verification`: rotates and resends; always `202`.
- `POST /auth/login`: validates and normalizes credentials, returns a safe `AuthUser`, and sets the
  auth cookie. Missing users, incorrect passwords, and users without a local password all receive
  the same generic `401`. Correct credentials on an unverified account receive `403` with
  `EMAIL_NOT_VERIFIED_CODE`, which reveals nothing the caller does not already know and lets the UI
  offer a resend.
- `POST /auth/forgot-password`: requests a reset link; always `202`.
- `POST /auth/reset-password`: redeems a reset token once and installs the new password.
- `GET /auth/me`: requires the cookie guard and returns the current safe `AuthUser`.
- `POST /auth/logout`: clears the auth cookie and returns `204`.
- `GET /auth/google`, `GET /auth/google/callback`: the Google flow described above.
- `GET /admin/health`: proves ADMIN authorization (`401` anonymous, `403` USER, `200` ADMIN).

`CookieAuthGuard` validates the token and reloads the user from PostgreSQL, then exposes the safe
user context through `CurrentUser`. `Roles` metadata and `RolesGuard` provide the intentionally
small role layer. API authorization is authoritative; frontend state is only presentation logic.

`OptionalCookieAuthGuard` is its companion for routes whose answer differs for a signed-out
visitor rather than being refused to one. It resolves the session when there is a usable cookie,
admits the request either way, and creates nothing — an invalid or expired token is the signed-out
state, not an error. `GET /entitlements` is the only route using it today.

## Password recovery

`POST /auth/forgot-password` **always** answers `202` with the same body. An unknown address, an
account that signs in with Google and has no local password, and an account that really was mailed
a link are indistinguishable from outside, so the endpoint cannot be used to discover who has an
account or how they sign in. An account with no local password is a deliberate silent no-op:
minting a password for it would add a credential its owner never asked for. A mail-transport
failure is also silent — only an address with a local account ever reaches the transport, so
failing the response there would answer the exact question the endpoint refuses to answer. The
failure is loud in the logs instead.

Reset tokens are the verification token's rules, applied to a stronger credential:

- 256 bits of cryptographic randomness, encoded base64url
- only the SHA-256 hash is persisted; the plaintext exists solely inside the outbound email
- expire after `AUTH_PASSWORD_RESET_TTL_SECONDS` (default one hour — much shorter than a
  verification link, because a reset link is a live credential for an account that already exists)
- single-use, and one outstanding token per user, so requesting a new link invalidates the
  previous one
- redemption consumes the token and writes the new password inside **one** transaction, so the
  two cannot come apart and only the request that actually removed the row succeeds

`POST /auth/reset-password` applies the same password policy as registration — an old password
that predates a policy change still authenticates, but a newly chosen one must satisfy today's
rules — and hashes with the same Argon2id `PasswordService`.

Redemption runs cheap-first:

1. SHA-256 the submitted token and look it up on the unique `tokenHash` index.
2. If no unexpired row matches, reject. An expired row is cleared on the way out — expiry is the
   one verdict that needs no transaction, because an expired token can never become valid again.
3. Only then compute the Argon2id hash, which happens outside the transaction because Argon2id is
   deliberately slow and a transaction must not be held open across it.
4. Redeem inside the transaction, which re-reads the row and re-checks everything step 1 checked.

Step 1 exists because the endpoint is unauthenticated and generic rate limiting is deliberately
deferred: hashing first would let anyone spend the API's CPU one full Argon2id at a time by posting
invented tokens, without ever having to guess a real one. **It is a filter, never an
authorization.** Between step 1 and step 4 the token can expire, be rotated by a new request, or be
consumed by a concurrent redemption, so the transaction repeats every check and remains the single
source of truth. A hash computed for a token that is taken in the meantime is simply discarded, and
both rejection paths return the same `401` with the same message — the caller learns only that this
token did not work, which is what the endpoint tells them anyway.

Redeeming also marks the address verified if it was not already, and drops any pending
verification token: holding the reset link proves exactly what a verification link proves. Without
that, an account that never verified could reset its password and still be unable to sign in. An
already-verified account keeps its original `emailVerifiedAt` — a reset is not a second
verification event. Nothing else changes: not the role, not the plan, not a linked Google account.

The link points at `WEB_BASE_URL/reset-password?token=...`. The web pages are `/forgot-password`
and `/reset-password`, built from the same `AuthCard` and form styles as Login, Register and
Verify Email, and reachable from a **Forgot your password?** link on the sign-in form.

**A reset does not end existing sessions.** The session token is a stateless JWT that the API
validates by signature and expiry, so there is nothing to revoke short of a session-version column
or a server-side session store, and either one is a larger change than this feature justifies.
Until then, an attacker who already holds a live session cookie keeps it for up to
`AUTH_TOKEN_TTL_SECONDS` after the victim resets. This is the top production-hardening item below.

## Configuration and secrets

All auth, Google, and SMTP configuration is parsed and validated in `packages/config/src/index.ts`.
Auth, email, and Google business code never reads `process.env`. `getWebPublicConfig()` exposes no
server secret.

Outbound email goes through an `EmailSender` port. The SMTP transport is the production
implementation; deterministic tests replace the port entirely, so no automated test can send real
mail. With no SMTP configured the API still boots and reports the verification email as
undeliverable rather than pretending it was sent.

## Observability

Auth emits stable structured events — `auth.login.succeeded`, `auth.login.failed`,
`auth.register.completed`, `auth.email.verification.sent`, `auth.email.verification.completed`,
`auth.google.callback.completed`, `auth.google.account.linked`,
`auth.google.account.link.refused`, `auth.google.user.created`,
`auth.password.reset.requested`, `auth.password.reset.completed`, and their failure counterparts.
The Google events carry the resolved `emailAuthority`, so an operator can see *why* a link was
allowed or refused without re-deriving it. Correlation uses the internal `actorUserId` once identity is
established; email is not used as a correlation key. Tokens, passwords, cookies, JWTs, SMTP
credentials, Google secrets, reset tokens, and reset-token hashes are never logged.

## Bootstrap admin and QA personas

`pnpm db:seed` requires `ADMIN_EMAIL` and `ADMIN_PASSWORD`. It normalizes the email, hashes the
password with Argon2id, and upserts only that account as a verified `ADMIN`. It has no default
credentials and is safe to rerun without creating duplicates.

`pnpm test:users:seed` creates or updates exactly the two persistent QA personas from the `QA_*`
environment variables, and refuses to run when `NODE_ENV=production` because the `QA_ADMIN`
persona is a real administrator account. See
[`../workflows/auth-testing.md`](../workflows/auth-testing.md).

## Intentionally deferred, and what production still needs

Nothing below is an oversight. Each is a known gap with a known cost, listed so the decision to
ship without it stays visible.

### Must do before public production

1. **Session invalidation.** The session token is a stateless JWT, so logout is browser-local and
   a password reset does not end other sessions. An attacker holding a captured cookie keeps
   access for up to `AUTH_TOKEN_TTL_SECONDS`. The smallest honest fix is a `sessionVersion`
   integer on `User`, carried as a JWT claim and compared during the guard's existing reload —
   the reload already happens, so this costs no extra query. Bumping it on password reset, and on
   an explicit "sign out everywhere", makes both revocations real.
2. **Rate limiting.** Deliberately out of scope here and handled as one cross-application
   production-hardening concern, not as an auth-local control and never as an entitlement
   (`AGENTS.md` invariant 17). Until it exists, `/auth/login`, `/auth/register`,
   `/auth/forgot-password`, `/auth/resend-verification` and `/auth/reset-password` accept
   unlimited attempts from one source. Login is the credential-stuffing target; the two mail
   endpoints can be used to send mail to an address repeatedly.
3. **Registration is an enumeration oracle.** `POST /auth/register` answers `409` for an address
   that already exists, so anyone can test whether an address has an account. Recovery, resend and
   login are all careful not to leak this; registration undoes that. Closing it means answering
   `202` and mailing "someone tried to register with your address" instead, which changes the
   registration UX and is a product decision, not a code change.

### Should do soon

4. **Sign-in-transaction cookie integrity.** The OAuth transaction cookie is HttpOnly but not
   authenticated. Anyone who can set a cookie on the victim's browser — a compromised sibling
   subdomain, or plain HTTP in a non-production deployment — can plant their own transaction and
   complete a login-CSRF: the victim ends up signed in to the *attacker's* account. Signing the
   cookie, or scoping it with a `__Host-` prefix, closes it.
5. **Timing side channel on recovery and resend.** Both endpoints return one response, but an
   address with an account performs an SMTP round trip and an address without one does not, so
   elapsed time still distinguishes them. Sending mail out of band removes the difference.
6. **Argon2id parameters are the library defaults.** They should be pinned explicitly and chosen
   against the production instance's memory budget, and `PasswordService` should rehash on login
   when the stored parameters are below the current policy.
7. **No account-linking surface.** A user whose Google address is `EXTERNAL` has no way to link
   the two identities at all — the refusal is correct, but the only remedy is signing in with a
   password. An authenticated "connect Google" action in account settings is the missing half.

### Optional later

8. CAPTCHA on registration and recovery.
9. MFA or passkeys.
10. Refresh-token rotation, which only becomes meaningful once sessions are revocable.
11. A full server-side session store, listing active sessions and revoking one.
12. A second identity provider.

Not deferred because they are already true: PKCE is S256-only, state and nonce are both checked in
constant time, ID tokens are only ever read after `verifyIdToken`, provider access and refresh
tokens are never persisted, and no password, token, cookie, JWT or secret is ever logged.
