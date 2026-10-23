# Production architecture

The deployment that runs FactorSage with **at most four backtests executing at once, deployment-wide**,
sized from `benchmarks.md` and `capacity-model.md`. Its files are `deploy/production/` and
`docker/production.Dockerfile`; how to run it is `RUNBOOK.md`.

## 1. Shape

```text
                 Internet
                    │ 80/443 (TCP), 443/UDP
              ┌─────▼─────┐
              │   Caddy   │  TLS (ACME), HTTP/2+3, compression, security headers, body limit
              └──┬─────┬──┘
   app.<domain>  │     │  api.<domain>
           ┌─────▼──┐ ┌▼──────────┐        outbound: FMP, Stripe, SMTP, Google OAuth
           │  web   │ │    api    │◄──────────────────────────────────────────┐
           │ Next.js│ │  NestJS   │                                           │
           └────────┘ └──┬────┬───┘                                           │
                         │    │        ┌───────────────────────────────────┐  │
                         │    │        │ worker (supervisor)               │  │
                         │    │        │  backtest ×4 · monitor · market   │──┘
                         │    │        │  data · stock EOD                 │
                         │    │        └──────┬───────────────┬────────────┘
                    ┌────▼────▼──┐            │               │
                    │ PostgreSQL ├◄───────────┘               │
                    │     16     │   (data network: no route out, nothing published)
                    └────────────┘                     ┌──────▼─────┐
                                      api ────────────►│  Redis 7   │
                                                       └────────────┘
```

| Component       | What it is                                                                                  | Why this way                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Edge            | Caddy 2                                                                                     | automatic certificates and HTTP/3 with a ten-line config; one binary, no certbot cron                                    |
| Web             | Next.js server (`next start`), one container                                                | server-rendered public pages (pricing, shared reports, demos); stateless                                                 |
| API             | NestJS, one container                                                                       | stateless; every limit is in PostgreSQL or Redis, so a second replica needs no code change                               |
| Worker          | one supervisor, seven children: 4 backtest, 1 Monitor, 1 market data, 1 stock EOD           | `BACKTEST_WORKER_PROCESSES=4` = the global cap: each executing run has a core and no process idles waiting for admission |
| Queue/scheduler | PostgreSQL (`BacktestJob`, advisory-lock admission), no broker                              | already durable, transactional with the run row, survives every restart (`backtest-execution.md`)                        |
| Database        | PostgreSQL 16, one primary, tuned                                                           | the source of truth; market history is most of its size                                                                  |
| Cache           | Redis 7, `noeviction`, RDB snapshots                                                        | disposable projection + gate/lock/rate-limit state                                                                       |
| Migrations      | one-shot `migrate` job before the API and worker start                                      | schema first, then code — the deploy order every migration README assumes                                                |
| Backups         | nightly `pg_dump` (+ off-host copy), PITR recommended                                       | §5                                                                                                                       |
| Observability   | JSON logs to stdout → any collector; exporters for host, PostgreSQL, Redis; external uptime | §6                                                                                                                       |
| Secrets         | `/etc/factorsage/*.env`, root-only, runtime environment                                     | nothing secret in images, build args or the repository                                                                   |

**No Kubernetes.** The workload is one stateful database, one cache and a handful of processes whose
concurrency is capped at four by design; a scheduler, an ingress controller and a control plane would
add more failure modes than they remove. **No separate broker.** The PostgreSQL queue is the
documented architecture (`AGENTS.md` invariant 14).

## 2. Single host or separated?

| Option                                          | Pros                                                                                                          | Cons                                                                                                                                                           | Verdict                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A. One host, everything** (this compose file) | cheapest; no network hops between API, workers, PostgreSQL, Redis; one machine to secure, monitor and back up | one failure domain; backtests and the database share CPU and disk                                                                                              | **launch** — the measured load fits with headroom (§3); recovery is a restore, measured in `RUNBOOK.md` |
| B. App host + managed PostgreSQL                | managed backups/PITR/failover; database isolated from backtest CPU                                            | ~2–3× the cost of the database share; network latency on every read of history (frame reads are I/O-bound); egress costs                                       | **first upgrade** when uptime requirements exceed what a restore gives                                  |
| C. Separate worker host(s)                      | backtest CPU isolated from the API                                                                            | the cap stays four (global admission), so a second worker host adds availability, not throughput; Redis and PostgreSQL must then be reachable over the network | only for availability, after B                                                                          |

