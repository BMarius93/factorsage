#!/usr/bin/env bash
# Backup timing on the benchmark database (23 GB of synthetic history at the end of the benchmarks):
#  1. a full custom-format dump, as backup-postgres.sh takes it, streamed and counted rather than
#     stored (this disk cannot hold it), so its duration and compressed size are measured;
#  2. one large table (TABLE, default DailyPrice) dumped to a file;
#  3. with DROP_BENCH=1, the benchmark database dropped to free the disk (the benchmarks are over;
#     `bench:scale-backtests setup` recreates it);
#  4. that table restored — definition, rows, primary key and indexes — into a scratch database with
#     four jobs, timed, then the scratch database and the file removed.
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

note start "\"databaseBytes\":$(psql "$BENCH_DATABASE_URL" -Atc 'select pg_database_size(current_database())'),\"tableBytes\":$(psql "$BENCH_DATABASE_URL" -Atc "select pg_total_relation_size('\"$TABLE\"')")"
started=$(date +%s)
bytes=$(pg_dump -Fc -Z 6 "$BENCH_DATABASE_URL" | wc -c)
note full-dump-streamed "\"exit\":${PIPESTATUS[0]},\"seconds\":$(seconds $started),\"dumpBytes\":$bytes"
started=$(date +%s)
pg_dump -Fc -Z 6 -t "public.\"$TABLE\"" -f "$SCRATCH/table.dump" "$BENCH_DATABASE_URL"
note table-dumped "\"table\":\"$TABLE\",\"exit\":$?,\"seconds\":$(seconds $started),\"dumpBytes\":$(stat -c %s "$SCRATCH/table.dump")"
pg_restore --list "$SCRATCH/table.dump" > "$SCRATCH/toc.txt"
note table-verified "\"exit\":$?,\"entries\":$(grep -vc '^;' "$SCRATCH/toc.txt")"
if [ "${DROP_BENCH:-0}" = "1" ]; then
  psql "$ADMIN_URL" -qc "DROP DATABASE intrinsic_value_bench WITH (FORCE)"
  note bench-dropped "\"exit\":$?"
fi
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $RESTORE_DB" && psql "$ADMIN_URL" -qc "CREATE DATABASE $RESTORE_DB"
started=$(date +%s)
pg_restore -j 4 --no-owner -d "$RESTORE_URL" "$SCRATCH/table.dump" 2> "$SCRATCH/restore.err"
status=$?
note table-restored "\"table\":\"$TABLE\",\"exit\":$status,\"seconds\":$(seconds $started),\"rows\":$(psql "$RESTORE_URL" -Atc "select count(*) from \"$TABLE\""),\"restoredBytes\":$(psql "$RESTORE_URL" -Atc "select pg_total_relation_size('\"$TABLE\"')"),\"indexes\":$(psql "$RESTORE_URL" -Atc "select count(*) from pg_indexes where tablename='$TABLE'"),\"errorLines\":$(grep -c . "$SCRATCH/restore.err")"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $RESTORE_DB"
rm -f "$SCRATCH/table.dump" "$SCRATCH/toc.txt"
note finished
