#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Source shared utilities
source "$SCRIPT_DIR/common/port-utils.sh"
read_base_ports

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}
INSPECT=false
INSPECT_BRK=false
INSPECT_PORT=${INSPECT_PORT:-}

# Parse command line arguments
CLEAR_CACHE=false
CLEAR_ALL_SPACES=false
FORCE=false
WATCH=false
# Flags this script has no opinion about, forwarded to start-local-dev.sh.
# This script is a wrapper around that one, so its surface is the other's, and
# refusing a flag it has not heard of makes every caller wait for this file to
# learn about it. That reaches further than convenience: loom drives the
# daemon's toolshed recovery through here at whatever labs commit it vendors,
# so a refusal is an instance whose toolshed never comes back.
PASSTHROUGH_ARGS=()
CF_HARNESS=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --clear-cache)
            CLEAR_CACHE=true
            shift
            ;;
        --dangerously-clear-all-spaces)
            CLEAR_ALL_SPACES=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --watch)
            WATCH=true
            shift
            ;;
        --cf-harness)
            CF_HARNESS=true
            shift
            ;;
        --inspect)
            INSPECT=true
            shift
            ;;
        --inspect-brk)
            INSPECT=true
            INSPECT_BRK=true
            shift
            ;;
        --inspect-port)
            INSPECT=true
            INSPECT_PORT="$2"
            shift 2
            ;;
        --inspect-port=*)
            INSPECT=true
            INSPECT_PORT="${1#*=}"
            shift
            ;;
        --port-offset)
            PORT_OFFSET="$2"
            shift 2
            ;;
        --port-offset=*)
            PORT_OFFSET="${1#*=}"
            shift
            ;;
        --shell-port)
            SHELL_PORT="$2"
            shift 2
            ;;
        --shell-port=*)
            SHELL_PORT="${1#*=}"
            shift
            ;;
        --toolshed-port)
            TOOLSHED_PORT="$2"
            shift 2
            ;;
        --toolshed-port=*)
            TOOLSHED_PORT="${1#*=}"
            shift
            ;;
        *)
            echo "Forwarding to start-local-dev.sh: $1"
            PASSTHROUGH_ARGS+=("$1")
            shift
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((BASE_SHELL_PORT + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((BASE_TOOLSHED_PORT + PORT_OFFSET))}

# Checked here, ahead of the stop and the cache and space clearing below, so an
# offset start-local-dev.sh will refuse costs nothing on the way to the refusal.
require_reachable_port "shell" "$SHELL_PORT"
require_reachable_port "toolshed" "$TOOLSHED_PORT"
if [[ "$INSPECT" == "true" ]]; then
    # The port start-local-dev.sh would pick for an --inspect run that names
    # none, resolved here so the check covers it and the start it hands to
    # binds the port that was checked.
    INSPECT_PORT=${INSPECT_PORT:-$((BASE_INSPECTOR_PORT + PORT_OFFSET))}
    require_reachable_port "inspector" "$INSPECT_PORT"
fi

# Export for child scripts
export SHELL_PORT
export TOOLSHED_PORT
export PORT_OFFSET

echo "Stopping local dev servers..."
# The forwarded flags reach the stop as well as the start, so `--cf-harness`
# cycles the console with the pair rather than leaving the old one holding its
# port against the new one.
STOP_ARGS=(--shell-port "$SHELL_PORT" --toolshed-port "$TOOLSHED_PORT")
if [[ "$CF_HARNESS" == "true" ]]; then
    STOP_ARGS+=(--cf-harness)
fi
./scripts/stop-local-dev.sh "${STOP_ARGS[@]}" "${PASSTHROUGH_ARGS[@]}"

CACHE_DIR="packages/toolshed/cache"

if [[ "$CLEAR_CACHE" == "true" ]]; then
    echo "Clearing disposable caches (preserving spaces/databases)..."
    # Clear all cache subdirectories except 'memory' which contains databases
    if [[ -d "$CACHE_DIR" ]]; then
        find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type d ! -name 'memory' -exec rm -rf {} +
        # Also remove any loose files in cache root
        find "$CACHE_DIR" -maxdepth 1 -type f -delete
    fi
    echo "Disposable caches cleared."
fi

if [[ "$CLEAR_ALL_SPACES" == "true" ]]; then
    echo "WARNING: Clearing all spaces/databases..."
    if [[ -d "$CACHE_DIR/memory" ]]; then
        rm -rf "$CACHE_DIR/memory"
    fi
    echo "Spaces/databases cleared."
fi

echo "Starting local dev servers..."
START_ARGS="--shell-port $SHELL_PORT --toolshed-port $TOOLSHED_PORT"
if [[ "$FORCE" == "true" ]]; then
    START_ARGS="$START_ARGS --force"
fi
if [[ "$WATCH" == "true" ]]; then
    START_ARGS="$START_ARGS --watch"
fi
if [[ "$CF_HARNESS" == "true" ]]; then
    START_ARGS="$START_ARGS --cf-harness"
fi
if [[ "$INSPECT" == "true" ]]; then
    if [[ "$INSPECT_BRK" == "true" ]]; then
        START_ARGS="$START_ARGS --inspect-brk"
    else
        START_ARGS="$START_ARGS --inspect"
    fi
    if [[ -n "$INSPECT_PORT" ]]; then
        START_ARGS="$START_ARGS --inspect-port $INSPECT_PORT"
    fi
fi
./scripts/start-local-dev.sh $START_ARGS "${PASSTHROUGH_ARGS[@]}"
