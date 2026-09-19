# Frontend Architecture and Visual System

This document is the canonical frontend guidance for IntrinsicValue V2.

The legacy repository `BMarius93/intrinsic-value-old` is the visual and behavioral reference for the product. It is not an implementation template. Preserve the established FactorSage feel where it still fits the V2 product, but rebuild using the V2 dependency rules and feature boundaries.

## Visual direction

The V2 product UI should feel like a refined continuation of the legacy FactorSage application, not a redesign.

Core traits to preserve:

- Light, calm financial-product UI rather than a dark trading-terminal aesthetic.
- Near-white page background (`#FCFCFC`) and white primary surfaces.
- Blue as the primary interactive/brand accent, centered on `#4882FF` with a darker hover/active tone around `#3B73E6`.
- Dark neutral primary text around `#222222` / `#404040` and muted text around `#667085`.
- Very light cool borders around `#E6EAF5` and subtle blue-tinted elevation.
- Green for positive/buy states (`#1E9E78`), red for negative/sell states (`#D1435B`), and restrained orange for warning/final-exit states.
- Rounded cards and controls, generally softer than default browser UI. A page-level surface uses
  `--radius-lg`; controls and nested surfaces use smaller radii. The large `--radius-hero` radius is
  reserved for a true outcome hero and is not a default for product cards.
- Ordinary surfaces are flat, and elevation is reserved for overlays and that one hero. Do not turn
  the product into a heavily elevated/card-stacked dashboard.
- Information density should remain appropriate for financial research: compact enough for tables and metrics, but with clear spacing and hierarchy.

Use the design tokens in `apps/web/src/styles/tokens.css`. It holds the product's shared visual
language — the semantic palette, the radius and elevation scales, the type scale, the standard
control sizes and the page spacing system — and a feature stylesheet asks for those by name instead
of restating their values. Geometry that is genuinely local to one component stays local; what is
prohibited is redefining a shared constant. A hex colour lives only in `tokens.css`. A genuinely new
shared value becomes a new token named for what it _means_ (`--color-positive`, never
`--monitor-green`). `ui-system.md` states the rule in full.

`ui-system.md` is the companion document: the shared component vocabulary that implements this
direction, what each component represents, and when not to reach for one. Read it before adding a
component to `components/ui`, and before writing a page header, a section surface, a collection, a
status pill, an entity reference or a stock identity anywhere.

## Typography

Use Geist as the primary UI font and Geist Mono where monospaced financial/technical content is
useful.

> Geist is a **V2 decision**, not something carried over from V1. Deployed V1 computes to
> `ui-sans-serif, system-ui, sans-serif`, so it renders in a different typeface on every operating
> system. V2 keeps Geist deliberately: it is close enough that a returning user does not register a
> change, and it is the same everywhere.

Typography should remain neutral and functional. The **shared scale** comes from tokens in
`styles/tokens.css`, and a feature stylesheet asks for it rather than restating it — a component may
still size a figure it alone draws, such as a KPI value or a quote:

- Page title: `--text-page-title`, 17px on a phone and 20px from 880px, at `--weight-emphasis`.
  A 24-28px display title belongs to the outcome hero (`--text-page-title-hero`) and nowhere else.
- Section title: `--text-section-title`.
- Labels: `--text-label-size` with `--text-label-tracking`, uppercase, at `--weight-emphasis`.
- Body text: `--text-body` (14px) for dense product screens, `--text-secondary` (13px) beside it.
- **One emphasis weight.** `--weight-emphasis` is 600. The product does not use 700: reserving it
  keeps a label from competing with the value it labels, and matches V1's 400/500/600 ladder.
- Financial values: use consistent weight and tabular/monospaced presentation when alignment materially improves scanning.

Do not introduce a second decorative display typeface for normal product screens without an explicit design decision.

## Responsive behavior

Responsive behavior is a product requirement, not a final CSS cleanup step. Every user-facing feature must be designed and tested for both desktop and mobile as part of the same task.

Legacy behavior worth preserving conceptually:

