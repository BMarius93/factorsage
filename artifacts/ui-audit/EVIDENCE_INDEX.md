# UI audit evidence index

Generated from `manifest.json` (642 screenshots).

#### admin/ (5)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `master-admin-desktop-1440.png` | master | 1440x900 | /admin as ADMIN | — |
| `master-admin-mobile-390.png` | master | 390x844 | /admin as ADMIN | — |
| `master-admin-tablet-1024.png` | master | 1024x768 | /admin as ADMIN | — |
| `pro-admin-access-denied-desktop-1440.png` | pro | 1440x900 | Non-admin opens /admin | — |
| `pro-admin-access-denied-mobile-390.png` | pro | 390x844 | Non-admin opens /admin | — |

#### auth/ (70)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `after-sign-out-desktop-1440.png` | free-empty | 1440x900 | Immediately after Sign out | — |
| `forgot-password-default-desktop-1440.png` | guest | 1440x900 | Password recovery request form | — |
| `forgot-password-default-mobile-390.png` | guest | 390x844 | Password recovery request form | — |
| `forgot-password-default-tablet-1024.png` | guest | 1024x768 | Password recovery request form | — |
| `forgot-password-submitted-desktop-1440.png` | guest | 1440x900 | Recovery request accepted (neutral) | POST /auth/forgot-password → 202 (mocked; no email) |
| `forgot-password-submitted-mobile-390.png` | guest | 390x844 | Recovery request accepted (neutral) | POST /auth/forgot-password → 202 (mocked; no email) |
| `free-limit-account-menu-open-desktop-1440.png` | free-limit | 1440x900 | Account menu / guest topbar | — |
| `guest-account-menu-open-desktop-1440.png` | guest | 1440x900 | Account menu / guest topbar | — |
| `guest-bounced-from-protected-route-desktop-1440.png` | guest | 1440x900 | Guest opens /strategies/new → RequireAuth | — |
| `guest-bounced-from-protected-route-mobile-390.png` | guest | 390x844 | Guest opens /strategies/new → RequireAuth | — |
| `login-default-desktop-1440.png` | guest | 1440x900 | Sign in, Google not configured (hermetic stack) | — |
| `login-default-mobile-390.png` | guest | 390x844 | Sign in, Google not configured (hermetic stack) | — |
| `login-default-tablet-1024.png` | guest | 1024x768 | Sign in, Google not configured (hermetic stack) | — |
| `login-empty-submit-desktop-1440.png` | guest | 1440x900 | Submit with empty fields | — |
| `login-empty-submit-mobile-390.png` | guest | 390x844 | Submit with empty fields | — |
| `login-invalid-credentials-desktop-1440.png` | guest | 1440x900 | Invalid credentials (real API 401) | — |
| `login-invalid-credentials-mobile-390.png` | guest | 390x844 | Invalid credentials (real API 401) | — |
| `login-oauth-link-refused-desktop-1440.png` | guest | 1440x900 | Returned from Google with ?error=oauth_link_not_allowed | — |
| `login-oauth-link-refused-mobile-390.png` | guest | 390x844 | Returned from Google with ?error=oauth_link_not_allowed | — |
| `login-oauth-provider-error-desktop-1440.png` | guest | 1440x900 | Returned from Google with ?error=oauth_provider | — |
| `login-oauth-provider-error-mobile-390.png` | guest | 390x844 | Returned from Google with ?error=oauth_provider | — |
| `login-rate-limited-desktop-1440.png` | guest | 1440x900 | Sign-in refused with 429 | POST /auth/login → 429 |
| `login-rate-limited-mobile-390.png` | guest | 390x844 | Sign-in refused with 429 | POST /auth/login → 429 |
| `login-submitting-desktop-1440.png` | guest | 1440x900 | Sign-in request in flight | POST /auth/login hangs |
| `login-submitting-mobile-390.png` | guest | 390x844 | Sign-in request in flight | POST /auth/login hangs |
| `login-with-google-desktop-1440.png` | guest | 1440x900 | Sign in with Google offered | GET /auth/providers → {google:true} |
| `login-with-google-mobile-390.png` | guest | 390x844 | Sign in with Google offered | GET /auth/providers → {google:true} |
| `master-account-menu-open-desktop-1440.png` | master | 1440x900 | Account menu / guest topbar | — |
| `pro-account-menu-open-desktop-1440.png` | pro | 1440x900 | Account menu open | — |
| `pro-account-menu-open-mobile-390.png` | pro | 390x844 | Account menu open | — |
| `pro-visits-login-while-signed-in-desktop-1440.png` | pro | 1440x900 | Signed-in user opens /login | — |
| `pro-visits-login-while-signed-in-mobile-390.png` | pro | 390x844 | Signed-in user opens /login | — |
| `register-default-desktop-1440.png` | guest | 1440x900 | Create account form (email only) | — |
| `register-default-mobile-390.png` | guest | 390x844 | Create account form (email only) | — |
| `register-default-tablet-1024.png` | guest | 1024x768 | Create account form (email only) | — |
| `register-invalid-email-desktop-1440.png` | guest | 1440x900 | Malformed email submitted | — |
| `register-invalid-email-mobile-390.png` | guest | 390x844 | Malformed email submitted | — |
| `register-server-error-desktop-1440.png` | guest | 1440x900 | Registration request failed (500) | POST /auth/register → 500 |
| `register-server-error-mobile-390.png` | guest | 390x844 | Registration request failed (500) | POST /auth/register → 500 |
| `register-submitted-desktop-1440.png` | guest | 1440x900 | Registration accepted (neutral confirmation) | POST /auth/register → 202 (mocked; no email) |
| `register-submitted-mobile-390.png` | guest | 390x844 | Registration accepted (neutral confirmation) | POST /auth/register → 202 (mocked; no email) |
| `register-with-google-desktop-1440.png` | guest | 1440x900 | Create account with Google offered | GET /auth/providers → {google:true} |
| `register-with-google-mobile-390.png` | guest | 390x844 | Create account with Google offered | GET /auth/providers → {google:true} |
| `reset-password-form-desktop-1440.png` | guest | 1440x900 | Reset link opened: new password form | — |
| `reset-password-form-mobile-390.png` | guest | 390x844 | Reset link opened: new password form | — |
| `reset-password-form-tablet-1024.png` | guest | 1024x768 | Reset link opened: new password form | — |
| `reset-password-invalid-token-desktop-1440.png` | guest | 1440x900 | Reset link rejected (401) | POST /auth/reset-password → 401 |
| `reset-password-invalid-token-mobile-390.png` | guest | 390x844 | Reset link rejected (401) | POST /auth/reset-password → 401 |
| `reset-password-no-token-desktop-1440.png` | guest | 1440x900 | Reset page opened without a token | — |
| `reset-password-no-token-mobile-390.png` | guest | 390x844 | Reset page opened without a token | — |
| `reset-password-no-token-tablet-1024.png` | guest | 1024x768 | Reset page opened without a token | — |
| `reset-password-success-desktop-1440.png` | guest | 1440x900 | Password reset complete | POST /auth/reset-password → 200 |
| `reset-password-success-mobile-390.png` | guest | 390x844 | Password reset complete | POST /auth/reset-password → 200 |
| `starter-limit-account-menu-open-desktop-1440.png` | starter-limit | 1440x900 | Account menu / guest topbar | — |
| `verify-email-invalid-token-desktop-1440.png` | guest | 1440x900 | Expired/used/unknown link (401) | POST /auth/verify-email → 401 |
| `verify-email-invalid-token-mobile-390.png` | guest | 390x844 | Expired/used/unknown link (401) | POST /auth/verify-email → 401 |
| `verify-email-mismatch-desktop-1440.png` | guest | 1440x900 | Password confirmation mismatch (client-side) | — |
| `verify-email-mismatch-mobile-390.png` | guest | 390x844 | Password confirmation mismatch (client-side) | — |
| `verify-email-no-token-desktop-1440.png` | guest | 1440x900 | Verification page opened without a token | — |
| `verify-email-no-token-mobile-390.png` | guest | 390x844 | Verification page opened without a token | — |
| `verify-email-no-token-tablet-1024.png` | guest | 1024x768 | Verification page opened without a token | — |
| `verify-email-resend-submitted-desktop-1440.png` | guest | 1440x900 | Resend verification link submitted | POST /auth/resend-verification → 202 (mocked; no email) |
| `verify-email-resend-submitted-mobile-390.png` | guest | 390x844 | Resend verification link submitted | POST /auth/resend-verification → 202 (mocked; no email) |
| `verify-email-set-password-desktop-1440.png` | guest | 1440x900 | Verification link opened: choose password form | — |
| `verify-email-set-password-mobile-390.png` | guest | 390x844 | Verification link opened: choose password form | — |
| `verify-email-set-password-tablet-1024.png` | guest | 1024x768 | Verification link opened: choose password form | — |
| `verify-email-success-desktop-1440.png` | guest | 1440x900 | Verified and password set | POST /auth/verify-email → 200 |
| `verify-email-success-mobile-390.png` | guest | 390x844 | Verified and password set | POST /auth/verify-email → 200 |
| `verify-email-too-short-desktop-1440.png` | guest | 1440x900 | Password below minimum length | — |
| `verify-email-too-short-mobile-390.png` | guest | 390x844 | Password below minimum length | — |

