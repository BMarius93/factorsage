#!/usr/bin/env bash
# Phase 4 main matrix: 30-year runs unless stated, four workers, synthetic provider.
# READ_MODE: the frame-read option the matrix runs with (empty = the code default, STORE).
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
LOG=$ROOT/docs/production/benchmark-results/phase4.log
export BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
export BENCH_REDIS_URL=redis://localhost:6379/5
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
READ_MODE=${READ_MODE:-}
MODE_ARGS=()
if [ -n "$READ_MODE" ]; then MODE_ARGS=(--worker-env "BACKTEST_NON_RESIDENT_FRAME_READ=$READ_MODE"); fi
cd "$ROOT/apps/api"
redis-cli CONFIG SET save "900 1 300 100000" >> "$LOG"
bench() { # label, args... (skipped when a report for the label already exists: resumable)
  local label=$1; shift
  if grep -q "\"label\":\"$label\"" "$ROOT/docs/production/benchmark-results/scale-backtests.jsonl" 2>/dev/null; then
    echo "{\"event\":\"phase4.skipped\",\"label\":\"$label\"}" >> "$LOG"; return; fi
  echo "{\"event\":\"phase4.start\",\"label\":\"$label\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
  local started=$(date +%s)
  env -u FMP_API_KEY -u RUN_LIVE_FMP_HYDRATION timeout 14400 ./node_modules/.bin/tsx src/backtest-benchmark/scale-backtest-benchmark.ts run --label "$label" "${MODE_ARGS[@]}" "$@" \
    > "$ROOT/artifacts/scale-benchmark/$label.stdout" 2> "$ROOT/artifacts/scale-benchmark/$label.stderr"
  echo "{\"event\":\"phase4.done\",\"label\":\"$label\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started )),\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
}
# Four at once, the global cap: cold (Redis flushed: everything rebuilt from PostgreSQL), then warm, three times.
bench H-cold-mixed-shared   --scenario H --cache cold --mix mixed --overlap shared --strategy simple
bench H-warm-mixed-shared-1 --scenario H --cache warm --mix mixed --overlap shared --strategy simple
bench H-warm-mixed-shared-2 --scenario H --cache warm --mix mixed --overlap shared --strategy simple
# The sizing case: four 1,000-security runs at once.
bench I-warm-mixed-shared   --scenario I --cache warm --mix mixed --overlap shared --strategy simple
# Each plan's largest run alone, warm; the smaller ones three times for their spread.
for s in A B C D E F; do bench "$s-warm-mixed" --scenario $s --cache warm --mix mixed --strategy simple; done
for r in 2 3; do for s in A B C; do bench "$s-warm-mixed-$r" --scenario $s --cache warm --mix mixed --strategy simple; done; done
bench F-warm-mixed-2 --scenario F --cache warm --mix mixed --strategy simple
# Pro+ simultaneity: two of one owner's 1,000-security runs at once.
bench G-warm-mixed --scenario G --cache warm --mix mixed --overlap shared --strategy simple
# Strategy complexity at Pro x 500, and once at the four-way load.
for st in monthly sector complex; do bench "D-warm-mixed-$st" --scenario D --cache warm --mix mixed --strategy $st; done
bench H-warm-mixed-shared-complex --scenario H --cache warm --mix mixed --overlap shared --strategy complex
# The LRU's worst cases: 1,000 ordinary securities in one run, and four runs whose ordinary members
# (1,400 in all) span the whole 1,000-security pool.
bench F-ordinary-30y --scenario F --cache warm --mix ordinary --strategy simple --timeout-minutes 180
bench H-warm-mixed-disjoint --scenario H --cache warm --mix mixed --overlap disjoint --strategy simple --timeout-minutes 180
echo "{\"event\":\"phase4b.finished\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
