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

force_sync_and_wait() {
  local name="$1"
  local old_refresh old_synced nonce deadline
  local ready reason refresh synced

  if ! old_refresh="$(kubectl -n "$NAMESPACE" get externalsecret "$name" -o jsonpath='{.status.refreshTime}' 2>/dev/null)"; then
    echo "Failed to read ExternalSecret $NAMESPACE/$name refresh baseline" >&2
    return 1
  fi
  if ! old_synced="$(kubectl -n "$NAMESPACE" get externalsecret "$name" -o jsonpath='{.status.syncedResourceVersion}' 2>/dev/null)"; then
    echo "Failed to read ExternalSecret $NAMESPACE/$name resource-version baseline" >&2
    return 1
  fi
  nonce="$(date -u +%s)-$$-$RANDOM"

  kubectl -n "$NAMESPACE" annotate externalsecret "$name" "force-sync=$nonce" --overwrite >/dev/null
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

  while true; do
    ready="$(kubectl -n "$NAMESPACE" get externalsecret "$name" -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}' 2>/dev/null || true)"
    reason="$(kubectl -n "$NAMESPACE" get externalsecret "$name" -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.reason}{end}' 2>/dev/null || true)"
    refresh="$(kubectl -n "$NAMESPACE" get externalsecret "$name" -o jsonpath='{.status.refreshTime}' 2>/dev/null || true)"
    synced="$(kubectl -n "$NAMESPACE" get externalsecret "$name" -o jsonpath='{.status.syncedResourceVersion}' 2>/dev/null || true)"

    if [[ "$ready" == "False" ]]; then
      echo "ExternalSecret $NAMESPACE/$name failed to sync: ${reason:-unknown reason}" >&2
      return 1
    fi

    if [[ "$ready" == "True" && -n "$refresh" && "$refresh" != "$old_refresh" && -n "$synced" && "$synced" != "$old_synced" ]]; then
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