#### backtests/ (96)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `downgraded-collection-desktop-1440.png` | downgraded | 1440x900 | /backtests as downgraded (real seeded data) | — |
| `downgraded-collection-mobile-390.png` | downgraded | 390x844 | /backtests as downgraded (real seeded data) | — |
| `downgraded-collection-tablet-1024.png` | downgraded | 1024x768 | /backtests as downgraded (real seeded data) | — |
| `downgraded-result-historic-summary-only-desktop-1440.png` | downgraded | 1440x900 | Completed 20-year run with summary but no curve/trades (fixture) | — |
| `downgraded-result-historic-summary-only-mobile-390.png` | downgraded | 390x844 | Completed 20-year run with summary but no curve/trades (fixture) | — |
| `free-empty-collection-desktop-1440.png` | free-empty | 1440x900 | /backtests as free-empty (real seeded data) | — |
| `free-empty-collection-mobile-390.png` | free-empty | 390x844 | /backtests as free-empty (real seeded data) | — |
| `free-empty-collection-tablet-1024.png` | free-empty | 1024x768 | /backtests as free-empty (real seeded data) | — |
| `free-empty-new-initial-desktop-1440.png` | free-empty | 1440x900 | New backtest with no own content (built-ins available) | — |
| `free-empty-new-initial-mobile-390.png` | free-empty | 390x844 | New backtest with no own content (built-ins available) | — |
| `free-empty-new-prerequisites-missing-desktop-1440.png` | free-empty | 1440x900 | No strategies or lists at all → prerequisites notice | GET /strategies → []; GET /lists → [] |
| `free-empty-new-prerequisites-missing-mobile-390.png` | free-empty | 390x844 | No strategies or lists at all → prerequisites notice | GET /strategies → []; GET /lists → [] |
| `free-limit-collection-desktop-1440.png` | free-limit | 1440x900 | /backtests as free-limit (real seeded data) | — |
| `free-limit-collection-mobile-390.png` | free-limit | 390x844 | /backtests as free-limit (real seeded data) | — |
| `free-limit-collection-tablet-1024.png` | free-limit | 1024x768 | /backtests as free-limit (real seeded data) | — |
| `free-limit-new-concurrency-refused-desktop-1440.png` | free-limit | 1440x900 | Submit while a run is in flight → real 403 (nothing created) | — |
| `free-limit-new-concurrency-refused-mobile-390.png` | free-limit | 390x844 | Submit while a run is in flight → real 403 (nothing created) | — |
| `free-limit-new-refused-viewport-after-tap-mobile-390.png` | free-limit | 390x844 | Viewport right after tapping Run in the sticky bar (error rect {"top":1216,"bottom":1280,"vh":844,"scrollY":0}) | — |
| `free-limit-result-running-desktop-1440.png` | free-limit | 1440x900 | Running at 42% (pinned fixture run, polled each second) | — |
| `free-limit-result-running-mobile-390.png` | free-limit | 390x844 | Running at 42% (pinned fixture run, polled each second) | — |
| `free-limit-result-running-tablet-1024.png` | free-limit | 1024x768 | Running at 42% (pinned fixture run, polled each second) | — |
| `free-normal-collection-desktop-1440.png` | free-normal | 1440x900 | /backtests as free-normal (real seeded data) | — |
| `free-normal-collection-mobile-390.png` | free-normal | 390x844 | /backtests as free-normal (real seeded data) | — |
| `free-normal-collection-tablet-1024.png` | free-normal | 1024x768 | /backtests as free-normal (real seeded data) | — |
| `free-normal-new-history-limit-refused-desktop-1440.png` | free-normal | 1440x900 | MAX (30y) on Free → real 403 history limit | — |
| `free-normal-new-history-limit-refused-mobile-390.png` | free-normal | 390x844 | MAX (30y) on Free → real 403 history limit | — |
| `free-normal-result-completed-desktop-1440.png` | free-normal | 1440x900 | Completed 2-year result (Free) | — |
| `free-normal-result-completed-mobile-390.png` | free-normal | 390x844 | Completed 2-year result (Free) | — |
| `guest-collection-desktop-1440.png` | guest | 1440x900 | /backtests as guest (real seeded data) | — |
| `guest-collection-mobile-390.png` | guest | 390x844 | /backtests as guest (real seeded data) | — |
| `guest-collection-tablet-1024.png` | guest | 1024x768 | /backtests as guest (real seeded data) | — |
| `master-collection-desktop-1440.png` | master | 1440x900 | /backtests as master (real seeded data) | — |
| `master-collection-mobile-390.png` | master | 390x844 | /backtests as master (real seeded data) | — |
| `master-collection-tablet-1024.png` | master | 1024x768 | /backtests as master (real seeded data) | — |
| `pro-collection-60-runs-desktop-1440.png` | pro | 1440x900 | 60 runs, long strategy name, extreme returns | GET /backtests (synthetic, 60 rows) |
| `pro-collection-60-runs-mobile-390.png` | pro | 390x844 | 60 runs, long strategy name, extreme returns | GET /backtests (synthetic, 60 rows) |
| `pro-collection-desktop-1440.png` | pro | 1440x900 | /backtests as pro (real seeded data) | — |
| `pro-collection-error-desktop-1440.png` | pro | 1440x900 | GET /backtests → 500 | GET /backtests → 500 |
| `pro-collection-error-mobile-390.png` | pro | 390x844 | GET /backtests → 500 | GET /backtests → 500 |
| `pro-collection-every-status-desktop-1440.png` | pro | 1440x900 | One run in each status (QUEUED…FAILED) | GET /backtests (synthetic, from real rows) |
| `pro-collection-every-status-mobile-390.png` | pro | 390x844 | One run in each status (QUEUED…FAILED) | GET /backtests (synthetic, from real rows) |
| `pro-collection-loading-desktop-1440.png` | pro | 1440x900 | GET /backtests pending | GET /backtests hangs |
| `pro-collection-loading-mobile-390.png` | pro | 390x844 | GET /backtests pending | GET /backtests hangs |
| `pro-collection-mobile-390.png` | pro | 390x844 | /backtests as pro (real seeded data) | — |
| `pro-collection-tablet-1024.png` | pro | 1024x768 | /backtests as pro (real seeded data) | — |
| `pro-heavy-collection-boundary-879.png` | pro-heavy | 879x900 | /backtests as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-boundary-880.png` | pro-heavy | 880x900 | /backtests as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1280.png` | pro-heavy | 1280x800 | /backtests as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1440.png` | pro-heavy | 1440x900 | /backtests as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-mobile-390.png` | pro-heavy | 390x844 | /backtests as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-table-scrolled-right-desktop-1440.png` | pro-heavy | 1440x900 | Same table scrolled horizontally inside its surface to reveal the Actions column | — |
| `pro-heavy-collection-tablet-1024.png` | pro-heavy | 1024x768 | /backtests as pro-heavy (real seeded data) | — |
| `pro-heavy-new-initial-boundary-879.png` | pro-heavy | 879x900 | New backtest, initial state (defaults) | — |
| `pro-heavy-new-initial-boundary-880.png` | pro-heavy | 880x900 | New backtest, initial state (defaults) | — |
| `pro-heavy-new-initial-desktop-1280.png` | pro-heavy | 1280x800 | New backtest, initial state (defaults) | — |
| `pro-heavy-new-initial-desktop-1440.png` | pro-heavy | 1440x900 | New backtest, initial state (defaults) | — |
| `pro-heavy-new-initial-mobile-390.png` | pro-heavy | 390x844 | New backtest, initial state (defaults) | — |
| `pro-heavy-new-initial-tablet-1024.png` | pro-heavy | 1024x768 | New backtest, initial state (defaults) | — |
| `pro-heavy-new-load-error-desktop-1440.png` | pro-heavy | 1440x900 | GET /strategies → 500 on the form | GET /strategies → 500 |
| `pro-heavy-new-load-error-mobile-390.png` | pro-heavy | 390x844 | GET /strategies → 500 on the form | GET /strategies → 500 |
| `pro-heavy-new-loading-desktop-1440.png` | pro-heavy | 1440x900 | Options loading (GET /benchmarks pending) | GET /benchmarks hangs |
| `pro-heavy-new-loading-mobile-390.png` | pro-heavy | 390x844 | Options loading (GET /benchmarks pending) | GET /benchmarks hangs |
| `pro-heavy-new-prefilled-max-desktop-1440.png` | pro-heavy | 1440x900 | Prefilled via ?strategyId&stockListId, MAX pressed (30 years) | — |
| `pro-heavy-new-prefilled-max-mobile-390.png` | pro-heavy | 390x844 | Prefilled via ?strategyId&stockListId, MAX pressed (30 years) | — |
| `pro-heavy-new-submitting-mobile-390.png` | pro-heavy | 390x844 | Submit in flight (POST mocked to hang; nothing sent) | POST /backtests hangs |
| `pro-heavy-new-validation-desktop-1440.png` | pro-heavy | 1440x900 | Run pressed with nothing selected + invalid numbers (focus stays on button) | — |
| `pro-heavy-new-validation-mobile-390.png` | pro-heavy | 390x844 | Run pressed with nothing selected + invalid numbers (focus stays on button) | — |
| `pro-heavy-result-01343e62-desktop-1440.png` | pro-heavy | 1440x900 | Completed: Trend confirmation (2023-09-19→2026-09-19, trades vary) | — |
| `pro-heavy-result-2ee631cd-desktop-1440.png` | pro-heavy | 1440x900 | Completed: RSI mean reversion (2025-09-19→2026-09-19, trades vary) | — |
| `pro-heavy-result-3fdc682c-desktop-1440.png` | pro-heavy | 1440x900 | Completed: Trend confirmation (2021-09-19→2026-09-19, trades vary) | — |
| `pro-heavy-result-95e90c9b-desktop-1440.png` | pro-heavy | 1440x900 | Completed: RSI mean reversion (2023-09-19→2026-09-19, trades vary) | — |
| `pro-heavy-result-chart-crosshair-desktop-1440.png` | pro-heavy | 1440x900 | Chart crosshair legend | — |
| `pro-heavy-result-chart-crosshair-mobile-390.png` | pro-heavy | 390x844 | Chart crosshair legend | — |
| `pro-heavy-result-completed-boundary-879.png` | pro-heavy | 879x900 | Completed result (3y, contributions) | — |
| `pro-heavy-result-completed-boundary-880.png` | pro-heavy | 880x900 | Completed result (3y, contributions) | — |
| `pro-heavy-result-completed-desktop-1280.png` | pro-heavy | 1280x800 | Completed result (3y, contributions) | — |
| `pro-heavy-result-completed-desktop-1440.png` | pro-heavy | 1440x900 | Completed result (3y, contributions) | — |
| `pro-heavy-result-completed-mobile-390.png` | pro-heavy | 390x844 | Completed result (3y, contributions) | — |
| `pro-heavy-result-completed-tablet-1024.png` | pro-heavy | 1024x768 | Completed result (3y, contributions) | — |
| `pro-heavy-result-configuration-expanded-desktop-1440.png` | pro-heavy | 1440x900 | Run configuration disclosure opened | — |
| `pro-heavy-result-configuration-expanded-mobile-390.png` | pro-heavy | 390x844 | Run configuration disclosure opened | — |
| `pro-heavy-result-e4515843-desktop-1440.png` | pro-heavy | 1440x900 | Completed: Margin-of-safety ladder with RSI confirmation, staged profit taking and three alternative final-exit rules (2024-09-19→2026-09-19, trades vary) | — |
| `pro-heavy-result-failed-1-desktop-1440.png` | pro-heavy | 1440x900 | Failed run (Blue chips) | — |
| `pro-heavy-result-failed-1-mobile-390.png` | pro-heavy | 390x844 | Failed run (Blue chips) | — |
| `pro-heavy-result-failed-2-desktop-1440.png` | pro-heavy | 1440x900 | Failed run (At the Pro limit — 100 symbols) | — |
| `pro-heavy-result-failed-2-mobile-390.png` | pro-heavy | 390x844 | Failed run (At the Pro limit — 100 symbols) | — |
| `pro-heavy-result-not-found-desktop-1440.png` | pro-heavy | 1440x900 | Unknown run id | — |
| `pro-heavy-result-queued-desktop-1440.png` | pro-heavy | 1440x900 | Queued run (mocked from the real running run) | GET /backtests/:id(+/progress) → QUEUED |
| `pro-heavy-result-queued-mobile-390.png` | pro-heavy | 390x844 | Queued run (mocked from the real running run) | GET /backtests/:id(+/progress) → QUEUED |
| `starter-collection-desktop-1440.png` | starter | 1440x900 | /backtests as starter (real seeded data) | — |
| `starter-collection-mobile-390.png` | starter | 390x844 | /backtests as starter (real seeded data) | — |
| `starter-collection-tablet-1024.png` | starter | 1024x768 | /backtests as starter (real seeded data) | — |
| `starter-limit-collection-desktop-1440.png` | starter-limit | 1440x900 | /backtests as starter-limit (real seeded data) | — |
| `starter-limit-collection-mobile-390.png` | starter-limit | 390x844 | /backtests as starter-limit (real seeded data) | — |
| `starter-limit-collection-tablet-1024.png` | starter-limit | 1024x768 | /backtests as starter-limit (real seeded data) | — |
| `starter-opens-other-accounts-object-desktop-1440.png` | starter | 1440x900 | Starter opens a Pro user's private backtest URL | — |

#### billing/ (48)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `free-limit-billing-real-desktop-1440.png` | free-limit | 1440x900 | /billing against the hermetic stack (Stripe inert) | — |
| `free-limit-billing-real-mobile-390.png` | free-limit | 390x844 | /billing against the hermetic stack (Stripe inert) | — |
| `free-limit-billing-real-tablet-1024.png` | free-limit | 1024x768 | /billing against the hermetic stack (Stripe inert) | — |
| `free-limit-pricing-signed-in-desktop-1440.png` | free-limit | 1440x900 | /pricing signed in | — |
| `free-limit-pricing-signed-in-mobile-390.png` | free-limit | 390x844 | /pricing signed in | — |
| `free-limit-pricing-signed-in-tablet-1024.png` | free-limit | 1024x768 | /pricing signed in | — |
| `guest-billing-redirect-desktop-1440.png` | guest | 1440x900 | Guest opens /billing | — |
| `guest-pricing-choose-pro-prompt-desktop-1440.png` | guest | 1440x900 | Guest presses Choose Pro | — |
| `guest-pricing-monthly-desktop-1440.png` | guest | 1440x900 | Public pricing, monthly | — |
| `guest-pricing-monthly-mobile-390.png` | guest | 390x844 | Public pricing, monthly | — |
| `guest-pricing-monthly-tablet-1024.png` | guest | 1024x768 | Public pricing, monthly | — |
| `guest-pricing-yearly-desktop-1440.png` | guest | 1440x900 | Public pricing, yearly | — |
| `guest-pricing-yearly-mobile-390.png` | guest | 390x844 | Public pricing, yearly | — |
| `guest-pricing-yearly-tablet-1024.png` | guest | 1024x768 | Public pricing, yearly | — |
| `mock-checkout-cancelled-desktop-1440.png` | pro | 1440x900 | Returned from Checkout (cancelled) | GET /billing/status → free |
| `mock-checkout-success-settling-desktop-1440.png` | pro | 1440x900 | Returned from Checkout, still settling | status/refresh → free (webhook not yet applied) |
| `mock-checkout-success-window-expired-desktop-1440.png` | pro | 1440x900 | Settle window elapsed, still Free — copy claims confirmation | status/refresh → free |
| `mock-error-desktop-1440.png` | pro | 1440x900 | GET /billing/status → 500 | GET /billing/status → 500 |
| `mock-error-mobile-390.png` | pro | 390x844 | GET /billing/status → 500 | GET /billing/status → 500 |
| `mock-free-billing-disabled-desktop-1440.png` | pro | 1440x900 | /billing with status 'free-billing-disabled' | GET /billing/status → free-billing-disabled |
| `mock-free-canceled-pro-annual-desktop-1440.png` | pro | 1440x900 | /billing with status 'free-canceled-pro-annual' | GET /billing/status → free-canceled-pro-annual |
| `mock-free-desktop-1440.png` | pro | 1440x900 | /billing with status 'free' | GET /billing/status → free |
| `mock-free-incomplete-desktop-1440.png` | pro | 1440x900 | /billing with status 'free-incomplete' | GET /billing/status → free-incomplete |
| `mock-free-mobile-390.png` | pro | 390x844 | /billing with status 'free' | GET /billing/status → free |
| `mock-free-tablet-1024.png` | pro | 1024x768 | /billing with status 'free' | GET /billing/status → free |
| `mock-loading-desktop-1440.png` | pro | 1440x900 | GET /billing/status pending | GET /billing/status hangs |
| `mock-loading-mobile-390.png` | pro | 390x844 | GET /billing/status pending | GET /billing/status hangs |
| `mock-pricing-status-error-desktop-1440.png` | pro | 1440x900 | /pricing signed in, status → 500 | GET /billing/status → 500 |
| `mock-pricing-status-error-mobile-390.png` | pro | 390x844 | /pricing signed in, status → 500 | GET /billing/status → 500 |
| `mock-pro-annual-desktop-1440.png` | pro | 1440x900 | /billing with status 'pro-annual' | GET /billing/status → pro-annual |
| `mock-pro-cancel-pending-desktop-1440.png` | pro | 1440x900 | /billing with status 'pro-cancel-pending' | GET /billing/status → pro-cancel-pending |
| `mock-pro-monthly-desktop-1440.png` | pro | 1440x900 | /billing with status 'pro-monthly' | GET /billing/status → pro-monthly |
| `mock-pro-monthly-mobile-390.png` | pro | 390x844 | /billing with status 'pro-monthly' | GET /billing/status → pro-monthly |
| `mock-pro-monthly-tablet-1024.png` | pro | 1024x768 | /billing with status 'pro-monthly' | GET /billing/status → pro-monthly |
| `mock-pro-scheduled-downgrade-desktop-1440.png` | pro | 1440x900 | /billing with status 'pro-scheduled-downgrade' | GET /billing/status → pro-scheduled-downgrade |
| `mock-pro-unrecognised-price-desktop-1440.png` | pro | 1440x900 | /billing with status 'pro-unrecognised-price' | GET /billing/status → pro-unrecognised-price |
| `mock-starter-annual-desktop-1440.png` | pro | 1440x900 | /billing with status 'starter-annual' | GET /billing/status → starter-annual |
| `mock-starter-monthly-desktop-1440.png` | pro | 1440x900 | /billing with status 'starter-monthly' | GET /billing/status → starter-monthly |
| `mock-starter-monthly-viewing-yearly-desktop-1440.png` | pro | 1440x900 | Starter monthly customer toggles Yearly | GET /billing/status → starter-monthly |
| `mock-starter-past-due-desktop-1440.png` | pro | 1440x900 | /billing with status 'starter-past-due' | GET /billing/status → starter-past-due |
| `mock-upgrade-failed-desktop-1440.png` | pro | 1440x900 | Upgrade → POST /billing/change 503 | GET /billing/status → starter-monthly; POST /billing/change → 503 |
| `mock-upgrade-pending-desktop-1440.png` | pro | 1440x900 | Upgrade in flight ('Working…') | POST /billing/change hangs |
| `pro-billing-real-desktop-1440.png` | pro | 1440x900 | /billing against the hermetic stack (Stripe inert) | — |
| `pro-billing-real-mobile-390.png` | pro | 390x844 | /billing against the hermetic stack (Stripe inert) | — |
| `pro-billing-real-tablet-1024.png` | pro | 1024x768 | /billing against the hermetic stack (Stripe inert) | — |
| `pro-pricing-signed-in-desktop-1440.png` | pro | 1440x900 | /pricing signed in | — |
| `pro-pricing-signed-in-mobile-390.png` | pro | 390x844 | /pricing signed in | — |
| `pro-pricing-signed-in-tablet-1024.png` | pro | 1024x768 | /pricing signed in | — |

#### dashboard/ (62)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `downgraded-collection-desktop-1440.png` | downgraded | 1440x900 | /dashboard as downgraded (real seeded data) | — |
| `downgraded-collection-mobile-390.png` | downgraded | 390x844 | /dashboard as downgraded (real seeded data) | — |
| `downgraded-collection-tablet-1024.png` | downgraded | 1024x768 | /dashboard as downgraded (real seeded data) | — |
| `free-empty-collection-desktop-1440.png` | free-empty | 1440x900 | /dashboard as free-empty (real seeded data) | — |
| `free-empty-collection-mobile-390.png` | free-empty | 390x844 | /dashboard as free-empty (real seeded data) | — |
| `free-empty-collection-tablet-1024.png` | free-empty | 1024x768 | /dashboard as free-empty (real seeded data) | — |
| `free-limit-collection-desktop-1440.png` | free-limit | 1440x900 | /dashboard as free-limit (real seeded data) | — |
| `free-limit-collection-mobile-390.png` | free-limit | 390x844 | /dashboard as free-limit (real seeded data) | — |
| `free-limit-collection-tablet-1024.png` | free-limit | 1024x768 | /dashboard as free-limit (real seeded data) | — |
| `free-normal-collection-desktop-1440.png` | free-normal | 1440x900 | /dashboard as free-normal (real seeded data) | — |
| `free-normal-collection-mobile-390.png` | free-normal | 390x844 | /dashboard as free-normal (real seeded data) | — |
| `free-normal-collection-tablet-1024.png` | free-normal | 1024x768 | /dashboard as free-normal (real seeded data) | — |
| `guest-collection-desktop-1440.png` | guest | 1440x900 | /dashboard as guest (real seeded data) | — |
| `guest-collection-mobile-390.png` | guest | 390x844 | /dashboard as guest (real seeded data) | — |
| `guest-collection-tablet-1024.png` | guest | 1024x768 | /dashboard as guest (real seeded data) | — |
| `master-collection-desktop-1440.png` | master | 1440x900 | /dashboard as master (real seeded data) | — |
| `master-collection-mobile-390.png` | master | 390x844 | /dashboard as master (real seeded data) | — |
| `master-collection-tablet-1024.png` | master | 1024x768 | /dashboard as master (real seeded data) | — |
| `pro-collection-boundary-879.png` | pro | 879x900 | /dashboard as pro (real seeded data) | — |
| `pro-collection-boundary-880.png` | pro | 880x900 | /dashboard as pro (real seeded data) | — |
| `pro-collection-desktop-1280.png` | pro | 1280x800 | /dashboard as pro (real seeded data) | — |
| `pro-collection-desktop-1440.png` | pro | 1440x900 | /dashboard as pro (real seeded data) | — |
| `pro-collection-mobile-390.png` | pro | 390x844 | /dashboard as pro (real seeded data) | — |
| `pro-collection-tablet-1024.png` | pro | 1024x768 | /dashboard as pro (real seeded data) | — |
| `pro-error-desktop-1440.png` | pro | 1440x900 | GET /dashboard and /market-overview → 500 | GET /dashboard → 500; GET /market-overview → 500 |
| `pro-error-mobile-390.png` | pro | 390x844 | GET /dashboard and /market-overview → 500 | GET /dashboard → 500; GET /market-overview → 500 |
| `pro-filter-sell-waiting-empty-desktop-1440.png` | pro | 1440x900 | Action=Sell + Waiting → filtered-empty | GET /dashboard (synthetic) |
| `pro-filter-sell-waiting-empty-mobile-390.png` | pro | 390x844 | Action=Sell + Waiting → filtered-empty | GET /dashboard (synthetic) |
| `pro-filter-waiting-desktop-1440.png` | pro | 1440x900 | State filter = Waiting | GET /dashboard (synthetic) |
| `pro-filter-waiting-mobile-390.png` | pro | 390x844 | State filter = Waiting | GET /dashboard (synthetic) |
| `pro-heavy-collection-boundary-879.png` | pro-heavy | 879x900 | /dashboard as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-boundary-880.png` | pro-heavy | 880x900 | /dashboard as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1280.png` | pro-heavy | 1280x800 | /dashboard as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1440.png` | pro-heavy | 1440x900 | /dashboard as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-mobile-390.png` | pro-heavy | 390x844 | /dashboard as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-tablet-1024.png` | pro-heavy | 1024x768 | /dashboard as pro-heavy (real seeded data) | — |
| `pro-loading-desktop-1440.png` | pro | 1440x900 | GET /dashboard and /market-overview pending | GET /dashboard hangs; GET /market-overview hangs |
| `pro-loading-mobile-390.png` | pro | 390x844 | GET /dashboard and /market-overview pending | GET /dashboard hangs; GET /market-overview hangs |
| `pro-malformed-response-desktop-1440.png` | pro | 1440x900 | GET /dashboard returns an unexpected shape (render failure → error boundary) | GET /dashboard → {unexpected:true} |
| `pro-many-signals-buy-sell-exit-boundary-879.png` | pro | 879x900 | 24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names | GET /dashboard (synthetic, derived from real response) |
| `pro-many-signals-buy-sell-exit-boundary-880.png` | pro | 880x900 | 24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names | GET /dashboard (synthetic, derived from real response) |
| `pro-many-signals-buy-sell-exit-desktop-1280.png` | pro | 1280x800 | 24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names | GET /dashboard (synthetic, derived from real response) |
| `pro-many-signals-buy-sell-exit-desktop-1440.png` | pro | 1440x900 | 24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names | GET /dashboard (synthetic, derived from real response) |
| `pro-many-signals-buy-sell-exit-mobile-390.png` | pro | 390x844 | 24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names | GET /dashboard (synthetic, derived from real response) |
| `pro-many-signals-buy-sell-exit-tablet-1024.png` | pro | 1024x768 | 24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names | GET /dashboard (synthetic, derived from real response) |
| `pro-many-signals-scrolled-sideways-mobile-390.png` | pro | 390x844 | Phone page scrolled right (document 756px wide at 390px) | GET /dashboard (synthetic) |
| `pro-market-unavailable-desktop-1440.png` | pro | 1440x900 | Market overview items UNAVAILABLE (contract-true) | GET /market-overview → all UNAVAILABLE, sparkline [] |
| `pro-market-unavailable-mobile-390.png` | pro | 390x844 | Market overview items UNAVAILABLE (contract-true) | GET /market-overview → all UNAVAILABLE, sparkline [] |
| `pro-no-matches-desktop-1440.png` | pro | 1440x900 | Monitors shown, no rows | GET /dashboard (synthetic, derived from real response) |
| `pro-no-matches-mobile-390.png` | pro | 390x844 | Monitors shown, no rows | GET /dashboard (synthetic, derived from real response) |
| `pro-no-monitors-shown-desktop-1440.png` | pro | 1440x900 | No monitors shown (all hidden) | GET /dashboard (synthetic, derived from real response) |
| `pro-no-monitors-shown-mobile-390.png` | pro | 390x844 | No monitors shown (all hidden) | GET /dashboard (synthetic, derived from real response) |
| `pro-not-scanned-desktop-1440.png` | pro | 1440x900 | Monitors never scanned | GET /dashboard (synthetic, derived from real response) |
| `pro-not-scanned-mobile-390.png` | pro | 390x844 | Monitors never scanned | GET /dashboard (synthetic, derived from real response) |
| `pro-stale-desktop-1440.png` | pro | 1440x900 | Every monitor STALE (last scan yesterday) | GET /dashboard (synthetic, derived from real response) |
| `pro-stale-mobile-390.png` | pro | 390x844 | Every monitor STALE (last scan yesterday) | GET /dashboard (synthetic, derived from real response) |
| `starter-collection-desktop-1440.png` | starter | 1440x900 | /dashboard as starter (real seeded data) | — |
| `starter-collection-mobile-390.png` | starter | 390x844 | /dashboard as starter (real seeded data) | — |
| `starter-collection-tablet-1024.png` | starter | 1024x768 | /dashboard as starter (real seeded data) | — |
| `starter-limit-collection-desktop-1440.png` | starter-limit | 1440x900 | /dashboard as starter-limit (real seeded data) | — |
| `starter-limit-collection-mobile-390.png` | starter-limit | 390x844 | /dashboard as starter-limit (real seeded data) | — |
| `starter-limit-collection-tablet-1024.png` | starter-limit | 1024x768 | /dashboard as starter-limit (real seeded data) | — |

