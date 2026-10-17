#!/usr/bin/env bash
#
# Runs one point-in-time index-universe command in a Claude cloud session with the provider key:
# `pnpm data:index-universe`, and only that (docs/decisions/sp500-historical-pit-v1.md §6).
#
#   RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh sync
#   RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh resolve
#   RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh ingest --concurrency 2
#   RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh benchmarks
#   scripts/cloud/fmp-index-universe.sh report --out artifacts/sp500-historical-pit/report.json
#   scripts/cloud/fmp-index-universe.sh protect --concurrency 4
#
# The owner authorized this universe-wide load (2026-10-17). It is deliberately not a general
# wrapper: it cannot start a stack, a worker or a test run with the provider configured. Its
# arguments are the index-universe command's, whose client carries a guard admitting the index's
# own directory endpoints and, per security, only the symbols the canonical membership names, inside
# a request budget.
#
# The Claude environment holds the key as LIVE_FMP_API_KEY, which nothing else reads. This script
# applies the session guard — refusing production and any non-local database or Redis, blanking
# FMP_API_KEY and FMP_BASE_URL — and only then, and only for a command that reaches the provider
# with the per-command opt-in set, maps the key onto FMP_API_KEY for the one process tree it
# starts. LIVE_FMP_API_KEY itself is removed from that tree. The key is never printed.
set -euo pipefail

# shellcheck source=scripts/cloud/lib.sh
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "Usage: [RUN_INDEX_UNIVERSE_INGESTION=1] scripts/cloud/fmp-index-universe.sh <sync|resolve|project|ingest|benchmarks|report|protect> [options]" >&2
  exit 2
fi

command="$1"
opt_in="${RUN_INDEX_UNIVERSE_INGESTION:-}"
cloud_use_toolchain
cloud_assert_safe
cd "$CLOUD_REPO_ROOT"

case "$command" in
  sync | resolve | ingest | benchmarks)
    if [ "$opt_in" != "1" ]; then
      echo "Refusing: '$command' reaches the provider. Set RUN_INDEX_UNIVERSE_INGESTION=1 on this command." >&2
      exit 2
    fi
    if [ -z "${LIVE_FMP_API_KEY:-}" ]; then
      echo "Refusing: LIVE_FMP_API_KEY is not configured for this environment." >&2
      exit 2
    fi
    key="$LIVE_FMP_API_KEY"
    exec env -u LIVE_FMP_API_KEY -u FMP_BASE_URL FMP_API_KEY="$key" pnpm data:index-universe -- "$@"
    ;;
  project | report | protect)
    exec env -u LIVE_FMP_API_KEY pnpm data:index-universe -- "$@"
    ;;
  *)
    echo "Unknown command '$command'" >&2
    exit 2
    ;;
esac
