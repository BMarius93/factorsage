# Browser storage and network inventory — how it was verified

Status: **verified against this build, in a browser, on 2026-09-21.** Not verified against a
production deployment — see _What this does not cover_. Owner input `O6`.

`STORAGE_INVENTORY` in `packages/contracts/src/legal.ts` is the machine-readable form of this
document, and `/cookies` renders the published policy from it, so the policy is the application's
own inventory rather than a description of it.

## Why a runtime inventory, and not a source search

`docs/legal/README.md` records that a targeted search found no analytics SDK in `apps/web/src`, and
says in the same sentence that this is not proof. A source search cannot see what a framework
injects at build time, what a font loader fetches, what a redirect target sets, or what a proxy
adds. So the question was answered by driving the running application and watching what the
browser actually did.

## Method

Against the hermetic E2E stack (`pnpm dev:fmp:e2e`, `dev:api:e2e`, `dev:web:e2e`) with a production
`next build`, a Chromium context recorded **every** request the browser issued and the whole of
`localStorage` after each step.

Journeys covered, as a signed-out visitor and as a signed-in one:

1. `/dashboard`, each of the six legal pages, `/pricing`, `/login`, `/register`;
2. a Stock Details page (`/stocks/QATEST1`) — the only surface that writes the guest recents key;
3. the consent journey: undecided → refuse → allow → withdraw, checking storage after each;
4. sign-in, the acceptance screen, `/billing`, `/cancellation-and-refunds`, `/legal/requests`.

Every request's origin was asserted against `localhost` / `127.0.0.1`.

## What was observed

**No third-party origin was contacted at any point.** The recorded set of non-local origins across
the whole guest journey was empty.

Three things that a template inventory would have got wrong:

- **Fonts are not a third-party request.** Geist is loaded through `next/font/google`, which
  downloads the files at **build** time and serves them from this origin. Nothing is fetched from
  `fonts.googleapis.com` or `fonts.gstatic.com` at runtime, so there is no font cookie and nothing
  to disclose.
- **There is no payment or identity script.** Stripe is reached by a server-side redirect to its
  hosted Checkout and Customer Portal, and Google by a server-side redirect to its sign-in page.
  Neither SDK is loaded in the browser, so neither sets anything on this origin. What they set on
  _their_ origins is theirs, and the policy says so instead of claiming the local control governs
  it.
- **Company logos never leave the origin.** `/api/logo/{symbol}` is a first-party Next.js route
  that proxies the provider server-side.

### Storage, per step

| Step                                 | `localStorage` afterwards                                |
| ------------------------------------ | -------------------------------------------------------- |
| First visit, no choice made          | _empty_                                                  |
| Stock Details viewed while undecided | _empty_ — recents held in memory only                    |
| Refuse                               | `factorsage.storage-consent.v1` only                     |
| Stock Details viewed after refusing  | `factorsage.storage-consent.v1` only                     |
| Allow, then view Stock Details       | consent record **and** `factorsage.recent-securities.v1` |
| Withdraw                             | consent record only — the recents key is removed         |

Cookies: the configured session cookie appears only after signing in, and the `_oauth_tx`
transaction cookie only when a Google sign-in is started. No other cookie was set on this origin.

## The classification decision

The guest recent-securities key is treated as an **optional preference**, not as strictly
necessary. It makes a dropdown nicer; the product works without it, and nobody asked for it. The
ePrivacy article 5(3) exemption is for storage strictly necessary to provide the service the user
explicitly requested, and this is not that. `docs/legal/owner-inputs-and-review.md` records the
same conservative default.

The consent record itself **is** necessary: it exists only to honour the visitor's own decision,
and asking permission to remember an answer would be circular.

Because one optional purpose exists, a consent control is required and is shown.
`OPTIONAL_STORAGE_EXISTS` is derived from the inventory, so if the product ever stops writing
optional storage the banner disappears rather than becoming a request for permission it does not
need — the specification is explicit that a fake Accept banner is worse than none.

## What this does not cover

- **A production deployment.** A CDN, a reverse proxy, a hosting platform's own analytics, an
  error-reporting agent or a tag manager added later can all set storage this build does not. The
  inventory must be re-verified against production before the cookie policy is published, which is
  the remaining half of `O6`.
- **Third-party pages.** What Google and Stripe do on their own domains was not inspected and is
  not claimed either way.
- **Anything added after this date.** A new dependency that loads a remote asset would not appear
  here. The E2E egress guard already fails a test run that contacts an unexpected host, which is
  the mechanism most likely to catch it.
