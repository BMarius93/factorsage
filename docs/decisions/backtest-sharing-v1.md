# Backtest Sharing V1

## Status

**Accepted — 2026-10-22 (owner).** An owner may publish the **results** of one completed backtest
behind an unguessable public link. Recipients — signed in or not, on any plan — read a read-only
report with the interactive chart, the eight KPI tiles, the annual returns and the general
simulation parameters. The stock list's securities, the trades and the owner stay private.
Sharing presents results; it never publishes, clones or transfers a strategy.

**Amended — 2026-10-26 (owner): definitions on the report** (`canonical-definitions-v1.md`). A new
link also records the canonical definitions of the run's Strategy and List, their provenance and
their generated descriptions. The report always says where each comes from — built-in, custom,
derived, or not recorded — and carries a description when the publication rule allows: an official
non-premium built-in's always, the owner's own only when the owner opts in, a premium built-in
Strategy's rules never. Links created before this amendment keep their report exactly as it was.

Out of scope for V1: public strategy or list publishing, cloning or copying a shared run's
configuration, social profiles, comments or likes, view analytics, any public directory or search
of shared runs, external image storage, and any change to plans, prices or entitlements.

## 1. The link

- **One active link per run**, owned by the run's owner. `BacktestShare` is keyed by `runId`, so a
  second active link is unrepresentable rather than refused.
- **Token**: 32 bytes from `crypto.randomBytes`, unpadded base64url — 43 characters of
  `[A-Za-z0-9_-]`, 256 bits. It contains no database identifier. A path segment that is not of that
  shape is answered `404` before any query (`isBacktestShareToken`).
- **Stored as issued**, not hashed. It is not a credential to an account: it reads only the
  allowlisted report its owner chose to publish, and the owner must be able to copy the same link
  again. A hashed token could not be shown twice.
- **Revocation deletes the row.** The token stops resolving on the next request — page, API and
  preview image alike — and can never be revived. Sharing again inserts a new row with a new token;
  the old one matches nothing, forever.
- **Only a completed run** with a stored summary can be shared (`409` otherwise). There is no
  entitlement on sharing: every plan that has a completed run may share it, including a downgraded
  account whose run no longer fits its plan.
- The public URL is `${WEB_BASE_URL}/share/{token}`, built by the API from the deployment's web
  origin exactly as emailed links are, never from a request's `Host`.

## 2. Routes

| Route                                     | Who                 | Policy              | What                                       |
| ----------------------------------------- | ------------------- | ------------------- | ------------------------------------------ |
| `GET /backtests/{runId}/share`            | owner (cookie)      | `standard-read`     | `{ shared, url, sharedAt }`                |
| `PUT /backtests/{runId}/share`            | owner (cookie)      | `mutation`          | create, or return the active link (idem.)  |
| `DELETE /backtests/{runId}/share`         | owner (cookie)      | `mutation`          | revoke; `204`; idempotent                  |
| `GET /shared-backtests/{token}`           | anyone, no guard    | `public-share-read` | the allowlisted report                     |
| `GET /shared-backtests/{token}/preview`   | anyone, no guard    | `public-share-read` | the link-preview card's data               |
| `GET /share/{token}` (web)                | anyone              | —                   | the public page, server-rendered           |
| `GET /share/{token}/preview.png` (web)    | anyone              | —                   | the 1200 × 630 Open Graph image            |

Owner routes sit on the existing `BacktestsController`, behind `CookieAuthGuard`, scoped by the
authenticated user id: another user's run answers `404` exactly like a run that does not exist, and
there is no ADMIN bypass. The public routes carry **no guard**: they never ask who is reading, so no
session, plan or Terms acceptance can change the answer — a Starter reader opens a Pro run beyond
every Starter limit. The Terms gate never applies to a request without a resolved session.

A malformed, unknown or revoked token and a run without a result are one indistinguishable `404`
with one message, in the API, the page and the image.

## 3. The public contract

`SharedBacktestReportResponse` (`@intrinsic/contracts`, `backtest-sharing.ts`) is a contract of its
own, never a filtered `BacktestRunDetailResponse`. It carries:

- `runNumber` — the run's per-user sequential Run ID, rendered `Run #0084` by `backtestRunLabel`
  exactly as on its owner's page, so a report can be quoted back precisely. The run's UUID never
  crosses the public link; no database identity does.
- `url`, `completedAt`.
- `configuration` — period, initial capital, monthly contribution, `maximumPositions`, the derived
  full-position percentage, the benchmark's catalog `code` and product `name` (never its id, series
  or provider symbol), `securityCount` and `strategyRuleCount`.
- `result.summary` — `SHARED_BACKTEST_SUMMARY_FIELDS`, an explicit allowlist of run-level
  aggregates: first/last simulated date, final value, net profit, portfolio and benchmark returns,
  excess return, both CAGRs, both maximum drawdowns, total trades.
