#!/usr/bin/env bash
#
# Creates the development PostgreSQL role and the three local databases, idempotently.
#
#   role      from DATABASE_URL (intrinsic), LOGIN CREATEDB, never superuser — CREATEDB is what
#             `pnpm db:check-drift`, Prisma's shadow database and `pnpm qa:matrix:provision` need
#   databases DATABASE_URL (dev), TEST_DATABASE_URL (test), QA_MATRIX_DATABASE_URL (matrix),
#             each owned by that role
#
# It only ever creates what is missing and re-asserts the role's attributes and ownership. It drops,
# truncates and migrates nothing; session-start.sh runs the migrations. Talks to the local server
# as the `postgres` superuser over its Unix socket, and refuses unless every URL names this machine.
set -euo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

cloud_assert_safe

dev_url="${DATABASE_URL:-}"
test_url="${TEST_DATABASE_URL:-}"
matrix_url="${QA_MATRIX_DATABASE_URL:-}"
for name in DATABASE_URL TEST_DATABASE_URL QA_MATRIX_DATABASE_URL; do
  if [ -z "${!name:-}" ]; then
    cloud_log "$name is not set; add it to the Claude environment (see the runbook)."
    exit 1
  fi
done

role="$(cloud_url_field user "$dev_url")"
password="$(cloud_url_field password "$dev_url")"
dev_db="$(cloud_url_field database "$dev_url")"
test_db="$(cloud_url_field database "$test_url")"
matrix_db="$(cloud_url_field database "$matrix_url")"

for url in "$test_url" "$matrix_url"; do
  if [ "$(cloud_url_field user "$url")" != "$role" ]; then
    cloud_log "DATABASE_URL, TEST_DATABASE_URL and QA_MATRIX_DATABASE_URL must use the same role."
    exit 1
  fi
done

# Identifiers are interpolated with format(%I) below, but anything unexpected is refused outright.
for identifier in "$role" "$dev_db" "$test_db" "$matrix_db"; do
  case "$identifier" in
    "" | *[!a-z0-9_]*)
      cloud_log "Refusing unexpected role/database name '$identifier' (lower-case letters, digits, _)."
      exit 1
      ;;
  esac
done
if [ -z "$password" ]; then
  cloud_log "DATABASE_URL carries no password; the role needs one for TCP connections."
  exit 1
fi
if [ "$dev_db" = "$test_db" ] || [ "$dev_db" = "$matrix_db" ] || [ "$test_db" = "$matrix_db" ]; then
  cloud_log "The development, test and matrix databases must be three different databases."
  exit 1
fi
case "$matrix_db" in
  *matrix*) ;;
  *)
    cloud_log "QA_MATRIX_DATABASE_URL must name a database containing 'matrix' (the matrix runner's own rule)."
    exit 1
    ;;
esac

cloud_as_postgres psql -X -q -v ON_ERROR_STOP=1 \
  -v role="$role" -v password="$password" \
  -v dev="$dev_db" -v test="$test_db" -v matrix="$matrix_db" <<'SQL'
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
           THEN format('ALTER ROLE %I WITH LOGIN CREATEDB NOSUPERUSER PASSWORD %L', :'role', :'password')
         ELSE format('CREATE ROLE %I WITH LOGIN CREATEDB NOSUPERUSER PASSWORD %L', :'role', :'password')
       END
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', name, :'role')
  FROM unnest(ARRAY[:'dev', :'test', :'matrix']) AS name
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', name, :'role')
  FROM unnest(ARRAY[:'dev', :'test', :'matrix']) AS name
\gexec
SQL

cloud_log "PostgreSQL: role $role; databases $dev_db, $test_db, $matrix_db present."