## 3. Sizing

### 3.1 What was measured

On the 4 vCPU / 16 GB development container, synthetic 34-year histories (the worst case per
security), `BACKTEST_NON_RESIDENT_FRAME_READ=STORE` (`benchmark-results.md` §1–§4):

| Resource                              | Measured                                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU per executing backtest            | **one core, fully**: a run is single-threaded and CPU-bound once its data is resident; four 1,000-security runs at once kept the machine 97 % busy (`I-warm-mixed-shared`)         |
| Backtest child memory                 | 0.3 GB idle or small; **0.5 GB** executing a warm 1,000-security run; **2.0–2.1 GB** while preparation rebuilds ~1,000 securities into Redis (`H-cold-*`, `F-ordinary-1y-store`)   |
| Four 1,000-security runs at once      | warm: 157 s each, 1.9 GB across the four children; cold (Redis empty): 21.3 min, **6.6 GB** across the four                                                                        |
| Redis                                 | **1.30 GB** `used_memory` with both tiers full (735 protected + 500 LRU, 1.05 MB per synthetic security; real histories 0.74 MB → ≈0.95 GB); snapshot copy-on-write 5 MB, 14 s     |
| PostgreSQL                            | ≤ 34 connections, ≤ 9 active; 34 CPU-seconds and 8.3 GB of block reads in a 21-minute cold four-way run; ≤ 0.7 GB of temp files per run; ≈ 8.5 MB of database per 34-year security |
| Interactive API beside four backtests | `benchmark-results.md` §6                                                                                                                                                          |

### 3.2 The reference host

**One host: 8 dedicated vCPU, 32 GB RAM, ≥ 240 GB local NVMe** — for example Hetzner Cloud CCX33.

- **CPU.** Four cores go to the four executing backtests (measured: a core each, flat out). The other
  four serve the API, web, PostgreSQL, Redis and the Monitor, market-data and stock-EOD children,
  whose combined load beside four backtests is measured in `benchmark-results.md` §6–§7. Dedicated
  (not shared) vCPUs, because a backtest holds its core for minutes at a time. On a 4 vCPU host the
  four backtests take every core; there, run `BACKTEST_GLOBAL_MAX_RUNNING=2`.
- **Memory.** The compose limits below sum to 30.3 GB, but they are ceilings: the measured
  simultaneous worst case (four cold 1,000-security preparations) is ≈ 9.6 GB of workers, 1.3 GB of
  Redis and PostgreSQL's 2.5 GB of shared buffers, leaving the rest to the page cache.
- **Storage.** A security's 34-year history is ≈ 8.5 MB in PostgreSQL (the benchmark database: 15 GB
  for 1,764 synthetic securities; real histories are shorter), so the canonical universe is ≈ 6 GB and
  5,000 hydrated securities ≈ 43 GB, plus up to 8 GB of WAL, two local
  dumps, images and the Redis snapshot. Throughput needs are small — the heaviest run read 6.6 MB/s on
  average — so any local NVMe has two orders of magnitude of headroom; latency matters more than
  IOPS, which is why local NVMe is preferred to network block storage.
