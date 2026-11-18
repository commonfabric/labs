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
#   * The servers keep running after this script returns, until --down stops
#     them. Their logs and process ids are in tmp/share-pattern-via-tailscale/
#     in this checkout. If the script fails or is interrupted before it prints
#     the shareable URL, it stops the servers it started. While a share from
#     this checkout is running, or while anything answers on one of the ports,
#     the script refuses to start another.
#   * THE GOTCHA this script handles for you: the shell's `dev-local` task bakes
#     API_URL=http://localhost into the bundle (felt.config.ts `$API_URL`
#     define; shell/src/lib/env.ts only falls back to same-origin when it is
#     unset), which breaks REMOTE browsers. This script launches the shell with
#     API_URL set to your machine's MagicDNS name instead.
#
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_ROOT/tmp/share-pattern-via-tailscale"
PIDFILE="$STATE_DIR/pids"

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
    -h|--help) sed -n '/^set -u/q;3,$p' "$0"; exit 0;;
    -*) echo "unknown option: $1" >&2; exit 2;;
    *) PATTERN="$1"; shift;;
  esac
done

# The time the process `$1` started, which tells it apart from a later process
# given the same pid, written the same way whatever the time zone and locale.
# Empty for a pid no process has.
started_at() {
  LC_ALL=C TZ=UTC0 ps -o lstart= -p "$1" | xargs
}

# The pids of the recorded servers that are still running. A recorded pid whose
# process did not start at the recorded time is left out, so that a later
# process given the same pid is left alone.
running_servers() {
  [ -f "$PIDFILE" ] || return 0
  local pid started
  while read -r pid started; do
    [ -n "$started" ] && [ "$(started_at "$pid")" = "$started" ] && echo "$pid"
  done < "$PIDFILE"
}

# Each server leads a process group of its own, so this stops each server
# along with anything it started.
stop_servers() {
  local pid stopped=""
  for pid in $(running_servers); do
    kill -- "-$pid" 2>/dev/null && echo "  stopped pid $pid" && stopped=1
  done
  [ -n "$stopped" ] || echo "  none of the servers this checkout recorded is running"
  rm -f "$PIDFILE"
}

# ---------- teardown ----------
# The tailscale serve mapping is one per machine, so it is turned off only by a
# checkout that has a record of a share.
if [ "$DOWN" = "1" ]; then
  if [ -f "$PIDFILE" ]; then
    echo "Disabling tailscale serve..."
    tailscale serve --https=443 off 2>/dev/null || true
    stop_servers
  else
    echo "This checkout has no record of a share, so there is nothing to stop."
    echo "If a share from it is still running, stop its servers by hand, and"
    echo "turn off the tailnet mapping with 'tailscale serve --https=443 off'."
  fi
  echo "Done."
  exit 0
fi

[ -n "$PATTERN" ] || { echo "error: pass a pattern, e.g. patterns/apps/lunch-poll/main.tsx" >&2; exit 2; }
PATTERN_ABS="$(cd "$(dirname "$PATTERN")" 2>/dev/null && pwd)/$(basename "$PATTERN")"
[ -f "$PATTERN_ABS" ] || { echo "error: pattern not found: $PATTERN" >&2; exit 2; }
[ -n "$SPACE" ] || SPACE="$(basename "$(dirname "$PATTERN_ABS")")-demo"
[ -z "$(running_servers)" ] || {
  echo "error: this checkout is already sharing a pattern; stop it with --down first" >&2
  exit 1
}
# A server this script starts cannot bind a port something already answers on,
# and a server answering on the toolshed or shell port would answer in place
# of the one this script starts.
for port in "$TOOLSHED_PORT" "$SHELL_PORT" "$INSPECT_PORT"; do
  if (: < "/dev/tcp/localhost/$port") 2>/dev/null; then
    echo "error: port $port is already in use; choose another with the port options" >&2
    exit 1
  fi
done

# ---------- MagicDNS name = the public URL ----------
DNSNAME="$(tailscale status --json 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null)"
[ -n "$DNSNAME" ] || { echo "error: not on Tailscale (no MagicDNS name). Connect to the tailnet first." >&2; exit 1; }
PUBLIC_URL="https://$DNSNAME"

echo "Repo:    $REPO_ROOT"
echo "Pattern: $PATTERN_ABS"
echo "Space:   $SPACE"
echo "Public:  $PUBLIC_URL  (toolshed :$TOOLSHED_PORT, shell :$SHELL_PORT, inspect :$INSPECT_PORT)"
mkdir -p "$STATE_DIR" && : > "$PIDFILE" || exit 1

# Until the URL is printed, the servers end when this script does, whether it
# fails or a signal ends it.
trap stop_servers EXIT

# Run a server in the background, writing to the log file `$1`, and record its
# pid and the time it started. Job control gives the server a process group of
# its own, so that it keeps running when whatever ran this script ends the
# script's process group after the script returns. Job control is on only for
# the launch, since it also gives each foreground command a group of its own
# and hands it the terminal. A job started under job control keeps the
# script's standard input, so the server reads /dev/null instead.
launch_server() {
  local log="$1"
  shift
  set -m
  "$@" < /dev/null > "$log" 2>&1 &
  set +m
  echo "$! $(started_at "$!")" >> "$PIDFILE"
}

# ---------- toolshed (with --inspect) ----------
# SHELL_URL tells the toolshed where to proxy the shell from. It has no default,
# and our shell is on an OFFSET port — without this the toolshed serves
# "Shell app not available" and the shared URL is broken.
cd "$REPO_ROOT/runtime/toolshed"
[ -f .env ] || printf 'ENV=development\nLOG_LEVEL=info\nCFTS_AI_GATEWAY_URL=\n' > .env
echo "Starting toolshed..."
launch_server "$STATE_DIR/toolshed.log" \
  env SHELL_URL="http://localhost:$SHELL_PORT" \
  deno run --unstable-otel -A --inspect=127.0.0.1:"$INSPECT_PORT" \
  --env-file=.env index.ts --port="$TOOLSHED_PORT"

# ---------- shell (API_URL = the public ts.net URL, NOT localhost) ----------
cd "$REPO_ROOT/runtime/shell"
rm -rf dist
echo "Starting shell (API_URL=$PUBLIC_URL)..."
launch_server "$STATE_DIR/shell.log" \
  env SHELL_PORT="$SHELL_PORT" API_URL="$PUBLIC_URL" \
  deno run -A ../../base/felt/cli.ts dev .

# ---------- wait for both to come up ----------
wait_http() {
  local url="$1" name="$2" i
  printf "Waiting for %s" "$name"
  for i in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ] && { echo " ok"; return 0; }
    printf "."; sleep 1
  done
  echo " TIMEOUT"; echo "  see $STATE_DIR/${name}.log" >&2; return 1
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
tailscale serve --bg "$TOOLSHED_PORT" >/dev/null || {
  echo "error: tailscale serve failed" >&2
  exit 1
}

# The servers are the caller's from here on, to stop with --down.
trap - EXIT

cat <<EOF

==================================================================
 Shareable URL (tailnet only):

   $PUBLIC_URL/$SPACE/$PIECE_ID

 Server inspector (chrome://inspect -> add):  127.0.0.1:$INSPECT_PORT

 Tear down:  $REPO_ROOT/scripts/share-pattern-via-tailscale.sh --down
==================================================================
EOF
