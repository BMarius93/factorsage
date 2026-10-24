# FactorSage production runbook

How to provision, deploy, operate, back up and recover the single-host production stack in
`deploy/production/`. The architecture and its sizing are in `architecture.md`; why each number is
what it is, in `benchmarks.md` and `capacity-model.md`.

Nothing here has been executed against real production infrastructure: the stack was built and
smoke-tested in a development container (`PRODUCTION-READINESS-REPORT.md` §E says exactly what was).

## 1. Provision the host

1. A VM per `architecture.md` §3 (reference: 8 dedicated vCPU, 32 GB RAM, ≥ 240 GB NVMe),
   Ubuntu 24.04 LTS, with a static public IP. Point `APP_DOMAIN` and `API_DOMAIN` (A/AAAA) at it.
2. Firewall: inbound 22 (your admin IPs only), 80 and 443 (TCP) and 443 (UDP, HTTP/3). Nothing else:
   PostgreSQL and Redis are never published (`docker-compose.yml` puts them on an `internal` network).
3. Docker Engine and the compose plugin from Docker's repository; enable unattended security upgrades.
4. `vm.overcommit_memory = 1` (`/etc/sysctl.d/99-redis.conf`): Redis forks to snapshot, and the
   kernel must not refuse the fork of a multi-GB process. Disable transparent huge pages
   (`echo never > /sys/kernel/mm/transparent_hugepage/enabled`, persisted by a systemd unit).
5. `git clone` the repository to `/opt/factorsage` (only `deploy/production/` is read on the host).

## 2. Secrets and configuration

Every secret lives in `/etc/factorsage/` (root:root, `0700`; files `0600`) — never in the
repository, an image, a build argument or `compose.env`'s committed template:

| File           | From template              | Holds                                                                                                                             |
| -------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `compose.env`  | `env/compose.env.example`  | domains, ACME e-mail, image registry, `RELEASE`, backup dir                                                                       |
| `postgres.env` | `env/postgres.env.example` | database superuser password                                                                                                       |
| `redis.env`    | `env/redis.env.example`    | Redis password                                                                                                                    |
| `migrate.env`  | `env/migrate.env.example`  | `DATABASE_URL` (pool 2)                                                                                                           |
| `api.env`      | `env/api.env.example`      | `DATABASE_URL` (pool 20), `REDIS_URL`, JWT secret, FMP key, Stripe keys and price ids, `STRIPE_LEGACY_PRICES`, SMTP, Google OAuth |
| `worker.env`   | `env/worker.env.example`   | `DATABASE_URL` (pool 6 per child), `REDIS_URL`, FMP key, FMP traffic limits                                                       |
| `web.env`      | `env/web.env.example`      | nothing secret                                                                                                                    |

Generate passwords with `openssl rand`. **Before the first V2 deploy**, list every retired Stripe
price that still has subscribers in `STRIPE_LEGACY_PRICES` (`ai/architecture/billing.md`), or those
subscribers fall to Free at their next reconciliation.

Rotate a secret by editing its file and `docker compose up -d <service>`; rotating `AUTH_JWT_SECRET`
signs everybody out.

## 3. Build and release

CI builds the images from one commit and pushes them tagged with the release:

```bash
REV=$(date -u +%Y-%m-%d)-$(git rev-parse --short HEAD)
for target in api worker migrate; do
  docker build -f docker/production.Dockerfile --target $target -t $REGISTRY/$target:$REV .
done
docker build -f docker/production.Dockerfile --target web -t $REGISTRY/web:$REV \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://$API_DOMAIN .
docker push $REGISTRY/{api,worker,migrate,web}:$REV
```

The web image compiles the public API URL in; a release build refuses a missing, non-https or
loopback URL.

## 4. Deploy

```bash
/opt/factorsage/deploy/production/scripts/deploy.sh "$REV"
```

which pulls the images, takes a database backup, then `docker compose up -d --wait`: the `migrate`
job applies pending migrations first (the API and worker `depends_on` its success), then the API,
worker and web are recreated. Caddy holds requests up to 10 s while a container restarts.

- **Worker restarts are safe.** On SIGTERM the supervisor asks each child to stop at its next
  checkpoint; a child releases its claim (the run is requeued and resumes from its first day on the
  next worker) within the 45 s `stop_grace_period`. A run that cannot reach a checkpoint in time is
  killed and its lease (60 s) expires; stale recovery requeues it. `maxAttempts` (3) bounds this.
- **Migrations must be backward compatible with the release before them** (expand, deploy, then
  contract in a later release), because the old API can still be serving while `migrate` runs.
  `packages/database/prisma/migrations/*/README.md` notes every migration that needs a deploy order.
- Roll back by redeploying the previous `RELEASE`. A migration is not rolled back by redeploying;
  restore from the pre-deploy backup only if a migration itself was wrong.

## 5. Health and monitoring

