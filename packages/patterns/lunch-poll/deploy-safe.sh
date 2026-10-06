#!/usr/bin/env bash

# Rehearsal-grade lunch-poll source update. Dry-run by default; --apply repeats
# the exact checked package, then requires the updated piece to render.

set -euo pipefail

apply=false
if [[ $# -gt 1 ]]; then
  echo "usage: $0 [--apply]" >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --apply) apply=true ;;
  *)
    echo "usage: $0 [--apply]" >&2
    exit 2
    ;;
esac

for name in CF_API_URL CF_IDENTITY SPACE PIECE; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name must be set" >&2
    exit 2
  fi
done

root="packages/patterns"
main="$root/lunch-poll/main.tsx"
tests=(
  "$root/lunch-poll/art-sync.test.tsx"
  "$root/lunch-poll/day-rollover.test.tsx"
  "$root/lunch-poll/generated-art.test.tsx"
  "$root/lunch-poll/lunch-stats.test.tsx"
  "$root/lunch-poll/main.test.tsx"
  "$root/lunch-poll/multi-user.test.tsx"
  "$root/lunch-poll/participant-identity-card.test.tsx"
  "$root/lunch-poll/poll-option-card.test.tsx"
  "$root/lunch-poll/read-cost.test.tsx"
)
package_args=(--root "$root")
for test_path in "${tests[@]}"; do
  package_args+=(--test "$test_path")
done

echo "Lunch-poll target: $CF_API_URL / $SPACE / $PIECE" >&2
for test_path in "${tests[@]}"; do
  deno task cf test "$test_path" --root "$root"
done

deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  "${package_args[@]}" --check "$main"

if [[ "$apply" != true ]]; then
  echo "Preflight passed; no source was changed. Re-run with --apply to deploy." >&2
  exit 0
fi

deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  "${package_args[@]}" "$main"
deno task cf piece render --piece "$PIECE" -s "$SPACE" >/dev/null
deno task cf piece inspect --piece "$PIECE" -s "$SPACE" --summary

echo "Source committed and the updated piece rendered successfully." >&2