- **Network.** Small: rebuilding a security into Redis asks the provider for one day of prices at most
  (608 requests, 0.9 MB for the cold four-way run); a security seen for the first time costs ~22
  requests on real FMP and ~2.3 MB of FMP-shaped history from the synthetic provider
  (`benchmark-results.md` §5; the real sample's bytes were not recorded), so a first-time
  1,000-security list downloads on the order of 2 GB. The host's included traffic is ample.

| Service  | CPU limit | Memory limit                         | Basis                                                                                                                             |
| -------- | --------: | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| worker   |         5 | 12 GB                                | four backtest children × 2.1 GB (measured preparation peak) + Monitor, market-data, stock-EOD children and supervisor ≈ 9.6 GB    |
| postgres |         3 | 10 GB                                | `shared_buffers` 2.5 GB, `work_mem` 32 MB × active queries, the rest page cache inside the cgroup                                 |
| redis    |         1 | 5 GB (`maxmemory` 4 GB)              | 3× the measured 1.30 GB, room to raise `STOCK_LRU_MAX_SECURITIES` to ~2,000 without a Redis change; 1 GB for buffers and the fork |
| api      |         2 | 2 GB (`--max-old-space-size` 1.5 GB) | `benchmark-results.md` §6                                                                                                         |
| web      |         1 | 1 GB                                 | stateless Next.js server                                                                                                          |
| caddy    |         1 | 256 MB                               | TLS edge                                                                                                                          |

Four simultaneous 1,000-security, 30-year backtests are safe on this host: they were measured on a
machine with half its cores and memory, cold and warm, with every result digest identical to the run
alone.

### 3.3 Monthly cost

List prices checked 2026-10-23 from third-party trackers of the providers' price pages (Hetzner
repriced on 2026-04-01 and 2026-06-15); excluding VAT; verify at order time.

| Option                                                        | Components                                                                                                      | ≈ Monthly     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------- |
| **A. One host (launch)**                                      | Hetzner CCX33 €138.49 + IPv4 + Storage Box BX11 (1 TB, off-host dumps) €3.20                                    | **≈ €145**    |
| A on other providers                                          | DigitalOcean General Purpose 8 vCPU / 32 GB $252; AWS m7i.2xlarge on demand ≈ $294 + 250 GB gp3 ≈ $20 + backups | $260–330      |
| B. App host + managed PostgreSQL                              | CCX33 (the backtests still need their four cores) + managed PostgreSQL 4 vCPU / 16 GB (DigitalOcean ≈ $270)     | ≈ €145 + $270 |
| C. B plus a second worker host (availability, not throughput) | B + a second CCX33                                                                                              | ≈ €285 + $270 |

## 4. Configuration that matters

| Setting                                 | Value                                             | Where          | Why                                                                                                                           |
| --------------------------------------- | ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BACKTEST_GLOBAL_MAX_RUNNING`           | 4                                                 | api, worker    | the product's deployment-wide cap                                                                                             |
| `BACKTEST_WORKER_PROCESSES`             | 4                                                 | worker         | one process per slot                                                                                                          |
| `BACKTEST_QUEUE_MAX_QUEUED`             | 100                                               | worker, api    | backpressure: `503 BACKTEST_QUEUE_FULL` beyond it                                                                             |
| `STOCK_LRU_MAX_SECURITIES`              | 500                                               | api, worker    | the owner's specified LRU size; see `capacity-model.md` for what it holds                                                     |
| `connection_limit`                      | api 20, worker 6/child, migrate 2                 | `DATABASE_URL` | the connection budget in `postgresql.conf` (Prisma otherwise sizes each pool from the CPU count, which multiplies by process) |
| `maxmemory` / policy                    | 4 GB / `noeviction`                               | `redis.conf`   | the stock tiers require `noeviction`; sized in §3.2                                                                           |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS`         | 1                                                 | api            | Caddy is the one proxy                                                                                                        |
| `stop_grace_period`                     | worker 45 s, api 20 s, postgres 120 s, redis 60 s | compose        | longer than each process's own graceful path (worker supervisor: 30 s)                                                        |
| `MONITOR_FAIR_USE_MAX_ENABLED_PER_USER` | 100                                               | api            | infrastructure protection for "unlimited" Monitors                                                                            |

## 5. Backup and recovery

RPO: 24 h with the nightly dump (minutes with WAL archiving, recommended). RTO: the measured restore
time of the database (`RUNBOOK.md` §7) plus the protected-tier rebuild, during which the product
serves from PostgreSQL. Redis needs no backup.

## 6. Observability

Every process already logs structured JSON with correlation ids; the deployment adds collection, the
three exporters and the alerts in `RUNBOOK.md` §5. There are no application metrics endpoints yet —
the queue, the LRU and the provider gate are observed through their log events and through
PostgreSQL/Redis queries; a `/metrics` endpoint is a recommended follow-up, not a launch blocker.
