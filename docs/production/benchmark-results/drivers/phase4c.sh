#!/usr/bin/env bash
# True provider misses (synthetic provider): securities absent from Redis AND PostgreSQL are
# downloaded, normalized, persisted, derived and projected inside the run's preparation.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
LOG=$ROOT/docs/production/benchmark-results/phase4.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
cd "$ROOT/apps/api"
TSX=./node_modules/.bin/tsx
bench() { # label, args... (resumable)
  local label=$1; shift
  if grep -q "\"label\":\"$label\"" "$ROOT/docs/production/benchmark-results/scale-backtests.jsonl" 2>/dev/null; then
    echo "{\"event\":\"phase4.skipped\",\"label\":\"$label\"}" >> "$LOG"; return; fi
  echo "{\"event\":\"phase4.start\",\"label\":\"$label\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
  local started=$(date +%s)
  env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION timeout 10800 $TSX src/backtest-benchmark/scale-backtest-benchmark.ts run --label "$label" "$@" \
    > "$ROOT/artifacts/scale-benchmark/$label.stdout" 2> "$ROOT/artifacts/scale-benchmark/$label.stderr"
  echo "{\"event\":\"phase4.done\",\"label\":\"$label\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started )),\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
}
synthetic() { # restart the synthetic provider with these options
  pkill -f "synthetic-fmp-server.ts"; sleep 1
  nohup $TSX src/backtest-benchmark/synthetic-fmp-server.ts --port 4790 --universe 4000 "$@" > "$ROOT/artifacts/scale-benchmark/synthetic-fmp.log" 2>&1 &
  until curl -sf http://127.0.0.1:4790/__synthetic/health > /dev/null; do sleep 0.5; done
  echo "{\"event\":\"phase4.synthetic\",\"args\":\"$*\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
}
redis-cli CONFIG SET save "900 1 300 100000" > /dev/null
synthetic
# Pro x 250, 60 % canonical universe (resident) and 100 never-hydrated securities.
bench C-miss-mixed --scenario C --cache miss --mix mixed --strategy simple
# Starter x 50 (20 never-hydrated), with 250 ms added to every provider answer.
synthetic --latency-ms 250
export BENCH_FMP_LATENCY_MS=250
bench B-miss-mixed-latency250 --scenario B --cache miss --mix mixed --strategy simple
unset BENCH_FMP_LATENCY_MS
synthetic
echo "{\"event\":\"phase4c.finished\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
