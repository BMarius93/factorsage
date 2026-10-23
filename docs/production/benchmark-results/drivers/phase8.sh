#!/usr/bin/env bash
# Phase 8: failure and recovery tests on the benchmark environment. Each step records its own report.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RES=$ROOT/docs/production/benchmark-results
LOG=$RES/phase8.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
note() { echo "{\"event\":\"phase8.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" >> "$LOG"; }
cd "$ROOT/apps/api"
TSX=./node_modules/.bin/tsx
bench() { # label, args...
  local label=$1; shift
  note start "\"label\":\"$label\""
  local started=$(date +%s)
  env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION timeout 10800 $TSX src/backtest-benchmark/scale-backtest-benchmark.ts run --label "$label" "$@" \
    > "$ROOT/artifacts/scale-benchmark/$label.stdout" 2> "$ROOT/artifacts/scale-benchmark/$label.stderr"
  note done "\"label\":\"$label\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started ))"
}
audit() { # label
  env -u FMP_API_KEY $TSX src/backtest-benchmark/scale-backtest-benchmark.ts audit > "$RES/audit-$1.json" 2> "$ROOT/artifacts/scale-benchmark/audit-$1.stderr"
  note audit "\"label\":\"$1\",\"exit\":$?"
}
synthetic() { # extra args: restart the synthetic provider
  pkill -f "synthetic-fmp-server.ts" ; sleep 1
  nohup $TSX src/backtest-benchmark/synthetic-fmp-server.ts --port 4790 --universe 4000 "$@" > "$ROOT/artifacts/scale-benchmark/synthetic-fmp.log" 2>&1 &
  until curl -sf http://127.0.0.1:4790/__synthetic/health > /dev/null; do sleep 0.5; done
  note synthetic "\"args\":\"$*\""
}
redis-cli CONFIG SET save "900 1 300 100000" > /dev/null
synthetic

# 1. A worker SIGKILLed while executing (warm): the run must be re-executed once, with the same result.
bench F8-H-warm-kill-worker --scenario H --cache warm --mix mixed --overlap shared --strategy simple --chaos kill-worker --chaos-at-s 60
audit after-kill-worker-warm
# 2. A worker SIGKILLed while rebuilding stocks into Redis (cold preparation).
bench F8-H-cold-kill-worker --scenario H --cache cold --mix mixed --overlap shared --strategy simple --chaos kill-worker --chaos-at-s 40
audit after-kill-worker-cold
# 3. Redis stopped and restarted while four runs execute.
BENCH_REDIS_RESTART_COMMAND='redis-cli SHUTDOWN SAVE; sleep 1; runuser -u redis -- redis-server /etc/redis/redis.conf --daemonize yes' \
  bench F8-H-warm-redis-restart --scenario H --cache warm --mix mixed --overlap shared --strategy simple --chaos redis-restart --chaos-at-s 60
redis-cli CONFIG SET save "900 1 300 100000" > /dev/null
audit after-redis-restart
# 4. Redis loses everything while four runs execute.
bench F8-H-warm-redis-flush --scenario H --cache warm --mix mixed --overlap shared --strategy simple --chaos redis-flush --chaos-at-s 60
audit after-redis-flush
# 5. Restart during a large hydration: the protected-tier rebuild killed half way, then run again.
redis-cli -n 5 FLUSHDB > /dev/null
note protect-kill-start
( env DATABASE_URL="$BENCH_DATABASE_URL" REDIS_URL="$BENCH_REDIS_URL" STOCK_LRU_MAX_SECURITIES=500 FMP_API_KEY= $TSX src/index-universe.ts protect --concurrency 4 \
    > "$RES/protect-killed.stdout" 2> "$ROOT/artifacts/scale-benchmark/protect-killed.stderr" ) &
