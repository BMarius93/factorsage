# Monitor EOD V2 — mandatory application-wide intraday price audit

**Status:** IMPLEMENTATION BLOCKER / preliminary source inventory, 2026-10-14  
**Scope:** all product use of **real-time market prices / intraday quotes / provisional same-session EOD bars**, not merely the Monitor. This document is an evidence-backed starting inventory, **not** a claim that an exhaustive static/runtime call graph has already been completed. The implementation auditor must complete it and record verified zero-use evidence before removing the old paths.

Reference proposal: `docs/decisions/monitor-eod-v2-proposal.md`. Reference audit: owner-supplied Claude read-only audit, verdict READY WITH CHANGES.

## 1. Non-negotiable EOD-only policy

**FactorSage must not use real-time or provisional intraday prices for customer-facing market prices, Strategy evaluation, Monitor Signals, technicals, valuation ratios, intrinsic value, Stock Details, Backtests or Dashboard.**

- The latest eligible market-price bar is the newest **verified finalized exchange session**. Merely having a row dated today (even from an `historical-price-eod/full` endpoint) **does not** establish finality.
- Before EOD finalization, serve the last verified completed session and show its actual `asOf` session. Do not substitute a provisional price or call it the current/live EOD close.
- EOD finality is controlled by a canonical stock `(security, session)` readiness invariant using the exchange calendar and provider refresh watermark: a bar for S exists, and the verified successful tail read was **after** the accepted close + publication delay; defer unknown/not-yet-published S. Account for split/corporate-action generations and corrections.
- For the same security/session/basis, derived indicators and valuation series must only use finalized canonical prices; avoid publishing partial-session-derived state as final.
- Existing historical sessions remain available. Do not delete old DailyPrice rows, backtest results, historical evidence or underlying data wholesale. Remediate/replace affected provisional **tail** rows and ensure consumers cannot read them as final; audit price-basis and derived-materialization invalidation.
- User activity, auth/session, WebSocket transport, Stripe, FMP's real-provider *test/hydration harness*, financial-disclosure/alternative-data ingestion, and process scheduling are **not** "real-time market quotes". Do not delete them based on keyword search. Keep PIT disclosure availability correct; EOD-only does not mean freezing unrelated datasets to once daily.

## 2. Verified source entry points and affected consumers

Classification: **REMOVE AFTER REPLACEMENT**, **MIGRATE TO FINALIZED EOD**, or **VERIFY**. These are file/function search findings; a full call graph and runtime/network proof are still required.

