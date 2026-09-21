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

A local password only ever becomes usable when it was chosen by someone who proved control of the
mailbox — by redeeming a verification link or a reset link. See *Local registration and email
verification* for why (AUTH-002).

There is no magic-link sign-in, no MFA, no passkey and no second external provider.

## Identity model

`User` is the product identity:

- UUID `id`
- normalized unique `email`
- nullable `passwordHash`
- nullable `emailVerifiedAt`
- `USER` or `ADMIN` role
- `FREE`, `STARTER` or `PRO` commercial plan
- `sessionVersion`, a non-null integer (default `0`) that every session token must match — see
  *What a session is, and what ends it*
- `registrationEmailClaimedAt`, nullable: when registration or resend last claimed the right to
  email this account — the per-address cooldown of *Email-first registration (AUTH-003)*
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

The model represents these identity states:

```text
local password only      passwordHash set,  no OAuthAccount
Google only              passwordHash null, one OAuthAccount
both                     passwordHash set,  one OAuthAccount
pending (unverified)     passwordHash null, emailVerifiedAt null   (AUTH-003: registration sets no password)
legacy pending           passwordHash set,  emailVerifiedAt null   (registered before AUTH-003 — inert, never activated)
```

## Local registration and email verification

Registration is **email-first** (AUTH-003). `POST /auth/register` takes an address and nothing
else, answers the same `202 { "status": "accepted" }` for every well-formed address, and never
establishes a password. The emailed activation link opens `/verify-email`, where the holder of the
mailbox chooses the account's first password (AUTH-002). Registration never signs anybody in.

### Email-first registration (AUTH-003)

> For every syntactically valid address, `POST /auth/register` gives the same status, body and
> headers, sets no cookie, and changes nothing about an existing account's credentials, verification,
> sessions, role, plan or linked identities. Only the holder of an emailed activation link ever sets
> an account's first password.

**The enumeration this closes.** Before AUTH-003 registration took `{ email, password }`, answered
`201 { "status": "verification_sent" }` for a new address and `409 "An account with this email
already exists"` for **any** existing row — pending, verified, Google-only or linked — so anyone
could test whether an address had an account. It stored the registrant's password on the unverified
row (made inert by AUTH-002, but still a credential nobody proved), sent the email inside the
request (a transport failure answered `503`, and only addresses that reached the transport paid for
an SMTP round trip), and had no per-address bound: each request to a new address sent a message, and
`resend-verification` rotated and re-mailed a pending account's link on every call.

**The contract now.** The request is `{ email }`. Any other field — a `password` from a client built
before AUTH-003, a `role`, a `plan` — is ignored and never read, logged or stored. A malformed
address is still `400`. Every well-formed address gets `202 { "status": "accepted" }`, no
`Set-Cookie`, and the same rate-limit headers; nothing in the response describes the account or
whether mail was sent.

**What happens behind the one answer:**

| State of the address                   | Written by the request                                        | Email, after the response                  |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| No account                             | one pending user: no password, unverified, claim set          | activation link                            |
| Pending (unverified)                   | the claim; an inert pre-AUTH-003 `passwordHash` is cleared     | a fresh activation link (rotates the old)  |
| Verified password, Google-only, or both | the claim only                                                | neutral "you already have an account" notice — no token, no link that changes anything |
| Any of these inside the cooldown       | nothing                                                       | none; no token is issued or rotated        |

`POST /auth/resend-verification` is the same operation without the first and third rows: an
unknown or verified address is a silent no-op, and a pending one is re-mailed under the same claim
and cooldown. The two endpoints share one implementation (`RegistrationService.requestActivation`).

**The existing-account notice** tells the mailbox owner that someone asked to create an account with
their address, that nothing changed, and how to sign in: a sign-in link, plus a recovery link when
the account has a password, or a "signs in with Google" line when it has a Google identity. It
carries no token and no account detail beyond that, and only the mailbox owner reads it.

**Per-address cooldown.** `User.registrationEmailClaimedAt` records when an email to the account
was last claimed. A request takes the claim with **one conditional `UPDATE`** that carries the value
it read (the `rotating-token.ts` idiom) and the state it decided on (`emailVerifiedAt IS NULL` or
not), and only when that value is older than `REGISTRATION_EMAIL_COOLDOWN_SECONDS` (five minutes).
So of any number of concurrent requests for one address exactly one sees a count of one and sends;
the rest send nothing. A new address's row is **created already claimed**, so a request that loses
the unique-index race reads a row that is cooling down.

- The cooldown bounds what anyone can make FactorSage send to one address — one message per window
  whoever asks and from however many IPs — on top of the per-IP `auth-sensitive` bucket.
- It never refuses a request, and a suppressed request writes, issues and rotates nothing, so the
  link already in the inbox stays valid.
- It is keyed by the account row. Nothing derived from the address is stored, logged or sent to
  Redis, and it is not a rate-limit counter: `AGENTS.md` invariant 19's rule that no counter is keyed
  by a submitted address is untouched, because nothing here decides whether a request is allowed.