#### lists/ (100)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `downgraded-collection-desktop-1440.png` | downgraded | 1440x900 | /lists as downgraded (real seeded data) | — |
| `downgraded-collection-mobile-390.png` | downgraded | 390x844 | /lists as downgraded (real seeded data) | — |
| `downgraded-collection-tablet-1024.png` | downgraded | 1024x768 | /lists as downgraded (real seeded data) | — |
| `downgraded-over-limit-list-detail-desktop-1440.png` | downgraded | 1440x900 | 83 stocks on a Free plan: 'Over plan limit' badge (explanation only in tooltip) | — |
| `downgraded-over-limit-list-detail-mobile-390.png` | downgraded | 390x844 | 83 stocks on a Free plan: 'Over plan limit' badge (explanation only in tooltip) | — |
| `free-empty-collection-desktop-1440.png` | free-empty | 1440x900 | /lists as free-empty (real seeded data) | — |
| `free-empty-collection-mobile-390.png` | free-empty | 390x844 | /lists as free-empty (real seeded data) | — |
| `free-empty-collection-tablet-1024.png` | free-empty | 1024x768 | /lists as free-empty (real seeded data) | — |
| `free-empty-new-list-dialog-desktop-1440.png` | free-empty | 1440x900 | New list dialog opened from the empty state | — |
| `free-empty-new-list-dialog-mobile-390.png` | free-empty | 390x844 | New list dialog opened from the empty state | — |
| `free-limit-add-refused-desktop-1440.png` | free-limit | 1440x900 | Add → real 403 ENTITLEMENT_LIST_SYMBOL_LIMIT (nothing written) | — |
| `free-limit-add-refused-mobile-390.png` | free-limit | 390x844 | Add → real 403 ENTITLEMENT_LIST_SYMBOL_LIMIT (nothing written) | — |
| `free-limit-at-10-before-add-desktop-1440.png` | free-limit | 1440x900 | List at 10/10 with an 11th stock selected: no warning, Add enabled | — |
| `free-limit-at-10-before-add-mobile-390.png` | free-limit | 390x844 | List at 10/10 with an 11th stock selected: no warning, Add enabled | — |
| `free-limit-collection-desktop-1440.png` | free-limit | 1440x900 | /lists as free-limit (real seeded data) | — |
| `free-limit-collection-mobile-390.png` | free-limit | 390x844 | /lists as free-limit (real seeded data) | — |
| `free-limit-collection-tablet-1024.png` | free-limit | 1024x768 | /lists as free-limit (real seeded data) | — |
| `free-limit-new-list-11-chips-desktop-1440.png` | free-limit | 1440x900 | New list with 11 stocks chosen (limit 10): no counter | — |
| `free-limit-new-list-refused-desktop-1440.png` | free-limit | 1440x900 | Create → real 403 (nothing persisted) | — |
| `free-normal-collection-desktop-1440.png` | free-normal | 1440x900 | /lists as free-normal (real seeded data) | — |
| `free-normal-collection-mobile-390.png` | free-normal | 390x844 | /lists as free-normal (real seeded data) | — |
| `free-normal-collection-tablet-1024.png` | free-normal | 1024x768 | /lists as free-normal (real seeded data) | — |
| `free-normal-list-detail-custom-window-desktop-1440.png` | free-normal | 1440x900 | Own list with one open-ended membership period | — |
| `free-normal-list-detail-custom-window-mobile-390.png` | free-normal | 390x844 | Own list with one open-ended membership period | — |
| `free-normal-list-detail-custom-window-tablet-1024.png` | free-normal | 1024x768 | Own list with one open-ended membership period | — |
| `guest-builtin-list-detail-desktop-1440.png` | guest | 1440x900 | Built-in list read-only (with a CUSTOM membership row) | — |
| `guest-builtin-list-detail-mobile-390.png` | guest | 390x844 | Built-in list read-only (with a CUSTOM membership row) | — |
| `guest-builtin-list-detail-tablet-1024.png` | guest | 1024x768 | Built-in list read-only (with a CUSTOM membership row) | — |
| `guest-collection-desktop-1440.png` | guest | 1440x900 | /lists as guest (real seeded data) | — |
| `guest-collection-error-desktop-1440.png` | guest | 1440x900 | GET /lists → 500 as a Guest | GET /lists → 500 |
| `guest-collection-mobile-390.png` | guest | 390x844 | /lists as guest (real seeded data) | — |
| `guest-collection-tablet-1024.png` | guest | 1024x768 | /lists as guest (real seeded data) | — |
| `guest-list-not-found-desktop-1440.png` | guest | 1440x900 | Unknown list id | — |
| `guest-new-list-sign-in-prompt-desktop-1440.png` | guest | 1440x900 | Guest presses New list → SignInPrompt | — |
| `guest-new-list-sign-in-prompt-mobile-390.png` | guest | 390x844 | Guest presses New list → SignInPrompt | — |
| `master-builtin-list-editable-desktop-1440.png` | master | 1440x900 | Administrator viewing a built-in list (editable) | — |
| `master-builtin-list-editable-mobile-390.png` | master | 390x844 | Administrator viewing a built-in list (editable) | — |
| `master-builtin-row-overflow-desktop-1440.png` | master | 1440x900 | Admin: built-in row overflow | — |
| `master-collection-desktop-1440.png` | master | 1440x900 | /lists as master (real seeded data) | — |
| `master-collection-mobile-390.png` | master | 390x844 | /lists as master (real seeded data) | — |
| `master-collection-tablet-1024.png` | master | 1024x768 | /lists as master (real seeded data) | — |
| `pro-collection-desktop-1440.png` | pro | 1440x900 | /lists as pro (real seeded data) | — |
| `pro-collection-error-desktop-1440.png` | pro | 1440x900 | GET /lists → 500 | GET /lists → 500 |
| `pro-collection-error-mobile-390.png` | pro | 390x844 | GET /lists → 500 | GET /lists → 500 |
| `pro-collection-loading-desktop-1440.png` | pro | 1440x900 | GET /lists pending | GET /lists hangs |
| `pro-collection-loading-mobile-390.png` | pro | 390x844 | GET /lists pending | GET /lists hangs |
| `pro-collection-mobile-390.png` | pro | 390x844 | /lists as pro (real seeded data) | — |
| `pro-collection-tablet-1024.png` | pro | 1024x768 | /lists as pro (real seeded data) | — |
| `pro-heavy-100-symbol-list-detail-desktop-1440.png` | pro-heavy | 1440x900 | List at the Pro limit (100 stocks) | — |
| `pro-heavy-100-symbol-list-detail-mobile-390.png` | pro-heavy | 390x844 | List at the Pro limit (100 stocks) | — |
| `pro-heavy-collection-boundary-879.png` | pro-heavy | 879x900 | /lists as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-boundary-880.png` | pro-heavy | 880x900 | /lists as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1280.png` | pro-heavy | 1280x800 | /lists as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1440.png` | pro-heavy | 1440x900 | /lists as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-mobile-390.png` | pro-heavy | 390x844 | /lists as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-tablet-1024.png` | pro-heavy | 1024x768 | /lists as pro-heavy (real seeded data) | — |
| `pro-heavy-list-detail-error-desktop-1440.png` | pro-heavy | 1440x900 | GET /lists/:id → 500 | GET /lists/:id → 500 |
| `pro-heavy-list-detail-loading-desktop-1440.png` | pro-heavy | 1440x900 | GET /lists/:id pending | GET /lists/:id hangs |
| `pro-heavy-long-name-list-detail-desktop-1440.png` | pro-heavy | 1440x900 | 120-char name, 500-char description, 3-period member | — |
| `pro-heavy-long-name-list-detail-mobile-390.png` | pro-heavy | 390x844 | 120-char name, 500-char description, 3-period member | — |
| `pro-heavy-long-name-list-detail-tablet-1024.png` | pro-heavy | 1024x768 | 120-char name, 500-char description, 3-period member | — |
| `pro-heavy-membership-multi-period-readonly-desktop-1440.png` | pro-heavy | 1440x900 | Member with 3 periods: editor opens read-only | — |
| `pro-heavy-membership-multi-period-readonly-mobile-390.png` | pro-heavy | 390x844 | Member with 3 periods: editor opens read-only | — |
| `starter-45-stock-list-detail-desktop-1440.png` | starter | 1440x900 | 45-stock list (no pagination on members) | — |
| `starter-45-stock-list-detail-mobile-390.png` | starter | 390x844 | 45-stock list (no pagination on members) | — |
| `starter-collection-desktop-1440.png` | starter | 1440x900 | /lists as starter (real seeded data) | — |
| `starter-collection-mobile-390.png` | starter | 390x844 | /lists as starter (real seeded data) | — |
| `starter-collection-tablet-1024.png` | starter | 1024x768 | /lists as starter (real seeded data) | — |
| `starter-delete-confirm-desktop-1440.png` | starter | 1440x900 | Delete list confirmation | — |
| `starter-delete-confirm-mobile-390.png` | starter | 390x844 | Delete list confirmation | — |
| `starter-empty-list-detail-desktop-1440.png` | starter | 1440x900 | Own list with no stocks | — |
| `starter-empty-list-detail-mobile-390.png` | starter | 390x844 | Own list with no stocks | — |
| `starter-empty-list-detail-tablet-1024.png` | starter | 1024x768 | Own list with no stocks | — |
| `starter-limit-collection-desktop-1440.png` | starter-limit | 1440x900 | /lists as starter-limit (real seeded data) | — |
| `starter-limit-collection-mobile-390.png` | starter-limit | 390x844 | /lists as starter-limit (real seeded data) | — |
| `starter-limit-collection-tablet-1024.png` | starter-limit | 1024x768 | /lists as starter-limit (real seeded data) | — |
| `starter-member-overflow-open-desktop-1440.png` | starter | 1440x900 | Member row overflow | — |
| `starter-member-overflow-open-mobile-390.png` | starter | 390x844 | Member row overflow | — |
| `starter-membership-always-eligible-desktop-1440.png` | starter | 1440x900 | Membership editor, FULL (Always eligible) | — |
| `starter-membership-always-eligible-mobile-390.png` | starter | 390x844 | Membership editor, FULL (Always eligible) | — |
| `starter-membership-end-before-start-desktop-1440.png` | starter | 1440x900 | End before start | — |
| `starter-membership-end-before-start-mobile-390.png` | starter | 390x844 | End before start | — |
| `starter-membership-missing-start-desktop-1440.png` | starter | 1440x900 | Save without start date | — |
| `starter-membership-missing-start-mobile-390.png` | starter | 390x844 | Save without start date | — |
| `starter-membership-period-default-desktop-1440.png` | starter | 1440x900 | Switched to Membership period (Present checked, empty From) | — |
| `starter-membership-period-default-mobile-390.png` | starter | 390x844 | Switched to Membership period (Present checked, empty From) | — |
| `starter-membership-valid-preview-desktop-1440.png` | starter | 1440x900 | Valid bounded period with 'Saves as' preview | — |
| `starter-membership-valid-preview-mobile-390.png` | starter | 390x844 | Valid bounded period with 'Saves as' preview | — |
| `starter-new-list-validation-desktop-1440.png` | starter | 1440x900 | Create pressed with no name | — |
| `starter-new-list-validation-mobile-390.png` | starter | 390x844 | Create pressed with no name | — |
| `starter-opens-other-accounts-object-desktop-1440.png` | starter | 1440x900 | Starter opens a Pro user's private list URL | — |
| `starter-own-list-detail-desktop-1440.png` | starter | 1440x900 | Own list detail (2 stocks) | — |
| `starter-own-list-detail-mobile-390.png` | starter | 390x844 | Own list detail (2 stocks) | — |
| `starter-own-list-detail-tablet-1024.png` | starter | 1024x768 | Own list detail (2 stocks) | — |
| `starter-remove-stock-confirm-desktop-1440.png` | starter | 1440x900 | Remove stock confirmation | — |
| `starter-remove-stock-confirm-mobile-390.png` | starter | 390x844 | Remove stock confirmation | — |
| `starter-rename-dialog-desktop-1440.png` | starter | 1440x900 | Rename → dialog titled 'Edit list' | — |
| `starter-rename-dialog-mobile-390.png` | starter | 390x844 | Rename → dialog titled 'Edit list' | — |
| `starter-row-overflow-open-desktop-1440.png` | starter | 1440x900 | Row overflow menu open | — |
| `starter-row-overflow-open-mobile-390.png` | starter | 390x844 | Row overflow menu open | — |

#### monitors/ (85)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `downgraded-blocked-blocked_by_entitlement-f31f58-desktop-1440.png` | downgraded | 1440x900 | Blocked monitor (ENT-Downgraded Monitor 3) | — |
| `downgraded-blocked-blocked_by_entitlement-f31f58-mobile-390.png` | downgraded | 390x844 | Blocked monitor (ENT-Downgraded Monitor 3) | — |
| `downgraded-blocked-disabled-8b7b8f-desktop-1440.png` | downgraded | 1440x900 | Blocked monitor (ENT-Downgraded Monitor 4 (off)) | — |
| `downgraded-blocked-disabled-8b7b8f-mobile-390.png` | downgraded | 390x844 | Blocked monitor (ENT-Downgraded Monitor 4 (off)) | — |
| `downgraded-collection-desktop-1440.png` | downgraded | 1440x900 | /monitors as downgraded (real seeded data) | — |
| `downgraded-collection-mobile-390.png` | downgraded | 390x844 | /monitors as downgraded (real seeded data) | — |
| `downgraded-collection-tablet-1024.png` | downgraded | 1024x768 | /monitors as downgraded (real seeded data) | — |
| `free-empty-collection-desktop-1440.png` | free-empty | 1440x900 | /monitors as free-empty (real seeded data) | — |
| `free-empty-collection-mobile-390.png` | free-empty | 390x844 | /monitors as free-empty (real seeded data) | — |
| `free-empty-collection-tablet-1024.png` | free-empty | 1024x768 | /monitors as free-empty (real seeded data) | — |
| `free-empty-new-monitor-prerequisites-desktop-1440.png` | free-empty | 1440x900 | No own strategy or list → prerequisites dialog | — |
| `free-empty-new-monitor-prerequisites-mobile-390.png` | free-empty | 390x844 | No own strategy or list → prerequisites dialog | — |
| `free-limit-collection-desktop-1440.png` | free-limit | 1440x900 | /monitors as free-limit (real seeded data) | — |
| `free-limit-collection-mobile-390.png` | free-limit | 390x844 | /monitors as free-limit (real seeded data) | — |
| `free-limit-collection-tablet-1024.png` | free-limit | 1024x768 | /monitors as free-limit (real seeded data) | — |
| `free-limit-new-monitor-refused-desktop-1440.png` | free-limit | 1440x900 | 2nd active monitor on Free → real 403 (nothing created) | — |
| `free-limit-new-monitor-refused-mobile-390.png` | free-limit | 390x844 | 2nd active monitor on Free → real 403 (nothing created) | — |
| `free-normal-collection-desktop-1440.png` | free-normal | 1440x900 | /monitors as free-normal (real seeded data) | — |
| `free-normal-collection-mobile-390.png` | free-normal | 390x844 | /monitors as free-normal (real seeded data) | — |
| `free-normal-collection-tablet-1024.png` | free-normal | 1024x768 | /monitors as free-normal (real seeded data) | — |
| `guest-builtin-monitor-detail-desktop-1440.png` | guest | 1440x900 | Built-in monitor detail as Guest | — |
| `guest-builtin-monitor-detail-mobile-390.png` | guest | 390x844 | Built-in monitor detail as Guest | — |
| `guest-builtin-monitor-detail-tablet-1024.png` | guest | 1024x768 | Built-in monitor detail as Guest | — |
| `guest-collection-desktop-1440.png` | guest | 1440x900 | /monitors as guest (real seeded data) | — |
| `guest-collection-mobile-390.png` | guest | 390x844 | /monitors as guest (real seeded data) | — |
| `guest-collection-tablet-1024.png` | guest | 1024x768 | /monitors as guest (real seeded data) | — |
| `guest-monitor-not-found-desktop-1440.png` | guest | 1440x900 | Unknown monitor id | — |
| `guest-visibility-switch-prompt-desktop-1440.png` | guest | 1440x900 | Guest toggles 'On my dashboard' | — |
| `master-builtin-monitor-admin-menu-desktop-1440.png` | master | 1440x900 | Admin on built-in monitor: Pause for everyone / Unpublish | — |
| `master-builtin-monitor-admin-menu-mobile-390.png` | master | 390x844 | Admin on built-in monitor: Pause for everyone / Unpublish | — |
| `master-builtin-row-overflow-desktop-1440.png` | master | 1440x900 | Admin: built-in row overflow | — |
| `master-collection-desktop-1440.png` | master | 1440x900 | /monitors as master (real seeded data) | — |
| `master-collection-mobile-390.png` | master | 390x844 | /monitors as master (real seeded data) | — |
| `master-collection-tablet-1024.png` | master | 1024x768 | /monitors as master (real seeded data) | — |
| `pro-collection-desktop-1440.png` | pro | 1440x900 | /monitors as pro (real seeded data) | — |
| `pro-collection-error-desktop-1440.png` | pro | 1440x900 | GET /monitors → 500 | GET /monitors → 500 |
| `pro-collection-error-mobile-390.png` | pro | 390x844 | GET /monitors → 500 | GET /monitors → 500 |
| `pro-collection-loading-desktop-1440.png` | pro | 1440x900 | GET /monitors pending | GET /monitors hangs |
| `pro-collection-loading-mobile-390.png` | pro | 390x844 | GET /monitors pending | GET /monitors hangs |
| `pro-collection-mobile-390.png` | pro | 390x844 | /monitors as pro (real seeded data) | — |
| `pro-collection-tablet-1024.png` | pro | 1024x768 | /monitors as pro (real seeded data) | — |
| `pro-heavy-collection-boundary-879.png` | pro-heavy | 879x900 | /monitors as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-boundary-880.png` | pro-heavy | 880x900 | /monitors as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1280.png` | pro-heavy | 1280x800 | /monitors as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1440.png` | pro-heavy | 1440x900 | /monitors as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-mobile-390.png` | pro-heavy | 390x844 | /monitors as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-table-scrolled-right-desktop-1440.png` | pro-heavy | 1440x900 | Same table scrolled horizontally inside its surface to reveal the Actions column | — |
| `pro-heavy-collection-tablet-1024.png` | pro-heavy | 1024x768 | /monitors as pro-heavy (real seeded data) | — |
| `pro-heavy-delete-confirm-desktop-1440.png` | pro-heavy | 1440x900 | Delete monitor confirmation | — |
| `pro-heavy-delete-confirm-mobile-390.png` | pro-heavy | 390x844 | Delete monitor confirmation | — |
| `pro-heavy-detail-overflow-open-desktop-1440.png` | pro-heavy | 1440x900 | Monitor header overflow open | — |
| `pro-heavy-detail-overflow-open-mobile-390.png` | pro-heavy | 390x844 | Monitor header overflow open | — |
| `pro-heavy-edit-dialog-desktop-1440.png` | pro-heavy | 1440x900 | Edit monitor dialog | — |
| `pro-heavy-edit-dialog-mobile-390.png` | pro-heavy | 390x844 | Edit monitor dialog | — |
| `pro-heavy-edit-dialog-rebind-note-desktop-1440.png` | pro-heavy | 1440x900 | Strategy changed → rebind note | — |
| `pro-heavy-edit-dialog-rebind-note-mobile-390.png` | pro-heavy | 390x844 | Strategy changed → rebind note | — |
| `pro-heavy-long-name-monitor-detail-desktop-1440.png` | pro-heavy | 1440x900 | Monitor with a 120-char name over a 100-stock list | — |
| `pro-heavy-long-name-monitor-detail-mobile-390.png` | pro-heavy | 390x844 | Monitor with a 120-char name over a 100-stock list | — |
| `pro-heavy-long-name-monitor-detail-tablet-1024.png` | pro-heavy | 1024x768 | Monitor with a 120-char name over a 100-stock list | — |
| `pro-heavy-monitor-detail-dense-desktop-1440.png` | pro-heavy | 1440x900 | 30 securities in all 5 statuses, 100 signals incl. ended ones | GET /monitors/:id (synthetic, from real built-in response) |
| `pro-heavy-monitor-detail-dense-mobile-390.png` | pro-heavy | 390x844 | 30 securities in all 5 statuses, 100 signals incl. ended ones | GET /monitors/:id (synthetic, from real built-in response) |
| `pro-heavy-monitor-detail-dense-tablet-1024.png` | pro-heavy | 1024x768 | 30 securities in all 5 statuses, 100 signals incl. ended ones | GET /monitors/:id (synthetic, from real built-in response) |
| `pro-heavy-monitor-detail-empty-desktop-1440.png` | pro-heavy | 1440x900 | Monitor whose list is empty and never scanned | GET /monitors/:id (synthetic empty) |
| `pro-heavy-monitor-detail-empty-mobile-390.png` | pro-heavy | 390x844 | Monitor whose list is empty and never scanned | GET /monitors/:id (synthetic empty) |
| `pro-heavy-monitor-detail-loading-desktop-1440.png` | pro-heavy | 1440x900 | GET /monitors/:id pending | GET /monitors/:id hangs |
| `pro-heavy-own-monitor-detail-desktop-1440.png` | pro-heavy | 1440x900 | Own monitor detail (worker: not evaluable on fixture data) | — |
| `pro-heavy-own-monitor-detail-mobile-390.png` | pro-heavy | 390x844 | Own monitor detail (worker: not evaluable on fixture data) | — |
| `pro-heavy-own-monitor-detail-tablet-1024.png` | pro-heavy | 1024x768 | Own monitor detail (worker: not evaluable on fixture data) | — |
| `starter-collection-desktop-1440.png` | starter | 1440x900 | /monitors as starter (real seeded data) | — |
| `starter-collection-mobile-390.png` | starter | 390x844 | /monitors as starter (real seeded data) | — |
| `starter-collection-tablet-1024.png` | starter | 1024x768 | /monitors as starter (real seeded data) | — |
| `starter-limit-collection-desktop-1440.png` | starter-limit | 1440x900 | /monitors as starter-limit (real seeded data) | — |
| `starter-limit-collection-mobile-390.png` | starter-limit | 390x844 | /monitors as starter-limit (real seeded data) | — |
| `starter-limit-collection-tablet-1024.png` | starter-limit | 1024x768 | /monitors as starter-limit (real seeded data) | — |
| `starter-new-monitor-dialog-desktop-1440.png` | starter | 1440x900 | New monitor dialog loaded | — |
| `starter-new-monitor-dialog-mobile-390.png` | starter | 390x844 | New monitor dialog loaded | — |
| `starter-new-monitor-loading-desktop-1440.png` | starter | 1440x900 | New monitor dialog: options loading on open | GET /strategies delayed 2.5s |
| `starter-new-monitor-loading-mobile-390.png` | starter | 390x844 | New monitor dialog: options loading on open | GET /strategies delayed 2.5s |
| `starter-new-monitor-options-error-desktop-1440.png` | starter | 1440x900 | Dialog options GET /lists → 500 | GET /lists → 500 |
| `starter-new-monitor-options-error-mobile-390.png` | starter | 390x844 | Dialog options GET /lists → 500 | GET /lists → 500 |
| `starter-new-monitor-validation-desktop-1440.png` | starter | 1440x900 | Create pressed empty | — |
| `starter-new-monitor-validation-mobile-390.png` | starter | 390x844 | Create pressed empty | — |
| `starter-opens-other-accounts-object-desktop-1440.png` | starter | 1440x900 | Starter opens a Pro user's private monitor URL | — |
| `starter-row-overflow-open-desktop-1440.png` | starter | 1440x900 | Monitor row overflow (Disable / Edit / Delete) | — |
| `starter-row-overflow-open-mobile-390.png` | starter | 390x844 | Monitor row overflow (Disable / Edit / Delete) | — |

