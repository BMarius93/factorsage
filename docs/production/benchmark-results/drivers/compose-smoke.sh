#!/usr/bin/env bash
# The production stack on this development machine (PRODUCTION-READINESS-REPORT.md §E): the four
# images built from docker/production.Dockerfile and pushed to a local registry, then
# deploy/production/scripts/deploy.sh run as the host runs it — a first deploy and a re-deploy —
# and the health checks, the edge, failover between the two API processes, graceful stops, and
# the backup and restore scripts.
#
#   SCRATCH=<empty dir> WEB_RELEASE=false docs/production/benchmark-results/drivers/compose-smoke.sh
#
# - The build context is the working tree's tracked and unignored files only (what a CI checkout
#   holds, plus uncommitted edits): nothing local — stack logs, storage states — can reach an image.
# - Secrets are throwaway values generated here into /etc/factorsage (0600) and removed at the end;
#   no provider key, no Stripe, no mail server. Nothing secret is written to the log.
# - The edge serves `app.localhost` and `api.localhost`, for which Caddy issues certificates from
#   its own CA; public ACME issuance needs public DNS and is not exercised.
# - WEB_RELEASE=false builds the web image as a non-release build when `pnpm legal:check` still has
#   blockers: a release build refuses to compile until the legal pages are approved.
# - The stack runs from a copy of deploy/production, changed in one place only when this machine has
#   fewer than five CPUs: Docker refuses a CPU limit above the machine's count, so the worker's 5.0
#   is capped at it (the reference host has 8).
set -uo pipefail
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
LOG=$ROOT/docs/production/benchmark-results/compose-smoke.log
SCRATCH=${SCRATCH:?set SCRATCH to an empty scratch directory}
WEB_RELEASE=${WEB_RELEASE:-true}
REV=smoke-$(git -C "$ROOT" rev-parse --short HEAD)
REGISTRY=localhost:5000/factorsage
ETC=/etc/factorsage
DEPLOY=$SCRATCH/repo
COMPOSE=(docker compose --env-file "$ETC/compose.env" -f "$DEPLOY/deploy/production/docker-compose.yml")
CURL=(curl -sk --max-time 20 --resolve api.localhost:443:127.0.0.1 --resolve app.localhost:443:127.0.0.1 --resolve app.localhost:80:127.0.0.1)
note() { echo "{\"event\":\"smoke.$1\",\"at\":\"$(date -u +%FT%TZ)\"${2:+,$2}}" | tee -a "$LOG"; }
seconds() { echo $(( $(date +%s) - $1 )); }
container() { "${COMPOSE[@]}" ps -aq "$1" 2>/dev/null | head -1; }
state() {
  local id; id=$(container "$1")
  [ -n "$id" ] || { echo missing; return; }
  docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}/exit={{.State.ExitCode}}/restarts={{.RestartCount}}' "$id"
}
exitcode() { local id; id=$(container "$1"); if [ -n "$id" ]; then docker inspect -f '{{.State.ExitCode}}' "$id"; else echo null; fi; }
if [ -e "$ETC" ]; then echo "$ETC exists; refusing to overwrite it" >&2; exit 2; fi
# The project is named `factorsage` and is torn down with its volumes: refuse to run beside any other.
if [ -n "$(docker volume ls -q --filter name=factorsage_)" ] || [ -n "$(docker ps -aq --filter label=com.docker.compose.project=factorsage)" ]; then
  echo "a factorsage compose project or volume already exists; refusing" >&2; exit 2
fi

note start "\"release\":\"$REV\",\"webRelease\":$WEB_RELEASE,\"docker\":\"$(docker version -f '{{.Server.Version}}')\",\"compose\":\"$(docker compose version --short)\""

# 1. The build context: a CI checkout's files plus this tree's uncommitted edits.
CONTEXT=$SCRATCH/context
mkdir -p "$CONTEXT"
git -C "$ROOT" ls-files -z -co --exclude-standard | (cd "$ROOT" && tar --null -T - -cf -) | tar -xf - -C "$CONTEXT"
note context "\"files\":$(git -C "$ROOT" ls-files -co --exclude-standard | wc -l),\"bytes\":$(du -sb "$CONTEXT" | cut -f1)"

