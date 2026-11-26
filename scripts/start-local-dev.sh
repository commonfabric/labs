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
# The console is opt-in and stays that way. An inherited loom variable is a
# fact about the process tree, not a request for a console, and a flag is the
# only thing loom needs to know about cf-harness.
CF_HARNESS=false
# Whether the console this script may start runs skill scripts in its sandbox.
# The operator's decision, and no part of starting a fabric implies it, so it
# is off unless named and passed through to the launcher, which prints it.
CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG=false
# Whether a task sent to that console may declare a browser host, a client
# that shows the agent's web pages to the owner. Also the operator's decision:
# named here, it is passed through to the console server, which also reads
# `CF_HARNESS_ALLOW_BROWSER_HOST`.
CF_HARNESS_ALLOW_BROWSER_HOST_FLAG=false
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
        --allow-browser-host)
            CF_HARNESS_ALLOW_BROWSER_HOST_FLAG=true
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

SHELL_LOG="$SCRIPT_DIR/../runtime/shell/local-dev-shell.log"
TOOLSHED_LOG="$SCRIPT_DIR/../runtime/toolshed/local-dev-toolshed.log"
CONSOLE_LOG="$SCRIPT_DIR/../runtime/cf-harness/local-dev-console.log"
SHELL_PID=""
TOOLSHED_PID=""
CONSOLE_PID=""
# The pids of the reader of the servers' logs and of the command the script is
# waiting for, and a directory for the pipe that reader writes to and for that
# command's output.
TAIL_PID=""
WAITED_PID=""
WORK_DIR=""

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

# Stops what the script is waiting for and every server it has not handed
# over, and removes its working directory.
cleanup() {
    stop_waiting
    kill_tree "$CONSOLE_PID"
    kill_tree "$TOOLSHED_PID"
    kill_tree "$SHELL_PID"
    rm -rf "$WORK_DIR"
}

fail_startup() {
    local message=$1

    echo "Error: $message" >&2
    show_recent_log "shell" "$SHELL_LOG"
    show_recent_log "toolshed" "$TOOLSHED_LOG"
    exit 1
}

# The line start_server appends to a server's log when the server exits, so
# that the log reports an exit the same way it reports a bind.
EXIT_LINE="start-local-dev.sh: server exited with status"

# Runs a command in the background with its output in a log, and appends
# EXIT_LINE and the command's exit status to the log when the command ends.
# $! is the pid of a process that waits for the command and exits with its
# status, so `wait` on it reports that status.
start_server() {
    local log_file=$1
    shift

    : > "$log_file"
    {
        "$@"
        exit_status=$?
        echo "$EXIT_LINE $exit_status"
        exit "$exit_status"
    } < /dev/null >> "$log_file" 2>&1 &
}

# Runs a command in the background, with its standard input from the file the
# first argument names and its output in $WORK_DIR/output, and waits for it.
# The `wait` builtin returns when a signal arrives, where a command run in the
# foreground holds the signal until it ends, so a signal ends the script
# promptly however long the command would take.
run_and_wait() {
    local input=$1
    shift

    "$@" < "$input" > "$WORK_DIR/output" &
    WAITED_PID=$!
    wait "$WAITED_PID"
    local exit_code=$?
    WAITED_PID=""
    return "$exit_code"
}

# Stops the log reader and the command the script is waiting for, without
# waiting for them: this also runs from the signal handlers, where bash 5 may
# already have collected their exit, and a `wait` there would block on the
# servers instead.
stop_waiting() {
    local pid
    for pid in "$WAITED_PID" "$TAIL_PID"; do
        [[ -z "$pid" ]] || kill "$pid" 2>/dev/null
    done
    WAITED_PID=""
    TAIL_PID=""
}