#### pickers/ (22)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `pro-indicators-menu-open-desktop-1440.png` | pro | 1440x900 | Indicators popover open (grouped checkboxes, Unavailable entries) | — |
| `pro-indicators-menu-open-mobile-390.png` | pro | 390x844 | Indicators popover open (grouped checkboxes, Unavailable entries) | — |
| `pro-indicators-menu-scrolled-desktop-1440.png` | pro | 1440x900 | Indicators popover scrolled to the end | — |
| `pro-indicators-menu-scrolled-mobile-390.png` | pro | 390x844 | Indicators popover scrolled to the end | — |
| `starter-add-stocks-in-list-markers-desktop-1440.png` | starter | 1440x900 | Add stocks: members shown as 'In list' | — |
| `starter-add-stocks-in-list-markers-mobile-390.png` | starter | 390x844 | Add stocks: members shown as 'In list' | — |
| `starter-list-picker-chip-and-results-desktop-1440.png` | starter | 1440x900 | One chip selected; new query open | — |
| `starter-list-picker-chip-and-results-mobile-390.png` | starter | 390x844 | One chip selected; new query open | — |
| `starter-list-picker-focused-blank-desktop-1440.png` | starter | 1440x900 | Stock picker focused, blank query (no panel) | — |
| `starter-list-picker-focused-blank-mobile-390.png` | starter | 390x844 | Stock picker focused, blank query (no panel) | — |
| `starter-list-picker-loading-desktop-1440.png` | starter | 1440x900 | Search pending | GET /stocks/search hangs |
| `starter-list-picker-loading-mobile-390.png` | starter | 390x844 | Search pending | GET /stocks/search hangs |
| `starter-list-picker-no-results-desktop-1440.png` | starter | 1440x900 | No results | — |
| `starter-list-picker-no-results-mobile-390.png` | starter | 390x844 | No results | — |
| `starter-list-picker-rate-limited-desktop-1440.png` | starter | 1440x900 | Search → 429 (picker ignores the rate-limit copy) | GET /stocks/search → 429 |
| `starter-list-picker-rate-limited-mobile-390.png` | starter | 390x844 | Search → 429 (picker ignores the rate-limit copy) | GET /stocks/search → 429 |
| `starter-list-picker-results-desktop-1440.png` | starter | 1440x900 | Results for 'Q' | — |
| `starter-list-picker-results-mobile-390.png` | starter | 390x844 | Results for 'Q' | — |
| `starter-list-picker-selected-marker-desktop-1440.png` | starter | 1440x900 | Re-searching an already chosen stock (Selected marker) | — |
| `starter-list-picker-selected-marker-mobile-390.png` | starter | 390x844 | Re-searching an already chosen stock (Selected marker) | — |
| `starter-list-picker-typing-debounce-desktop-1440.png` | starter | 1440x900 | Typed 'Q' — inside the 250ms debounce | — |
| `starter-list-picker-typing-debounce-mobile-390.png` | starter | 390x844 | Typed 'Q' — inside the 250ms debounce | — |