- `result.annualReturns` — the owner page's own per-year figures: the Strategy's and, over the same
  window, the benchmark's (null where the benchmark cannot be measured), which is what the Strategy
  vs benchmark heatmap draws.
- `result.curve` — the owner page's own chart projection, point for point.
- `definitions` (optional; links created since 2026-10-26) — for the Strategy and the List, each
  `{ origin, builtInName?, description }`: the origin (`built_in | custom | derived | unknown`), the
  official name of the built-in it is or was derived from, and either the published `short` and
  `detailed` description or `{ status: "withheld", reason: "owner" | "premium" }`
  (`canonical-definitions-v1.md` §7 has the publication rule).

Never present: the canonical definition documents themselves; a customer's name for their strategy
or list; strategy or list ids or versions; rules, metrics, operators or thresholds **except** in a
description the publication rule allows; list members; any symbol or security name; trades, the
trade log, positions, holdings, entry or exit dates, signals; the methodology record; the
ETF-condition diagnostics and stock-sector assignments (they name the ETFs a strategy reads and the
stocks it holds); failure detail; the owner. The API's integration tests pin the exact key sets and
search the served bytes for every private value, with descriptions withheld and published; adding a
field to the allowlist is a deliberate, test-visible act.

**Counts come from the frozen run.** `securityCount` is the snapshot's resolved securities, as the
owner's "Stocks" fact is. `strategyRuleCount` is `strategyRuleCount()` over the snapshot's
definition projected through `withCanonicalStrategyDefinition`: every Condition and every Trigger
across all BUY levels, SELL levels and FINAL EXIT Exit Rules — the lines a user writes in the
Builder. Editing or deleting the strategy or list afterwards changes neither.

**Figures are never recalculated.** The summary is the stored `BacktestRunSummary` through the
owner page's `resultSummaryOf` (benchmark CAGR derived at read, as for the owner); the curve is the
same `downsampleCurve` over the same persisted daily equity; annual returns are the same
`backtestAnnualReturns` chaining. The funded benchmark scenario — contributions buying benchmark
shares at each date's price — is the stored `benchmarkValue`, so monthly-contribution semantics
are the owner's exactly.

## 4. The public page

`/share/[token]` lives in the `(app)` shell and is guest-readable (`isGuestReadableRoute`). The page
is a server component: it reads the report once per request (`cache: "no-store"`, React `cache()`
shared with `generateMetadata`) from the public API with **no cookie forwarded**, and renders it
with the owner page's own components: the header titled by the Run ID (`Run #0084`) with a
`Shared backtest report · period · Benchmark` line; `BacktestResultOverview` — the chart
(Lightweight Charts, fully interactive once hydrated) and the eight KPI tiles side by side from
1,280px, stacked below it, exactly the owner's 70/30 overview; `BacktestAnnualReturns`, the Strategy
vs benchmark heatmap; `DisclosureNote`; and a `FactGrid` of the simulation settings and counts. Only
the allowlisted data is serialized into the RSC payload, so nothing private can reach the HTML.

When the link recorded definitions, a **Strategy and list** section follows the results: each is
titled `Strategy — <official name>` for a built-in and `Strategy` otherwise, with its provenance
line (`Built-in · Official FactorSage Strategy`, `Custom`, `Derived from <built-in>`,
`Origin not recorded`) and the published description, or a plain sentence saying it is withheld.
The intro stops calling the rules private once their description is published.

What the owner's page adds has no counterpart: no customer names for the strategy or list, no links
to them, no "Edit and run again", no Share, no run configuration provenance, no trade log, no locked
or teased section and no upgrade offer. The page says it is a shared, read-only report. Its one action is **Create your own
backtest**: a Guest goes to `/register?next=/backtests/new`, a signed-in reader to `/backtests/new`.
An unknown or revoked link renders a `404` not-found state that names no backtest.

## 5. Link previews

`generateMetadata` emits `og:title`, `og:description`, `og:image` (1200 × 630 PNG with its alt
text), `og:type=website`, `og:url`, `og:site_name`, `twitter:card=summary_large_image` and
`robots: noindex, nofollow` — a shared link is something a person was sent, not a page to list.

- Title: `18.4% Annualized vs 10.2% SPY | FactorSage` — the stored CAGRs to one decimal; total
  returns when the run is too short to annualize; the run's own figure alone when there is no
  benchmark figure. The benchmark is named by its product name (`SPY`).
- Description: `26-year backtest · 750 securities · 12 strategy rules`. Years are
  `backtestPeriodYears`, the product's one definition of a period's years; under a year, months.

Next.js streams `generateMetadata` into the body for user agents outside its own list. Every user
agent is therefore served blocking metadata (`htmlLimitedBots` in `next.config.ts`,
`src/lib/link-previews.ts`), so any crawler that reads only `<head>` sees the tags without running
JavaScript. Every other route's metadata is static, so this costs nothing elsewhere.

## 6. The preview image