- It is independent of account state: every row of the table above is suppressed alike.

**Out-of-band delivery.** The request path only reads, creates or claims. Issuing the token and
talking to the transport run afterwards on `BackgroundEmailDispatcher`, a tracked in-process task
set that `app.close()` and shutdown drain. The transport's latency and failures therefore never
reach the response, and no transaction is ever open across a send. The residual timing difference
between states is a database round trip or two (an insert for a new address, an `UPDATE` for a
claim, none inside the cooldown), not an SMTP exchange.

**Failure.** A send that fails is logged with the original error (`auth.email.verification.send.failed`
or `auth.email.account_notice.send.failed`) and **gives the claim back** — the column is restored to
its previous value, conditionally on still holding this claim — so the owner's next request sends at
once instead of waiting out a cooldown for a message that never left. The same happens if the task
fails before reaching the transport (a database error while issuing). A new account is therefore
never stranded: it is a pending row whose owner can simply ask again. What a failure cannot undo is
the rotation of a pending account's previous link, which happened when the token was issued; the
retry mails a new one.

**Concurrency.**

- *Simultaneous registrations of one new address* (including case and whitespace variants, which
  are normalized before anything else): the unique index on `email` lets one `INSERT` win;
  `createPendingUser` turns the loser's `P2002` into a re-read, and the re-read row is already
  claimed. One user, one token, one message, and every request gets the same `202` — never a `500`.
- *Registration racing verification*: the pending claim is conditional on `emailVerifiedAt IS NULL`
  and is evaluated on the row the verification transaction locks, so a verification that commits
  first makes the claim miss. A claim that commits first clears only an inert hash, and the
  verification then installs the owner's password. If the claim won but the owner's link was
  redeemed before the background task issued, the task re-checks the account after issuing and
  **withdraws its own token** (`discardIssuedToken`, conditional on the hash) instead of mailing
  it. Either the account ends verified with the owner's password and no verification token, or it
  ends pending with exactly one live link — the one just mailed.
- *Registration racing Google*: a Google link or first sign-in verifies the account inside its own
  transaction and deletes verification tokens; the claim then misses, or the background task's
  re-check withdraws its token, and a token issued before the link is deleted by it. A registration
  that loses the create race to a Google sign-in reads a verified row and sends the notice. No
  password or OAuth row is ever written by registration.

**Old rows.** No destructive migration. A pending row registered before AUTH-003 may still carry an
inert `passwordHash`: it never authenticates (login refuses every unverified account with the
generic `401`), nothing needs it, verification replaces it, and the first claimed register or resend
for that address clears it. The new column starts `NULL` everywhere, so the first request after the
deploy for any account may send one email and the cooldown applies from then on. Verified accounts
are untouched.

**Residual risks.**

- **Accepted residual risk — the existing-account notice** (decided 2026-09-18 by the product
  owner, for the current release; recorded under AUTH-003 / DEC-004 in the remediation plan):
  - an unauthenticated caller can make FactorSage send the neutral existing-account notice to the
    owner of a verified account;
  - at most one email per address per five-minute cooldown window, plus the per-IP
    `auth-sensitive` rate limit;
  - the email carries no verification token, password, session information or account data;
  - the public response stays the same generic `202`, so account enumeration is not reopened;
  - the risk is operational — nuisance email, mail-provider quota and cost, sender reputation —
    and is **not** an account-takeover or credential-disclosure vulnerability.
  Recommended follow-up, not implemented, before registration traffic becomes material:
  - make registration for a verified account a silent no-op (no notice);
  - lengthen the cooldown;
  - add CAPTCHA or risk-based abuse protection in front of registration.
- The same one-email-per-window bound applies to activation links for new and pending addresses;
  CAPTCHA remains optional-later item 8.
- Pending rows accumulate for addresses nobody activates; the per-IP bucket bounds the rate, and a
  cleanup of old never-activated rows is future work.
- An in-process task is lost if the process dies between the claim and the send; the claim then
  expires with the cooldown and the owner asks again.
- A few database round trips still differ between states; that is not an SMTP-sized signal, and no
  test asserts wall-clock timing.
- A client built before AUTH-003 still posts a password; it is ignored, and the email that follows
  asks the holder to choose one.

**Manual live-email verification — not executed in the AUTH-003 PR.** Deliberately deferred to
preserve the Mailtrap sandbox quota; every automated test uses `InMemoryEmailSender` and no real
message was sent while implementing it. The owner's steps are in
[`../workflows/auth-testing.md`](../workflows/auth-testing.md), *Registration enumeration check
(AUTH-003)*.

### The rule: verification sets the password (AUTH-002)

> Possession or redemption of an email-verification link never activates a password that was
> selected before control of the mailbox was proven.

**The vulnerable sequence this closes.** Before AUTH-002, verification only set `emailVerifiedAt`:

