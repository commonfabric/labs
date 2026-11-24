#!/usr/bin/env bash
# Shared utilities for port detection across macOS and Linux

# Get PIDs listening on a port (cross-platform)
# Usage: get_pids_on_port <port>
#
# Output contract: newline-separated numeric PIDs, or empty if none found.
# Callers pipe this straight into kill, so no branch may ever leak
# non-numeric text (e.g. tool error messages) to stdout.
get_pids_on_port() {
    local port=$1

    # lsof is the primary detector on macOS, but it lives in /usr/sbin,
    # which minimal PATHs (e.g. launchd-spawned processes) often omit.
    # Probe absolute locations before giving up on it.
    local lsof_bin=""
    if command -v lsof &>/dev/null; then
        lsof_bin=lsof
    elif [[ -x /usr/sbin/lsof ]]; then
        lsof_bin=/usr/sbin/lsof
    elif [[ -x /usr/bin/lsof ]]; then
        lsof_bin=/usr/bin/lsof
    fi

    {
        if [[ -n "$lsof_bin" ]]; then
            "$lsof_bin" -ti :"$port" -sTCP:LISTEN 2>/dev/null
        elif command -v ss &>/dev/null; then
            # Use awk instead of grep -P for portability
            ss -tlnp "sport = :$port" 2>/dev/null | awk -F'pid=' '{for(i=2;i<=NF;i++){split($i,a,","); print a[1]}}' | sort -u
        elif [[ "$(uname)" == "Linux" ]] && command -v fuser &>/dev/null; then
            # Linux only: macOS fuser has no port/tcp form and would print
            # an error instead of PIDs. fuser outputs to stderr, and
            # prefixes with port info.
            fuser "$port/tcp" 2>&1 | awk '{for(i=2;i<=NF;i++) print $i}'
        fi
    } | grep -E '^[0-9]+$' || true
}

# Locate ports.json at repo root, requiring the jq used to read it
# Usage: ports_json_path
ports_json_path() {
    if ! command -v jq &>/dev/null; then
        echo "Error: jq is required but not found. Install with: brew install jq" >&2
        exit 1
    fi
    local ports_file
    ports_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/ports.json"
    if [[ ! -f "$ports_file" ]]; then
        echo "Error: $ports_file not found" >&2
        exit 1
    fi
    echo "$ports_file"
}

# Read base ports from ports.json at repo root
read_base_ports() {
    local ports_file
    ports_file="$(ports_json_path)"
    BASE_TOOLSHED_PORT=$(jq -e '.toolshed' "$ports_file") || { echo "Error: ports.json missing .toolshed" >&2; exit 1; }
    BASE_SHELL_PORT=$(jq -e '.shell' "$ports_file") || { echo "Error: ports.json missing .shell" >&2; exit 1; }
    BASE_INSPECTOR_PORT=$(jq -e '.inspector' "$ports_file") || { echo "Error: ports.json missing .inspector" >&2; exit 1; }
}

# Read the ports clients refuse to connect to into BLOCKED_PORTS, space
# separated. Browsers and Deno's fetch both implement the WHATWG bad-port list
# and reject a request to one of these before opening a connection, so a server
# that binds one starts and answers a curl health check while the browser and
# every server-to-server hop cannot reach it.
read_blocked_ports() {
    local ports_file
    ports_file="$(ports_json_path)"
    BLOCKED_PORTS=$(jq -er '.blockedPorts | join(" ")' "$ports_file") || { echo "Error: ports.json missing .blockedPorts" >&2; exit 1; }
}

# Report whether a port is one clients refuse to connect to
# Usage: port_is_blocked <port>
port_is_blocked() {
    local port=$1
    local blocked
    for blocked in $BLOCKED_PORTS; do
        if (( port == blocked )); then
            return 0
        fi
    done
    return 1
}

# Exit code emitted when a requested port is one clients refuse to connect to.
# The offset has to change; retrying it reaches the same port.
PORT_UNREACHABLE_EXIT=4

# Refuse a port that clients will not talk to. Such a port binds, so the server
# starts and answers a curl health check, and then the browser cannot load the
# page and toolshed's proxy hop to the shell dev server fails. Checked before a
# script acts on the port, because the later failure surfaces as a test waiting
# on state that never arrives. Reads the list from ports.json on every call, so
# the answer comes from the repository rather than from whatever a caller's
# environment happens to carry in BLOCKED_PORTS.
# Usage: require_reachable_port <server name> <port>
require_reachable_port() {
    local name=$1
    local port=$2

    read_blocked_ports
    port_is_blocked "$port" || return 0

    echo "Error: $name port $port is one clients refuse to connect to." >&2
    echo "       Browsers and Deno's fetch reject a request to it before" >&2
    echo "       opening a connection, so a server here binds but nothing" >&2
    echo "       reaches it. Choose a port offset that moves $name elsewhere." >&2
    exit "$PORT_UNREACHABLE_EXIT"
}
