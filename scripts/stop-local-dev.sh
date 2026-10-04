#!/usr/bin/env bash
# Kill any deno process on the specified ports
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/common/port-utils.sh"
read_base_ports

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}
# The console is stopped only when asked for, the same way it is started. Its
# port is not offset, so one machine's fabrics share it, and a stop that reached
# for it unasked would take down a console another fabric is serving.
CF_HARNESS=false
CONSOLE_PORT=${CF_HARNESS_CONSOLE_PORT:-8135}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --port-offset)
            PORT_OFFSET="$2"
            shift 2
            ;;
        --port-offset=*)
            PORT_OFFSET="${1#*=}"
            shift
            ;;
        --cf-harness)
            CF_HARNESS=true
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
            shift
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((BASE_SHELL_PORT + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((BASE_TOOLSHED_PORT + PORT_OFFSET))}

# Kill deno processes listening on a specific port
kill_deno_on_port() {
    local port=$1
    local pids
    pids=$(get_pids_on_port "$port")

    for pid in $pids; do
        # Only kill if it's a deno process
        if ps -p "$pid" -o comm= 2>/dev/null | grep -q deno; then
            kill -9 "$pid" 2>/dev/null
        fi
    done
}

kill_deno_on_port "$SHELL_PORT"
kill_deno_on_port "$TOOLSHED_PORT"
if [[ "$CF_HARNESS" == "true" ]]; then
    kill_deno_on_port "$CONSOLE_PORT"
fi
