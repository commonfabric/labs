#!/usr/bin/env bash
# Check health of local dev servers.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/common/port-utils.sh"
read_base_ports

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}

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
            echo "Unknown option: $1"
            echo "Usage: $0 [--port-offset N] [--shell-port PORT] [--toolshed-port PORT]"
            exit 1
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((BASE_SHELL_PORT + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((BASE_TOOLSHED_PORT + PORT_OFFSET))}

ALL_OK=true

check_server() {
    local name=$1
    local url=$2
    local port=$3

    local pids
    pids=$(get_pids_on_port "$port")

    if [[ -z "$pids" ]]; then
        echo "  $name: not running (nothing on port $port)"
        ALL_OK=false
        return
    fi

    local curl_output=""
    local curl_exit=0
    local status=""
    local total_time=""
    local metrics_file=""
    local error_file=""

    metrics_file=$(mktemp)
    error_file=$(mktemp)

    if curl -sS -o /dev/null -w "%{http_code} %{time_total}" "$url" >"$metrics_file" 2>"$error_file"; then
        curl_output="$(cat "$metrics_file")"
    else
        curl_exit=$?
        curl_output="$(cat "$error_file")"
    fi

    rm -f "$metrics_file" "$error_file"

    if [[ "$curl_exit" -eq 0 ]]; then
        status="${curl_output%% *}"
        total_time="${curl_output#* }"
        if [[ "$status" == "200" ]]; then
            echo "  $name: ok ($url, ${total_time}s)"
            return
        fi

        echo "  $name: process on port $port but HTTP status $status after ${total_time}s ($url)"
        ALL_OK=false
        return
    fi

    echo "  $name: process on port $port but curl failed with exit $curl_exit ($url)"
    if [[ -n "$curl_output" ]]; then
        echo "    curl: $curl_output"
    fi
    ALL_OK=false
}

check_server "Toolshed" "http://localhost:$TOOLSHED_PORT/_health" "$TOOLSHED_PORT"
check_server "Shell" "http://localhost:$SHELL_PORT" "$SHELL_PORT"
# The page a browser loads, which the toolshed answers by fetching the shell
# dev server. It fails while both checks above report success whenever that hop
# is broken.
check_server "Shell through toolshed" "http://localhost:$TOOLSHED_PORT/" "$TOOLSHED_PORT"

if [[ "$ALL_OK" == "true" ]]; then
    echo "All servers healthy."
else
    echo "Some servers are not healthy."
    exit 1
fi
