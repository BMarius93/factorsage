#!/usr/bin/env bash
#
# Runs one command with the cloud Stripe SANDBOX configured, and nothing else ever sees it.
#
#   scripts/cloud/with-stripe.sh pnpm billing:verify-catalog
#   scripts/cloud/with-stripe.sh pnpm billing:reconcile -- --user qa-pro@factorsage.test --dry-run
#   STRIPE_SANDBOX_SMOKE=true scripts/cloud/with-stripe.sh pnpm test:billing:sandbox
#   scripts/cloud/with-stripe.sh stripe customers list --limit 3
#
# The Claude environment holds the sandbox under SANDBOX_STRIPE_*, which the application does not
# read, so `pnpm test`, a plain `pnpm dev:api` and Playwright run without Stripe exactly as CI does.
# This maps those values onto the runtime names (STRIPE_SECRET_KEY, the four STRIPE_PRICE_*), sets
# STRIPE_API_KEY for the Stripe CLI, and derives STRIPE_WEBHOOK_SECRET for this session from
# `stripe listen --print-secret` — never a secret that was valid on another machine. It refuses a
# live-mode key, production mode and any non-local database before running anything.
set -euo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/cloud/with-stripe.sh <command> [args...]" >&2
  exit 2
fi

# STRIPE_SANDBOX_SMOKE is blanked for the session, so a value here was set on this command line:
# keep it through the guard, which would otherwise neutralize the opt-in this wrapper exists for.
smoke="${STRIPE_SANDBOX_SMOKE:-}"
cloud_use_toolchain
cloud_assert_safe
cloud_export_stripe_runtime
if [ -n "$smoke" ]; then
  export STRIPE_SANDBOX_SMOKE="$smoke"
fi
exec "$@"
