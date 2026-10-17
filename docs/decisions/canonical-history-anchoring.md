# Canonical history anchoring (CONC-01)

## Status

**Accepted** by the owner on 2026-10-17 ("First hydration must load the required history from the
canonical retention start"). Supersedes the load scope of
`caller-scoped-history-materialization.md` (decision 2, "a load target is
`[requested.from - derived warm-up, today]`") and the lazy widening that followed from it, including
`price-retention-warmup-horizon.md`'s "below the product boundary the target snaps to the retention
start" special case — every load now snaps there. Everything else in those documents (bounded reads,
the product horizon as the outer bound of what is shown, coverage, freshness, manifests) stands.

## Context

Recursive series — every EMA, Wilder's RSI, the first weekly bar — are anchored at the earliest
**stored** bar (AUD-02), so the history a calculation starts from is part of every value it
produces. With caller-scoped loads, a stock first opened in a one-year Stock Details view stored its
history from four years before that year; a thirty-year backtest later widened it, the derived state
was rebuilt from the new first bar, and values already served — to users, to backtests, to
Monitors — changed. Which client arrived first decided the numbers (found by the stock-data
concurrency suite, `docs/audits/stock-data-concurrency-2026-10-16.md`, CONC-01).

Measured on AAPL's real stored history (QA-matrix data, the fake provider serving it): a cold
2016 one-year view followed by a thirty-year read moved **every** March-2016 session's EMA 200W from
22.96 to 23.23 (1.2 %), and EMA 200D in the fifth significant digit.

## Decision

**Every load materializes the whole price-retention window — `[today − (product years + 4), today]`
— whatever window the caller reads.** `loadTarget` returns the retention target; the caller's range
is what it reads afterwards, bounded by the product horizon exactly as before.

- The first hydration, whoever triggers it (Stock Details, a backtest, a Monitor, the stock EOD
  child, the API or a worker, alone or concurrently), stores the security's whole retained history,
  so its earliest stored bar — the anchor — is the same for every caller and every order.
- A later read of any window is served from what is already there: no widening, no re-anchoring, no
  second provider request.
- PostgreSQL data is reused as before: coverage subtraction still asks the provider only for what is
  missing, and a resident or durable stock is never fetched again.

## Consequences

Measured with a one-off bench on AAPL (8,559 stored sessions over 34 years), local
PostgreSQL and Redis, fake provider serving the real rows:

| Scenario                                        | Before (caller-scoped)                                            | After (canonical)                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Cold first view of the latest year              | 2.2 s wall, 1.1 s CPU; 1 price request, 1,251 rows; Redis 1.47 MB | 7.1 s wall, 5.4 s CPU; 1 price request, 8,559 rows; Redis 4.08 MB |
| … then a thirty-year backtest read              | 7.1 s, 2 price requests                                           | 0.08 s, **0** requests                                            |
| Cold view of a 2016 year, then thirty years     | 4.9 s + 7.6 s, 3 requests                                         | 7.3 s + 0.07 s, 1 request                                         |
| Warm repeat of a view                           | 12–16 ms                                                          | 11 ms                                                             |
| Values served for March 2016 after the sequence | differ from a canonical load (22 of 22 sessions)                  | identical                                                         |

- **Provider requests never increase**: the first read is one request either way; every later deep
  read needs none. Payload per first read grows (34 years of daily bars, about 8.5 k rows).
- **First-touch latency** of a never-seen security grows by about five seconds, almost all of it
  PostgreSQL: writing 8.5 k derived rows (≈ 4.0 s of 7.6 s), reading them back for publication
  (≈ 1.3 s), statements (≈ 1.1 s, unchanged) and prices (≈ 1.0 s). It is paid once per security per
  environment; the monitored universe and every backtested security already paid it.
- **Redis memory** per resident security is the full history (≈ 4 MiB), which the capacity sizing
  (`ai/architecture/production-capacity.md`, 4.64 MiB per security) already assumed.
- **Securities hydrated narrowly before this change** are widened once on their next read (one
  request for the missing prefix) and their derived state is rebuilt from the earlier anchor: their
  values move once. Shipping this with the release's r8 rebuild means production pays that rebuild
  once, together with r8.
- **Not changed:** the anchor still moves when an earlier bar genuinely arrives (a provider extending
  its history), and two environments hydrated on different dates anchor at their own retention
  starts — the retention window, not the first caller, decides.

## Rejected

- **Persist prices for the whole window but keep derived state and Redis caller-scoped.** Correct in
  principle (the calculation already reads from the earliest persisted bar), but it splits one load
  target into three inside the hydration and its generation fencing — a broader change for a saving
  that only applies to never-seen securities.
- **A revision bump that rebuilds every security on deploy.** Unnecessary: the r8 rebuild ships in
  the same release.
