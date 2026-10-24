#!/usr/bin/env bash
# Phase 5: interactive load against the API/web production builds, with and without four backtests.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RES=$ROOT/docs/production/benchmark-results
LOG=$RES/phase5.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
note() { echo "{\"event\":\"phase5.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" >> "$LOG"; }
# A throwaway password for the load accounts: in this shell's memory only, never exported, never
# written; passed to the load-generator commands alone (never to the API, web or workers).
PW=$(openssl rand -hex 18)
mkdir -p "$ROOT/artifacts/load"
cd "$ROOT/apps/api"
# The API from its current build (the web build already calls http://127.0.0.1:3101).
pnpm build > "$ROOT/artifacts/load/api-build.log" 2>&1
note api-built "\"exit\":$?"
mkdir -p "$ROOT/artifacts/load"
note servers-starting
env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION ./node_modules/.bin/tsx src/load-test/bench-servers.ts --api-port 3101 --web-port 3100 \
  > "$ROOT/artifacts/load/servers.stdout" 2> "$ROOT/artifacts/load/servers.stderr" &
SERVERS=$!
until [ -s "$ROOT/artifacts/load/servers.json" ] && grep -q '"pid"' "$ROOT/artifacts/load/servers.json"; do
  if ! kill -0 $SERVERS 2>/dev/null; then note servers-failed; exit 1; fi; sleep 2; done
API_PID=$(python3 -c "import json;print(json.load(open('$ROOT/artifacts/load/servers.json'))['api']['pid'])")
note servers-ready "\"apiPid\":$API_PID"
LOAD_TEST_PASSWORD="$PW" ./node_modules/.bin/tsx src/load-test/interactive-load.ts setup --users 100 > "$RES/load-setup.json" 2> "$ROOT/artifacts/load/setup.stderr"
note setup-done "\"exit\":$?"
level() { # users, label
  LOAD_TEST_PASSWORD="$PW" ./node_modules/.bin/tsx src/load-test/interactive-load.ts run --base-url http://127.0.0.1:3101 \
    --users "$1" --duration-s 150 --ramp-s 20 --api-pid "$API_PID" --api-log "$ROOT/artifacts/load/api.log" --sample-jobs true \
    --label "$2" > "$ROOT/artifacts/load/$2.stdout" 2> "$ROOT/artifacts/load/$2.stderr"
  note level-done "\"label\":\"$2\",\"exit\":$?"
}
browser() { # label
  (cd "$ROOT/apps/web" && LOAD_TEST_PASSWORD="$PW" ./node_modules/.bin/tsx load-test/browser-journeys.ts --web-url http://127.0.0.1:3100 \
    --users 3 --rounds 2 --label "$1" > "$ROOT/artifacts/load/browser-$1.stdout" 2> "$ROOT/artifacts/load/browser-$1.stderr")
  note browser-done "\"label\":\"$1\",\"exit\":$?"
}
# Without backtests.
for users in 5 20 50 100; do level $users "baseline-${users}u"; done
browser baseline
# With four backtests executing: H warm runs back to back until the levels are done.
H_LOOP_STOP=$ROOT/artifacts/load/h-loop.stop; rm -f "$H_LOOP_STOP"
(
  i=0
  while [ ! -e "$H_LOOP_STOP" ]; do
    i=$((i+1))
    env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION ./node_modules/.bin/tsx src/backtest-benchmark/scale-backtest-benchmark.ts run \
      --scenario H --cache warm --mix mixed --overlap shared --strategy simple --label "H-under-load-$i" \
      > "$ROOT/artifacts/scale-benchmark/H-under-load-$i.stdout" 2> "$ROOT/artifacts/scale-benchmark/H-under-load-$i.stderr"
  done
) &
HLOOP=$!
# Wait for four executing.
until [ "$(psql "$BENCH_DATABASE_URL" -Atc "select count(*) from \"BacktestJob\" where status='CLAIMED'")" -ge 4 ]; do sleep 2; done
note backtests-executing
for users in 5 20 50 100; do level $users "during-H-${users}u"; done
browser during-H
touch "$H_LOOP_STOP"
note h-loop-stopping
wait $HLOOP
note h-loop-stopped
# Live admission probes (no worker running now): tabs, bypasses, queue saturation.
LOAD_TEST_PASSWORD="$PW" ./node_modules/.bin/tsx src/load-test/submission-probes.ts --base-url http://127.0.0.1:3101 --saturate 100 \
  > "$ROOT/artifacts/load/probes.stdout" 2> "$ROOT/artifacts/load/probes.stderr"
note probes-done "\"exit\":$?"
# The API through a Redis restart: readiness and a public stock page every 0.5 s for 60 s, with
# Redis restarted (SHUTDOWN SAVE, then started again) 10 s in.
(
  end=$((SECONDS + 60))
  while [ $SECONDS -lt $end ]; do
    for path in /health/ready /stocks/SYN0001/summary; do
      printf '%s %s %s\n' "$(date +%s.%N)" "$path" \
        "$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "http://127.0.0.1:3101$path")"
    done
    sleep 0.5
  done
) > "$RES/api-redis-restart-probe.log" &
PROBE=$!
sleep 10
note redis-restart-begun
redis-cli SHUTDOWN SAVE > /dev/null; sleep 1; runuser -u redis -- redis-server /etc/redis/redis.conf --daemonize yes
until redis-cli ping 2> /dev/null | grep -q PONG; do sleep 0.2; done
note redis-restarted
wait $PROBE
redis-cli CONFIG SET save "900 1 300 100000" > /dev/null
note redis-restart-probe-done
kill $SERVERS; wait $SERVERS 2>/dev/null
note finished