| Signal             | Where                                                                                                                                                                                  | Alert when                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| API liveness       | `GET https://$API_DOMAIN/health`                                                                                                                                                       | non-200 for 2 min                                                         |
| API readiness      | `docker compose exec api node -e "fetch('http://127.0.0.1:3001/health/ready')…"` (blocked at the edge)                                                                                 | `unavailable`                                                             |
| Web                | `GET https://$APP_DOMAIN/`                                                                                                                                                             | non-200 for 2 min                                                         |
| TLS                | certificate expiry                                                                                                                                                                     | < 14 days                                                                 |
| Container restarts | `docker compose ps` / restart count                                                                                                                                                    | any restart loop                                                          |
| Backtest queue     | `SELECT status, count(*) FROM "BacktestJob" GROUP BY 1`                                                                                                                                | `QUEUED` > 50 for 15 min; any `CLAIMED` with an expired lease for > 5 min |
| Queue full         | API log `BACKTEST_QUEUE_FULL` 503s                                                                                                                                                     | any                                                                       |
| Worker failures    | `backtest.failed`, `worker.child.exited`, `backtest.lease.lost`                                                                                                                        | > 3/hour                                                                  |
| Monitor EOD pass   | `monitor.cycle.completed` duration                                                                                                                                                     | not completed by 07:00 ET                                                 |
| FMP                | provider failures and the gate's "temporarily unavailable" (`FmpTransientError`: a process's gate queue of `FMP_MAX_QUEUE_DEPTH` is full, or a request waited `FMP_MAX_QUEUE_WAIT_MS`) | sustained                                                                 |
| Redis              | `INFO memory used_memory` vs `maxmemory`; `rdb_last_bgsave_status`                                                                                                                     | > 85 %; `err`                                                             |
| PostgreSQL         | connections vs `max_connections`; disk; replication/backup age                                                                                                                         | > 80 %; < 20 % free; backup > 26 h old                                    |
| Host               | CPU, RAM, disk, load                                                                                                                                                                   | disk < 20 % free, RAM available < 10 %                                    |
| Worker memory      | `docker stats factorsage-worker-1` (the cgroup's usage against its 16 GB limit); the kernel's OOM kills in `dmesg`                                                                     | > 80 % of the limit; any OOM kill                                         |

Every process logs one JSON object per line to stdout (rotated by Docker: 5 × 50 MB per container).
Ship them with any collector that reads Docker's JSON logs (e.g. Vector or Grafana Alloy to a hosted
log store) and derive the counters above from the events; `node_exporter`, `postgres_exporter` and
`redis_exporter` cover the host and data stores. An external uptime check (any provider) hits the two
public URLs.

## 6. Backups

- **Nightly logical dump**: `scripts/backup-postgres.sh` from a systemd timer (02:30 UTC), custom
  format, zstd, verified with `pg_restore --list`, copied off-host with `rclone` when
  `BACKUP_REMOTE` is set, 14 days retained locally. The deploy script takes one before every release.
- **Point-in-time recovery** (recommended before launch, not built here): `wal_level = replica` is
  already set; add WAL-G or pgBackRest archiving to an object store for an RPO of minutes instead of
  a day.
- **Redis is not backed up.** It holds no state of record: a lost Redis is rebuilt from PostgreSQL
  (the protected tier by `pnpm data:index-universe -- protect`, everything else on first read). Its
  RDB snapshot only shortens a restart.
- What a backup must contain: every table. Market data is the bulk of it and is re-downloadable, but
  only at the provider's quota and rate — a restore is far faster than a re-hydration.

## 7. Restore drill (quarterly) and recovery

```bash
scripts/restore-postgres.sh /var/backups/factorsage/factorsage-<stamp>.dump factorsage_restore
docker compose exec postgres psql -U factorsage -d factorsage_restore -c 'SELECT count(*) FROM "User"'
```

To recover: stop `api` and `worker`, restore into a new database, point `DATABASE_URL` in
`api.env`, `worker.env` and `migrate.env` at it, `docker compose up -d`. Then flush Redis
(`docker compose exec redis redis-cli -a … FLUSHALL`) — its projections describe the old database —
and run `protect` for the protected tier. Record the drill's duration: it is the recovery time.

## 8. Incidents

| Symptom                          | First checks                                                                                                                                                 | Action                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backtests queue but none start   | `CLAIMED` jobs and their leases; worker logs                                                                                                                 | a crashed worker's slot returns within one lease (60 s); if every slot is held by live leases, the runs are executing — check their progress                                                                                                                                                                                                                           |
| `503 BACKTEST_QUEUE_FULL`        | queue depth                                                                                                                                                  | expected under a burst; raise `BACKTEST_QUEUE_MAX_QUEUED` only with capacity, never `BACKTEST_GLOBAL_MAX_RUNNING` without re-measuring                                                                                                                                                                                                                                 |
| A 1,000-symbol run is very slow  | its phase timings (`backtest.frames.loaded`, `backtest.window.loaded` with `storeReads`) and LRU evictions (`stock-data.cache.lru-evicted` with its `runId`) | a list of many ordinary (non-protected) securities spends most of its time in preparation, rebuilding each one into Redis once (~22 min for 1,000 on the benchmark machine); its windows read the non-resident ones from PostgreSQL. Check `BACKTEST_NON_RESIDENT_FRAME_READ` is not set to `REBUILD`, which rebuilds them in every window (`benchmark-results.md` §2) |
| Redis out of memory              | `used_memory`, `maxmemory`, LRU size                                                                                                                         | `noeviction` refuses writes and reads still serve; lower `STOCK_LRU_MAX_SECURITIES` or raise `maxmemory` with the container limit                                                                                                                                                                                                                                      |
| Redis lost                       | `/health/ready`                                                                                                                                              | restart it; reads rebuild from PostgreSQL; run `protect` for the protected tier                                                                                                                                                                                                                                                                                        |
| PostgreSQL connections exhausted | `pg_stat_activity` by application                                                                                                                            | pools are fixed per process (`connection_limit`); a leak shows as one process's count growing                                                                                                                                                                                                                                                                          |
| FMP rate limited / quota         | `stock-data.provider.request` 429s                                                                                                                           | the gate already waits and retries; lower `FMP_RATE_LIMIT_PER_WINDOW` to the plan's documented limit                                                                                                                                                                                                                                                                   |
| A deploy hangs on `migrate`      | `docker compose logs migrate`                                                                                                                                | a migration waiting on a lock: find it in `pg_locks`; never kill a migration mid-statement without a backup                                                                                                                                                                                                                                                            |
