#!/usr/bin/env bash
set -euo pipefail

export LOG_TO_STDERR=1
# Surface piece-list build/sync diagnostics in the daemon log; without this a
# "piece dir never appeared" timeout gives no signal about what the daemon saw.
export CF_FUSE_DEBUG=1

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

# The phases to run. A lane asks for one section; a bare run does all of
# them. The variable is this suite's own: CF_CLI_INTEGRATION_SECTION names
# integration.sh's sections, which are a different set, and neither script
# accepts the other's.
SECTION="${CF_FUSE_INTEGRATION_SECTION:-${1:-all}}"

# The script records as one test named "fuse-exec.sh", and each phase below
# records as its own test named "fuse-exec.sh <phase>". The script's record is
# written from the existing cleanup trap, which owns EXIT; registering a
# second trap would replace it. Neither name carries the dispatched section:
# which section scheduled a phase is run context, and the same phase joins
# across a lane's run of one section and a local `all` run. With recording
# off this initializes nothing, so the suite carries no dependency on the
# timing helper.
source "$SCRIPT_DIR/test-records.sh"
CF_TEST_RECORD_NAME="fuse-exec.sh"
CF_TEST_RECORD_START_MS=0
if [ -n "${CF_TEST_RECORDS_DIR:-}" ]; then
  CF_TEST_RECORD_START_MS=$(cf_test_now_ms)
fi

error() {
  # Drop errexit for the diagnostics: this path is about to exit non-zero anyway,
  # and one failing probe must not cut the dump short. Dump the daemon's own state
  # (log tail and, on Linux, its threads' kernel state) first, because it reads
  # only files off the mount and so survives a wedged mount, then the mount tree,
  # which can stall even with each touch bounded.
  set +e
  >&2 echo "ERROR: $1"
  dump_daemon_state
  dump_mount_state
  exit 1
}

# On failure, show what the mounted tree actually contains so "path never
# appeared" failures distinguish an empty piece list from a misnamed entry.
dump_mount_state() {
  if [ -z "${MOUNTPOINT:-}" ] || [ -z "${SPACE:-}" ]; then
    return 0
  fi
  local pieces_dir="$MOUNTPOINT/$SPACE/pieces"
  >&2 echo "--- mount state dump ---"
  if path_exists "$pieces_dir" 2; then
    >&2 bounded 5 ls -la "$pieces_dir" 2>&1 || true
    if path_exists "$pieces_dir/pieces.json" 2; then
      >&2 echo "--- pieces.json ---"
      >&2 bounded 5 cat "$pieces_dir/pieces.json" 2>&1 || true
    fi
  else
    >&2 echo "(pieces dir not reachable: $pieces_dir)"
  fi
  >&2 echo "--- end mount state dump ---"
}

# The direct child processes of the background mount's supervisor. MOUNT_PID is
# the supervisor; its one child is the worker that actually serves FUSE. pgrep is
# present on both CI (Linux) and local (macOS); the /proc fallback covers a Linux
# runner without pgrep.
worker_pids() {
  local supervisor="$1"
  local kids
  kids=$(pgrep -P "$supervisor" 2>/dev/null)
  if [ -z "$kids" ] && [ -r "/proc/$supervisor/task/$supervisor/children" ]; then
    kids=$(cat "/proc/$supervisor/task/$supervisor/children" 2>/dev/null)
  fi
  printf '%s\n' $kids
}

# Print each thread's scheduling state and kernel wait channel for a process,
# read from /proc (Linux only). These reads never block regardless of process
# state, unlike a stat() that crosses the wedged mount, so they are safe to run on
# the failure path.
dump_proc_state() {
  local pid="$1"
  local label="$2"
  if [ ! -d "/proc/$pid" ]; then
    >&2 echo "($label PID $pid: no /proc entry)"
    return 0
  fi
  local cmd
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)
  >&2 echo "--- $label PID $pid: ${cmd:-<unknown>} ---"
  local task tid stat_line state wchan
  for task in "/proc/$pid/task/"*; do
    [ -d "$task" ] || continue
    tid=$(basename "$task")
    # stat field 3 is the state letter; the comm field (2) may hold spaces and
    # parentheses, so read the state from after the final ') '.
    stat_line=$(cat "$task/stat" 2>/dev/null)
    state=${stat_line##*) }
    state=${state%% *}
    wchan=$(cat "$task/wchan" 2>/dev/null)
    >&2 echo "  thread $tid: state=${state:-?} wchan=${wchan:-?}"
  done
}

# Dump the FUSE daemon's own diagnostics without touching the mount: the tail of
# its log file (a regular file off the mount) and, on Linux, each daemon thread's
# kernel state. A wedged mount leaves the worker thread in uninterruptible sleep
# (state 'D') parked in a FUSE wait, so the state letter and 'wchan' per thread
# turn an opaque hang into a diagnosable one.
dump_daemon_state() {
  if [ -z "${MOUNT_PID:-}" ] && [ -z "${DAEMON_LOG:-}" ]; then
    return 0
  fi
  # Both the test-body failure path (error) and the exit-trap cleanup can reach a
  # wedge, but the daemon state only needs capturing once; whichever gets there
  # first dumps it, and by the second the daemon may already be killed.
  if [ -n "${DAEMON_STATE_DUMPED:-}" ]; then
    return 0
  fi
  DAEMON_STATE_DUMPED=1
  >&2 echo "--- daemon state dump ---"
  if [ -n "${DAEMON_LOG:-}" ] && [ -f "$DAEMON_LOG" ]; then
    >&2 echo "--- daemon log tail: $DAEMON_LOG ---"
    >&2 tail -n 100 "$DAEMON_LOG" 2>&1 || true
  else
    >&2 echo "(daemon log not available: ${DAEMON_LOG:-<unparsed>})"
  fi
  if [ -n "${MOUNT_PID:-}" ] && [ -d "/proc/$MOUNT_PID" ]; then
    dump_proc_state "$MOUNT_PID" "supervisor"
    local worker
    for worker in $(worker_pids "$MOUNT_PID"); do
      dump_proc_state "$worker" "worker"
    done
  fi
  >&2 echo "--- end daemon state dump ---"
}

# Each phase announces itself here before it runs, so each announcement is
# also the record of one test named for it, and a phase that fails is the
# record that carries the failure. Without them the whole script — a FUSE
# mount, a daemon, and everything done with them — is one identity that can
# only be scored, run, and skipped as a unit.
phase() {
  # The prefix is not '→': `cf` starts its own hint lines with that, so a run
  # of this suite holds three times as many of them as it has phases, and the
  # log stops being greppable for where a failing run got to.
  echo "▶ $1"
  cf_test_step_begin "$1"
}

if [ -n "${CF_CLI_INTEGRATION_USE_LOCAL:-}" ]; then
  cf() {
    deno task cli "$@"
  }
