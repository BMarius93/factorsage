# Rewrite Plan

## M0 — Foundation
Repository structure, pnpm, Docker infrastructure, strict TypeScript, CI, documentation.

## M1 — Pure core
Port and characterize reusable `runtime-core` logic and intrinsic-value formula functions.

## M2 — Database + FMP
Unify Prisma ownership, design repositories, build the FMP adapter.

## M3 — Stock Details
First full vertical slice from browser to API to DB/FMP to valuation and back.

## M4 — Auth + Lists
Static lists and per-symbol FULL/CUSTOM buy windows.

## M5 — Strategies
Versioned strategy contracts and reusable evaluation.

## M6 — Backtests
Durable jobs, dedicated worker, immutable snapshots, result persistence.

## M7 — Monitors
Reuse canonical strategy evaluation for current-data scans.

## M8 — Entitlements + Billing
Central product entitlements first; Stripe as billing integration second.

## M9 — Admin
Operational/admin surfaces.

## M10 — Regression and retirement
Port the high-value Playwright suite and retire the old repository after behavioral parity is proven.
