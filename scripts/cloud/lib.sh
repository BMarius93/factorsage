# shellcheck shell=bash
#
# Shared helpers for the Claude cloud environment. Sourced by the other scripts in this directory,
# never executed on its own. `docs/development/claude-cloud-environment.md` is the runbook.
#
# Kept to bash 3.2 so the guard below can be exercised on a developer's macOS shell as well as on
# the Ubuntu VM it is written for.

CLOUD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_REPO_ROOT="$(cd "$CLOUD_LIB_DIR/../.." && pwd)"

# ---------------------------------------------------------------------------------------------
# Pinned third-party tools
#
# Both come from their official Docker Hub images (through Google's mirror first) because the VM
# cannot download GitHub release assets of repositories other than the one attached to the
# session. Each image is pinned by its index digest and each binary by its own checksum;
# fetch-image-file.py refuses any mismatch, so a moved tag can never change what gets installed.
# To upgrade, change all four values of a tool together.
# ---------------------------------------------------------------------------------------------
CLOUD_MAILPIT_VERSION="v1.31.4"
CLOUD_MAILPIT_IMAGE="axllent/mailpit"
CLOUD_MAILPIT_DIGEST="sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48"
CLOUD_MAILPIT_PATH="mailpit"
CLOUD_MAILPIT_SHA256="69671b823510d9763958800aaf26c034a326198f039c94cf625cefbfce007c20"

CLOUD_STRIPE_CLI_VERSION="v1.53.0"
CLOUD_STRIPE_CLI_IMAGE="stripe/stripe-cli"
CLOUD_STRIPE_CLI_DIGEST="sha256:92dbb87a9342196d6b4c0aa305ef8d0cacc1edd81da12f1e819ed78e9e99bead"
CLOUD_STRIPE_CLI_PATH="bin/stripe"
CLOUD_STRIPE_CLI_SHA256="b59176ea7d307e8dfe7139f73d469eadc033b49fcb938395385a1c6f32a6feca"

# Where things live on the VM. /opt and /var/lib survive in the environment snapshot; .cloud/ is
# per-checkout runtime state (logs, process ids, the guard verdict) and is git-ignored.
CLOUD_TOOLS_DIR="/opt/factorsage-cloud/bin"
CLOUD_STATE_DIR="/var/lib/factorsage-cloud"
CLOUD_RUNTIME_DIR="$CLOUD_REPO_ROOT/.cloud"
CLOUD_DEFAULT_BROWSERS_PATH="/opt/ms-playwright"

CLOUD_MAILPIT_SMTP_PORT=1025
CLOUD_MAILPIT_HTTP_PORT=8025

cloud_log() {
  printf '[factorsage-cloud] %s\n' "$*" >&2
}

# ---------------------------------------------------------------------------------------------
# Toolchain
# ---------------------------------------------------------------------------------------------

# The exact Node version the repository pins. pnpm refuses to install a project whose own
# `engines.node` does not match, so "some Node 22" is not enough.
cloud_node_version() {
  tr -d ' v\r\n' <"$CLOUD_REPO_ROOT/.nvmrc"
}

# The pnpm version `packageManager` pins (any `+sha…` suffix removed).
cloud_pnpm_version() {
  sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"+]*\).*/\1/p' \
    "$CLOUD_REPO_ROOT/package.json"
}

cloud_node_prefix() {
  printf '/opt/node-v%s' "$(cloud_node_version)"
}

# Always the cloud path: setup.sh does not see the environment's variables and inherits the image's
# own PLAYWRIGHT_BROWSERS_PATH, so honouring it would install into a directory the hook never checks.
cloud_playwright_browsers_path() {
  printf '%s' "$CLOUD_DEFAULT_BROWSERS_PATH"
}

# Puts the pinned Node, its pnpm shim and the pinned tools first on PATH for this process.
cloud_use_toolchain() {
  PATH="$(cloud_node_prefix)/bin:$CLOUD_TOOLS_DIR:$PATH"
  PLAYWRIGHT_BROWSERS_PATH="$(cloud_playwright_browsers_path)"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  STRIPE_CLI_TELEMETRY_OPTOUT=1
  NEXT_TELEMETRY_DISABLED=1
  CHECKPOINT_DISABLE=1
  export PATH PLAYWRIGHT_BROWSERS_PATH COREPACK_ENABLE_DOWNLOAD_PROMPT STRIPE_CLI_TELEMETRY_OPTOUT \
    NEXT_TELEMETRY_DISABLED CHECKPOINT_DISABLE
}

cloud_as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

cloud_as_postgres() {
  (
    cd / || exit 1
    if [ "$(id -u)" = 0 ]; then
      runuser -u postgres -- "$@"
    else
      sudo -n -u postgres "$@"
    fi
  )
}

cloud_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

