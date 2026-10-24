#!/usr/bin/env bash
# Backup timing on the benchmark database (23 GB of synthetic history at the end of the benchmarks),
# with the flags deploy/production/scripts/backup-postgres.sh and restore-postgres.sh use:
#  1. a full custom-format zstd:6 dump, streamed and counted rather than stored (this disk cannot
#     hold it), so its duration and compressed size are measured;
#  2. one large table (TABLE, default DailyPrice) dumped to a file and listed;
#  3. with DROP_BENCH=1, the benchmark database dropped to free the disk (the benchmarks are over;
#     `bench:scale-backtests setup` recreates it);
#  4. that table restored — definition, rows, primary key and indexes — into a scratch database with
#     four jobs and --exit-on-error, timed, then the scratch database and the file removed. Its
#     foreign key is left out of the restore list: the table it references is not in the dump.
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
DUMP_FLAGS=(--format=custom --compress=zstd:6)
note() { echo "{\"event\":\"backup.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" >> "$LOG"; }
seconds() { echo $(( $(date +%s) - $1 )); }

note start "\"databaseBytes\":$(psql "$BENCH_DATABASE_URL" -Atc 'select pg_database_size(current_database())'),\"table\":\"$TABLE\",\"tableBytes\":$(psql "$BENCH_DATABASE_URL" -Atc "select pg_total_relation_size('\"$TABLE\"')"),\"tableHeapBytes\":$(psql "$BENCH_DATABASE_URL" -Atc "select pg_table_size('\"$TABLE\"')"),\"pgDump\":\"$(pg_dump --version)\",\"flags\":\"${DUMP_FLAGS[*]}\""
started=$(date +%s)
bytes=$(pg_dump "${DUMP_FLAGS[@]}" "$BENCH_DATABASE_URL" | wc -c)
note full-dump-streamed "\"exit\":${PIPESTATUS[0]},\"seconds\":$(seconds $started),\"dumpBytes\":$bytes"
started=$(date +%s)
pg_dump "${DUMP_FLAGS[@]}" -t "public.\"$TABLE\"" -f "$SCRATCH/table.dump" "$BENCH_DATABASE_URL"
note table-dumped "\"exit\":$?,\"seconds\":$(seconds $started),\"dumpBytes\":$(stat -c %s "$SCRATCH/table.dump"),\"rows\":$(psql "$BENCH_DATABASE_URL" -Atc "select count(*) from \"$TABLE\"")"
pg_restore --list "$SCRATCH/table.dump" | grep -v 'FK CONSTRAINT' > "$SCRATCH/toc.txt"
note table-listed "\"exit\":${PIPESTATUS[0]},\"entries\":$(grep -vc '^;' "$SCRATCH/toc.txt")"
if [ "${DROP_BENCH:-0}" = "1" ]; then
  psql "$ADMIN_URL" -qc "DROP DATABASE intrinsic_value_bench WITH (FORCE)"
  note bench-dropped "\"exit\":$?"
fi
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $RESTORE_DB" && psql "$ADMIN_URL" -qc "CREATE DATABASE $RESTORE_DB"
started=$(date +%s)
pg_restore --jobs=4 --no-owner --exit-on-error -L "$SCRATCH/toc.txt" -d "$RESTORE_URL" "$SCRATCH/table.dump" 2> "$SCRATCH/restore.err"
status=$?
note table-restored "\"exit\":$status,\"seconds\":$(seconds $started),\"rows\":$(psql "$RESTORE_URL" -Atc "select count(*) from \"$TABLE\""),\"restoredBytes\":$(psql "$RESTORE_URL" -Atc "select pg_total_relation_size('\"$TABLE\"')"),\"indexes\":$(psql "$RESTORE_URL" -Atc "select count(*) from pg_indexes where tablename='$TABLE'"),\"errorLines\":$(grep -c . "$SCRATCH/restore.err")"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $RESTORE_DB"
rm -f "$SCRATCH/table.dump" "$SCRATCH/toc.txt"
note finished