fi

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    error "$message"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "$haystack" == *"$needle"* ]]; then
    error "$message"
  fi
}

assert_not_exists() {
  local path="$1"
  local message="$2"
  local status

  # A stat on a FUSE path is a round-trip to the daemon, not a local lookup, so it
  # can hang when the daemon wedges. path_exists distinguishes three outcomes: the
  # path is present (0), it is genuinely absent (1), or the probe timed out with no
  # answer (anything else). Reading a timed-out probe as "absent" would let a
  # wedge — or the very path this forbids, hidden behind a hung stat — pass, so on
  # a non-answer retry until the deadline and then fail rather than pass.
  while true; do
    if path_exists "$path" 1; then
      status=0
    else
      status=$?
    fi
    if [ "$status" -eq 0 ]; then
      error "$message"
    elif [ "$status" -eq 1 ]; then
      return 0
    fi
    if wait_deadline_reached; then
      error "$message (could not confirm absence; a stat on the path never returned, so the FUSE daemon may be wedged)"
    fi
    sleep 0.1
  done
}

# Run a command with a hard time bound where 'timeout' is available (Linux CI),
# so a call that touches a wedged FUSE mount cannot block forever. SIGKILL,
# because a stat parked on an unresponsive FUSE daemon does not act on a catchable
# signal. macOS local dev has no 'timeout'; there the command runs unbounded,
# which is acceptable because the daemon hang this guards against is a CI (Linux)
# failure mode and not seen on local FUSE-T.
bounded() {
  local seconds="$1"
  shift

  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL "$seconds" "$@"
    return $?
  fi

  "$@"
}

path_exists() {
  local path="$1"
  local probe_timeout="${2:-3}"

  bounded "$probe_timeout" test -e "$path" >/dev/null 2>&1
}

assert_json_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"

  local actual_json expected_json
  actual_json=$(printf '%s\n' "$actual" | jq -S -c .)
  expected_json=$(printf '%s\n' "$expected" | jq -S -c .)

  if [ "$actual_json" != "$expected_json" ]; then
    error "$message. Expected: $expected_json, got: $actual_json"
  fi
}

# The waits below fire only when the daemon has wedged — a healthy operation
# settles in well under a second, so their deadline is not tuned to how long the
# work takes. WAIT_DEADLINE_EPOCH is set at startup to a few minutes before the CI
# step's outer 'timeout' would kill the script, so a wedge trips a wait — and
# error() prints the daemon's state — while there is still time to flush the log,
# rather than the step being cancelled mid-hang with the diagnostics truncated.
# Because the bound only ever cuts off a wedge, making it this large costs a
# healthy run nothing and widens the margin against a slow machine or a clock jump.
wait_deadline_reached() {
  [ "$(date +%s)" -ge "$WAIT_DEADLINE_EPOCH" ]
}

wait_for_path() {
  local path="$1"

  while true; do
    # Initial lazy hydration of FUSE paths may need a network round-trip.
    if path_exists "$path" 1; then
      return 0
    fi
    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  error "Timed out waiting for path: $path"
}

# A mounted JSON document answers lookups from a stub while the daemon hydrates
# the piece behind it, and rebuilds land on a debounce after that, so the path
# existing says nothing about the content being final. Poll the document until
# it renders what is expected, the same way the path probes poll for lookups.
wait_for_json() {
  local path="$1"
  local filter="$2"
  local message="$3"

  while true; do
    if jq -e "$filter" "$path" >/dev/null 2>&1; then
      return 0
    fi
    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  local actual
  actual=$(head -c 400 "$path" 2>/dev/null || true)
  error "$message. Last content of $(basename "$path"): $actual"
}

fuse_encode_component() {
  local value="$1"
  value="${value//%/%25}"
  value="${value//:/%3A}"
  value="${value//\//%2F}"
  if [[ "$value" == .* ]]; then
    value="%2E${value:1}"
  fi
  printf '%s\n' "$value"
}

resolve_entity_dir() {
  local entities_dir="$1"
  local entity_id="$2"
  local bare_id="${entity_id#of:}"
  local canonical_entity_dir="$entities_dir/of:$bare_id"
  local bare_entity_dir="$entities_dir/$bare_id"
  local encoded_entity_dir="$entities_dir/$(fuse_encode_component "$entity_id")"
  local encoded_canonical_entity_dir="$entities_dir/$(fuse_encode_component "of:$bare_id")"
  local encoded_bare_entity_dir="$entities_dir/$(fuse_encode_component "$bare_id")"

  while true; do
    if path_exists "$encoded_entity_dir" 1; then
      printf '%s\n' "$encoded_entity_dir"
      return 0
    fi

    if path_exists "$encoded_canonical_entity_dir" 1; then
      printf '%s\n' "$encoded_canonical_entity_dir"
      return 0
    fi

    if path_exists "$encoded_bare_entity_dir" 1; then
      printf '%s\n' "$encoded_bare_entity_dir"
      return 0
    fi

    if path_exists "$canonical_entity_dir" 1; then
      printf '%s\n' "$canonical_entity_dir"
      return 0
    fi

    if path_exists "$bare_entity_dir" 1; then
      printf '%s\n' "$bare_entity_dir"
      return 0
    fi

    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  return 1
}