PROTECT=$!
sleep 240
pkill -KILL -f "src/index-universe.ts protect"
wait $PROTECT 2>/dev/null
note protect-killed "\"protectedReady\":$(redis-cli -n 5 SCARD stock-data:v2:protected-stocks)"
env DATABASE_URL="$BENCH_DATABASE_URL" REDIS_URL="$BENCH_REDIS_URL" STOCK_LRU_MAX_SECURITIES=500 FMP_API_KEY= $TSX src/index-universe.ts tiers --out "$RES/tiers-after-protect-kill.json" > /dev/null 2>&1
started=$(date +%s)
env DATABASE_URL="$BENCH_DATABASE_URL" REDIS_URL="$BENCH_REDIS_URL" STOCK_LRU_MAX_SECURITIES=500 FMP_API_KEY= $TSX src/index-universe.ts protect --concurrency 4 \
  > "$RES/protect-after-kill.stdout" 2> "$ROOT/artifacts/scale-benchmark/protect-after-kill.stderr"
note protect-rerun "\"exit\":$?,\"seconds\":$(( $(date +%s) - started ))"
env DATABASE_URL="$BENCH_DATABASE_URL" REDIS_URL=redis://localhost:6379/5 STOCK_LRU_MAX_SECURITIES=500 \
  STOCK_CACHE_PROTECTED_SAMPLE=SYN0001,SYN0002,SYN0100,SYN0300,SYN0500,SYN0735 FMP_API_KEY= \
  $TSX src/cache-benchmark/stock-cache-tier-validation.ts residency --out "$RES/lru/residency-after-protect-kill.json" > /dev/null 2>&1
note residency-after-protect-kill "\"exit\":$?"
# 6. PostgreSQL connection exhaustion: 20 s into four running backtests, 85 of the server's 100
#    connections are taken and held for 150 s, then released.
(
  sleep 20
  python3 - "$BENCH_DATABASE_URL" <<'PY'
import subprocess, sys, time
procs = [subprocess.Popen(["psql", sys.argv[1], "-c", "select pg_sleep(150)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(85)]
time.sleep(3)
print("held", len(procs), flush=True)
for proc in procs: proc.wait()
print("released", flush=True)
PY
) > "$ROOT/artifacts/scale-benchmark/pg-hold.log" 2>&1 &
HOLD=$!
bench F8-H-warm-pg-exhaustion --scenario H --cache warm --mix mixed --overlap shared --strategy simple --timeout-minutes 60
wait $HOLD 2>/dev/null
note pg-exhaustion "\"holder\":\"$(tr '\n' ' ' < "$ROOT/artifacts/scale-benchmark/pg-hold.log")\""
# 7. FMP rate-limit exhaustion during a true miss: every provider request refused (429) for 90 s.
( sleep 20; curl -s "http://127.0.0.1:4790/__synthetic/outage?ms=90000&status=429" > /dev/null; ) &
bench F8-C-miss-fmp-outage --scenario C --cache miss --mix mixed --strategy simple --timeout-minutes 90
# 8. Partial provider failures: every 7th request answered 500 during a true miss.
synthetic --fail-every 7 --fail-status 500
bench F8-B-miss-partial-failures --scenario B --cache miss --mix mixed --strategy simple --timeout-minutes 60
synthetic
audit after-provider-failures
# 9. Monitor EOD processing during heavy backtest activity: the Monitor capacity benchmark
#    (stock EOD child + Monitor pass, 100 users, 300 Monitors, 9,000 members) alone, then while
#    four backtests execute back to back on the same machine and PostgreSQL server.
monitor_bench() {
  (cd "$ROOT/apps/worker" && env -u FMP_API_KEY timeout 5400 ./node_modules/.bin/tsx src/monitor/capacity-bench.ts \
    --scenario=growing --days=2 --out="$RES/monitor-$1.json" > "$ROOT/artifacts/scale-benchmark/monitor-$1.log" 2>&1)
  note monitor-bench "\"label\":\"$1\",\"exit\":$?"
}
monitor_bench alone
monitor_bench during-H &
MB=$!
i=0
while kill -0 $MB 2>/dev/null; do
  i=$((i+1))
  bench "F8-H-beside-monitor-$i" --scenario H --cache warm --mix mixed --overlap shared --strategy simple
done
wait $MB
note finished