| Area | Existing source / consumer | Issue and EOD action | Class |
| --- | --- | --- | --- |
| FMP quote endpoint | `packages/fmp/src/client.ts` — `FmpClient.getCurrentQuotes`, `batch-quote`, `FMP_QUOTE_MAX_SYMBOLS_PER_REQUEST` | Direct real-time/last-price request path. After all consumers migrate, remove unsupported path/unused constant and related quote-only tests. Verify no other production user first. | REMOVE AFTER REPLACEMENT |
| Quote contracts and mapping | `packages/fmp/src/mapping.ts` — `FmpCurrentQuoteProviderPort`, `FmpCurrentQuote` mappings/types; `packages/domain/src/stock-data.ts` and `packages/stock-data` quote-only types | Remove now-unused real-time market interfaces once all call sites have EOD equivalents. Retain unrelated EOD and provider ports. | REMOVE AFTER REPLACEMENT |
| Canonical stock quote adapter | `packages/stock-data/src/service.ts` — `getCurrentObservations` | Calls FMP quote port, emits `CURRENT_QUOTE` / `MONITOR_CURRENT_DATA`; replace with provider-free read of finalized EOD session data for Monitor. | REMOVE AFTER REPLACEMENT |
| Monitor worker data port | `apps/worker/src/monitor/composition.ts` — `PrismaMonitorDataLoader.getCurrentObservations` | Replace with finalized EOD frame reader and session checkpoint protocol; bulk refresh belongs to stock-eod child, not this evaluator. | MIGRATE TO FINALIZED EOD |
| Monitor scan and quote interpretation | `apps/worker/src/monitor/monitor-cycle.ts` — `getCurrentObservations`, `resolveObservation`, quote age, exchange-session quote resolution, `loadSymbolSnapshot`; `apps/worker/src/monitor/level-decision.ts` | Remove 5-minute provisional-quote evaluation; consume finalized EOD prices in chronological sessions, never synthesize false resolutions on missing EOD data. | MIGRATE TO FINALIZED EOD |
| Monitor provisional frame | `packages/stock-data/src/monitor-frame.ts` — `projectMonitorEvaluationFrame`; `packages/stock-data/src/service.ts` — `readMonitorEvaluationFrame`, `prepareMonitorEvaluationData` | Builds a synthetic/provisional observation from quote, carries previous closed derived state and special quote split hold. Replace with canonical finalized daily evaluation frame and existing reducer. After migration remove unused quote-only projector/reasons/tests. | REMOVE AFTER REPLACEMENT |
| Monitor quote settings | `packages/config/src/index.ts`, `.env.example` — `MONITOR_QUOTE_MAX_AGE_MS` (`345600000`) and quote-derived configuration | Remove with quote path; preserve monitor concurrency, retry, EOD publication and FMP EOD parameters. | REMOVE AFTER REPLACEMENT |
| EOD endpoint can still be intraday | `packages/fmp/src/client.ts` — `historical-price-eod/full`; `packages/stock-data/src/service.ts` — `ensureStockFresh`, `isPriceFreshnessStale` (~6h), `loadTarget`/UTC `today()`, `refreshPriceWithinLease`, `saveDailyPriceSync`, `unsettledTailStart` | FMP exposes an in-progress same-day bar through the *EOD* API. Current sync may persist that bar and derived values before market close; subsequent reads may treat them as latest. Introduce shared finalized-session watermark gating and safe tail repair; do not assume changing FMP endpoint name solves it. | MIGRATE TO FINALIZED EOD |
| Canonical price and derived read APIs | `packages/stock-data/src/service.ts` — `getDailyPrices`, `getDailyDerivedState`, `getDailyTechnicals`, `getDailyEvaluationFrame`, intrinsic and valuation-ratio read methods | Audit all default/explicit `to=today` bounds and whether provisional canonical rows leak. Clamp the **observable** window to latest finalized verified per-security/session, with consistent basis/watermark policy; retain historical ranges. | MIGRATE TO FINALIZED EOD |
| Stock Details API and frontend | `apps/api/src/stocks/stocks.controller.ts`, `apps/api/src/stocks/logged-stock-data.service.ts`; `apps/web/src/features/stocks/details/components/StockDetails.tsx`, `StockHeader.tsx`, `apps/web/src/features/stocks/details/utils/price-summary.ts` | Chart, latest close/change/high/low, technicals and valuation snapshots can currently consume a stored provisional current-day bar. UI currently labels close as `At close · End-of-day data`; ensure those labels are backed by verified final bars and as-of dates. Audit incremental history endpoints as well as composite details. | MIGRATE TO FINALIZED EOD |
| Backtests ending today | `apps/api` Backtest submission/date validation; `apps/worker/src/backtest/backtest-processor.ts`; `packages/stock-data/src/service.ts` — `getDailyEvaluationFrame`; `packages/strategy/src/backtest/*` | A user can request a period ending today. The data loader may serve today's in-progress bar, producing a misleading immutable run. Enforce an explicit rule: reject/adjust only the latest *unfinalized* requested session (with clear user/API behavior), use latest completed session, and preserve immutable old results. Audit benchmark/stock session alignment. | MIGRATE TO FINALIZED EOD |
| Dashboard & built-in Monitors | `apps/api/src/dashboard/*`, `apps/web/src/features/dashboard/components/DashboardPage.tsx`, `apps/api/src/monitors/*`, `apps/web/src/features/monitors/*` | Dashboard reads Monitor persisted state and reasons derived from newest Strategy; state comes from provisional quote evaluation. Replace with EOD transition Activity feed and truthful versioned evidence, migrate legacy quote origin. | MIGRATE TO FINALIZED EOD |
| Existing Market Overview ETFs | `apps/worker/src/market-data/*`, `apps/api/src/market/*`, `packages/stock-data/src/market-data-refresh.ts` | Has close + publication delay and post-final refresh watermark. **Preserve and reuse**; verify the overview/sector endpoints never expose a provisional ETF bar or a false fresh day, and same-session ETF conditions gate evaluation. | VERIFY |
| Other data sources/market surfaces | Stock price history API families, strategy valuation & intrinsic read paths, historical chart/price summary selectors, list and backtest previews, exports, any future consumer of `DailyPrice` | Exhaustively search direct and indirect market-price consumers. A stored `DailyPrice` can leak a provisional row even without ever calling `getCurrentQuotes`. | VERIFY |
| QA / capacity / fixture infrastructure | `apps/worker/src/monitor/capacity-bench.ts`, `data-correctness-scan.ts`, Monitor integration fixtures, FMP quote tests, `apps/api/src/e2e-stack/fake-fmp.ts`, `apps/api/src/fmp-live/*`, contract/OpenAPI and architecture docs | Adapt quote-specific tests/fixtures/benchmarks to completed EOD sessions, including synthetic price publication and missing bars. Do not delete legitimate real-FMP EOD hydration/audit tooling merely because it says "live". | MIGRATE / VERIFY |

## 3. Evidence for the two independent intraday leak mechanisms

### A. Direct quote calls
- `packages/fmp/src/client.ts` invokes the `batch-quote` endpoint in `getCurrentQuotes`.
- `packages/stock-data/src/service.ts` (`getCurrentObservations`) invokes that quote method for all watched symbols.
- `apps/worker/src/monitor/monitor-cycle.ts` obtains `CurrentObservation` and builds a provisional `readMonitorEvaluationFrame` through `monitor-frame.ts`.

