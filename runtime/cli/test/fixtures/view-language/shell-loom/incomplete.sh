#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <base-commit-ish>" >&2
  exit 2
fi

base_spec="$1"
repo_root=$(git rev-parse --show-toplevel)
script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$script_dir/../lib/setup-version.sh"
base_commit=$(git merge-base HEAD "$base_spec" 2>/dev/null || true)
if [ -z "$base_commit" ]; then
  base_commit=$(git rev-parse --verify --quiet "$base_spec^{commit}" || true)
fi
if [ -z "$base_commit" ]; then
  echo "check-deno-setup-gate: cannot resolve base '$base_spec'" >&2
  exit 2
fi

base_pin=$(git show "$base_commit:src/DENO_VERSION" 2>/dev/null || \
  git show "$base_commit:.ops/DENO_VERSION")
base_pin=$(printf '%s' "$base_pin" | tr -d '[:space:]')
head_pin=$(tr -d '[:space:]' < "$repo_root/src/DENO_VERSION")
if [ "$base_pin" = "$head_pin" ]; then
  exit 0
fi

setup_version_from_file() {
  awk '$1 ~ /^[0-9]+$/ { print $1; exit }' "$1"
}

base_setup_log=$(mktemp)
trap 'rm -f "$base_setup_log"' EXIT
setup_version_git_show "$repo_root" "$base_commit" > "$base_setup_log"
base_setup_version=$(setup_version_from_file "$base_setup_log")
head_version_dir=$(setup_version_dir "$repo_root/src" "$repo_root")
head_setup_version=$(setup_version_from_file "$head_version_dir/SETUP_VERSION")

if ! [[ "$base_setup_version" =~ ^[0-9]+$ && "$head_setup