- Desktop and mobile share the same information architecture and feature semantics.
- The top application bar remains compact and persistent where useful.
- Branding can adapt by viewport: compact mark on small screens, fuller wordmark when space permits.
- Desktop navigation may expose more persistent navigation; mobile should use a compact navigation treatment and may use a fixed bottom navigation for the primary destinations.
- Mobile layouts receive dedicated composition where density requires it. Do not force a desktop table into a tiny viewport merely by adding horizontal scrolling.
- Dense collections are a **table on desktop and one purpose-built card per row on mobile**. This is
  not optional polish and not per-feature discretion: it is what `components/ui/DataTable` does, and
  features get it by using that component rather than by choosing a layout.
- Both presentations are the **same DOM**, not two copies behind media queries. A record rendered
  twice doubles every row count, reads every record twice to a screen reader, and duplicates
  `data-testid`s. Playwright counts collection rows as `tbody tr` for this reason.
- Charts must resize to the container and remain usable by touch. Tooltips, legends, selectors, and overlays must not assume mouse hover.
- Page padding should scale progressively with viewport size rather than jumping from cramped mobile to oversized desktop spacing.
- Fixed mobile UI must respect `env(safe-area-inset-bottom)`.
- Avoid content hidden behind fixed bottom navigation; reserve sufficient bottom padding on small screens.

As a baseline, consider behavior at roughly phone, tablet/small desktop, and large desktop widths. Use content-driven breakpoints rather than copying legacy breakpoint values mechanically.

The application shell and dense feature content have different constraints. Reuse these baseline
breakpoints unless a feature's own content demonstrates a different need. The full visual-parity
composition and acceptance contract is in `v1-visual-parity.md`:

- `600px` — tablet padding, the fuller brand treatment and the four-column KPI band.
- `880px` — the canonical dense/compact switch: topbar navigation replaces the fixed bottom
  navigation, and `DataTable` switches from its fluid one/two-column card grid to the dense table
  (UI-004). The earlier `768px`/`1024px` pair never existed in CSS and is withdrawn.
- `1280px` — wide desktop padding; 880–1,279px is the intermediate band where wide tables fold.

Component-local breakpoints are allowed only for a component's own content and are listed in
`ui-system.md` (Breakpoints).

## Frontend structure

Use App Router for routing and composition. Do not introduce Pages Router in V2.

Preferred direction:

```text
apps/web/src/
  app/                    # routes, layouts, route-level loading/error composition
    api/logo/[symbol]/    # the one server route the web app owns: the cached logo proxy
  components/
    ui/                   # genuinely reusable primitives
    layout/               # app shell/navigation primitives
  features/
    stocks/
      api/
      components/
      hooks/
      utils/
    lists/
    strategies/
    backtests/
    monitors/
  lib/
    api/                   # shared transport/client infrastructure only
    stock-logo.ts          # where a security's mark comes from (one abstraction)
  styles/
    tokens.css
```

Keep feature-specific code inside the feature. Do not create a global component merely because two files currently use it; promote it only when it represents a stable shared UI concept.

Route files should be thin composition boundaries. React components must not own financial/business calculations that belong in domain/backend code.

### Application shell

`components/layout` owns the shared chrome: `AppShell` (topbar, content region,
and mobile bottom navigation), `AppTopbar`, `MobileBottomNav`, `BrandMark`, and
`PageContainer`. Routes compose the shell through a layout; they do not rebuild
chrome per page.

`components/layout/navigation.ts` is the single source of truth for primary
destinations and for active-route matching. Add or rename a destination there,
never inside a navigation component.

`AppTopbar` exposes an `actions` slot for account/user controls so authentication
work can supply them without changing the shell.

### Shared UI vocabulary

`components/ui` holds the cross-feature product concepts: `PageHeader`, `SectionCard`, `DataTable`,
`FactGrid`, `StatusBadge`, `EntityReferenceChip` / `LinkedEntities`, `StockIdentity` / `StockLogo`,
`EmptyState`, `Skeleton`, plus the `forms` and `actions` class modules. `ui-system.md` documents
each one.

The durable rules:

- **The legacy repository is the visual oracle.** A returning FactorSage user should recognise the
  product; an engineer should recognise a cleaner V2 codebase.
- **Desktop composes large surfaces.** A page is `PageHeader` plus a stack of `SectionCard`s. Do not
  nest a section surface inside another, and do not render a desktop grid of one small card per
  record.
- **Dense collections are tables inside those surfaces**, and their mobile counterpart is a card per
  row — from `DataTable`, once.
- **Geist is canonical**, applied on `body` in `globals.css`; Geist Mono only where alignment of
  technical or financial values genuinely helps. No feature declares a font family, and the shared
  scale — page title, section title, body, secondary, label, emphasis weight — comes from tokens. A
  component may still size something it alone draws, such as a KPI's figure.
- **Surfaces are flat.** An ordinary surface is `--radius-lg` with a 1px border and no shadow, which
  is what separates a tool from a marketing page. `--radius-hero` and `--shadow-hero` belong to one
  screen, the backtest result. Overlays — menus and dialogs — are the only other place elevation is
  real.
- **Width is an intent, not a number.** `PageContainer` takes `width="data" | "reading"`: data
  surfaces use the screen, editors and prose keep a readable measure. No route writes a max-width.
- **Status, relationship, identity, empty, loading and table primitives are not reinvented in a
  feature.** A feature owns what a status _means_ — its label, its tone, its ordering — and the
  shared component owns how it looks.
- **Entity relationships are explicit and clickable.** A Monitor shows its Strategy and Stock List;
  a Backtest shows its Strategy, Stock List and Benchmark; the Dashboard links every reference it
  names. Use `EntityReferenceChip`, and omit its `href` where the entity has no page or no longer
  exists rather than rendering a link that 404s.
- **Stock identity goes through `StockIdentity`.** A logo is decoration: it must degrade to the
  ticker monogram, must not shift layout when it fails, must not stretch, and must not be announced
  twice. Never assemble a provider image URL in a component. Every mark is served from the
  product's own `/api/logo/{ticker}` endpoint, whose handler is the one file in the web application
  that knows a provider URL; `lib/stock-logo.ts` is the only thing that builds the same-origin URL,
  and `ui-system.md` (`StockIdentity` / `StockLogo`) documents why.
- **Page rhythm is defined once.** A route's `.page` composes `stack` from
  `components/ui/page.module.css`; do not set a page gap or top padding in a feature stylesheet.

### Styling

Component styles live in colocated CSS Modules (`Component.module.css`) that read
the semantic tokens. `globals.css` is reserved for app-wide element defaults and
shared cross-page classes; do not grow it with per-component rules. Shared layout
metrics (topbar height, bottom-navigation height, safe-area inset, content
max-width, page padding) are tokens in `styles/tokens.css` so chrome and content
cannot drift apart.

## API and contracts

- The web app consumes `@intrinsic/contracts` as the canonical API shape.
- Never import Prisma, database, FMP, worker, or server-only domain infrastructure into web code.
- Do not duplicate API response interfaces locally when a contract already exists.
- Keep shared HTTP mechanics in `lib/api`; keep stock-specific calls in `features/stocks/api`, etc.
- UI components should receive view-ready data or use feature hooks; they should not know backend persistence details.
- Loading, empty, error, stale/unavailable, and partial-data states are part of the feature implementation, not optional polish.
- **A missing read model is documented, never worked around in the browser.** Do not fan a
  collection out into one request per row to reconstruct an aggregate the API does not expose, and
  do not invent or infer a value the backend did not record. Record the gap in `ui-system.md` under
  "Known read-model gaps" and build what the existing contracts truthfully support. The Dashboard is
  the worked example of closing one: `GET /dashboard` is its dedicated read model, so the page makes
  one request instead of joining monitors, states and strategies in the browser.

## Guest-readable routes

The `(app)` shell renders for Guests, and `RouteAccessGate` decides per route whether a session is
required: `/dashboard`, `/stocks`, `/stocks/[symbol]` and **both the collections and the detail
pages** of Lists, Strategies and Monitors are public, because built-in content is public product
content (`AGENTS.md` invariant 21) and a visitor who cannot browse it cannot discover what the
product does. `/strategies/new` and everything else goes through `RequireAuth`. The list is
`isGuestReadableRoute` in `features/auth/utils/guest-routes.ts`, with its own test. The API still
authorizes every request — a page for another customer's object reads as not found.