1. an attacker registers `victim@example.com` with a password of their choosing;
2. the account is stored unverified with the attacker's password hash;
3. the verification email goes to the real mailbox owner, who clicks it;
4. the account becomes verified **with the attacker's password still on it**;
5. the attacker signs in as the victim.

PR #44 (AUTH-001) closed the same pre-account takeover on the Google-linking path; this closes it
on the direct verification path.

**The flow now.**

1. Since AUTH-003 registration takes no password at all. A row registered before it may still
   carry the registrant's hash; that hash is **never** activated: login refuses every unverified
   account with the generic `401`, and every path that verifies an address replaces or removes it
   in the same transaction — verification installs the password its redeemer chooses, a reset
   installs the reset password, and Google adoption clears it (AUTH-001). A claimed register or
   resend clears it too.
2. The emailed link opens `/verify-email?token=…`. Opening it redeems nothing: the page asks for
   **New password** and **Confirm password**.
3. The browser posts `POST /auth/verify-email` with `{ token, password }` in the JSON body. The
   password never appears in a URL. The request is parsed with the registration password policy;
   a request without a password (the pre-AUTH-002 shape) is a `400` and redeems nothing.
4. Redemption runs cheap-first, exactly like a reset (see *Password recovery*): an indexed
   SHA-256 lookup refuses unknown and expired tokens before any Argon2id work; only then is the new
   password hashed, outside any transaction.
5. **One transaction** (`EmailVerificationService.redeemToken`) then:
   - re-reads the token and re-checks its expiry;
   - consumes exactly that token (`consumeRotatingToken`, the concurrency gate below);
   - installs the new `passwordHash` and increments `sessionVersion` in one `UPDATE`;
   - sets `emailVerifiedAt` with a conditional `updateMany … where emailVerifiedAt is null`,
     evaluated on the row the previous statement locked, so an already-verified account keeps its
     original instant;
   - deletes any outstanding `PasswordResetToken`, which was issued against the credential being
     replaced.

   Any failure rolls all of it back: the token is still redeemable, the account is unverified with
   its previous hash and version, and the reset link is still present.
6. The response is `{ "status": "verified" }` and issues **no session**. The page offers
   **Continue to sign in** (`/login`); the owner signs in with the password they just chose. A
   pre-AUTH-003 registration password fails with the ordinary generic `401`.

**Tokens.**

- 256 bits of cryptographic randomness, encoded base64url
- only the SHA-256 hash is persisted; the plaintext exists solely inside the outbound email
- expire after `AUTH_EMAIL_VERIFICATION_TTL_SECONDS`
- single-use: only the request whose delete removed **this exact token** installs a password —
  see *Rotation and concurrency* below. Two concurrent redemptions of one link with different
  passwords produce exactly one `200` and one `401`; the account ends on the winner's password
  with exactly one `sessionVersion` increment.
- unknown, expired, already-used and superseded tokens all answer the same `401` with the same
  message and change nothing on the account (an expired row is cleared, as before); a malformed
  request (empty or over-long token, missing or
  policy-violating password) is a `400` before any token is looked at
- one outstanding token per user, so `POST /auth/resend-verification` rotates and invalidates the
  previous link; a resent link goes through exactly the same flow

**Session version.** Verification increments `sessionVersion` because it installs a credential,
for the same reason a reset does. For a never-verified account this revokes nothing — login refuses
unverified accounts, so no session was ever issued (0 → 1, no legacy token exists). It matters for
a state that is reachable: `resend-verification` decides eligibility on a read taken before it
issues, so a resend racing the redemption of the previous link can leave a live link on an account
that is by then verified and signed in. Redeeming that link sets a new password, and every session
issued before it gets the generic `401`, exactly as after a reset. A refused redemption revokes
nothing.

**Why registration no longer stores a hash.** AUTH-002 left the registration hash in place because
removing it changed the contract; AUTH-003 was that contract change. With registration email-first
there is no registration password to store, the `403 EMAIL_NOT_VERIFIED` hint it enabled is gone
(it told a caller that a pending account existed), and the invariant above now holds at the source
as well as at verification.

**Residual limitations.**

- A victim who opens an unsolicited link and completes the form gains an account in their own name
  with their own password; that is the intended outcome, not a takeover. A victim who ignores it
  leaves an unverified row the attacker cannot use.
- Anyone can still register someone else's address and cause an activation email to be sent — at
  most one per address per cooldown window since AUTH-003, with a response that reveals nothing.
- A client (or tab) built before AUTH-002 posts `{ token }` only and receives a `400`; its link is
  unspent and works once the page is reloaded on the new build.

