#!/usr/bin/env bash
#
# Runs one guarded live-FMP hydration in a Claude cloud session: `pnpm fmp:live`, and only that.
#
#   scripts/cloud/fmp-live.sh --symbols AAPL --full-history --plan
#   RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL --full-history
#   RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL,MSFT,NVDA --full-history
#
# Unlike with-stripe.sh this takes no command. It cannot start a stack, a worker or a test run with
# the provider configured: its arguments are `pnpm fmp:live`'s arguments, and that command hydrates
# at most three securities, through the product's own loaders, inside a total request budget
# (docs/development/fmp-live-hydration.md).
#
# The Claude environment holds the key as LIVE_FMP_API_KEY, which the application does not read, so
# `pnpm test`, the stacks and Playwright run without a provider credential exactly as CI does. This
# script does not map it either. It applies the session guard — refusing production and any
# non-local database or Redis, and blanking FMP_API_KEY and FMP_BASE_URL — and hands over to the
# launcher, which looks for the key only after the opt-in and the command line have been accepted
# and maps it into the one child process that performs the run.
set -euo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "Usage: [RUN_LIVE_FMP_HYDRATION=1] scripts/cloud/fmp-live.sh --symbols AAPL[,MSFT[,NVDA]] --full-history [--budget N] [--plan]" >&2
  exit 2
fi

# RUN_LIVE_FMP_HYDRATION is blanked for the session, so a value here was set on this command
# line: keep it through the guard, which would otherwise neutralize the opt-in this script exists
# to pass on.
opt_in="${RUN_LIVE_FMP_HYDRATION:-}"
cloud_use_toolchain
cloud_assert_safe
if [ -n "$opt_in" ]; then
  export RUN_LIVE_FMP_HYDRATION="$opt_in"
fi
cd "$CLOUD_REPO_ROOT"
exec pnpm fmp:live -- "$@"
