#!/usr/bin/env bash
# The sequential LRU-500 model check, re-run on a fully hydrated ordinary set.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=$ROOT/docs/production/benchmark-results/lru
LOG=$OUT/phase3.log
BENCH_DB=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
case "$BENCH_DB" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
cd "$ROOT/apps/api"
echo "{\"event\":\"phase3.start\",\"name\":\"lru-500\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
started=$(date +%s)
env DATABASE_URL="$BENCH_DB" REDIS_URL=redis://localhost:6379/5 STOCK_LRU_MAX_SECURITIES=500 \
  STOCK_CACHE_PROTECTED_SAMPLE=SYN0001,SYN0002,SYN0100,SYN0300,SYN0500,SYN0735 FMP_API_KEY= RUN_LIVE_FMP_HYDRATION= LOG_LEVEL=warn \
  timeout 7200 ./node_modules/.bin/tsx src/cache-benchmark/stock-cache-tier-validation.ts lru --out "$OUT/lru-500.json" \
  > "$OUT/lru-500.stdout" 2> "$OUT/lru-500.stderr"
echo "{\"event\":\"phase3.done\",\"name\":\"lru-500\",\"exit\":$?,\"seconds\":$(( $(date +%s) - started )),\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