`POST /auth/resend-verification` always answers `202`. Unknown addresses, already-verified
accounts, and external-only accounts are silent no-ops so the endpoint cannot enumerate accounts. A
pending account shares registration's claim and cooldown (AUTH-003).

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

   **Adopting an account nobody verified discards its password.** Anyone can register an address
   they do not control, so the password on a never-verified row proves nothing about the mailbox
   owner; keeping it would let whoever registered first sign in to the account Google just handed
   to its owner (a pre-account takeover). When the row's `emailVerifiedAt` is null *at the moment
   of linking*, the link's transaction also sets `passwordHash` to null and deletes any
   `PasswordResetToken`, leaving a verified Google-only account. That condition is evaluated by
   the conditional update inside the transaction, never from the earlier read, so a verification
   redeemed first keeps the password, and any failure rolls the whole adoption back. An
   already-verified account keeps its password: its owner proved control of both. Recovery skips
   accounts without a password, so the result stays Google-only; there is no set-password flow.

Resolution retries exactly once on a `P2002` uniqueness collision. Two callbacks for the same
brand-new identity can both find nothing and both try to write it; PostgreSQL decides, and the
loser resolves again and finds the row the winner wrote. The retry is bounded at one because the
second pass reads state that already exists.

Success issues the same HttpOnly session cookie as password login and redirects to
`WEB_BASE_URL` followed by the validated return path the flow started with, or `/` — the
Dashboard's canonical route (see _Return destination after sign-in_). Every failure redirects to
`WEB_BASE_URL/login?error=<code>` using the stable `OAUTH_ERROR_CODES` contract and sets no session
cookie. Provider detail never
reaches the browser.

### Return destination after sign-in (UX-003)

A Guest asked to sign in from a page — a built-in strategy's "Backtest this strategy", a plan button
on the public `/pricing` page (PRICING-001), or a bounce from a protected URL such as
`/backtests/new?strategyId=…` — returns to that page afterwards. The
destination travels as `?next=<path+query>`:

```text
SignInPrompt / RequireAuth ── /login?next=… ──┬─ password: LoginForm → router.replace(next)
                              /register?next=… ┘  Google:   GET /auth/google?next=… → cookie
                                                            → callback → WEB_BASE_URL + next
```

**Threat model.** `next` is attacker-controlled — anyone can send a victim
`/login?next=//evil.example` — and it ends in a browser navigation after a successful sign-in, and
for Google in a `302 Location` from the API. Unvalidated, that is an open redirect straight out of a
trusted sign-in, the classic phishing hand-off. So `next` is only ever an **app-relative path**,
decided by `safeReturnPath` — a pure function implemented twice, once per trust boundary, neither
trusting the other: `apps/web/src/features/auth/utils/return-path.ts` (before the browser
navigates) and `apps/api/src/auth/return-path.ts` (before the API redirects). One corpus,
`@intrinsic/testing/return-path-corpus`, drives both test suites so they cannot drift.

A value is accepted only when it is a string of 1–2048 characters that starts with exactly one `/`,
contains no backslash and no control character (C0, DEL, C1), and still satisfies all of that after
each of up to three rounds of percent-decoding (so `/%2F%2Fevil`, `/%5Cevil` and double-encoded
forms are refused, as are malformed escapes), and a real URL parser resolves it to the same origin.
Anything else — absent, empty, repeated, `//host`, `/\host`, `https:`, `javascript:`, CR/LF, tab,
over-length — is `/`, the Dashboard's canonical route. An accepted value is used verbatim,
never re-encoded.

- **Password sign-in.** `LoginPanel` validates `next`; `LoginForm` validates it again and
  `router.replace`s to it on success. A refused sign-in navigates nowhere.
- **Google.** `GET /auth/google?next=…` validates `next` itself and stores it as a fourth element
  of the OAuth transaction cookie only when it is not the default; nothing about it is sent to
  Google. The callback validates the stored value **again** before redirecting, because that cookie
  is not signed (item 4 below): a tampered cookie can at worst choose another page of the app, and
  the redirect is always `WEB_BASE_URL` + a validated path. State, PKCE, nonce, single-use
  clearing and every failure redirect are unchanged; a transaction cookie written before this
  field existed (three elements) still completes, to `/`.
- **Registration.** The register page keeps `next` on its links back to sign-in and to Google, so
  a same-tab sign-in returns correctly. It is **not** put into the activation email: verification
  only activates the account and sets its password (AUTH-002/003); carrying a destination through
  email is a separate follow-up.
- **Every entry point uses the helpers (UI-042).** `signInHref`, `registerHref` and
  `forgotPasswordHref` (`features/auth/utils/guest-routes.ts`) build every sign-in link: the
  topbar's "Sign in" carries the current pathname (the pathname, not `window.location`, so the link
  is identical on the server and the client), sign-in prompts carry the intended href — for "Run
  backtest" that is the prefilled `/backtests/new?…` — and the forgot-password detour keeps `next`
  so "Back to sign in" still returns there. Links out of an emailed verify/reset page carry no
  destination, because the email never did.
- **Already signed in (UI-040).** `/login` and `/register` read the session once
  (`useRedirectIfSignedIn`) and send a signed-in visitor to the validated `next`, or the
  Dashboard, instead of showing a second sign-in form. The form renders meanwhile, so a Guest never
  waits; the Guest's `401` from `/auth/me` is the expected probe answer, not an error.