#### shell/ (26)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `guest-not-found-page-mobile-390.png` | guest | 390x844 | Unknown URL as Guest | — |
| `guest-topbar-desktop-1440.png` | guest | 1440x900 | Guest shell: Pricing + Sign in | — |
| `guest-topbar-mobile-390.png` | guest | 390x844 | Guest shell: Pricing + Sign in | — |
| `guest-topbar-tablet-1024.png` | guest | 1024x768 | Guest shell: Pricing + Sign in | — |
| `pro-bottom-nav-scrolled-to-end-mobile-390.png` | pro | 390x844 | Phone scrolled to the end: bottom nav vs last content | — |
| `pro-nav-active-lists-desktop-1440.png` | pro | 1440x900 | Active nav state on /lists | — |
| `pro-nav-active-lists-mobile-390.png` | pro | 390x844 | Active nav state on /lists | — |
| `pro-nav-active-strategies-new-desktop-1440.png` | pro | 1440x900 | Active nav state on /strategies/new | — |
| `pro-nav-active-strategies-new-mobile-390.png` | pro | 390x844 | Active nav state on /strategies/new | — |
| `pro-nav-on-billing-desktop-1440.png` | pro | 1440x900 | Active nav state on /billing | — |
| `pro-nav-on-billing-mobile-390.png` | pro | 390x844 | Active nav state on /billing | — |
| `pro-nav-on-stock-details-desktop-1440.png` | pro | 1440x900 | Active nav state on /stocks/QATEST1 | — |
| `pro-nav-on-stock-details-mobile-390.png` | pro | 390x844 | Active nav state on /stocks/QATEST1 | — |
| `pro-not-found-page-desktop-1440.png` | pro | 1440x900 | Unknown URL | — |
| `pro-not-found-page-mobile-390.png` | pro | 390x844 | Unknown URL | — |
| `pro-root-redirect-desktop-1440.png` | pro | 1440x900 | / → redirect | — |
| `pro-root-redirect-mobile-390.png` | pro | 390x844 | / → redirect | — |
| `pro-session-check-failed-desktop-1440.png` | pro | 1440x900 | GET /auth/me → 500 on a protected route | GET /auth/me → 500 |
| `pro-session-check-failed-mobile-390.png` | pro | 390x844 | GET /auth/me → 500 on a protected route | GET /auth/me → 500 |
| `pro-session-checking-desktop-1440.png` | pro | 1440x900 | Session still resolving on a protected route | GET /auth/me hangs |
| `pro-session-checking-mobile-390.png` | pro | 390x844 | Session still resolving on a protected route | GET /auth/me hangs |
| `pro-session-resolving-dashboard-desktop-1440.png` | pro | 1440x900 | Session still resolving on the Dashboard | GET /auth/me hangs |
| `pro-session-resolving-dashboard-mobile-390.png` | pro | 390x844 | Session still resolving on the Dashboard | GET /auth/me hangs |
| `pro-topbar-search-expanded-mobile-375.png` | pro | 375x812 | Compact search expanded at 375px | — |
| `pro-topbar-search-mobile-375.png` | pro | 375x812 | Topbar at 375px (search icon-only below 380px) | — |
| `pro-topbar-search-mobile-390.png` | pro | 390x844 | Topbar at 390px (search icon-only below 380px) | — |