wait_for_piece_value() {
  local path="$1"
  local expected="$2"
  local actual

  while true; do
    actual=$(cf cell get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  error "Timed out waiting for piece path '$path'. Expected: $expected, got: $actual"
}

piece_pattern_identity() {
  cf piece inspect --json $SPACE_ARGS --piece "$PIECE_ID" 2>/dev/null |
    jq -r '.patternRef.identity // empty'
}

wait_for_pattern_identity_change() {
  local previous_identity="$1"
  local actual

  while true; do
    actual=$(piece_pattern_identity || true)
    if [ -n "$actual" ] && [ "$actual" != "$previous_identity" ]; then
      printf '%s\n' "$actual"
      return 0
    fi
    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  error "Timed out waiting for the FUSE source update to change pattern identity."
}

# The daemon writes its `[write-trace]` lines to the log named in the mount
# output. The lines are emitted from the FUSE callbacks themselves, in the
# order the single-threaded session loop runs them, so the log records what the
# daemon decided rather than what the decision eventually did to a cell.
trace_line_count() {
  if [ ! -f "$DAEMON_LOG" ]; then
    printf '0\n'
    return 0
  fi
  wc -l <"$DAEMON_LOG" | tr -d ' '
}

trace_since() {
  local mark="$1"
  tail -n "+$((mark + 1))" "$DAEMON_LOG" 2>/dev/null || true
}

trace_contains() {
  local mark="$1"
  local needle="$2"
  local trace
  trace=$(trace_since "$mark")

  [[ "$trace" == *"$needle"* ]]
}

# Match a whole trace line, so `fh=3` cannot satisfy a search for `fh=33`.
trace_contains_line() {
  local mark="$1"
  local line="$2"
  local trace
  trace=$(trace_since "$mark")

  [[ $'\n'"$trace"$'\n' == *$'\n'"$line"$'\n'* ]]
}

wait_for_trace_line() {
  local mark="$1"
  local needle="$2"

  while true; do
    if trace_contains "$mark" "$needle"; then
      return 0
    fi
    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  error "Timed out waiting for daemon trace line: $needle"
}

assert_trace_line_absent() {
  local mark="$1"
  local line="$2"
  local message="$3"

  if trace_contains_line "$mark" "$line"; then
    error "$message"
  fi
}

# Print the daemon's release trace line for a handle. `releaseCb` traces the
# handle's dirty/flushing/pending state as it found it, before making its own
# flush decision, so the line states what close() saw regardless of which
# callback ends up doing the flushing.
trace_release_line() {
  local mark="$1"
  local fh="$2"

  trace_since "$mark" |
    sed -n "s/^\(\[write-trace\] release fh=$fh .*\)$/\1/p" |
    tail -n 1
}

# Report the handle number the daemon assigned to the descriptor that wrote
# `size` bytes at offset 0 since `mark`. The write callback traces its line
# before replying, so the line is in the log once the write() has returned.
resolve_traced_write_fh() {
  local mark="$1"
  local size="$2"
  local fh

  while true; do
    fh=$(trace_since "$mark" |
      sed -n "s/^\[write-trace\] write fh=\([0-9][0-9]*\) size=$size offset=0$/\1/p" |
      tail -n 1)
    if [ -n "$fh" ]; then
      printf '%s\n' "$fh"
      return 0
    fi
    if wait_deadline_reached; then
      break
    fi
    sleep 0.1
  done

  return 1
}

read_piece_value_or_default() {
  local path="$1"
  local fallback="$2"
  local actual

  actual=$(cf cell get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
  if [ -z "$actual" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  if [[ ! "$actual" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  printf '%s\n' "$actual"
}

# True when the kernel's mount table still lists the mountpoint. Reading the mount
# table does not cross the mount, so this never blocks and needs no time bound —
# unlike a 'cd' or 'stat' into the mount root, which a wedged daemon would hang. It
# compares against the physical path resolved before the mount (MOUNTPOINT_REAL),
# which is how the mount appears in 'mount' output. With no resolvable path it
# reports active, so cleanup never 'rm -rf's a mount it could not rule out.
mount_is_active() {
  local path="${MOUNTPOINT_REAL:-$1}"
  [ -n "$path" ] || return 0
  mount | grep -Fq " on $path "
}

# True when the PID's command still looks like the FUSE daemon. Guards the
# SIGKILLs below against a reused PID, mirroring isFuseProcessCommand in
# packages/cli/commands/fuse.ts, which matches the supervisor and worker in both
# the 'deno run' and compiled-binary forms and nothing merely containing 'fuse'.
is_fuse_process() {
  ps -o command= -p "$1" 2>/dev/null |
    grep -qE 'packages/fuse/mod\.ts|fuse-supervisor|fuse-daemon'
}

# Kill the background FUSE daemon so a wedged mount stops blocking. MOUNT_PID is
# the supervisor; the process that actually serves FUSE and holds the /dev/fuse
# handle is its worker child, so kill the worker first — on Linux that makes the
# kernel abort the connection so calls on the mount fail instead of blocking — then
# the supervisor. SIGKILL, because a wedged worker does not act on SIGTERM.
kill_fuse_daemon() {
  if [ -z "${MOUNT_PID:-}" ]; then
    return 0
  fi
  local pid
  for pid in $(worker_pids "$MOUNT_PID") "$MOUNT_PID"; do
    if is_fuse_process "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

# Detach a mount whose daemon has been killed. 'cf fuse unmount' skips the system
# unmount once it sees no live daemon, so the severed mount would otherwise stay
# listed; remove it directly, on the physical path the unmount tools match against
# (MOUNTPOINT_REAL). Bounded because it runs on the failure path.
force_detach() {
  local path="${MOUNTPOINT_REAL:-$1}"
  if [ "$(uname)" = "Darwin" ]; then
    bounded 15 umount -f "$path"
  elif command -v fusermount3 >/dev/null 2>&1; then
    bounded 15 fusermount3 -u -z "$path"
  else
    bounded 15 umount -l "$path"
  fi
}

# Unmount, bounded by the shared outer deadline (WAIT_DEADLINE_EPOCH) rather than a
# fixed duration, so a slow-but-succeeding unmount is never cut short — the bound is
# whatever is left of the run's overall bound, minutes more than an unmount ever
# needs. Only a genuinely hung teardown reaches it. bounded's 'timeout' cannot
# exec a shell function, and local dev's 'cf' is one, so only an external 'cf'
# (the bin/cf a lane puts on PATH) is bounded; a 'cf' function runs unbounded,
# the same as the no-'timeout' local path.
unmount_until_deadline() {
  local remaining
  remaining=$((WAIT_DEADLINE_EPOCH - $(date +%s)))
  [ "$remaining" -ge 1 ] || remaining=1
  if [ "$(type -t cf)" = "file" ]; then
    bounded "$remaining" cf fuse unmount "$1" >/dev/null 2>&1
  else
    cf fuse unmount "$1" >/dev/null 2>&1
  fi
}

cleanup() {
  # Capture the pending exit status before 'set +e' overwrites it: it tells us
  # whether the test has already failed.
  local exit_code=$?
  set +e
  # Close the step that was running with the body's own status, before the
  # teardown below adds its time to the clock. A wedged teardown lands on
  # the script's record further down.
  cf_test_step_close "$exit_code"
  local can_remove_mountpoint=true
  local wedge_confirmed=false
  # Gate on MOUNTPOINT being set, not on '[ -d "$MOUNTPOINT" ]': that is a getattr
  # on the mount root, which blocks on a wedged daemon. mktemp -d created the
  # directory, so a set MOUNTPOINT is always a real directory to tear down.
  if [ -n "${MOUNTPOINT:-}" ]; then
    if [ "$exit_code" -ne 0 ]; then
      # The test has already failed, for whatever reason, and error() has already
      # dumped the daemon state if the failure was a wedge. We no longer care about
      # a graceful unmount — hard-terminate the daemon so nothing it holds can block
      # the process from exiting and reporting the failure to CI, then detach the
      # severed mount. SIGKILL is non-blocking, so this needs no timeout.
      kill_fuse_daemon
      force_detach "$MOUNTPOINT" >/dev/null 2>&1
    else
      # The test passed, so tear the mount down gracefully — this is the only path
      # that exercises the real 'cf fuse unmount', and it avoids leaving a stale
      # FUSE-T mount on macOS. Bound it only by the shared outer deadline, so a
      # slow-but-succeeding unmount is never cut short; the bound is minutes, far
      # longer than an unmount takes. If it cannot finish by then, the teardown
      # itself has wedged — a real failure a passing run must not hide. Capture the
      # daemon state, hard-kill it, detach, and fail the run.
      unmount_until_deadline "$MOUNTPOINT"
      if mount_is_active "$MOUNTPOINT"; then
        >&2 echo "WARN: $MOUNTPOINT still mounted after unmount; the FUSE teardown wedged"
        dump_daemon_state
        kill_fuse_daemon
        force_detach "$MOUNTPOINT" >/dev/null 2>&1
        wedge_confirmed=true
      fi
    fi
    if mount_is_active "$MOUNTPOINT"; then
      >&2 echo "WARN: leaving mounted filesystem at $MOUNTPOINT because it could not be detached"
      can_remove_mountpoint=false
    fi
  fi
  if [ "$can_remove_mountpoint" = true ] && [ -n "${MOUNTPOINT:-}" ]; then
    rm -rf "$MOUNTPOINT"
  fi
  if [ -n "${IDENTITY:-}" ]; then
    rm -f "$IDENTITY"
  fi
  if [ -n "${MEMORY_PROXY_PID:-}" ]; then
    kill "$MEMORY_PROXY_PID" 2>/dev/null || true
    wait "$MEMORY_PROXY_PID" 2>/dev/null || true
  fi
  if [ -n "${MEMORY_TRACE:-}" ]; then
    rm -f "$MEMORY_TRACE"
  fi
  if [ -n "${MEMORY_PROXY_READY:-}" ]; then
    rm -f "$MEMORY_PROXY_READY"
  fi
  if [ -n "${MEMORY_PROXY_STATE:-}" ]; then
    rmdir "$MEMORY_PROXY_STATE" 2>/dev/null || true
  fi
  if [ -n "${INCOMPATIBLE_PATTERN_SRC:-}" ]; then
    rm -f "$INCOMPATIBLE_PATTERN_SRC"
  fi
  # The record carries the run's final verdict, wedged teardown included.
  if [ "$wedge_confirmed" = true ]; then
    cf_test_record_with_status 1
  else
    cf_test_record_with_status "$exit_code"
  fi
  # If the graceful unmount could not complete before the deadline, the teardown
  # wedged after the test otherwise passed. Fail the run so that hang is reported
  # rather than masked by a green build. This runs after the temp files are
  # cleaned; an exit from the EXIT trap keeps this status.
  if [ "$wedge_confirmed" = true ]; then
    >&2 echo "ERROR: FUSE teardown wedged after the test passed; failing the run so the hang is not masked."
    exit 1
  fi
}

trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1; then
  error "jq must be installed."
fi

if [ -z "${API_URL:-}" ]; then
  error "API_URL must be defined."
fi

# What every phase runs against: an identity, a stepped piece, the memory
# proxy that records what the daemon transfers, and a background FUSE mount
# over a fresh space.
# Brings the mount up, and everything the mount is of: an identity, a space
# holding one stepped piece, and the memory proxy the entity listing reads. It
# records like any other phase, so a mount that never comes up is reported as
# the mount rather than as the script.
run_mount() {
  phase "A background FUSE daemon mounts a space holding one stepped piece"
  SPACE=$(mktemp -u XXXXXXXXXX)
  IDENTITY=$(mktemp)
  MOUNTPOINT=$(mktemp -d)
  # Resolve the mountpoint's physical path now, while it is still an empty plain
  # directory. After 'cf fuse mount' it is the mount root, and resolving it then
  # would 'cd' across the mount and block on a wedged daemon. The resolved path does
  # not move when the mount appears over it, and it is what 'mount' output and the
  # unmount tools use, so cleanup can test and detach against it without ever
  # touching the mount.
  MOUNTPOINT_REAL=$(cd -P -- "$MOUNTPOINT" 2>/dev/null && pwd)
  SPACE_ARGS="--api-url=$API_URL --identity=$IDENTITY --space=$SPACE"
  PATTERN_SRC="$SCRIPT_DIR/pattern/fuse-exec.tsx"
  CUSTOM_EXPORT="customPatternExport"
  ENTITY_DEEP_PROBE="${FUSE_DEEP_ENTITY_PROBE:-0}"

  # The deadline for every wait that fails the test (see wait_deadline_reached).
  # The overall bound is the time the whole run is allowed:
  # FUSE_EXEC_OVERALL_TIMEOUT_SECONDS where the caller sets it, and 480 seconds
  # otherwise. The waits give up a few minutes before it, so error() can print
  # the daemon's state before anything outside the script stops the run. The
  # floor guards a misconfigured tiny outer bound from making every wait fire
  # at once.
  OVERALL_TIMEOUT_SECONDS="${FUSE_EXEC_OVERALL_TIMEOUT_SECONDS:-480}"
  WAIT_BUDGET_SECONDS=$((OVERALL_TIMEOUT_SECONDS - 300))
  [ "$WAIT_BUDGET_SECONDS" -ge 30 ] || WAIT_BUDGET_SECONDS=$((OVERALL_TIMEOUT_SECONDS / 2 + 1))
  WAIT_DEADLINE_EPOCH=$(($(date +%s) + WAIT_BUDGET_SECONDS))

  echo "API_URL=$API_URL"
  echo "SPACE=$SPACE"
  echo "IDENTITY=$IDENTITY"
  echo "MOUNTPOINT=$MOUNTPOINT"

  cf id new >"$IDENTITY"

  PIECE_ID=$(cf piece new --main-export "$CUSTOM_EXPORT" $SPACE_ARGS "$PATTERN_SRC")
  echo "Created piece: $PIECE_ID"
  cf piece step $SPACE_ARGS --piece "$PIECE_ID"
  echo "Stepped piece: $PIECE_ID"
  ENTITY_PAYLOAD_MARKER="FUSE_ENTITY_LIST_PAYLOAD_50c21a1f"
  printf '{"lastMessage":"%s","messageCount":0,"legacyCount":0,"messages":[]}\n' \
    "$ENTITY_PAYLOAD_MARKER" |
    cf cell set $SPACE_ARGS --piece "$PIECE_ID" "" --input

  MEMORY_PROXY_STATE=$(mktemp -d)
  MEMORY_TRACE="$MEMORY_PROXY_STATE/frames"
  MEMORY_PROXY_READY="$MEMORY_PROXY_STATE/ready"
  mkfifo "$MEMORY_PROXY_READY"
  deno run --allow-net --allow-write="$MEMORY_TRACE" \
    "$SCRIPT_DIR/fuse-memory-proxy.ts" "$API_URL" "$MEMORY_TRACE" \
    >"$MEMORY_PROXY_READY" &
  MEMORY_PROXY_PID=$!
  if ! IFS= read -r FUSE_API_URL <"$MEMORY_PROXY_READY"; then
    error "FUSE memory proxy exited before reporting its listening address."
  fi
  rm -f "$MEMORY_PROXY_READY"
  MEMORY_PROXY_READY=""

  # --cfc-mode names the FUSE guardrail mode this suite's write-through phases
  # need rather than taking whatever the runner default resolves to. One of
  # those phases writes a handler file, and an enforcing mount refuses a
  # handler write with EACCES at `open`. That write is a shell redirect, so
  # under this script's `set -e` the run ends at that line with the shell's own
  # "Permission denied" and the path it was writing to, which names no mode.
  #
  # A mount that names no mode runs at DEFAULT_FUSE_CFC_MODE
  # (packages/fuse/cfc-writeback.ts), which is `enforce-strict`, so the flag
  # lowers this mount rather than restating where it would have landed. That
  # rung belongs to the mount; the floor an unconfigured transaction carries
  # is DEFAULT_CFC_ENFORCEMENT_MODE in packages/runner/src/cfc/types.ts, which
  # stays `disabled`.
  MOUNT_OUTPUT=$(cf fuse mount "$MOUNTPOINT" --api-url="$FUSE_API_URL" --identity="$IDENTITY" --space="$SPACE" --cfc-mode=disabled --background --dangerously-allow-incompatible-schema)
  echo "$MOUNT_OUTPUT"

  MOUNT_PID="${MOUNT_OUTPUT#*PID }"
  if [ "$MOUNT_PID" = "$MOUNT_OUTPUT" ]; then
    error "Could not parse fuse daemon PID from mount output."
  fi

  MOUNT_PID="${MOUNT_PID%%)*}"
  case "$MOUNT_PID" in
    ''|*[!0-9]*)
      error "Could not parse fuse daemon PID from mount output."
      ;;
  esac

  # The background mount prints a 'log:' line pointing at the daemon's log file (see
  # packages/cli/commands/fuse.ts). That file lives off the mount, so it stays
  # readable even when the mount itself is wedged, and the trace assertions and the
  # failure-path daemon dump both read it. It is required, so a parse miss is fatal.
  DAEMON_LOG=$(printf '%s\n' "$MOUNT_OUTPUT" | sed -n 's/^[[:space:]]*log:[[:space:]]*//p')
  if [ -z "$DAEMON_LOG" ]; then
    error "Could not parse fuse daemon log path from mount output."
  fi

  # 'cf fuse mount --background' returns only after the daemon has reported the
  # 'mounted' supervisor state and been confirmed alive. The daemon reports that
  # just before it enters its FUSE session loop, and mounted paths hydrate lazily,
  # so the wait_for_path calls below cover the rest.
  if ! kill -0 "$MOUNT_PID" >/dev/null 2>&1; then
    error "Fuse daemon exited immediately after reporting mount readiness."
  fi

  # The layout of the mounted tree, named once so every phase addresses the
  # same paths whichever section reached it.
  ENTITIES_DIR="$MOUNTPOINT/$SPACE/entities"
  STATUS_FILE="$MOUNTPOINT/.status"
  PIECE_NAME="Fuse-Exec-Fixture"
  PIECE_DIR="$MOUNTPOINT/$SPACE/pieces/$PIECE_NAME"
  INPUT_DIR="$PIECE_DIR/input"
  INPUT_LAST_MESSAGE="$INPUT_DIR/lastMessage"
  RESULT_DIR="$PIECE_DIR/result"
  RESULT_JSON="$PIECE_DIR/result.json"
  META_JSON="$PIECE_DIR/meta.json"
  HANDLER_FILE="$RESULT_DIR/recordMessage.handler"
  LEGACY_HANDLER_FILE="$RESULT_DIR/legacyWrite.handler"
  TOOL_FILE="$RESULT_DIR/search.tool"

  wait_for_path "$ENTITIES_DIR"

  # `.status` carries the mode the daemon resolved, fixed before it mounted, so
  # one read settles it. It is what names the mode at the mount when the flag
  # above stops reaching the daemon, rather than several phases later as a
  # permission error on a path.
  path_exists "$STATUS_FILE" || error ".status was not mounted at the mount root."
  STATUS_CFC_MODE=$(jq -r '.cfc.mode' "$STATUS_FILE")
  if [ "$STATUS_CFC_MODE" != "disabled" ]; then
    error ".status reports CFC mode $STATUS_CFC_MODE; the mount was given disabled."
  fi
}

# Runs before any phase reads a piece: the assertion is that nothing but
# identifiers has crossed the memory proxy, and reading a piece transfers
# its payload. Every section runs it, ahead of the phases it selected.
run_entity_listing() {
  phase "Listing every mounted entity directory transfers identifiers without entity payload bytes"
  MOUNTED_ENTITY_DIRS=$(find "$ENTITIES_DIR" -mindepth 1 -maxdepth 1 -type d -print)
  if [ -z "$MOUNTED_ENTITY_DIRS" ]; then
    error "Mounted entities directory did not contain any entity directories."
  fi
  if ! grep -Fq "$PIECE_ID" "$MEMORY_TRACE"; then
    error "Listing mounted entity directories did not transfer the known entity identifier."
  fi
  if grep -Fq "$ENTITY_PAYLOAD_MARKER" "$MEMORY_TRACE"; then
    error "Listing mounted entity directories transferred entity payload bytes."
  fi
}

# The lazily hydrated part of the mounted tree, which every phase below the
# entity listing addresses. It records for the same reason the mount does.
run_piece_paths() {
  phase "The mounted piece's directory and documents hydrate"
  wait_for_path "$MOUNTPOINT/$SPACE/pieces"
  wait_for_path "$PIECE_DIR"
  wait_for_path "$RESULT_DIR"
  wait_for_path "$RESULT_JSON"
  wait_for_path "$META_JSON"

  ENTITY_ID=$(jq -r '.entityId' "$META_JSON")
  if [ -z "$ENTITY_ID" ] || [ "$ENTITY_ID" = "null" ]; then
    error "Mounted meta.json did not include an entityId."
  fi
}

run_entities_entry() {
  phase "Entities namespace exposes matching entry for mounted piece"
  ENTITY_DIR=$(resolve_entity_dir "$ENTITIES_DIR" "$ENTITY_ID" || true)
  if [ -z "$ENTITY_DIR" ]; then
    error "Timed out waiting for entity directory entry for $ENTITY_ID."
  fi
}

run_status_document() {
  phase ".status reads as a whole JSON document"
  # A single read is enough to prove the generated file is served as one coherent
  # document through a real getattr and read. That the counters it carries are
  # fresh and advance is settled deterministically by the CellBridge.status unit
  # tests; asserting it here would mean polling out the macOS NFS attribute cache,
  # and this suite adds no waits it can avoid.
  path_exists "$STATUS_FILE" || error ".status was not mounted at the mount root."
  cat "$STATUS_FILE" | jq -e . >/dev/null ||
    error ".status did not read back as a whole JSON document."
}

# The waits here are what puts the callable files in place for the phases
# that run them, so every section using one runs this phase first.
run_callable_entries() {
  phase "Mounted callable entries exist"
  wait_for_path "$HANDLER_FILE"
  wait_for_path "$LEGACY_HANDLER_FILE"
  wait_for_path "$TOOL_FILE"

  path_exists "$HANDLER_FILE" || error "recordMessage.handler was not mounted."
  path_exists "$LEGACY_HANDLER_FILE" || error "legacyWrite.handler was not mounted."
  path_exists "$TOOL_FILE" || error "search.tool was not mounted."
}

run_callable_json_surface() {
  phase "Mounted JSON surface hides callable internals"
  assert_not_exists "$RESULT_DIR/search" "Pattern tool internals should not be exposed as a directory."
  wait_for_json "$RESULT_JSON" '.recordMessage == {"/handler":"recordMessage"}' \
    "result.json should render recordMessage as a handler sigil"
  wait_for_json "$RESULT_JSON" '.legacyWrite == {"/handler":"legacyWrite"}' \
    "result.json should render legacyWrite as a handler sigil"
  wait_for_json "$RESULT_JSON" '.search == {"/tool":"search"}' \
    "result.json should render search as a tool sigil"
}

run_callable_shebangs() {
  phase "Callable files are executable and expose cf exec shebangs"
  HANDLER_FIRST_LINE=$(head -n 1 "$HANDLER_FILE")
  TOOL_FIRST_LINE=$(head -n 1 "$TOOL_FILE")
  test -x "$HANDLER_FILE" || error "Handler file should be executable."
  test -x "$TOOL_FILE" || error "Tool file should be executable."
  assert_contains "$HANDLER_FIRST_LINE" "#!" "Handler file should start with a shebang."
  assert_contains "$HANDLER_FIRST_LINE" " exec" "Handler shebang should invoke cf exec."
  assert_contains "$TOOL_FIRST_LINE" "#!" "Tool file should start with a shebang."
  assert_contains "$TOOL_FIRST_LINE" " exec" "Tool shebang should invoke cf exec."
}

run_callable_help() {
  phase "Top-level and direct --help print agent-oriented callable help without invoking callables"
  COUNT_BEFORE_HELP=$(read_piece_value_or_default "messageCount" "0")
  HANDLER_HELP=$(cf exec "$HANDLER_FILE" --help)
  TOOL_HELP=$(cf exec "$TOOL_FILE" --help)
  TOOL_HELP_JSON=$(cf exec "$TOOL_FILE" --help --json)
  DIRECT_HANDLER_HELP=$("$HANDLER_FILE" --help)
  assert_contains "$HANDLER_HELP" "cf exec" "cf exec help should describe the cf exec call form."
  assert_contains "$HANDLER_HELP" "[invoke] --message <string>" "Handler help should show the optional invoke verb."
  assert_contains "$HANDLER_HELP" "--message <string>" "Handler help should expand schema-derived flags."
  assert_contains "$HANDLER_HELP" "Required." "Handler help should mark required flags."
  # A handler's help says nothing about output rather than asserting there is
  # none: a verb declared `Stream<E, R>` does return a result, and this page
  # cannot see the declaration.
  assert_not_contains "$HANDLER_HELP" "Output:" "Handler help should carry no Output section."
  assert_contains "$HANDLER_HELP" "Alternatively, write JSON to this file to invoke the handler." "Handler help should mention write-through invocation."
  assert_contains "$TOOL_HELP" "[run] --query <string>" "Tool help should show the optional run verb."
  assert_contains "$TOOL_HELP" "--query <string>" "Tool help should expand schema-derived flags."
  assert_contains "$TOOL_HELP" "JSON on success:" "Tool help should show JSON output."
  assert_contains "$TOOL_HELP" "--help --json" "Tool help should mention machine-readable schema help."
  assert_contains "$DIRECT_HANDLER_HELP" "[invoke] --message <string>" "Direct help should show the optional invoke verb."
  assert_contains "$DIRECT_HANDLER_HELP" "$HANDLER_FILE" "Direct help should mention the mounted file path."
  assert_contains "$DIRECT_HANDLER_HELP" "--message <string>" "Direct help should show the mounted file call form."
  if [[ "$DIRECT_HANDLER_HELP" == *"cf exec $HANDLER_FILE"* ]]; then
    error "Direct help should hide the cf exec call form."
  fi
  printf '%s\n' "$TOOL_HELP_JSON" | jq -e '.inputSchema.required == ["query"]' >/dev/null ||
    error "Machine-readable help should include the input schema."
  printf '%s\n' "$TOOL_HELP_JSON" | jq -e '.outputSchema.properties.summary.type == "string"' >/dev/null ||
    error "Machine-readable help should include the output schema."
  COUNT_AFTER_HELP=$(read_piece_value_or_default "messageCount" "0")
  if [ "$COUNT_AFTER_HELP" != "$COUNT_BEFORE_HELP" ]; then
    error "Top-level cf exec --help should not mutate messageCount. Expected: $COUNT_BEFORE_HELP, got: $COUNT_AFTER_HELP"
  fi
}

# This phase and the three handler phases after it read messageCount as an
# absolute count, from the zero the piece starts at, so the four run together
# and in this order. The tool phases between them leave the count alone.
run_handler_direct_exec() {
  phase "Mounted callables can be executed directly through their shebangs"
  "$HANDLER_FILE" --message "piece-direct"
  wait_for_piece_value "lastMessage" '"piece-direct"'
  wait_for_piece_value "messageCount" "1"
  DIRECT_TOOL=$("$TOOL_FILE" --query "direct" --help "via-shebang")
  assert_json_eq \
    "$DIRECT_TOOL" \
    '{"help":"via-shebang","query":"direct","source":"bound-source","summary":"bound-source:direct:via-shebang"}' \
    "Direct tool execution returned unexpected JSON"
}

run_handler_stdin() {
  phase "cf exec reads handler JSON input from stdin"
  printf '{"message":"stdin-handler"}' | cf exec "$HANDLER_FILE" --json
  wait_for_piece_value "lastMessage" '"stdin-handler"'
  wait_for_piece_value "messageCount" "2"
}

run_tool_stdin() {
  phase "Mounted tools read JSON input from stdin"
  DIRECT_TOOL_STDIN=$(printf '{"query":"stdin-tool","help":"stdin-help"}' | "$TOOL_FILE" --json)
  assert_json_eq \
    "$DIRECT_TOOL_STDIN" \
    '{"help":"stdin-help","query":"stdin-tool","source":"bound-source","summary":"bound-source:stdin-tool:stdin-help"}' \
    "Direct tool execution with stdin JSON returned unexpected JSON"
}

run_handler_flags() {
  phase "cf exec invokes mounted handlers with schema-derived flags"
  cf exec "$HANDLER_FILE" --message "piece-explicit"
  wait_for_piece_value "lastMessage" '"piece-explicit"'
  wait_for_piece_value "messageCount" "3"
}

run_handler_implicit_verb() {
  phase "cf exec invokes mounted handlers without an explicit verb"
  cf exec "$HANDLER_FILE" --message "piece-implicit"
  wait_for_piece_value "lastMessage" '"piece-implicit"'
  wait_for_piece_value "messageCount" "4"
}

run_tool_flags() {
  phase "cf exec runs mounted tools with schema-derived flags"
  TOOL_EXPLICIT=$(cf exec "$TOOL_FILE" --query "explicit" --help "schema-field")
  assert_json_eq \
    "$TOOL_EXPLICIT" \
    '{"help":"schema-field","query":"explicit","source":"bound-source","summary":"bound-source:explicit:schema-field"}' \
    "Explicit tool execution returned unexpected JSON"
}

run_tool_help_field() {
  phase "Top-level --help with a value is parsed as the schema field when present"
  HELP_FIELD_OUTPUT=$(cf exec "$TOOL_FILE" --help "literal-help" --query "help-field")
  assert_json_eq \
    "$HELP_FIELD_OUTPUT" \
    '{"help":"literal-help","query":"help-field","source":"bound-source","summary":"bound-source:help-field:literal-help"}' \
    "Top-level --help with a value should be parsed as the tool schema field"
}

run_tool_implicit_verb() {
  phase "cf exec runs mounted tools without an explicit verb"
  TOOL_IMPLICIT=$(cf exec "$TOOL_FILE" --query "implicit" --help "")
  assert_json_eq \
    "$TOOL_IMPLICIT" \
    '{"help":"","query":"implicit","source":"bound-source","summary":"bound-source:implicit:"}' \
    "Implicit tool execution returned unexpected JSON"
}

run_empty_object_handler() {
  phase "Empty-object handlers run without an explicit verb, and invoke still works"
  LEGACY_COUNT_BEFORE_EXEC=$(read_piece_value_or_default "legacyCount" "0")
  cf exec "$LEGACY_HANDLER_FILE"
  wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE_EXEC + 1))"
  cf exec "$LEGACY_HANDLER_FILE" invoke
  wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE_EXEC + 2))"
}

# The deep probe compares the two namespaces and is off by default. The
# pieces-side invocation is the baseline the entities-side one is compared
# against and runs whichever way FUSE_DEEP_ENTITY_PROBE is set; which phase
# owns it is what the probe decides.
run_shared_backing_cell() {
  if [ "$ENTITY_DEEP_PROBE" = "1" ]; then
    phase "Handler execution through pieces/ and entities/ reaches the same backing cell"
  else
    phase "Deep entities callable probe skipped"
  fi
  COUNT_BEFORE_PIECES_SHARED=$(read_piece_value_or_default "messageCount" "0")
  cf exec "$HANDLER_FILE" --message "shared-message"
  wait_for_piece_value "lastMessage" '"shared-message"'
  wait_for_piece_value "messageCount" "$((COUNT_BEFORE_PIECES_SHARED + 1))"

  if [ "$ENTITY_DEEP_PROBE" != "1" ]; then
    return 0
  fi

  ENTITY_RESULT_DIR="$ENTITY_DIR/result"
  ENTITY_HANDLER_FILE="$ENTITY_RESULT_DIR/recordMessage.handler"
  ENTITY_TOOL_FILE="$ENTITY_RESULT_DIR/search.tool"

  wait_for_path "$ENTITY_HANDLER_FILE"
  wait_for_path "$ENTITY_TOOL_FILE"

  COUNT_BEFORE_ENTITIES_SHARED=$(read_piece_value_or_default "messageCount" "0")
  cf exec "$ENTITY_HANDLER_FILE" --message "shared-message"
  wait_for_piece_value "lastMessage" '"shared-message"'
  wait_for_piece_value "messageCount" "$((COUNT_BEFORE_ENTITIES_SHARED + 1))"

  phase "Tool execution through pieces/ and entities/ is identical"
  PIECES_TOOL_SHARED=$(cf exec "$TOOL_FILE" --query "shared-tool" --help "entity-compare")
  ENTITIES_TOOL_SHARED=$(cf exec "$ENTITY_TOOL_FILE" --query "shared-tool" --help "entity-compare")
  assert_json_eq \
    "$PIECES_TOOL_SHARED" \
    "$ENTITIES_TOOL_SHARED" \
    "Tool output should match between pieces/ and entities/ paths"
}

run_legacy_write_through() {
  phase "Legacy handler write-through still works"
  LEGACY_COUNT_BEFORE=$(read_piece_value_or_default "legacyCount" "0")
  echo '{}' > "$LEGACY_HANDLER_FILE"
  wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE + 1))"
}

