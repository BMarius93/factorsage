#!/usr/bin/env bash
# Backup timing on the benchmark database: a full custom-format dump (as backup-postgres.sh takes it),
# its verification, and a timed restore of one large table — definition, rows, primary key and
# indexes — into a scratch database (the whole database does not fit twice on this disk).
# Writes only to SCRATCH and to the scratch database, both removed at the end.
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
LOG=$ROOT/docs/production/benchmark-results/backup-drill.log
BENCH_DATABASE_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/intrinsic_value_bench#')
case "$BENCH_DATABASE_URL" in *_bench) ;; *) echo "refusing" >&2; exit 2;; esac
SCRATCH=${SCRATCH:?set SCRATCH to an empty scratch directory}
TABLE=${TABLE:-DailyPrice}
RESTORE_DB=intrinsic_value_restore_drill
ADMIN_URL=$(echo "$DATABASE_URL" | sed 's#/intrinsic_value$#/postgres#')
RESTORE_URL=$(echo "$DATABASE_URL" | sed "s#/intrinsic_value\$#/$RESTORE_DB#")
note() { echo "{\"event\":\"backup.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" >> "$LOG"; }
seconds() { echo $(( $(date +%s) - $1 )); }

note start "\"databaseBytes\":$(psql "$BENCH_DATABASE_URL" -Atc 'select pg_database_size(current_database())')"
started=$(date +%s)
pg_dump -Fc -Z 6 -f "$SCRATCH/bench.dump" "$BENCH_DATABASE_URL"
note dumped "\"exit\":$?,\"seconds\":$(seconds $started),\"dumpBytes\":$(stat -c %s "$SCRATCH/bench.dump")"
started=$(date +%s)
pg_restore --list "$SCRATCH/bench.dump" > "$SCRATCH/toc.txt"
note verified "\"exit\":$?,\"seconds\":$(seconds $started),\"entries\":$(grep -vc '^;' "$SCRATCH/toc.txt")"
# The table, its rows, its primary key and its indexes; never foreign keys (their targets are empty).
grep -E "^[0-9]+; [0-9]+ [0-9]+ (TABLE|TABLE DATA|CONSTRAINT|INDEX) public \"?$TABLE\"?[_ ]" "$SCRATCH/toc.txt" \
  | grep -v "FK CONSTRAINT" > "$SCRATCH/toc-table.txt"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $RESTORE_DB" && psql "$ADMIN_URL" -qc "CREATE DATABASE $RESTORE_DB"
pg_restore --section=pre-data --schema-only -d "$RESTORE_URL" "$SCRATCH/bench.dump" 2> "$SCRATCH/types.err" || true
psql "$RESTORE_URL" -qc "DROP TABLE IF EXISTS public.\"$TABLE\" CASCADE"
started=$(date +%s)
pg_restore -j 4 -L "$SCRATCH/toc-table.txt" -d "$RESTORE_URL" "$SCRATCH/bench.dump" 2> "$SCRATCH/table.err"
status=$?
note table-restored "\"table\":\"$TABLE\",\"exit\":$status,\"seconds\":$(seconds $started),\"tocEntries\":$(wc -l < "$SCRATCH/toc-table.txt"),\"rows\":$(psql "$RESTORE_URL" -Atc "select count(*) from \"$TABLE\""),\"tableBytes\":$(psql "$RESTORE_URL" -Atc "select pg_total_relation_size('\"$TABLE\"')"),\"errors\":$(grep -c 'error' "$SCRATCH/table.err")"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $RESTORE_DB"
rm -f "$SCRATCH/bench.dump" "$SCRATCH/toc.txt" "$SCRATCH/toc-table.txt"
note finished
