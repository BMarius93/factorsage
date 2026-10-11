#!/usr/bin/env bash
#
# Starts, inspects and stops one FactorSage application stack in a Claude cloud session.
#
#   scripts/cloud/stack.sh up e2e           the hermetic Playwright stack on the test database:
#                                           fixture FMP :3011, API :3001, worker, web :3000
#                                           (the ordinary `pnpm dev:*:e2e` launchers)
#   scripts/cloud/stack.sh up e2e --mail    the same, with the API in mail mode
#                                           (`pnpm dev:api:e2e:mail`): its email goes to the
#                                           local Mailpit, for `pnpm test:e2e:mail` only
#   scripts/cloud/stack.sh up dev           the development stack on the dev database; no FMP key,
#                                           no Stripe, mail to the local Mailpit
#   scripts/cloud/stack.sh up dev --stripe  the same, with the cloud Stripe sandbox configured for
#                                           the API and `stripe listen` forwarding its test-mode
#                                           webhooks to 127.0.0.1:3001/webhooks/stripe
#   scripts/cloud/stack.sh status
#   scripts/cloud/stack.sh logs <fmp|api|worker|web|stripe>
#   scripts/cloud/stack.sh down [--force]
#
# `up` waits until every process answers, which takes a few minutes the first time (each launcher
# builds the workspace packages): give the command a 10-minute timeout.
#
# Every process runs in its own session, so it outlives the command that started it, and `down`
# stops each whole process tree — pnpm, the watcher and everything it forked — by process group.
# That is what stops orphaned watchers from keeping ports and test-database connections alive.
# Only one stack runs at a time: both use :3000 and :3001.
set -uo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

STACK_DIR="$CLOUD_RUNTIME_DIR/stack"
LOG_DIR="$CLOUD_RUNTIME_DIR/logs"
FAKE_FMP_PORT="${E2E_FAKE_FMP_PORT:-3011}"
STACK_PORTS="3000 3001 $FAKE_FMP_PORT"
# Stopped in this order: consumers first, the processes they depend on last.
ROLES_DOWN="web worker stripe api fmp"
# The webhook types the API handles (HANDLED_EVENT_TYPES in apps/api/src/billing/stripe-webhook.controller.ts).
# The Stripe CLI forwards nothing without an explicit list.
STRIPE_WEBHOOK_EVENTS="checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.pending_update_applied,customer.subscription.pending_update_expired,invoice.paid,invoice.payment_failed,subscription_schedule.updated,subscription_schedule.released,subscription_schedule.aborted"

usage() {
  sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

say() {
  printf '[stack] %s\n' "$*"
}

pid_of() {
  cat "$STACK_DIR/$1.pid" 2>/dev/null
}

group_alive() {
  [ -n "$1" ] && kill -0 -- "-$1" 2>/dev/null
}

role_alive() {
  group_alive "$(pid_of "$1")"
}

# start_role <role> <command...>: starts the command as a new session whose id is recorded.
start_role() {
  local role="$1" waited=0
  shift
  rm -f "$STACK_DIR/$role.pid"
  # shellcheck disable=SC2016 # $$ and $0 belong to the inner shell.
  nohup setsid bash -c 'echo $$ >"$0"; exec "$@"' "$STACK_DIR/$role.pid" "$@" \
    >"$LOG_DIR/stack-$role.log" 2>&1 </dev/null &
  until [ -s "$STACK_DIR/$role.pid" ]; do
    waited=$((waited + 1))
    if [ "$waited" -gt 50 ]; then
      say "$role did not start"
      return 1
    fi
    sleep 0.1
  done
}

stop_role() {
  local role="$1" pgid waited=0
  pgid="$(pid_of "$role")"
  [ -n "$pgid" ] || return 0
  if group_alive "$pgid"; then
    kill -TERM -- "-$pgid" 2>/dev/null
    while group_alive "$pgid" && [ "$waited" -lt 20 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if group_alive "$pgid"; then
      kill -KILL -- "-$pgid" 2>/dev/null
    fi
    say "stopped $role"
  fi
  rm -f "$STACK_DIR/$role.pid"
}

http_answers() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1")"
  [ "$code" != "000" ] && [ "$code" -lt 500 ]
}

http_ok() {
  curl -fsS -o /dev/null --max-time 10 "$1"
}

listener_ready() {
  grep -q 'Ready!' "$LOG_DIR/stack-stripe.log" 2>/dev/null
}

# wait_role <role> <seconds> <probe...>: waits for the probe while the role's processes live.
wait_role() {
  local role="$1" seconds="$2" waited=0
  shift 2
  until "$@" >/dev/null 2>&1; do
    if ! role_alive "$role"; then
      say "$role exited during start-up. Last lines of .cloud/logs/stack-$role.log:"
      tail -n 40 "$LOG_DIR/stack-$role.log" >&2
      return 1
    fi
    waited=$((waited + 2))
    if [ "$waited" -ge "$seconds" ]; then
      say "$role did not become ready within ${seconds}s. Last lines of .cloud/logs/stack-$role.log:"
      tail -n 40 "$LOG_DIR/stack-$role.log" >&2
      return 1
    fi
    sleep 2
  done
  say "$role ready"
}

running_roles() {
  local role found=""
  for role in $ROLES_DOWN; do
    if role_alive "$role"; then
      found="$found $role"
    fi
  done
  printf '%s' "$found"
}

busy_ports() {
  local port busy=""
  for port in $STACK_PORTS; do
    if cloud_port_open "$port"; then
      busy="$busy $port"
    fi
  done
  printf '%s' "$busy"
}

# The cloud image has no ss (iproute2), and its lsof 4.95 skips a process whose name contains a
# space — `next-server (v16…)`, the web — so fuser (psmisc) answers there.
listener_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u
  else
    fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u
  fi
}

