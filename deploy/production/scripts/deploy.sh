#!/usr/bin/env bash
# Rolls the stack to a release (RUNBOOK.md, "Deploy"). Images are built and pushed by CI; this host
# only pulls. The schema job runs first (docker-compose.yml `depends_on`), then the API and worker
# are recreated; Caddy holds requests for up to 10 s while a container restarts.
#
#   deploy.sh 2026-10-23-abc1234
set -euo pipefail

RELEASE=${1:?usage: deploy.sh <release tag>}
REPO=${FACTORSAGE_REPO:-/opt/factorsage}
ENV_FILE=/etc/factorsage/compose.env
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$REPO/deploy/production/docker-compose.yml")

sed -i "s/^RELEASE=.*/RELEASE=$RELEASE/" "$ENV_FILE"
"${COMPOSE[@]}" pull web api worker migrate
# A backup first: a migration is the one deploy step that cannot be rolled back by redeploying. The
# database is started (a no-op when it runs) so the first deploy backs up its empty database rather
# than failing on a container that does not exist yet.
"${COMPOSE[@]}" up -d --wait postgres
"$REPO/deploy/production/scripts/backup-postgres.sh"
"${COMPOSE[@]}" up -d --remove-orphans --wait
"${COMPOSE[@]}" ps
docker image prune -f --filter "until=168h" > /dev/null
