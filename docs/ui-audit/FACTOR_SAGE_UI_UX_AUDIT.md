# FactorSage V2 — UI/UX Audit

**Scope:** the whole user-visible web application (`apps/web`), audited as one product.
**Nature:** audit only. No product code, styles, contracts or tests were changed.
**Evidence:** 642 screenshots with a machine-readable manifest under `artifacts/ui-audit/`.
In this document an evidence reference such as `lists/pro-heavy-collection-desktop-1440.png` means
`artifacts/ui-audit/lists/pro-heavy-collection-desktop-1440.png`. `artifacts/ui-audit/EVIDENCE_INDEX.md`
lists every capture with persona, viewport, state and mocks.

---

## 1. Executive summary

FactorSage V2 is **close to being one coherent product, but not there yet**. It has a real design
system: tokens in `styles/tokens.css`, a shared vocabulary (`PageHeader`, `SectionCard`, `DataTable`,
`EmptyState`, `StatusBadge`, `EntityReferenceChip`, `StockIdentity`, `WorkflowFooter`,
`OverflowMenu`) and written composition rules (`ai/architecture/ui-system.md`,
`v1-visual-parity.md`). Four surfaces follow those rules most closely and look like the intended
product: the four collections, New Backtest, the Backtest result and Billing/Pricing. Around them,
several surfaces were built as islands with their own headers, cards, error panels, type sizes and
breakpoints: Stock Details, the Strategy Builder, the auth pages, `/admin` and the session gate.

The problems that matter most are **structural and behavioural, not cosmetic**:

1. **One long name breaks the collection tables** (UI-001, UI-002). `EntityReferenceChip` truncates
   its label visually but keeps its full max-content width. In the Backtests and Monitors
   collections, one realistic 120-character list or strategy name therefore widens the table to
   1,735–2,110 px at a 1,440 px viewport. The *Actions* column (`View results`, `Open`, `…`) scrolls
   out of view and the identity column collapses to mid-word breaks ("Univers / e 04 / trend"). The
   same mechanism makes the **phone Dashboard scroll sideways by 366 px**. The Dashboard received a
   local fix for the desktop case (UX-007), but it was never generalised.
2. **Plan limits are invisible until the user has already done the work** (UI-020 … UI-024).
   Nothing shows "10 of 10 stocks", "1 of 1 active monitor", "5-year history" or "1 run at a time"
   before submit. The API refusal is the only signal, it carries no route to `/billing`, and on phones
   the New Backtest refusal renders **below the fold**, out of sight from the sticky action bar
   (UI-005). A downgraded account sees "Enabled" and "Not scanning" pills side by side, and the
   explanation lives only in a hover tooltip.
3. **The same workflow behaves differently depending on where it starts** (UI-008, UI-009, UI-030).
   - "Backtest this …" exists for built-ins and for Guests, but not on your own list, strategy or
     monitor, nor on Stock Details.
   - The Monitor picker offers only your own content, in a flat list, while the Backtest picker
     groups built-ins with yours.
   - "New …" changes button style and position between the empty and populated states, and
     disappears while loading.
4. **The Strategy Builder silently authors logic** (UI-013). Every new condition and every new
   FINAL EXIT rule starts as the complete rule "Price is above SMA 20D". So "+ Add condition" and
   "+ Add OR rule" create duplicates, and a pristine blank strategy greets the user with a red
   "2 issues to fix".
5. **The Dashboard does not say *when*** (UI-025). A row never shows how long a signal has been
   active, even though `since` is in the contract. There is no sort and no grouping, and the only
   freshness cue is one page-level "Updated 12 min ago" under a card labelled "Real-time Matches" on
   an end-of-day product.
6. **Failure states tell the wrong story** (UI-031, UI-037, UI-046).
   - A failed backtest shows a raw `EXECUTION_FAILED` code and "Please try running it again" for a
     data problem a retry cannot fix, then "No positions have been opened yet" and "Trade log 0"
     beneath.
   - A lapsed Pro-annual customer sees "Waiting for payment confirmation" on the plan they left,
     with no button to buy it again.
   - The Checkout return says "Your plan below reflects your confirmed subscription" even when it
     does not.

**Counts.** 58 findings: **0 P0, 13 P1, 31 P2, 14 P3.** No P0 was found:
- every primary action stayed reachable, sometimes only by horizontal scroll or row click;
- no data crossed accounts — another account's list, strategy, monitor or backtest reads as not
  found;
- no workflow was impossible to complete.

**Positive core worth converging on:** the Backtest result hero, `DataTable`'s single-DOM
table/card pattern, `WorkflowFooter` on New Backtest, the SignInPrompt pattern for Guests, the
Billing plan catalog (limits derived from `PLAN_ENTITLEMENTS`, not restated), `StockIdentity`'s
monogram fallback, and the calm token palette. Section 27 lists what to keep.

**Answer to "one coherent design system, or individually-built pages?"** One system with three
dialects. About 70% of the product speaks the shared vocabulary faithfully. Three families speak
their own:
- Stock Details: its own status panel, skeleton, cards, badges and facts list.
- Strategy Builder: its own cards, selects and footer, with a red "Remove".
- Auth, `/admin` and the session gate: their own header sizes (22/26/30/32 px), button heights
  (46 px) and breakpoints (560 px).

There are also system-level drifts inside the shared vocabulary:
- The documented breakpoints (768 px table↔card, 1,024 px nav) are not what ships; 880 px drives
  both.
- Four `<select>` stylings exist (38/44/46 px and `--action-height`).
- Two independent stock comboboxes exist.
- Collections carry second headings that the spec forbids.

Section 8 gives the evidence.

---

## 2. Audit methodology

1. **Inventory from code, not memory.**
   - All `page.tsx`, `layout.tsx`, `error.tsx` and `not-found.tsx` files under `apps/web/src/app`.
   - The navigation registry (`components/layout/navigation.ts`).
   - The guest route list (`features/auth/utils/guest-routes.ts`).
   - Every feature hook's API calls, every shared primitive, all CSS modules (breakpoints, literal
     sizes), the entitlement catalog (`packages/contracts/src/entitlements.ts`), the billing catalog
     and state machine, and the seeders.
   - Five parallel read-only code investigations produced file:line-level facts, each checked
     against screenshots before being reported: pickers and data lifecycle; entitlements and
     billing; lists/strategies/search/stock/auth; dashboard/backtests/monitors/shell; seeds.
2. **Hermetic stack** (the repository's own deterministic E2E stack, `ai/workflows/auth-testing.md`
   §7):
   - fixture FMP on `127.0.0.1:3011`;
   - API, worker and web against `TEST_DATABASE_URL`;
   - SMTP and Google blanked; Stripe inert with placeholder keys;
   - the egress guard armed on every process.
3. **Personas.**
   - The five seeded personas (`pnpm test:personas:seed`).
   - Four audit-only personas created with the product's own `seedQaUsers` in the **test** database:
     `free-empty`, `free-normal`, `starter`, `pro-heavy`.
   - Audit content was created **through the public API**, so it passed the real validation and
     entitlement guards: 36 lists, 30 strategies, 16 monitors, 12 backtests (10 completed, 2
     genuinely failed).
4. **Capture harness** (`artifacts/ui-audit/harness/`):
   - A Playwright library script signs each persona in through `POST /auth/login` (real HttpOnly
     cookie).
   - It stubs logos exactly as the E2E suite does (the `204` miss) and hides the Next.js dev
     indicator.
   - Each screenshot is taken together with automated in-page checks: horizontal document
     overflow, elements outside the viewport (excluding scroll containers and intentionally
     off-screen skip links), duplicate IDs, controls without accessible names, ambiguous
     accessible names, `<h1>` count, console errors, page errors and unexpected failed requests.
     All results are stored in `manifest.json`.
5. **Mocked states.**
   - States the stack cannot produce on demand were produced by Playwright route interception with
     payloads derived from real captured responses (`harness/fixtures/*.json` → `harness/mocks.mjs`),
     so their shapes stay contract-true.
   - These cover loading (hung requests), 500s, 429s, many signals, SELL/FINAL EXIT rows, stale
     scans, queued runs, and every billing subscription state.
   - 141 of 642 captures use a mock, and the manifest names it.
6. **Entitlement refusals were real.** Limits were exercised against the real API, which refused
   and wrote nothing:
   - the 11th stock on a 10-stock Free list;
   - an 11-stock new list;
   - a second active monitor;
   - a second concurrent backtest;
   - a 30-year period on Free;
   - deleting a strategy in use (409).
7. **Viewports.** 1,440×900 and 1,280×800 (desktop); 1,024×768; **880 and 879** (the real
   breakpoint); 390×844 and 375×812 (phone).
8. **Visual review.** Screenshots were reviewed directly, cropped where needed, and compared across
   personas and viewports. Section 23 names the DOM measurements used to confirm root causes.

**Capture artifacts to ignore.** Full-page screenshots of scrolling pages render *fixed/sticky*
chrome (phone bottom navigation, the Strategy save bar, `WorkflowFooter`) at the position it
occupied in the first viewport. It therefore appears "in the middle" of tall images; that is
Playwright's stitching, not a layout bug. Where position mattered (UI-005, UI-006), viewport-only
captures were taken.

---

## 3. Commit, branch and environment audited

| Item | Value |
|---|---|
| Branch | `UI-audit` (created by the owner; one docs-only commit ahead of `main`) |
| Commit | `25b0461f` — "docs(product): require sign-in for all backtests" (parent `76063966`, `main` at audit start) |
| Tree at start | clean |
| Production code changed | **No.** Only `artifacts/ui-audit/**` and `docs/ui-audit/**` were added. `apps/web/next-env.d.ts` was touched by `next dev` itself (the known dev/build drift) and was restored. |
| Stack | hermetic E2E stack (`dev:fmp:e2e`, `dev:api:e2e`, `dev:worker:e2e`, `dev:web:e2e`), Next dev server on :3000, API :3001 |
| Database | `intrinsic_value_test` only (never the development database) |
| Browser | Chromium (Playwright 1.62), headless, `en-US`, `America/New_York`, DPR 1 |
| Date of audit | 2026-09-19 (fixture market data anchored to that date) |

**Data caveats that affect what the screenshots show:**
- **Prices are synthetic.** Only `QATEST1` has prices, a deterministic sawtooth over ~3 years. The
  market-overview indices are seeded, and every other security has no local data.
- **Real symbols have no data locally.** Stock Details for IBM, AMZN and the like shows the product's
  error state, because the fixture provider refuses them. In production they would load.
- **Logos never load.** Every logo is the product's own `204` miss, so every identity shows the
  monogram.
- **Search includes integration-test leftovers.** The test catalog contains rows such as "Weekly
  Cache Round Trip Corp".
- **User monitors never produce signals.** The Monitor worker cannot evaluate user monitors on the
  hermetic stack (fixture quotes are empty, so everything is "Not evaluable"). The live Dashboard
  shows the three seeded built-in rows; richer Dashboard and Monitor states are mocked.

---

## 4. Product route inventory

| Route | Access | Type | Shell | Notes |
|---|---|---|---|---|
| `/` | public | redirect | – | Server redirect to `/dashboard`. The code comment still claims signed-out users go to `/login` (stale). |
| `/login` | public | auth | standalone `AuthCard` | Password sign-in. Google only when `/auth/providers` says so. Also renders for signed-in users (UI-040). |
| `/register` | public | auth | standalone | Email only; the password is chosen on the verification page. |
| `/verify-email` | public (token) | auth | standalone | Sets the password *and* verifies. Handles the no-token, invalid, resend and success states. |
| `/forgot-password` | public | auth | standalone | Neutral "if that address…" confirmation. |
| `/reset-password` | public (token) | auth | standalone | Invalid token handled differently from verify (UI-043). |
| `/dashboard` | guest-readable | dashboard | app shell | Market strip, current signals, guest notice. |
| `/stocks` | guest-readable | placeholder | app shell | Stale placeholder: "Stock research and intrinsic value arrive in the Stock Details slice." (UI-051). |
| `/stocks/[symbol]` | guest-readable | entity detail | app shell | Chart, indicators, intrinsic value, technicals, key facts. |
| `/lists` | guest-readable | collection | app shell | "Your lists" + "Built-in lists". New list opens a modal. |
| `/lists/[id]` | guest-readable | entity detail + editor | app shell | Add stocks, membership (buy-window) editor, remove, rename, delete. |
| `/strategies` | guest-readable | collection | app shell | New strategy is a route; Rename is a modal. |
| `/strategies/new` | authenticated | editor | app shell | Strategy Builder. |
| `/strategies/[id]` | guest-readable | editor or read-only | app shell | `canEdit` selects Builder or `StrategyReadOnlyView`. |
| `/monitors` | guest-readable | collection | app shell | New/Edit monitor is a modal; built-in dashboard-visibility switch. |
| `/monitors/[monitorId]` | guest-readable | entity detail | app shell | Configuration, monitored stocks, recent signals. |
| `/backtests` | authenticated | collection | app shell | No overflow menu (runs are immutable). |
| `/backtests/new` | authenticated | workflow | app shell | Prefill via `?strategyId&stockListId`. |
| `/backtests/[id]` | authenticated | outcome hero | app shell | Polls `/progress` every 1 s while running, 2.5 s while queued. |
| `/billing` | authenticated | product page | app shell | Plan catalog + subscription facts. |
| `/pricing` | guest-readable | product page | app shell | Same `PlanCatalog`; guest CTAs open SignInPrompt. |
| `/admin` | ADMIN role | admin | app shell | Built-in content table. Reached only from the account menu. |
| unmatched URL | public | not-found | standalone (no shell) | `app/not-found.tsx`. |
| render failure | – | error | app shell | `app/(app)/error.tsx`, plus `global-error.tsx`. |

Plus the one web-owned server route `/api/logo/[symbol]`: a logo proxy, not a page.

**Modal-driven surfaces** (no route):
- New list and Edit list (the rename dialog);
- Membership editor;
- Remove stock, Delete list/strategy/monitor confirmations;
- Rename strategy;
- New monitor and Edit monitor;
- SignInPrompt, in five variants;
- Indicators popover;
- account menu and row/header overflow menus.

**Totals:** 22 page routes plus 2 failure surfaces audited; 13 modal/popover surfaces.

---

## 5. Persona / tier matrix

Limits come from `packages/contracts/src/entitlements.ts` (`PLAN_ENTITLEMENTS`, `ADMIN_ENTITLEMENTS`):

| | GUEST | FREE | STARTER | PRO | ADMIN (role) |
|---|---|---|---|---|---|
| Read built-ins, search, Stock Details | ✓ | ✓ | ✓ | ✓ | ✓ |
| Custom lists / strategies | – | unlimited | unlimited | unlimited | unlimited |
| Stocks per list | – | 10 | 50 | 100 | ∞ |
| Stocks per backtest | – | 10 | 50 | 100 | ∞ |
| Backtest period (years) | – | 5 | 15 | 30 | ∞ |
| Concurrent backtests | – | 1 | 1 | 2 | ∞ |
| Active monitors | – | 1 | 3 | 10 | ∞ |
| View backtests at all | **No** (routes gated; contract flag `canViewDemo` still `true`) | ✓ | ✓ | ✓ | ✓ |