### B. Provisional rows from the historical EOD endpoint
- `ai/architecture/deep-discovery.md` §3 records a live-verified same-session incomplete bar returned by `historical-price-eod/full` before market close.
- `packages/stock-data/src/service.ts` `isPriceFreshnessStale` uses time since last refresh (default 6 hours), not session finality; `today()` uses a UTC date string. `saveDailyPriceSync` may save a same-session row and its derived state; `unsettledTailStart` deliberately re-reads the tail later because it knows it can contain provisional data.
- `ai/product/stock-details.md` and `packages/contracts/src/stock-data.ts` explicitly acknowledge the newest stored EOD row can be in progress, despite StockHeader labelling it at-close data.
- Backtest history frames and Stock Details read from the same canonical prices and derived state. No direct quote API invocation is necessary for provisional data to reach those surfaces.

**Required remediation:** change ingestion/readiness **and** all downstream read-model boundaries. Ideally the storage separates accepted/finalized from still-provisional data; minimally persist/query a robust session watermark and prevent any consumer from exposing an unfinalized row. Rethink default "today" for product-range and Backtest submission. Do not silently drop a real trading session once it is finalized.

## 4. Mandatory exhaustive follow-up audit (not yet proven)

The implementing engineer must build a verified call-site and network inventory across the **whole monorepo**, including:

1. Search all production TypeScript, API routes, web hooks/components, worker compositions, ports/contracts, FMP paths and Prisma reads for: `getCurrentQuotes`, `batch-quote`, `getCurrentObservations`, `CurrentObservation`, `projectMonitorEvaluationFrame`, `quote`, `intraday`, `provisional`, `latest`, `today()`, `DailyPrice` and `getDailyEvaluationFrame`. Follow transitive consumers and distinguish market-price code from unrelated strings.
2. Inventory every path capable of issuing provider requests **during trading hours** and every path capable of **reading a provisional stored same-day bar** without FMP calls. Include CLI scripts and initial hydration.
3. For each path record entrypoint → data service → provider or PostgreSQL/Redis → API contract → UI; classify KEEP, MIGRATE, DELETE and why.
4. Check any use of live market price in derived weekly data, indicators, valuation ratios, fundamental metrics, intrinsic values, comparison charts, backtest calculations and historical replay. Preserve PIT correctness.
5. Produce a final migration/removal manifest with exact file+symbol names, which replacement was installed, and test proof that no production **market-price quote** path remains.
6. After replacement, remove dead quote FMP APIs/ports/mapping/types/configs and quote-specific scenarios, adjust all tests/docs/guards, and prove the route cannot be reached in production. Do not remove unrelated scheduled updates or real-provider EOD test capabilities.

## 5. EOD-only acceptance gate

Implementation **cannot be called complete** until all are true:

- [ ] No production `batch-quote` or equivalent real-time quote endpoint is used or left wired for market pricing. Any intentionally retained provider quote capability must be individually justified and explicitly approved; the target is zero.
- [ ] Before finalization, a stock's customer-visible latest close/date is the **previous verified finalized session**; no in-progress high/low/volume/derived readings leak as EOD.
- [ ] All Stock Details chart/header/technicals/intrinsic/valuation API endpoints and Backtests use only verified finalized sessions, including requested `to=today`.
- [ ] Stock EOD refresh, ETF readiness and Monitor evaluation agree on the same target session, basis and finalized inputs, with per-security partial coverage and retry.
- [ ] A newly observed EOD transition is emitted once. Missing data never changes a lifecycle; skipped sessions are caught up sequentially.
- [ ] Full test matrix: before close, inside delay, provider publication missing/late, immediately after real publication, weekends/holidays/early close/DST, Redis cold/warm/LRU eviction, correction/re-base, fundamental/alternative-data unavailable, overlapping Monitors, quote endpoint prohibited.
- [ ] Historical V1 live-quote Signal occurrences are explicitly distinguished from new `EOD_CLOSE` occurrences; immutable old backtest results are not silently rewritten.
- [ ] Provider request counters prove EOD provider usage is bounded and the real-time endpoint receives **zero** calls during full E2E / production-like harness.
- [ ] The documentation and accepted methodology statements accurately describe finalized EOD, no remaining "Monitor live quote" claims in current canonical docs (historical audit logs may still describe the old version).
- [ ] An auditor signs off with a path-by-path inventory, including tests and grep/runtime evidence; do not substitute absence of the word "quote" for functional proof.

## 6. Caution on removal order

**First** enforce EOD finality at the canonical price-data boundary, **then** migrate current consumers, **then** remove quote-only code and tests. A broad search-and-delete of quote symbols is dangerous: it can erase important fallback, QA and provider-code correctness paths, and leaves the more serious `historical-price-eod/full` in-progress-bar leak untouched.
