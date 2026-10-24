#!/usr/bin/env bash
# The interactive tier with two API processes: two load generators of 50 users each, one per API
# process, against phase 5's 100 users on one process. Nothing else runs (no backtests).
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
RES=$ROOT/docs/production/benchmark-results
LOG=$RES/phase5.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
note() { echo "{\"event\":\"phase5.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" >> "$LOG"; }
PW=$(openssl rand -hex 18)
cd "$ROOT/apps/api"
TSX=./node_modules/.bin/tsx
rm -f "$ROOT/artifacts/load/servers-3101.json" "$ROOT/artifacts/load/servers-3102.json"
for port in 3101 3102; do
  env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION $TSX src/load-test/bench-servers.ts --api-only --api-port $port \
    > "$ROOT/artifacts/load/servers-$port.stdout" 2> "$ROOT/artifacts/load/servers-$port.stderr" &
done
for port in 3101 3102; do
  until [ -s "$ROOT/artifacts/load/servers-$port.json" ]; do sleep 2; done
done
P1=$(python3 -c "import json;print(json.load(open('$ROOT/artifacts/load/servers-3101.json'))['api']['pid'])")
P2=$(python3 -c "import json;print(json.load(open('$ROOT/artifacts/load/servers-3102.json'))['api']['pid'])")
note two-api-ready "\"pids\":[$P1,$P2]"
LOAD_TEST_PASSWORD="$PW" $TSX src/load-test/interactive-load.ts setup --users 100 > /dev/null 2> "$ROOT/artifacts/load/setup-two-api.stderr"
note two-api-setup "\"exit\":$?"
LOAD_TEST_PASSWORD="$PW" $TSX src/load-test/interactive-load.ts run --base-url http://127.0.0.1:3101 --users 50 --first-user 1 \
  --duration-s 150 --ramp-s 20 --api-pid "$P1" --api-log "$ROOT/artifacts/load/api-3101.log" --label two-api-100u-a \
  > "$ROOT/artifacts/load/two-api-a.stdout" 2> "$ROOT/artifacts/load/two-api-a.stderr" &
A=$!
LOAD_TEST_PASSWORD="$PW" $TSX src/load-test/interactive-load.ts run --base-url http://127.0.0.1:3102 --users 50 --first-user 51 \
  --duration-s 150 --ramp-s 20 --api-pid "$P2" --api-log "$ROOT/artifacts/load/api-3102.log" --label two-api-100u-b \
  > "$ROOT/artifacts/load/two-api-b.stdout" 2> "$ROOT/artifacts/load/two-api-b.stderr" &
B=$!
wait $A; EA=$?; wait $B; EB=$?
note two-api-done "\"exit\":[$EA,$EB]"
kill "$P1" "$P2" 2> /dev/null
sleep 2
pkill -f "bench-servers.ts --api-only" 2> /dev/null
note two-api-finished
