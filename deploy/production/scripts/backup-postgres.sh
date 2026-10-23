#!/usr/bin/env bash
# Nightly logical backup of the FactorSage database (docs/production/RUNBOOK.md, "Backups").
#
#   /opt/factorsage/deploy/production/scripts/backup-postgres.sh
#
# Writes a compressed custom-format dump to $BACKUP_DIR (mounted into the container at /backups),
# verifies it is readable, optionally copies it off the host with rclone, and prunes old dumps.
# Run it from a systemd timer or cron as root; it needs no secret of its own (the container's
# superuser is used through `docker compose exec`).
set -euo pipefail

REPO=${FACTORSAGE_REPO:-/opt/factorsage}
COMPOSE=(docker compose --env-file /etc/factorsage/compose.env -f "$REPO/deploy/production/docker-compose.yml")
BACKUP_DIR=${BACKUP_DIR:-/var/backups/factorsage}
RETAIN_DAYS=${RETAIN_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="factorsage-$STAMP.dump"

started=$(date +%s)
"${COMPOSE[@]}" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=zstd:6 --file="/backups/'"$FILE"'"'
# A dump nobody can list is not a backup.
"${COMPOSE[@]}" exec -T postgres pg_restore --list "/backups/$FILE" > /dev/null
size=$(stat -c %s "$BACKUP_DIR/$FILE")

if [ -n "${BACKUP_REMOTE:-}" ]; then
  # e.g. BACKUP_REMOTE=b2:factorsage-backups/postgres — configured in rclone's own config.
  rclone copy "$BACKUP_DIR/$FILE" "$BACKUP_REMOTE"
fi

find "$BACKUP_DIR" -name 'factorsage-*.dump' -mtime +"$RETAIN_DAYS" -delete
printf '{"event":"backup.postgres.completed","file":"%s","bytes":%s,"durationS":%s,"remote":%s}\n' \
  "$FILE" "$size" "$(( $(date +%s) - started ))" "$([ -n "${BACKUP_REMOTE:-}" ] && echo true || echo false)"
