# Authentication Architecture

The Nest API is the authentication authority for V2. It owns credentials, sessions, email
verification, and the Google OpenID Connect exchange. The web application holds no authentication
authority; its auth state is presentation logic only. V2 does not use NextAuth and does not use
Pages Router.

For running auth tests, seeding QA personas, and Playwright, see
[`../workflows/auth-testing.md`](../workflows/auth-testing.md).

## Identity model

`User` is the product identity:

- UUID `id`
- normalized unique `email`
- nullable `passwordHash`
- nullable `emailVerifiedAt`
- `USER` or `ADMIN` role
- creation and update timestamps

Emails are trimmed and lowercased before lookup or storage. PostgreSQL enforces uniqueness.
Passwords are hashed with Argon2id and plaintext credentials are never persisted or logged.
`passwordHash` never appears in API contracts or responses.

Two satellite models complete the identity picture:

- `OAuthAccount` — `(provider, providerAccountId)` unique, related to `User`, with
  `OAuthProvider = GOOGLE`. FactorSage uses external providers for identity only, so provider
  access and refresh tokens are deliberately never persisted.
- `EmailVerificationToken` — one row per user (`userId` unique), storing only the SHA-256
  `tokenHash` plus `expiresAt`.

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

Identity resolution:

1. A known `(GOOGLE, sub)` returns its existing user. Repeat sign-in creates nothing.
2. Otherwise the provider email must be present and reported verified. An unverified or missing
   provider email is refused outright.
3. A matching FactorSage email is linked — a new `OAuthAccount`, `emailVerifiedAt` set, and any
   pending local verification token removed. Linking is never "dangerous": it happens only because
   Google itself vouched for the address.
4. Otherwise a new verified user is created with no local password.

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
- `GET /auth/me`: requires the cookie guard and returns the current safe `AuthUser`.
- `POST /auth/logout`: clears the auth cookie and returns `204`.
- `GET /auth/google`, `GET /auth/google/callback`: the Google flow described above.
- `GET /admin/health`: proves ADMIN authorization (`401` anonymous, `403` USER, `200` ADMIN).

`CookieAuthGuard` validates the token and reloads the user from PostgreSQL, then exposes the safe
user context through `CurrentUser`. `Roles` metadata and `RolesGuard` provide the intentionally
small role layer. API authorization is authoritative; frontend state is only presentation logic.

Forgot/reset password is not implemented.

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
`auth.google.callback.completed`, `auth.google.account.linked`, `auth.google.user.created`, and
their failure counterparts. Correlation uses the internal `actorUserId` once identity is
established; email is not used as a correlation key. Tokens, passwords, cookies, JWTs, SMTP
credentials, and Google secrets are never logged.

## Bootstrap admin and QA personas

`pnpm db:seed` requires `ADMIN_EMAIL` and `ADMIN_PASSWORD`. It normalizes the email, hashes the
password with Argon2id, and upserts only that account as a verified `ADMIN`. It has no default
credentials and is safe to rerun without creating duplicates.

`pnpm test:users:seed` creates or updates exactly the two persistent QA personas from the `QA_*`
environment variables. See [`../workflows/auth-testing.md`](../workflows/auth-testing.md).