#### stocks/ (54)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `guest-details-qatest1-desktop-1440.png` | guest | 1440x900 | Stock Details as Guest | — |
| `guest-details-qatest1-mobile-390.png` | guest | 390x844 | Stock Details as Guest | — |
| `guest-search-focused-blank-desktop-1440.png` | guest | 1440x900 | Focused, blank: popular only (no recents) | — |
| `guest-search-focused-blank-mobile-390.png` | guest | 390x844 | Focused, blank: popular only (no recents) | — |
| `guest-search-keyboard-highlight-desktop-1440.png` | guest | 1440x900 | Arrow-key highlight | — |
| `guest-search-keyboard-highlight-mobile-390.png` | guest | 390x844 | Arrow-key highlight | — |
| `guest-search-long-company-name-desktop-1440.png` | guest | 1440x900 | Long company name result | — |
| `guest-search-long-company-name-mobile-390.png` | guest | 390x844 | Long company name result | — |
| `guest-search-no-results-desktop-1440.png` | guest | 1440x900 | No results | — |
| `guest-search-no-results-mobile-390.png` | guest | 390x844 | No results | — |
| `guest-search-recents-after-view-desktop-1440.png` | guest | 1440x900 | Guest after viewing QATEST1: localStorage recents | — |
| `guest-search-results-desktop-1440.png` | guest | 1440x900 | Results for 'QA' | — |
| `guest-search-results-mobile-390.png` | guest | 390x844 | Results for 'QA' | — |
| `pro-details-crosshair-desktop-1440.png` | pro | 1440x900 | Crosshair legend | — |
| `pro-details-crosshair-mobile-390.png` | pro | 390x844 | Crosshair legend | — |
| `pro-details-error-desktop-1440.png` | pro | 1440x900 | GET /stocks/QATEST1 → 500 | GET /stocks/QATEST1 → 500 |
| `pro-details-history-error-desktop-1440.png` | pro | 1440x900 | Older-history load fails after MAX | GET /stocks/QATEST1/prices → 500 |
| `pro-details-history-loading-desktop-1440.png` | pro | 1440x900 | Older history loading (spinner overlay) | GET /stocks/QATEST1/prices hangs |
| `pro-details-loading-desktop-1440.png` | pro | 1440x900 | GET /stocks/QATEST1 pending (skeleton) | GET /stocks/QATEST1 hangs |
| `pro-details-loading-mobile-390.png` | pro | 390x844 | GET /stocks/QATEST1 pending (skeleton) | GET /stocks/QATEST1 hangs |
| `pro-details-overlays-rsi-desktop-1440.png` | pro | 1440x900 | SMA 50D + SMA 200D + RSI 14D pane selected | — |
| `pro-details-overlays-rsi-mobile-390.png` | pro | 390x844 | SMA 50D + SMA 200D + RSI 14D pane selected | — |
| `pro-details-qatest1-boundary-879.png` | pro | 879x900 | Stock Details with 3y synthetic data, default Balanced overlay | — |
| `pro-details-qatest1-boundary-880.png` | pro | 880x900 | Stock Details with 3y synthetic data, default Balanced overlay | — |
| `pro-details-qatest1-desktop-1280.png` | pro | 1280x800 | Stock Details with 3y synthetic data, default Balanced overlay | — |
| `pro-details-qatest1-desktop-1440.png` | pro | 1440x900 | Stock Details with 3y synthetic data, default Balanced overlay | — |
| `pro-details-qatest1-mobile-390.png` | pro | 390x844 | Stock Details with 3y synthetic data, default Balanced overlay | — |
| `pro-details-qatest1-tablet-1024.png` | pro | 1024x768 | Stock Details with 3y synthetic data, default Balanced overlay | — |
| `pro-details-qatest2-no-data-desktop-1440.png` | pro | 1440x900 | Security with no price data (complete & empty) | — |
| `pro-details-qatest2-no-data-mobile-390.png` | pro | 390x844 | Security with no price data (complete & empty) | — |
| `pro-details-range-max-desktop-1440.png` | pro | 1440x900 | Range MAX (history bound + unavailable gaps) | — |
| `pro-details-range-max-mobile-390.png` | pro | 390x844 | Range MAX (history bound + unavailable gaps) | — |
| `pro-details-real-symbol-no-local-data-desktop-1440.png` | pro | 1440x900 | Real catalog symbol, no local data (fixture provider refuses) | — |
| `pro-details-real-symbol-no-local-data-mobile-390.png` | pro | 390x844 | Real catalog symbol, no local data (fixture provider refuses) | — |
| `pro-details-unknown-symbol-desktop-1440.png` | pro | 1440x900 | Symbol not in catalog | — |
| `pro-details-unknown-symbol-mobile-390.png` | pro | 390x844 | Symbol not in catalog | — |
| `pro-heavy-search-error-desktop-1440.png` | pro-heavy | 1440x900 | Search → 500 | GET /stocks/search → 500 |
| `pro-heavy-search-error-mobile-390.png` | pro-heavy | 390x844 | Search → 500 | GET /stocks/search → 500 |
| `pro-heavy-search-focused-blank-desktop-1440.png` | pro-heavy | 1440x900 | Focused, blank: Recent Searches + Popular | — |
| `pro-heavy-search-focused-blank-mobile-390.png` | pro-heavy | 390x844 | Focused, blank: Recent Searches + Popular | — |
| `pro-heavy-search-keyboard-highlight-desktop-1440.png` | pro-heavy | 1440x900 | Arrow-key highlight | — |
| `pro-heavy-search-keyboard-highlight-mobile-390.png` | pro-heavy | 390x844 | Arrow-key highlight | — |
| `pro-heavy-search-loading-desktop-1440.png` | pro-heavy | 1440x900 | Search pending, no prior results | GET /stocks/search hangs |
| `pro-heavy-search-loading-mobile-390.png` | pro-heavy | 390x844 | Search pending, no prior results | GET /stocks/search hangs |
| `pro-heavy-search-long-company-name-desktop-1440.png` | pro-heavy | 1440x900 | Long company name result | — |
| `pro-heavy-search-long-company-name-mobile-390.png` | pro-heavy | 390x844 | Long company name result | — |
| `pro-heavy-search-no-results-desktop-1440.png` | pro-heavy | 1440x900 | No results | — |
| `pro-heavy-search-no-results-mobile-390.png` | pro-heavy | 390x844 | No results | — |
| `pro-heavy-search-rate-limited-desktop-1440.png` | pro-heavy | 1440x900 | Search → 429 | GET /stocks/search → 429 |
| `pro-heavy-search-rate-limited-mobile-390.png` | pro-heavy | 390x844 | Search → 429 | GET /stocks/search → 429 |
| `pro-heavy-search-results-desktop-1440.png` | pro-heavy | 1440x900 | Results for 'QA' | — |
| `pro-heavy-search-results-mobile-390.png` | pro-heavy | 390x844 | Results for 'QA' | — |
| `pro-stocks-index-placeholder-desktop-1440.png` | pro | 1440x900 | /stocks route | — |
| `pro-stocks-index-placeholder-mobile-390.png` | pro | 390x844 | /stocks route | — |

