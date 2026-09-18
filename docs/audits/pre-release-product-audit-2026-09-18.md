# FactorSage V2 Pre-Release Audit

- **Audited commit:** `main` @ `6b642eb4870027b65b625c01373e3c1eb61cbd60` (Merge PR #42, dashboard market cards), fetched 2026-09-18.
- **Branch:** `audit/pre-release-2026-09-18`. It contains only this document.
- **Evidence:** screenshots and logs are kept **outside the repository** at
  `~/Documents/projects/factorsage-audit-evidence-2026-09-18/`, because the repo commits no
  screenshots. In this document, `EV/` means that folder.
  - `EV/v2-qa-stack/`: deterministic test-DB stack, with personas and QA fixtures.
  - `EV/v2-dev-data/`: development DB with real market data.
  - `EV/v2-full-page/`: full-page captures.
  - `EV/v1/`: deployed factorsage.com, as a guest.
  - `EV/e2e.log`, `EV/summary.txt`, `EV/gate-per-package.txt`: raw test output.
- **Screenshot naming:** `<persona>-<route>-<width>.png`, for example
  `EV/v2-qa-stack/pro-dashboard-1280.png`.
- **Method:**
  - Five parallel read-only code reviews: backend domain, backtests/data/workers, auth/billing/ops,
    frontend, and tests.
  - Every P0/P1 below was then re-checked against the code by hand, and where possible reproduced
    in a browser.
  - Browser inspection covered 1440, 1280, 820, 390 and 360 px, across these states: Guest, FREE,
    STARTER, PRO, ADMIN and DOWNGRADED.

---

## 1. Executive Summary

**V2 is close to a public release.** The remaining work is mostly **production configuration**,
**one security fix** and **a small set of UX correctness fixes**. There is no architecture work
between here and launch.

The domain core is the strongest part of the codebase, and the reviews found no defect in it:

- Ownership filtering, SYSTEM/USER separation, the Monitor lifecycle, and the backtest
  claim/lease/snapshot protocol are all sound.
- Entitlement enforcement sits at every canonical boundary and is decided inside the writing
  transaction.
- Stripe webhook handling is idempotent and converges when events arrive out of order.

All of this was verified end to end in code, and most of it is also covered by strong
integration tests.

**One release blocker (P0).**

- A Google sign-in can adopt a **pre-registered, never-verified account and keep the password
  someone else chose for it**. That is a classic pre-account-takeover.
- The fix is a few lines with low risk.

**Main pre-launch risks (P1), all small to medium:**

- **Plan-limit refusals read as outages.**
  - Example: a FREE user who creates an 11-stock list is told "Try again in a moment".
- **Guest hand-off breaks.**
  - "Backtest this strategy" bounces a guest to `/login`.
  - The sign-in prompt promises "you will come straight back here", which is not implemented.
- **Monitor detail can say "Enabled" for a monitor the plan has stopped scanning.**
- **No error boundary or styled 404.**
- **At 1280 px the Dashboard's Stock column collapses to one letter per ticker.**
- **Production-config gaps.**
  - The web image bakes `http://localhost:3001` into the bundle.
  - Required settings silently default to localhost.
  - No security headers.
  - Unpinned lockfile.
- **Session revocation.** Your own auth document lists it as "must do before public
  production".
- **The E2E suite is not green (7 known failures) and not provider-free.** It cannot act as the
  release smoke gate until it is.

**Mix of the remaining work:**

| Type | Share |
| --- | --- |
| Production configuration / ops | ~35% |
| UX correctness | ~30% |
| Tests / CI | ~20% |
| Backend robustness (P2 hardening, not blockers) | ~15% |
| Architecture | 0% |

---

## 2. Current Product State

What works end to end today (verified in the browser and by tests):

- **Dashboard.**
  - Run Backtest, S&P 500 and DJIA (market-reference index series with 7-day sparklines), VIX
    (gauge with regime label), Real-time Matches, then Current Signals.
  - Signal filters: All / Active / Waiting, plus an Action filter.
  - Entity chips, and a staleness badge ("Stale · last scan 49 min ago" when no worker is
    running, which is correct).
  - Guest notice, and a mobile card composition.
  - `EV/v2-dev-data/devfree-dashboard-1440.png`, `…-390.png`.
- **Built-in content.**
  - Guests can browse built-in Lists, Strategies and Monitors.
  - Read-only detail pages.
  - Per-user Dashboard visibility switches.
  - Admin editing through the ordinary editors plus an admin overview.
- **Lists.**
  - Your / Built-in sections, create dialog with a multi-select picker, rename, delete.
  - A point-in-time membership editor with multiple ranges.
- **Strategies.**
  - Builder with BUY/SELL levels, percentage segments, Conditions, optional Trigger, and FINAL
    EXIT OR-rules.
  - Contextual help panel, live logic summary, issue count, and a sticky save bar on mobile.
- **Monitors.**
  - Collection split into Your / Built-in.
  - Enable/disable, and a "Not scanning" state for plan overage.
  - Detail page with configuration, monitored stocks and recent signals. Rebind and delete.
- **Backtests.**
  - New Backtest form (benchmark picker limited to selectable series).
  - Asynchronous execution with progress, a year-window result chart (Strategy / S&P 500 / Cash),
    results tiles, trades and holdings.
- **Stock Details.**
  - Identity with logo, 1M–MAX ranges, indicators menu from the canonical catalog, RSI pane,
    intrinsic-value cards, key facts.
- **Billing.**
  - Free/Starter/Pro cards read from `PLAN_ENTITLEMENTS` and `BILLING_CATALOG`.
  - Monthly/yearly toggle, Checkout, Portal, and the transition matrix.
- **Auth.**
  - Email/password with verification and reset.
  - Google OIDC (PKCE, state, nonce).
  - In-context sign-in prompt for guests.

**Known gaps that are not defects:**

- No public pricing page (deferred by `ai/architecture/v1-visual-parity.md:52`).
- No guest demo backtests. The entitlement decision permits them but does not require them.
- `/stocks` has no index page (see H-10).

---

## 3. Release Blockers

### [B-1] Google sign-in can take over a pre-registered, unverified account

**Severity:** BLOCKER, if Google sign-in is enabled in production. It is optional
(`GOOGLE_*` is all-or-nothing).

**Surface:** auth / backend

**Evidence (re-verified by hand):**
- `apps/api/src/auth/google/google-auth.service.ts:148-186`: an existing account whose address
  Google is authoritative for (Gmail, or a matching Workspace `hd`) is adopted with
  `users.linkOAuthAccount`.
- `apps/api/src/auth/users.service.ts:97-122`: `linkOAuthAccount` sets `emailVerifiedAt`, deletes
  the verification token, and **leaves `passwordHash` untouched, even when the row was never
  verified**.
- `google-auth.integration.test.ts:582` covers exactly this adoption and only asserts that the
  address becomes verified.

**Problem:** the account can be adopted while it still carries a password set by whoever
registered it first.

**Impact (attack sequence):**
1. The attacker registers `victim@gmail.com` with a password of their choosing. The row stays
   unverified, so it is unusable for now.
2. Later the real owner clicks "Continue with Google". Their Google identity is linked to the
   attacker-created row, which becomes verified.
3. The attacker signs in with the password and sees everything the victim creates from then on,
   including Billing and the Customer Portal.

The victim clicking the verification email that the attacker's registration triggered leads to
the same result.

**Recommended fix:**
- In `linkOAuthAccount`, when the row's `emailVerifiedAt` is null, also set `passwordHash: null`
  and delete any `PasswordResetToken` in the same transaction. The owner can set a password later
  through Forgot password.
- Add an integration case asserting that the old password no longer logs in.
- Optionally, for the email path, have registration of an already-pending address rotate the
  token rather than keep the first registrant's password.

**Scope:** small. **Risk of fixing:** low.

No other finding survived the second pass as a blocker.

---

## 4. High-Priority Pre-Release Improvements (P1)

### [H-1] Plan-limit and rate-limit refusals are shown as transient failures

**Surface:** frontend.

**Evidence:**
- **Reproduced in the browser as FREE:**
  1. New list with 11 stocks.
  2. `POST /lists` returns `403 ENTITLEMENT_LIST_SYMBOL_LIMIT`.
  3. The dialog says "The list could not be saved right now. Try again in a moment."
  4. `EV/v2-qa-stack/free-list-create-overlimit-1280.png`
- **Cause:**
  - `apps/web/src/features/lists/components/ListFormDialog.tsx:32-37` passes through only 400s.
  - The same pattern appears in:
    - `MonitorDetail.tsx:173-175,463-466` (enable over cap)
    - `components/ui/ConfirmDialog.tsx:26-31` (every delete)
    - `StrategyRenameDialog.tsx:23-28`
    - `MembershipEditor.tsx:98-104`
    - `StrategyBuilder.tsx:132-142`
  - These turn a 403 entitlement refusal or a 429 into "try again". The canonical translator
    `lib/api/entitlement-errors.ts:45` (`requestFailureMessage`) already exists and is used by
    MonitorsPage, MonitorFormDialog, NewBacktestForm and ListDetail.
- **Inconsistency:** enabling a monitor over the cap shows the plan message on the collection
  but "That change did not save." on the detail page.

**Impact:**
- The single most common commercial boundary (symbols per list) reads as an outage, with no path
  to Billing.
- A 429 invites exactly the retry the limiter refuses.

**Fix:** route all six call sites through `requestFailureMessage(error, fallback)`, and keep
ConfirmDialog's 409 pass-through. Add one component test per site for a 403 entitlement code.

**Scope:** small. **Risk:** low.

### [H-2] Guest hand-off: restricted actions bounce to `/login`, and sign-in never returns

**Surface:** frontend / auth UX.

**Evidence:**
- **Reproduced as a guest:** on a built-in Strategy, clicking "Backtest this strategy" lands on
  `/login`.
  - `EV/v2-qa-stack/guest-backtest-this-strategy-result-1280.png`
- **The same class of action works correctly elsewhere:** the Dashboard's Run Backtest card and
  "New list" open the in-context prompt.
  - `EV/v2-qa-stack/guest-run-backtest-prompt-1280.png`
- **Cause:**
  - `features/strategies/components/StrategyReadOnlyView.tsx:44-49` and
    `features/monitors/components/MonitorDetail.tsx:385-390` render a plain
    `<Link href="/backtests/new?…">` for every non-editor, guests included.
  - `/backtests/new` is not a guest route (`features/auth/utils/guest-routes.ts`), so
    `RequireAuth` redirects.
- **The prompt promises something that is not implemented:**
  - Its copy reads "Sign in or create an account to run one — you will come straight back here".
    See the same screenshot.
  - But `SignInPrompt.tsx:23-28` links bare `/login` / `/register`, and `LoginForm` always lands
    on `/dashboard`.
  - `signInHref()`'s own docstring says "and back to the page they were on", which is not
    implemented either.

**Impact:**
- The primary call to action on built-in content, which is how guests discover the product,
  breaks the agreed "in-context prompt, never bounced" rule.
- The strategy/list prefill is lost.
- Every guest who signs in from a prompt is dropped on the Dashboard.

**Fix:**
1. For a guest, render the "Backtest this …" actions as buttons that call
   `gate.attempt(SIGN_IN_TO_BACKTEST, …)`, as `DashboardOverview.tsx:150-165` does.
2. Add `?next=` to `signInHref()` and honour it in the login, register and Google callback flows,
   accepting only same-origin paths (must start with `/`, not `//`).
   - If you want to defer (2), change the prompt copy now so it stops promising the return.

**Scope:** small (1), medium (2). **Risk:** low (1), medium (2), because redirect validation must
be strict.

### [H-3] Monitor detail says "Enabled" for a monitor that is not being scanned

**Surface:** frontend.

**Evidence:**
- As DOWNGRADED, "ENT-Downgraded Monitor 3" appears as **Enabled + Not scanning** in the
  collection (`EV/v2-qa-stack/downgraded-monitors-1440.png`).
- Its detail page shows only **Enabled** (`…/downgraded-monitors_f31f583d-…-1440.png`).
- `MonitorDetail.tsx:363-372` never reads `operationalStatus` or `blockedReason`; the collection
  does (`MonitorsPage.tsx:265-279`).

**Impact:** after a downgrade, the page that should explain why nothing is happening states a
false operational fact.

**Fix:** move the collection's blocked pill and `blockedExplanation` into
`features/monitors/utils` and render them on both surfaces.

**Scope:** small. **Risk:** low.

### [H-4] No error boundary and no styled not-found page

**Surface:** frontend.

**Evidence:**
- There is no `error.tsx`, `global-error.tsx` or `not-found.tsx` under `apps/web/src/app`.
- An unknown URL renders Next's bare 404 with no shell (`EV/v2-qa-stack/guest-nope-404-1440.png`).

**Impact:**
- The app renders client-side, so any render-time exception (chart library, an unexpected
  contract field) replaces the whole UI, navigation included, with Next's unstyled
  "Application error" page.
- There is no way back apart from the browser.

**Fix:**
- `app/(app)/error.tsx`: in-shell `EmptyState variant="error"` plus `reset()`.
- A minimal `app/global-error.tsx`.
- `app/not-found.tsx` using the shell and `EmptyState`.

**Scope:** small. **Risk:** low.

### [H-5] At 1280 px the Dashboard's Stock column collapses to a single letter

**Surface:** frontend / visual.

**Evidence:**
- **Real data, 1280 px:** tickers render as "U.", "R.", "M.", "H."
  (`EV/v2-dev-data/devfree-dashboard-1280.png`). The same happens on the QA stack ("QATE…",
  `EV/v2-qa-stack/pro-dashboard-session-loading-300ms-1280.png`).
- At 1440 px it is fine (`EV/v2-dev-data/devfree-dashboard-1440.png`).
- **Cause:**
  - `DashboardPage.module.css:98-103` gives the Why column `min-width: 14rem`.
  - The Strategy, List and Monitor chips do not wrap.
  - The Stock cell has no minimum, so it absorbs all of the shrink.

**Impact:** on a 13" laptop (1280) the primary Dashboard table hides the one column that
identifies each signal.

**Fix (either):**
- Give the stock cell a minimum (about 7.5rem, enough for a 5-letter ticker and a truncated name),
  and allow entity chips to truncate.
- Or hide the List column between 880 and ~1360 px (it is also on the Monitor detail).

Verify at 1280 and 1024.

**Scope:** small. **Risk:** low.

### [H-6] Production configuration fails open: localhost API URL baked into the web bundle, silent localhost defaults

**Surface:** production / ops (code change needed).

**Evidence:**
- `apps/web/src/lib/api/client.ts:8-9` falls back to `http://localhost:3001`.
- `NEXT_PUBLIC_*` values are compiled into the bundle at build time.
- `docker/web.Dockerfile` has no `ARG`/`ENV` for this variable, and `.dockerignore` excludes
  `.env`.
- `docker-compose.yml:44` sets the variable only at runtime, which has no effect on client code.
- `packages/config/src/index.ts` defaults `WEB_BASE_URL` (used for email links, the Google
  redirect and Stripe return URLs) and `CORS_ORIGINS` to localhost.
- SMTP is optional. With no mailer, `registration.service.ts:118` creates the user and then
  answers 503, so no password account can ever be verified.

**Impact:**
- A web image built from this Dockerfile sends every browser's API calls to the visitor's own
  machine.
- A missing variable in production produces a stack that boots "healthy" but cannot register
  users, send reset links or return from Checkout.

**Fix:**
- Add `ARG NEXT_PUBLIC_API_BASE_URL` / `ENV` before `pnpm build` in `docker/web.Dockerfile`, pass
  it via compose `build.args`, and fail the production build when it is unset or empty.
- In `packages/config`, when `NODE_ENV=production`:
  - require `WEB_BASE_URL`, `CORS_ORIGINS` and the SMTP group;
  - refuse `localhost` values.

**Scope:** small. **Risk:** low.

### [H-7] Sessions cannot be revoked (listed by your own auth doc as must-do before public production)

**Surface:** auth.

**Evidence:**
- The JWT carries only `{sub}`. `authenticateToken` checks the signature, expiry and that the
  user exists.
- Logout clears only this browser's cookie (`auth.controller.ts:157-165`).
- A password reset changes nothing about existing sessions.
- `ai/architecture/authentication.md` lists this as item 1 under "Must do before public
  production".

**Impact:** a stolen cookie stays valid for up to `AUTH_TOKEN_TTL_SECONDS` (8 h) after the victim
resets their password or logs out.

**Fix (as documented):**
- Add `User.sessionVersion` (migration) and include it as a JWT claim.
- Compare it in the guard's existing per-request user reload.
- Bump it on password reset and on a new "Sign out everywhere" action.

**Scope:** medium. **Risk:** low to medium (every user is signed out once at deploy).

If you decide the 8 h TTL is an acceptable launch posture, record that decision in the auth
document instead.

### [H-8] No security headers; the logo proxy serves provider SVG from the app origin

**Surface:** frontend / ops.

**Evidence:**
- `apps/web/next.config.ts` sets no headers: no `frame-ancestors`/`X-Frame-Options`, `nosniff`,
  `Referrer-Policy` or HSTS.
- The API has no helmet and advertises `X-Powered-By`.
- `app/api/logo/[symbol]/route.ts:91-99` passes any `image/*`, SVG included, through on the web
  origin:
  - no CSP;
  - no `nosniff`;
  - unbounded `arrayBuffer()`;
  - redirects followed.

**Impact:**
- Billing and destructive confirmations can be framed (clickjacking).
- A hostile SVG at the provider CDN, opened directly at `/api/logo/X`, would run script on the
  FactorSage origin. That origin makes credentialed API calls.
- Likelihood is low; the fix is trivial.

**Fix:**
- A `headers()` block in `next.config.ts`: `frame-ancestors 'none'` (via CSP), `nosniff`,
  `Referrer-Policy`, HSTS.
- `helmet()` in the API's `main.ts`.
- On the logo route: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`, `nosniff`, `redirect: "error"`, and a ~512 KB cap.

Defer a full application CSP to post-launch, since it needs testing against Next and Lightweight
Charts.

**Scope:** small. **Risk:** low.

### [H-9] Builds are not reproducible, and CI does not guard the migration history

**Surface:** CI / ops.

**Evidence:**
- `.github/workflows/ci.yml` and all three `docker/*.Dockerfile` use
  `pnpm install --no-frozen-lockfile`.
- CI runs lint, typecheck, test, test:redis, openapi and build. It has no
  `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code`. `db:validate` only
  checks schema syntax.

**Impact:**
- Dependency drift can enter a release unreviewed.
- A schema edit without its migration passes CI and fails `migrate deploy` in production.

**Fix:**
- Use `--frozen-lockfile` everywhere.
- Add a migrate-diff step against a CI Postgres shadow database (the recipe already exists in your
  migration notes).

**Scope:** small. **Risk:** low.

### [H-10] The E2E suite is neither green nor hermetic, so it cannot be the release gate

**Surface:** tests. Full breakdown in §7.

**Evidence:**
- **Full run with correct worker and fixture state:** 156 passed, 7 failed (`EV/e2e.log`).
- **All 7 have root causes in tests or fixtures, not in the product:**
  - backtest resume: 1
  - logo 404 console assertion: 4
  - PRO concurrency: 2
- **The stack is not provider-free:**
  - `dev:api:e2e` / `dev:worker:e2e` inherit `FMP_API_KEY`.
  - The QA SPY fixture series in the test DB is synthetic up to 2026-09-11 (close ≈ 470) and
    then carries **real** FMP closes (757.39, 760.88) from 2026-09-14.
  - As a result, the QA backtest result shows the "S&P 500" jumping about 60% on the last day and
    a +78.23% benchmark return (`EV/v2-qa-stack/pro-backtests_9fc43e7b-…-1440.png`).

**Impact:**
- A release smoke run that is red by default hides new regressions.
- Fixture data silently mutates from a live provider, so results depend on the day.

**Fix:**
- The per-failure actions in §7.
- Blank `FMP_API_KEY` in the e2e scripts, and stub `**/api/logo/**` in a shared Playwright
  fixture.

**Scope:** medium in total, all test-side. **Risk:** low.

---

## 5. UX / Visual Polish (P2 unless noted)

**Signal-state vocabulary differs between surfaces (P2).**
- The Dashboard shows "Buy 100%" + "Active" / "Waiting for trigger".
- Monitor detail shows "Matched" + "Buy · Trigger" for the same state, and the monitor itself is
  "Running".
- Compare `EV/v2-qa-stack/guest-dashboard-1440.png` with
  `…/guest-monitors_15656ff2-…-1440.png`.
- Pick one label per lifecycle state (`ACTIVE` → "Active", `PENDING_TRIGGER` → "Waiting for
  trigger") and one level chip format, both from a single `features/monitors/utils` source.

**Mobile signal card (P2).**
- The "Why" prose is right-aligned in a label/value row, so a two-line rule reads ragged-left
  (`EV/v2-full-page/guestfull-dashboard-390.png`, `EV/v2-qa-stack/pro-dashboard-820.png`).
- V1 left-aligns the match reason under its label (`EV/v1/v1-dashboard-390.png`).
- Stack label over value for long text.
- At 390 px, the carded page header plus the guest notice push the first signal below the fold
  (`EV/v2-qa-stack/guest-dashboard-390.png`). V1 shows the first match in the first viewport.
- On phones, consider dropping the Dashboard header card (your parity doc already says "no
  redundant Dashboard heading", `v1-visual-parity.md:296`) or condensing the guest notice.

**360 px strip (P2).**
- "S&P 50…" and "MATCH…" labels clip, and "Backtest" touches the tile edge
  (`EV/v2-dev-data/devfree-dashboard-360.png`).
- Use shorter compact labels ("S&P", "Matches") below ~380 px.

**Back links on built-in detail pages (P2).**
- Built-in List, Strategy and Monitor details always say "← Dashboard"
  (`ListDetail.tsx:294-297`, `StrategyReadOnlyView.tsx:29`, `MonitorDetail.tsx:344`), even when
  opened from their collection (`EV/v2-qa-stack/guest-strategies_2e684ee4-…-1440.png`).
- This predates PR #41, which made built-ins browsable in collections.
- Point them at the owning collection.

**Stock Details overlay lines are unlabeled at rest (P2).**
- The default intrinsic-value step line has no name until the user hovers; the legend is written
  only from the crosshair callback (`StockPriceChart.tsx:322-349`).
- On touch devices it effectively has no legend (`EV/v2-dev-data/dev-stocks_AAPL-1440.png`,
  `devfree-stocks_NVDA-390.png`).
- V1 shows persistent legend chips and colour-coded axis labels (`EV/v1/v1-stocks_IBKR-1440.png`).
- Render a resting legend with the latest values.

**Focus and loading details (P2).**
- `Modal.tsx:24-29` never returns focus to the trigger on close.
- The sign-in prompt can open while the session is still resolving (`use-sign-in-prompt.tsx:47-59`).
- An expired session mid-use shows "could not be loaded, try again" forever instead of moving to
  signed-out.
- A typeahead Enter can select the previous query's result during the 250 ms debounce
  (`use-stock-search.ts:62-71`, `StockSearch.tsx:176`, `SecurityMultiSelect.tsx:121`). In the list
  picker this adds the wrong security.

**Formatting drift (P2).**
- Collection dates differ between features:
  - Lists pin `en-US` (`lists/utils/format.ts:7`).
  - Strategies use the browser locale (`strategies/utils/format.ts:3-13`, whose comment claims
    it "matches lists").
  - Admin shows `9/18/2026` (`EV/v2-qa-stack/admin-admin-1440.png`).
- `formatSignedPercent` means a fraction in Stock Details but percentage points in Backtests.
- Settle on one small `lib/format` module for dates and signed percentages, with distinct names.

**Placeholder and internal surfaces (P2/P3).**
- `/stocks` shows developer copy to anyone: "Stock research and intrinsic value arrive in the
  Stock Details slice." (`EV/v2-qa-stack/guest-stocks-1440.png`). Redirect it to `/dashboard`
  (P2, trivial).
- `/admin` access-denied renders unstyled and flush-left (`EV/v2-qa-stack/pro-admin-1440.png`).
  The admin overview says "1 stocks" (`admin-admin-1440.png`). (P3)
- A comped (no-subscription) Pro account sees "Upgrade to Starter" on the Starter card
  (`EV/v2-qa-stack/pro-billing-1440.png`, `plan-actions.ts:150-160`). It only affects
  admin-granted plans. (P3)

**Component duplication with real divergence (P3; see §6):**
- Four segmented-control implementations with different accessibility semantics.
- `AccountMenu` uses `role="menu"` without arrow keys.
- `StockStatusPanel` has its own buttons, off the token scale.

**Verified good; no change needed:**
- No horizontal overflow on any captured page at 1440, 1280, 820, 390 or 360.
- No guest-UI flash for signed-in users: with `/auth/me` delayed by 1.5 s, neither "Sign in" nor
  the guest notice appeared (`EV/v2-qa-stack/pro-dashboard-session-loading-*.png`).
- The desktop-table / mobile-card split is consistent across collections.
- Carded page headers, sticky strategy save bar, and New/Edit placement are consistent.

### Comparison with deployed V1 (`EV/v1/`)

**V1 communicates more clearly:**
- **Persistent chart legend** (see above).
- **Margin-of-safety column with a bar on every Dashboard match**
  (`v1-dashboard-1440.png`). This gives valuation context per signal that the V2 Dashboard does
  not show. This is not a launch item; see §11.
- **Mobile Dashboard density:** the first match appears in the first viewport, and the match
  reason is left-aligned.
- **Lists collection previews member symbols as chips** (`v1-lists-1440.png`). V2 shows only a
  count.
- **Public `/pricing`.**

**V2 is clearly better, and must not regress:**
- **Honest data labelling:** "End-of-day data", session dates on market cards, "Stale · last scan
  …", "Waiting for trigger".
- **VIX as a gauge with a regime label.**
- **Pricing that is true.** V1 lists "Unavailable" prices and credits/top-ups the product does not
  have (`v1-pricing-1440.png`). V2's cards are generated from the entitlement matrix.
- **Readable built-in strategy logic,** in place of V1's "preview" pseudo-code
  (`v1-strategies_stg_…-1440.png`).
- **Real built-in monitors with live signals,** where V1 had a "Demo/Preview" monitor row
  (`v1-monitors-1440.png`).
- **No horizontal overflow; consistent section cards.**

**Copied from V1 and worth a second look (keep for launch):**
- The "Real-time Matches" label sits beside "End-of-day data" labelling everywhere else. It is
  an intentional product decision, so no change is proposed.

---

## 6. Code / Architecture Findings

### Correctness risk

**C-1 Benchmark Redis cache can hand a backtest a truncated year (P2; silent, rare).**
- **Mechanism:** `packages/stock-data/src/benchmark-service.ts:251-266` publishes year keys whose
  contents depend on the caller's range, then overwrites the manifest with that narrower range
  (`benchmark-cache.ts:92-104`, plain sequential `SET`s).
- **Trigger:** a hydration at a freshness boundary (every 6 h, or a UTC date change) for a later
  start year rewrites that year's key with a partial year. A concurrent reader that already passed
  the manifest check then reads it, and `assertCalendarCoversPeriod` checks PostgreSQL rather
  than the rows returned.
- **Consequence:** a run's execution calendar and benchmark lose months without any error.
- **Fix:** always write whole calendar years (read PostgreSQL from Jan 1 of the first year), or
  never shrink the manifest (take the union, as the stock loader does). Add a two-writer test.
- **Effort:** S. Low risk. **Recommended before launch because it is cheap.**

**C-2 Crashed backtest leases are recovered only by an idle worker child (P2).**
- `worker-loop.ts:59` runs `recoverStaleJobs()` only between claims.
- The API's concurrency count uses status alone (`entitlements.service.ts:203-205`).
- **Consequence:** while every child is busy with long runs, a crashed run stays
  `RUNNING`/`PREPARING_DATA` with frozen progress, and a STARTER user gets 403 on every new
  submission.
- **Fix:** run recovery on its own timer (the lease heartbeat already has one), and optionally
  exclude expired leases from the API count.
- **Effort:** S.

**C-3 Monitor orphan sweep runs one statement per row inside a 5 s interactive transaction (P2).**
- `apps/worker/src/monitor/monitor-repository.ts:615-655`; the default `PrismaClient()` is created
  at `composition.ts:63`.
- It fails permanently once removals reach roughly 1–2 k state rows at production latency, for
  example an admin restructuring an S&P-sized built-in.
- The Dashboard filters by level but not by list membership, so removed members' Signals would
  stay on the public Dashboard.
- **Fix:** bulk `updateMany`/`createMany`/`deleteMany`, as `crossMonitorConfigurationBoundary`
  already does.
- **Effort:** S. Raise to P1 if you expect to restructure built-ins shortly after launch.

**C-4 `GET /market-overview` has no failure backoff (P2).**
- Serial reads of three series (`market.service.ts:52`).
- Each refresh can wait up to 120 s for the Redlock and retries FMP for 15 s × 3.
- Nothing records a recent failure.
- **Consequence:** during a provider outage every Dashboard view (guests included) re-drives the
  provider and can hang for minutes.
- **Fix:** a ~60 s per-series Redis backoff marker after a failed refresh, a ~5 s overall request
  budget, and parallel reads.

**C-5 Smaller correctness items (P3):**
- Monitor state survives a level moving between BUY/SELL/FINAL EXIT, or Exit Rule ids changing,
  with identical logic. The fingerprint ignores kind and ids (`level-decision.ts:60-61`,
  `contracts/src/strategies.ts:2249-2281`). Reachable only through crafted API calls.
- Overlapping cycles after a lost lease can write duplicate orphan-sweep transitions (the read
  happens outside the transaction).
- Monitor detail and PATCH responses always return `dashboardVisible: true` for built-ins
  (`monitors.service.ts:105`), contrary to OpenAPI.
- Stock search takes 40 rows ordered by symbol before ranking by relevance
  (`prisma-store.ts:466-478`), so an exact ticker can be cut off for common name substrings.
- Redis client has no `commandTimeout` (`redis-client.ts:17-20`).
- Backtest children have no `disconnect` handler, so an orphaned child keeps claiming jobs.

### Security (beyond B-1 / H-7 / H-8)

- **Login CSRF (P2).** The API accepts `application/x-www-form-urlencoded` (Nest default
  parsers). A cross-site form can sign a victim into the attacker's account. Register only the
  JSON parser, or reject non-JSON state-changing requests.
- **Account enumeration (P2/P3).**
  - Registration answers 409 for a known address.
  - Resend-verification answers 503 when mail sending fails for an unverified account, versus 202
    for an unknown address.
- **Unsigned OAuth transaction cookie (P3).**
- **Readiness leaks detail (P3).** `/health/ready` returns `error.message` (DB host/port) in its
  public 503 body.

### Maintainability / duplication (P3, where divergence already costs consistency)

- Two error-translation paths (the root cause of H-1).
- The monitor enable toggle is implemented twice with different status rendering (the root cause
  of H-3).
- `statusTone()` is copy-pasted in `BacktestsPage.tsx:37` and `BacktestRunView.tsx:61`.
- Segmented control is implemented four ways (Dashboard `aria-pressed`, Builder clipped radio,
  Billing full-size radio, Stock range fieldset). All fill with `--color-primary` rather than
  `--color-surface-selected`.
- The chart chrome palette is duplicated in two `chart-theme.ts` files. The ui-system doc's "no
  hex outside tokens.css" claim is inaccurate.
- Stale docs: `authentication.md` and `entitlements.md` both say rate limiting does not exist yet.
  It does.

### Scaling (long-term; measured where possible)

- **`GET /backtests` returns every run with its full `snapshot`, with no pagination**
  (`backtests.service.ts:925-931`).
  - Measured on dev: 72 runs = 40 KB in 56 ms; average snapshot 3.3 KB.
  - Not an issue at launch. Add `select` plus cursor pagination later (P3).
- **`STOCK_CACHE_MAX_RESIDENT_STOCKS` defaults to 100, which equals one PRO backtest's list**
  (`packages/config/src/index.ts:844`). Concurrent PRO runs will thrash the resident LRU. Results
  stay correct; runs get slower.
  - Raise it in production to at least monitored universe + workers × 100, and document the
    sizing rule (P2, config).
- **Nested `versions: { take: 1 }` on multi-parent Strategy queries** may load all versions under
  Prisma without `relationJoins`. Unverified; check with query logging (P3).

### Unnecessary complexity

None worth changing before launch. The abstractions that look heavy are the claim/lease protocol,
the fingerprinted Monitor lifecycle, the year-window engine and the entitlement lock. Each is
documented, tested, and carrying real weight.

---

## 7. Test / QA Findings

### Baseline results (all on `6b642eb4`)

| Check | Result |
| --- | --- |
| `pnpm lint` | pass (71 s) |
| `pnpm typecheck` | pass (447 s) |
| `pnpm test` (full, parallel) | **fail**: 7 web tests + 7 stock-data Redis tests, **all `Test timed out in 5000ms`**. The run was under heavy machine load (5 review agents plus stale dev processes). pnpm stopped at the first failing package. |
| Per-package re-run, serial | web **730/730** · stock-data **465/465** · worker **213/213** · api **1011/1012**: `backtests.integration.test.ts › keeps a submitted run unchanged when an administrator later edits the built-ins` got 404 on `GET /backtests/:id`. **The file then passed 30/30 in isolation.** Intermittent, cause not established. |
| `pnpm build` | pass (75 s) |
| `pnpm openapi:validate` | pass (48 paths) |
| `pnpm test:e2e` (test DB, personas re-seeded, worker running) | **156 passed, 7 failed** (4.5 min) |

### The 7 E2E failures: cause and recommended action

**1. `backtests.user.spec.ts` › resumes from persisted progress after a mid-run reload**
- **Action:** fix the test.
- **Cause:** the diagnosis "the run finishes too fast" is wrong.
  - Since be9ca337 the chart mounts as soon as the run exists.
  - The wait loop (`:505-517`) treats "chart exists" as "drawing", so it exits during
    QUEUED/PREPARING with `data-strategy-points=0` and fails at `:530` (failed in 3.6 s here).
- **Change:**
  - Wait for points > 0 or a terminal status.
  - Make `afterEach` wait for the run to finish; this spec's leftover run is what then breaks
    #6/#7.

**2–5. `indicators.user` ×2, `oscillators.user` ×2: console 404**
- **Action:** a small product change plus a test fixture change.
- **Cause:** `/api/logo/QATEST1` proxies FMP's CDN and answers **404** for a missing logo.
- **This is not test-only noise.** Every real ticker without an upstream logo also logs a console
  404 for real users; guest dashboards showed them for QA tickers.
- **Change:**
  - Answer a missing logo with a cacheable non-error response that the component still treats as
    missing (e.g. `204`, verified against `onError`).
  - Stub `**/api/logo/**` in a shared Playwright fixture.
  - Do not filter the console assertion.

**6. `entitlements.pro.spec.ts` › accepts a thirty-year backtest**
- **Action:** fix the fixture and the test.
- **Cause:**
  - One of PRO's two slots is permanently pinned by the fixture run (lease until 2099).
  - The second slot was held by a run over "ENT-Pro Wide": 80 fictional ENTF tickers with **no
    coverage rows**, so the worker hydrates each one through real FMP (observed:
    `backtest.security.skipped NO_DAILY_DATA`, still `PREPARING_DATA` minutes later).
  - `waitForFreeSlot` polls for up to 120 s inside a test whose timeout is **30 s**, so its own
    budget can never be used.
  - `countInFlight` reads only grid page 1, while PRO_USER holds 225 accumulated runs.
- **Change:**
  - Seed "no data over the whole range" coverage and watermark rows for ENTF securities.
  - Wait for a free slot in `beforeEach`, with a test timeout large enough to cover it.
  - Count in-flight runs via `GET /backtests`.
  - Correct the header comment, which says no run is pinned.

**7. `entitlements.pro.spec.ts` › accepts a second concurrent backtest**
- **Action:** same as #6.
- **Cause:** same as #6 ("2 are already running").

**Known local-only noise (lower priority, with a concrete fix each):**
- **`getByLabel("Name")` strict-mode collision** with "More actions for <name>" when run against
  the dev DB. The pattern appears in about 20 places. Use `{ exact: true }` or scope the locator
  to the dialog. (P3)
- **API "runs at most 1 concurrent backtests on starter" flake.**
  - It fails whenever a worker is running against `TEST_DATABASE_URL`, because `pnpm test` and
    the E2E stack share that database.
  - Worker suites' `claimNextJob` is unscoped and `pnpm -r test` runs packages concurrently, so
    suites can steal each other's jobs.
  - Fix: give E2E its own database, or run DB-backed packages with `--workspace-concurrency=1`.
    (P2)
- **stock-data `redis.integration.test.ts` timeouts.**
  - Real-clock windows have 25–50 ms margins under the default 5 s timeout.
  - Widen the ratios and set `testTimeout: 20_000` for integration files. The same timeout issue
    applies to the userEvent-heavy web component tests that timed out under load. (P2)

### Other test findings

- **P1 (in H-10):** E2E is not provider-free.
  - It reaches FMP via ENTF hydration, the benchmark tail refresh (this corrupted the SPY fixture)
    and the logo CDN.
- **P2:**
  - **E2E is not in CI.** Add it once it is green and hermetic.
  - **The three "progressive run" E2E tests almost never assert anything.** On a fast stack they
    downgrade to annotations. The fallback component test mocks `lightweight-charts` entirely. An
    e2e-only per-year worker delay would make them real.
  - **Personas accumulate runs** (PRO_USER has 225), because runs cannot be deleted. A
    `globalSetup` should prune E2E-created runs in the test DB.
  - **Fixture freshness depends on the real clock** ("run the seed shortly before the suite"). A
    stale seed silently sends backtests to the provider.
- **P3:**
  - Cross-customer case for `PUT /dashboard/monitors/:id/visibility` (only random and unpublished
    ids are tested).
  - No axe/a11y smoke and no touch/mobile device project (mobile is only `setViewportSize`).
  - A 29-Feb date bug in `history-window.user.spec.ts:62-66`.
  - `validation.md`'s `useTestDatabase` caller list omits `monitors.integration.test.ts`.

### Tests that are genuinely strong (protect them)

- **Cross-user denial for every resource**, indistinguishable from "missing": lists, strategies,
  backtests (including `/progress`), monitors, recent searches. SYSTEM built-ins answer 403 to
  customers.
- **Entitlement race tests:** 4 parallel submissions give exactly `[202,403,403,403]`, plus the
  list-size race.
- **Stripe webhooks:** duplicate, concurrent, stale, out-of-order and tampered deliveries.
- **Lease recovery** for backtest jobs and the monitor scan schedule.
- **Engine checks:** annual windows equal the continuous run.
- **Contract checks:** OpenAPI contract test, rate-limit coverage test, and a test proving that
  live-provider suites are gated.

---

## 8. Production / Operations Findings

### Code changes needed (covered above)

H-6 (config fail-fast and baked API URL), H-7 (session revocation), H-8 (headers), H-9 (lockfile
and migrate diff), C-2 (lease recovery), C-4 (market-overview backoff).

**Images are dev-grade (P2):**
- single-stage;
- run as root;
- ship dev dependencies;
- no `NODE_ENV`;
- `pnpm` as PID 1.

The last point is a problem because SIGTERM may not reach Nest's shutdown hooks or the worker
supervisor's drain logic. That logic exists and is good. Use a multi-stage build, `USER node`, and
`node dist/…` (or `tini`) as the entrypoint.

`builtins:bootstrap` runs through `tsx`, so the deploy image needs dev dependencies or a compiled
script.

### Deployment / configuration tasks (not code; nothing here could be verified for production)

**1. Pick the platform.** The repo has no deploy configuration at all.
- Web and API must share a registrable domain (for example `app.` and `api.`), because the
  session cookie is `SameSite=Lax`.

**2. Deploy order:**
1. `pnpm db:migrate:deploy`
2. `pnpm builtins:bootstrap`
3. Start API and worker.
4. Run `pnpm db:seed` once, with `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

**3. Environment variables:**
- `NODE_ENV=production` everywhere. It drives Secure cookies and the Stripe live/sandbox guard.
- A unique `AUTH_JWT_SECRET`.
- `DATABASE_URL`, `REDIS_URL`, `FMP_API_KEY`, `WEB_BASE_URL`, `CORS_ORIGINS`.
- The full SMTP group. Without it, password accounts cannot be verified.
- `NEXT_PUBLIC_API_BASE_URL` **at web build time**.
- `RATE_LIMIT_TRUSTED_PROXY_HOPS` set to the real proxy count. Left at 0 behind a load balancer,
  every guest shares one IP bucket and auth locks out.
- `STOCK_CACHE_MAX_RESIDENT_STOCKS` sized per §6.

**4. Google.**
- The `GOOGLE_*` trio, with the production callback registered in Google Console.
- Only after B-1 is fixed.

**5. Stripe.**
- Live keys, the four live price ids, and this environment's own `whsec`.
- The webhook subscribed to exactly the handled events.
- Portal with plan switching off and cancel at period end.
- Then run `pnpm billing:verify-catalog` and `pnpm billing:reconcile -- --all --dry-run`.

**6. Probes and monitoring.**
- Liveness → `/health`, readiness → `/health/ready`. The latter probes Postgres and Redis.
- The worker has no HTTP probe. Alert on `MonitorScanSchedule.lastCompletedAt` age and
  `consecutiveFailures`, and on `BacktestRun` rows in-flight for longer than N hours.

**7. Backups.** PostgreSQL is the only durable store; Redis can be lost at any time. Confirm
point-in-time recovery on the managed database before launch.

**8. Never set** `BACKTEST_DEBUG_ARCHIVE` in production. The QA seeders already refuse production.

### Verified fine operationally

- Monitor scans use a singleton `MonitorScanSchedule` claim (`SKIP LOCKED` plus lease), so several
  worker instances are safe.
- Backtest jobs likewise, with ownership-guarded writes.
- API `enableShutdownHooks`. The supervisor forwards SIGTERM with a grace period, and children
  release their leases.
- Structured logging without secrets or query strings.
- No stack traces in 500 bodies.
- Stripe partially configured → fails at boot. Stripe fully absent → billing cleanly disabled.

---

## 9. Things I Would NOT Change Before Release

**Architecture:**
- **The durable PostgreSQL claim/lease idiom** for backtests and monitor scans. Do not add a
  queue, a cron or a Redis lock. It is correct and tested.
- **Redis as a disposable projection, and wide-column calculated-series storage.** Both are
  documented decisions with budgets.
- **Entitlement architecture:** central resolver, guards at canonical boundaries, per-user
  advisory lock, persona-based E2E.
- **The one-way Stripe direction** and the single `changeUserPlan` writer.
- **The Monitor lifecycle reducer and fingerprinting**, apart from the narrow C-5 staleness check
  post-launch.
- **Strategy definition v2 with read-time upgrade** of v1. Do not migrate stored rows.
- **`SP500` = SPY proxy for backtests and `SP500_INDEX` for the Dashboard.** Leave the split
  as is.

**Frontend:**
- **Client-rendered app shell with hand-rolled fetch hooks.** Do not migrate to React Query or
  server components now. The race handling (request ids, abort, sequence guards, terminal latches)
  is careful and correct.
- **The Dashboard composition:** 5-card strip, VIX gauge, signals-first.
- **Desktop-table / mobile-card dual compositions.**
- **Navigation order** (desktop and mobile differ intentionally; see `navigation.ts:1-11`).

**Deferred consolidation (post-launch):** unifying the four segmented controls, deduplicating the
chart palette, and extracting a generic fetch hook. Each is real but cosmetic. Doing them now
touches many surfaces for no user-visible gain.

**Features to leave out of this release:**
- a public pricing page;
- guest demo backtests;
- a Margin-of-Safety column on the Dashboard.

All three are product scope, not launch requirements.

---

## 10. Recommended Release Plan

### Phase A: must fix (about 3–5 focused days)

1. B-1: Google adoption clears an unverified password.
2. H-6: config fail-fast plus the baked `NEXT_PUBLIC_API_BASE_URL`.
3. H-1: route every mutation error through `requestFailureMessage`.
4. H-2: guest "Backtest this …" uses the prompt; implement `?next=` or fix the prompt copy.
5. H-3: blocked status on Monitor detail.
6. H-4: `error.tsx` / `global-error.tsx` / `not-found.tsx`.
7. H-5: Dashboard stock column at 1280.
8. H-8: headers and logo route hardening.
9. H-9: frozen lockfile and migrate-diff in CI.
10. H-7: session revocation, or an explicit recorded decision to launch on the 8 h TTL.

### Phase B: final QA and polish

1. H-10: make E2E green and hermetic; add it to CI.
2. C-1 (benchmark year keys) and C-2 (lease recovery timer). Both are small and remove silent or
   stuck states.
3. The cheap §5 items:
   - `/stocks` redirect;
   - built-in back links;
   - state vocabulary;
   - mobile "Why" alignment and 360 labels;
   - resting chart legend.
4. Raise `STOCK_CACHE_MAX_RESIDENT_STOCKS` for production.

### Phase C: production configuration

§8 checklist: platform, domains, env, Stripe live configuration, Google Console, SMTP, backups,
probes and alerts.

### Phase D: smoke test on the production-like environment

- Register → verify email → sign in; reset password.
- Google sign-in (new account, and linking to an existing verified account).
- FREE limits: 11-stock list, second backtest, second monitor.
- Checkout Starter → webhook → plan; Portal cancel → end-of-period.
- Create strategy → backtest (real data, 5y) → result; create monitor → wait one scan cycle →
  Dashboard.
- Guest: browse built-ins, prompts.
- Mobile pass at 390 on a real phone.

### Phase E: deploy

Deploy in the order in §8. Watch `monitor.cycle.*`, `backtest.*`, provider-gate and 5xx logs for
the first 24 h.

---

## 11. Post-Release Backlog

- C-4 market-overview backoff (do it earlier if the provider proves flaky), C-3 bulk orphan
  sweep, C-5 items.
- Paginate `GET /backtests`; search relevance before truncation; Redis `commandTimeout`.
- Login-CSRF hardening, registration enumeration decision, signed OAuth transaction cookie,
  generic readiness body.
- Production-grade Docker images, if not done in Phase A.
- Full application CSP.
- A shared `SegmentedControl`, a `lib/format` module, one chart palette, a disclosure-pattern
  `AccountMenu`, modal focus return, typeahead stale-Enter guard, pause the Dashboard poll in
  hidden tabs.
- Per-signal valuation context on the Dashboard (V1's margin-of-safety bar) and member-symbol
  previews on List collections.
- Public pricing page; guest demo backtests.
- E2E: a11y smoke, touch device project, real progressive-run assertions, persona run pruning.
- Update stale docs (rate limiting in `authentication.md` / `entitlements.md`,
  `validation.md` caller list, the `ui-system.md` hex claim).

---

## Prioritization Table

| ID | Area | Finding | Priority | Effort | Release requirement? |
| --- | --- | --- | --- | --- | --- |
| B-1 | Auth | Google adoption keeps a pre-registered account's password | P0 | S | Yes (if Google is enabled) |
| H-1 | Frontend | Plan/rate-limit refusals shown as "try again" | P1 | S | Yes |
| H-2 | Frontend/Auth | Guest "Backtest this" bounces to /login; prompt's "come back" not implemented | P1 | S–M | Yes |
| H-3 | Frontend | Monitor detail hides "Not scanning" | P1 | S | Yes |
| H-4 | Frontend | No error boundary / styled 404 | P1 | S | Yes |
| H-5 | Visual | Dashboard stock column collapses at 1280 | P1 | S | Yes |
| H-6 | Ops/Config | Baked localhost API URL; silent localhost/SMTP defaults | P1 | S | Yes |
| H-7 | Auth | No session revocation (doc: must-do) | P1 | M | Yes, or record a decision |
| H-8 | Security | No security headers; logo SVG served unsandboxed | P1 | S | Yes |
| H-9 | CI/Ops | Unfrozen lockfile; no migration drift check | P1 | S | Yes |
| H-10 | Tests | E2E 7 failures, not provider-free | P1 | M | Yes (as release gate) |
| C-1 | Data | Benchmark year keys can be truncated under concurrency | P2 | S | Recommended |
| C-2 | Worker | Crashed-run lease recovered only by idle child | P2 | S | Recommended |
| C-3 | Worker | Orphan sweep per-row in a 5 s transaction | P2 | S | No |
| C-4 | API | market-overview has no failure backoff | P2 | S–M | No |
| U-1 | UX | Signal-state vocabulary differs across surfaces | P2 | S | No |
| U-2 | Mobile | Right-aligned "Why"; signals below fold; 360 clipping | P2 | S | No |
| U-3 | UX | Built-in detail back links always "Dashboard" | P2 | S | No |
| U-4 | UX | Chart overlays unlabeled at rest | P2 | S–M | No |
| U-5 | UX | `/stocks` developer placeholder | P2 | S | No (trivial) |
| U-6 | UX | Modal focus, prompt during session load, expired session, stale typeahead Enter | P2 | S–M | No |
| U-7 | Frontend | Date/percent formatting drift | P2 | M | No |
| S-1 | Security | Login CSRF via form-encoded bodies | P2 | S | No |
| S-2 | Security | Registration/resend account enumeration | P2 | M | No |
| O-1 | Ops | Dev-grade Docker images, pnpm as PID 1 | P2 | M | If deploying these images |
| O-2 | Config | Resident-stock cache default = one PRO list | P2 | S | Config only |
| T-1 | Tests | Shared test DB between `pnpm test` and E2E; unscoped job claims | P2 | S–M | No |
| T-2 | Tests | Real-clock Redis tests / 5 s timeouts under load | P2 | S | No |
| T-3 | Tests | Progressive-run E2E tests are hollow; persona run accumulation | P2 | M | No |
| T-4 | Tests | Intermittent `backtests.integration` 404 (not reproduced) | P2 | S | Investigate |
| C-5 | Domain | Fingerprint ignores kind/rule ids; duplicate transitions; `dashboardVisible` | P3 | S | No |
| P-1 | Perf | `GET /backtests` unpaginated (40 KB / 72 runs today) | P3 | S–M | No |
| P-2 | Perf | Search truncates before relevance; Redis no command timeout | P3 | S | No |
| M-1 | Code | Duplicated segmented control / chart palette / statusTone / AccountMenu a11y | P3 | M | No |
| U-8 | UX | Admin denied page unstyled; "1 stocks"; comped-Pro "Upgrade to Starter"; guest 401 console error | P3 | S | No |
| D-1 | Docs | Stale rate-limit and validation docs | P3 | S | No |

**Counts:** P0 = 1 · P1 = 10 · P2 = 19 · P3 = 6 (rows).

---

## Second-pass notes (what was downgraded, and why)

- **Frontend reviewer's "logo proxy SVG" (P1):** merged into H-8. The likelihood is low; it
  stays P1 only because the whole header fix is small.
- **`GET /backtests` payload (P2 → P3):** measured at 40 KB / 56 ms for 72 runs.
- **Web Docker image API URL:** kept at P1 rather than P0, because the repo has no deploy
  configuration. It is a blocker only if these images are what ships.
- **Session revocation (H-7):** P1 rather than P0. Its exposure is bounded by the 8 h TTL, but
  your own document calls it must-do, so it needs either the fix or a recorded decision.
- **Nav order differences, the "Real-time Matches" label, the Dashboard h1:** not raised as
  defects. The first two are documented decisions; the third is only mentioned for phones.
- **The memory-noted "stuck RUNNING after SIGKILL":** not a product bug in itself. Those rows were
  2099-lease fixtures. The real product-level variant is C-2.
- **Areas checked with no defect found:**
  - ownership filters on every List/Strategy/Monitor/Backtest read and write;
  - admin-only SYSTEM mutations;
  - guest gating of mutation routes;
  - entitlement guards inside the writing transaction;
  - Stripe signature, idempotency and refetch;
  - backtest snapshot immutability;
  - rebind `configVersion` fencing;
  - no guest-UI flash for signed-in users;
  - no horizontal overflow at any width.

## Could not verify

- **Anything about the real production environment** (hosting, DNS, cookies, Stripe Dashboard,
  Google Console, SMTP, backups). No deploy configuration exists in the repo.
- **Live Stripe Checkout / Portal round trip.** It was not re-run in this audit; the
  sandbox-verified runbook exists.
- **Google sign-in in a browser.** B-1 is established from code and the existing integration test,
  not reproduced live.
- **FMP behaviours:**
  - whether a provisional intraday bar is stored as END_OF_DAY;
  - whether `^VIX` rows always carry numeric volume.
- **Real-latency thresholds** for C-1 (race window), C-3 (orphan count that hits 5 s) and O-2
  (thrash cost).
- **Root cause of the intermittent `backtests.integration` 404** (T-4). It passed on re-run.
- **Real iOS/Android devices.** Mobile was inspected with Chromium device emulation (390/360,
  touch, DPR 2), not real hardware.
- **Deployed V1 behind sign-in.** Only guest surfaces were compared.

**Environment note:** eleven stale `nest start --watch` processes from earlier sessions were
running during the audit. Killing them was declined. One of them, rather than the API I started,
won port 3001 during the E2E run. I verified that it served `intrinsic_value_test`, so the E2E
results stand. I later stopped that one child process. The remaining stale watchers are still
running.