# 2. Images. The API and worker layers are shared; the web build is the last layer.
build() {
  local target=$1; shift
  local started; started=$(date +%s)
  docker build -f "$CONTEXT/docker/production.Dockerfile" --target "$target" -t "$REGISTRY/$target:$REV" \
    --network host --build-arg HTTPS_PROXY --build-arg NO_PROXY \
    --secret id=build_ca,src=/root/.ccr/ca-bundle.crt "$@" "$CONTEXT" > "$SCRATCH/build-$target.log" 2>&1
  local status=$?
  note build "\"target\":\"$target\",\"exit\":$status,\"seconds\":$(seconds "$started"),\"imageBytes\":$(docker image inspect -f '{{.Size}}' "$REGISTRY/$target:$REV" 2>/dev/null || echo null)"
  return $status
}
build api --build-arg BUILD_WEB=false || exit 1
build worker --build-arg BUILD_WEB=false || exit 1
build migrate --build-arg BUILD_WEB=false || exit 1
build web --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.factorsage.test --build-arg FACTORSAGE_RELEASE_BUILD="$WEB_RELEASE" || exit 1
# The release guard, shown once: the same web build as a release, expected to stop on the legal blockers.
if [ "$WEB_RELEASE" = "false" ]; then
  docker build -f "$CONTEXT/docker/production.Dockerfile" --target web --network host \
    --build-arg HTTPS_PROXY --build-arg NO_PROXY --secret id=build_ca,src=/root/.ccr/ca-bundle.crt \
    --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.factorsage.test "$CONTEXT" > "$SCRATCH/build-web-release.log" 2>&1
  note web-release-guard "\"exit\":$?,\"legalBlockers\":$(grep -oE '[0-9]+ blocker\(s\)' "$SCRATCH/build-web-release.log" | head -1 | grep -oE '^[0-9]+' || echo null)"
fi
for f in api worker migrate web; do
  # Nothing of the development machine inside an image: no .env, storage state, local stack state or tests.
  note image-contents "\"target\":\"$f\",\"forbiddenPaths\":$(docker run --rm --entrypoint sh "$REGISTRY/$f:$REV" -c 'find /repo \( -name ".env" -o -name ".cloud" -o -name ".e2e-stack" -o -path "*/playwright/.auth*" -o -name "*.test.ts" \) 2>/dev/null | wc -l'),\"user\":\"$(docker image inspect -f '{{.Config.User}}' "$REGISTRY/$f:$REV")\""
done

# The deployment files as committed, but for the CPU cap described above.
mkdir -p "$DEPLOY/deploy"
cp -r "$ROOT/deploy/production" "$DEPLOY/deploy/"
cpus=$(nproc)
if [ "$cpus" -lt 5 ]; then
  sed -i "s/limits: { cpus: \"5.0\", memory: 16G }/limits: { cpus: \"$cpus.0\", memory: 16G }/" "$DEPLOY/deploy/production/docker-compose.yml"
  note worker-cpu-limit-capped "\"cpus\":$cpus,\"changedLines\":$(diff "$ROOT/deploy/production/docker-compose.yml" "$DEPLOY/deploy/production/docker-compose.yml" | grep -c '^>')"
fi

# 3. A local registry, as the host pulls from one.
docker rm -f -v smoke-registry > /dev/null 2>&1
docker run -d --name smoke-registry -p 127.0.0.1:5000:5000 registry:2 > /dev/null
for i in $(seq 1 30); do curl -s localhost:5000/v2/ > /dev/null && break; sleep 1; done
for f in api worker migrate web; do docker push -q "$REGISTRY/$f:$REV" > /dev/null || { note push-failed "\"target\":\"$f\""; exit 1; }; done
note pushed