# Reads `tail -f` output of the logs in wait_for_binds's `logs`, and prints
# "bound" once each log has a line containing its entry in `markers`, or
# "exited N" once the log at index N has a line containing EXIT_LINE,
# whichever comes first. With more than one log, tail names the log the lines
# after each of its headers come from.
read_log_events() {
    local current=0
    local bound=()
    local bound_count=0
    local line
    local name
    local i

    while IFS= read -r line; do
        if [[ "$line" == "==> "*" <==" ]]; then
            name=${line#==> }
            name=${name% <==}
            for (( i = 0; i < ${#logs[@]}; i++ )); do
                [[ "${logs[i]}" != "$name" ]] || current=$i
            done
        elif [[ "$line" == *"$EXIT_LINE"* ]]; then
            echo "exited $current"
            return
        elif [[ -z "${bound[current]}" && "$line" == *"${markers[current]}"* ]]; then
            bound[current]=1
            if (( ++bound_count == ${#logs[@]} )); then
                echo "bound"
                return
            fi
        fi
    done
}

# Reads the logs of the servers the arguments name, four for each server (its
# name, the text of the line it prints once it has bound its port, its pid,
# and its log), as the servers write them, until every one has bound its port
# or one of them exits. Returns 0 once all have bound. When one exits first,
# returns 1 with its name, log, and exit status in EXITED_SERVER, EXITED_LOG,
# and SERVER_EXIT_STATUS. Returns 2 when the logs end, which happens only when
# something stops the reader of the logs. There is no time limit: a server that neither binds
# nor exits holds this wait until something stops the script. The bind is what
# the wait is for, rather than an HTTP answer, so that a server already on the
# port is never mistaken for this one.
wait_for_binds() {
    local names=()
    local markers=()
    local pids=()
    local logs=()
    while (( $# > 0 )); do
        names+=("$1")
        markers+=("$2")
        pids+=("$3")
        logs+=("$4")
        shift 4
    done

    mkfifo "$WORK_DIR/logs"
    tail -n +1 -f "${logs[@]}" > "$WORK_DIR/logs" &
    TAIL_PID=$!
    # Disowned so that bash does not report it as terminated when
    # stop_waiting stops it.
    disown "$TAIL_PID"
    run_and_wait "$WORK_DIR/logs" read_log_events
    stop_waiting
    rm -f "$WORK_DIR/logs"

    local outcome
    local index
    read -r outcome index < "$WORK_DIR/output"
    case "$outcome" in
        bound)
            return 0
            ;;
        exited)
            EXITED_SERVER=${names[index]}
            EXITED_LOG=${logs[index]}
            wait "${pids[index]}"
            SERVER_EXIT_STATUS=$?
            return 1
            ;;
    esac
    return 2
}

# Waits for the servers the arguments name, as wait_for_binds takes them, to
# bind their ports. A server that exits first fails the script, with
# PORT_IN_USE_EXIT when its port was already in use.
require_binds() {
    wait_for_binds "$@"
    case $? in
        0)
            return
            ;;
        2)
            fail_startup "the servers' logs ended before they bound their ports."
            ;;
    esac

    echo "Error: $EXITED_SERVER exited before it became ready" \
        "(exit $SERVER_EXIT_STATUS)." >&2
    show_recent_log "$EXITED_SERVER" "$EXITED_LOG"
    if [[ "$SERVER_EXIT_STATUS" -eq "$PORT_IN_USE_EXIT" ]]; then
        echo "($EXITED_SERVER could not bind its port; it is already in use.)" >&2
        exit "$PORT_IN_USE_EXIT"
    fi
    exit 1
}

# Sets HTTP_STATUS to the status a single GET of the URL answers with, or 000
# when the request fails. There is no time limit on the answer.
get_http_status() {
    run_and_wait /dev/null curl -s -o /dev/null -w "%{http_code}" "$1"
    HTTP_STATUS=$(< "$WORK_DIR/output")
}

require_http() {
    local name=$1
    local url=$2

    get_http_status "$url"
    if [[ "$HTTP_STATUS" != "200" ]]; then
        fail_startup "$name answered $url with HTTP $HTTP_STATUS, not 200."
    fi
    echo "  $name is ready."
}

# Until the servers are handed over, they end when this script does, whether
# it fails or a signal ends it.
trap cleanup EXIT
# Ctrl-C ends the script by SIGINT, so that whatever ran it knows it was
# interrupted. Bash ends that way on its own only when a command it waits for
# in the foreground ends by SIGINT, and this script waits in the background.
trap 'cleanup; trap - INT EXIT; kill -INT $$' INT
WORK_DIR=$(mktemp -d) || exit 1

# Each server runs in a process group of its own, so that it keeps running
# when whatever ran this script ends the script's process group after the
# script returns. Job control is what gives a background job its own group.
# It is on only while the servers are launched, since it also gives each
# foreground command a group of its own and hands it the terminal. A job
# started under job control keeps the script's standard input, so each server
# reads /dev/null instead. Under KEEP_ALIVE this script does not return, and
# the servers stay in its group, to end with it.
server_job_control() {
    [[ "$KEEP_ALIVE" == "true" ]] || set -m
}

# Start shell dev server in background
cd "$SCRIPT_DIR/../runtime/shell"
server_job_control
start_server "$SHELL_LOG" \
    env TOOLSHED_PORT="$TOOLSHED_PORT" deno task dev-local
SHELL_PID=$!

# Start toolshed dev server in background
# We pass --port= as CLI arg because deno --watch doesn't pass env vars to subprocess
cd "$SCRIPT_DIR/../runtime/toolshed"
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
# EXPOSE_GC lets a leak test read the server's memory after a full collection
# (/api/health/collected-memory).
start_server "$TOOLSHED_LOG" \
    env SHELL_URL="http://localhost:$SHELL_PORT" \
    EXPOSE_GC=true \
    API_URL="$TOOLSHED_API_URL" \
    MEMORY_URL="$TOOLSHED_MEMORY_URL" \
    deno run --unstable-otel -A --v8-flags=--max-old-space-size=16384 \
        $INSPECT_FLAG $WATCH_FLAG \
        --env-file=.env index.ts --port="$TOOLSHED_PORT"
TOOLSHED_PID=$!
set +m

echo "Waiting for the shell and toolshed to bind their ports..."
require_binds \
    "shell" "Dev server listening on" "$SHELL_PID" "$SHELL_LOG" \
    "toolshed" "Server running on" "$TOOLSHED_PID" "$TOOLSHED_LOG"
require_http "shell" "http://localhost:$SHELL_PORT"
require_http "toolshed" "http://localhost:$TOOLSHED_PORT/_health"

# The page a browser loads: the toolshed serving the shell it proxies. The two
# checks above cover each server on its own port, and this one covers the hop
# between them, which the toolshed makes with fetch() rather than with curl.
require_http "shell through toolshed" "http://localhost:$TOOLSHED_PORT/"

if [[ "$KEEP_ALIVE" != "true" ]]; then
    # The shell and toolshed are the caller's from here on, to stop with
    # stop-local-dev.sh, so that a console that does not come up, or a signal
    # that ends the wait for one, stops only the console.
    SHELL_PID=""
    TOOLSHED_PID=""
fi

# The cf-harness console, on the fabric the toolshed above is now serving.
#
# It never fails this script. The toolshed and the shell are the stack; the
# console is a surface on top of it, and a person whose sandbox runtime is not
# set up or whose model provider is not connected should still get a working
# fabric. So every way the console can fail to come up is reported here and
# written to its log, and none of them stops the servers that did come up.
#
# The console's sandbox runtime is not this script's to choose. It is the one
# `CF_HARNESS_SANDBOX_RUNTIME` names in this script's environment. With none
# named, the console of a loom instance (`LOOM_INSTANCE_ID` set, so
# `--instance` below) does not start, and says that loom must name one: loom
# chooses each instance's runtime, and a default could be another. Any other
# console takes its platform's: an Apple silicon Mac and Linux serve on their
# native runtime and refuse to start where that is not set up, any other Mac
# does not start, and every other platform has no default and does not start.
CONSOLE_STATUS=""

console_unavailable() {
    local reason=$1

    echo "" >&2
    echo "Error: cf-harness console did not start: $reason" >&2
    echo "  The shell and toolshed are unaffected and still running." >&2
    echo "  Console log: runtime/cf-harness/local-dev-console.log" >&2
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
    # The toolshed above runs in `runtime/toolshed`, so an unset `MEMORY_DIR`
    # leaves it on that directory's own `cache/memory`, which is the store the
    # console then has to read.
    CONSOLE_STORE=${MEMORY_DIR:-"$(cd "$SCRIPT_DIR/../runtime/toolshed" && pwd)/cache/memory"}
    export CONSOLE_PORT TOOLSHED_API_URL CONSOLE_STORE \
        CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG CF_HARNESS_ALLOW_BROWSER_HOST_FLAG
    CONSOLE_ARGS=()
    while IFS= read -r console_arg; do
        CONSOLE_ARGS+=("$console_arg")
    done < <(console_launch_args)

    launch_console() {
        cd "$SCRIPT_DIR/.."
        # The console resolves its own store from `--store` above; an inherited
        # `MEMORY_DIR` would be the toolshed's `file://` spelling of it.
        unset MEMORY_DIR
        deno task --cwd runtime/cf-harness console:launch "${CONSOLE_ARGS[@]}"
    }

    echo ""
    echo "Starting cf-harness console on port $CONSOLE_PORT..."
    [[ ! -f "$CONSOLE_LOG" ]] || mv -- "$CONSOLE_LOG" "$CONSOLE_LOG.previous"
    server_job_control
    start_server "$CONSOLE_LOG" launch_console
    CONSOLE_PID=$!
    set +m

    # The console's banner is written once it has bound its port, so a console
    # left over from an earlier launch, which writes to the log it was given,
    # cannot be taken for this one.
    echo "Waiting for the cf-harness console to bind its port..."
    wait_for_binds "cf-harness console" "cf-harness console: http://" \
        "$CONSOLE_PID" "$CONSOLE_LOG"
    case $? in
        0)
            get_http_status "http://127.0.0.1:$CONSOLE_PORT/api/health"
            if [[ "$HTTP_STATUS" == "200" ]]; then
                echo "  cf-harness console is ready."
            else
                console_unavailable \
                    "it answered /api/health with HTTP $HTTP_STATUS"
            fi
            ;;
        1)
            console_unavailable \
                "it exited before answering (exit $SERVER_EXIT_STATUS)"
            ;;
        *)
            console_unavailable "its log ended before it bound its port"
            ;;
    esac
    if [[ -n "$CONSOLE_STATUS" ]]; then
        show_recent_log "cf-harness console" "$CONSOLE_LOG"
    fi
fi

if [[ "$KEEP_ALIVE" != "true" ]]; then
    # The console is the caller's from here on too.
    CONSOLE_PID=""
fi

# Print the server URLs on success
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
echo "Shell log file: runtime/shell/local-dev-shell.log"
echo "Toolshed log file: runtime/toolshed/local-dev-toolshed.log"
if [[ "$CF_HARNESS" == "true" || -n "$CONSOLE_STATUS" ]]; then
    echo "Console log file: runtime/cf-harness/local-dev-console.log"
fi

if [[ "$KEEP_ALIVE" == "true" ]]; then
    echo ""
    echo "Codex detected; keeping this command attached so Codex does not clean up the dev servers."
    echo "Stop this command or run ./scripts/stop-local-dev.sh from another shell to stop them."
    wait "$SHELL_PID" "$TOOLSHED_PID"
fi
