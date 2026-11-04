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
    if [[ ( -n "$refresh" && "$refresh" != "$old_refresh" ) || ( -n "$synced" && "$synced" != "$old_synced" ) ]]; then
      status_advanced=true
    fi

    if [[ "$ready" == "False" && "$status_advanced" == true ]]; then
      echo "ExternalSecret $NAMESPACE/$name failed to sync: ${reason:-unknown reason}" >&2
      return 1
    fi

    if [[ "$ready" == "True" && -n "$refresh" && "$refresh" != "$old_refresh" && -n "$synced" ]]; then
      echo "ExternalSecret $NAMESPACE/$name refreshed"
      return 0
    fi

    if (( $(date +%s) >= deadline )); then
      echo "Timed out waiting for ExternalSecret $NAMESPACE/$name to refresh" >&2
      return 1
    fi

    sleep "$POLL_SECONDS"
  done
}

for external_secret in "$@"; do
  force_sync_and_wait "$external_secret"
done