run_truncate_disarm() {
  phase "Path truncate disarms an already-open descriptor's buffered write"
  wait_for_path "$INPUT_LAST_MESSAGE"

  # `handles.write` overlays the buffer the open seeded from the file, so the
  # stale value is this content over whatever tail of the old value outlives it.
  # The assertions below read the daemon's trace and do not depend on which.
  STALE_CONTENT="open-stale-descriptor"
  STALE_TRACE_MARK=$(trace_line_count)

  # Write and truncate under one sustained redirect of fd 9. On Linux the kernel
  # sends FUSE flush on every close(), and `printf >&9` closes a dup of fd 9 when
  # the redirect ends — which would flush the descriptor's buffered write before
  # the truncate ever runs, defeating the point of the test. Redirecting the whole
  # group keeps fd 9's buffered write on the handle until the group ends, so every
  # flush of it happens after the truncate has disarmed it.
  exec 9<> "$INPUT_LAST_MESSAGE"
  {
    printf '%s' "$STALE_CONTENT"
    : > "$INPUT_LAST_MESSAGE"
  } >&9
  exec 9>&-

  # The write above leaves fd 9's handle holding the stale content and marked
  # dirty. The truncate empties the buffer of every descriptor open on this inode
  # and clears `dirty` on all of them, and leaves `truncatePending` set only on
  # the truncating handle. `dirty || truncatePending` is what `flushHandle`,
  # `flushCb` and `releaseCb` gate on, so clearing both is what makes fd 9's
  # handle inert.
  #
  # `releaseCb` traces the handle's state before deciding anything, so its line
  # reports whether close() found the descriptor armed, on either truncate path
  # and whichever callback does the flushing. The cell value cannot report that;
  # `docs/development/waiting-in-tests-rationale.md` records why.
  STALE_FH=$(resolve_traced_write_fh "$STALE_TRACE_MARK" "${#STALE_CONTENT}") ||
    error "Could not resolve the handle the daemon assigned to fd 9."

  wait_for_trace_line "$STALE_TRACE_MARK" "[write-trace] release fh=$STALE_FH "
  STALE_RELEASE_LINE=$(trace_release_line "$STALE_TRACE_MARK" "$STALE_FH")

  if [[ "$STALE_RELEASE_LINE" != *" pending="* ]] ||
    [[ "$STALE_RELEASE_LINE" != *" flushing="* ]]; then
    error "Daemon release trace no longer reports flushing/pending: $STALE_RELEASE_LINE"
  fi

  # `pending` is `dirty || truncatePending`, the pair every flush path gates on.
  if [[ "$STALE_RELEASE_LINE" != *" pending=false"* ]]; then
    error "Truncate left the open descriptor armed at close(). Daemon traced: $STALE_RELEASE_LINE"
  fi

  # A flush already in flight carries the buffer it copied when it started, which
  # the truncate cannot recall.
  if [[ "$STALE_RELEASE_LINE" != *" flushing=false"* ]]; then
    error "A flush was already in flight for the descriptor at close(). Daemon traced: $STALE_RELEASE_LINE"
  fi

  # The release line alone would miss a descriptor whose flush had already
  # finished by the time release arrived, which clears the same fields the disarm
  # does. `flushCb` traces `flush-fire` only for a handle that got past the gate,
  # so its absence rules that out. close() sends flush before release and the
  # daemon runs its callbacks on one thread, so a traced release means the flush
  # decision is already traced too.
  assert_trace_line_absent "$STALE_TRACE_MARK" \
    "[write-trace] flush-fire fh=$STALE_FH" \
    "Truncate left the open descriptor armed: the daemon flushed fh=$STALE_FH on close()"
}