# Installs the exact `.nvmrc` Node under /opt, verified against nodejs.org's published checksums.
cloud_install_node() {
  local version prefix arch file base tmp
  version="$(cloud_node_version)"
  prefix="$(cloud_node_prefix)"
  if [ -x "$prefix/bin/node" ] && [ "$("$prefix/bin/node" -v)" = "v$version" ]; then
    return 0
  fi
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *)
      cloud_log "unsupported CPU architecture $(uname -m)"
      return 1
      ;;
  esac
  file="node-v$version-linux-$arch.tar.xz"
  base="https://nodejs.org/dist/v$version"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file" &&
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" &&
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) &&
    rm -rf "$prefix.partial" &&
    mkdir -p "$prefix.partial" &&
    tar -xJf "$tmp/$file" -C "$prefix.partial" --strip-components=1 &&
    rm -rf "$prefix" &&
    mv "$prefix.partial" "$prefix"
  local status=$?
  rm -rf "$tmp"
  return $status
}

# Activates the exact `packageManager` pnpm through Corepack, the mechanism the Dockerfiles use,
# falling back to npm into the same pinned Node prefix if Corepack cannot fetch it.
cloud_install_pnpm() {
  local want
  want="$(cloud_pnpm_version)"
  cloud_use_toolchain
  if [ "$(cd "$CLOUD_REPO_ROOT" && pnpm --version 2>/dev/null)" = "$want" ]; then
    return 0
  fi
  if corepack enable pnpm && (cd "$CLOUD_REPO_ROOT" && corepack install) &&
    [ "$(cd "$CLOUD_REPO_ROOT" && pnpm --version 2>/dev/null)" = "$want" ]; then
    return 0
  fi
  cloud_log "Corepack could not activate pnpm $want; installing it with npm instead"
  npm install --global --prefix "$(cloud_node_prefix)" "pnpm@$want" &&
    [ "$(cd "$CLOUD_REPO_ROOT" && pnpm --version 2>/dev/null)" = "$want" ]
}

cloud_sha256_of() {
  sha256sum "$1" 2>/dev/null | cut -d' ' -f1
}

# Installs one pinned binary unless the right one is already there.
cloud_install_tool() {
  local name="$1" image="$2" digest="$3" path="$4" sha="$5"
  local dest="$CLOUD_TOOLS_DIR/$name"
  if [ -x "$dest" ] && [ "$(cloud_sha256_of "$dest")" = "$sha" ]; then
    return 0
  fi
  mkdir -p "$CLOUD_TOOLS_DIR" &&
    python3 "$CLOUD_LIB_DIR/fetch-image-file.py" \
      --image "$image" --digest "$digest" --path "$path" --sha256 "$sha" --dest "$dest"
}

cloud_install_tools() {
  cloud_install_tool mailpit "$CLOUD_MAILPIT_IMAGE" "$CLOUD_MAILPIT_DIGEST" \
    "$CLOUD_MAILPIT_PATH" "$CLOUD_MAILPIT_SHA256" &&
    cloud_install_tool stripe "$CLOUD_STRIPE_CLI_IMAGE" "$CLOUD_STRIPE_CLI_DIGEST" \
      "$CLOUD_STRIPE_CLI_PATH" "$CLOUD_STRIPE_CLI_SHA256"
}

# Succeeds only when every browser directory the lockfile's Playwright expects exists. The list
# comes from Playwright itself, so a branch that moves the version is detected, never assumed.
cloud_playwright_browsers_ready() {
  local plan locations location
  plan="$(cd "$CLOUD_REPO_ROOT" &&
    pnpm --filter @intrinsic/web exec playwright install --dry-run chromium 2>/dev/null)" || return 1
  locations="$(printf '%s\n' "$plan" | sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p')"
  [ -n "$locations" ] || return 1
  while IFS= read -r location; do
    [ -d "$location" ] || return 1
  done <<EOF
$locations
EOF
}

cloud_install_playwright() {
  (cd "$CLOUD_REPO_ROOT" && pnpm --filter @intrinsic/web exec playwright install --with-deps chromium)
}

# ---------------------------------------------------------------------------------------------
# Local services
# ---------------------------------------------------------------------------------------------

cloud_port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# cloud_wait_for <seconds> <command...>: polls once a second until the command succeeds.
cloud_wait_for() {
  local seconds="$1" waited=0
  shift
  until "$@" >/dev/null 2>&1; do
    waited=$((waited + 1))
    [ "$waited" -ge "$seconds" ] && return 1
    sleep 1
  done
}