#### strategies/ (74)

| File | Persona | Viewport | State | Mocks |
|---|---|---|---|---|
| `downgraded-collection-desktop-1440.png` | downgraded | 1440x900 | /strategies as downgraded (real seeded data) | — |
| `downgraded-collection-mobile-390.png` | downgraded | 390x844 | /strategies as downgraded (real seeded data) | — |
| `downgraded-collection-tablet-1024.png` | downgraded | 1024x768 | /strategies as downgraded (real seeded data) | — |
| `free-empty-collection-desktop-1440.png` | free-empty | 1440x900 | /strategies as free-empty (real seeded data) | — |
| `free-empty-collection-mobile-390.png` | free-empty | 390x844 | /strategies as free-empty (real seeded data) | — |
| `free-empty-collection-tablet-1024.png` | free-empty | 1024x768 | /strategies as free-empty (real seeded data) | — |
| `free-limit-collection-desktop-1440.png` | free-limit | 1440x900 | /strategies as free-limit (real seeded data) | — |
| `free-limit-collection-mobile-390.png` | free-limit | 390x844 | /strategies as free-limit (real seeded data) | — |
| `free-limit-collection-tablet-1024.png` | free-limit | 1024x768 | /strategies as free-limit (real seeded data) | — |
| `free-normal-collection-desktop-1440.png` | free-normal | 1440x900 | /strategies as free-normal (real seeded data) | — |
| `free-normal-collection-mobile-390.png` | free-normal | 390x844 | /strategies as free-normal (real seeded data) | — |
| `free-normal-collection-tablet-1024.png` | free-normal | 1024x768 | /strategies as free-normal (real seeded data) | — |
| `guest-backtest-this-prompt-desktop-1440.png` | guest | 1440x900 | Guest presses Backtest this strategy | — |
| `guest-builtin-readonly-desktop-1440.png` | guest | 1440x900 | Built-in strategy read-only view | — |
| `guest-builtin-readonly-mobile-390.png` | guest | 390x844 | Built-in strategy read-only view | — |
| `guest-builtin-readonly-tablet-1024.png` | guest | 1024x768 | Built-in strategy read-only view | — |
| `guest-collection-desktop-1440.png` | guest | 1440x900 | /strategies as guest (real seeded data) | — |
| `guest-collection-mobile-390.png` | guest | 390x844 | /strategies as guest (real seeded data) | — |
| `guest-collection-tablet-1024.png` | guest | 1024x768 | /strategies as guest (real seeded data) | — |
| `guest-new-strategy-prompt-mobile-390.png` | guest | 390x844 | Guest presses New strategy | — |
| `guest-strategy-not-found-desktop-1440.png` | guest | 1440x900 | Unknown strategy id | — |
| `master-builtin-editable-desktop-1440.png` | master | 1440x900 | Administrator opens a built-in strategy (builder) | — |
| `master-builtin-editable-mobile-390.png` | master | 390x844 | Administrator opens a built-in strategy (builder) | — |
| `master-builtin-row-overflow-desktop-1440.png` | master | 1440x900 | Admin: built-in row overflow | — |
| `master-collection-desktop-1440.png` | master | 1440x900 | /strategies as master (real seeded data) | — |
| `master-collection-mobile-390.png` | master | 390x844 | /strategies as master (real seeded data) | — |
| `master-collection-tablet-1024.png` | master | 1024x768 | /strategies as master (real seeded data) | — |
| `pro-collection-desktop-1440.png` | pro | 1440x900 | /strategies as pro (real seeded data) | — |
| `pro-collection-error-desktop-1440.png` | pro | 1440x900 | GET /strategies → 500 | GET /strategies → 500 |
| `pro-collection-error-mobile-390.png` | pro | 390x844 | GET /strategies → 500 | GET /strategies → 500 |
| `pro-collection-loading-desktop-1440.png` | pro | 1440x900 | GET /strategies pending | GET /strategies hangs |
| `pro-collection-loading-mobile-390.png` | pro | 390x844 | GET /strategies pending | GET /strategies hangs |
| `pro-collection-mobile-390.png` | pro | 390x844 | /strategies as pro (real seeded data) | — |
| `pro-collection-tablet-1024.png` | pro | 1024x768 | /strategies as pro (real seeded data) | — |
| `pro-heavy-collection-boundary-879.png` | pro-heavy | 879x900 | /strategies as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-boundary-880.png` | pro-heavy | 880x900 | /strategies as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1280.png` | pro-heavy | 1280x800 | /strategies as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-desktop-1440.png` | pro-heavy | 1440x900 | /strategies as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-mobile-390.png` | pro-heavy | 390x844 | /strategies as pro-heavy (real seeded data) | — |
| `pro-heavy-collection-tablet-1024.png` | pro-heavy | 1024x768 | /strategies as pro-heavy (real seeded data) | — |
| `pro-heavy-long-name-editor-desktop-1440.png` | pro-heavy | 1440x900 | Editor for a strategy with 120-char name + long description | — |
| `pro-heavy-long-name-editor-mobile-390.png` | pro-heavy | 390x844 | Editor for a strategy with 120-char name + long description | — |
| `starter-collection-desktop-1440.png` | starter | 1440x900 | /strategies as starter (real seeded data) | — |
| `starter-collection-mobile-390.png` | starter | 390x844 | /strategies as starter (real seeded data) | — |
| `starter-collection-tablet-1024.png` | starter | 1024x768 | /strategies as starter (real seeded data) | — |
| `starter-delete-confirm-desktop-1440.png` | starter | 1440x900 | Delete strategy confirmation | — |
| `starter-delete-refused-in-use-desktop-1440.png` | starter | 1440x900 | Delete → real 409 (strategy used by a monitor; nothing deleted) | — |
| `starter-edit-dirty-save-bar-desktop-1440.png` | starter | 1440x900 | Unsaved changes: save bar with Discard | — |
| `starter-edit-dirty-save-bar-mobile-390.png` | starter | 390x844 | Unsaved changes: save bar with Discard | — |
| `starter-edit-ladder-boundary-879.png` | starter | 879x900 | Edit existing: 3 BUY, 2 SELL, FINAL EXIT with 3 rules | — |
| `starter-edit-ladder-desktop-1280.png` | starter | 1280x800 | Edit existing: 3 BUY, 2 SELL, FINAL EXIT with 3 rules | — |
| `starter-edit-ladder-desktop-1440.png` | starter | 1440x900 | Edit existing: 3 BUY, 2 SELL, FINAL EXIT with 3 rules | — |
| `starter-edit-ladder-mobile-390.png` | starter | 390x844 | Edit existing: 3 BUY, 2 SELL, FINAL EXIT with 3 rules | — |
| `starter-edit-ladder-tablet-1024.png` | starter | 1024x768 | Edit existing: 3 BUY, 2 SELL, FINAL EXIT with 3 rules | — |
| `starter-limit-collection-desktop-1440.png` | starter-limit | 1440x900 | /strategies as starter-limit (real seeded data) | — |
| `starter-limit-collection-mobile-390.png` | starter-limit | 390x844 | /strategies as starter-limit (real seeded data) | — |
| `starter-limit-collection-tablet-1024.png` | starter-limit | 1024x768 | /strategies as starter-limit (real seeded data) | — |
| `starter-new-blank-boundary-879.png` | starter | 879x900 | New strategy, blank | — |
| `starter-new-blank-desktop-1440.png` | starter | 1440x900 | New strategy, blank | — |
| `starter-new-blank-mobile-390.png` | starter | 390x844 | New strategy, blank | — |
| `starter-new-blank-tablet-1024.png` | starter | 1024x768 | New strategy, blank | — |
| `starter-new-final-exit-middle-removed-desktop-1440.png` | starter | 1440x900 | Exit rule 2 removed → renumbered | — |
| `starter-new-final-exit-middle-removed-mobile-390.png` | starter | 390x844 | Exit rule 2 removed → renumbered | — |
| `starter-new-final-exit-three-rules-desktop-1440.png` | starter | 1440x900 | BUY with 2 conditions + trigger; FINAL EXIT with 3 OR rules | — |
| `starter-new-final-exit-three-rules-mobile-390.png` | starter | 390x844 | BUY with 2 conditions + trigger; FINAL EXIT with 3 OR rules | — |
| `starter-new-issues-revealed-desktop-1440.png` | starter | 1440x900 | Issue count pressed → issues revealed/focused | — |
| `starter-new-issues-revealed-mobile-390.png` | starter | 390x844 | Issue count pressed → issues revealed/focused | — |
| `starter-new-metric-focus-help-desktop-1440.png` | starter | 1440x900 | Metric select focused → contextual explanation | — |
| `starter-new-metric-focus-help-mobile-390.png` | starter | 390x844 | Metric select focused → contextual explanation | — |
| `starter-new-one-buy-level-desktop-1440.png` | starter | 1440x900 | After + Add buy level | — |
| `starter-new-one-buy-level-mobile-390.png` | starter | 390x844 | After + Add buy level | — |
| `starter-opens-other-accounts-object-desktop-1440.png` | starter | 1440x900 | Starter opens a Pro user's private strategie URL | — |
| `starter-rename-dialog-mobile-390.png` | starter | 390x844 | Rename → 'Edit strategy' dialog | — |
| `starter-row-overflow-open-desktop-1440.png` | starter | 1440x900 | Strategy row overflow | — |
