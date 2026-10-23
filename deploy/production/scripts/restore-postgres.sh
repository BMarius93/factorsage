#!/usr/bin/env bash
# Restores a dump into a NEW database, for a restore drill or a recovery (RUNBOOK.md, "Restore").
#
#   restore-postgres.sh /var/backups/factorsage/factorsage-20261023T020000Z.dump factorsage_restore
#
# Never restores over the live database: the target must not exist. Point the applications at it
# only after checking it (row counts, `prisma migrate status`), by changing DATABASE_URL.
set -euo pipefail

DUMP=${1:?usage: restore-postgres.sh <dump file> <new database name>}
TARGET=${2:?usage: restore-postgres.sh <dump file> <new database name>}
REPO=${FACTORSAGE_REPO:-/opt/factorsage}
COMPOSE=(docker compose --env-file /etc/factorsage/compose.env -f "$REPO/deploy/production/docker-compose.yml")

case "$TARGET" in
  *[!a-z0-9_]*) echo "database name must be [a-z0-9_]" >&2; exit 2 ;;
esac
NAME=$(basename "$DUMP")

if "${COMPOSE[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '"'$TARGET'"'"' | grep -q 1; then
  echo "database $TARGET already exists; refusing to restore over it" >&2
  exit 1
fi
started=$(date +%s)
"${COMPOSE[@]}" exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" '"$TARGET"
"${COMPOSE[@]}" exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d '"$TARGET"' --jobs=4 --no-owner --exit-on-error "/backups/'"$NAME"'"'
printf '{"event":"restore.postgres.completed","database":"%s","durationS":%s}\n' "$TARGET" "$(( $(date +%s) - started ))"
