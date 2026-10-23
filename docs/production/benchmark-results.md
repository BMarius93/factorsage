# Benchmark results

Measured 2026-10-23 on the cloud development container (4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, no
swap, network block storage; PostgreSQL 16.15 and Redis 7.0.15 on the same machine). How each number
was produced, and what is real and what is synthetic, is `benchmarks.md`; the raw reports are in
`benchmark-results/` and every table here is a projection of them
(`tsx src/backtest-benchmark/summarize-results.ts`).

**Everything below ran against the synthetic provider and synthetic 34-year histories**, except the
one real-FMP sample in §5. Provider-miss timings are FactorSage's own miss path against a provider
that answers instantly unless stated; they are not FMP's latency, rate limit or quota behaviour.

## 1. Stock cache tiers at `STOCK_LRU_MAX_SECURITIES=500`

735 protected (canonical-universe) securities and 1,029 ordinary ones, every one with a complete
stored history. Raw reports: `benchmark-results/lru/`.

| Check                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LRU-500 model check (sequential, from an empty LRU: fill, overflow, re-reads, re-admissions, protected reads between) | 1,392 reads (1,039 LRU, 353 protected); LRU 0 → 500, **536 evictions**; after every read the LRU equals a reference count-bounded LRU **in membership and order** (0 deviations); every evicted security gone whole (0 leftover keys); every read equal to PostgreSQL's rows; never above 500; protected digest unchanged; 0 provider requests. Cold LRU read (rebuilt from PostgreSQL) median **1.86 s**, p95 2.19 s, max 3.68 s; warm LRU read 3 ms; protected read median 3 ms, p95 5 ms |
| Concurrent readers at 500 (6 processes × 120 random reads, 71 % LRU / 29 % protected)                                 | 720 reads, 257 cold, **0 mismatches against PostgreSQL**, 0 errors; read p50 11 ms, p95 4.2 s (cold rebuilds under six-way contention), max 5.9 s; LRU never above 500 across 29,758 samples; nothing left behind by any eviction; protected digest unchanged                                                                                                                                                                                                                               |
| Capacity lowered to 400 under concurrent access (forced eviction)                                                     | the first touch evicted 100 members in **21 ms**, 0 of their keys left; 360 further reads with the LRU never above 400; audit clean                                                                                                                                                                                                                                                                                                                                                         |
| Promotion of an LRU member to protected, and demotion back                                                            | left the LRU with all 72 keys and their bytes unchanged and no TTL; reconciled back, it rejoined as the newest LRU member within capacity, bytes unchanged                                                                                                                                                                                                                                                                                                                                  |
| Protected tier rebuilt from PostgreSQL alone (`protect --concurrency 4`)                                              | 733 published + 2 already resident in **973 s** (16.2 min); 0 provider requests; tier 770 MB (mean 1.05 MB per security, p95 1.19 MB)                                                                                                                                                                                                                                                                                                                                                       |
| Protected residency                                                                                                   | 735 designated, 735 READY, 52,920 keys, **0 keys with a TTL**, 0 orphans, 0 dual residency, 0 violations                                                                                                                                                                                                                                                                                                                                                                                    |
| Redis restart (`SHUTDOWN SAVE`, restart, load ~1.2 GB)                                                                | **15.5 s** until it served again; protected digest identical; 52,920 keys; LRU 400/400 READY; audit clean                                                                                                                                                                                                                                                                                                                                                                                   |
| Redis loss (`FLUSHDB` of the benchmark database), then `protect`                                                      | 735 published from PostgreSQL alone in **875 s** (14.6 min), 0 provider requests, 770 MB; every price and daily-state chunk of the sample **byte-identical** to before the loss (manifests differ only by their publication time); 52,920 keys, 0 with a TTL, audit clean; the LRU starts empty and fills on reads                                                                                                                                                                          |

Redis memory: the synthetic histories cost 1.05 MB per security (34 full years); the real S&P 500
point-in-time universe measured 0.74 MB per security (`docs/decisions/protected-stock-tier-v1.md`).
With both tiers full — 735 protected and 500 LRU securities — `used_memory` was **1.30 GB**.

## 2. LRU contention: a run with more ordinary securities than the LRU holds

Pro+ × 1,000 ordinary securities (no canonical-universe member), one year (two calendar-year
windows), four workers, warm cache, LRU 500 (`F-ordinary-1y-*`).

| Frame read                            | Preparation | Window reads (2025 · 2026)     | Frames from PostgreSQL | Evictions | Result digest |
| ------------------------------------- | ----------- | ------------------------------ | ---------------------- | --------- | ------------- |
| `STORE` (now the default)             | 1,335 s     | **18.7 s** (5.2 · 13.4)        | 1,000                  | 993       | `9070dcbc…`   |
| reference: LRU 1,100, nothing evicted | 846 s       | 4.7 s (2.3 · 2.4)              | 0                      | 0         | `9070dcbc…`   |
| `REBUILD` (the previous behaviour)    | 1 s ¹       | **1,418.7 s** · not finished ² | 0                      | 1,922 ²   | — ²           |

¹ Every security was already resident from the run before, so preparation found nothing to load —
the windows are where the old behaviour pays. ² A container restart at 21:29 UTC ended the run
~16 minutes into its second window; its first window (48 sessions, 2025-10-23 → 2025-12-31) is
measured from the run's own log events (`benchmark-results/F-ordinary-1y-rebuild.interrupted.jsonl`),
and the harness never wrote its report.

The same 48-session window took **1,418.7 s** with the previous behaviour, **5.2 s** with `STORE`
and 2.3 s with nothing evicted: the previous behaviour rebuilt each of the 1,000 securities' full
34-year histories in every window, ~270 times the cost. Over 30 calendar-year windows that is on the
order of twelve hours of rebuilding per run, against minutes. The digests of the two completed runs
are identical: reading a non-resident security's window from PostgreSQL gives the same
result, as the integration test proves value by value. All the evictions in the `STORE` run happened
in preparation, which still rebuilds each non-resident security once (1,000 rebuilds, 22 minutes
here); none happened in the windows.