- **Empty sign-in (UI-041).** An empty email or password is answered beside the field and focuses
  it; no request is sent, so it can never come back as "those credentials".
- **What is not covered.** The post-sign-out redirect does not carry a destination. `next` is not
  restricted to known route prefixes: an unknown app path lands on the not-found page, which is
  harmless.

Google is optional. With all three `GOOGLE_*` variables unset the provider is simply not offered;
partial configuration is rejected by centralized configuration at startup.

## Browser authentication

The API signs a short-lived HS256 JWT containing only the user ID and the account's session
version (`sv`). The JWT is stored only in the
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

### Rotation and concurrency

`EmailVerificationToken` and `PasswordResetToken` are the same lifecycle — a random plaintext
token mailed to its owner, only the SHA-256 hash persisted, at most one outstanding token per
user, issuance rotating the previous one away, an expiry, a single-use redemption — and they share
one implementation of the concurrency rules, in `apps/api/src/auth/rotating-token.ts`. Keeping
them in one place is deliberate: two subtly different answers to the same question is how one of
them ends up wrong.

Issuance upserts by `userId`, so rotating a token **reuses the same row**: same `id`, new
`tokenHash`, new `expiresAt`. Anything that acts on a row it read earlier is therefore acting on
an identity that may already belong to a different token, and addressing that row by `id` alone
would silently hit whatever now lives there. Being inside `$transaction` does not help: at
PostgreSQL's READ COMMITTED default a statement re-reads the rows it writes, so a `DELETE` issued
after a concurrent rotation committed finds and deletes the *new* row — and reports a count of one
for it.

So the rule is: **the earlier `SELECT` is never authoritative, and every state-changing statement
carries the identity it intends to act on** (`id` + `tokenHash`, plus the expiry predicate that
belongs there). The consuming delete is the concurrency gate:

- exactly one row deleted — this request consumed *this* token, and may perform the effect the
  token authorizes: set the password (and, for either token, mark the address verified);
- zero rows — the token was already consumed by a concurrent redemption, rotated away by a newer
  link, or expired since it was read. Reject, and perform no effect.

That last case is what makes rotation mean what it says. A resend or a second forgot-password
request invalidates the previous link, so honouring the previous link afterwards — because the row
id still matched — would have defeated the rotation the user asked for.

### What a session is, and what ends it

A session is exactly the signed cookie. The API keeps **no server-side session registry** — no
session table, no Redis entry, no refresh token. What makes a session revocable is one integer on
the user row: **version-based stateless JWT revocation** (SESSION-002, DEC-003). Every request
revalidates the token's signature and expiry, then reloads the user from PostgreSQL — `role`,
`plan` and `sessionVersion` in one read — which is what lets the entitlement resolver read
persisted state rather than anything a client asserted, and what lets a revocation take effect on
the very next request.

#### The session model

| Property           | Value                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token              | HS256 JWT signed by `JwtService` with `AUTH_JWT_SECRET` (≥ 32 characters); `algorithms: ["HS256"]` pinned on verify (`auth.module.ts`)                                                    |
| Claims             | `{ sub: userId, sv: sessionVersion }` plus the library's `iat` / `exp` (`AuthService.issueToken`). `sv` is always written, including `0`. No other user data is in the token.        |
| TTL                | `AUTH_TOKEN_TTL_SECONDS`, default 8 h (`packages/config`), used both as JWT `exp` and cookie `Max-Age`. Unchanged by SESSION-002.                                                      |
| Cookie             | `AUTH_COOKIE_NAME` (default `intrinsic_auth`), `HttpOnly`, `SameSite=Lax`, `Secure` only when `NODE_ENV=production`, path `/`, `Max-Age` = TTL (`auth-cookie.ts`)                       |
| Issuers            | Exactly two, both through `AuthService.issueToken`: `POST /auth/login` and `GET /auth/google/callback`. Registration, verification and password reset issue no session.               |
| Validation         | `AuthService.authenticateToken`: signature + expiry, claim parsing (`session-token.ts`), then **one** `User` read by id that also selects `sessionVersion`; the claim must match it     |
| Guards             | `CookieAuthGuard` (required session; any failure → generic `401`) and `OptionalCookieAuthGuard` (any failure → Guest). Both call `authenticateToken`; nothing else parses the cookie.   |
| Ordinary logout    | `POST /auth/logout` clears the cookie in the calling browser only; revokes nothing                                                                                                      |
| Sign out everywhere | `POST /auth/logout-all` (authenticated): increments `sessionVersion`, clears the caller's cookie, `204`                                                                                |
| Global kill switch | Rotating `AUTH_JWT_SECRET` invalidates every session of every user                                                                                                                      |