cloud_start_postgres() {
  if pg_isready -q -h 127.0.0.1 -p 5432; then
    return 0
  fi
  if ! ls -d /etc/postgresql/*/main >/dev/null 2>&1; then
    local major
    major="$(ls /usr/lib/postgresql | sort -n | tail -n1)"
    cloud_as_root pg_createcluster "$major" main || return 1
  fi
  cloud_as_root service postgresql start &&
    cloud_wait_for 60 pg_isready -q -h 127.0.0.1 -p 5432
}

cloud_redis_ping() {
  [ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null)" = "PONG" ]
}

cloud_start_redis() {
  if cloud_redis_ping; then
    return 0
  fi
  cloud_as_root service redis-server start && cloud_wait_for 30 cloud_redis_ping
}

# Mailpit catches everything the development stack sends. Loopback only: nothing outside the VM
# can deliver to it or read it.
cloud_start_mailpit() {
  if cloud_port_open "$CLOUD_MAILPIT_SMTP_PORT"; then
    return 0
  fi
  [ -x "$CLOUD_TOOLS_DIR/mailpit" ] || return 1
  mkdir -p "$CLOUD_RUNTIME_DIR/logs"
  nohup setsid "$CLOUD_TOOLS_DIR/mailpit" \
    --smtp "127.0.0.1:$CLOUD_MAILPIT_SMTP_PORT" \
    --listen "127.0.0.1:$CLOUD_MAILPIT_HTTP_PORT" \
    >"$CLOUD_RUNTIME_DIR/logs/mailpit.log" 2>&1 </dev/null &
  cloud_wait_for 20 cloud_port_open "$CLOUD_MAILPIT_SMTP_PORT"
}

# ---------------------------------------------------------------------------------------------
# The environment guard
#
# Nothing in a cloud session may reach production, a remote database or live Stripe, and no
# provider credential may be ambient. Two levels:
#
# - a REFUSAL means the environment is misconfigured in a way that could do damage (production
#   mode, a non-loopback database or Redis, a live Stripe key). Every script here stops, and
#   session-start.sh provisions nothing.
# - a NEUTRALIZED variable is one that must never be set for every command at once: a provider
#   credential only an explicit wrapper may introduce, or a per-run opt-in that would switch a
#   safety check off globally. It is blanked for the session and reported.
# ---------------------------------------------------------------------------------------------

CLOUD_LOCAL_URL_VARS="DATABASE_URL TEST_DATABASE_URL QA_MATRIX_DATABASE_URL QA_MATRIX_SOURCE_DATABASE_URL QA_PERSONA_DATABASE_URL REDIS_URL QA_MATRIX_REDIS_URL"

CLOUD_NEUTRALIZED_VARS="FMP_API_KEY FMP_BASE_URL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_STARTER_MONTHLY STRIPE_PRICE_STARTER_YEARLY STRIPE_PRICE_PRO_MONTHLY STRIPE_PRICE_PRO_YEARLY STRIPE_API_KEY RUN_LIVE_FMP_TESTS STRIPE_SANDBOX_SMOKE STRIPE_BILLING_PERSONAS QA_PERSONA_ALLOW_REMOTE_HOST QA_MATRIX_ALLOW_REMOTE_HOST CI FACTORSAGE_RELEASE_BUILD"

CLOUD_SANDBOX_PRICE_VARS="SANDBOX_STRIPE_PRICE_STARTER_MONTHLY SANDBOX_STRIPE_PRICE_STARTER_YEARLY SANDBOX_STRIPE_PRICE_PRO_MONTHLY SANDBOX_STRIPE_PRICE_PRO_YEARLY"

# cloud_url_field <scheme|host|user|password|database> <url>. Prints nothing for an unparseable URL,
# which every caller treats as "not local".
cloud_url_field() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import sys
import urllib.parse

field, raw = sys.argv[1], sys.argv[2]
url = urllib.parse.urlsplit(raw)
values = {
    "scheme": url.scheme,
    "host": url.hostname or "",
    "user": urllib.parse.unquote(url.username or ""),
    "password": urllib.parse.unquote(url.password or ""),
    "database": url.path.lstrip("/"),
}
print(values[field])
PY
  return 0
}

cloud_is_loopback_host() {
  case "$1" in
    localhost | 127.0.0.1 | ::1) return 0 ;;
    *) return 1 ;;
  esac
}

cloud_is_stripe_live_key() {
  case "$1" in
    sk_live_* | rk_live_*) return 0 ;;
    *) return 1 ;;
  esac
}

cloud_is_stripe_test_key() {
  case "$1" in
    sk_test_* | rk_test_*) return 0 ;;
    *) return 1 ;;
  esac
}

# cloud_add_refusal <variable> <reason>
cloud_add_refusal() {
  CLOUD_REFUSALS="${CLOUD_REFUSALS}- $2
"
  case " $CLOUD_REFUSED_VARS " in
    *" $1 "*) ;;
    *) CLOUD_REFUSED_VARS="$CLOUD_REFUSED_VARS $1" ;;
  esac
}

# Sets CLOUD_REFUSALS (newline-separated reasons), CLOUD_REFUSED_VARS (the variables responsible,
# which session-start.sh blanks so no later command can act on them) and CLOUD_NEUTRALIZE (names).
# Reads the environment only; changes nothing. Never prints a value.
cloud_evaluate_environment() {
  local name value host
  CLOUD_REFUSALS=""
  CLOUD_REFUSED_VARS=""
  CLOUD_NEUTRALIZE=""

  if [ "${NODE_ENV:-}" = "production" ]; then
    cloud_add_refusal NODE_ENV "NODE_ENV is production. Cloud sessions are development/test only."
  fi

  for name in $CLOUD_LOCAL_URL_VARS; do
    value="${!name:-}"
    [ -n "$value" ] || continue
    host="$(cloud_url_field host "$value")"
    if ! cloud_is_loopback_host "$host"; then
      cloud_add_refusal "$name" "$name does not point at this machine (host '${host:-unparseable}')."
    fi
  done

  if [ -n "${DATABASE_URL:-}" ] && [ "${DATABASE_URL:-}" = "${TEST_DATABASE_URL:-}" ]; then
    cloud_add_refusal TEST_DATABASE_URL "DATABASE_URL and TEST_DATABASE_URL name the same database."
  fi

  for name in STRIPE_SECRET_KEY STRIPE_API_KEY SANDBOX_STRIPE_SECRET_KEY; do
    value="${!name:-}"
    if cloud_is_stripe_live_key "$value"; then
      cloud_add_refusal "$name" "$name is a LIVE-mode Stripe key. Only sandbox/test keys may exist here."
    fi
  done
  value="${SANDBOX_STRIPE_SECRET_KEY:-}"
  if [ -n "$value" ] && ! cloud_is_stripe_test_key "$value"; then
    cloud_add_refusal SANDBOX_STRIPE_SECRET_KEY \
      "SANDBOX_STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_)."
  fi

  for name in $CLOUD_NEUTRALIZED_VARS; do
    if [ -n "${!name:-}" ]; then
      CLOUD_NEUTRALIZE="$CLOUD_NEUTRALIZE $name"
    fi
  done
}

# Refuses (non-zero, reasons on stderr) or blanks the neutralized variables in this process.
cloud_assert_safe() {
  local name
  cloud_evaluate_environment
  if [ -n "$CLOUD_REFUSALS" ]; then
    cloud_log "REFUSING: this environment is not a safe FactorSage cloud dev/QA environment."
    printf '%s' "$CLOUD_REFUSALS" >&2
    return 1
  fi
  for name in $CLOUD_NEUTRALIZE; do
    export "$name="
  done
  return 0
}

# ---------------------------------------------------------------------------------------------
# Stripe sandbox
#
# The sandbox credentials live under SANDBOX_STRIPE_* so the ordinary runtime — `pnpm test`, a
# plain `pnpm dev:api`, Playwright — never sees Stripe at all, exactly like CI. This maps them onto
# the names the application reads, for one process tree, after proving they are test-mode, and
# derives this session's webhook signing secret from the Stripe CLI rather than trusting any secret
# that was valid somewhere else.
# ---------------------------------------------------------------------------------------------
cloud_export_stripe_runtime() {
  local key="${SANDBOX_STRIPE_SECRET_KEY:-}" name value secret suffix
  if [ -z "$key" ]; then
    cloud_log "SANDBOX_STRIPE_SECRET_KEY is not set; configure the Stripe sandbox first (see the runbook)."
    return 1
  fi
  if ! cloud_is_stripe_test_key "$key"; then
    cloud_log "REFUSING: SANDBOX_STRIPE_SECRET_KEY is not a sandbox/test-mode key."
    return 1
  fi
  for name in $CLOUD_SANDBOX_PRICE_VARS; do
    value="${!name:-}"
    case "$value" in
      price_*) ;;
      *)
        cloud_log "$name must be set to a price_… id from the cloud Stripe sandbox."
        return 1
        ;;
    esac
  done
  if ! command -v stripe >/dev/null 2>&1; then
    cloud_log "The Stripe CLI is not installed; run scripts/cloud/setup.sh."
    return 1
  fi
  secret="$(STRIPE_API_KEY="$key" cloud_with_timeout 60 stripe listen --print-secret 2>/dev/null)" ||
    secret=""
  case "$secret" in
    whsec_*) ;;
    *)
      cloud_log "Could not obtain a webhook signing secret from the Stripe CLI (is *.stripe.com allowed?)."
      return 1
      ;;
  esac
  for name in $CLOUD_SANDBOX_PRICE_VARS; do
    suffix="${name#SANDBOX_STRIPE_PRICE_}"
    export "STRIPE_PRICE_$suffix=${!name}"
  done
  export STRIPE_SECRET_KEY="$key" STRIPE_WEBHOOK_SECRET="$secret" STRIPE_API_KEY="$key"
}
