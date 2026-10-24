#!/usr/bin/env bash
# The live admission and entitlement probes again, after fixing their submission body (it lacked
# `maximumPositions`, so every probe submission was refused as BACKTEST_INVALID before any limit
# was reached). One API process, no worker executing, the queue empty.
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
rm -f "$ROOT/artifacts/load/servers-3101.json"
env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION $TSX src/load-test/bench-servers.ts --api-only --api-port 3101 \
  > "$ROOT/artifacts/load/servers-probes.stdout" 2> "$ROOT/artifacts/load/servers-probes.stderr" &
until [ -s "$ROOT/artifacts/load/servers-3101.json" ]; do sleep 2; done
P=$(python3 -c "import json;print(json.load(open('$ROOT/artifacts/load/servers-3101.json'))['api']['pid'])")
queued=$(psql "$BENCH_DATABASE_URL" -Atc "select count(*) from \"BacktestJob\" where status in ('QUEUED','CLAIMED')")
note probes-rerun-ready "\"apiPid\":$P,\"queuedOrClaimed\":$queued"
LOAD_TEST_PASSWORD="$PW" $TSX src/load-test/interactive-load.ts setup --users 100 > /dev/null 2> "$ROOT/artifacts/load/setup-probes.stderr"
LOAD_TEST_PASSWORD="$PW" $TSX src/load-test/submission-probes.ts --base-url http://127.0.0.1:3101 --saturate 100 \
  > "$ROOT/artifacts/load/probes-rerun.stdout" 2> "$ROOT/artifacts/load/probes-rerun.stderr"
note probes-rerun-done "\"exit\":$?"
kill "$P" 2> /dev/null
sleep 2
pkill -f "bench-servers.ts --api-only" 2> /dev/null
