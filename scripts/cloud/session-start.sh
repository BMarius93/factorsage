#!/usr/bin/env bash
#
# SessionStart hook (.claude/settings.json) for Claude cloud sessions. Everywhere else — a local
# Claude Code session, CI, a developer's shell — it exits immediately and changes nothing.
#
# In a cloud session it makes the VM ready for work, in this order:
#
#   1. the environment guard: refuse production, any non-loopback database or Redis and any live
#      Stripe key; blank every provider credential or opt-in that must never be ambient
#   2. the pinned Node/pnpm first on PATH for every later command (via CLAUDE_ENV_FILE)
#   3. PostgreSQL, Redis and Mailpit started; the role and the three databases ensured
#   4. dependencies installed for this branch, the Prisma client generated, dev and test migrated
#   5. the Playwright browser this branch's lockfile pins, installed if missing
#
# It never starts an application stack and never seeds data. stdout becomes context for Claude, so
# it prints a short summary only; the details go to .cloud/logs/session-start.log. No value of any
# variable is ever printed.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

set -uo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

mkdir -p "$CLOUD_RUNTIME_DIR/logs"
LOG="$CLOUD_RUNTIME_DIR/logs/session-start.log"
: >"$LOG"
ENV_FILE="${CLAUDE_ENV_FILE:-}"
PROBLEMS=""
STARTED_AT="$(date +%s)"

persist() {
  if [ -n "$ENV_FILE" ]; then
    printf '%s\n' "$1" >>"$ENV_FILE"
  fi
}

problem() {
  PROBLEMS="${PROBLEMS}- $1
"
}

# step <description> <command...>: runs quietly into the log, records a problem on failure.
step() {
  local description="$1"
  shift
  printf '\n== %s\n' "$description" >>"$LOG"
  if "$@" >>"$LOG" 2>&1; then
    return 0
  fi
  problem "$description failed (see .cloud/logs/session-start.log)"
  return 1
}

# 1. Guard ------------------------------------------------------------------------------------
cloud_evaluate_environment
rm -f "$CLOUD_RUNTIME_DIR/REFUSED"
if [ -n "$CLOUD_REFUSALS" ]; then
  printf '%s' "$CLOUD_REFUSALS" >"$CLOUD_RUNTIME_DIR/REFUSED"
fi
# A refused variable is blanked as well, so no command later in the session — a seed, a reset, a
# migration typed by hand — can act on the production database or live key it named.
for name in $CLOUD_REFUSED_VARS $CLOUD_NEUTRALIZE; do
  export "$name="
  persist "export $name="
done

# 2. Toolchain --------------------------------------------------------------------------------
persist "export PATH=\"$(cloud_node_prefix)/bin:$CLOUD_TOOLS_DIR:\$PATH\""
persist "export PLAYWRIGHT_BROWSERS_PATH=\"$(cloud_playwright_browsers_path)\""
persist "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
persist "export STRIPE_CLI_TELEMETRY_OPTOUT=1"
persist "export NEXT_TELEMETRY_DISABLED=1"
persist "export CHECKPOINT_DISABLE=1"
cloud_use_toolchain
step "Node $(cloud_node_version)" cloud_install_node
step "pnpm $(cloud_pnpm_version)" cloud_install_pnpm

if [ -n "$CLOUD_REFUSALS" ]; then
  echo "FactorSage cloud environment: REFUSED — nothing was provisioned."
  printf '%s' "$CLOUD_REFUSALS"
  echo "Blanked for this session:$CLOUD_REFUSED_VARS$CLOUD_NEUTRALIZE"
  echo "Fix the Claude environment variables, then start a new session."
  exit 0
fi

# 3. Services and databases -------------------------------------------------------------------
step "PostgreSQL" cloud_start_postgres
step "Redis" cloud_start_redis
if ! [ -x "$CLOUD_TOOLS_DIR/mailpit" ] || ! [ -x "$CLOUD_TOOLS_DIR/stripe" ]; then
  step "Mailpit and Stripe CLI install" cloud_install_tools
fi
step "Mailpit" cloud_start_mailpit
step "database provisioning" bash "$CLOUD_LIB_DIR/provision-databases.sh"

# 4. Dependencies and migrations --------------------------------------------------------------
cd "$CLOUD_REPO_ROOT" || exit 0
databases_state="NOT migrated"
if step "pnpm install" pnpm install --frozen-lockfile --prefer-offline &&
  step "Prisma client" pnpm db:generate &&
  step "development database migrations" pnpm db:migrate:deploy &&
  step "test database migrations" pnpm db:test:prepare; then
  databases_state="dev + test migrated to this branch"
fi

# 5. Playwright -------------------------------------------------------------------------------
playwright_version="$(pnpm --filter @intrinsic/web exec playwright --version 2>/dev/null | sed 's/^Version //')"
if ! cloud_playwright_browsers_ready; then
  step "Playwright ${playwright_version:-?} Chromium install" cloud_install_playwright
fi

# Summary -------------------------------------------------------------------------------------
present() {
  if [ -n "${!1:-}" ]; then echo "set"; else echo "not set"; fi
}
stripe_state="not configured"
if [ -n "${SANDBOX_STRIPE_SECRET_KEY:-}" ]; then
  stripe_state="sandbox configured — only through scripts/cloud/with-stripe.sh or stack.sh --stripe"
fi
google_state="off"
if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  google_state="configured"
fi

echo "FactorSage cloud environment, prepared in $(($(date +%s) - STARTED_AT))s (docs/development/claude-cloud-environment.md)"
echo "- toolchain: node $(node -v 2>/dev/null || echo missing), pnpm $(pnpm --version 2>/dev/null || echo missing), Playwright ${playwright_version:-missing} at $PLAYWRIGHT_BROWSERS_PATH"
echo "- services: PostgreSQL 127.0.0.1:5432, Redis 127.0.0.1:6379, Mailpit SMTP 127.0.0.1:$CLOUD_MAILPIT_SMTP_PORT / UI+API 127.0.0.1:$CLOUD_MAILPIT_HTTP_PORT"
echo "- databases: $databases_state; matrix database exists (pnpm qa:matrix:provision migrates it)"
echo "- FMP: no key in the runtime environment (LIVE_FMP_API_KEY $(present LIVE_FMP_API_KEY); no live-FMP command exists yet)"
echo "- Stripe: $stripe_state"
echo "- Google sign-in: $google_state"
if [ -n "$CLOUD_NEUTRALIZE" ]; then
  echo "- blanked for this session (must never be ambient):$CLOUD_NEUTRALIZE"
fi
if [ -f "$CLOUD_STATE_DIR/setup-status" ] && grep -q ' failed' "$CLOUD_STATE_DIR/setup-status"; then
  echo "- environment snapshot had failed setup steps (repaired above where possible): $(grep ' failed' "$CLOUD_STATE_DIR/setup-status" | cut -d' ' -f1 | tr '\n' ' ')"
fi
if [ -n "$PROBLEMS" ]; then
  echo "PROBLEMS:"
  printf '%s' "$PROBLEMS"
else
  echo "- ready. Stacks: scripts/cloud/stack.sh up e2e|dev; seeds: pnpm test:personas:seed, pnpm qa:seed"
fi
exit 0