# 4. Configuration: the committed templates' shape with throwaway values.
PG=$(openssl rand -hex 24); RD=$(openssl rand -hex 32); JWT=$(openssl rand -base64 48 | tr -d '\n')
mkdir -m 0700 "$ETC"
mkdir -p "$SCRATCH/backups"
cat > "$ETC/compose.env" <<EOF
APP_DOMAIN=app.localhost
API_DOMAIN=api.localhost
ACME_EMAIL=ops@factorsage.test
REGISTRY=$REGISTRY
RELEASE=placeholder
BACKUP_DIR=$SCRATCH/backups
EOF
cat > "$ETC/postgres.env" <<EOF
POSTGRES_DB=factorsage
POSTGRES_USER=factorsage
POSTGRES_PASSWORD=$PG
EOF
echo "REDIS_PASSWORD=$RD" > "$ETC/redis.env"
cat > "$ETC/migrate.env" <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://factorsage:$PG@postgres:5432/factorsage?connection_limit=2
EOF
cat > "$ETC/api.env" <<EOF
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgresql://factorsage:$PG@postgres:5432/factorsage?connection_limit=20&pool_timeout=10
REDIS_URL=redis://:$RD@redis:6379/0
WEB_BASE_URL=https://app.factorsage.test
CORS_ORIGINS=https://app.factorsage.test
AUTH_JWT_SECRET=$JWT
AUTH_TOKEN_TTL_SECONDS=604800
FMP_API_KEY=smoke-test-placeholder
SMTP_HOST=smtp.factorsage.test
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM=FactorSage <noreply@factorsage.test>
EOF
cat > "$ETC/worker.env" <<EOF
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgresql://factorsage:$PG@postgres:5432/factorsage?connection_limit=6&pool_timeout=30
REDIS_URL=redis://:$RD@redis:6379/0
FMP_API_KEY=smoke-test-placeholder
FMP_MAX_CONCURRENT_REQUESTS=4
FMP_RATE_LIMIT_PER_WINDOW=20
FMP_RATE_WINDOW_MS=1000
EOF
printf 'NODE_ENV=production\nPORT=3000\n' > "$ETC/web.env"
chmod 0600 "$ETC"/*.env

# 5. The first deploy, exactly as RUNBOOK §4 runs it.
started=$(date +%s)
FACTORSAGE_REPO=$DEPLOY "$DEPLOY/deploy/production/scripts/deploy.sh" "$REV" > "$SCRATCH/deploy-1.log" 2>&1
note deploy "\"run\":1,\"exit\":$?,\"seconds\":$(seconds "$started"),\"backups\":$(ls "$SCRATCH/backups" | wc -l)"
for s in caddy web api api-2 worker migrate postgres redis; do note service "\"name\":\"$s\",\"state\":\"$(state $s)\""; done

# 6. The edge and the processes behind it.
# An HTTP status, or null when no response came back (curl's 000).
code() { local c; c=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"); if [ "$c" = "000" ]; then echo null; else echo "$c"; fi; }
note edge "\"apiHealth\":$(code https://api.localhost/health),\"apiReadyFromInternet\":$(code https://api.localhost/health/ready),\"web\":$(code https://app.localhost/),\"httpRedirect\":\"$("${CURL[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' http://app.localhost/ | sed 's/^000 $/none/')\",\"hsts\":$("${CURL[@]}" -D - -o /dev/null https://api.localhost/health | grep -ci '^strict-transport-security'),\"serverHeader\":$("${CURL[@]}" -D - -o /dev/null https://api.localhost/health | grep -ci '^server:'),\"oversizedBody\":$(head -c 2000000 /dev/zero | code -X POST -H 'content-type: application/json' --data-binary @- https://api.localhost/lists)"
ready=$("${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:3001/health/ready').then(async r=>{console.log(r.status+' '+(await r.text()).slice(0,300))}).catch(e=>console.log('ERR '+e.message))")
note api-readiness "\"result\":$(printf '%s' "$ready" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')"
"${COMPOSE[@]}" logs --no-color > "$SCRATCH/logs-after-deploy.txt" 2>&1
note worker-children "\"started\":$(grep -c 'worker.child.started' "$SCRATCH/logs-after-deploy.txt"),\"exited\":$(grep -c 'worker.child.exited' "$SCRATCH/logs-after-deploy.txt")"
note idle-memory "\"containers\":$(docker stats --no-stream --format '{{.Name}}={{.MemUsage}}' | sed 's# / .*##' | python3 -c 'import json,sys; print(json.dumps(dict(l.strip().split("=",1) for l in sys.stdin if "=" in l)))')"

# 7. One API process stopped: the edge keeps answering from the other.
started=$(date +%s)
"${COMPOSE[@]}" stop api-2 > /dev/null 2>&1
note api-2-stopped "\"stopSeconds\":$(seconds "$started"),\"exit\":$(exitcode api-2)"
ok=0; for i in $(seq 1 20); do [ "$(code https://api.localhost/health)" = "200" ] && ok=$((ok+1)); done
note failover "\"healthOkOf20\":$ok"
"${COMPOSE[@]}" start api-2 > /dev/null 2>&1

# 8. Graceful stops: well inside the grace period, never a SIGKILL (137). The API's NestJS shutdown
#    hooks close the server and then re-raise the signal, so it exits 143; the worker and web exit 0.
#    The API first gets an in-flight request — a 60 KB body sent at 6 KB/s, straight to the
#    container — and is stopped 2 s into it: a graceful stop answers it; an abrupt one resets it.
api_ip=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "factorsage_app"}}{{$v.IPAddress}}{{end}}{{end}}' "$(container api)")
python3 -c 'import json; print(json.dumps({"email": "in-flight@factorsage.test", "password": "x" * 60000}))' > "$SCRATCH/slow-body.json"
curl -s --max-time 60 -o /dev/null -w '%{http_code}' --limit-rate 6k -X POST -H 'content-type: application/json' \
  --data-binary @"$SCRATCH/slow-body.json" "http://$api_ip:3001/auth/login" > "$SCRATCH/in-flight.status" 2>/dev/null &
in_flight=$!
sleep 2
started=$(date +%s)
"${COMPOSE[@]}" stop api > /dev/null 2>&1
wait $in_flight
note in-flight-through-stop "\"service\":\"api\",\"stopSeconds\":$(seconds "$started"),\"exit\":$(exitcode api),\"inFlightStatus\":\"$(cat "$SCRATCH/in-flight.status")\""
"${COMPOSE[@]}" start api > /dev/null 2>&1
for s in worker api web; do
  started=$(date +%s)
  "${COMPOSE[@]}" stop "$s" > /dev/null 2>&1
  note graceful-stop "\"service\":\"$s\",\"seconds\":$(seconds "$started"),\"exit\":$(exitcode "$s")"
  "${COMPOSE[@]}" start "$s" > /dev/null 2>&1
done
"${COMPOSE[@]}" logs --no-color worker > "$SCRATCH/logs-worker-stop.txt" 2>&1
note worker-shutdown-events "\"lines\":$(grep -cE 'shutdown|stopping|SIGTERM' "$SCRATCH/logs-worker-stop.txt")"

# 9. A re-deploy of the same release: backup taken, nothing recreated.
before=$("${COMPOSE[@]}" ps -q | sort | md5sum | cut -c1-8)
started=$(date +%s)
FACTORSAGE_REPO=$DEPLOY "$DEPLOY/deploy/production/scripts/deploy.sh" "$REV" > "$SCRATCH/deploy-2.log" 2>&1
note deploy "\"run\":2,\"exit\":$?,\"seconds\":$(seconds "$started"),\"backups\":$(ls "$SCRATCH/backups" | wc -l),\"containersUnchanged\":$([ "$before" = "$("${COMPOSE[@]}" ps -q | sort | md5sum | cut -c1-8)" ] && echo true || echo false)"

# 10. The restore script on the newest backup, into a new database.
dump=$(ls -t "$SCRATCH/backups" | head -1)
started=$(date +%s)
FACTORSAGE_REPO=$DEPLOY "$DEPLOY/deploy/production/scripts/restore-postgres.sh" "$SCRATCH/backups/$dump" factorsage_restore > "$SCRATCH/restore.log" 2>&1
status=$?
count() { "${COMPOSE[@]}" exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d $1 -Atc 'select count(*) from \"_prisma_migrations\"'"; }
note restore "\"exit\":$status,\"seconds\":$(seconds "$started"),\"dumpBytes\":$(stat -c %s "$SCRATCH/backups/$dump"),\"migrationsLive\":$(count factorsage),\"migrationsRestored\":$(count factorsage_restore)"
FACTORSAGE_REPO=$DEPLOY "$DEPLOY/deploy/production/scripts/restore-postgres.sh" "$SCRATCH/backups/$dump" factorsage_restore > /dev/null 2>&1
note restore-over-existing-refused "\"exit\":$?"

# 11. The logs hold no secret; then everything is removed.
"${COMPOSE[@]}" logs --no-color > "$SCRATCH/logs-final.txt" 2>&1
note secrets-in-logs "\"count\":$(cat "$SCRATCH"/logs-*.txt "$SCRATCH"/deploy-*.log "$SCRATCH/restore.log" | grep -cF -e "$PG" -e "$RD" -e "$JWT")"
for s in caddy web api api-2 worker postgres redis; do note service-final "\"name\":\"$s\",\"state\":\"$(state $s)\""; done
"${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1
docker rm -f -v smoke-registry > /dev/null 2>&1
rm -rf "$ETC" "$CONTEXT" "$DEPLOY"
note finished
