#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Source shared utilities
source "$SCRIPT_DIR/common/port-utils.sh"
source "$SCRIPT_DIR/common/console-args.sh"
read_base_ports

require_command() {
    local command_name=$1
    local install_hint=$2

    if ! command -v "$command_name" &>/dev/null; then
        echo "Error: $command_name is required but not found." >&2
        if [[ -n "$install_hint" ]]; then
            echo "       $install_hint" >&2
        fi
        exit 1
    fi
}

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}
INSPECT=false
INSPECT_BRK=false
INSPECT_PORT=${INSPECT_PORT:-}
LOCAL_DEV_STARTUP_TIMEOUT=${LOCAL_DEV_STARTUP_TIMEOUT:-120}

# Source-run build metadata: default COMMIT_SHA to this checkout's HEAD so
# toolshed's /api/meta reports the commit it is running — cf compares its own
# commit against it to detect version skew. An explicit COMMIT_SHA wins.
if [[ -z "${COMMIT_SHA:-}" ]]; then
    COMMIT_SHA="$(git -C "$SCRIPT_DIR/.." rev-parse HEAD 2>/dev/null || true)"
fi
export COMMIT_SHA

# Exit code emitted when a server cannot bind because its port is already in
# use. Callers can retry on a different port.
PORT_IN_USE_EXIT=3