`/share/{token}/preview.png` is a Next.js route handler (Node runtime) rendering `ImageResponse` from
`next/og`: FactorSage wordmark, the annualized return (largest), the benchmark's beside it, a compact
Strategy-versus-benchmark curve, then maximum drawdown, securities, strategy rules, the period, and
"Hypothetical historical results" — the first sentence of the product's backtest disclosure. Palette
and typeface are the product's own: the chart theme's Strategy blue and benchmark grey, Geist (read
from the pinned `geist` package's TTFs, since the renderer cannot fetch fonts).

- **Data**: `GET /shared-backtests/{token}/preview` — the stored headline figures and two columns of
  the persisted daily equity (`totalValue`, `benchmarkValue`), thinned by
  `sampleSharedBacktestPreview` to at most 600 points. Endpoints are kept, and the days between are
  cut into equal buckets in which the highest and lowest value of **each** line survive, so a sharp
  drawdown is drawn as a drawdown. Deterministic. Drawing only — no figure is computed from it.
- **Authorization on every request**: the route asks the API before anything else; a revoked or
  unknown token is `404` (`no-store`) and nothing is rendered.
- **Caching**: rendered bytes live in a small process-local LRU (64 images) keyed by a digest of
  the design version and the data drawn — never by the token, so a re-shared run reuses its picture
  and a design change (`PREVIEW_DESIGN_VERSION`) redraws them all. The digest is the `ETag`;
  responses are `Cache-Control: public, no-cache`, so any cache must revalidate with FactorSage
  before each use — which is where revocation is enforced — and an unchanged picture revalidates
  with a `304` and no render. Nothing is stored in PostgreSQL, Redis or object storage, and no image
  data or coordinates travel in the link.
- **Third-party copies**: WhatsApp, Slack, LinkedIn and the rest keep their own copy of a preview
  once they have fetched it. That copy is outside FactorSage and survives a revocation; the owner is
  told so when they stop sharing.

## 7. Abuse, caching and logs

- `public-share-read` is IP-keyed, fails open, and is sized for one fact: the web server renders the
  page and the image itself, so most public reads arrive from the **web tier's** address. The
  bucket therefore bounds the whole tier's public reads. Guessing is not what it protects against —
  256-bit tokens do that.
- The API serves both public routes `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
  The page itself is dynamic and uncached, so a revocation takes effect on the next request.
- A token in a URL is a working link, so it is kept out of logs: the API's request log writes
  `/shared-backtests/:token` (`loggablePath`), rate-limit and Terms events already log the route
  template, and `next dev` drops `/share/{token}` requests from its log
  (`TOKEN_BEARING_PATH_PREFIXES`). Sharing events (`backtest.share.enabled`, `.revoked`) carry the
  actor and run, never the token. Error messages never contain it.
- A public view reads the share row, the run's snapshot, summary and daily equity. It never reads a
  trade, a position, a stock history, a user row or the provider, never starts or queues a run, and
  consumes no execution slot. The E2E suite asserts the fixture FMP journal is unchanged.

## 8. Data model

Migration `20261023090000_backtest_share` adds one table:

```text
BacktestShare(runId PK -> BacktestRun ON DELETE CASCADE, token UNIQUE, createdAt)
```

It references the frozen run; no existing row or column changes, and the run's `updatedAt` is
untouched by sharing. Deleting a user or a run deletes its share.

Migration `20261026090000_definition_provenance_and_share_definitions` adds `definitions JSONB`,
`descriptions JSONB` (both or neither, by CHECK) and `publishDescriptions BOOLEAN DEFAULT false`,
written in the same statement that creates a link (`canonical-definitions-v1.md` §7). The owner's
`PUT` takes an optional `{ publishDescriptions }`; without one an existing link keeps its setting.

## 9. Known V1 limitations

- A script that hammers a valid link through the web page spends the web tier's
  `public-share-read` allowance for every shared link until the window resets — a capacity failure
  confined to shared pages, never a data exposure.
- Previews already fetched by third-party platforms outlive a revocation.
- Runs completed before the funded benchmark scenario existed have no benchmark line in the chart or
  the image, exactly as on the owner's page.
- The shared page keeps the product shell, so a signed-in reader who has not accepted the current
  Terms sees the acceptance screen there, as on every product route; the API answers them anyway.

## Alternatives rejected

- **Columns on `BacktestRun`** (`shareToken`, `sharedAt`): mutates the run row and its `updatedAt`
  for something that is not part of the result.
- **A history table with a partial unique index** on active shares: Prisma cannot express a partial
  index, so the migration-drift check would fail; deleting the row gives the same guarantee.
- **Hashing the token**: the owner could not copy the link again.
- **Filtering `BacktestRunDetailResponse`**: a field added to the private detail would leak by
  default. The allowlist leaks nothing by default.
- **Client-side fetching of the report**: crawlers would see no metadata, and every view would cost
  a second request.
- **Storing the PNG** (PostgreSQL, Redis, object storage) or embedding it in the link: the image is
  cheap to render, deterministic, and cached by content.
