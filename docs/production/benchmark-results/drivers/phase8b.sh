#!/usr/bin/env bash
# Two failure tests again, against backtest workers rebuilt with a Redis client that waits through
# refused connections (BACKTEST_REDIS_MAX_RETRIES_PER_REQUEST): a worker kill during a first-time
# hydration, and the Redis restart that found the fix.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RES=$ROOT/docs/production/benchmark-results
LOG=$RES/phase8.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
note() { echo "{\"event\":\"phase8.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" >> "$LOG"; }
cd "$ROOT"
pnpm --filter @intrinsic/stock-data build > "$ROOT/artifacts/scale-benchmark/rebuild.log" 2>&1 \
  && pnpm --filter @intrinsic/worker build >> "$ROOT/artifacts/scale-benchmark/rebuild.log" 2>&1
note rebuilt "\"exit\":$?"
cd "$ROOT/apps/api"
TSX=./node_modules/.bin/tsx
# The worker kill during a first-time hydration, again: the first attempt (F8-C-miss-kill-worker)
# started inside the provider outage the test before it injected, failed on its 429s at 8 s and
# never reached the kill.
label=F8-C-miss-kill-worker-2
note start "\"label\":\"$label\""
started=$(date +%s)
env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION timeout 3600 $TSX src/backtest-benchmark/scale-backtest-benchmark.ts run --label "$label" \
  --scenario C --cache miss --mix mixed --strategy simple --chaos kill-worker --chaos-at-s 30 --timeout-minutes 60 \
  > "$ROOT/artifacts/scale-benchmark/$label.stdout" 2> "$ROOT/artifacts/scale-benchmark/$label.stderr"
note done "\"label\":\"$label\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started ))"
label=F8-H-warm-redis-restart-ridethrough
note start "\"label\":\"$label\""
started=$(date +%s)
BENCH_REDIS_RESTART_COMMAND='redis-cli SHUTDOWN SAVE; sleep 1; runuser -u redis -- redis-server /etc/redis/redis.conf --daemonize yes' \
  env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION timeout 3600 $TSX src/backtest-benchmark/scale-backtest-benchmark.ts run --label "$label" \
  --scenario H --cache warm --mix mixed --overlap shared --strategy simple --chaos redis-restart --chaos-at-s 60 \
  > "$ROOT/artifacts/scale-benchmark/$label.stdout" 2> "$ROOT/artifacts/scale-benchmark/$label.stderr"
note done "\"label\":\"$label\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started ))"
redis-cli CONFIG SET save "900 1 300 100000" > /dev/null
env -u FMP_API_KEY $TSX src/backtest-benchmark/scale-backtest-benchmark.ts audit > "$RES/audit-after-redis-restart-ridethrough.json" 2> "$ROOT/artifacts/scale-benchmark/audit-ridethrough.stderr"
note audit "\"label\":\"after-redis-restart-ridethrough\",\"exit\":$?"
