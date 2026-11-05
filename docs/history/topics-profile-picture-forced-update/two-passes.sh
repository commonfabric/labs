#!/bin/bash
# Two clean passes of the combined rollout, each on a freshly reset clone with
# the server stopped before the reset and started after it.
set -uo pipefail
R=$HOME/clones/topics-kept-activity-2026-10-26
cd "$HOME/coding/B-cf-repos/labs-topics-index" || { echo "labs checkout missing" >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: $0 <pass dir name>..." >&2; exit 2; }
for pass in "$@"; do
  echo "[$(date -u +%H:%M:%S)] $pass: stop, reset, start"
  ./scripts/stop-local-dev.sh --port-offset 2 > /dev/null 2>&1
  if lsof -nP -iTCP:8002 -sTCP:LISTEN > /dev/null; then echo "server still up"; exit 1; fi
  deno task cf space reset "$R/clone" > "$R/$pass-reset.log" 2>&1 || { echo "reset failed"; exit 1; }
  HOST=127.0.0.1 MEMORY_DIR="file://$R/clone/" ./scripts/start-local-dev.sh --port-offset 2 > "$R/$pass-start.log" 2>&1 || { echo "start failed"; exit 1; }
  "$R/tools/pass.sh" "$pass" || { echo "[$(date -u +%H:%M:%S)] $pass FAILED"; exit 1; }
  echo "[$(date -u +%H:%M:%S)] $pass clean"
done
