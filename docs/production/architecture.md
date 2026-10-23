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

Filled from measurements in §3 of `capacity-model.md`; the compose limits (`docker-compose.yml`)
are those numbers.

## 4. Configuration that matters

| Setting                                 | Value                                             | Where          | Why                                                                                                                           |
| --------------------------------------- | ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BACKTEST_GLOBAL_MAX_RUNNING`           | 4                                                 | api, worker    | the product's deployment-wide cap                                                                                             |
| `BACKTEST_WORKER_PROCESSES`             | 4                                                 | worker         | one process per slot                                                                                                          |
| `BACKTEST_QUEUE_MAX_QUEUED`             | 100                                               | worker, api    | backpressure: `503 BACKTEST_QUEUE_FULL` beyond it                                                                             |
| `STOCK_LRU_MAX_SECURITIES`              | 500                                               | api, worker    | the owner's specified LRU size; see `capacity-model.md` for what it holds                                                     |
| `connection_limit`                      | api 20, worker 6/child, migrate 2                 | `DATABASE_URL` | the connection budget in `postgresql.conf` (Prisma otherwise sizes each pool from the CPU count, which multiplies by process) |
| `maxmemory` / policy                    | 6 GB / `noeviction`                               | `redis.conf`   | the stock tiers require `noeviction`; size in `capacity-model.md`                                                             |
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
