#!/usr/bin/env bash
#
# share-pattern-via-tailscale.sh
#
# Host a Common Fabric pattern on a LOCAL toolshed (started with --inspect) and
# share it on your tailnet via `tailscale serve`, so teammates can open it in a
# browser and interact with it together. For "can someone host the latest-main
# <pattern> locally and export it via Tailscale so we can poke at it / measure
# things" requests.
#
# Usage:
#   scripts/share-pattern-via-tailscale.sh <pattern.tsx> [options]
#   scripts/share-pattern-via-tailscale.sh --down
#
# Options:
#   --space NAME         space to deploy into (default: "<pattern-dir>-demo")
#   --toolshed-port N    default 8100  } offset from the usual 8000/5173 so this
#   --shell-port N       default 5273  } won't clobber a normal start-local-dev
#   --inspect-port N     default 9329  } instance running at the same time
#   --down               stop the servers and remove the tailscale serve mapping
#
# Notes:
#   * The toolshed runs with --inspect; connect Chrome via chrome://inspect (add
#     127.0.0.1:<inspect-port>) to profile the SERVER. The pattern runtime runs
#     client-side, so profile the CLIENT in each browser's own DevTools.
#   * Storage is isolated per-checkout (toolshed CACHE_DIR defaults to ./cache),
#     so this won't touch a parallel local instance's data.
#   * tailscale SERVE (tailnet-only), never `funnel` (public internet).
#   * THE GOTCHA this script handles for you: the shell's `dev-local` task bakes
#     API_URL=http://localhost into the bundle (felt.config.ts `$API_URL`
#     define; shell/src/lib/env.ts only falls back to same-origin when it is
#     unset), which breaks REMOTE browsers. This script launches the shell with
#     API_URL set to your machine's MagicDNS name instead.
#
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="/tmp/cf-share-tailscale.pids"
SERVEFILE="/tmp/cf-share-tailscale.serveport"

TOOLSHED_PORT=8100
SHELL_PORT=5273
INSPECT_PORT=9329
SPACE=""
PATTERN=""
DOWN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --down) DOWN=1; shift;;
    --space) SPACE="$2"; shift 2;;
    --toolshed-port) TOOLSHED_PORT="$2"; shift 2;;
    --shell-port) SHELL_PORT="$2"; shift 2;;
    --inspect-port) INSPECT_PORT="$2"; shift 2;;
    -h|--help) sed -n '3,29p' "$0"; exit 0;;
    -*) echo "unknown option: $1" >&2; exit 2;;
    *) PATTERN="$1"; shift;;
  esac
done

# ---------- teardown ----------
if [ "$DOWN" = "1" ]; then
  echo "Disabling tailscale serve..."
  tailscale serve --https=443 off 2>/dev/null || true
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "  killed pid $pid"
    done < "$PIDFILE"
    rm -f "$PIDFILE" "$SERVEFILE"
  fi
  echo "Done."
  exit 0
fi

[ -n "$PATTERN" ] || { echo "error: pass a pattern, e.g. patterns/apps/lunch-poll/main.tsx" >&2; exit 2; }
PATTERN_ABS="$(cd "$(dirname "$PATTERN")" 2>/dev/null && pwd)/$(basename "$PATTERN")"
[ -f "$PATTERN_ABS" ] || { echo "error: pattern not found: $PATTERN" >&2; exit 2; }
[ -n "$SPACE" ] || SPACE="$(basename "$(dirname "$PATTERN_ABS")")-demo"

# ---------- MagicDNS name = the public URL ----------
DNSNAME="$(tailscale status --json 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null)"
[ -n "$DNSNAME" ] || { echo "error: not on Tailscale (no MagicDNS name). Connect to the tailnet first." >&2; exit 1; }
PUBLIC_URL="https://$DNSNAME"

echo "Repo:    $REPO_ROOT"
echo "Pattern: $PATTERN_ABS"
echo "Space:   $SPACE"
echo "Public:  $PUBLIC_URL  (toolshed :$TOOLSHED_PORT, shell :$SHELL_PORT, inspect :$INSPECT_PORT)"
: > "$PIDFILE"

# ---------- toolshed (with --inspect) ----------
# SHELL_URL tells the toolshed where to proxy the shell from. It has no default,
# and our shell is on an OFFSET port — without this the toolshed serves
# "Shell app not available" and the shared URL is broken.
cd "$REPO_ROOT/runtime/toolshed"
[ -f .env ] || printf 'ENV=development\nLOG_LEVEL=info\nCFTS_AI_GATEWAY_URL=\n' > .env
echo "Starting toolshed..."
nohup env SHELL_URL="http://localhost:$SHELL_PORT" \
  deno run --unstable-otel -A --inspect=127.0.0.1:"$INSPECT_PORT" \
  --env-file=.env index.ts --port="$TOOLSHED_PORT" > /tmp/cf-share-toolshed.log 2>&1 &