# Reads the cell through the value run_truncate_disarm emptied, so it runs
# after that phase rather than on its own.
run_truncate_clears() {
  phase "Path truncate clears stale open write handles"
  wait_for_piece_value "lastMessage" '""'
}

# The closing assertion is that the update leaves lastMessage as the empty
# string run_truncate_clears saw, so this phase runs after that one rather
# than on its own.
run_source_update() {
  phase "FUSE source writes can explicitly authorize an incompatible schema update"
  FUSE_PATTERN_SRC="$PIECE_DIR/.src/fuse-exec.tsx"
  wait_for_path "$FUSE_PATTERN_SRC"
  PATTERN_IDENTITY_BEFORE_SOURCE_WRITE=$(piece_pattern_identity)
  if [ -z "$PATTERN_IDENTITY_BEFORE_SOURCE_WRITE" ]; then
    error "Could not read the piece pattern identity before the FUSE source update."
  fi

  INCOMPATIBLE_PATTERN_SRC=$(mktemp)
  awk '
    /^interface Output \{/ { in_output = 1 }
    in_output && /^  lastMessage: string;$/ {
      print "  lastMessage: string | number;"
      in_output = 0
      next
    }
    { print }
  ' "$PATTERN_SRC" >"$INCOMPATIBLE_PATTERN_SRC"
  if ! grep -q '^  lastMessage: string | number;$' "$INCOMPATIBLE_PATTERN_SRC"; then
    error "Failed to build the incompatible FUSE source update fixture."
  fi

  tee "$FUSE_PATTERN_SRC" <"$INCOMPATIBLE_PATTERN_SRC" >/dev/null
  PATTERN_IDENTITY_AFTER_SOURCE_WRITE=$(
    wait_for_pattern_identity_change "$PATTERN_IDENTITY_BEFORE_SOURCE_WRITE"
  )
  if [ "$PATTERN_IDENTITY_AFTER_SOURCE_WRITE" = "$PATTERN_IDENTITY_BEFORE_SOURCE_WRITE" ]; then
    error "Dangerously authorized FUSE source write did not update the piece."
  fi
  wait_for_piece_value "lastMessage" '""'
}

# Every phase runs whichever section was asked for. The mount is what this
# suite costs, and each of these is a precondition of everything below it: the
# entity listing reads a memory-proxy trace that accumulates over the run, so
# nothing may hydrate the piece before it, and the two after it put the
# mounted tree in place. They record like any other phase and are not
# selectable.
PRELUDE=(mount entity-listing piece-paths entities-entry)

# The phases each section runs, in the order `all` runs them. A section is a
# group of phases over one mount rather than a phase on its own: the mount,
# the daemon and the piece cost more than every phase together, and each
# section needs all three. What a section can assume is what the prelude above
# leaves behind — a mounted space holding one stepped piece, with the piece's
# paths named and its entity directory resolved.
#
# Two dependencies decide where the boundaries fall. The four handler phases
# assert `messageCount` as an absolute count up from the piece's initial zero,
# so they stay together and in order. And the source update ends by asserting
# `lastMessage` is the empty string the truncate phase left behind, so it sits
# in the section holding that phase.
#
# `callable-entries` is a precondition rather than a boundary: it puts the
# callable files in place, so every section that runs one of them runs it
# first, and `all` runs it once.
#
# This table is read as well as run. packages/cli/test/fuse-sections.test.ts
# holds it to reaching every phase, from `all` and from the sections the test
# topology's `cli-fuse` suite makes units of, and to naming phases the script
# defines. Choosing the arm here, before the mount, is what makes an unknown
# section cost a second rather than a mount.
case "$SECTION" in
  all)
    PHASES=(
      status-document callable-entries callable-json-surface
      callable-shebangs callable-help handler-direct-exec handler-stdin
      tool-stdin handler-flags handler-implicit-verb tool-flags
      tool-help-field tool-implicit-verb empty-object-handler
      shared-backing-cell legacy-write-through truncate-disarm
      truncate-clears source-update
    )
    ;;
  status)
    PHASES=(status-document)
    ;;
  callables)
    PHASES=(
      callable-entries callable-json-surface callable-shebangs callable-help
    )
    ;;
  exec)
    PHASES=(
      callable-entries handler-direct-exec handler-stdin tool-stdin
      handler-flags handler-implicit-verb tool-flags tool-help-field
      tool-implicit-verb empty-object-handler shared-backing-cell
    )
    ;;
  writes)
    PHASES=(
      callable-entries legacy-write-through truncate-disarm truncate-clears
      source-update
    )
    ;;
  *)
    error "Unknown FUSE integration section: $SECTION"
    ;;
esac

# A phase's function is its name with dashes turned into underscores. Each
# opens its own record, and the cleanup trap closes whichever was open, so a
# phase that fails is the one recorded as failing.
for PHASE in "${PRELUDE[@]}" "${PHASES[@]}"; do
  "run_${PHASE//-/_}"
done

echo "FUSE exec integration section '$SECTION' passed."
