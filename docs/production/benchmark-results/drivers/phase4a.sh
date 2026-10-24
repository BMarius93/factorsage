#!/usr/bin/env bash
# LRU-thrash comparison: Pro+ x 1,000 ordinary securities, one year, four workers.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
LOG=$ROOT/docs/production/benchmark-results/phase4.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
cd "$ROOT/apps/api"
# The production snapshot policy (deploy/production/redis/redis.conf), not the development default
# (`60 10000` snapshots a multi-GB dataset every minute under LRU churn and distorts the timings).
echo "{\"event\":\"phase4.redis-save\",\"before\":\"$(redis-cli CONFIG GET save | tail -1)\"}" >> "$LOG"
redis-cli CONFIG SET save "900 1 300 100000" >> "$LOG"
bench() { # label, args...
  local label=$1; shift
  echo "{\"event\":\"phase4.start\",\"label\":\"$label\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
  local started=$(date +%s)
  env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION timeout 14400 ./node_modules/.bin/tsx src/backtest-benchmark/scale-backtest-benchmark.ts run --label "$label" "$@" \
    > "$ROOT/artifacts/scale-benchmark/$label.stdout" 2> "$ROOT/artifacts/scale-benchmark/$label.stderr"
  echo "{\"event\":\"phase4.done\",\"label\":\"$label\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started )),\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
}
bench F-ordinary-1y-store --scenario F --mix ordinary --cache warm --years 1 --strategy simple \
  --worker-env BACKTEST_NON_RESIDENT_FRAME_READ=STORE --timeout-minutes 120
bench F-ordinary-1y-lru1100 --scenario F --mix ordinary --cache warm --years 1 --strategy simple \
  --worker-env STOCK_LRU_MAX_SECURITIES=1100 --timeout-minutes 120
bench F-ordinary-1y-rebuild --scenario F --mix ordinary --cache warm --years 1 --strategy simple \
  --timeout-minutes 90
echo "{\"event\":\"phase4a.finished\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