stack_down() {
  local force="${1:-}" role port pid leftovers=""
  for role in $ROLES_DOWN; do
    stop_role "$role"
  done
  rm -f "$STACK_DIR/kind"
  for port in $STACK_PORTS; do
    pid="$(listener_pids "$port" | tr '\n' ' ')"
    if [ -n "$pid" ]; then
      if [ "$force" = "--force" ]; then
        # shellcheck disable=SC2086 # deliberate word splitting of the pid list
        kill -TERM $pid 2>/dev/null
        say "killed the listener on :$port (pid $pid)"
      else
        leftovers="$leftovers :$port(pid $pid)"
      fi
    fi
  done
  if [ -n "$leftovers" ]; then
    say "still listening, not started by this script:$leftovers — rerun with --force to stop them"
  fi
  # `next dev` rewrites this generated file; the committed form is the `next build` one.
  if ! git -C "$CLOUD_REPO_ROOT" diff --quiet -- apps/web/next-env.d.ts 2>/dev/null; then
    git -C "$CLOUD_REPO_ROOT" checkout -- apps/web/next-env.d.ts
    say "restored apps/web/next-env.d.ts (next dev drift)"
  fi
}

stack_up() {
  local kind="${1:-}" option="${2:-}" running busy
  case "$kind" in
    e2e | dev) ;;
    *) usage ;;
  esac
  case "$kind:$option" in
    e2e: | e2e:--mail | dev: | dev:--stripe) ;;
    *) usage ;;
  esac

  cloud_use_toolchain
  cloud_assert_safe || exit 1
  # No stack process holds the live-FMP credential, under any name. It belongs to
  # scripts/cloud/fmp-live.sh, whose launcher maps it into the one process that performs a run.
  unset LIVE_FMP_API_KEY
  mkdir -p "$STACK_DIR" "$LOG_DIR"

  running="$(running_roles)"
  if [ -n "$running" ]; then
    say "a $(cat "$STACK_DIR/kind" 2>/dev/null || echo '?') stack is already running:$running. Run: scripts/cloud/stack.sh down"
    exit 1
  fi
  busy="$(busy_ports)"
  if [ -n "$busy" ]; then
    say "ports already in use:$busy. Run: scripts/cloud/stack.sh down --force"
    exit 1
  fi
  cloud_redis_ping || {
    say "Redis is not running; start a new session or run scripts/cloud/session-start.sh"
    exit 1
  }
  pg_isready -q -h 127.0.0.1 -p 5432 || {
    say "PostgreSQL is not running; start a new session or run scripts/cloud/session-start.sh"
    exit 1
  }

  echo "$kind${option:+ $option}" >"$STACK_DIR/kind"
  cd "$CLOUD_REPO_ROOT" || exit 1

  if [ "$kind" = "e2e" ]; then
    local api_script="dev:api:e2e" next="pnpm test:personas:seed && pnpm test:e2e"
    if [ "$option" = "--mail" ]; then
      # Mail mode delivers to the session's Mailpit and nowhere else; without it the suite would
      # only wait out its timeouts.
      cloud_port_open "$CLOUD_MAILPIT_SMTP_PORT" || {
        say "Mailpit is not running; start a new session or run scripts/cloud/session-start.sh"
        exit 1
      }
      api_script="dev:api:e2e:mail"
      next="pnpm test:e2e:mail"
      say "starting the hermetic E2E stack in mail mode (test database, fixture FMP, email to the local Mailpit only)"
    else
      say "starting the hermetic E2E stack (test database, fixture FMP, no external provider)"
    fi
    start_role fmp pnpm dev:fmp:e2e &&
      wait_role fmp 300 http_ok "http://127.0.0.1:$FAKE_FMP_PORT/__e2e/health" &&
      start_role api pnpm "$api_script" &&
      wait_role api 600 http_ok "http://127.0.0.1:3001/health/ready" &&
      start_role worker pnpm dev:worker:e2e &&
      wait_role worker 300 sleep_then_alive worker &&
      start_role web pnpm dev:web:e2e &&
      wait_role web 600 http_answers "http://127.0.0.1:3000/" || {
      stack_down
      exit 1
    }
    say "ready. Next: $next   (then: scripts/cloud/stack.sh down)"
    return 0
  fi

  if [ "$option" = "--stripe" ]; then
    cloud_export_stripe_runtime || {
      stack_down
      exit 1
    }
    say "starting the development stack with the Stripe sandbox"
  else
    say "starting the development stack (no FMP key, no Stripe)"
  fi
  start_role api pnpm dev:api &&
    wait_role api 600 http_ok "http://127.0.0.1:3001/health/ready" || {
    stack_down
    exit 1
  }
  if [ "$option" = "--stripe" ]; then
    # The listener prints this session's signing secret; it never reaches the log.
    # shellcheck disable=SC2016 # $0 belongs to the inner shell.
    start_role stripe bash -c 'stripe listen --events "$0" --forward-to http://127.0.0.1:3001/webhooks/stripe 2>&1 |
      sed -u "s/whsec_[A-Za-z0-9]*/whsec_[redacted]/g"' "$STRIPE_WEBHOOK_EVENTS" &&
      wait_role stripe 90 listener_ready || {
      stack_down
      exit 1
    }
    # Only the API and the listener hold Stripe configuration.
    unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_API_KEY STRIPE_PRICE_STARTER_MONTHLY \
      STRIPE_PRICE_STARTER_YEARLY STRIPE_PRICE_PRO_MONTHLY STRIPE_PRICE_PRO_YEARLY
  fi
  start_role worker pnpm dev:worker &&
    wait_role worker 300 sleep_then_alive worker &&
    start_role web pnpm dev:web &&
    wait_role web 600 http_answers "http://127.0.0.1:3000/" || {
    stack_down
    exit 1
  }
  say "ready: web http://localhost:3000, API http://localhost:3001, Mailpit http://127.0.0.1:$CLOUD_MAILPIT_HTTP_PORT"
}

# The worker has no port. It counts as started once its processes have survived the package build
# and their own start-up; the Playwright global setup separately proves the E2E worker armed the
# egress guard.
sleep_then_alive() {
  sleep 20
  role_alive "$1"
}

stack_status() {
  local role pid kind
  kind="$(cat "$STACK_DIR/kind" 2>/dev/null || echo none)"
  echo "stack: $kind"
  for role in fmp api stripe worker web; do
    pid="$(pid_of "$role")"
    if [ -n "$pid" ] && group_alive "$pid"; then
      echo "  $role: running (process group $pid)"
    elif [ -n "$pid" ]; then
      echo "  $role: DEAD (see .cloud/logs/stack-$role.log)"
    fi
  done
  echo "ports in use:$(busy_ports)"
  echo "mailpit: $(cloud_port_open "$CLOUD_MAILPIT_SMTP_PORT" && echo running || echo stopped)"
}

case "${1:-}" in
  up) stack_up "${2:-}" "${3:-}" ;;
  down) stack_down "${2:-}" ;;
  status) stack_status ;;
  logs)
    [ -n "${2:-}" ] || usage
    tail -n 200 "$LOG_DIR/stack-$2.log"
    ;;
  *) usage ;;
esac