`sessionVersion` is authentication state, never a response field: `/auth/me` and every other
contract still return only `id`, `email`, `role` and `plan`. The same read now also carries
whether the account has accepted the required Terms version — compliance state, likewise never a
response field, reaching `LegalAcceptanceInterceptor` on `request.legalAcceptance` and dropped by
`toAuthUser`. It rides on this query rather than a second one so that the acceptance state and
the identity it is about are read on the same row, in the same statement. `UsersService` keeps it in a separate
`SESSION_USER_SELECT`, and `toAuthUser` drops it.

#### The comparison rule

`parseSessionClaims` and `isCurrentSession` in `apps/api/src/auth/session-token.ts` are the whole
rule, and `authenticateToken` is its only caller:

- **Equality, never ordering.** A token is current only while `sv` equals the row's
  `sessionVersion`. A lower `sv` was revoked; a higher one was never issued for this account. Both
  are refused.
- **A malformed `sv` is refused**: present but not a non-negative safe integer (a string, a
  fraction, a negative, `null`, a boolean, an array, ≥ 2^53).
- **Every refusal is the same generic `401`** — revoked, expired, forged, malformed, or an account
  that no longer exists are indistinguishable to the caller. `OptionalCookieAuthGuard` turns every
  one of them into the Guest view.

#### Rollout: tokens issued before the claim existed

Tokens signed before SESSION-002 carry `{ sub }` only. The migration
(`20260918120000_add_user_session_version`) adds the column as `NOT NULL DEFAULT 0`, so every
existing account starts at `0`, and:

- a correctly signed token **without** `sv` is accepted only while the account's
  `sessionVersion` is `0`, so **deploying does not sign anybody out**;
- the account's first increment (a password reset, or "sign out everywhere") revokes those legacy
  tokens exactly like versioned ones;
- once an account is past `0`, a missing claim is never treated as current again;
- every token issued after the deploy carries an explicit `sv`, so once one `AUTH_TOKEN_TTL_SECONDS`
  has passed since the deploy no legacy token can still be unexpired, and the legacy branch of
  `isCurrentSession` can be deleted in a follow-up. There is deliberately no deployment flag.

#### What revokes a session