| Persona (audit id) | Source | Plan / role | State | What it exposed |
|---|---|---|---|---|
| `guest` | no session | GUEST | – | Guest-readable routes, SignInPrompts, `/backtests` and `/billing` bounces, pricing CTAs, localStorage recents |
| `free-empty` | audit seed | FREE | no own content | Every empty state, the monitor prerequisites dialog, New Backtest with built-ins only |
| `free-normal` | audit seed + API | FREE | 2 lists (one custom window), 2 strategies, 1 monitor, 2 completed runs (one from the harness's API probe), recents | Normal Free usage; the 30-year MAX refusal |
| `free-limit` | `FREE_USER` fixture | FREE | list at 10/10, 1/1 monitors, 1/1 runs (pinned RUNNING) | Real refusals: list add, list create, monitor create, concurrent run. Running-run view. |
| `starter` | audit seed + API | STARTER | 4 lists (2, 20, 45, empty), 3 strategies incl. a 3-BUY/2-SELL/3-exit ladder, 2 monitors (1 disabled), 2 runs | Builder density, dialogs, pickers, membership editor, delete refused (409) |
| `starter-limit` | `STARTER_USER` fixture | STARTER | 3/3 monitors, 1/1 runs | Collections at capacity |
| `pro` | `PRO_USER` fixture | PRO | 1 list (80), 4 monitors, pinned run | Default account; Dashboard base for mocks |
| `pro-heavy` | audit seed + API | PRO | 30 lists (a 120-char name, 500-char description, 100-stock list, a member with 3 periods), 25 strategies, 13 monitors (10 enabled), 8 runs (6 completed, 2 failed), recents | Density and pathological content |
| `downgraded` | `DOWNGRADED_USER` fixture | FREE (content from Pro) | 83-stock list, blocked monitors, a 20-year historic run | Over-limit presentation |
| `master` | `ADMIN_USER` fixture | FREE + ADMIN | – | `/admin`, editable built-ins, publish/pause controls |

The "master / built-in owner" concept is implemented as **SYSTEM ownership plus `role = ADMIN`**.
There is no separate owner account; see §26.

---

## 6. State matrix

Legend: **E** = explicitly handled by product code · **I** = incidental (browser default or
accidental) · **—** = not applicable · **✗** = missing. Evidence references are in the
page sections.

| Surface | First load / loading | Empty | One / several | Many | Long text | Error (fetch) | Not found | Guest | Processing | Mutation failure | Stale |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard | E (skeleton rows + strip placeholders) | E ×3 (no monitors / no matches / filtered) | E | I (no paging, no sort) | ✗ (chips break layout at 390) | E (EmptyState error + retry) | — | E (notice) | — | — | E (page badge only) |
| Lists collection | E (skeleton, no "New") | E (compact, CTA moves) | E | E (client paging, no search) | E (wraps) | E (copy says "Your lists" to guests) | — | E | — | E (ConfirmDialog) | ✗ (no refresh) |
| List detail | E (skeleton, **no header**) | E ("No stocks yet") | E | I (100 rows, no paging) | E | E | E | E (read-only) | E ("Adding…") | E (API message) | — |
| Membership editor | — | E (FULL default) | E | E (multi-period → read-only) | — | — | — | — | E | E | — |
| Strategies collection | E | E | E | E | E | E | — | E | — | E (409 surfaced) | — |
| Strategy Builder | E | E (blank shows "2 issues") | E | E (10-limit, silent disable) | E | E | E | E (read-only) | E (save bar) | E | — |
| Monitors collection | E | E | E | E | **✗ (table overflow)** | E | — | E | E ("Enabling…") | E (inline under row) | ✗ |
| Monitor detail | E (**no header**) | E | E | I (100 signals, no paging) | E | E | E ("no longer exists" for others' too) | E | E | E | I ("Last checked" absolute only) |
| Backtests collection | E | E (on canvas, different anatomy) | E | E | **✗ (table overflow)** | E | — | redirect | E (progress in row) | — | ✗ (not polled) |
| New Backtest | E (disabled selects, no copy) | E (prerequisites notice) | — | I (native select with 27 options) | — | E (whole page replaced) | — | redirect | E ("Submitting…") | E (**off-screen on phone**) | — |
| Backtest result | E | E (no-trade copy) | — | I (trade log unpaged) | E | E | E | redirect | E (progress + polling) | — | — |
| Stock search | E ("Searching…") | E (recents/popular) | E | E (8 results) | E (truncates) | E (+429 copy) | E (no results) | E | — | — | — |
| Stock Details | E (page-shaped skeleton) | E ("Not enough price history") | — | E (MAX) | — | E (bespoke panel) | E (bespoke panel) | E | E (history spinner) | — | E (as-of dates) |
| Billing | E (text only) | — | — | — | — | E | — | redirect | E ("Working…") | E | E (settle loop) |
| Pricing | E | — | — | — | — | E | — | E | — | — | — |
| Auth | E (button label) | — | — | — | — | E | E (token) | — | E | E | — |
| Admin | E | E | E | — | — | E (**no retry**) | — | E (denied) | — | — | — |

"Stale data" is handled explicitly only on the Dashboard (page-level badge) and on Stock Details
(as-of dates). The Backtests collection, Monitors, Monitor detail and Admin never refresh after
first load (UI-048).

---

## 7. Responsive viewport matrix

**Breakpoints as implemented** (from CSS modules; see §8):

| Width | Topbar nav | Bottom nav | Collections | Flush `SectionCard` | `WorkflowFooter` | Type/padding tokens |
|---|---|---|---|---|---|---|
| < 380 | icon-only search (expands full-row with Cancel) | ✓ | phone cards | dissolved | sticky above nav | 17 px title, 12 px card pad, 16 px gutter |
| 380–599 | inline search (≤ 360 px) | ✓ | phone cards | dissolved | sticky | same |
| 600–879 | inline search | ✓ | **phone cards stretched to ~800 px** | dissolved | sticky | 32 px gutter, wordmark |
| 880–1,279 | desktop nav, search ≤ 420 px | hidden | dense tables | bordered | inline bottom-right | 20 px title, 24 px card pad, 36 px buttons |
| ≥ 1,280 | same | hidden | same | same | same | 40 px gutter; backtest KPIs in 8 columns |

**Per page:**

| Page | Content max width | Desktop → phone structural change | Primary action (desktop / phone) | Notes |
|---|---|---|---|---|
| Dashboard | 1,600 (data) | 5-card strip stays 5 columns (76 px cards on phone). Signals table → cards with LABEL/value rows. | Run Backtest card / "Backtest" card | 390: **366 px sideways overflow** with long names (UI-002). 880–1,279: chips unreadable (UI-003). |
| Collections | 1,600 | Table → one card per row. The flush surface dissolves. | "New …" header right (tinted) / full-width tinted under the lead | Phone overflow "…" at the card bottom-left and menu clipped off-screen (UI-006). |
| List detail | 1,600 | Members table → cards. Add button full width < 600. | Edit (tinted) + "…" | – |
| Strategy Builder | 1,600 | ≥ 960: 67/33 grid with sticky explanation. < 960: inline help under the focused row. ≥ 620: 3-field predicate row. | Save bar sticky (bottom; above nav on phone) | 620 and 960 are local breakpoints. |
| New Backtest | 820 (reading) | 3 → 2 → 1 columns at 880/600 | Footer bottom-right / sticky bar with summary | Error below the fold on phone (UI-005). |
| Backtest result | 1,600 | KPIs 8 → 4 → 2 columns. Chart 360/300/240 px. | none in hero | Phone hero title wraps to 4 lines at display size. |
| Monitor detail | 1,600 | Tables → cards | Edit monitor + "…" | – |
| Stock Details | 1,600 | 3fr/2fr columns → single column. Chart 360/480 → 280/380. | none | No phone summary grid (spec). |
| Billing / Pricing | 1,600 | 3 plan cards → stacked | Manage billing / plan CTAs | Cards keep button baselines aligned. |
| Auth | card ~400 | card fills width, 26 px title below 560 | full-width submit | Separate type/button scale (UI-044). |

**Dialogs:** centered modals at every width. There are no bottom sheets. Phone padding is 16 px
and action rows stack full-width, primary on top. The exception is SignInPrompt, whose two links
stay side by side.

**Menus near edges:** desktop overflow menus right-align under the trigger and stay in view. On
phones the trigger moves to the bottom-left of the card while the menu is still right-aligned, so
it opens past the left edge (UI-006).

**Keyboard focus:** the focus ring token (`--focus-ring`) is visible on inputs and buttons in
captures. Search, list picker and Indicators support arrow keys and Escape. The account menu
declares `role="menu"` without arrow-key handling (UI-053).

---

## 8. Global design-system observations

### 8.1 What is genuinely systemic

- **Tokens.** Colour, radius, elevation, type scale, control heights, page padding and widths are
  tokens. Hex colours stay in `tokens.css`, with three exceptions: the two chart themes
  (`features/backtests/utils/chart-theme.ts`, `features/stocks/details/utils/chart-theme.ts`) and
  the Google glyph. These contradict the documented "there are none anywhere else" claim.
- **Surfaces.** Ordinary surfaces are flat, 16 px radius, 1 px border (`--shadow-surface: none`).
  The 28 px `--radius-hero` appears exactly once, on the Backtest result. Overlays alone carry
  shadows.
- **Collections.** All four collections render through `DataTable` + `CollectionFooter` inside
  `OwnedCollection` sections.
  - Phone cards come from the same DOM; no duplicate `data-testid` was ever detected across 642
    captures (the automated duplicate-ID check found none).
  - Every page had exactly one `<h1>`, except six loading states (§21).
- **Identity.** Every stock identity goes through `StockIdentity`, and the monogram fallback never
  shifted a row (every capture used it).
- **Status.** Status pills come from `StatusBadge` everywhere except Stock Details and the Admin
  role pill.

### 8.2 Measured drift

| Dimension | Canonical | Observed exceptions |
|---|---|---|
| Breakpoints | Docs: 600 / **768** / **1,024** / 1,280 (`ui-system.md`, `v1-visual-parity.md`, `frontend.md`) | Code: **880** is the switch for tables, cards, nav, bottom nav, `WorkflowFooter` and tokens (28 media queries). **768 and 1,024 appear nowhere.** Local breakpoints: 380 (search), 560 (auth, admin), 620 and 960 (builder), 820, 1,100, 959 (UI-004). |
| Literal font sizes | Tokens | **226** literal `font-size` declarations in feature CSS, from 9 px to 32 px. Heaviest: StrategyBuilder (21), ExplanationPanel (16), DashboardOverview (16), BacktestRunView (12), Billing (10). |
| Page title | `--text-page-title` 17/20 px; display size only on the result hero | AuthCard 30/26 px, Admin 32/26 px, StockStatusPanel 26/30 px, RequireAuth 22 px, and an unused Builder `.pageTitle` at 26 px |
| Buttons | `forms.primaryButton` / `tintedButton` / `secondaryButton` (`--button-height` 44/36) | Auth buttons `min-height: 46px` in `auth-form.module.css`; Stock Details' own `retryButton` |
| Selects | `SelectControl` (only used by the page-size and Dashboard filters) | New Backtest 44 px, Monitor dialog 46 px, Builder 38 px, SelectControl `--action-height` (UI-045) |
| Comboboxes | – | `StockSearch` and `SecurityMultiSelect` share a hook but not a component; they differ in keyboard, ARIA, error copy and blank-state behaviour (UI-035) |
| Segmented controls | – | Three constructions: radiogroup with hidden radios (billing cadence, level %), fieldset of radios (chart range), `aria-pressed` buttons (Dashboard state filter) |
| Section surface | `SectionCard` | Builder cards (`--radius-md`, hard-coded 16/14 px padding), Stock Details' `chartCard` / valuation / metrics cards, `BacktestMetricsRow` (a bordered card inside the hero), `LogicPreview` inside "Logic" (UI-016) |
| Facts | `FactGrid` | Stock Details `<dl>` ("Key facts"), Admin identity `<dl>` |
| Empty / error | `EmptyState` | `StockStatusPanel` (Stock Details), `RequireAuth` gate markup, verify/reset inline states (UI-028) |
| Dates | – | See UI-049: `formatListDate` (en-US) vs `formatStrategyDate` (browser locale), ISO dates in "Detected · from history", native date inputs in OS locale, absolute "Last checked" vs relative "Updated 12 min ago" |

### 8.3 Verdict

It is **one design system** with three dialects and a documentation gap, not a set of
individually-built pages. The collections, New Backtest, the Backtest result and Billing share one
visual grammar that a returning user would recognise on every screen. Stock Details, the Strategy
Builder and the auth/admin/gate pages look like FactorSage — same palette, radius and type family —
but are assembled from local parts. Their titles, error panels and buttons are measurably different.
Evidence:
- `stocks/pro-details-error-desktop-1440.png` against `dashboard/pro-error-desktop-1440.png`: the
  same situation rendered as two different components;
- `admin/master-admin-desktop-1440.png`;
- `auth/login-default-desktop-1440.png` against `lists/free-empty-collection-desktop-1440.png`.

---

## 9. Navigation / shell audit

| Element | Observed | Evidence |
|---|---|---|
| Topbar (≥ 880) | Wordmark → search (≤ 420 px) → Strategies · Monitors · Backtests · Lists → account monogram. Sticky, translucent, 64 px. | `shell/pro-nav-active-lists-desktop-1440.png` |
| Active route | 2 px underline plus primary ink. **No item is active on `/dashboard`, `/stocks/*`, `/billing`, `/pricing` or `/admin`** (Dashboard has no desktop item; the brand is the link). | `shell/pro-nav-on-stock-details-desktop-1440.png`, `shell/pro-nav-on-billing-desktop-1440.png` |
| Topbar (< 880) | Compact mark, inline search (390) or icon-only search (375) that expands to a full-width field with Cancel, then the account monogram. | `shell/pro-topbar-search-mobile-375.png`, `shell/pro-topbar-search-expanded-mobile-375.png` |
| Bottom nav (< 880) | Dashboard · Lists · Monitors · Strategies · Backtests, 60 px plus safe area. Content reserve works: the last card clears the nav. | `shell/pro-bottom-nav-scrolled-to-end-mobile-390.png` |
| Guest topbar | "Pricing" link plus "Sign in" pill. At 390 the search placeholder truncates to "Search AAPL, M". Sign in carries no `?next=` (UI-042). | `shell/guest-topbar-mobile-390.png` |
| Account menu | Email, raw role badge ("USER"/"ADMIN"), Plan and billing, Admin (admins), Sign out, Sign out everywhere. **No plan/tier shown anywhere in the shell** (UI-024). | `auth/pro-account-menu-open-desktop-1440.png`, `auth/master-account-menu-open-desktop-1440.png` |
| Session resolving | The account slot renders nothing, then pops in. Protected routes show text-only "Checking your session...". | `shell/pro-session-checking-mobile-390.png` |
| Page title placement | `PageHeader` (surface) on every product page except the editors (plain), the Backtest result (hero), `/stocks`, Admin and gate pages (bespoke). | – |
| Breadcrumbs | Only the `← {parent}` back link. It points to **Dashboard** from read-only built-ins and to **Admin** for admins, not to the owning collection (UI-016). | `strategies/guest-builtin-readonly-desktop-1440.png` |
| Content width | `data` 1,600 px, `reading` 820 px (New Backtest only). The Builder uses the data width with its own 67/33 grid. | – |
| Global spacing | 16 / 32 / 40 px gutters and a 24/32 px section gap hold on every product page. Exceptions: Stock Details sets its own 16/20 px gap; New Backtest adds a 20 px top padding. | – |

The shell itself is one of the product's strongest parts:
- the navigation order matches the V1-parity spec on both desktop and phone;
- safe-area handling works;
- the bottom-nav reserve never hid content in any capture.

---

## 10. Authentication audit

**Surfaces captured:**
- Sign in: default, empty submit, invalid, submitting, 429, OAuth `oauth_link_not_allowed` and
  `oauth_provider`, Google offered.
- Register: default, submitted, invalid email, 500, Google offered.
- Forgot password: default, submitted.
- Verify email: no token, set-password form, mismatch, too short, success, invalid token, resend.
- Reset password: no token, form, invalid, success.
- Account menus, sign-out, protected-route bounce, signed-in visiting `/login`.

Desktop, 1,024 and 390 were captured. Every email-sending endpoint was mocked.

**Step clarity.**
- *Registration* is honest. The email-only form says "We'll email you a link to confirm the address
  and choose your password". The confirmation is deliberately neutral ("If this address can be
  used…"), so the user knows an email *may* have been sent and that the password is chosen later
  (`auth/register-submitted-desktop-1440.png`).
- *Verify email* is clear that opening the link verified nothing until a password is chosen ("Choose
  the password you will use… nothing is activated until a password is chosen here"). Success is
  explicit: "Your email address is verified and your password is set."
- Success does **not** sign the user in. "Continue to sign in" drops any `next`, so the user retypes
  the password they just chose and lands on the Dashboard (UI-042).

**Findings in this area:**
- **UI-040:** a signed-in user opening `/login` sees the full sign-in form, with no redirect and no
  "you are signed in as …".
- **UI-041:** an empty submit is sent to the API and answered "Unable to sign in with those
  credentials."
- **UI-043:** invalid tokens are handled asymmetrically.
  - Verify-email switches to a dedicated state with a resend form.
  - Reset-password keeps the form and shows the API's raw sentence ("This password reset link is
    invalid or has expired", no full stop) above an enabled "Change password" button that can only
    fail again (`auth/reset-password-invalid-token-mobile-390.png`).
- **UI-044:** auth is a visual island.
  - 30 px titles (26 px below a local 560 px breakpoint), 46 px buttons, "Signing in..." with three
    dots instead of "…", "| FactorSage" tab titles.
  - A blue top border on the card that appears nowhere else.
  - It is standalone, outside the shell — defensible for auth, but the scale should match.
- **Google:** the button appears only when `/auth/providers` says so, on `/login` and `/register`
  only (`auth/login-with-google-desktop-1440.png`). The hermetic stack has no Google, so the
  default captures show none.
- **Sign-out** lands on `/login` with no confirmation copy ("You have been signed out")
  (`auth/after-sign-out-desktop-1440.png`).

Mobile: every auth form fits at 390 without horizontal scroll, and buttons are full width.

---

## 11. Dashboard audit

**What it tries to communicate:** "what is matching now, across my monitors and FactorSage's
built-ins", preceded by a market context strip.

**Composition:**
1. `PageHeader` "Dashboard", with the freshness badge in the aside.
2. A 5-card strip: Run Backtest · S&P 500 · DJIA · VIX gauge · Real-time Matches.
3. For Guests, a sign-in notice.
4. "Current signals": state pills (All/Active/Waiting with counts), an Action select, and a table or
   cards.

The spec says "No redundant visible 'Dashboard' heading"; the page has one.

**States captured:**

| State | Result | Evidence |
|---|---|---|
| Real seeded (3 rows: BUY active ×2, BUY waiting ×1) | Clear pills: outline level badge "Buy 100%" plus solid state badge. "Why" prose reads well on desktop. | `dashboard/pro-collection-desktop-1440.png` |
| 24 mixed rows (BUY/SELL/FINAL EXIT, 4 monitors, repeated securities, long names) | No pagination, no sort, no grouping; QATEST1 appears 6 times in arrival order. Relationship chips truncated. | `dashboard/pro-many-signals-buy-sell-exit-desktop-1440.png` |
| Same at 1,024 / 880 | Chips collapse to "QA Bu…", "Q…", a lone "(" (UI-003) | `dashboard/pro-collection-tablet-1024.png`, `…boundary-880.png` |
| Same at 879 | Phone cards stretched across ~850 px; "Why" prose right-aligned across the card | `dashboard/pro-collection-boundary-879.png` |
| Same at 390 | **Page scrolls sideways (document 756 px)** (UI-002). "Why" right-aligned in a 3-line block (UI-011). | `dashboard/pro-many-signals-scrolled-sideways-mobile-390.png` |
| Filter Waiting / Sell+Waiting | Filtered-empty "No signals match these filters", with no "clear filters" action | `dashboard/pro-filter-sell-waiting-empty-*.png` |
| No matches | "Nothing is matching right now" (compact) | `dashboard/pro-no-matches-*.png` |
| No monitors shown | "No monitors are shown" + "Go to monitors" | `dashboard/pro-no-monitors-shown-*.png` |
| Stale / not scanned | Page badge "Stale · last scan …" / "Not scanned yet". **Rows carry no freshness of their own.** | `dashboard/pro-stale-*.png`, `dashboard/pro-not-scanned-*.png` |
| Loading | Strip placeholders plus 6 skeleton rows | `dashboard/pro-loading-*.png` |
| Error | Red-tinted EmptyState "The dashboard could not be loaded" + Try again. The market strip degrades to "No data". | `dashboard/pro-error-*.png` |
| Market unavailable | Cards read "No data" and keep their size | `dashboard/pro-market-unavailable-*.png` |
| Guest | Same page plus the notice "You are viewing FactorSage's built-in monitors…" and a tinted "Sign in" (no `next`) | `dashboard/guest-collection-*.png` |
| Free-empty | Built-in rows only; nothing tells the user their own monitors would appear here | `dashboard/free-empty-collection-desktop-1440.png` |

**Can a user answer the key questions quickly?**

| Question | Answer |
|---|---|
| What is matching now? | Yes: one row per monitor outcome. |
| BUY or SELL? | Yes: green/red/amber outline badge with a text label. |
| Which stock? | Yes, and the ticker is protected by UX-007. |
| Which strategy / list / monitor? | On desktop ≥ 1,280, mostly; truncated chips degrade at 1,024–1,279. On phone yes, as labelled rows. |
| When was it last checked? | Only page-level ("Updated 12 min ago"), computed at render and not ticking. Per-monitor freshness is in the payload (`monitors[].freshness`) but not shown per row. |
| Is the signal still active, and since when? | "Active" yes; **"since when" no** — `since` and `observationDate` are in every row of the contract but never rendered (UI-025). |
| Was something recently closed? | **No.** Closed signals exist only on each monitor's detail page (UI-026). |
| Multiple matches for the same security? | Rendered as separate unrelated rows, not grouped. |
| BUY and SELL simultaneously for one security? | Two rows with different colours. Correct, but easy to miss without grouping. |

---

## 12. Stock search audit

**Topbar combobox (`StockSearch`).** Lifecycle observed and confirmed in code:
1. Page loads; recents load once when the session resolves. Signed-in users call
   `GET /recent-searches`. A guest with ids in localStorage calls `GET /recent-searches?ids=…`; a
   guest with none makes no request.
2. Focus with a blank query opens the panel:
   - **"Recent Searches"**: up to 5 *recently viewed* stocks. They are recorded by Stock Details on
     load, not by searching; the label says "searches" (UI-058).
   - **"Popular Searches"**: 3 items from a static pool (AAPL, MSFT, NVDA…), not catalog-checked.
3. Typing is debounced 250 ms, with a minimum of 1 non-blank character. Filtering is server-side,
   the server default is 8 results, and there is no cache. Previous results stay while the next
   request loads; the first load shows "Searching…" and a pulsing dot.
4. Arrow keys wrap. Enter picks the highlighted row, or the first row — including the first
   *shortcut* when the query is blank. Escape closes.
5. Selecting navigates to `/stocks/{SYMBOL}` (guarded by the unsaved-changes check) and clears the
   field.
6. Recents appear only when non-empty and disappear when there are none. There is no clear or
   remove control. After a guest views QATEST1, the recents appear from localStorage
   (`stocks/guest-search-recents-after-view-desktop-1440.png`).

States: `stocks/*-search-focused-blank-*`, `*-results-*`, `*-keyboard-highlight-*`,
`*-long-company-name-*` (truncates with an ellipsis), `*-no-results-*` ("No stocks match 'zzqqxx'."),
`pro-heavy-search-error-*`, `pro-heavy-search-rate-limited-*`, `pro-heavy-search-loading-*`.

**Findings:**
- The rate-limited state says "Too many requests. Please try again in 42 seconds." and still offers
  a **"Try again"** button (UI-036).
- The list picker (§19) gets none of this: it has no recents, no rate-limit copy and no spinner
  (UI-035).
- `/stocks` itself is a stale placeholder (UI-051).

---

## 13. Stock Details audit

**Layout:**
1. `PageHeader` with the logo/monogram, ticker, company, exchange/currency pills and a price aside
   ("▲ +$0.65 (+0.43%) · At close · Sep 11, 2026 · End-of-day data").
2. "Price history" card: range pills, the Indicators popover and the chart.
3. Intrinsic value (blend tiles and a model list with "vs price" chips).
4. Key facts.
5. Technicals.

Evidence: `stocks/pro-details-qatest1-*` at all six viewports.

**Strong:**
- The honest "End-of-day data" labelling.
- Viewport-driven history: MAX extends the chart with a spinner overlay, and failures give "Older
  history could not be loaded. Try again" (`stocks/pro-details-history-error-desktop-1440.png`).
- Unavailable indicator entries are disabled and marked "Unavailable".
- The RSI pane has 30/50/70 guides, and the crosshair legend shows every selected series
  (`stocks/pro-details-overlays-rsi-*`, `stocks/pro-details-crosshair-*`).
- The page-shaped loading skeleton is the best loading state in the product.

**Issues:**
- **No actions from a stock** (UI-018). There is no "Add to list", "Backtest", "Monitor" or "Open in
  list" action. The page is a dead end for acting on what the user just researched.
- **The overlay legend is hover-only.** The default "Balanced" overlay is a flat green line with no
  label until the crosshair moves (`stocks/pro-details-qatest1-desktop-1440.png`). On a phone the
  legend appears only after a touch and then covers the top of the chart.
- **Two opposite sign conventions sit side by side.**
  - Intrinsic value: "+5.94% vs price" means the *value* is 5.94% above the price.
  - Technicals: "price +4.24%" means the *price* is above the average.
  - Green means "value above price" in one panel and "price above average" in the other.
- **Unbalanced columns.** The desktop right column (Key facts) ends early, leaving a large empty
  area beside Technicals.
- **Phone spec gap.** The spec's phone "compact summary grid (price, market cap, sector)" is not
  implemented, and market cap appears nowhere.
- **Island primitives** (UI-017). Not-found and error use a bespoke `StockStatusPanel` with a 26/30 px
  title and a "FACTORSAGE" eyebrow, unlike every other page's `EmptyState`
  (`stocks/pro-details-unknown-symbol-*`, `stocks/pro-details-error-desktop-1440.png`).
- **Missing data looks transient.** A catalog stock the loader cannot hydrate shows "Something went
  wrong… This is usually temporary" with Try again (`stocks/pro-details-real-symbol-no-local-data-*`).
  The UI cannot distinguish "temporarily failed" from "not available for this security"; that is
  partly an environment artifact here.
- **QATEST2**, complete but empty, shows the header with "No recent price data" and the "Not enough
  price history to draw a chart." frame (`stocks/pro-details-qatest2-no-data-*`). That is an
  explicit, honest empty state.

---

## 14. Lists audit

### Collection (`/lists`)

- **Composition.**
  - `PageHeader` "Lists" / "Reusable stock universes for strategies, backtests, and monitors."
  - `SectionCard` "Your lists" (flush `DataTable`: Name + optional description, Stocks, Updated,
    Actions = `Open` + `…`).
  - `SectionCard` "Built-in lists": the same columns, plus a "Built-in" badge on every row.
- **Every persona captured** at 1,440 / 1,024 / 390; pro-heavy also at 1,280 / 880 / 879.
- **Empty (free-empty).**
  - The header has **no "New list"**.
  - The empty state sits inside the titled "Your lists" card as a dashed compact panel: "You haven't
    created any lists yet" + a **solid primary** "New list"
    (`lists/free-empty-collection-desktop-1440.png`).
  - Once a list exists, "New list" moves to the header as a **tinted** button (UI-030).
- **Two stacked tables with different column geometry.** "Stocks" sits ~60 px further right in the
  built-in table than in "Your lists" (`lists/pro-heavy-collection-desktop-1440.png`) (UI-007).
- **Density (pro-heavy, 30 lists).**
  - Page 1 of 2 at 25 rows, ordered newest first. The account's most important lists — the 100-stock
    one and the long-named one, created first — are on page 2.
  - There is no search, filter or sort (UI-010).
  - On a phone the 30 cards make a 5,738 px page; each card is ~180 px for three facts.
- **Phone cards.** `Open` and `…` sit together at the card bottom. The spec puts the overflow at the
  top-right. The menu opens off-screen to the left, cutting "Delete" to "elete"
  (`lists/starter-row-overflow-open-mobile-390.png`) (UI-006).
- **Downgraded.** A "Status" column appears only when an own list is non-compliant, showing
  "Over plan limit" (warning). The explanation is a `title` tooltip only
  (`lists/downgraded-collection-desktop-1440.png`) (UI-021).
- **Guest.**
  - "Built-in lists" only, plus a tinted "New list" that opens "Sign in to create a list"
    (`lists/guest-new-list-sign-in-prompt-*`).
  - A fetch error tells the Guest "Your lists could not be loaded" (`lists/guest-collection-error-desktop-1440.png`).
- **No Run Backtest** on any row (UI-008).

### New / Edit list

- **Create.** A modal "New list" with Name (placeholder "e.g. Dividend compounders"),
  "Description · optional", Stocks (`SecurityMultiSelect`) and the hint "Every stock starts with full
  buy eligibility…".
  - Buttons: Cancel + "Create list".
  - Validation "A list needs a name." appears only after submit (`lists/starter-new-list-validation-*`).
  - Success navigates to the new list.
- **Rename.** The overflow item says "Rename", but the dialog is titled **"Edit list"** and also edits
  the description (`lists/starter-rename-dialog-*`).
- **Detail header.** "Edit" (tinted) + "…" (Delete list) (`lists/starter-own-list-detail-*`).

### List detail (`/lists/[id]`)

- **Anatomy.**
  - Header: name, lead (description), badges "N stocks" (and "Built-in" / "Over plan limit").
  - "Add stocks" section: picker + primary "Add to list" / "Add N stocks".
  - "Stocks" section: Stock (identity), Membership, Exchange, Actions = `Membership` + `…`
    ("Remove from list").
- **Initially empty** (`lists/starter-empty-list-detail-*`): "Add stocks" first, then the compact
  "No stocks yet — Search above to add supported stocks to this list."
- **With stocks.** Rows are in API order; there is no reordering and no sort.
  - Duplicates are impossible. Members appear in the picker as muted "In list" rows
    (`pickers/starter-add-stocks-in-list-markers-*`).
  - A chosen stock re-appears as "Selected", and choosing it again unselects it.
- **Remove.** `ConfirmDialog` "Remove stock — Remove QATEST2 and its membership periods from this
  list?" (`lists/starter-remove-stock-confirm-*`).
- **Delete list.** The collection's dialog says "…its buy-window configuration"; the detail's says
  "…every stock's membership configuration" (UI-058).
- **Many members.** The 45- and 100-stock lists render every member with no pagination
  (`lists/starter-45-stock-list-detail-*`, `lists/pro-heavy-100-symbol-list-detail-*`). They stay
  readable on desktop, but the phone page is ~9,000+ px.
- **At the Free limit (10/10).**
  - With an 11th stock chosen there is no counter, no warning, and "Add to list" stays enabled
    (`lists/free-limit-at-10-before-add-*`).
  - Pressing it produces the API sentence "Your plan allows 10 stocks per list; this change would
    make 11", with no upgrade route (`lists/free-limit-add-refused-*`).
  - Creating an 11-stock list behaves the same (`lists/free-limit-new-list-11-chips-desktop-1440.png`,
    `…-refused-…`) (UI-020).
- **Built-in (guest)**: read-only, back link "← Dashboard" (UI-016).
- **Built-in (admin)**: the ordinary editor (`lists/master-builtin-list-editable-*`).

### Buy windows ("Membership")

Membership editor dialog states:

| State | Behaviour | Evidence |
|---|---|---|
| FULL | Radio "Always eligible" selected | `lists/starter-membership-always-eligible-*` |
| Switch to period | "Membership period" defaults to **From empty, Present checked** | `…-membership-period-default-*` |
| Save with no start | "Pick the date membership starts" | `…-membership-missing-start-*` |
| End before start | "Membership cannot end before it starts" | `…-membership-end-before-start-*` |
| Valid bounded | Live preview "Saves as Jun 1, 2025 → Jan 1, 2026" | `…-membership-valid-preview-*` |
| Several stored periods (3) | **Read-only**: lists the periods, "This editor manages a single period, so saving here would replace all 3", a "Replace with one period" button, and "Close" instead of Cancel | `lists/pro-heavy-membership-multi-period-readonly-*` |

- **Open-ended periods** render as "→ Present". Overlap and adjacency cannot be entered because
  only one period is editable, so there is no overlap copy anywhere.
- **Wrong period shown** (UI-019). The member table shows the *first* stored period — here the
  expired 2015–2018 one — plus "+2 more". The period in force today ("Sep 19, 2025 → Present") is
  hidden behind the tooltip.
- **Mixed date formats.** The date inputs render in the OS locale ("01.06.2025", "dd.mm.yyyy")
  while every displayed date is "Jun 1, 2025" (UI-049).
- **Mixed terminology.** The UI says "Membership" in the editor and table, but "buy windows" in the
  create hint, the empty state and the delete dialog (UI-058).

---

## 15. Strategies audit

### Collection

- Same anatomy as Lists. Columns: Name, **Levels** (an outline pill, e.g. "3 buys · 2 sells · final
  exit"), Version ("v1"), Updated, Actions.
- **New strategy** is a *route* (Lists uses a modal). This is deliberate (see §19), but the header
  button looks identical.
- **Delete of a strategy in use** gives a real 409: "This strategy is used by a monitor. Delete the
  monitor first." inside the confirm dialog (`strategies/starter-delete-refused-in-use-desktop-1440.png`).
  The copy is good, but the page never says *which* monitor, and there is no reverse-usage indicator
  anywhere (a known read-model gap).

### Builder (`/strategies/new`, own `/strategies/[id]`)

Captured blank and built-up at 1,440, 1,024, 879 and 390; editing the 3-BUY / 2-SELL / 3-exit
ladder at 1,440, 1,280, 1,024, 879 and 390.

**Initial blank state** (`strategies/starter-new-blank-*`):
- Page header "New strategy" + lead; Details card; "BUY LEVELS" (green), "SELL LEVELS" (red),
  "FINAL EXIT" (amber) sections, each with a dashed hint and an "+ Add …" button.
- A side "Strategy logic" preview ("Add a buy level to see this strategy in words.").
- A sticky save bar that already reads **"2 issues to fix"** in red, with a disabled "Save strategy"
  (UI-013). There is no Cancel.

**Building:**
- **+ Add buy level** creates "BUY 1" with 25% selected and **one complete condition, "Price is
  above SMA 20D"**.
- **+ Add condition** adds a second identical "AND Price is above SMA 20D".
- **+ Add trigger** adds "Price crosses above SMA 20D".
- **+ Add final exit** and **+ Add OR rule** each add another "Price is above SMA 20D" rule.
- The result: the preview reads three identical exit rules ORed together, and the issue count
  climbs (`strategies/starter-new-final-exit-three-rules-*`). Defaults are real logic, not empty
  placeholders (UI-013).

**Exit rules:**
- With several rules each gets "EXIT RULE n" + Remove, separated by "OR".
- Removing rule 2 renumbers the rest (`…-final-exit-middle-removed-*`).
- The preview says "RULE n" and the button says "+ Add OR rule" — three wordings for one concept
  (UI-058).
- The FINAL EXIT card repeats its section's heading ("FINAL EXIT" / "FINAL EXIT") (UI-014).

**Controls:**
- Level percentages are segmented radiogroups: 25/50/75/100 for BUY, 25/50/75 for SELL.
- ↑/↓ reorder levels. **"Remove" is red text on every level and removes immediately, with no confirm
  and no undo** (UI-014). The product otherwise hides destructive actions in overflow menus and
  confirms them.

**Nested selectors** (native `<select>`, 38 px, builder-local styling):
- **Metric**, grouped:
  - Price;
  - Moving averages (14: SMA/EMA 20/50/100/200 D and W);
  - Oscillators (RSI 7/14/21 D);
  - Valuation (7 × "Margin of Safety (…)", including "Margin of Safety (DCF (FCFF))" and
    "Margin of Safety (Dividend Discount (DDM))");
  - Position (Gain/Loss; SELL and FINAL EXIT only).
- **Operator**: "is above / is below / is close to" (conditions); "crosses above / crosses below"
  (triggers).
- **Value**: a series select, or a number with "%".
- No API calls; options come from the contracts registry. An invalid stored value shows as an
  injected "Unavailable metric" / "Unavailable" / "Choose" option.

**Contextual help:**
- Focusing a metric drives the explanation panel: title, definition, formula, worked examples, and
  "Not evaluable when…" (`strategies/starter-new-metric-focus-help-*`).
- On desktop it is a sticky side panel; below 960 px it appears inline under the focused row.
- This is the best domain explanation in the product. It is absent from the Monitor and Backtest
  forms, where the same concepts (membership, maximum positions, triggers) matter.

**Editing:**
- A dirty form shows "Unsaved changes" + "Discard changes" + "Save strategy"
  (`strategies/starter-edit-dirty-save-bar-*`).
- The page title stays **"Edit strategy"**, not the strategy's name, and the rename dialog is also
  titled "Edit strategy" (UI-015).
- The editor has no Delete, no overflow menu and no "Backtest this strategy".

**Phone:**
- Predicate fields stack three per row.
- The save bar sits above the bottom nav; together they take ~150 px of an 844 px viewport.
- The explanation appears under the focused row.
- The logic preview is an open `<details>` at the end of the page.

**Read-only built-in** (`strategies/guest-builtin-readonly-*`):
- `PageHeader` with a "Built-in" badge and a tinted "Backtest this strategy".
- A "Logic" SectionCard that contains a second bordered card titled "Strategy logic" (card-in-card
  with a duplicate heading), and the back link "← Dashboard" (UI-016).
- Guests get the SignInPrompt "Sign in to run a backtest… you will come straight back here". "Here"
  is the strategy page, not the prefilled backtest the decision record describes (UI-042).

---

## 16. Backtests audit

### Collection

| State | Observed | Evidence |
|---|---|---|
| Empty (free-empty) | EmptyState **directly on the canvas** (not in a titled card like the other three collections), solid "Run your first backtest", **no header "New backtest"** | `backtests/free-empty-collection-desktop-1440.png` |
| Populated | Columns: Strategy (+ period), Status, Stock list (chip, **static: no ids**), Benchmark (chip + return), Portfolio, Excess return, Queued (desktop only), Actions ("View results", terminal runs only) | `backtests/pro-collection-desktop-1440.png` |
| Long names (pro-heavy) | **Table 1,735 px wide in a 1,358 px surface; Excess return / Queued / View results off-screen** (UI-001) | `backtests/pro-heavy-collection-desktop-1440.png`, `…-table-scrolled-right-…` |
| Every status | Queued / Preparing data (pending) → Running / Finalizing (active, inline progress + message) → Completed / Failed | `backtests/pro-collection-every-status-*` |
| 60 runs | Paged 25; extreme returns (+1,287.50%, −43.21%) align; long strategy name wraps to 5 lines | `backtests/pro-collection-60-runs-*` |
| In-flight (free-limit) | RUNNING 42% row. **The collection is never polled**, so the row stays at 42% until reload (UI-048). | `backtests/free-limit-collection-*` |
| Guest | Redirect to `/login?next=%2Fbacktests` | – |

### New Backtest

**Field order:**
1. Strategy (optgroups "Built-in (1)" / "Your strategies (25)")
2. Stock list ("Built-in" / "Your lists")
3. Benchmark (defaults to S&P 500)
4. Start date (default today − 5 y) + **MAX**
5. End date (today)
6. Initial capital (10000)
7. Monthly contribution · optional
8. Maximum positions (10), with a live help box: "10 positions → a full position is 10% of the
   portfolio; a 25% BUY level targets 2.5%"

The `WorkflowFooter` carries the summary "{strategy} over {list}", Cancel and "Run backtest". Evidence:
`backtests/pro-heavy-new-initial-*` at all six viewports.

**Enablement and dependencies:**
- Only the three selects are disabled, and only while options load. The loading state has no text
  (`backtests/pro-heavy-new-loading-*`).
- No field depends on another.
- Choosing a list shows **no metadata**: no symbol count, no "exceeds your plan's 10-stock backtest
  limit". Choosing a strategy shows nothing of its logic.

**Validation:**
- On submit, errors appear under each field and "Run backtest" keeps focus
  (`backtests/pro-heavy-new-validation-*`). The spec's "focus/scroll to first invalid field" is not
  implemented.
- On a phone the server refusal renders at y ≈ 1,216 px in an 844 px viewport, invisible from the
  sticky bar (`backtests/free-limit-new-refused-viewport-after-tap-mobile-390.png`) (UI-005).

**Limits:**
- MAX always sets 30 years. On Free this is guaranteed to fail with "Your plan allows 5 years of
  backtest history; this period covers 30" (`backtests/free-normal-new-history-limit-refused-*`)
  (UI-023).
- Concurrency: "Your plan runs one backtest at a time; wait for the current one to finish"
  (`backtests/free-limit-new-concurrency-refused-*`). There is no link to the running run.

**Prefill and prerequisites:**
- `?strategyId&stockListId` prefill works (`backtests/pro-heavy-new-prefilled-max-*`). Unknown ids
  are silently ignored.
- The prerequisites notice appears only when *no* strategy or list exists at all. Built-ins count,
  so free-empty sees the normal form (`backtests/free-empty-new-initial-*` vs
  `…-prerequisites-missing-*`).

### Result (`/backtests/[id]`)

**Completed** (`backtests/pro-heavy-result-completed-*`, six viewports) — the product's best screen:
- A hero with back link, display title, "Completed", and "list · period · vs benchmark".
- Year milestone chips.
- The Strategy / S&P 500 / Cash absolute-value chart, bounded pan and zoom, with a legend.
- An 8-KPI "Results" row.
- A collapsed "Run configuration" (snapshot facts and linked entities).
- Final holdings; a trade log (19 trades, newest first, realised P/L signed and toned).

**Chart observations:**
- The Strategy line (#4882FF) and the Cash line (#B9C6E8) are two blues. Where they overlap
  (2023–24 here) they are hard to tell apart (UI-032).
- The crosshair legend works (`backtests/pro-heavy-result-chart-crosshair-*`).

**Other states:**
- **Running** (`backtests/free-limit-result-running-*`): the phase "Running", "42%", a progress bar
  and "Simulating". The chart frame is empty but already spans the full period, with KPIs "—",
  "Holdings 0 / No positions have been opened yet" and "Recent trades 0".
- **Queued** (mocked): the same with "Queued 0%".
- **Failed** (real: 100 data-less fixture stocks; 27 real symbols with no local data)
  (`backtests/pro-heavy-result-failed-*`), top to bottom:
  1. A red box: "Backtest failed / The backtest could not be completed. Please try running it
     again."
  2. Phase "Preparing data", failure code `EXECUTION_FAILED`, a Run ID with a "Copy" button, and a
     solid "Start a new backtest".
  3. Below that: the chart placeholder "This run produced no comparison curve.", 8 KPIs of "—",
     "No positions have been opened yet." and "Trade log 0 — This run made no trades."

  This is the worst-communicated state in the product (UI-031):
  - the message blames nothing and invites a retry that cannot help;
  - the implementation code is shown;
  - the CTA discards the configuration;
  - the empty sections read as if the run had executed.
- **Historic summary-only** (downgraded fixture): KPIs present, but the chart reads "This run
  produced no comparison curve" and there are no trades (`backtests/downgraded-result-historic-summary-only-*`).
  Honest, if unexplained.
- **The hero has no actions**: no "Run again with these settings", no "Edit strategy", no "Open
  list" beyond the collapsed configuration's links (UI-032).
- **Phone**: KPIs in 2 columns (the spec asks for 4). The 120-character strategy name wraps to 4
  lines at the 28 px display size (UI-033).

---

## 17. Monitors audit

### Collection

- Sections "Your monitors" and "Built-in monitors".
- Own columns: Monitor, State ("Enabled"/"Disabled", plus "Not scanning"), Strategy chip, Stock list
  chip + "N stocks", Active signals, Last checked (absolute), Actions (`Open` + `…`
  Disable/Edit/Delete).
- Built-in columns: Monitor, **"On my dashboard" switch**, the same references, and `Open` (+ Edit
  for admins).
- **pro-heavy (13 monitors, long names)**: the table is 2,110 px wide. The Monitor column collapses
  to ~97 px with mid-word breaks; Active signals, Last checked and Actions are off-screen
  (`monitors/pro-heavy-collection-desktop-1440.png`, `…-table-scrolled-right-…`) (UI-001).
- **starter-limit (3/3 active)**: no capacity indicator; "New monitor" looks identical
  (`monitors/starter-limit-collection-*`).
- **downgraded**:
  - Monitors 1–3 show "Enabled" *and* "Not scanning" stacked, with the reason in a tooltip only.
  - Monitor 4 shows "Disabled".
  - Nothing on the page says the account is over its plan (`monitors/downgraded-collection-*`)
    (UI-021).
- **Guest**: built-ins only; toggling a switch opens "Sign in to choose your dashboard monitors"
  (`monitors/guest-visibility-switch-prompt-desktop-1440.png`).

### New / Edit Monitor (modal)

- **Options load when the dialog opens** (`GET /strategies` + `GET /lists`, no cache), shown as
  "Loading your strategies and lists…" (`monitors/starter-new-monitor-loading-*`).
- **Fields:**
  - Name (placeholder "e.g. Value entries — core universe").
  - Strategy (flat list, **own strategies only**), with two always-visible hints about live editing
    and Gain/Loss.
  - Stock list (flat, own only), with a membership hint.
  - "Start monitoring now" — a pre-ticked checkbox; the product has a `Switch` component
    elsewhere.
  - Buttons: Cancel + "Create monitor".
- **Validation**: "A monitor needs a name.", "Choose a strategy.", "Choose a stock list."
  (`monitors/starter-new-monitor-validation-*`).
- **No own content (free-empty)**: a warning panel says "You do not have a strategy or a stock list
  yet. Create both, then come back to start monitoring." with two buttons
  (`monitors/free-empty-new-monitor-prerequisites-*`). The user can see built-in strategies and
  lists on every other page and use them in a backtest, so "you do not have a strategy" contradicts
  the rest of the product (UI-009).
- **At the Free limit**: after the whole form is filled, "Your plan allows 1 active monitor; you
  already have 1". Unticking "Start monitoring now" would succeed, but the message does not say so
  (`monitors/free-limit-new-monitor-refused-*`) (UI-022).
- **Edit**: the same dialog, titled "Edit monitor". Changing the strategy reveals the rebind note
  "Changing the strategy or stock list starts monitoring the new configuration from the next scan…"
  (`monitors/pro-heavy-edit-dialog-rebind-note-*`). The note is clear and appears at the right
  moment.
- **Options error**: "Your strategies and lists could not be loaded, so there is nothing to choose
  between yet." + Cancel / Try again (`monitors/starter-new-monitor-options-error-*`).

### Detail (`/monitors/[id]`)

- **Header**: name, "Enabled"/"Built-in"/"Running" pills. Actions: "Edit monitor" (tinted) + "…"
  (Disable / Delete monitor), or for non-owners the tinted "Backtest this monitor". Owners get **no
  backtest action** (UI-008).
- **Configuration card**: Linked (Strategy, Stock list chips), Stocks, Active signals, Last checked
  (absolute).
- **Monitored stocks**: Stock, Status (all five: Matched, Waiting for trigger, No match, Not
  evaluable, Not checked yet), Signal chips ("Buy · Trigger", "Final exit · Condition",
  "Buy · waiting for trigger"), Price (matched only), Status since.
- **Recent signals**: Stock, State ("Active" or "Ended {datetime}"), Level chip, Price, Detected
  (either "Sep 18, 2026, 11:00 AM" or "2026-09-18 · from history").
- **Dense (mocked: 30 stocks, 100 signals)**: a 9,128 px page with no pagination, no status filter,
  and Matched rows not brought to the top. The 100-row cap reads "Showing the 100 most recent
  signals. Older ones are kept but are not listed here yet." (`monitors/pro-heavy-monitor-detail-dense-*`)
  (UI-026).
- **Closed signals** show *when* they ended but never *why*. `resolutionReason` (e.g.
  `BUY_WINDOW_CLOSED`, `MEMBER_REMOVED`, `LOGIC_CHANGED`, `MONITOR_REBOUND`) is in the contract and
  not rendered (UI-026).
- **"Not evaluable"** has no per-row reason. On the hermetic stack every own-monitor stock is "Not
  evaluable" (`monitors/pro-heavy-own-monitor-detail-*`) and the user cannot tell why.
- **Empty** (mocked): "No stocks to evaluate… Add some to {list} and the next scan will evaluate
  them."
- **Timestamps** are absolute local datetimes ("Sep 19, 2026, 03:01 AM"), while the Dashboard is
  relative ("Updated 12 min ago") (UI-049).
- **Admin on a built-in**: overflow "Pause for everyone" / "Unpublish" and "Published" pills
  (`monitors/master-builtin-monitor-admin-menu-*`).
- **Other account's monitor**: "This monitor no longer exists — It may have been deleted", which is
  wrong for a monitor that exists but belongs to someone else (UI-057).

---

## 18. Billing / pricing audit

Every subscription state was mocked on `GET /billing/status`; no Stripe object was created.

| State | Header | Cards | Evidence |
|---|---|---|---|
| Free | "Billing & Plan" + "Free" badge, no Manage billing | Free "Current plan" (disabled), Starter "Upgrade to Starter", Pro "Upgrade to Pro" (primary) + "Recommended" | `billing/mock-free-*` |
| Billing disabled | – | Paid cards without buttons + note "Subscriptions are not available in this environment…" | `billing/mock-free-billing-disabled-*` |
| Starter monthly | "Manage billing" | Free "Cancel subscription" (portal), Starter current, Pro "Upgrade to Pro"; "Your subscription" → Billing Monthly / Renews date | `billing/mock-starter-monthly-*` |
| Starter annual | toggle opens on Yearly | "Switch to monthly" / "Takes effect at your next renewal" | `billing/mock-starter-annual-*` |
| Pro monthly / annual | – | "Downgrade to Starter" (renewal), Free "Cancel subscription" | `billing/mock-pro-monthly-*`, `…-pro-annual-*` |
| Cancel pending | "Access until" | Other cards buttonless: "Resume your subscription to change plan" — **no Resume action exists on the page** (UI-038) | `billing/mock-pro-cancel-pending-*` |
| Scheduled downgrade | "Changing to Starter monthly on …" | Starter "Scheduled for your next renewal" | `billing/mock-pro-scheduled-downgrade-*` |
| Past due | warning notice ("Your last payment did not go through…") | plan kept | `billing/mock-starter-past-due-*` |
| Incomplete | info notice | Starter "Waiting for payment confirmation" | `billing/mock-free-incomplete-*` |
| **Canceled Pro annual** | "Your subscription has ended. You are on the Free plan." | Toggle opens on **Yearly**; **Pro card: no button, "Waiting for payment confirmation"** (UI-037) | `billing/mock-free-canceled-pro-annual-*` |
| Unrecognised price | "Contact support…" | – | `billing/mock-pro-unrecognised-price-*` |
| Loading / error | "Loading your plan…" (text only) / "Your billing details could not be loaded." + Try again | – | `billing/mock-loading-*`, `billing/mock-error-*` |
| Checkout success | "Payment received — we are confirming…" then, after 6 × 1.5 s, "**Payment received. Your plan below reflects your confirmed subscription.**" while the plan is still Free (UI-046) | – | `billing/mock-checkout-success-settling-*`, `…-window-expired-*` |
| Checkout cancelled | "Checkout was cancelled. Nothing was charged…" | – | `billing/mock-checkout-cancelled-*` |
| Action failure / pending | "Working…" on the card; API message in a red notice | – | `billing/mock-upgrade-pending-*`, `billing/mock-upgrade-failed-*` |

**Pricing** (`billing/guest-pricing-*`, `…-pricing-signed-in-*`):
- The same `PlanCatalog`: monthly/yearly toggle, "Billed annually · save $9/$49", and a "How
  billing works" card.
- Guest CTAs: "Start for free" / "Choose Starter" / "Choose Pro", which open "Sign in to choose a
  plan".
- Mobile stacks the three cards with their CTAs aligned to their own content.

**Claims against entitlements** (UI-039):
- The five feature rows are derived from `PLAN_ENTITLEMENTS`, so the numbers are right.
- **"Stocks per backtest"** (10/50/100, enforced separately) is not stated.
- **"Backtests over N years of history"** reads as a look-back limit; it is a *period-length* limit,
  and any plan may start 30 years back.
- An admin on Free sees Free's numbers although their limits are unlimited.
- The **Free card on the Yearly toggle** shows "$0 / year".

**Naming and discoverability.** The header says "Billing & Plan"; the account-menu item, the
`/pricing` link and the tab title say "Plan and billing" (UI-047). The current plan is visible only
on `/billing` — not in the account menu (which shows the role "USER") and not in the shell (UI-024).

---

## 19. Picker / component audit

**Summary.**
- There is **no shared combobox, listbox or popover primitive**. `SelectControl` (a label beside a
  native select) is used only by the page-size selector and the Dashboard Action filter.
- No picker shows a plan limit, and none is cached across navigations.
- Native `<select>` open states cannot be captured in a screenshot (the OS draws them), so their
  option sets were recorded from the DOM.

### 19.1 Topbar stock search — custom combobox

| Aspect | Observed |
|---|---|
| Closed | Placeholder "Search AAPL, Microsoft, NVIDIA…", no visible label (aria "Search stocks"), clear "×" once typed. Below 380 px: icon button → full-row field + "Cancel". |
| Open | Panel under the field (≤ 420 px wide on desktop), `max-height: min(320px, 50dvh)`, scrolls. Sections "Recent Searches" / "Popular Searches" (blank) or "Results". |
| Selected / hover / keyboard | Highlight = `aria-selected` + tint. Arrow keys wrap, Enter, Escape. |
| Empty / loading / error | "No stocks match "…"." / "Searching…" + dot / API copy (429: "Too many requests. Please try again in 42 seconds.") + "Try again" |
| Long names | Company name truncates with an ellipsis (`stocks/*-search-long-company-name-*`) |

Lifecycle:
1. Recents load with the session.
2. Focus shows recents and popular with no request.
3. Typing waits 250 ms (min 1 character), then calls `GET /stocks/search?q=`.
4. Up to 8 server-ranked results replace the list; the previous results stay while the next request
   loads.
5. Selecting closes the panel, clears the field and navigates.
6. Stock Details records the view, and recents re-order on next load.

The results are deterministic for a given catalog, and no account-specific data appears.

### 19.2 List stock picker — `SecurityMultiSelect`, a second custom combobox

| Aspect | Observed |
|---|---|
| Closed | Chips (symbol only, "×") + input. Placeholder "Search stocks…" → "Add another…". Backspace removes the last chip. Label "Stocks" is a `<span>` in the create dialog. |
| Open | Only when there are results or a status. **A blank focus shows nothing** (no recents or popular) (`pickers/starter-list-picker-focused-blank-*`). Full field width, max-height 280 px. |
| Row states | Default (exchange shown), "Selected" (green text), "In list" (muted, `aria-disabled`) |
| Empty / loading / error | "No stocks match "zzzzqqq"." / "Searching…" (no spinner) / **always "Search is unavailable right now. Try again"**, even for a 429 (`pickers/starter-list-picker-rate-limited-*`) (UI-036) |
| Keyboard | Arrows wrap. Enter toggles the highlighted or first row and never submits the form. Escape closes. `aria-selected` means *chosen* here (it means *highlighted* in 19.1); the listbox has no label (UI-035). |

Lifecycle:
1. Typing ("Q") waits out the debounce (`…-typing-debounce-*`), then shows results (`…-results-*`).
2. Choosing a result adds a chip, clears the query and closes the panel.
3. Searching again marks the chosen row "Selected" (`…-selected-marker-*`); choosing it again
   removes the chip.
4. Nothing is saved until "Create list" / "Add N stocks".
5. After save, the members appear in API order.

Previously chosen entities stay as chips across searches. Members of the current list are shown,
not hidden.

### 19.3 New Backtest selects (native)

| Picker | Placeholder | Grouping | Load | Default | Unknown/deleted id |
|---|---|---|---|---|---|
| Strategy | "Select a strategy…" | `<optgroup>` "Built-in" then "Your strategies" (server order: `updatedAt` desc) | with the page (`Promise.all` of strategies, lists, benchmarks) | none, or `?strategyId` | silently ignored |
| Stock list | "Select a stock list…" | "Built-in" / "Your lists" (`createdAt` desc) | same | none, or `?stockListId` | silently ignored |
| Benchmark | "Select a benchmark…" | flat | same | SP500 | – |

- **Disabled** while loading, with no loading text. **Error** replaces the whole page
  (`backtests/pro-heavy-new-load-error-*`).
- **Many options**: pro-heavy's list select has 33 entries in one native menu with no search.
- **Selection** shows only the name; there is no symbol count or ownership detail.

### 19.4 Monitor dialog selects (native)

- Strategy and Stock list: "Select a strategy…" / "Select a stock list…".
- **Own ownership only, flat** — 26 options, 0 optgroups for pro-heavy. Built-ins are excluded.
- **Loaded on dialog open**, with visible loading copy.
- An existing reference missing from the options would render as the placeholder while state still
  holds the id (UI-045). Foreign keys make this rare.
- The two New Backtest and Monitor pickers choose the same kinds of entity with different
  grouping, ownership rules, loading behaviour and error UI (UI-009).

### 19.5 Strategy Builder selects (native, 38 px)

These are described in §15. Options are local and static, with no loading or error states. An
unavailable stored value is represented by an injected option.

### 19.6 Indicators popover (Stock Details)

- **Trigger**: "Indicators" + count badge.
- **Panel**: `role="dialog"`, right-aligned, `min(300px, 100vw-32px)` wide, ≤ 420 px tall, scrolls.
  - Hint "Price is always shown. Select any number of overlays."
  - Groups ("Moving averages — daily", "— weekly", oscillators, intrinsic values), each checkbox
    with a colour swatch.
  - Unavailable entries are disabled and suffixed "Unavailable".
- **Data**: no request on open or toggle; all overlay data arrives with the page and history loads.
- **Behaviour**: the panel stays open while toggling. Escape returns focus to the trigger.
- **Phone**: the panel overlays the chart (`pickers/pro-indicators-menu-open-mobile-390.png`,
  `…-scrolled-*`).

### 19.7 Other choosers

| Control | Construction | Notes |
|---|---|---|
| Chart range 1M…MAX | fieldset of radio pills | Default 1Y. MAX extends history lazily. |
| Level percentage | radiogroup pills | – |
| Billing cadence | radiogroup pills | Starts on the subscription's interval, including an *ended* one (UI-037) |
| Dashboard state filter | `aria-pressed` buttons, the active one **solid primary** | A second solid-blue element on the Dashboard beside the Run Backtest card |
| Dashboard action filter | `SelectControl` | – |
| Page size "Rows 25/50/100" | `SelectControl` | Client-side paging; each section pages independently |
| Dates (backtest, membership) | native `type="date"` | No min/max, OS-locale display; only the backtest has a MAX shortcut (UI-023, UI-049) |
| Built-in dashboard visibility | shared `Switch` | The only place `Switch` is used; the monitor "enabled" state is a checkbox in the dialog and a menu item in rows |

---

## 20. Empty-state comparison

| Surface | Headline | Explanation | CTA | Container | Next action obvious? |
|---|---|---|---|---|---|
| Lists (own) | "You haven't created any lists yet" | "Group the stocks you care about into a named list, then restrict per-stock buy windows whenever a universe needs them." | solid "New list" | compact dashed panel **inside** the titled "Your lists" card; built-ins below | Yes, but the header has no button in this state |
| Strategies (own) | "You haven't created any strategies yet" | Explains a strategy with an inline example condition | solid "New strategy" | same | Yes |
| Monitors (own) | "You haven't created any monitors yet" | A long paragraph on scanning cadence | solid "New monitor" | same | Yes, but pressing it leads to the prerequisites dialog for new users |
| Backtests | "No backtests yet" | "A backtest executes one strategy over one stock list…" | solid "Run your first backtest" | **full EmptyState directly on the canvas**, no section title | Yes |
| Dashboard — no monitors shown | "No monitors are shown" | "Turn a monitor back on from the Monitors page…" | secondary "Go to monitors" | compact inside "Current signals" | Partly |
| Dashboard — no matches | "Nothing is matching right now" | "Your monitors are running…" | none | same | n/a |
| Dashboard — filtered | "No signals match these filters" | – | **none (no clear filters)** | same | No |
| List detail | "No stocks yet" | "Search above to add supported stocks to this list." | none (the picker is above) | compact | Yes |
| Monitor detail — stocks | "No stocks to evaluate" | links the list | inline link | compact | Yes |
| Monitor detail — signals | "No signals yet" | "One is recorded the moment…" | none | compact | n/a |
| Backtest holdings / trades | "No positions" / "No trades" | varies by status; **wrong on failed runs** | none | compact | – |
| Stock chart | "Not enough price history to draw a chart." | – | none | chart frame | – |
| Search | "No stocks match "…"." | – | none | panel | – |
| Recent searches | section simply absent | – | – | – | – |
| New Backtest prerequisites | "A backtest needs both a strategy and a stock list." | links "Create a strategy / Create a stock list first." | inline links | warning box | Yes |
| New Monitor prerequisites | "A monitor watches one strategy over one stock list" | "You do not have a strategy or a stock list yet…" | solid "Create a strategy" + secondary "Create a stock list" (→ `/lists`, not a create action) | warning panel in dialog | Misleading (UI-009) |
| Admin | "No built-in content yet" | "Run the built-in bootstrap to create it." | none | compact | Developer-facing copy |

Consistency verdict (UI-012):
- The copy is consistently good: specific, explanatory, second person.
- The anatomy is inconsistent:
  - Three collections nest the empty state in a titled card; Backtests floats it on the canvas.
  - The CTA is primary in every empty state while "New …" is tinted elsewhere.
  - The header "New …" disappears whenever the empty state shows (UI-030).

---

## 21. Loading-state comparison

| Surface | Loading treatment | Header during load | Layout shift on arrival |
|---|---|---|---|
| Collections | `SectionCard` with 4 skeleton rows | ✓ title and lead, **no "New …"** | Button appears; skeleton card → flush table (it dissolves on phone) |
| Dashboard | Strip placeholders ("—") + 6 skeleton rows | ✓ | Freshness badge appears |
| List / strategy / monitor detail | one skeleton card | **✗ no header, no back link, `<h1>` count 0** | Whole header pops in |
| Backtest result | skeleton card | ✗ | Whole hero pops in |
| Stock Details | **page-shaped skeleton** (header, chart, columns), `role=status` | skeleton header | Minimal — the best of the product |
| Chart history extension | spinner overlay "Loading price history" | – | none |
| New Backtest | full form with disabled selects, **no loading text** | ✓ | none |
| Monitor dialog | text "Loading your strategies and lists…" | – | dialog grows |
| Billing | text "Loading your plan…" | ✓ | cards appear |
| Pricing (signed in) | "Checking your plan…", cards without actions | ✓ | buttons appear |
| Search | "Searching…" + dot | – | – |
| List picker | "Searching…" (no dot) | – | – |
| Session gate | text "Checking your session..." (three dots) | ✗ | redirect |
| Account slot | nothing, then the monogram pops in | – | topbar right edge shifts |
| Mutations | button label ("Creating…", "Saving…", "Adding…", "Submitting…", "Working…", "Opening…", "Enabling…") | – | – |
| Backtest run progress | phase + % + bar + message, polled every 1 s / 2.5 s | ✓ hero | – |

Evidence: `*/pro-collection-loading-*`, `dashboard/pro-loading-*`, `lists/pro-heavy-list-detail-loading-desktop-1440.png`,
`monitors/pro-heavy-monitor-detail-loading-desktop-1440.png`, `stocks/pro-details-loading-*`,
`backtests/pro-heavy-new-loading-*`, `monitors/starter-new-monitor-loading-*`, `billing/mock-loading-*`,
`shell/pro-session-checking-*`.

Loading is always distinguishable from empty: no surface shows an empty state while loading. The
conventions, however, are four (skeleton card, page-shaped skeleton, disabled form, text-only), and
detail pages drop their header (UI-027). No optimistic updates exist except monitor enable/disable,
which updates the row locally after the response.

---

## 22. Error-state comparison

| Failure | Surface | Copy | Recovery | Layout | Leaks implementation? |
|---|---|---|---|---|---|
| Collection fetch 500 | Lists/Strategies/Monitors/Backtests | "Your lists could not be loaded / This is usually temporary — try again in a moment." | secondary "Try again" | error EmptyState replaces sections; header stays | No, but "Your…" is shown to Guests |
| Dashboard 500 | Dashboard | "The dashboard could not be loaded" | Try again | red-tinted panel; strip shows "No data" | No |
| Detail 500 | List | "Something went wrong / The list could not be loaded right now." | Try again | h1 EmptyState, no header | No |
| Not found | List / Strategy / Monitor / Backtest | "List not found" / "Strategy not found" / "This monitor no longer exists" / "This backtest was not found" | Back to … | h1 EmptyState | Wording inconsistent; monitor copy wrong for others' objects (UI-057) |
| Stock fetch 500 / unknown | Stock Details | "Something went wrong" / "Stock not found" | bespoke Try again + Back to Dashboard | **bespoke panel, 26/30 px title, "FACTORSAGE" eyebrow** | No (UI-017) |
| History extension | Stock chart | "Older history could not be loaded." | Try again | inline in chart | No |
| Picker fetch | Search | API copy / "Search is unavailable right now." | Try again | in panel | No |
| Picker fetch | List picker | always "Search is unavailable right now." | Try again | in panel | No, but wrong for 429 |
| Options fetch | New Backtest | "The submission form could not be loaded" | Try again | whole page replaced (header too) | No |
| Options fetch | Monitor dialog | "Your strategies and lists could not be loaded…" | Cancel / **primary** Try again | inline alert | No |
| Mutation refused (entitlement) | List add, list create, monitor create, backtest submit | API sentence, verbatim, **no trailing period** ("…this change would make 11") | none (no upgrade link) | inline red alert; **off-screen on phone for backtests** | Tone is fine; missing next step (UI-020) |
| Dependency refusal (409) | Delete strategy | "This strategy is used by a monitor. Delete the monitor first." | – | inside ConfirmDialog | No |
| Backtest failed | Result | "The backtest could not be completed. Please try running it again." + `EXECUTION_FAILED` + Run ID | "Start a new backtest" | red box followed by misleading empty sections | **Yes** (UI-031) |
| Billing status 500 | Billing / Pricing | "Your billing details could not be loaded." / "Your plan could not be loaded, so no plan can be chosen right now." | Try again | inline | No |
| Billing action 503 | Billing | API message | – | red notice | No |
| Auth | Sign in | "Unable to sign in with those credentials." (also for empty fields), rate-limit copy, OAuth copies | – | inline alert | No |
| Session 500 | protected routes | "Unable to verify your session / The API could not be reached…" | "Return to sign in" | **no page gutter on phone** (UI-029) | Inaccurate: it was reached and failed |
| Render failure | `(app)/error.tsx` | "This page could not be shown…" | primary Try again + secondary Go to the Dashboard | in shell | No |
| Unknown URL | `not-found.tsx` | "This page does not exist" | "Go to the Dashboard" | standalone, **no shell** | No |
| Admin 500 | Admin | "Built-in content could not be loaded" | **no retry** | inline | No |

A malformed Dashboard payload (`{unexpected:true}`) did **not** crash the page; it degraded to "No
monitors are shown" (`dashboard/pro-malformed-response-desktop-1440.png`).

---

## 23. Heavy / pathological data tests

| Test | Result | Evidence |
|---|---|---|
| 120-char list name + 500-char description (unbroken 60-char token) | List detail header wraps cleanly and the description wraps. **In other tables the chip's max-content width breaks the layout** (UI-001). | `lists/pro-heavy-long-name-list-detail-*` |
| 120-char strategy name | Result hero wraps to 2 lines on desktop and 4 on phone at display size. The Backtests identity column wraps to 5 lines. | `backtests/pro-heavy-result-completed-*` |
| 120-char monitor name | Monitors table identity column collapses to one word per line. Dashboard phone sideways overflow. | `monitors/pro-heavy-collection-desktop-1440.png`, `dashboard/pro-many-signals-scrolled-sideways-mobile-390.png` |
| 30 lists, 25 strategies, 13 monitors, 60 runs | Client paging at 25 works; no search, sort or filter | `*/pro-heavy-collection-*`, `backtests/pro-collection-60-runs-*` |
| 100-stock list (Pro limit) | All rows on one page; ~2,400 px desktop | `lists/pro-heavy-100-symbol-list-detail-*` |
| 24 dashboard rows | No paging; one scroll of ~2,400 px; repeated securities ungrouped | `dashboard/pro-many-signals-*` |
| 30 monitored stocks + 100 signals | 9,128 px page; the 100 cap has an honest notice | `monitors/pro-heavy-monitor-detail-dense-*` |
| Large / small / negative numbers | "$98,765.43", "$0.87", "+1,287.50%", "−43.21%", "0.00%" (zero neutral) align in numeric columns | `dashboard/pro-many-signals-*`, `backtests/pro-collection-60-runs-*` |
| Missing logo | Always the monogram, never a broken image, no layout shift | all |
| No intrinsic value | "No intrinsic-value estimates are available for this stock yet." | `stocks/pro-details-qatest2-no-data-*` |
| Long company name | Truncated in search and cards, full in the details header | `stocks/*-search-long-company-name-*` |

**Root cause of UI-001 / UI-002 (DOM measurement).**
- On `/backtests` as pro-heavy: `span.EntityReference::chipLabel` renders 170 px wide with
  `scrollWidth` 698 px. The `td` computes to 752 px and the table to 1,735 px, inside a
  `DataTable::scroll` of 1,358 px.
- On `/monitors` the table is 2,110 px.
- On the phone Dashboard, `DashboardPage::entityCell` spans 128–756 px.
- In auto table layout the cell takes its content's max-content width even though the chip clips
  visually. UX-007 fixed this only in the Dashboard's desktop stylesheet.

---

## 24. Desktop / mobile parity analysis

**Parity that holds:**
- The same information architecture and one DOM per record.
- Every column reappears in phone cards as labelled rows.
- Bottom-nav order matches the spec.
- Phone dialogs stack actions full width.
- `WorkflowFooter` becomes a sticky bar with a summary.
- The Strategy Builder moves help inline under the focused row.

**Parity that breaks:**

| # | Break | Detail |
|---|---|---|
| 1 | Overflow menu placement and clipping | Top-right per spec; bottom-left in reality; clipped off the left edge (UI-006) |
| 2 | Error visibility | The desktop error sits next to the button; on phone it is off-screen (UI-005) |
| 3 | Dashboard | The desktop table is safe (UX-007); the phone page scrolls sideways (UI-002) |
| 4 | Hover-only information | "Over plan limit", "Not scanning" and Stock Details legends are hover/tooltip-driven, so phone users get **less** information than desktop users (UI-021, UI-018) |
| 5 | 600–879 px | Tablets receive phone cards stretched to full width, with right-aligned values ~800 px from their labels (UI-003, UI-004) |
| 6 | Backtest KPIs | 2 columns, not the spec's 4, producing a long result card (UI-033) |
| 7 | Guest topbar | Pricing + Sign in squeeze the search placeholder to "Search AAPL, M" |

Nothing is desktop-only or phone-only in capability.

---

## 25. Entitlement UX analysis

**What exists:**
- Plan cards with derived limits (Billing, Pricing).
- Honest server refusals, whose messages include numbers ("allows 10… would make 11").
- Non-destructive downgrade (content kept, read-only where over the limit).
- "Over plan limit" and "Not scanning" badges.
- Guest SignInPrompts that explain *why* an account is needed.

**What is missing (UI-020 … UI-024):**
- **No proactive limits.**
  - No "N of 10 stocks" on a list or in the picker.
  - No "N of 1 active monitors" on Monitors or in the dialog.
  - No plan-aware MAX and no period hint on New Backtest.
  - No "1 run in progress" before submit.
  - No backtest-symbol check when choosing a list. The API has the numbers (`compliance.symbolLimit`
    is already on list responses).
- **No path forward.** No refusal links to `/billing`, and the SignInPrompt pattern has no plan
  equivalent. The "Recommended" badge on Pro is the only upgrade nudge in the product.
- **No sense of plan.** Plan appears only on `/billing`. The account menu shows the role, and
  nothing in the shell shows the tier.
- **Tooltip-only explanations** for the over-limit states, unreachable on touch.
- **Dead-end refusals.**
  - The monitor refusal could offer "create it disabled".
  - The concurrency refusal could link to the running run.
  - The history refusal could offer "set to 5 years".

**Guest:**
- The collections and detail pages of built-ins are readable.
- Every create action opens a SignInPrompt. Backtests, Billing and Admin redirect to sign-in with
  `next`.
- The contract still advertises `backtests.canViewDemo: true` for Guests after the decision to
  require sign-in (`docs/decisions/entitlements-v1.md` at 25b0461f). Nothing reads the flag, but it
  contradicts the decision.

---

## 26. Built-in / custom / admin behaviour

**Model.** Built-ins are `SYSTEM`-owned; admins (`role = ADMIN`) edit them through the ordinary
editors. The "master account" of the brief is therefore the administrator role, not an owner
account. **Implemented.**

**Distinguishing built-in from custom:**
- Separate "Built-in …" sections, plus a "Built-in" outline badge on every row of that section (the
  badge is redundant there).
- A "Built-in" badge in detail headers.
- In New Backtest, "Built-in" optgroups.
- On the Dashboard, only the monitor name tells them apart; there is no badge.

**Customer view of a built-in:**
- Read-only lists and strategies (`StrategyReadOnlyView`) and a read-only monitor with a dashboard
  visibility switch.
- A "Backtest this …" action.
- The back link goes to "Dashboard" (UI-016).

**Admin view:**
- The ordinary editors (`lists/master-builtin-list-editable-*`, `strategies/master-builtin-editable-*`).
- Monitor overflow items "Pause for everyone" / "Unpublish" (`monitors/master-builtin-monitor-admin-menu-*`).
- Row overflow items on built-ins (`*/master-builtin-row-overflow-desktop-1440.png`).
- The back link goes to "Admin".
- Nothing offers to delete a built-in, which is correct.
- **The admin/customer boundary is only implicit.** Nothing on an editable built-in says "Changes
  apply to everyone" except `/admin`'s caption. An admin editing a built-in list sees the same
  "Edit" button a customer sees on their own list (UI-052).

**`/admin`:**
- A bespoke header ("ACCOUNT ACCESS" eyebrow, 32 px "Admin"), an identity `<dl>` and a "Built-in
  content" table.
- Rows show kind, name, `systemKey`, publication and running state, details, and last edited by
  email.
- Actions are a visible "Edit" link per row, not an overflow menu. The error state has no retry
  (`admin/master-admin-*`).
- For non-admins: "Access denied / This account does not have admin access." with no gutter on phone
  (`admin/pro-admin-access-denied-*`).

---

## 27. Interaction consistency (and positive findings)

### 27.1 Equivalent actions compared

| Action | Lists | Strategies | Monitors | Backtests | Divergence |
|---|---|---|---|---|---|
| **New** | modal; header tinted *or* empty-state primary | route; same placement rule | modal; same rule | route; header tinted only when runs exist, else empty-state primary "Run your first backtest" | Mechanism differs (modal/route) — justified. Placement and style shift with state (UI-030). |
| **Edit** | detail header tinted "Edit" → dialog titled "Edit list" (the row menu calls it "Rename") | row menu "Rename" → "Edit strategy" dialog; the full editor is also titled "Edit strategy" | row menu "Edit"; detail tinted "Edit monitor" → dialog "Edit monitor" | n/a | Three vocabularies for one idea (UI-015) |
| **Delete** | row "…" → Delete; detail "…" → "Delete list"; ConfirmDialog | row "…" only; **not in the editor** | row "…" → Delete; detail "…" → "Delete monitor" | n/a | Builder has no delete. Strategy Builder levels use visible red "Remove" without confirm (UI-014). |
| **Save** | dialog primary "Create list" / "Save changes" | save bar "Save strategy" + status + Discard | dialog "Create monitor" / "Save changes" | footer "Run backtest" | The Builder is a documented exception — defensible |
| **Cancel** | dialog secondary | none on new; "Discard changes" only when dirty | dialog secondary | footer secondary link | – |
| **Run backtest from entity** | ✗ | ✗ (own) / ✓ built-in "Backtest this strategy" | ✗ (own) / ✓ built-in "Backtest this monitor" | – | UI-008 |
| **Row click** | opens detail | opens detail | opens detail | opens result | ✓ consistent; not on detail sub-tables |
| **Contextual row action** | "Open" | "Open" | "Open" | "View results" (terminal only; empty cell otherwise) | ✓ |
| **Overflow** | "…" `More actions for {name}` | same | same (Disable/Edit/Delete) | none | ✓ desktop; ✗ phone placement (UI-006) |
| **Enable / disable** | – | – | row menu item; detail menu item; dialog checkbox; built-ins via `Switch` | – | Three controls for one state |
| **Modal close** | "×", Escape, Cancel | same | same | – | ✓ |
| **Unsaved-changes guard** | none needed | native `window.confirm`; account-menu links bypass it | none | none | UI-053 |
| **Back navigation** | "← Lists" or "← Dashboard" (built-in) | "← Strategies" or "← Dashboard" | "← Monitors" / "← Dashboard" / "← Admin" | "← Backtests" | Context-dependent parent (UI-016) |
| **Retry** | secondary | secondary | secondary / **primary** in dialog | secondary | `error.tsx` and the monitor dialog use primary (UI-056) |
| **Button order** | Cancel → primary | – | Cancel → primary | Cancel → primary | SignInPrompt and error pages put primary first (UI-056) |

### 27.2 Positive findings — keep and converge toward

1. **Backtest result** (`BacktestRunView`) is the reference outcome page:
   - hero identity and status;
   - a period-bounded absolute-value chart with Strategy, Benchmark and Cash;
   - KPIs, then a collapsed immutable configuration, then holdings and trades.
   - It renders running, queued and completed runs from one layout with honest polling.
2. **`DataTable` single-DOM table/card** — the phone cards are genuinely usable, labelled and
   screen-reader-safe. Keep it as the only collection primitive.
3. **New Backtest + `WorkflowFooter`** — the canonical form:
   - reading width, grouped fieldsets, inline hints;
   - a live explanation of maximum positions;
   - a summary in the footer and a sticky phone bar.
4. **SignInPrompt / `AccountActionLink`** — Guests are never dead-ended or redirected for browsing;
   each prompt says *why*.
5. **Billing `PlanCatalog`** — limits and prices derived from the canonical catalog; one component
   for `/billing` and `/pricing`; cadence re-prices the same three cards; aligned CTA baselines.
6. **`StockIdentity`** — the monogram fallback never shifts layout and is never announced twice.
7. **Strategy Builder explanation panel** — the best domain teaching in the product (formula, worked
   examples, "Not evaluable when…").
8. **Stock Details** — the page-shaped loading skeleton, viewport-driven history and end-of-day
   honesty labels.
9. **Copy quality** — empty states, the rebind note, the membership explainer and billing notices
   are precise and humane.
10. **Shell** — correct nav order per viewport, safe-area handling, and a bottom-nav reserve that
    never obscured content.
11. **Membership editor** — "Saves as …" preview; refuses to silently destroy multi-period data.

---

## 28. Accessibility / basic browser issues

Automated checks over 642 captures:

| Check | Result |
|---|---|
| Horizontal document overflow | **3 captures, all the phone Dashboard with long names (366 px)**. Nothing else overflowed at any width. |
| Elements outside the viewport | Dashboard entity cells (same cause); row overflow menus on phone (−21 px left edge); the expanded 375 px search pushing the account trigger off-screen while open |
| Duplicate IDs | none |
| Controls without an accessible name | none |
| Ambiguous accessible names | **"Open" ×158, "Edit" ×48, "Delete" ×5.** Row "Open" links have no entity context in their accessible name (UI-050). The overflow trigger does ("More actions for {name}"). |
| `<h1>` count | exactly one everywhere except 6 loading states with **none** (detail skeletons, session check) |
| Uncaught page errors | none (the one crash seen was caused by an invalid audit mock and was re-captured) |
| Console errors | 401 `/auth/me` on **every Guest page load** (57); React hydration-attribute mismatch warnings (15, e.g. `backtests/pro-collection-error-*`, `strategies/master-collection-mobile-390.png`); otherwise only intentionally mocked or real refusals (UI-054) |
| Unexpected failed requests | Only real API validations: `400 /auth/login` for an empty submit; `400 /auth/register` for a malformed email |

**Manual observations:**
- Status is never colour-only: every tone has a text label.
- The focus ring is visible.
- Row menus are disclosures with `aria-expanded`. The **account menu** uses `role="menu"` without
  arrow-key support (UI-053).
- **Tooltip-only explanations** ("Over plan limit", "Not scanning", membership "+N more", truncated
  chips) are unavailable to touch and keyboard users (UI-021).
- Chart legends appear only on hover or touch.
- Native selects are keyboard-accessible by default. The Builder's three unlabelled selects rely on
  `aria-label` ("Metric", "Condition", "Value"), which is fine.

---

## 29. Complete issue register

Severity: **P0** broken / unusable · **P1** serious UX or structural inconsistency · **P2** product
polish / visual inconsistency · **P3** minor polish. Totals: **0 P0 · 13 P1 · 31 P2 · 14 P3**.

| ID | Sev | Title |
|---|---|---|
| UI-001 | P1 | Long entity names push table actions off-screen in the Backtests and Monitors collections |
| UI-002 | P1 | Phone Dashboard scrolls sideways with a long entity name |
| UI-003 | P2 | Dashboard relationship chips unreadable at 880–1,279 px; stretched phone cards at 600–879 px |
| UI-004 | P2 | Shipped breakpoints (880 px) diverge from the documented 768 / 1,024 px contract |
| UI-005 | P1 | Phone form errors render out of view; focus never moves to the error |
| UI-006 | P1 | Phone row overflow menu placed bottom-left and clipped off-screen |
| UI-007 | P2 | Collections carry second headings, twin tables with misaligned columns and redundant badges |
| UI-008 | P1 | "Run / Backtest this" exists for built-ins and Guests but not for your own entities |
| UI-009 | P2 | Monitor and Backtest pickers treat the same entities differently |
| UI-010 | P2 | No search, sort or filter on any collection |
| UI-011 | P3 | Phone card "Why" prose is right-aligned |
| UI-012 | P2 | Empty-state anatomy differs across collections |
| UI-013 | P1 | Strategy Builder defaults create real, duplicated logic; blank form opens with errors |
| UI-014 | P2 | Builder uses visible red "Remove" with no confirm/undo; FINAL EXIT heading duplicated |
| UI-015 | P2 | Strategy editor identity and actions: generic title, no delete/backtest, "Rename" vs "Edit" |
| UI-016 | P2 | Read-only built-ins: back link to Dashboard; card-in-card with a duplicate heading |
| UI-017 | P2 | Stock Details is built from bespoke primitives |
| UI-018 | P2 | Stock Details: no actions, hover-only legend, conflicting sign conventions, unbalanced layout |
| UI-019 | P1 | Member table shows the oldest membership period, hiding the current one |
| UI-020 | P1 | Plan limits are never shown before they are hit, and refusals have no path forward |
| UI-021 | P1 | Over-limit (downgraded) state is contradictory and explained only in tooltips |
| UI-022 | P2 | Monitor-capacity refusal hides the obvious alternative (create disabled) |
| UI-023 | P2 | MAX period ignores the plan's history limit |
| UI-024 | P2 | The current plan is invisible outside /billing; the account menu shows the role |
| UI-025 | P1 | Dashboard rows never say when a signal started; no sort/grouping; "Real-time" label |
| UI-026 | P2 | Monitor detail: ended signals lack a reason; no filter; mixed date formats |
| UI-027 | P2 | Detail loading states drop the page header |
| UI-028 | P2 | Error presentation uses three different components |
| UI-029 | P2 | Session-gate pages lack gutters and misdescribe failures |
| UI-030 | P2 | "New …" changes location and style between states and vanishes while loading |
| UI-031 | P1 | Failed backtest page leaks codes, suggests a futile retry and shows misleading empty sections |
| UI-032 | P2 | Result hero has no follow-up actions; Strategy and Cash lines are hard to distinguish |
| UI-033 | P3 | Phone result: 2-column KPIs and a 4-line display title |
| UI-034 | P3 | Backtests collection chips are static; "View results" only for terminal runs |
| UI-035 | P2 | Two independent stock comboboxes with divergent behaviour and ARIA semantics |
| UI-036 | P2 | Rate-limit copy is lost in the list picker and contradicted in the topbar |
| UI-037 | P1 | A lapsed subscriber cannot re-buy the plan they left (card shows "Waiting for payment confirmation") |
| UI-038 | P2 | Cancellation-pending state asks the user to resume but offers no Resume action |
| UI-039 | P2 | Plan cards omit or blur real limits |
| UI-040 | P2 | Signed-in users see the sign-in form at /login |
| UI-041 | P3 | Empty sign-in submit is sent and answered "Unable to sign in with those credentials." |
| UI-042 | P2 | Return path is dropped by several sign-in entry points |
| UI-043 | P2 | Invalid reset link keeps a dead form; invalid verification link does not |
| UI-044 | P3 | Auth pages use their own type, button and breakpoint scale |
| UI-045 | P2 | Four select stylings; a stale reference silently shows the placeholder |
| UI-046 | P1 | Checkout return claims a confirmed subscription after the settle window expires |
| UI-047 | P3 | "Billing & Plan" vs "Plan and billing" |
| UI-048 | P2 | Collections and details never refresh; relative ages don't tick |
| UI-049 | P2 | Date formats vary by surface and by OS locale |
| UI-050 | P2 | Row actions have ambiguous accessible names ("Open", "Edit") |
| UI-051 | P3 | `/stocks` is a stale placeholder |
| UI-052 | P3 | `/admin` is bespoke; admin edits to built-ins carry no "affects everyone" signal |
| UI-053 | P3 | Shell nits: no active nav item on Dashboard/Stocks/Billing; account-menu semantics; native confirm |
| UI-054 | P3 | Console noise: Guest 401 on every load; hydration mismatches |
| UI-055 | P3 | Tab titles missing or inconsistent |
| UI-056 | P3 | Button order and retry-button weight vary |
| UI-057 | P3 | Not-found wording differs per entity and is wrong for other accounts' monitors |
| UI-058 | P3 | Terminology and microcopy drift |

---

### UI-001 — Long entity names push table actions off-screen in the Backtests and Monitors collections

- **Severity:** P1
- **Pages:** `/backtests`, `/monitors` (any `DataTable` column holding an `EntityReferenceChip`)
- **Viewports:** Desktop 1,440 / 1,280 / 1,024
- **Personas:** Any account with a long list, strategy or monitor name (pro-heavy)

**Observed:**
- With one 120-character list name, the Backtests table computes 1,735 px inside a 1,358 px
  surface. The Stock list column is 752 px, and Excess return, Queued and **View results** are
  outside the visible area.
- In Monitors the table reaches 2,110 px. The Monitor column shrinks to ~97 px and breaks words
  mid-token ("Univers / e 04 / trend"). Active signals, Last checked and the Open/… actions are off
  screen.
- The chip *looks* truncated ("Global dividend aristocrats …") but keeps a `scrollWidth` of 698 px.

**Expected consistency:**
- `ui-system.md`: "A relationship chip caps its own width and truncates, so one long name cannot
  widen a column."
- The Dashboard's UX-007 fix (`minmax(0, max-content)` track plus an identity floor) solved exactly
  this, but only on the Dashboard at ≥ 880 px.

**Why it matters:** the contextual action of every row disappears as soon as the user names things
realistically (names up to 120 characters are allowed). The identity column, the most important
one, becomes the least readable.

**Evidence:**
- `backtests/pro-heavy-collection-desktop-1440.png`
- `backtests/pro-heavy-collection-table-scrolled-right-desktop-1440.png`
- `monitors/pro-heavy-collection-desktop-1440.png`
- `monitors/pro-heavy-collection-table-scrolled-right-desktop-1440.png`

**Suggested direction:** make the chip's cap intrinsic to `EntityReferenceChip` (its min-content
and max-content both bounded), not a per-feature stylesheet rule. Give every identity column the
UX-007 floor through `DataTable` column metadata.

### UI-002 — Phone Dashboard scrolls sideways with a long entity name

- **Severity:** P1
- **Pages:** `/dashboard`
- **Viewports:** Phone 390 (and any width < 880)
- **Personas:** Any account whose monitor, strategy or list name exceeds the card width

**Observed:** the card's `entityCell` wrapper spans 128–756 px, making the document 756 px wide at a
390 px viewport. The whole page pans horizontally, bottom nav included in the scroll area.

**Expected consistency:** `frontend.md`: "the page body never scrolls sideways"; no other page
overflows at any width in 642 captures.

**Why it matters:** the Dashboard is the landing page; sideways panning on a phone reads as broken.

**Evidence:**
- `dashboard/pro-many-signals-buy-sell-exit-mobile-390.png` (automated overflow 366 px)
- `dashboard/pro-many-signals-scrolled-sideways-mobile-390.png`

**Suggested direction:** same root fix as UI-001. The phone card's `links` region must constrain
chip width.

### UI-003 — Dashboard relationship chips unreadable at 880–1,279 px; stretched phone cards at 600–879 px

- **Severity:** P2
- **Pages:** `/dashboard` (and every `DataTable` at 600–879)
- **Viewports:** 1,024, 880, 879
- **Personas:** All

**Observed:**
- At 1,024 the Strategy / List / Monitor chips read "QA Bu…", "Q…".
- At 880 the List chip is a lone "(" and the Monitor column is clipped.
- At 879 the phone-card layout stretches to ~850 px, with values right-aligned far from their
  labels.

**Expected consistency:** the relationship block is a documented first-class part of every
Dashboard row (the "Which strategy / list / monitor produced it?" question).

**Why it matters:** laptops and tablets lose the "which monitor produced this" answer.

**Evidence:**
- `dashboard/pro-collection-tablet-1024.png`
- `dashboard/pro-collection-boundary-880.png`
- `dashboard/pro-collection-boundary-879.png`

**Suggested direction:** at intermediate widths, fold the three relationship chips into one
"Strategy → List · Monitor" line under the stock (the `links` card role already exists). Cap phone
cards at a readable width, or use two columns above 600 px.

### UI-004 — Shipped breakpoints (880 px) diverge from the documented 768 / 1,024 px contract

- **Severity:** P2
- **Pages:** All
- **Viewports:** 600–1,023
- **Personas:** All

**Observed:**
- Every layout switch happens at 880 px: nav, bottom nav, table↔card, `WorkflowFooter`, the token
  step. No CSS uses 768 or 1,024.
- Local breakpoints add 380, 560, 620, 820, 960, 959 and 1,100.
- Docs (`frontend.md`, `ui-system.md`, `v1-visual-parity.md`) and the `DataTable` comment disagree.

**Expected consistency:** one documented breakpoint set.

**Why it matters:** reviewers verify against the wrong widths. The 600–879 band (large phones in
landscape, small tablets) is served stretched phone layouts.

**Evidence:** §8.2 measurements; `lists/pro-heavy-collection-boundary-879.png` vs
`…-boundary-880.png`.

**Suggested direction:** decide the canonical set, likely confirming 880 and documenting it.
Define what the 600–879 band should do (two-column cards or a compact table), and fold the local
breakpoints into tokens or justify them.

### UI-005 — Phone form errors render out of view; focus never moves to the error

- **Severity:** P1
- **Pages:** `/backtests/new` (also field validation on the same page)
- **Viewports:** Phone
- **Personas:** Free / Starter at a limit; any user with an invalid field

**Observed:**
- After tapping "Run backtest" in the sticky bar, the refusal ("Your plan runs one backtest at a
  time…") renders at y ≈ 1,216 px in an 844 px viewport.
- Nothing scrolls, focus stays on the button, and the user sees no reaction.
- On desktop, validation errors also leave focus on "Run backtest".

**Expected consistency:** `v1-visual-parity.md`: "Validation errors focus or scroll to the first
invalid field; moving actions into a fixed bar must not hide the error state."

**Why it matters:** the tap appears to do nothing, and the only explanation of a plan limit is
invisible.

**Evidence:**
- `backtests/free-limit-new-refused-viewport-after-tap-mobile-390.png`
- `backtests/free-limit-new-concurrency-refused-mobile-390.png`
- `backtests/pro-heavy-new-validation-*`

**Suggested direction:** `WorkflowFooter` owns error surfacing. Show a submit error in the bar's
summary slot and scroll/focus the first invalid field.

### UI-006 — Phone row overflow menu placed bottom-left and clipped off-screen

- **Severity:** P1
- **Pages:** `/lists`, `/strategies`, `/monitors` (phone cards)
- **Viewports:** Phone < 880
- **Personas:** Any signed-in owner

**Observed:**
- The "…" trigger sits beside "Open" at the card's bottom-left.
- The menu is right-aligned to the trigger, so it opens to x = −21 px, and "Delete" renders as
  "elete".
- Near the bottom of the screen the menu also sits under the bottom nav.

**Expected consistency:** spec: phone cards put the overflow "at the top-right"; the desktop menu
aligns correctly.

**Why it matters:** destructive and maintenance actions are partially clipped on the primary phone
screens.

**Evidence:**
- `lists/starter-row-overflow-open-mobile-390.png`
- `monitors/starter-row-overflow-open-mobile-390.png`

**Suggested direction:** place the trigger top-right per spec (the `status` region), and make
`OverflowMenu` collision-aware (flip alignment at viewport edges).

### UI-007 — Collections carry second headings, twin tables with misaligned columns and redundant badges

- **Severity:** P2
- **Pages:** `/lists`, `/strategies`, `/monitors`
- **Viewports:** All
- **Personas:** Signed-in

**Observed:**
- Each page renders "Your …" and "Built-in …" titled cards, each with its own table whose column
  widths differ (Stocks column ~60 px apart).
- Every built-in row repeats a "Built-in" badge inside the "Built-in lists" section.

**Expected consistency:** `v1-visual-parity.md`: no second card titled "Your lists…". The
`frontend.md` ownership section deliberately requires two sections, so the documents conflict.

**Why it matters:** the eye has to re-find columns, and the page reads as two pages stacked.

**Evidence:**
- `lists/pro-heavy-collection-desktop-1440.png`
- `lists/free-empty-collection-desktop-1440.png`

**Suggested direction:** resolve the doc conflict. If two sections stay, share column templates
between them and drop the per-row badge inside the built-in section.

### UI-008 — "Run / Backtest this" exists for built-ins and Guests but not for your own entities

- **Severity:** P1
- **Pages:** `/lists`, `/lists/[id]`, `/strategies`, `/strategies/[id]` (editor), `/monitors/[id]`
  (owner), `/stocks/[symbol]`
- **Viewports:** All
- **Personas:** All signed-in

**Observed:**
- "Backtest this strategy" and "Backtest this monitor" appear only on read-only built-in views.
- An owner looking at their own monitor, strategy or list has no way to start a prefilled backtest.
  The parity spec requires "Run Backtest" on list/strategy rows and headers.

**Expected consistency:** the same entity offers the same next step regardless of who owns it.

**Why it matters:** the product's core loop (List + Strategy → Backtest → Monitor) is broken exactly
where users spend most time, their own content. The prefill mechanism already exists.

**Evidence:**
- `strategies/guest-builtin-readonly-desktop-1440.png` vs `strategies/starter-edit-ladder-desktop-1440.png`
- `monitors/guest-builtin-monitor-detail-*` vs `monitors/pro-heavy-own-monitor-detail-*`
- `lists/starter-own-list-detail-*`

**Suggested direction:** one `AccountActionLink`-based "Run backtest" in every entity header
(secondary position) and as the visible row action where `Open` is redundant with row click.

### UI-009 — Monitor and Backtest pickers treat the same entities differently

- **Severity:** P2
- **Pages:** `/backtests/new`, New/Edit Monitor dialog
- **Viewports:** All
- **Personas:** All signed-in; free-empty most visibly

**Observed:**

| | Backtest picker | Monitor picker |
|---|---|---|
| Built-ins | included, in a "Built-in" optgroup | excluded |
| Grouping | optgroups | flat list |
| Load | with the page, silent | on dialog open, with copy |
| Error | page-level | inline |

- A new user who can browse built-ins is told "You do not have a strategy or a stock list yet".
- "Create a stock list" links to `/lists`, not to a create action.

**Expected consistency:** one entity picker with one rule for ownership display. Where monitors
cannot use built-ins, say so ("Monitors watch your own strategies and lists").

**Why it matters:** users form a model of "my content vs FactorSage's" from pickers, and here the
two pickers disagree.

**Evidence:**
- `monitors/free-empty-new-monitor-prerequisites-*`
- `monitors/pro-heavy-edit-dialog-*`
- `backtests/pro-heavy-new-initial-desktop-1440.png`

**Suggested direction:** a shared `EntitySelect` (grouping, loading, error, stale-reference rules).
The monitor rule is explained in the prerequisite copy.

### UI-010 — No search, sort or filter on any collection

- **Severity:** P2
- **Pages:** Lists, Strategies, Monitors, Backtests, list members, monitor stocks and signals,
  Dashboard
- **Viewports:** All
- **Personas:** pro-heavy

**Observed:**
- Collections page 25 rows in creation order.
- pro-heavy's two most important lists sit on page 2.
- A 100-stock list and a 100-signal history are single unsorted scrolls.

**Expected consistency:** the Dashboard's filter pills show the product knows how to filter.

**Why it matters:** density grows with plan (Pro allows 10 monitors, 100-stock lists, unlimited
lists and strategies).

**Evidence:**
- `lists/pro-heavy-collection-desktop-1440.png`
- `lists/pro-heavy-100-symbol-list-detail-*`
- `monitors/pro-heavy-monitor-detail-dense-*`

**Suggested direction:**
- Client-side name search and a sort control in `CollectionFooter` or a `SectionCard` toolbar
  (all rows are already in memory).
- Status filters on monitor detail.

### UI-011 — Phone card "Why" prose is right-aligned

- **Severity:** P3
- **Pages:** `/dashboard`
- **Viewports:** Phone
- **Personas:** All

**Observed:** the multi-line reason in `fact` rows is right-aligned against the "WHY" label.

**Why it matters:** ragged-left prose is hard to read.

**Evidence:** `dashboard/pro-collection-mobile-390.png`

**Suggested direction:** long-text facts take a full-width stacked layout (label above).

### UI-012 — Empty-state anatomy differs across collections

- **Severity:** P2
- **Pages:** Collections, Dashboard
- **Viewports:** All
- **Personas:** free-empty

**Observed:**
- Lists, Strategies and Monitors nest a compact dashed empty state inside a titled "Your …" card.
- Backtests shows a full empty state directly on the canvas.
- The Dashboard's filtered-empty state has no "Clear filters".

**Why it matters:** first-run users meet four different first impressions.

**Evidence:** `*/free-empty-collection-desktop-1440.png`, `dashboard/pro-filter-sell-waiting-empty-*`

**Suggested direction:** one empty-collection composition (§30); filtered-empty always offers a
reset.

### UI-013 — Strategy Builder defaults create real, duplicated logic; blank form opens with errors

- **Severity:** P1
- **Pages:** `/strategies/new`, `/strategies/[id]`
- **Viewports:** All
- **Personas:** All creators

**Observed:**
- A new level, condition and exit rule each start as the complete rule "Price is above SMA 20D".
- A second condition or a second OR rule is immediately a duplicate that the validator flags.
- A pristine blank strategy shows red "2 issues to fix" before any interaction.

**Expected consistency:** new rows begin empty (like every other form field) and errors appear after
interaction (the Builder's own "touched" rule).

**Why it matters:** users can save logic they never chose, and a first-time user is greeted with
errors.

**Evidence:**
- `strategies/starter-new-blank-desktop-1440.png`
- `strategies/starter-new-final-exit-three-rules-*`
- `strategies/starter-new-final-exit-middle-removed-*`

**Suggested direction:** new predicate rows start with an unset metric ("Choose a metric"). The issue
count stays neutral until first save or interaction.

### UI-014 — Builder uses visible red "Remove" with no confirm/undo; FINAL EXIT heading duplicated

- **Severity:** P2
- **Pages:** Strategy Builder
- **Viewports:** All
- **Personas:** Creators

**Observed:**
- Every level shows red "Remove", which deletes the level and its conditions instantly.
- The FINAL EXIT card title repeats its section title.

**Expected consistency:** `ui-system.md`: "A destructive action is never a visible peer… `actions`
has no danger variant". Everywhere else deletion is confirmed.

**Why it matters:** the product's most complex form has its least guarded destructive action.

**Evidence:** `strategies/starter-edit-ladder-*`, `strategies/starter-new-final-exit-three-rules-*`

**Suggested direction:** quiet "Remove" (neutral ink), with undo via a transient notice or a confirm
when the level has conditions. Drop the duplicate card title.

### UI-015 — Strategy editor identity and actions: generic title, no delete/backtest, "Rename" vs "Edit"

- **Severity:** P2
- **Pages:** `/strategies/[id]`, the strategy rename dialog
- **Viewports:** All
- **Personas:** Owners

**Observed:**
- The editor's title is "Edit strategy" rather than the strategy's name.
- It has no overflow menu (no delete) and no backtest action.
- The rename dialog is also titled "Edit strategy".

**Expected consistency:** entity headers carry the entity's identity and canonical actions
(Lists/Monitors detail).

**Why it matters:** two different screens share one title, and users cannot delete from the thing
they are looking at.

**Evidence:** `strategies/starter-edit-ladder-desktop-1440.png`, `strategies/starter-rename-dialog-mobile-390.png`

**Suggested direction:** title = strategy name (with "Editing" as a status). Header overflow with
Rename/Delete; rename dialogs titled "Rename …".

### UI-016 — Read-only built-ins: back link to Dashboard; card-in-card with a duplicate heading

- **Severity:** P2
- **Pages:** Built-in list, strategy and monitor detail
- **Viewports:** All
- **Personas:** Guest, customers

**Observed:**
- The back link reads "← Dashboard" even when the user came from `/strategies`.
- The strategy's "Logic" card contains a second bordered card titled "Strategy logic".

**Expected consistency:** back link = owning collection. One surface per section.

**Evidence:** `strategies/guest-builtin-readonly-*`, `lists/guest-builtin-list-detail-*`

**Suggested direction:** the back link always targets the collection. `LogicPreview` renders
unframed inside `SectionCard`.

### UI-017 — Stock Details is built from bespoke primitives

- **Severity:** P2
- **Pages:** `/stocks/[symbol]`
- **Viewports:** All
- **Personas:** All

**Observed:**
- `StockStatusPanel` (26/30 px title, "FACTORSAGE" eyebrow) replaces `EmptyState`.
- A bespoke skeleton, bespoke cards instead of `SectionCard`, a bespoke `<dl>` instead of
  `FactGrid`, bespoke badges instead of `StatusBadge`, its own retry button and its own page gap.

**Why it matters:** the same situations (error, not found) look different here than anywhere else.

**Evidence:** `stocks/pro-details-error-desktop-1440.png` vs `dashboard/pro-error-desktop-1440.png`;
`stocks/pro-details-unknown-symbol-*`

**Suggested direction:** migrate to shared primitives. Keep the page-shaped skeleton pattern and
promote it (§30).

### UI-018 — Stock Details: no actions, hover-only legend, conflicting sign conventions, unbalanced layout

- **Severity:** P2
- **Pages:** `/stocks/[symbol]`
- **Viewports:** All
- **Personas:** All

**Observed:**
- There are no actions (add to list, backtest, monitor).
- The overlay legend exists only under the crosshair.
- Intrinsic value "+X% vs price" and technicals "price +X%" use opposite reference points in the same
  colours.
- The right column ends early, leaving an empty area.
- There is no phone summary grid (spec) and no market cap.

**Why it matters:** research doesn't lead anywhere, and a reader can misread under- vs over-valued.

**Evidence:** `stocks/pro-details-qatest1-desktop-1440.png`, `stocks/pro-details-qatest1-mobile-390.png`

**Suggested direction:**
- Header actions ("Add to list", "Backtest").
- A persistent compact legend.
- One sign convention with an explicit label ("Price vs value: −5.9%").
- A masonry or ordered single stack for the lower sections.

### UI-019 — Member table shows the oldest membership period, hiding the current one

- **Severity:** P1
- **Pages:** `/lists/[id]`
- **Viewports:** All
- **Personas:** Anyone with multi-period members (point-in-time membership)

**Observed:** the Membership cell shows "Jan 2, 2015 → Jun 29, 2018 +2 more". The period in force
today ("Sep 19, 2025 → Present") is only in a tooltip. The editor can't edit individual periods and
offers only "Replace with one period".

**Expected consistency:** invariant 3 makes multi-period membership first-class.

**Why it matters:** at a glance the stock looks ineligible today when it is eligible.

**Evidence:**
- `lists/pro-heavy-long-name-list-detail-desktop-1440.png`
- `lists/pro-heavy-membership-multi-period-readonly-*`

**Suggested direction:** show the current or next period first ("Member now · since Sep 19, 2025 ·
3 periods"), and list all periods in a disclosure the user can reach by touch.

### UI-020 — Plan limits are never shown before they are hit, and refusals have no path forward

- **Severity:** P1
- **Pages:** List detail and create, New Backtest, New Monitor, Monitors, Backtests
- **Viewports:** All
- **Personas:** free-limit, starter-limit, free-normal

**Observed:**
- No counters ("10 of 10 stocks"), no disabled-at-limit states, no plan-aware defaults.
- Refusals arrive only after submit, as the API's sentence with no link to plans.

**Expected consistency:** the Billing cards already derive the numbers from `PLAN_ENTITLEMENTS`, and
list responses already carry `compliance.symbolLimit`.

**Why it matters:** "limit appears only after the work is done" — the brief's own P1 example.

**Evidence:**
- `lists/free-limit-at-10-before-add-*`, `lists/free-limit-add-refused-*`
- `lists/free-limit-new-list-11-chips-desktop-1440.png`
- `monitors/free-limit-new-monitor-refused-*`
- `backtests/free-normal-new-history-limit-refused-*`

**Suggested direction:**
- One `LimitMeter`/hint pattern (count vs limit) wherever a limited quantity is edited.
- Entitlement refusals rendered by one component with a "See plans" link (§30).

### UI-021 — Over-limit (downgraded) state is contradictory and explained only in tooltips

- **Severity:** P1
- **Pages:** `/monitors`, `/monitors/[id]`, `/lists`, `/lists/[id]`
- **Viewports:** All; phone worst
- **Personas:** downgraded

**Observed:**
- Monitor rows show "Enabled" and "Not scanning" together, and lists show "Over plan limit".
- The explanations are `title` tooltips (the detail page adds one inline line).
- No page says the account is over its plan or what to do.

**Why it matters:** a downgraded customer cannot tell why monitors stopped, and on touch cannot read
the reason at all.

**Evidence:**
- `monitors/downgraded-collection-*`
- `lists/downgraded-collection-*`
- `lists/downgraded-over-limit-list-detail-*`
- `monitors/downgraded-blocked-*`

**Suggested direction:**
- An account-level compliance notice ("3 monitors are paused because Free allows 1 — Choose which to
  keep / See plans").
- One status per row ("Paused — plan limit").
- Inline, not tooltip, explanations.

### UI-022 — Monitor-capacity refusal hides the obvious alternative (create disabled)

- **Severity:** P2
- **Pages:** New Monitor dialog
- **Viewports:** All
- **Personas:** free-limit

**Observed:** "Start monitoring now" is pre-ticked. At capacity the create fails with "Your plan
allows 1 active monitor; you already have 1", with no hint that unticking would save it.

**Evidence:** `monitors/free-limit-new-monitor-refused-*`

**Suggested direction:** at capacity, default the checkbox off with an inline note, or offer "Save
without monitoring" in the refusal.

### UI-023 — MAX period ignores the plan's history limit

- **Severity:** P2
- **Pages:** `/backtests/new`
- **Viewports:** All
- **Personas:** Free, Starter

**Observed:** MAX always sets 30 years, a guaranteed refusal on Free (5 years) and Starter
(15 years).

**Evidence:** `backtests/free-normal-new-history-limit-refused-*`

**Suggested direction:** MAX = the plan's maximum, labelled ("MAX · 5 years on Free").

### UI-024 — The current plan is invisible outside /billing; the account menu shows the role

- **Severity:** P2
- **Pages:** Shell, account menu
- **Viewports:** All
- **Personas:** All signed-in

**Observed:** the account menu shows "USER"/"ADMIN" (an internal role) and never "Free/Starter/Pro".
No tier indicator exists in the shell.

**Evidence:** `auth/*-account-menu-open-desktop-1440.png`

**Suggested direction:** show the plan badge in the account menu (the role only for admins).

### UI-025 — Dashboard rows never say when a signal started; no sort/grouping; "Real-time" label

- **Severity:** P1
- **Pages:** `/dashboard`
- **Viewports:** All
- **Personas:** All

**Observed:**
- `since`, `observationDate` and per-monitor `freshness` are in every payload but not rendered.
- Rows are unsorted and ungrouped (the same stock six times).
- Freshness is one page badge, computed at render and never ticking.
- The card label is "Real-time Matches" on end-of-day data.

**Expected consistency:** `builtin-dashboard-signals-v1.md` honesty rules, and the market strip's
own careful "session date, not 24h" labelling.

**Why it matters:** "Is this new? Is it still valid?" is the first question a trader asks.

**Evidence:**
- `dashboard/pro-many-signals-buy-sell-exit-desktop-1440.png`
- `dashboard/pro-stale-desktop-1440.png`

**Suggested direction:**
- A "Since" column ("Active 3 d", or the date).
- Default sort: state, then level, then newest.
- Optional grouping by stock.
- Rename the card "Current matches".

### UI-026 — Monitor detail: ended signals lack a reason; no filter; mixed date formats

- **Severity:** P2
- **Pages:** `/monitors/[id]`
- **Viewports:** All
- **Personas:** Owners, Guests on built-ins

**Observed:**
- "Ended {datetime}" without `resolutionReason`.
- "Not evaluable" without a reason.
- No status filter, and Matched rows are not prioritised.
- Detected mixes "2026-09-18 · from history" with "Sep 18, 2026, 11:00 AM".

**Evidence:** `monitors/pro-heavy-monitor-detail-dense-desktop-1440.png`

**Suggested direction:**
- Render reason labels ("Ended · left the list", "Ended · buy window closed").
- Add status filter pills (the Dashboard pattern) and use one date formatter.

### UI-027 — Detail loading states drop the page header

- **Severity:** P2
- **Pages:** List, strategy, monitor and backtest detail
- **Viewports:** All
- **Personas:** All

**Observed:** a skeleton card only (`<h1>` count 0). The header, back link and actions pop in with a
layout shift. Collections keep their header, and Stock Details renders a page-shaped skeleton.

**Evidence:**
- `lists/pro-heavy-list-detail-loading-desktop-1440.png`
- `monitors/pro-heavy-monitor-detail-loading-desktop-1440.png`
- `stocks/pro-details-loading-*`

**Suggested direction:** detail skeletons include a `PageHeader` skeleton (Stock Details is the
reference).

### UI-028 — Error presentation uses three different components

- **Severity:** P2
- **Pages:** Stock Details, gate pages, auth, Admin vs the rest
- **Viewports:** All
- **Personas:** All

**Observed:**
- `EmptyState variant="error"` (centred, red-tinted) on product pages.
- `StockStatusPanel` (left-aligned, eyebrow) on Stock Details.
- `RequireAuth` bespoke markup (22 px h1, no gutter).
- Admin's error has no retry. Titles vary ("Something went wrong", "… could not be loaded").

**Evidence:**
- `dashboard/pro-error-*`, `stocks/pro-details-error-*`
- `shell/pro-session-check-failed-mobile-390.png`, `admin/pro-admin-access-denied-*`

**Suggested direction:** `EmptyState` everywhere, with one title pattern ("{Thing} could not be
loaded") and an always-present recovery.

### UI-029 — Session-gate pages lack gutters and misdescribe failures

- **Severity:** P2
- **Pages:** Any protected route when `/auth/me` fails; `/admin` for non-admins
- **Viewports:** Phone
- **Personas:** All

**Observed:**
- Text touches the viewport edge (rendered outside `PageContainer`).
- A 500 is described as "The API could not be reached. Check your connection".

**Evidence:** `shell/pro-session-check-failed-mobile-390.png`, `admin/pro-admin-access-denied-mobile-390.png`

**Suggested direction:** render gate states inside `PageContainer` as `EmptyState`, and word the
failure by status.

### UI-030 — "New …" changes location and style between states and vanishes while loading

- **Severity:** P2
- **Pages:** Lists, Strategies, Monitors, Backtests
- **Viewports:** All
- **Personas:** free-empty vs populated

**Observed:**
- Populated: a tinted "New …" at header right.
- Empty: no header button, and a *solid* CTA inside the empty state ("New list", "Run your first
  backtest").
- Loading and error: no create action at all.

**Expected consistency:** `v1-visual-parity.md`: "Actions must not change order between loading,
empty and populated states"; "an empty state occupies the collection region without moving New…
away from the header". `frontend.md` says the opposite ("exactly one create call to action… the
empty section carries it otherwise").

**Evidence:** `lists/free-empty-collection-*` vs `lists/starter-collection-*`, `*/pro-collection-loading-*`

**Suggested direction:** resolve the doc conflict. Recommended: the header always carries "New …"
(disabled while loading), and the empty state repeats it only as copy.

### UI-031 — Failed backtest page leaks codes, suggests a futile retry and shows misleading empty sections

- **Severity:** P1
- **Pages:** `/backtests/[id]` (FAILED)
- **Viewports:** All
- **Personas:** Any

**Observed:**
- "The backtest could not be completed. Please try running it again." with Phase "Preparing data",
  Failure code `EXECUTION_FAILED` and the Run ID. The runs failed because the universe has no usable
  data, which a retry cannot fix.
- Below: an empty chart, KPIs "—", "No positions have been opened yet.", "Trade log 0 — This run made
  no trades."
- The CTA "Start a new backtest" opens a blank form, not this configuration.

**Why it matters:** failure is when users most need guidance, and they get implementation vocabulary
and a dead end.

**Evidence:** `backtests/pro-heavy-result-failed-1-*`, `backtests/pro-heavy-result-failed-2-*`

**Suggested direction:**
- Map failure codes to user-facing reasons and actions ("None of the 100 stocks has price data for
  this period — choose another list or period").
- Hide result sections for failed runs.
- "Edit and run again" prefilled from the snapshot.
- Keep the Run ID in a "Details for support" disclosure.

### UI-032 — Result hero has no follow-up actions; Strategy and Cash lines are hard to distinguish

- **Severity:** P2
- **Pages:** `/backtests/[id]`
- **Viewports:** All
- **Personas:** All

**Observed:**
- No "Run again / Duplicate settings / Monitor this" in the hero.
- Strategy (#4882FF) and Cash (#B9C6E8) are both blue; when they overlap they merge.

**Evidence:** `backtests/pro-heavy-result-completed-desktop-1440.png`

**Suggested direction:** header actions (secondary "Run again with these settings"); Cash drawn as a
neutral dashed line.

### UI-033 — Phone result: 2-column KPIs and a 4-line display title

- **Severity:** P3
- **Pages:** `/backtests/[id]`
- **Viewports:** Phone
- **Personas:** All

**Observed:** KPIs in 2 columns (the spec says 4); a long strategy name wraps to 4 lines at 28 px.

**Evidence:** `backtests/pro-heavy-result-completed-mobile-390.png`

**Suggested direction:** four compact KPI columns; clamp the hero title to 2 lines, with the full
name available.

### UI-034 — Backtests collection chips are static; "View results" only for terminal runs

- **Severity:** P3
- **Pages:** `/backtests`
- **Viewports:** All
- **Personas:** All

**Observed:**
- Stock list and Strategy chips are not links (a known read-model gap: no ids in the summary).
- Running rows have an empty action cell, although the result page shows live progress.

**Evidence:** `backtests/pro-collection-every-status-desktop-1440.png`

**Suggested direction:** add ids to the summary contract; "View progress" for non-terminal runs.

### UI-035 — Two independent stock comboboxes with divergent behaviour and ARIA semantics

- **Severity:** P2
- **Pages:** Topbar search; list create / add stocks
- **Viewports:** All
- **Personas:** All

**Observed:**

| | Topbar search | List picker |
|---|---|---|
| Blank focus | recents / popular | nothing |
| Spinner | yes | no |
| Error copy | API-derived | hard-coded |
| `aria-selected` means | highlighted | chosen |
| Labelled listbox | yes | no |
| Enter on blank | picks the first shortcut | – |

**Evidence:** `stocks/*-search-*`, `pickers/starter-list-picker-*`

**Suggested direction:** one `SecurityCombobox` primitive with single- and multi-select modes.

### UI-036 — Rate-limit copy is lost in the list picker and contradicted in the topbar

- **Severity:** P2
- **Pages:** List picker, topbar search
- **Viewports:** All
- **Personas:** All

**Observed:**
- For a 429, the list picker says "Search is unavailable right now. Try again".
- The topbar says "Too many requests. Please try again in 42 seconds." and still shows a "Try again"
  button.

**Expected consistency:** `frontend.md` §Request failures — "a 429 is not an invitation to retry".

**Evidence:** `pickers/starter-list-picker-rate-limited-*`, `stocks/pro-heavy-search-rate-limited-*`

**Suggested direction:** use `requestFailureMessage` in both, and hide or disable retry until the
wait elapses.

### UI-037 — A lapsed subscriber cannot re-buy the plan they left (card shows "Waiting for payment confirmation")

- **Severity:** P1
- **Pages:** `/billing`
- **Viewports:** All
- **Personas:** Canceled / unpaid / expired subscribers (mocked status)

**Observed:**
- For `status: CANCELED` on Pro yearly, the toggle opens on Yearly.
- The Pro card has no button and reads "Waiting for payment confirmation".
- Cause: `currentPriceKeyOf` ignores the subscription status.

**Why it matters:** the most likely returning buyer sees a misleading message and no purchase path
for their old plan.

**Evidence:** `billing/mock-free-canceled-pro-annual-desktop-1440.png`

**Suggested direction:** treat ended statuses as "no current price". The last plan could carry a
"Resubscribe" CTA.

### UI-038 — Cancellation-pending state asks the user to resume but offers no Resume action

- **Severity:** P2
- **Pages:** `/billing`
- **Viewports:** All
- **Personas:** Paid, cancellation scheduled

**Observed:** the other cards read "Resume your subscription to change plan". The only route is the
generic "Manage billing".

**Evidence:** `billing/mock-pro-cancel-pending-desktop-1440.png`

**Suggested direction:** the hint names the path ("Resume in Manage billing") or the page offers a
Resume action.

### UI-039 — Plan cards omit or blur real limits

- **Severity:** P2
- **Pages:** `/billing`, `/pricing`
- **Viewports:** All
- **Personas:** All

**Observed:**
- The per-backtest stock limit is not listed.
- "Backtests over N years of history" reads as look-back rather than period length.
- Admins see Free's limits.
- The Free card shows "$0 / year" on the yearly toggle.

**Evidence:** `billing/guest-pricing-*`, `billing/mock-free-canceled-pro-annual-desktop-1440.png`

**Suggested direction:** add "Up to N stocks per backtest"; reword to "Backtest periods up to N
years".

### UI-040 — Signed-in users see the sign-in form at /login

- **Severity:** P2
- **Pages:** `/login` (and `/register`)
- **Viewports:** All
- **Personas:** Signed-in

**Evidence:** `auth/pro-visits-login-while-signed-in-*`

**Suggested direction:** redirect to `next` or the Dashboard, or show "Signed in as …".

### UI-041 — Empty sign-in submit is sent and answered "Unable to sign in with those credentials."

- **Severity:** P3
- **Pages:** `/login`
- **Viewports:** All
- **Personas:** Guest

**Evidence:** `auth/login-empty-submit-*`

**Suggested direction:** client-side required-field messages, as the verify/reset forms already do.

### UI-042 — Return path is dropped by several sign-in entry points

- **Severity:** P2
- **Pages:** Topbar "Sign in", Dashboard guest notice, "Continue to sign in" (after verify and
  reset), forgot-password links; SignInPrompt from "Backtest this …"
- **Viewports:** All
- **Personas:** Guest

**Observed:**
- Plain `/login` links lose `next`.
- The backtest prompt returns to the strategy page, not the prefilled backtest the decision record
  describes.
- `GUEST_ENTITLEMENTS.backtests.canViewDemo` is still `true`.

**Evidence:** `shell/guest-topbar-*`, `dashboard/guest-collection-*`, `strategies/guest-backtest-this-prompt-desktop-1440.png`

**Suggested direction:** build every sign-in link with `signInHref(currentReturnPath())`, pass the
intended href through the prompt, and correct the stale flag.

### UI-043 — Invalid reset link keeps a dead form; invalid verification link does not

- **Severity:** P2
- **Pages:** `/reset-password`, `/verify-email`
- **Viewports:** All
- **Personas:** Guest

**Observed:**
- Reset shows the raw API sentence "This password reset link is invalid or has expired" (no full
  stop) above an enabled form.
- Verify switches to a dedicated state with a resend form.

**Evidence:** `auth/reset-password-invalid-token-*`, `auth/verify-email-invalid-token-*`

**Suggested direction:** mirror the verify pattern: an invalid state plus an inline "Send a new
link".

### UI-044 — Auth pages use their own type, button and breakpoint scale

- **Severity:** P3
- **Pages:** All auth pages
- **Viewports:** All
- **Personas:** Guest

**Observed:** 30/26 px titles, 46 px buttons, a 560 px breakpoint, "..." pending labels, "|" title
separator, and a blue top border.

**Evidence:** `auth/login-default-*`

**Suggested direction:** consume the shared tokens and `forms` classes. Keep the standalone
composition.

### UI-045 — Four select stylings; a stale reference silently shows the placeholder

- **Severity:** P2
- **Pages:** New Backtest, Monitor dialog, Strategy Builder, `SelectControl`
- **Viewports:** All
- **Personas:** All

**Observed:**
- Four heights and styles: 44, 46 and 38 px, plus `--action-height`.
- In Backtest and Monitor, an id not in the options renders "Select a …" while state still holds
  it. The Builder instead injects an "Unavailable" option.

**Suggested direction:** one `Select` primitive, with the Builder's explicit unavailable-option rule
adopted everywhere.

### UI-046 — Checkout return claims a confirmed subscription after the settle window expires

- **Severity:** P1
- **Pages:** `/billing?checkout=success`
- **Viewports:** All
- **Personas:** Buyers whose webhook is slow

**Observed:** after 6 × 1.5 s with the plan still Free, the notice switches to "Payment received.
Your plan below reflects your confirmed subscription." The cards below still show Free as current.

**Why it matters:** it tells a paying customer something false about their money.

**Evidence:** `billing/mock-checkout-success-settling-desktop-1440.png`, `billing/mock-checkout-success-window-expired-desktop-1440.png`

**Suggested direction:** a third outcome: "We're still confirming your payment — this can take a
minute. Refresh or check back shortly."

### UI-047 — "Billing & Plan" vs "Plan and billing"

- **Severity:** P3
- **Pages:** `/billing` header vs account menu, `/pricing` link, tab title
- **Evidence:** `billing/mock-free-desktop-1440.png`, `auth/pro-account-menu-open-desktop-1440.png`
- **Suggested direction:** one name.

### UI-048 — Collections and details never refresh; relative ages don't tick

- **Severity:** P2
- **Pages:** Backtests collection, Monitors, Monitor detail, Admin; Dashboard ages
- **Viewports:** All
- **Personas:** All

**Observed:** a RUNNING run stays "42%" in the collection until reload. The Dashboard refreshes every
60 s, but "Updated 12 min ago" is computed once per render.

**Evidence:** `backtests/free-limit-collection-*`

**Suggested direction:** poll collections while any row is non-terminal; tick relative times.

### UI-049 — Date formats vary by surface and by OS locale

- **Severity:** P2
- **Pages:** Lists, Strategies, Monitor detail, Dashboard, date inputs
- **Viewports:** All
- **Personas:** All

**Observed:**
- `formatListDate` (en-US) vs `formatStrategyDate` (browser locale).
- "2026-09-18 · from history" vs "Sep 18, 2026, 11:00 AM".
- Absolute "Last checked" vs relative "Updated 12 min ago".
- Native date inputs in OS format ("01.06.2025") beside "Jun 1, 2025".

**Evidence:**
- `monitors/pro-heavy-monitor-detail-dense-desktop-1440.png`
- `lists/starter-membership-valid-preview-desktop-1440.png`

**Suggested direction:** one date module (date, datetime, relative) used everywhere; consider a
product date picker for consistency.

### UI-050 — Row actions have ambiguous accessible names ("Open", "Edit")

- **Severity:** P2
- **Pages:** All collections, Admin
- **Viewports:** All
- **Personas:** All

**Observed:** 158 "Open" and 48 "Edit" controls whose accessible name lacks the entity. The overflow
trigger does it right ("More actions for …").

**Suggested direction:** `aria-label="Open {name}"`, as the overflow already does.

### UI-051 — `/stocks` is a stale placeholder

- **Severity:** P3
- **Pages:** `/stocks`
- **Observed:** "Stock research and intrinsic value arrive in the Stock Details slice." with a
  bespoke h1 and no `PageHeader`.
- **Evidence:** `stocks/pro-stocks-index-placeholder-*`
- **Suggested direction:** redirect to search, or make it a real "research" landing (recents,
  popular).

### UI-052 — `/admin` is bespoke; admin edits to built-ins carry no "affects everyone" signal

- **Severity:** P3
- **Pages:** `/admin`, built-in editors as admin
- **Observed:**
  - A 32 px header with its own role pill; visible "Edit" row links; no retry.
  - The ordinary editors give no "changes apply to every user" notice.
- **Evidence:** `admin/master-admin-*`, `lists/master-builtin-list-editable-*`
- **Suggested direction:** `PageHeader` + `DataTable` conventions; a persistent notice on built-in
  editors in admin mode.

### UI-053 — Shell nits: no active nav item on Dashboard/Stocks/Billing; account-menu semantics; native confirm

- **Severity:** P3
- **Observed:**
  - The desktop nav highlights nothing on `/dashboard`, `/stocks/*`, `/billing`.
  - The account menu is `role="menu"` without arrow keys and dismisses on different events from
    `OverflowMenu`.
  - The Builder's leave guard uses `window.confirm`, and account-menu links bypass it.
- **Evidence:** `shell/pro-nav-on-stock-details-desktop-1440.png`, `shell/pro-nav-on-billing-desktop-1440.png`

### UI-054 — Console noise: Guest 401 on every load; hydration mismatches

- **Severity:** P3
- **Observed:** `GET /auth/me` → 401 logs "Failed to load resource" on every Guest page. React
  attribute hydration warnings appear on several pages.
- **Evidence:** `manifest.json` (`consoleErrors`)
- **Suggested direction:** a non-error session probe for Guests; locale/time-stable SSR output.

### UI-055 — Tab titles missing or inconsistent

- **Severity:** P3
- **Observed:**
  - `/dashboard`, `/admin` and the Strategies routes have no route title.
  - Detail titles are generic ("List · FactorSage", "Backtest · FactorSage").
  - Auth and not-found use "|".

### UI-056 — Button order and retry-button weight vary

- **Severity:** P3
- **Observed:**
  - SignInPrompt, `error.tsx` and `global-error.tsx` put the primary button first.
  - "Try again" is secondary on pages but primary in `error.tsx` and the Monitor dialog.

### UI-057 — Not-found wording differs per entity and is wrong for other accounts' monitors

- **Severity:** P3
- **Observed:** "List not found" / "Strategy not found" / "This monitor no longer exists — It may
  have been deleted" / "This backtest was not found".
- **Evidence:** `*/starter-opens-other-accounts-object-desktop-1440.png`
- **Suggested direction:** one pattern: "{Thing} not found — it may have been deleted, or it belongs
  to another account."

### UI-058 — Terminology and microcopy drift

- **Severity:** P3
- **Observed:**
  - "Membership" vs "buy window(s)" across the editor, hints and delete dialogs.
  - "Exit rule N" / "Rule N" / "+ Add OR rule".
  - "Recent Searches" means recently *viewed*.
  - Static "Popular Searches" are not catalog-checked.
  - "Margin of Safety (DCF (FCFF))" and "Margin of Safety (Dividend Discount (DDM))".
  - The two delete-list confirmations differ.
  - Some validation messages lack a full stop ("Pick the date membership starts").

---

## 30. Recommended design-system rules

Each rule points to the existing implementation that should be treated as the reference.

| # | Rule | Reference to converge on |
|---|---|---|
| R1 | **Page header.** `PageHeader` everywhere. Title = the entity's name (never "Edit X"). Back link = owning collection. Actions right: secondary → primary → overflow. | `ListDetail` header |
| R2 | **Collection primary action.** "New …" (tinted) is always in the header at the same place, including empty, loading and error; disabled while loading. | Lists/Strategies populated state |
| R3 | **Entity "Run backtest".** Every List, Strategy, Monitor and Stock header offers "Run backtest" (secondary) via `AccountActionLink`, prefilled. | `StrategyReadOnlyView` "Backtest this strategy" |
| R4 | **Record table.** `DataTable` only. Identity column with a min-width floor; relationship chips intrinsically capped; actions column never scrolls away (sticky last column or a folded relationships line). | Dashboard UX-007 rules, generalised |
| R5 | **Phone record card.** Identity + status + overflow in the top row; facts; relationships; one contextual action at the bottom. Long-text facts stack (label above). Menus collision-aware. | `DataTable` card roles (fix overflow placement) |
| R6 | **Empty state.** Header keeps "New …". The empty region is a compact `EmptyState` in the section, with explanatory copy and at most one CTA. Filtered-empty always offers "Clear filters". | Lists empty copy; Dashboard compact states |
| R7 | **Loading.** Skeleton shaped like the destination, including the `PageHeader` skeleton; never text-only for page loads. | Stock Details skeleton |
| R8 | **Errors.** `EmptyState variant="error"` for fetch failures ("{Thing} could not be loaded" + Try again); an `EntitlementNotice` for plan refusals (message + limit + "See plans"); never raw codes except in a support disclosure. | Dashboard error; `requestFailureMessage` |
| R9 | **Form footer.** `WorkflowFooter`, which also surfaces the submit error and focuses the first invalid field. The Builder save bar remains the one exception. | New Backtest |
| R10 | **Dialogs.** `Modal`; title = verb + object ("Rename list", "Delete monitor"); Cancel then primary; phone stacks primary on top. | `ConfirmDialog` |
| R11 | **Pickers.** One `EntitySelect` (grouping Built-in / Yours, loading copy, error, unavailable-option rule), one `SecurityCombobox` (single/multi), one `Select`. | Backtest optgroups; Builder unavailable option; topbar search behaviour |
| R12 | **Badges.** Level: outline, BUY positive / SELL negative / FINAL EXIT warning (one shared map). State: solid. Ownership "Built-in": outline neutral, only where ownership is mixed. Plan: badge in the account menu. | Dashboard level + state pills |
| R13 | **Limits.** Wherever a limited quantity is edited, show "N of LIMIT" and a plan-aware default; refusals via R8. | Plan cards (derived from `PLAN_ENTITLEMENTS`) |
| R14 | **Freshness and time.** One date module: date "Sep 18, 2026", datetime "Sep 18, 2026, 11:00 AM", relative ("3 d ago") that ticks; every signal row carries "since". | Market strip's session-date honesty |
| R15 | **Destructive actions.** Always in an overflow or behind a confirm or undo, never red at rest. | `OverflowMenu` + `ConfirmDialog` |
| R16 | **Spacing and type scale.** Tokens only; the display title only on the result hero; no feature-level page gaps. | `tokens.css` |
| R17 | **Breakpoints.** One documented set matching the code (880 as the dense/compact switch) plus a defined 600–879 behaviour. | `DataTable.module.css` |

---

## 31. Prioritised cleanup plan

**Phase 1 — Structural layout defects** (small, high-leverage, shared components)
- Intrinsic chip cap in `EntityReferenceChip`; identity floors and a non-scrolling actions column in
  `DataTable`; collision-aware `OverflowMenu`, with the phone trigger at top-right.
- Resolves **UI-001, UI-002, UI-003, UI-006**; partially **UI-004**.

**Phase 2 — Entitlement and failure communication** (the trust layer)
- `EntitlementNotice` + "See plans".
- Proactive "N of LIMIT" meters (lists, monitors, backtest period and symbols).
- Plan-aware MAX and a monitor "create disabled" path.
- Account-level compliance notice for downgraded accounts; plan badge in the account menu.
- Failure-code mapping for backtests; hide result sections on failure.
- Billing fixes: lapsed-subscriber CTA, settle-timeout copy, resume path; card copy.
- Resolves **UI-020, UI-021, UI-022, UI-023, UI-024, UI-031, UI-037, UI-038, UI-039, UI-046, UI-005**.

**Phase 3 — Workflow symmetry**
- "Run backtest" on every entity header and row.
- One `EntitySelect` shared by Backtest and Monitor, with explicit ownership rules.
- Strategy editor identity and actions (title, overflow Rename/Delete, backtest).
- Back links to collections.
- "New …" placement rule (resolve the doc conflict first).
- Resolves **UI-008, UI-009, UI-015, UI-016, UI-030, UI-034, UI-040, UI-042**.

**Phase 4 — Pickers and forms**
- Builder defaults (empty metric), issue count after interaction, quiet Remove with undo.
- One `SecurityCombobox` and one `Select`; rate-limit copy via `requestFailureMessage`.
- Membership: current period first, a period list reachable by touch.
- Reset-password invalid state mirrors verify.
- Resolves **UI-013, UI-014, UI-019, UI-035, UI-036, UI-043, UI-045, UI-041**.

**Phase 5 — State handling and data presentation**
- Dashboard "Since" column, default sort, optional grouping, "Current matches" label.
- Monitor detail filters and resolution reasons.
- Search and sort for collections; polling for non-terminal backtests; ticking relative times.
- Detail-page header skeletons; `EmptyState` for every error (Stock Details, gate pages, Admin retry).
- One date module.
- Resolves **UI-010, UI-012, UI-025, UI-026, UI-027, UI-028, UI-029, UI-048, UI-049**.

**Phase 6 — Visual polish and system hygiene**
- Migrate Stock Details, auth and Admin onto shared primitives and tokens.
- Stock Details actions, legend and sign convention.
- Collection twin-table alignment and badge redundancy.
- Result hero actions, chart palette and phone KPIs.
- Breakpoint documentation; tab titles; button order; not-found wording; terminology; console noise;
  accessible names; `/stocks`.
- Resolves **UI-004, UI-007, UI-011, UI-017, UI-018, UI-032, UI-033, UI-044, UI-047, UI-050,
  UI-051, UI-052, UI-053, UI-054, UI-055, UI-056, UI-057, UI-058**.

Every finding is assigned to exactly one phase, except UI-004, which starts in Phase 1 and closes in
Phase 6.

---

## 32. Screenshots / evidence index

- **Location:** `artifacts/ui-audit/` — 642 PNGs, ~82 MB. Areas: `admin` 5, `auth` 70, `backtests`
  96, `billing` 48, `dashboard` 62, `lists` 100, `monitors` 85, `pickers` 22, `shell` 26, `stocks`
  54, `strategies` 74.
- **Naming:** `{area}/{persona}-{state}-{viewport-label}.png`. Viewport labels: `desktop-1440`,
  `desktop-1280`, `tablet-1024`, `boundary-880`, `boundary-879`, `mobile-390`, `mobile-375`.
- **Manifest:** `artifacts/ui-audit/manifest.json`, one entry per screenshot. Fields: file, route,
  persona, tier, viewport, state, fixture, mocks, audit section, automated `checks` (overflow px,
  outside-viewport elements, duplicate ids, unnamed controls, ambiguous labels, h1 count), console
  errors, page errors, unexpected failed requests.
- **Human-readable index:** `artifacts/ui-audit/EVIDENCE_INDEX.md`, grouped by area, with persona,
  viewport, state and mocks for every file. Generated by `harness/evidence-index.mjs`.
- **Harness (reproducible):** `artifacts/ui-audit/harness/`:
  - `lib.mjs` — sessions, checks, manifest.
  - `seed-audit-users.ts` — the four audit personas, in the test DB only.
  - `populate.mjs` — audit content via the public API.
  - `mocks.mjs` + `fixtures/` — contract-true mocked states derived from real responses.
  - `capture-*.mjs` — per-area captures.
  - `diag-table.mjs` — the UI-001 DOM measurement.
  - `contact.mjs` — a review aid.

  Run it against the hermetic stack after `pnpm test:personas:seed`.

Persona coverage (captures):
- pro 155
- guest 120
- pro-heavy 116
- starter 102
- free-limit 36
- master 28
- free-empty 24
- downgraded 23
- free-normal 22
- starter-limit 16

Viewport coverage:
- 1,440: 286
- 390: 237
- 1,024: 84
- 1,280: 11
- 880: 10
- 879: 12
- 375: 2

Mocked captures: 141 of 642.

### Areas not tested, and why

| Area | Reason |
|---|---|
| Real Google OAuth consent and callback | No Google client on the hermetic stack. The button was rendered via a mocked `/auth/providers`; the redirect flow was not exercised. |
| Real email delivery and link redemption end-to-end | SMTP off by design (no Mailtrap quota). Verify and reset pages were driven with mocked API responses. |
| Stripe Checkout and Customer Portal pages | No Stripe objects created by design. Every Stripe-facing POST was mocked. |
| Real market data, real logos | Fixture provider only; synthetic prices on one security; every logo is the monogram. |
| Worker-produced live signals for user monitors | Fixture quotes are empty, so user monitors are "Not evaluable". Dashboard and Monitor richness was mocked from real payloads. |
| Long (15–30 year) real backtests | The fixture price window is ~3 years. Period-length behaviour was verified via refusals; the 20-year historic fixture shows the summary-only rendering. |
| Touch gestures on charts (pinch/pan) | Headless Chromium; hover/crosshair only. |
| Native `<select>` open state | Drawn by the OS; option sets were recorded from the DOM instead. |
| Safari / Firefox, screen readers, 200% zoom | Out of scope for this pass; only automated a11y heuristics and keyboard spot checks. |
| 60-second Dashboard refresh cadence | Not observed over time; confirmed in code. |

### External side effects

- **Email:** none. The register, resend and forgot-password POSTs were intercepted in the browser;
  SMTP is blank on the stack.
- **Stripe:** none. One real `POST /billing/change` reached the local API when a hung mock was
  released (capture `billing/mock-loading-desktop-1440.png`). The API refused it with `409
  BILLING_NO_SUBSCRIPTION` before any Stripe code ran, and the placeholder key plus the egress guard
  make a Stripe call impossible on this stack.
- **FMP:** none. The fixture server answered six local 404s for real-symbol profiles (Stock Details
  for IBM, and a failed backtest over real symbols).
- **Egress:** the guard log shows exactly one blocked outbound attempt, Next.js's own
  `registry.npmjs.org` version check (the documented tolerated case).
- **Databases:** only `intrinsic_value_test` was written: 4 audit users plus their content, created
  through the public API. The development database was not touched.
