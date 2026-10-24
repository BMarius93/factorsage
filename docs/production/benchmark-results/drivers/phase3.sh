#!/usr/bin/env bash
# Phase 3 remaining checks, sequential. Bench database + Redis db 5 only; no provider.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=$ROOT/docs/production/benchmark-results/lru
LOG=$OUT/phase3.log
mkdir -p "$OUT"
BENCH_DB=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
case "$BENCH_DB" in *_bench) ;; *) echo "refusing: not a bench database" >&2; exit 2;; esac
SAMPLE=SYN0001,SYN0002,SYN0100,SYN0300,SYN0500,SYN0735
cd "$ROOT/apps/api"
run() { # name, capacity, args...
  local name=$1 capacity=$2; shift 2
  local started=$(date +%s)
  echo "{\"event\":\"phase3.start\",\"name\":\"$name\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
  env DATABASE_URL="$BENCH_DB" REDIS_URL=redis://localhost:6379/5 STOCK_LRU_MAX_SECURITIES="$capacity" \
    STOCK_CACHE_PROTECTED_SAMPLE=$SAMPLE FMP_API_KEY= RUN_LIVE_FMP_HYDRATION= LOG_LEVEL=warn \
    timeout 5400 "$@" > "$OUT/$name.stdout" 2> "$OUT/$name.stderr"
  local code=$?
  echo "{\"event\":\"phase3.done\",\"name\":\"$name\",\"exit\":$code,\"seconds\":$(( $(date +%s) - started )),\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
}
redis_mem() { redis-cli -n 5 INFO memory | grep -E "^used_memory:|^used_memory_rss:" | tr -d '\r' | tr '\n' ' '; echo; }
TSX=./node_modules/.bin/tsx
VALIDATE=src/cache-benchmark/stock-cache-tier-validation.ts

echo "mem before protect: $(redis_mem)" >> "$LOG"
# 1. The protected tier, rebuilt from PostgreSQL (the recovery path after a Redis loss).
run protect-initial 500 $TSX src/index-universe.ts protect --concurrency 4
echo "mem after protect: $(redis_mem)" >> "$LOG"
run residency-initial 500 $TSX $VALIDATE residency --out "$OUT/residency-initial.json"
# 2. Concurrent readers at capacity 500, then a capacity lowered to 400 under concurrent access.
run concurrency-500 500 $TSX $VALIDATE concurrency --processes 6 --operations 120 --out "$OUT/concurrency-500.json"
echo "mem after concurrency-500: $(redis_mem)" >> "$LOG"
run concurrency-400 400 $TSX $VALIDATE concurrency --processes 6 --operations 60 --out "$OUT/concurrency-400.json"
# 3. Promotion of an LRU member and its demotion back.
run promotion 500 $TSX $VALIDATE promotion --out "$OUT/promotion.json"
run residency-before-restart 500 $TSX $VALIDATE residency --out "$OUT/residency-before-restart.json"
# 4. Redis restart with its snapshot.
echo "restart: $(date -u +%FT%TZ) $(redis_mem)" >> "$LOG"
t0=$(date +%s%N)
redis-cli SHUTDOWN SAVE >> "$LOG" 2>&1
sleep 1
runuser -u redis -- redis-server /etc/redis/redis.conf --daemonize yes >> "$LOG" 2>&1
until redis-cli PING 2>/dev/null | grep -q PONG; do sleep 0.2; done
until [ "$(redis-cli INFO persistence | grep -c '^loading:0')" = "1" ]; do sleep 0.2; done
echo "{\"event\":\"phase3.redis-restarted\",\"ms\":$(( ($(date +%s%N) - t0) / 1000000 ))}" >> "$LOG"
echo "mem after restart: $(redis_mem)" >> "$LOG"
run residency-after-restart 500 $TSX $VALIDATE residency --out "$OUT/residency-after-restart.json"
# 5. Redis loss: flush the benchmark database, rebuild the protected tier from PostgreSQL alone.
redis-cli -n 5 FLUSHDB >> "$LOG" 2>&1
run protect-after-flush 500 $TSX src/index-universe.ts protect --concurrency 4
echo "mem after protect-after-flush: $(redis_mem)" >> "$LOG"
run residency-after-flush 500 $TSX $VALIDATE residency --out "$OUT/residency-after-flush.json"
echo "{\"event\":\"phase3.finished\",\"at\":\"$(date -u +%FT%TZ)\"}" >> "$LOG"