**A Guest is never redirected for navigating.** Reaching a protected *action* — New list, New
strategy, New monitor, a built-in Monitor's dashboard-visibility switch — opens `SignInPrompt`
where they are, offering Sign in and Create an account; `/login` is a destination they choose, not
one they are sent to. `useSignInPrompt` (`features/auth/hooks/use-sign-in-prompt.tsx`) is the one
way a page asks: it answers whether the viewer is signed in, runs the action or opens the prompt,
and hands back the element to render. Do not build a second auth modal.

A link to a protected page on a guest-readable page — "Run backtest" on a List, Strategy or
Monitor — is an `AccountActionLink` (UX-002): a real, prefilled link for a signed-in viewer, a
button that opens the prompt for a Guest, and a disabled button while the session is still
resolving. Prompt copy that more than one surface uses lives once in
`features/auth/utils/sign-in-prompts.ts` (`SIGN_IN_TO_BACKTEST`). For such an action the prompt's
`?next=` is the action's **own destination** — the prefilled New Backtest — not the page being
read (UI-042): the Guest asked to run a backtest, so signing in lands there.

**Run backtest on every entity** (UI-008). `features/backtests/components/RunBacktestLink.tsx` is
the one "Run backtest" action: a quiet secondary button in the header of every List, Strategy and
Monitor page, owned or built-in, prefilled through `features/backtests/utils/prefill.ts` with
exactly what the entity knows (a List itself, a Strategy itself, a Monitor both). Collection rows
keep their single "Open"; a stock alone is not a backtest configuration, so Stock Details offers
"Add to list" instead. A built-in's back link is its owning collection, never the Dashboard.

**Signing in comes back to the page** (UX-003). The prompt's Sign in and Create an account links
carry the current path and query as `?next=`, `RequireAuth` keeps the attempted URL the same way
when it bounces a Guest from a protected route, and the sign-in and register pages hand it on to
password sign-in, Google and each other. Every hop validates it with `safeReturnPath`
(`features/auth/utils/return-path.ts`) — see `authentication.md`, _Return destination after sign-in_.
Build these links with `signInHref(next)` / `registerHref(next)`, never by concatenating a query.

## Request failures

A failed mutation is worded by `requestFailureMessage(error, fallback)`
(`lib/api/entitlement-errors.ts`) and nothing else (UX-001). It shows the rate-limit copy for `429`
and `503 RATE_LIMIT_UNAVAILABLE`, the API's own message for an entitlement refusal and for a `400`,
and the surface's `fallback` only for a genuinely unexpected failure. A plan limit is not an outage
and a `429` is not an invitation to retry, so no surface keeps its own "try again in a moment"
translator. A surface with a domain refusal of its own handles that first and delegates the rest —
`ConfirmDialog` passes a `409` dependency refusal through before calling the translator. The same
action therefore reads the same on a collection and on a detail page. A `/billing` link, if one is
ever added, belongs to the translator's callers in one place, not to each surface.

## Failure pages

`app/not-found.tsx`, `app/(app)/error.tsx` and `app/global-error.tsx` are the product's own
not-found and error states (UX-006); `ui-system.md` (`EmptyState`) describes them. Never render an
error's message or stack. Do not add a route or flag whose purpose is to throw.

Built-in content renders through the ordinary feature pages. The response's `canEdit` decides the
presentation: a customer sees a built-in List, Strategy or Monitor read-only (the Strategy through
`StrategyReadOnlyView`, the same `LogicPreview` the Builder uses), an administrator sees the ordinary
editors, and nothing offers to delete a built-in.

## Ownership-aware collections

Lists, Strategies and Monitors each return one collection holding two kinds of thing, and each page
renders them as **two sections: the viewer's own first, the built-ins second.** They are never one
mixed table — only one of them can be edited, and only one of them counts against a plan.