echo $! >> "$PIDFILE"

# ---------- shell (API_URL = the public ts.net URL, NOT localhost) ----------
cd "$REPO_ROOT/runtime/shell"
rm -rf dist
echo "Starting shell (API_URL=$PUBLIC_URL)..."
nohup env SHELL_PORT="$SHELL_PORT" API_URL="$PUBLIC_URL" \
  deno run -A ../../base/felt/cli.ts dev . > /tmp/cf-share-shell.log 2>&1 &
echo $! >> "$PIDFILE"

# ---------- wait for both to come up ----------
wait_http() {
  local url="$1" name="$2" i
  printf "Waiting for %s" "$name"
  for i in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ] && { echo " ok"; return 0; }
    printf "."; sleep 1
  done
  echo " TIMEOUT"; echo "  see /tmp/cf-share-${name}.log" >&2; return 1
}
wait_http "http://localhost:$TOOLSHED_PORT/_health" toolshed || exit 1
wait_http "http://localhost:$SHELL_PORT/" shell || exit 1

# ---------- identity + deploy ----------
cd "$REPO_ROOT" || exit 1   # cf.key is minted/resolved relative to here

# Deploy as a unique per-user key, NOT the shared "implicit trust" operator key.
# This piece is your work, and the toolshed accepts any identity; deploying as
# the operator key collapses you into the local server principal (and into one
# identity for user counting). See docs/features/shared-identity.md.
cf_cli() { deno run -A runtime/cli/mod.ts "$@"; }

# Mint via a temp file and move into place only on success — a failed keygen
# must never leave an empty/partial cf.key that the guard below would then trust.
mint_key() {
  local tmp
  tmp="$(mktemp)" || { echo "mktemp failed" >&2; exit 1; }
  if cf_cli id new > "$tmp" && [ -s "$tmp" ]; then
    chmod 600 "$tmp"; mv "$tmp" cf.key
  else
    rm -f "$tmp"; echo "failed to mint deploy identity" >&2; exit 1
  fi
}

if [ ! -f cf.key ]; then
  echo "Minting a unique deploy identity (cf.key)..."
  mint_key
else
  # Older versions of this script derived the shared "implicit trust" key into
  # cf.key. Keeping such a key would silently keep deploying (and, via the
  # tailnet URL, acting) as the server operator. Detect it by DID and re-mint.
  existing_did="$(cf_cli id did cf.key 2>/dev/null || true)"
  implicit_tmp="$(mktemp)" || { echo "mktemp failed" >&2; exit 1; }
  cf_cli id derive "implicit trust" > "$implicit_tmp" 2>/dev/null
  implicit_did="$(cf_cli id did "$implicit_tmp" 2>/dev/null || true)"
  rm -f "$implicit_tmp"
  if [ -n "$existing_did" ] && [ "$existing_did" = "$implicit_did" ]; then
    echo "  cf.key is the shared \"implicit trust\" operator key — re-minting a unique one" >&2
    echo "  (previous key backed up to cf.key.implicit-trust.bak)" >&2
    mv cf.key cf.key.implicit-trust.bak
    mint_key
  fi
fi
echo "Deploying $(basename "$PATTERN_ABS")..."
DEPLOY_OUT="$(deno task cf piece new "$PATTERN_ABS" -i cf.key -a "http://localhost:$TOOLSHED_PORT" -s "$SPACE" 2>&1)"
PIECE_ID="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'fid[0-9]+:[A-Za-z0-9_-]+' | head -1)"
[ -n "$PIECE_ID" ] || { echo "deploy failed:" >&2; printf '%s\n' "$DEPLOY_OUT" | tail -20 >&2; exit 1; }

# ---------- expose on the tailnet ----------
tailscale serve --bg "$TOOLSHED_PORT" >/dev/null 2>&1
echo "$TOOLSHED_PORT" > "$SERVEFILE"

cat <<EOF

==================================================================
 Shareable URL (tailnet only):

   $PUBLIC_URL/$SPACE/$PIECE_ID

 Server inspector (chrome://inspect -> add):  127.0.0.1:$INSPECT_PORT

 Tear down:  scripts/share-pattern-via-tailscale.sh --down
==================================================================
EOF