| #   | Scenario                                            | Exists?                                                        | Other copies of the token after it                                                                   |
| --- | --------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| R1  | User signs out in this browser                      | Yes — `POST /auth/logout`                                      | **Keep working** until expiry, by design. Ordinary logout is browser-local and never bumps the version. |
| R2  | User signs out every device                         | Yes — `POST /auth/logout-all`, "Sign out everywhere" in `AccountMenu` | **Revoked** (version incremented)                                                               |
| R3  | User resets password via email link                 | Yes — `POST /auth/reset-password`                              | **Revoked**, in the same transaction that replaces the password                                      |
| R4  | Password change while signed in                     | No endpoint exists                                             | n/a — **must increment the version when built**                                                      |
| R5  | Role demoted (ADMIN → USER)                         | Only by direct DB edit or seed                                 | Keep working with the new role: the role is reloaded per request. A future admin role-management flow should increment on demotion. |
| R6  | Plan change (Stripe)                                | Yes                                                            | Keep working. The plan is reloaded per request; a plan change must **not** revoke.                   |
| R7  | User row deleted                                    | No user-facing deletion exists                                 | Revoked: the reload finds no row → `401`. A future account deletion needs no increment.              |
| R8  | Google account unlinked / OAuth identity removed    | No such action exists                                          | n/a — **must increment the version when built**                                                      |
| R9  | Administrator suspends an account                   | No such feature exists                                         | n/a — **must increment the version when built** (and refuse sign-in while suspended)                 |
| R10 | AUTH-001 clears an attacker-set password            | Yes (PR #44)                                                   | Nothing to revoke: the attacker never had a session — login refuses unverified accounts              |
| R11 | `AUTH_JWT_SECRET` rotated                           | Operational                                                    | Revoked for **all** users                                                                            |
| R12 | Operator re-runs `pnpm db:seed` / `test:users:seed` | Operational; rewrites that account's `passwordHash` and `role` | Keep working — the seeds do not increment. See residual limitations.                                 |
| R13 | Email verification installs the redeemer's password | Yes — `POST /auth/verify-email` (AUTH-002)                     | **Revoked**, in the same transaction that installs the password. A never-verified account has none. |

**Ordinary logout vs. sign out everywhere.** "Sign out" in `AccountMenu` calls `POST
/auth/logout`: this browser's cookie is cleared and the account's other sessions are untouched,
which is what signing out of a shared machine should do. "Sign out everywhere" calls `POST
/auth/logout-all`, which needs a live session (`CookieAuthGuard`, `mutation` rate-limit policy),
takes no body, increments the version and clears the caller's cookie; every other device gets the
generic `401` on its next request. A session that was already revoked cannot call it: the guard
refuses it before anything is written. Both clients land on `/login`.

#### Atomicity and concurrency

- **The version is only ever changed by an atomic `{ increment: 1 }`** in PostgreSQL, never read,
  incremented and written back. Concurrent "sign out everywhere" calls may increment more than
  once; that only moves the version further from every revoked token, so no older session can ever
  become valid again.
- **A password reset — and an email verification — increments in the same `UPDATE` that writes the
  new `passwordHash`**, inside the redemption transaction whose token-consuming delete is its gate. The credential change, the
  consumption and the revocation commit or roll back together: a failed, expired, unknown or
  already-used reset changes none of them.
- **Issuers sign the version read on the row that authorised the sign-in** —
  `findForPasswordLogin` for a password, the resolved row for Google — never a later read. A reset
  that commits while Argon2id is verifying the old password therefore leaves the new token already
  revoked, rather than letting a later read pick up the new version for an old credential.
- **Validation compares against the row read on that request.** A revocation committed before the
  read fails the token; one committed after it takes effect from the next request. There is no
  lock and no queue.

#### Residual limitations

- A revocation cannot interrupt a request that already passed the guard; it applies from the next
  request.
- Ordinary logout still leaves a captured copy of that browser's token valid until expiry; "sign
  out everywhere" is the remedy.
- Revocation is per account, all-or-nothing: there is no list of active sessions and no way to end
  one device alone. That needs a server-side session store (optional-later item 11).
- The operator seeds (R12) replace a password and role without incrementing the version; an
  operator who needs to evict sessions afterwards uses "sign out everywhere" as that user, or
  rotates `AUTH_JWT_SECRET`.
- Until one TTL after the deploy, a legacy claimless token of an account still at `0` stays valid,
  exactly as it was before the deploy.

## API surface

- `GET /auth/providers`: non-secret capability probe (`{ google: boolean }`) so the UI only offers
  providers this deployment configured.
- `POST /auth/register`: email-first (AUTH-003). Always `202 { status: "accepted" }` for a
  well-formed address; creates a pending account without a password, re-mails a pending one, or
  mails a verified one's owner a neutral notice — at most once per address per cooldown window.
- `POST /auth/verify-email`: redeems a token once, installs the password in the body as the
  account's password (AUTH-002) and records the submitted Terms acceptance for the account, all
  in one transaction. No session is issued. The body now requires `termsVersion`; a missing,
  unknown or superseded one is a `400` that redeems nothing, so an activated account without its
  acceptance is not a reachable state. See `legal-compliance.md`.
- `POST /auth/resend-verification`: re-mails a pending account's activation link under the same
  cooldown; always `202`.
- `POST /auth/login`: validates and normalizes credentials, returns a safe `AuthUser`, and sets the
  auth cookie. Missing users, incorrect passwords, users without a local password, and unverified
  accounts all receive the same generic `401` (AUTH-003 removed the `403 EMAIL_NOT_VERIFIED`
  branch: no credential on an unverified row was ever proven, and the distinct answer revealed that
  a pending account existed).
- `POST /auth/forgot-password`: requests a reset link; always `202`.
- `POST /auth/reset-password`: redeems a reset token once and installs the new password.
- `GET /auth/me`: requires the cookie guard and returns the current safe `AuthUser`.
- `POST /auth/logout`: clears this browser's auth cookie and returns `204`. Revokes nothing.
- `POST /auth/logout-all`: requires the cookie guard; revokes every session of the account ("sign
  out everywhere"), clears this browser's cookie and returns `204`.
- `GET /auth/google`, `GET /auth/google/callback`: the Google flow described above.
- `GET /admin/health`: proves ADMIN authorization (`401` anonymous, `403` USER, `200` ADMIN).

- `GET /legal/acceptance`, `POST /legal/acceptance`, `GET /legal/requests`,
  `POST /legal/requests`: Terms acceptance and the request channels a declining user keeps. All
  four are outside the acceptance gate — accepting cannot require having accepted, and a user who
  declines must still be able to cancel, exercise statutory rights and reach support
  (`legal-compliance.md`).

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
- redemption consumes the token, writes the new password and increments `sessionVersion` inside
  **one** transaction, so none of the three can happen without the others and only the request
  that actually removed the row succeeds

`POST /auth/reset-password` applies the same password policy as registration — an old password
that predates a policy change still authenticates, but a newly chosen one must satisfy today's
rules — and hashes with the same Argon2id `PasswordService`.

Redemption runs cheap-first:

1. SHA-256 the submitted token and look it up on the unique `tokenHash` index.
2. If no unexpired row matches, reject. An expired row is cleared on the way out — expiry is the
   one verdict that needs no transaction, because an expired token can never become valid again.
   Nothing depends on that cleanup: one expired row per user is bounded, replaced by the next
   issuance and cascaded with the account.
3. Only then compute the Argon2id hash, which happens outside the transaction because Argon2id is
   deliberately slow and a transaction must not be held open across it.
4. Redeem inside the transaction, which re-reads the row and re-checks everything step 1 checked,
   and whose consuming delete is the real gate — see *Rotation and concurrency* below.

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
verification event. Apart from the session version, nothing else changes: not the role, not the
plan, not a linked Google account.

The link points at `WEB_BASE_URL/reset-password?token=...`. The web pages are `/forgot-password`
and `/reset-password`, built from the same `AuthCard` and form styles as Login, Register and
Verify Email, and reachable from a **Forgot your password?** link on the sign-in form.

**A reset ends every existing session.** The increment of `sessionVersion` is part of the same
`UPDATE` that installs the new password, so every session the account had — a second device, or a
cookie an attacker captured — gets the generic `401` on its next request, while a failed, expired,
unknown or already-used token revokes nothing. The reset itself issues no session: the user signs
in with the new password afterwards, and that token carries the incremented version.


An invalid, expired or already-used reset link (`401` from the API, which does not say which) switches
the page to a recovery state — the neutral "This password reset link is invalid, expired, or has
already been used." and an inline "Send a new link" form — exactly as an invalid verification link
does, instead of leaving a dead password form under the raw API sentence (UI-043).

## Configuration and secrets

All auth, Google, and SMTP configuration is parsed and validated in `packages/config/src/index.ts`.
Auth, email, and Google business code never reads `process.env`. The web app's only configuration
is the public `NEXT_PUBLIC_API_BASE_URL`, which carries no secret.

Outbound email goes through an `EmailSender` port. The SMTP transport is the production
implementation; deterministic tests replace the port entirely with `InMemoryEmailSender`, and
`apps/api/src/email/no-real-email.setup.ts` additionally replaces `nodemailer` for every API test
file, so no automated test can send real mail even when a developer `.env` configures a relay
(`no-real-email.guard.test.ts` proves it). In development and test, with no SMTP configured, the API still boots and reports the
verification email as undeliverable rather than pretending it was sent. **In production the API
refuses to start without `SMTP_HOST` and `SMTP_FROM`**, and without an https, non-loopback
`WEB_BASE_URL` and `CORS_ORIGINS` (PROD-001): without them registration, verification, recovery,
the Google redirect and Stripe return URLs would all fail after a healthy-looking boot. The worker
sends no email and requires none of these.

## Observability

Auth emits stable structured events — `auth.login.succeeded`, `auth.login.failed`,
`auth.activation.requested` (register and resend, with `source` and an internal `outcome` of
`account_created`, `activation_claimed`, `notice_claimed`, `cooldown`, `claim_lost` or
`not_eligible` — never returned to the caller), `auth.email.verification.sent`,
`auth.email.verification.withdrawn`, `auth.email.account_notice.sent`,
`auth.email.verification.completed`,
`auth.google.callback.completed`, `auth.google.account.linked`,
`auth.google.account.link.refused`, `auth.google.user.created`,
`auth.password.reset.requested`, `auth.password.reset.completed`, `auth.sessions.revoked` (with
`reason` `password_reset`, `email_verification` or `sign_out_everywhere`), and their failure
counterparts. `auth.email.verification.rejected` and `auth.password.reset.rejected` carry `reason`
`no_redeemable_token` (refused by the cheap pre-check) or `token_not_redeemed` (lost to the
transaction).
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

1. **Session invalidation — done (SESSION-002, DEC-003).** `User.sessionVersion` is carried as
   the `sv` claim and compared during the guard's existing per-request reload; a password reset
   and `POST /auth/logout-all` increment it. See *What a session is, and what ends it* for the
   model, the rollout rule, the revocation matrix and the residual limitations.
2. **Rate limiting — done.** It exists as one cross-application concern, never as an entitlement
   (`AGENTS.md` invariant 17): `apps/api/src/rate-limit`, described in `rate-limiting.md`. Every
   credential, registration and recovery route uses the IP-keyed, fail-closed `auth-sensitive`
   policy.
   **Verification activating a password nobody proved — done (AUTH-002).** Redeeming a
   verification link now installs the password its holder chooses; see *The rule: verification
   sets the password*.
3. **Registration enumeration — done (AUTH-003, DEC-004).** Registration is email-first, answers
   one `202` for every address, mails a verified account's owner a neutral notice instead of
   returning `409`, and is bounded per address by a cooldown. See *Email-first registration*.

### Should do soon

4. **Sign-in-transaction cookie integrity.** The OAuth transaction cookie is HttpOnly but not
   authenticated. Anyone who can set a cookie on the victim's browser — a compromised sibling
   subdomain, or plain HTTP in a non-production deployment — can plant their own transaction and
   complete a login-CSRF: the victim ends up signed in to the *attacker's* account. Signing the
   cookie, or scoping it with a `__Host-` prefix, closes it.
5. **Timing side channel on recovery.** `POST /auth/forgot-password` returns one response, but an
   address with a local password performs an SMTP round trip and an address without one does not,
   so elapsed time still distinguishes them. Registration and resend already send out of band
   (AUTH-003, `BackgroundEmailDispatcher`); moving recovery onto the same dispatcher removes the
   difference there too.
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