`components/ui/OwnedCollection.tsx` owns that shape: `partitionByOwnership` splits the rows, and
`CollectionSection` renders one titled `SectionCard` with a `DataTable` and a `CollectionFooter`.
Each section is a component instance so it holds its own `usePagination` state — paging the
built-ins never moves the viewer's own list — and each needs its own `footerTestId`, which is what
its page-size control's `id` is built from. A Guest gets the built-in section alone; there is no
empty "Your …" section for someone who cannot own one.

An empty "Your …" section is a **compact** `EmptyState` inside its own section, not a full-page one:
a signed-in user with no monitors of their own must still see the built-ins under it, rather than a
page that claims the whole product is empty. The create action lives in the **page header in every
state** — loading, empty, error and populated — in the same place and weight (UI-030); while the
session resolves it is disabled rather than absent. The empty section explains the next step in
words ("Start with **New list** above") and repeats no button.

## Charts

For market-price and financial time-series charts, the legacy implementation establishes `lightweight-charts` as the preferred charting direction unless a future requirement demonstrates a better fit.

When it is introduced in V2:

- Keep chart-library lifecycle/integration isolated from feature/business logic.
- Split price series, technical indicators, intrinsic-value series/blends, and signal markers into focused modules rather than one large chart component.
- Keep series colors centrally configured and semantically stable.
- Price history, moving averages, intrinsic values/blends, and buy/sell/final-exit markers must remain legible together.
- Do not compute canonical valuation models in React. The chart visualizes canonical data/contracts.
- Time-series history loads from the viewport, not from a fixed range control: the chart reports
  when the window reaches unloaded history and the feature fetches the missing interval through the
  canonical API. Do not add a second stock-data fetching path in the web app, and do not let an
  arriving load move a window the user chose. See
  `../../docs/decisions/viewport-driven-stock-details-history.md`.
- Verify desktop resize and mobile touch interaction.
- Stock Details chart overlays and Strategy condition operands consume the canonical catalog in
  `../../docs/decisions/selectable-series-catalog.md`; feature components must not duplicate its
  option identities, grouping, or ordering.
- Stock Details exposes that catalog through one grouped multi-select `Indicators` control. Price
  remains the always-visible base series.

Do not add a second chart library just for convenience when Lightweight Charts can cleanly satisfy the requirement. A different library is acceptable for a materially different visualization category if justified by the task.

## Legacy-repository usage

When implementing a screen that existed in the old repository:

1. Inspect the legacy screen and its responsive behavior.
2. Identify the user-visible behavior, information hierarchy, spacing, visual tokens, and interaction model worth preserving.
3. Inspect V2 contracts and architecture before writing implementation code.
4. Rebuild the feature inside the V2 structure; do not bulk-copy the old component tree.
5. Do not preserve legacy backend coupling, duplicated types, Pages Router patterns, giant components, or obsolete product assumptions.
6. If the V2 product model conflicts with the old UI, preserve the V2 product model and adapt the visual pattern.

The goal is: a returning user should recognize FactorSage immediately, while an engineer should recognize a cleaner V2 codebase.

## Agent efficiency for frontend tasks

Frontend agents should minimize context consumption:

- Start with `AGENTS.md`, `ai/README.md`, this document, and the exact V2 feature/contracts in scope.
- Inspect only the corresponding legacy screen/components needed as a visual oracle.
- Search narrowly first and broaden only when blocked.
- Do not scan or summarize the entire old frontend before implementing one feature.
- Prefer one vertical slice per task/PR.
- During iteration run targeted web typecheck/tests; run the repository validation gate once when settled.
- For visual work, report the desktop and mobile states actually verified.

## Initial implementation sequence

Unless another product priority overrides it, the recommended first frontend vertical slices are:

1. Design foundation + application shell/navigation.
2. Stock Details using the existing `StockDetailsResponse` contract and real API data.
3. Stock Details chart/technicals/intrinsic-value overlays and responsive refinement.
4. Extend the established feature pattern to Lists, Strategies, Backtests, and Monitors.

Do not implement all legacy screens in one migration task.
