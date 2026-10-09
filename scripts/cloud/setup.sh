#!/usr/bin/env bash
#
# Provisions a Claude cloud VM for FactorSage development and QA.
#
# Called by the cloud environment's setup script, as root, after the repository is cloned and
# before Claude Code starts. Whatever it leaves on disk is snapshotted and reused by later sessions,
# so it installs everything slow — the exact Node and pnpm, dependencies, Prisma engines, the
# Playwright browser, Mailpit and the Stripe CLI — and migrates empty databases. Nothing it starts
# survives the snapshot, so it stops the services again at the end; session-start.sh starts them in
# every session and repairs anything this left behind.
#
# Idempotent: each step checks what is already there. It never fails the session, because a VM
# that cannot start cannot be debugged: every step's result is written to
# /var/lib/factorsage-cloud/setup-status, and session-start.sh reports and repairs failures.
set -uo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

if [ "$(uname -s)" != "Linux" ]; then
  cloud_log "setup.sh provisions the Linux cloud VM; refusing to run on $(uname -s)."
  exit 1
fi
if [ "$(id -u)" != "0" ]; then
  cloud_log "setup.sh must run as root, which the cloud environment's setup script does."
  exit 1
fi

mkdir -p "$CLOUD_STATE_DIR/steps"
rm -f "$CLOUD_STATE_DIR"/steps/*
SETUP_LOG="$CLOUD_STATE_DIR/setup.log"
: >"$SETUP_LOG"
started_at="$(date +%s)"

# A step returns this when it has nothing to do in this context; it is recorded as skipped.
STEP_SKIPPED=3

# run_step <name> <function>: runs one step with its output in the setup log, records the outcome.
run_step() {
  local name="$1" step_started status outcome
  step_started="$(date +%s)"
  "$2" >>"$SETUP_LOG" 2>&1
  status=$?
  case "$status" in
    0) outcome=ok ;;
    "$STEP_SKIPPED") outcome=skipped ;;
    *) outcome=failed ;;
  esac
  echo "$outcome $(($(date +%s) - step_started))s" >"$CLOUD_STATE_DIR/steps/$name"
}

step_ok() {
  grep -q '^ok' "$CLOUD_STATE_DIR/steps/$1" 2>/dev/null
}

step_toolchain() {
  cloud_install_node && cloud_install_pnpm
}

step_dependencies() {
  cloud_use_toolchain
  cd "$CLOUD_REPO_ROOT" && pnpm install --frozen-lockfile && pnpm db:generate
}

step_tools() {
  cloud_install_tools
}

step_databases() {
  # The environment's variables are not always visible to the setup script. Without them there is
  # nothing to provision against; session-start.sh creates and migrates the databases instead.
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is not visible to the setup script; session-start.sh provisions the databases."
    return "$STEP_SKIPPED"
  fi
  cloud_use_toolchain
  cloud_assert_safe &&
    cloud_start_postgres &&
    cloud_start_redis &&
    bash "$CLOUD_LIB_DIR/provision-databases.sh" &&
    (cd "$CLOUD_REPO_ROOT" && pnpm db:migrate:deploy && pnpm db:test:prepare)
}

step_playwright() {
  cloud_use_toolchain
  cloud_playwright_browsers_ready || cloud_install_playwright
}

run_step toolchain step_toolchain

if step_ok toolchain; then
  # Independent downloads in parallel, to stay inside the window the environment cache needs.
  run_step tools step_tools &
  run_step dependencies step_dependencies
  wait
  if step_ok dependencies; then
    run_step playwright step_playwright &
    run_step databases step_databases
    wait
  fi
else
  run_step tools step_tools
fi

# The snapshot keeps files, never processes; stop cleanly so the data directory is consistent.
service postgresql stop >>"$SETUP_LOG" 2>&1 || true
service redis-server stop >>"$SETUP_LOG" 2>&1 || true

{
  echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ) after $(($(date +%s) - started_at))s"
  for name in toolchain tools dependencies playwright databases; do
    printf '%s %s\n' "$name" "$(cat "$CLOUD_STATE_DIR/steps/$name" 2>/dev/null || echo skipped)"
  done
} | tee "$CLOUD_STATE_DIR/setup-status"

exit 0
