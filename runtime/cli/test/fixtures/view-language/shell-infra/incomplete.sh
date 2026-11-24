#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <namespace> <external-secret> [external-secret ...]" >&2
  exit 2
fi

NAMESPACE="$1"
shift

TIMEOUT_SECONDS="${EXTERNAL_SECRET_SYNC_TIMEOUT_SECONDS:-120}"
POLL_SECONDS="${EXTERNAL_SECRET_SYNC_POLL_SECONDS:-2}"

read_status_snapshot() {
  local name="$1"

  kubectl -n "$NAMESPACE" get externalsecret "$name" \
    -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"|"}{range .status.conditions[?(@.type=="Ready")]}{.reason}{end}{"|"}{.status.refreshTime}{"|"}{.status.syncedResourceVersion}'
}

force_sync_and_wait() {
  local name="$1"
  local old_snapshot old_refresh old_synced nonce deadline
  local snapshot ready reason refresh synced status_advanced

  if ! old_snapshot="$(read_status_snapshot "$name" 2>/dev/null)"; then
    echo "Failed to read ExternalSecret $NAMESPACE/$name status baseline" >&2
    return 1
  fi
  IFS='|' read -r _ _ old_refresh old_synced <<<"$old_snapshot"
  nonce="$(date -u +%s)-$$-$RANDOM"

  kubectl -n "$NAMESPACE" annotate externalsecret "$name" "force-sync=$nonce" --overwrite >/dev/null
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

  while true; do
    snapshot="$(read_status_snapshot "$name" 2>/dev/null || true)"
    IFS='|' read -r ready reason refresh synced <<<"$snapshot"
    status_advanced=false
    if [[ ( -n "$refresh" && "$refresh" != "$old_ref
