# Authentication Architecture

## Identity model

`User` is the product identity. It contains only:

- UUID `id`
- normalized unique `email`
- nullable `passwordHash`
- `USER` or `ADMIN` role
- creation and update timestamps

Emails are trimmed and lowercased before lookup or storage. PostgreSQL enforces uniqueness.
Passwords are hashed with Argon2id and plaintext credentials are never persisted or logged.
`passwordHash` never appears in API contracts or responses.

`passwordHash` is intentionally nullable so a future external-identity-only user can exist:

```text
local password ----\
                    -> User
Google OAuth -------/  (future)
```

Google OAuth, provider records, callbacks, and account linking are intentionally deferred. There
is no `OAuthAccount` model in this slice.

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

- `POST /auth/login`: validates and normalizes credentials, returns a safe `AuthUser`, and sets the
  auth cookie. Missing users, incorrect passwords, and users without a local password all receive
  the same generic `401` failure.
- `GET /auth/me`: requires the cookie guard and returns the current safe `AuthUser`.
- `POST /auth/logout`: clears the auth cookie and returns `204`.
- `GET /admin/health`: proves ADMIN authorization (`401` anonymous, `403` USER, `200` ADMIN).

`CookieAuthGuard` validates the token and reloads the user from PostgreSQL, then exposes the safe
user context through `CurrentUser`. `Roles` metadata and `RolesGuard` provide the intentionally
small role layer. API authorization is authoritative; frontend state is only presentation logic.

Future ADMIN endpoints, including a future Security sync endpoint, must reuse the existing cookie
auth and role guards. Security sync is not implemented.

## Bootstrap admin

`pnpm db:seed` requires `ADMIN_EMAIL` and `ADMIN_PASSWORD`. It normalizes the email, hashes the
password with Argon2id, and upserts only that account as `ADMIN`. It has no default credentials and
is safe to rerun without creating duplicates.
