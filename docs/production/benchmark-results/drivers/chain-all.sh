#!/usr/bin/env bash
# The remaining measurement chain, unattended: matrix → provider misses → interactive load → failure tests.
B=$(dirname "$0")
ROOT=$(git -C "$B" rev-parse --show-toplevel)
LOG=$ROOT/docs/production/benchmark-results/chain.log
echo "{\"event\":\"chain.start\",\"at\":\"$(date -u +%FT%TZ)\"}" >> $LOG
$B/phase4b.sh; echo "{\"event\":\"chain.phase4b\",\"exit\":$?,\"at\":\"$(date -u +%FT%TZ)\"}" >> $LOG
$B/phase4c.sh; echo "{\"event\":\"chain.phase4c\",\"exit\":$?,\"at\":\"$(date -u +%FT%TZ)\"}" >> $LOG
$B/phase5.sh;  echo "{\"event\":\"chain.phase5\",\"exit\":$?,\"at\":\"$(date -u +%FT%TZ)\"}" >> $LOG
$B/phase8.sh;  echo "{\"event\":\"chain.phase8\",\"exit\":$?,\"at\":\"$(date -u +%FT%TZ)\"}" >> $LOG
echo "{\"event\":\"chain.finished\",\"at\":\"$(date -u +%FT%TZ)\"}" >> $LOG
