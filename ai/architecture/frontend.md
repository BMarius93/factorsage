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
- Rounded cards and controls, generally softer than default browser UI. Large product cards may use radii around 24-28px; controls and nested surfaces should use smaller radii.
- Shadows must remain subtle. Do not turn the product into a heavily elevated/card-stacked dashboard.
- Information density should remain appropriate for financial research: compact enough for tables and metrics, but with clear spacing and hierarchy.

Use the design tokens in `apps/web/src/styles/tokens.css`. Do not scatter new hard-coded brand colors through feature components when an existing semantic token fits.

## Typography

Use Geist as the primary UI font and Geist Mono where monospaced financial/technical content is useful.

Typography should remain neutral and functional:

- Page titles and section titles: compact, semibold, slightly tight tracking where appropriate.
- Labels: small, semibold, often uppercase with restrained tracking.
- Body text: readable at approximately 14-15px for dense product screens.
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
- Dense desktop tables may become cards/stacked rows on mobile when that materially improves readability and actions.
- Charts must resize to the container and remain usable by touch. Tooltips, legends, selectors, and overlays must not assume mouse hover.
- Page padding should scale progressively with viewport size rather than jumping from cramped mobile to oversized desktop spacing.
- Fixed mobile UI must respect `env(safe-area-inset-bottom)`.
- Avoid content hidden behind fixed bottom navigation; reserve sufficient bottom padding on small screens.

As a baseline, consider behavior at roughly phone, tablet/small desktop, and large desktop widths. Use content-driven breakpoints rather than copying legacy breakpoint values mechanically.

The application shell establishes the baseline breakpoints. Reuse them unless a
feature's own content demands a different switch point:

- `600px` — tablet padding and the fuller brand treatment.
- `880px` — persistent topbar navigation replaces the fixed bottom navigation,
  and content moves to desktop padding.
- `1280px` — wide desktop padding.

## Frontend structure

Use App Router for routing and composition. Do not introduce Pages Router in V2.

Preferred direction:

```text
apps/web/src/
  app/                    # routes, layouts, route-level loading/error composition
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

## Charts

For market-price and financial time-series charts, the legacy implementation establishes `lightweight-charts` as the preferred charting direction unless a future requirement demonstrates a better fit.

When it is introduced in V2:

- Keep chart-library lifecycle/integration isolated from feature/business logic.
- Split price series, technical indicators, intrinsic-value series/blends, and signal markers into focused modules rather than one large chart component.
- Keep series colors centrally configured and semantically stable.
- Price history, moving averages, intrinsic values/blends, and buy/sell/final-exit markers must remain legible together.
- Do not compute canonical valuation models in React. The chart visualizes canonical data/contracts.
- Verify desktop resize and mobile touch interaction.

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