# Parse command line arguments
FORCE=false
WATCH=false
BG_UPDATER=false
# The console is opt-in and stays that way. An inherited loom variable is a
# fact about the process tree, not a request for a console, and a flag is the
# only thing loom needs to know about cf-harness.
CF_HARNESS=false
# Whether the console this script may start runs skill scripts in its sandbox.
# The operator's decision, and no part of starting a fabric implies it, so it
# is off unless named and passed through to the launcher, which prints it.
CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG=false
while [[ $# -gt 0 ]]; do
    case $1 in
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
        --allow-skill-scripts)
            CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG=true
            shift
            ;;
        --bg-updater)
            BG_UPDATER=true
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
            shift
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((BASE_SHELL_PORT + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((BASE_TOOLSHED_PORT + PORT_OFFSET))}
INSPECT_PORT=${INSPECT_PORT:-$((BASE_INSPECTOR_PORT + PORT_OFFSET))}

# Not derived from PORT_OFFSET: this is the port Weaver pairs with and loom's
# `/harness-console/*` proxy resolves the same way, so a fabric that needs
# another one names it and both sides read it from the same place.
CONSOLE_PORT=${CF_HARNESS_CONSOLE_PORT:-8135}
# Read as decimal. Shell arithmetic takes a leading zero for octal, so an
# environment that spells the port `010080` would compare as 4160 and slip past
# the blocked-port check below. A value that is not a number at all is left as
# it is: the launcher refuses it by name, which says more than this could.
if [[ "$CONSOLE_PORT" =~ ^[0-9]+$ ]]; then
    CONSOLE_PORT=$((10#$CONSOLE_PORT))
fi

require_reachable_port "shell" "$SHELL_PORT"
require_reachable_port "toolshed" "$TOOLSHED_PORT"
if [[ "$INSPECT" == "true" ]]; then
    require_reachable_port "inspector" "$INSPECT_PORT"
fi

# Export for child processes
export SHELL_PORT
export TOOLSHED_PORT

TOOLSHED_API_URL=${API_URL:-"http://localhost:$TOOLSHED_PORT"}
TOOLSHED_MEMORY_URL=${MEMORY_URL:-"$TOOLSHED_API_URL"}

require_command "deno" \
    "Run 'mise install' from the repo root or install Deno before starting local dev."
require_command "curl" \
    "Install curl so startup can verify that local dev servers reached HTTP 200."

KEEP_ALIVE=false
if [[ -n "${CODEX_SANDBOX:-}" ]]; then
    KEEP_ALIVE=true
fi

SHELL_LOG="$SCRIPT_DIR/../packages/shell/local-dev-shell.log"
TOOLSHED_LOG="$SCRIPT_DIR/../packages/toolshed/local-dev-toolshed.log"
BG_LOG="$SCRIPT_DIR/../packages/background-piece-service/local-dev-bg.log"
CONSOLE_LOG="$SCRIPT_DIR/../packages/cf-harness/local-dev-console.log"
SHELL_PID=""
TOOLSHED_PID=""
BG_PID=""
CONSOLE_PID=""

# With --force, kill anything already listening on the port so the server can
# bind it. Without --force the port is left untouched: each server reports a
# collision when its own bind fails (exit PORT_IN_USE_EXIT), which avoids a
# check-then-bind race.
free_port_if_forced() {
    local port=$1
    [[ "$FORCE" == "true" ]] || return 0

    local pids
    pids=$(get_pids_on_port "$port")
    if [[ -n "$pids" ]]; then
        echo "Port $port is in use, killing processes: $pids"
        echo "$pids" | xargs kill 2>/dev/null
        sleep 1
        # Force kill if still running
        pids=$(get_pids_on_port "$port")
        if [[ -n "$pids" ]]; then
            echo "Force killing remaining processes: $pids"
            echo "$pids" | xargs kill -9 2>/dev/null
            sleep 1
        fi
    fi
}

free_port_if_forced "$TOOLSHED_PORT"
free_port_if_forced "$SHELL_PORT"
# Deliberately not the console's port. `--force` frees the ports THIS fabric
# owns, and the console's is not one of them: it is not derived from
# PORT_OFFSET, so every fabric on the machine addresses the same one, and
# freeing it here would let one fabric's start kill another's console. A
# console whose port is taken fails the way every other console failure does
# — loudly, and without touching the pair.

show_recent_log() {
    local name=$1
    local log_file=$2

    if [[ -f "$log_file" ]]; then
        echo "" >&2
        echo "Last 40 lines from $name log ($log_file):" >&2
        tail -n 40 "$log_file" >&2
    fi
}

# Kill a process and all of its descendants. Targets only processes this script
# started, so a foreign server already on one of the ports (for example another
# run's server during a port collision) is left untouched.
kill_tree() {
    local pid=$1
    [[ -n "$pid" ]] || return 0

    local child
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null
}

cleanup_started_processes() {
    kill_tree "$CONSOLE_PID"
    kill_tree "$BG_PID"
    kill_tree "$TOOLSHED_PID"
    kill_tree "$SHELL_PID"
}

fail_startup() {
    local message=$1

    echo "Error: $message" >&2
    cleanup_started_processes
    show_recent_log "shell" "$SHELL_LOG"
    show_recent_log "toolshed" "$TOOLSHED_LOG"
    exit 1
}

ensure_process_running() {
    local name=$1
    local pid=$2
    local log_file=$3
    local process_state

    if kill -0 "$pid" 2>/dev/null; then
        process_state=$(ps -p "$pid" -o stat= 2>/dev/null)
        if [[ "$process_state" != *Z* ]]; then
            return
        fi
    fi

    wait "$pid" 2>/dev/null
    local exit_status=$?
    echo "Error: $name exited before it became ready (exit $exit_status)." >&2
    cleanup_started_processes
    show_recent_log "$name" "$log_file"
    if [[ "$exit_status" -eq "$PORT_IN_USE_EXIT" ]]; then
        echo "($name could not bind its port; it is already in use.)" >&2
        exit "$PORT_IN_USE_EXIT"
    fi
    exit 1
}

wait_for_http() {
    local name=$1
    local url=$2
    local pid=$3
    local log_file=$4
    local deadline=$((SECONDS + LOCAL_DEV_STARTUP_TIMEOUT))
    local remaining
    local status

    echo "Waiting for $name at $url..."
    while (( SECONDS < deadline )); do
        ensure_process_running "$name" "$pid" "$log_file"

        remaining=$((deadline - SECONDS))
        if (( remaining > 2 )); then
            remaining=2
        fi

        status=$(
            curl -s -o /dev/null -w "%{http_code}" --max-time "$remaining" \
                "$url" 2>/dev/null
        )
        if [[ "$status" == "200" ]]; then
            echo "  $name is ready."
            return
        fi

        if (( SECONDS < deadline )); then
            sleep 1
        fi
    done

    fail_startup \
        "$name did not become ready at $url within ${LOCAL_DEV_STARTUP_TIMEOUT}s."
}

# Wait until the server reports a successful bind (its listen marker) or its
# process exits. ensure_process_running classifies an early exit, surfacing
# PORT_IN_USE_EXIT when the bind failed because the port was already in use.
# Waiting on the marker rather than an HTTP probe avoids mistaking another
# server already on the port for this one.
wait_for_listen() {
    local name=$1
    local marker=$2
    local pid=$3
    local log_file=$4
    local deadline=$((SECONDS + LOCAL_DEV_STARTUP_TIMEOUT))

    echo "Waiting for $name to bind its port..."
    while (( SECONDS < deadline )); do
        ensure_process_running "$name" "$pid" "$log_file"
        if grep -q "$marker" "$log_file" 2>/dev/null; then
            echo "  $name has bound its port."
            return
        fi
        sleep 1
    done

    fail_startup "$name did not bind its port within ${LOCAL_DEV_STARTUP_TIMEOUT}s."
}

# Start shell dev server in background
cd "$SCRIPT_DIR/../packages/shell"
TOOLSHED_PORT="$TOOLSHED_PORT" deno task dev-local > "$SHELL_LOG" 2>&1 &
SHELL_PID=$!

# Start toolshed dev server in background
# We pass --port= as CLI arg because deno --watch doesn't pass env vars to subprocess
cd "$SCRIPT_DIR/../packages/toolshed"
WATCH_FLAG=""
if [[ "$WATCH" == "true" ]]; then
    WATCH_FLAG="--watch"
fi
INSPECT_FLAG=""
if [[ "$INSPECT" == "true" ]]; then
    if [[ "$INSPECT_BRK" == "true" ]]; then
        INSPECT_FLAG="--inspect-brk=127.0.0.1:$INSPECT_PORT"
    else
        INSPECT_FLAG="--inspect=127.0.0.1:$INSPECT_PORT"
    fi
fi
SHELL_URL="http://localhost:$SHELL_PORT" \
    API_URL="$TOOLSHED_API_URL" \
    MEMORY_URL="$TOOLSHED_MEMORY_URL" \
    deno run --unstable-otel -A $INSPECT_FLAG $WATCH_FLAG \
        --env-file=.env index.ts --port="$TOOLSHED_PORT" \
        > "$TOOLSHED_LOG" 2>&1 &
TOOLSHED_PID=$!

wait_for_listen "shell" "Dev server listening on" "$SHELL_PID" "$SHELL_LOG"
wait_for_http "shell" "http://localhost:$SHELL_PORT" "$SHELL_PID" "$SHELL_LOG"

# # Function to cleanup background processes
# cleanup() {
#     kill $SHELL_PID $TOOLSHED_PID 2>/dev/null
#     exit
# }

# # Set up trap to cleanup on script exit
# trap cleanup EXIT INT TERM

wait_for_listen "toolshed" "Server running on" "$TOOLSHED_PID" "$TOOLSHED_LOG"
wait_for_http \
    "toolshed" "http://localhost:$TOOLSHED_PORT/_health" \
    "$TOOLSHED_PID" "$TOOLSHED_LOG"

# The page a browser loads: the toolshed serving the shell it proxies. The two
# checks above cover each server on its own port, and this one covers the hop
# between them, which the toolshed makes with fetch() rather than with curl.
wait_for_http \
    "shell through toolshed" "http://localhost:$TOOLSHED_PORT/" \
    "$TOOLSHED_PID" "$TOOLSHED_LOG"

# The cf-harness console, on the fabric the toolshed above is now serving.
#
# It never fails this script. The toolshed and the shell are the stack; the
# console is a surface on top of it, and a person whose Docker is off or whose
# model provider is not connected should still get a working fabric. So every
# way the console can fail to come up is reported here and written to its log,
# and none of them stops the servers that did come up.
CONSOLE_STATUS=""

console_unavailable() {
    local reason=$1

    echo "" >&2
    echo "Error: cf-harness console did not start: $reason" >&2
    echo "  The shell and toolshed are unaffected and still running." >&2
    echo "  Console log: packages/cf-harness/local-dev-console.log" >&2
    kill_tree "$CONSOLE_PID"
    CONSOLE_PID=""
    CONSOLE_STATUS="$reason"
    CF_HARNESS=false
}

read_blocked_ports
if [[ "$CF_HARNESS" == "true" ]] && port_is_blocked "$CONSOLE_PORT"; then
    # Checked here rather than beside the pair's ports, which exit the script:
    # a console port a client refuses to connect to is a console problem, and a
    # console problem never stops the fabric.
    console_unavailable \
        "port $CONSOLE_PORT is one clients refuse to connect to, so a console \
there would bind and be unreachable. Set \`CF_HARNESS_CONSOLE_PORT\` elsewhere."
fi

if [[ "$CF_HARNESS" == "true" ]]; then
    # Everything the console needs comes from the fabric this script is
    # starting. The toolshed URL and port are this script's own; the store is
    # the directory the toolshed above was given, as a path rather than the
    # `file://` URL the toolshed reads it as — handing the URL through makes
    # the console's label reader walk nothing and read another store's cells.
    # `--instance` is how the identity and space are read off a loom instance;
    # without one, `CF_IDENTITY` and `CF_SPACE` name them and their absence is
    # the launcher's named error.
    # The toolshed above runs in `packages/toolshed`, so an unset `MEMORY_DIR`
    # leaves it on that directory's own `cache/memory`, which is the store the
    # console then has to read.
    CONSOLE_STORE=${MEMORY_DIR:-"$(cd "$SCRIPT_DIR/../packages/toolshed" && pwd)/cache/memory"}
    export CONSOLE_PORT TOOLSHED_API_URL CONSOLE_STORE \
        CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG
    CONSOLE_ARGS=()
    while IFS= read -r console_arg; do
        CONSOLE_ARGS+=("$console_arg")
    done < <(console_launch_args)

    echo ""
    echo "Starting cf-harness console on port $CONSOLE_PORT..."
    [[ ! -f "$CONSOLE_LOG" ]] || mv -- "$CONSOLE_LOG" "$CONSOLE_LOG.previous"
    (
        cd "$SCRIPT_DIR/.."
        # The console resolves its own store from `--store` above; an inherited
        # `MEMORY_DIR` would be the toolshed's `file://` spelling of it.
        unset MEMORY_DIR
        exec deno task --cwd packages/cf-harness console:launch "${CONSOLE_ARGS[@]}"
    ) > "$CONSOLE_LOG" 2>&1 &
    CONSOLE_PID=$!

    console_deadline=$((SECONDS + LOCAL_DEV_STARTUP_TIMEOUT))
    while (( SECONDS < console_deadline )); do
        if ! kill -0 "$CONSOLE_PID" 2>/dev/null; then
            wait "$CONSOLE_PID" 2>/dev/null
            console_unavailable "it exited before answering (exit $?)"
            break
        fi
        if [[ "$(
            curl -s -o /dev/null -w "%{http_code}" --max-time 2 \
                "http://127.0.0.1:$CONSOLE_PORT/api/health" 2>/dev/null
        )" == "200" ]]; then
            # A console left over from an earlier launch answers this health
            # check too, out of its own code and its own store. What makes the
            # 200 this launch's is the pid listening on the port being the
            # child started above, or one of its descendants.
            console_holder=$(foreign_port_holder "$CONSOLE_PORT" "$CONSOLE_PID")
            if [[ -n "$console_holder" ]]; then
                console_unavailable "port $CONSOLE_PORT is held by pid \
$console_holder, not the console this launch started"
            else
                echo "  cf-harness console is ready."
            fi
            break
        fi
        sleep 1
    done
    if [[ "$CF_HARNESS" == "true" && -n "$CONSOLE_PID" ]] \
        && (( SECONDS >= console_deadline )); then
        console_unavailable \
            "it did not answer /api/health within ${LOCAL_DEV_STARTUP_TIMEOUT}s"
    fi
    if [[ -n "$CONSOLE_STATUS" ]]; then
        show_recent_log "cf-harness console" "$CONSOLE_LOG"
    fi
fi

# Print the toolshed URL on success (when not using --bg-updater, which prints after health check)
if [[ "$BG_UPDATER" != "true" ]]; then
    echo "Development servers started successfully!"
    echo "  Shell:    http://localhost:$SHELL_PORT"
    echo "  Toolshed: http://localhost:$TOOLSHED_PORT"
    if [[ "$INSPECT" == "true" ]]; then
        echo "  Inspect:  127.0.0.1:$INSPECT_PORT"
    fi
    if [[ "$PORT_OFFSET" -ne 0 ]]; then
        echo "  Offset:   $PORT_OFFSET"
    fi
    if [[ "$CF_HARNESS" == "true" ]]; then
        echo "  Console:  http://127.0.0.1:$CONSOLE_PORT"
    elif [[ -n "$CONSOLE_STATUS" ]]; then
        echo "  Console:  NOT RUNNING — $CONSOLE_STATUS"
    fi
    echo "Shell log file: packages/shell/local-dev-shell.log"
    echo "Toolshed log file: packages/toolshed/local-dev-toolshed.log"
    if [[ "$CF_HARNESS" == "true" || -n "$CONSOLE_STATUS" ]]; then
        echo "Console log file: packages/cf-harness/local-dev-console.log"
    fi
fi

# Optionally start background-piece-service for bgUpdater polling
if [[ "$BG_UPDATER" == "true" ]]; then
    echo ""
    echo "Starting background-piece-service..."

    # Kill any previously running bg service to avoid orphaned processes
    BG_PID_FILE="$SCRIPT_DIR/../.bg-piece-service.pid"
    if [[ -f "$BG_PID_FILE" ]]; then
        OLD_BG_PID=$(cat "$BG_PID_FILE")
        if kill -0 "$OLD_BG_PID" 2>/dev/null; then
            echo "  Stopping previous bg service (PID $OLD_BG_PID)..."
            kill "$OLD_BG_PID" 2>/dev/null
            sleep 1
            if kill -0 "$OLD_BG_PID" 2>/dev/null; then
                echo "  Force killing previous bg service..."
                kill -9 "$OLD_BG_PID" 2>/dev/null
            fi
        fi
        rm -f "$BG_PID_FILE"
    fi

    echo "  Toolshed is ready."

    # Start the background service directly (not via deno task, for reliable PID tracking)
    cd "$SCRIPT_DIR/../packages/background-piece-service"
    OPERATOR_PASS="implicit trust" API_URL="http://localhost:$TOOLSHED_PORT" \
        deno run -A --unstable-worker-options src/main.ts \
        > "$BG_LOG" 2>&1 &
    BG_PID=$!
    cd "$SCRIPT_DIR/.."
    sleep 2
    ensure_process_running "background service" "$BG_PID" "$BG_LOG"

    # Save PID for stop script
    echo "$BG_PID" > "$BG_PID_FILE"

    echo "  Background service: PID $BG_PID (polling bgUpdater every 60s)"
    echo "  Log file: packages/background-piece-service/local-dev-bg.log"
    echo ""
    echo "Development servers started successfully!"
    echo "  Shell:    http://localhost:$SHELL_PORT"
    echo "  Toolshed: http://localhost:$TOOLSHED_PORT"
    if [[ "$INSPECT" == "true" ]]; then
        echo "  Inspect:  127.0.0.1:$INSPECT_PORT"
    fi
    if [[ "$PORT_OFFSET" -ne 0 ]]; then
        echo "  Offset:   $PORT_OFFSET"
    fi
    echo "Shell log file: packages/shell/local-dev-shell.log"
    echo "Toolshed log file: packages/toolshed/local-dev-toolshed.log"
fi

if [[ "$KEEP_ALIVE" == "true" ]]; then
    echo ""
    echo "Codex detected; keeping this command attached so Codex does not clean up the dev servers."
    echo "Stop this command or run ./scripts/stop-local-dev.sh from another shell to stop them."
    wait "$SHELL_PID" "$TOOLSHED_PID"
    kill_tree "$CONSOLE_PID"
fi
