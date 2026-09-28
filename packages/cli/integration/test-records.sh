# Test recording for the CLI shell suites. Sourced, not executed. Inert
# without CF_TEST_RECORDS_DIR; a script that cannot write the spool keeps
# running and records nothing. Each sourcing script is one producer with
# one fragment file.
#
# Usage, from a script that runs under `set -e`:
#
#   source "$(dirname -- "${BASH_SOURCE[0]}")/test-records.sh"
#   cf_test_record_script "acl.sh"
#
# The record is written from an EXIT trap with the script's exit status and
# wall-clock duration, so a failing script still records its failure.

CF_TEST_RECORD_FRAGMENT=""
CF_TEST_RECORD_START_MS=""
CF_TEST_RECORD_NAME=""
CF_TEST_STEP_NAME=""
CF_TEST_STEP_START_MS=""

cf_test_now_ms() {
  # deno is the toolchain every suite here already requires; a machine
  # where it fails records zero durations rather than failing anything.
  deno eval --quiet 'console.log(Date.now())' 2>/dev/null || echo 0
}

cf_test_record_line() {
  # Arguments: name, outcome, duration in ms. A step's name is a sentence
  # somebody wrote beside the phase it describes, so the two characters
  # that would tear the JSON line are escaped rather than assumed absent;
  # a torn line is one the reader drops without saying why.
  if [ -z "${CF_TEST_RECORDS_DIR:-}" ]; then
    return 0
  fi
  if [ -z "$CF_TEST_RECORD_FRAGMENT" ]; then
    mkdir -p "$CF_TEST_RECORDS_DIR" 2>/dev/null || return 0
    CF_TEST_RECORD_FRAGMENT="$CF_TEST_RECORDS_DIR/fragment-sh-$$-${RANDOM}${RANDOM}.ndjson"
  fi
  # A step name is a sentence somebody wrote beside the phase it
  # describes. The two characters that would tear the line are escaped
  # here, and a control character — a newline above all — is replaced
  # rather than escaped, because a raw one splits the record into two
  # lines and the reader drops both.
  local name="$1"
  name="${name//\\/\\\\}"
  name="${name//\"/\\\"}"
  name=$(printf '%s' "$name" | tr '\000-\037' ' ')
  printf '{"line":"record","test":{"k":"integration","s":"cli","n":"%s"},"outcome":"%s","durationMs":%d}\n' \
    "$name" "$2" "$3" >> "$CF_TEST_RECORD_FRAGMENT" 2>/dev/null || true
}

# Records the script's one test with the given exit status. For a script
# whose own EXIT trap must stay in place, call this from that trap instead
# of registering cf_test_record_script's.
cf_test_record_with_status() {
  local status="$1"
  local end_ms
  end_ms=$(cf_test_now_ms)
  local outcome="pass"
  if [ "$status" -ne 0 ]; then
    outcome="fail"
  fi
  cf_test_record_line "$CF_TEST_RECORD_NAME" "$outcome" \
    $((end_ms - CF_TEST_RECORD_START_MS))
}

cf_test_record_exit_trap() {
  local status=$?
  cf_test_step_close "$status"
  cf_test_record_with_status "$status"
  return $status
}

# Marks the start of a named step inside the dispatched section. The
# previous step's record is written here — a step that ran to the next
# marker completed, or the script would have exited — and the last open
# step is closed by the exit trap with the script's status. Steps run in
# plain command position, so this instrumentation never suppresses the
# script's error handling.
cf_test_step_begin() {
  if [ -z "${CF_TEST_RECORDS_DIR:-}" ]; then
    return 0
  fi
  cf_test_step_close 0
  # The step's identity is the script's name and the step's, and carries
  # no section: which section scheduled a step is run context, and the
  # same step must join across a lane's run of one section and a local
  # `all` run.
  CF_TEST_STEP_NAME="$CF_TEST_RECORD_NAME $1"
  CF_TEST_STEP_START_MS=$(cf_test_now_ms || echo 0)
}

cf_test_step_close() {
  local status="$1"
  if [ -z "$CF_TEST_STEP_NAME" ]; then
    return 0
  fi
  local end_ms
  end_ms=$(cf_test_now_ms || echo 0)
  local outcome="pass"
  if [ "$status" -ne 0 ]; then
    outcome="fail"
  fi
  cf_test_record_line "$CF_TEST_STEP_NAME" "$outcome" \
    $((end_ms - CF_TEST_STEP_START_MS))
  CF_TEST_STEP_NAME=""
  CF_TEST_STEP_START_MS=""
}

# Records the whole script (or its dispatched section) as one test, from
# start to exit.
cf_test_record_script() {
  if [ -z "${CF_TEST_RECORDS_DIR:-}" ]; then
    return 0
  fi
  CF_TEST_RECORD_NAME="$1"
  CF_TEST_RECORD_START_MS=$(cf_test_now_ms)
  trap cf_test_record_exit_trap EXIT
}
