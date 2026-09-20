#!/usr/bin/env bash
set -e

# Redirect logs to stderr so they don't pollute stdout (used for machine-readable output)
export LOG_TO_STDERR=1
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
error () {
  >&2 echo $1
  exit 1
}
assert_json_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  local expected_file
  local actual_file
  expected_file=$(mktemp)
  actual_file=$(mktemp)
  echo "$expected" | jq -S . > "$expected_file"
  echo "$actual" | jq -S . > "$actual_file"
  if ! diff -u "$expected_file" "$actual_file" > /dev/null; then
    error "$message"
  fi
}
replace () {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i ' ' "$1" "$2"
  else
    sed -i "$1" "$2"
  fi
}

if [ -n "${CF_CLI_INTEGRATION_USE_LOCAL:-}" ]; then
 cf_impl() {
   deno task cli "$@"
 }
else
 cf_impl() {
   command cf "$@"
 }
fi

cf() {
  if [ -z "$CF_CLI_INTEGRATION_TIMINGS" ]; then
    cf_impl "$@"
    return $?
  fi

  local start_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  cf_impl "$@"
  local status=$?
  local end_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  local elapsed_ms=$((end_ms - start_ms))
  local timing_line="[cf-timing] ${elapsed_ms}ms :: cf $*"
  >&2 echo "$timing_line"
  if [ -n "${CF_CLI_INTEGRATION_TIMINGS_FILE:-}" ]; then
    printf '%s\n' "$timing_line" >> "$CF_CLI_INTEGRATION_TIMINGS_FILE"
  fi
  return $status
}

# Delegated scripts (verbs-over-the-cli, verb-session-gaps, and the drills)
# run cf through $CF_BINARY, falling back to the checkout's deno task when it
# is unset. Resolve and export it here once, from the same decision cf_impl
# made, so a child tests the same artifact as the step that invoked it: the
# external binary on PATH, or unset in local-source mode so the fallback
# keeps parent and child on the checkout together.
if [ -z "${CF_CLI_INTEGRATION_USE_LOCAL:-}" ] && [ -z "${CF_BINARY:-}" ]; then
  CF_BINARY="$(type -P cf || true)"
fi
if [ -n "${CF_BINARY:-}" ]; then
  export CF_BINARY
fi

PATTERN_SRC="$SCRIPT_DIR/pattern/main.tsx"
SCHEMA_COMPATIBLE_PATTERN_SRC="$SCRIPT_DIR/pattern/schema-compatible.tsx"
SCHEMA_INCOMPATIBLE_PATTERN_SRC="$SCRIPT_DIR/pattern/schema-incompatible.tsx"
CUSTOM_EXPORT="customPatternExport" # for testing this feature
SECTION="${CF_CLI_INTEGRATION_SECTION:-${1:-all}}"

# The script records as one test named "integration.sh", written from the EXIT
# trap with its status and duration; each step below records as its own test
# named "integration.sh <step>". Neither name carries the dispatched section:
# which section scheduled a step is run context, and the same script and the
# same step join across a CI section leg and a local `all` run.
source "$SCRIPT_DIR/test-records.sh"
cf_test_record_script "integration.sh"

# A fresh invocation id. uuidgen is not present on every runner image, so this
# falls back to Python, which the timing helper above already requires.
new_invocation_id() {
  if command -v uuidgen > /dev/null 2>&1; then
    uuidgen
  else
    python3 -c 'import uuid; print(uuid.uuid4())'
  fi
}

# The server-execution arm this run's `cf` resolves (server-execution v2,
# testing.md §2), decided the way the cf binary itself decides: an explicit
# EXPERIMENTAL_SERVER_EXECUTION wins, else the deployment's own posture —
# probed off /api/health/stats (`servingLoop` present = the toolshed
# serves, and cf adopts the published ON posture). In the default CI lane
# this follows the first-party constant (the registry states its current
# value); an explicitly-ON toolshed resolves ON. Verb receipts are
# DELIBERATELY not written
# under ON (events.md §4: exactly-once is the stream's eventWatermark, so
# the receipt create-only mechanism must not coexist with it), which is
# why the dedup asserts below branch on this: the `deduplicated` key is
# the OFF arm's receipt-collision witness, and the ON arm's witness is
# BEHAVIORAL — same invocation echoed, exit 0, and exactly one message
# (which still fails if --invocation were ignored outright).
#
# The probe carries connect and total deadlines. A toolshed that ACCEPTS the
# connection and then stalls would otherwise hold this helper — and with it
# the whole retry suite, which calls it per assertion — for as long as the
# server stays silent, with no output and no step-level diagnosis. A stats
# endpoint that cannot answer within seconds is a dead deployment; the arm
# then reads OFF and the assertion that follows fails loudly.
server_execution_on() {
  case "${EXPERIMENTAL_SERVER_EXECUTION:-}" in
    true) return 0 ;;
    false) return 1 ;;
  esac
  curl --connect-timeout 5 --max-time 15 -fsS "$API_URL/api/health/stats" \
    2>/dev/null | jq -e '.servingLoop != null' > /dev/null 2>&1
}

# The session this run's invocation ids are chosen within. `cf piece call`
# takes it from CF_INVOCATION_SESSION, and an id addresses an outcome only
# within its session — so every retry below has to name the session its
# original call named. Minted the way an invocation id is: a session is an
# unguessable string and nothing more, and going through
# `cf invocation-session new` for it would cost a CLI process.
export CF_INVOCATION_SESSION="$(new_invocation_id)"

# Kill a backgrounded `cf` invocation. `cf` is a shell function, so $! is the
# subshell rather than the Deno process doing the work; killing only the
# subshell would leave that child running and still able to commit. Take the
# children first, then the subshell.
kill_process_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_process_tree "$child"
  done
  kill "$pid" 2> /dev/null || true
  wait "$pid" 2> /dev/null || true
}

# Count the messages a piece recorded. A piece that has never handled an event
# has nothing materialized to read, which reads as zero messages rather than as
# a failure — the same tolerance read_piece_value_or_default gives scalars.
message_count() {
  local piece_id="$1"
  local raw
  raw=$(cf cell get $SPACE_ARGS --piece "$piece_id" messages 2>/dev/null || true)
  if [ -z "$raw" ]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$raw" | jq 'length'
}

# Assert a piece recorded exactly `expected` messages.
assert_message_count() {
  local piece_id="$1"
  local expected="$2"
  local message="$3"
  local actual
  actual=$(message_count "$piece_id")
  if [ "$actual" != "$expected" ]; then
    error "$message (expected $expected, got $actual)"
  fi
}

setup_space() {
  if [ -z "$API_URL" ]; then
    error "API_URL must be defined."
  fi

  SPACE=$(mktemp -u XXXXXXXXXX) # generates a random space
  IDENTITY=$(mktemp)
  SPACE_ARGS="--api-url=$API_URL --identity=$IDENTITY --space=$SPACE"
  WORK_DIR=$(mktemp -d)

  echo "API_URL=$API_URL"
  echo "SPACE=$SPACE"
  echo "IDENTITY=$IDENTITY"
  echo "WORK_DIR=$WORK_DIR"

  # Create a key
  cf id new > "$IDENTITY"

  # Check space is empty
  if [ "$(cf piece ls $SPACE_ARGS)" != "" ]; then
    error "Space not empty."
  fi
}

# Helper functions for testing
test_value() {
  local test_name="$1"
  local path="$2"
  local value="$3"
  local expected="$4"
  local flags="$5"

  echo "$value" | cf cell set $SPACE_ARGS --piece $PIECE_ID "$path" $flags
  local result=$(cf cell get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  if [ "$result" != "$expected" ]; then
    error "$test_name failed. Expected: $expected, Got: $result"
  fi
}

read_piece_value_or_default() {
  local piece_id="$1"
  local path="$2"
  local fallback="$3"
  local actual

  actual=$(cf cell get $SPACE_ARGS --piece "$piece_id" "$path" 2>/dev/null || true)
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

test_json_value() {
  local test_name="$1"
  local path="$2"
  local value="$3"
  local flags="$4"

  echo "$value" | cf cell set $SPACE_ARGS --piece $PIECE_ID "$path" $flags
  local result=$(cf cell get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  assert_json_eq "$result" "$value" "$test_name failed. Expected: $value, Got: $result"
}

test_get_only() {
  local test_name="$1"
  local path="$2"
  local expected="$3"
  local flags="$4"

  local result=$(cf cell get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  if [ "$result" != "$expected" ]; then
    error "$test_name failed. Expected: $expected, Got: $result"
  fi
}

create_stepped_counter_piece() {
  local value="$1"

  PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created source piece: $PIECE_ID"

  printf '{"value":%s}\n' "$value" | cf piece apply $SPACE_ARGS --piece $PIECE_ID
  echo "$value" | cf cell set $SPACE_ARGS --piece $PIECE_ID value
  cf piece step $SPACE_ARGS --piece $PIECE_ID

  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID value)
  if [ "$RESULT" != "$value" ]; then
    error "Source piece value should be $value before linking, got: $RESULT"
  fi
}

run_piece_values() {
  setup_space

  # Create a new piece using custom default export as input
  PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created piece: $PIECE_ID"

  echo "Fetching piece source to $WORK_DIR"
  # Retrieve the source code for $PIECE_ID to $WORK_DIR
  cf piece getsrc $SPACE_ARGS --piece $PIECE_ID $WORK_DIR

  # Check file was retrieved
  if [ ! -f "$WORK_DIR/main.tsx" ]; then
    error "Source code was not retrieved from $PIECE_ID"
  fi
  if [ ! -f "$WORK_DIR/utils.ts" ]; then
    error "Source code was not retrieved from $PIECE_ID"
  fi

  echo "Updating piece source."

  # Update the piece's source code
  replace 's/Simple counter:/Simple counter 2:/g' "$WORK_DIR/main.tsx"
  cf piece setsrc --main-export $CUSTOM_EXPORT $SPACE_ARGS --piece $PIECE_ID $WORK_DIR/main.tsx

  # (Again) Retrieve the source code for $PIECE_ID to $WORK_DIR
  rm "$WORK_DIR/main.tsx"
  cf piece getsrc $SPACE_ARGS --piece $PIECE_ID $WORK_DIR

  # Check file was retrieved with modifications
  if ! grep -q "Simple counter 2" "$WORK_DIR/main.tsx"; then
    error "Retrieved source code was not modified"
  fi

  echo "Testing explicitly authorized incompatible source updates."
  local schema_piece_id schema_identity_before schema_identity_after_rejection
  local schema_identity_after_override schema_value
  schema_piece_id=$(cf piece new --no-start $SPACE_ARGS "$SCHEMA_COMPATIBLE_PATTERN_SRC")
  echo '{"value":5}' | cf piece apply $SPACE_ARGS --piece "$schema_piece_id"
  cf piece step $SPACE_ARGS --piece "$schema_piece_id"
  schema_identity_before=$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )

  # The preflight answers the same question without touching the piece.
  if cf piece setsrc --check $SPACE_ARGS --piece "$schema_piece_id" \
    "$SCHEMA_INCOMPATIBLE_PATTERN_SRC" \
    >"$WORK_DIR/incompatible-check.out" \
    2>"$WORK_DIR/incompatible-check.err"; then
    error "setsrc --check should fail for an incompatible source."
  fi
  if ! grep -q "cannot replace the source" "$WORK_DIR/incompatible-check.err"; then
    error "setsrc --check did not report the verdict."
  fi
  if ! grep -q "not backward compatible" "$WORK_DIR/incompatible-check.err"; then
    error "setsrc --check did not name the rule that refused it."
  fi
  if [ "$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )" != "$schema_identity_before" ]; then
    error "setsrc --check changed the piece source."
  fi
  # A compatible source clears the same preflight, and still applies nothing.
  cf piece setsrc --check $SPACE_ARGS --piece "$schema_piece_id" \
    "$SCHEMA_COMPATIBLE_PATTERN_SRC" >/dev/null

  if cf piece setsrc $SPACE_ARGS --piece "$schema_piece_id" \
    "$SCHEMA_INCOMPATIBLE_PATTERN_SRC" \
    >"$WORK_DIR/incompatible-setsrc.out" \
    2>"$WORK_DIR/incompatible-setsrc.err"; then
    error "Incompatible setsrc should fail without the dangerous override."
  fi
  if ! grep -q "not backward compatible" "$WORK_DIR/incompatible-setsrc.err"; then
    error "Incompatible setsrc failed for an unexpected reason."
  fi
  schema_identity_after_rejection=$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )
  if [ "$schema_identity_after_rejection" != "$schema_identity_before" ]; then
    error "Rejected incompatible setsrc changed the piece source."
  fi

  cf piece setsrc --dangerously-allow-incompatible-schema $SPACE_ARGS \
    --piece "$schema_piece_id" "$SCHEMA_INCOMPATIBLE_PATTERN_SRC"
  schema_identity_after_override=$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )
  if [ "$schema_identity_after_override" = "$schema_identity_before" ]; then
    error "Dangerously authorized setsrc did not change the piece source."
  fi
  schema_value=$(cf cell get $SPACE_ARGS --piece "$schema_piece_id" value)
  if [ "$schema_value" != "5" ]; then
    error "Dangerously authorized setsrc did not preserve the valid result."
  fi

  echo "Applying piece input."

  # Apply new input to piece
  echo '{"value":5}' | cf piece apply $SPACE_ARGS --piece $PIECE_ID

  # get, set and then re-get a value from the piece
  echo '10' | cf cell set $SPACE_ARGS --piece $PIECE_ID value

  # Verify the get returned what we expect
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID value)
  assert_json_eq "$RESULT" '10' "Get operation did not return expected value. Expected: 10, Got: $RESULT"

  echo "Testing different data types and nested paths..."

  # Test different data types
  test_value "String value" "stringField" '"hello world"' '"hello world"'
  test_value "Number value" "numberField" '42' '42'
  test_value "Boolean value" "booleanField" 'true' 'true'
  test_json_value "Array value" "arrayField" '[1,2,3]'
  test_json_value "Nested object" "userData" '{"user":{"name":"John","age":30}}'

  # Test nested path access
  test_get_only "Nested path access" "userData/user/name" '"John"'
  test_json_value "Array indexing" "listField" '["first","second","third"]'
  test_get_only "Array index access" "listField/1" '"second"'

  # Test setting nested value
  test_value "Nested path set" "userData/user/name" '"Jane"' '"Jane"'

  echo "Testing --input flag operations..."

  # Test input flag operations
  test_json_value "Input flag set" "userData" '{"user":{"name":"test"}}' "--input"
  test_value \
    "Nested input path" \
    "userData/user/name" \
    '"piece-search-input-value-7301"' \
    '"piece-search-input-value-7301"' \
    "--input"

  echo '"piece-search-result-value-9146"' |
    cf cell set $SPACE_ARGS --piece $PIECE_ID stringField
  SEARCH_INPUT=$(cf piece search $SPACE_ARGS --json "INPUT-VALUE-7301")
  echo "$SEARCH_INPUT" | jq -e --arg id "$PIECE_ID" \
    'length == 1 and .[0].id == $id' > /dev/null ||
    error "Piece search should find nested input data case-insensitively"
  SEARCH_RESULT=$(cf piece search $SPACE_ARGS --json "RESULT-VALUE-9146")
  echo "$SEARCH_RESULT" | jq -e --arg id "$PIECE_ID" \
    'length == 1 and .[0].id == $id' > /dev/null ||
    error "Piece search should find nested result data case-insensitively"
  SEARCH_NONE=$(cf piece search $SPACE_ARGS --json "piece-search-absent-5283")
  echo "$SEARCH_NONE" | jq -e 'length == 0' > /dev/null ||
    error "Piece search should return an empty JSON array when nothing matches"
  SEARCH_NAME=$(cf piece search $SPACE_ARGS --json "Simple counter:")
  echo "$SEARCH_NAME" | jq -e 'length == 0' > /dev/null ||
    error "Piece search should not match a piece name"

  echo "Testing piece step..."

  # Recompute (one iteration) with updated inputs
  cf piece step $SPACE_ARGS --piece $PIECE_ID

  # Check space has new piece with correct inputs and title
  TITLE="Simple counter 2: 10"
  if ! cf piece ls $SPACE_ARGS | grep -q "$PIECE_ID $TITLE"; then
    error "Piece did not appear in list of space pieces."
  fi

  echo "Successfully ran CLI piece values integration tests for ${API_URL}/${SPACE}/${PIECE_ID}."
}

run_piece_links() {
  setup_space

  create_stepped_counter_piece 10

  echo "Testing piece link..."

  cf piece set-slug $SPACE_ARGS counter-alias $PIECE_ID

  cf cell get $SPACE_ARGS --piece counter-alias value > /dev/null

  cf piece set-slug $SPACE_ARGS resolved-counter counter-alias --resolve-before-linking

  cf cell get $SPACE_ARGS --piece resolved-counter value > /dev/null

  # The slug index: both names just assigned are enumerable, and each resolves
  # to a piece. Names are compared exactly; the resolved ids are only checked
  # non-null, because an address is something to read next, not an identifier
  # to compare (docs/common/verbs/session-walkthrough.md, "An address is not an
  # identifier to compare").
  SLUGS_JSON=$(cf piece slugs $SPACE_ARGS --json)
  echo "$SLUGS_JSON" | jq -e '[.[].slug] == ["counter-alias", "resolved-counter"]' > /dev/null ||
    error "The slug listing should name both assigned slugs, got: $SLUGS_JSON"
  echo "$SLUGS_JSON" | jq -e 'all(.[]; .piece != null)' > /dev/null ||
    error "Every listed slug should resolve to a piece, got: $SLUGS_JSON"
  echo "Successfully listed the slug index."

  # Create a second piece from the same pattern
  PIECE_ID2=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created second piece: $PIECE_ID2"

  # Initialize piece2 with value 0 and step so output is computed
  echo '0' | cf cell set $SPACE_ARGS --piece $PIECE_ID2 value --input
  cf piece step $SPACE_ARGS --piece $PIECE_ID2

  # Verify piece2 starts with value 0
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID2 value)
  if [ "$RESULT" != "0" ]; then
    error "Piece2 value should be 0 before linking, got: $RESULT"
  fi

  # Linking from a nonexistent source path should fail
  if cf piece link $SPACE_ARGS $PIECE_ID/nonexistent $PIECE_ID2/value 2>/dev/null; then
    error "Linking from nonexistent source path should have failed"
  fi

  # Linking to a nonexistent target path should fail
  if cf piece link $SPACE_ARGS $PIECE_ID/value $PIECE_ID2/nonexistent 2>/dev/null; then
    error "Linking to nonexistent target path should have failed"
  fi

  # Link piece1's output value to piece2's input value
  cf piece link $SPACE_ARGS $PIECE_ID/value $PIECE_ID2/value

  # Linking to a missing destination slug should fail instead of treating it
  # as an invented target piece ID.
  if cf piece link $SPACE_ARGS $PIECE_ID/value missing-destination-slug/value 2>/dev/null; then
    error "Linking to missing destination slug should have failed"
  fi

  # Read back piece2's input value - should be piece1's output value (10)
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID2 value --input)
  if [ "$RESULT" != "10" ]; then
    error "After linking, piece2's input value should be 10 (from piece1), got: $RESULT"
  fi

  # Step piece2 to recompute with linked input
  cf piece step $SPACE_ARGS --piece $PIECE_ID2

  # Verify piece2's output value is now 10 (from piece1 via link)
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID2 value)
  if [ "$RESULT" != "10" ]; then
    error "After linking and stepping, piece2's output value should be 10, got: $RESULT"
  fi

  # Call increment handler on piece2; since its value is linked to piece1's
  # output cell, this should update piece1's value too.
  cf piece call $SPACE_ARGS --piece $PIECE_ID2 increment '{}'

  # Verify piece1's value is now 11 (was 10, incremented via piece2's handler)
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID value)
  if [ "$RESULT" != "11" ]; then
    error "After calling increment on piece2, piece1's value should be 11, got: $RESULT"
  fi

  echo "Testing piece link with invented piece ID..."

  # Use an invented piece ID (not created via cf piece new) as a data source
  INVENTED_ID="fid1:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"

  # Write a value to the invented piece
  echo '42' | cf cell set $SPACE_ARGS --piece $INVENTED_ID value

  # Create a third piece and link the invented piece's value to its input
  PIECE_ID3=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created third piece: $PIECE_ID3"

  # Linking from invented piece should fail without --allow-non-existing —
  # and as a DATA error: message (with the --allow-non-existing next step) and
  # TIP on stderr, nothing on stdout, no usage screen (regression guard for
  # the LinkValidationError → Cliffy usage-dump path).
  LINK_ERR_FILE=$(mktemp)
  if LINK_OUT=$(cf piece link $SPACE_ARGS $INVENTED_ID/value $PIECE_ID3/value 2>"$LINK_ERR_FILE"); then
    error "Linking from invented piece should have failed without --allow-non-existing"
  fi
  if [ -n "$LINK_OUT" ]; then
    error "Link data error should print nothing to stdout, got: $LINK_OUT"
  fi
  grep -q -- "--allow-non-existing" "$LINK_ERR_FILE" ||
    error "Link data error should carry the --allow-non-existing next step on stderr"
  grep -q "TIP:" "$LINK_ERR_FILE" ||
    error "Link data error should print the inspect hint on stderr"
  if grep -q "Usage:" "$LINK_ERR_FILE"; then
    error "Link data error must not dump the usage screen"
  fi

  # Now link with --allow-non-existing
  cf piece link $SPACE_ARGS --allow-non-existing $INVENTED_ID/value $PIECE_ID3/value

  # Read back piece3's input value - should be 42 from the invented piece
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID3 value --input)
  if [ "$RESULT" != "42" ]; then
    error "After linking invented piece, piece3's input value should be 42, got: $RESULT"
  fi

  # Step piece3 to recompute with linked input
  cf piece step $SPACE_ARGS --piece $PIECE_ID3

  # Verify piece3's output value is 42
  RESULT=$(cf cell get $SPACE_ARGS --piece $PIECE_ID3 value)
  if [ "$RESULT" != "42" ]; then
    error "After stepping piece3 with invented link, output value should be 42, got: $RESULT"
  fi

  # Call increment on piece3 and verify the invented piece's value updates
  cf piece call $SPACE_ARGS --piece $PIECE_ID3 increment '{}'

  RESULT=$(cf cell get $SPACE_ARGS --piece $INVENTED_ID value)
  if [ "$RESULT" != "43" ]; then
    error "After calling increment on piece3, invented piece's value should be 43, got: $RESULT"
  fi

  echo "Successfully ran CLI piece link integration tests for ${API_URL}/${SPACE}/${PIECE_ID}."
}

run_piece_call() {
  setup_space

  echo "Testing piece call with schema-derived flags and tools..."

  CALLABLE_PATTERN_SRC="$SCRIPT_DIR/pattern/fuse-exec.tsx"
  CALLABLE_PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $CALLABLE_PATTERN_SRC)
  echo "Created callable piece: $CALLABLE_PIECE_ID"

  CALL_HELP=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --help)
  # These greps assert cf's output: the help page names the mount that was
  # invoked, and the invocation above is the top-level spelling.
  echo "$CALL_HELP" | grep -q "cf piece call ... search --help" ||
    error "Top-level callable help should work without the delimiter"
  echo "$CALL_HELP" | grep -q "cf piece call ... search <json>" ||
    error "Piece-call help should describe JSON input without --json"
  echo "$CALL_HELP" | grep -q "cf piece call ... search --json \[<json>\]" ||
    error "Piece-call help should describe explicit --json input"

  CALL_HELP_JSON=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --help --json)
  echo "$CALL_HELP_JSON" | jq -e '.inputSchema.properties.query.type == "string"' > /dev/null ||
    error "Top-level --help --json should return the machine-readable schema"

  JSON_TOOL_RESULT=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --json '{"query":"json-input"}')
  assert_json_eq \
    "$JSON_TOOL_RESULT" \
    '{"query":"json-input","help":"","source":"bound-source","summary":"bound-source:json-input:"}' \
    "Explicit inline --json should pass the complete tool input"

  cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID recordMessage --message "piece-flags"
  RESULT=$(cf cell get $SPACE_ARGS --piece $CALLABLE_PIECE_ID lastMessage)
  if [ "$RESULT" != '"piece-flags"' ]; then
    error "Flag-based handler call should update lastMessage, got: $RESULT"
  fi

  LEGACY_COUNT_BEFORE=$(read_piece_value_or_default "$CALLABLE_PIECE_ID" "legacyCount" "0")
  cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyWrite
  RESULT=$(cf cell get $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyCount)
  if [ "$RESULT" != "$((LEGACY_COUNT_BEFORE + 1))" ]; then
    error "Bare no-arg handler call should increment legacyCount, got: $RESULT"
  fi

  cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyWrite invoke
  RESULT=$(cf cell get $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyCount)
  if [ "$RESULT" != "$((LEGACY_COUNT_BEFORE + 2))" ]; then
    error "Explicit invoke should still call an empty-object handler, got legacyCount=$RESULT"
  fi

  TOOL_RESULT=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --query tea)
  assert_json_eq \
    "$TOOL_RESULT" \
    '{"query":"tea","help":"","source":"bound-source","summary":"bound-source:tea:"}' \
    "Flag-based tool call should return the tool result"

  # A verb that registers the piece it creates through the space root's
  # `addPiece` stream, called from a process in which dispatch has started the
  # addressed piece and nothing else: the send starts the root at delivery, and
  # the registry carries the entry when the call returns.
  ROOT_REGISTRAR_PATTERN_SRC="$SCRIPT_DIR/pattern/root-registrar.tsx"
  ROOT_REGISTRAR_PIECE_ID=$(cf piece new $SPACE_ARGS $ROOT_REGISTRAR_PATTERN_SRC)
  echo "Created root-registrar piece: $ROOT_REGISTRAR_PIECE_ID"
  cf piece call $SPACE_ARGS --piece $ROOT_REGISTRAR_PIECE_ID register --label registered-by-verb
  cf piece ls $SPACE_ARGS | grep -q "Entry registered-by-verb" ||
    error "A verb sending into the root's addPiece stream should register its piece; registry: $(cf piece ls $SPACE_ARGS)"

  echo "Successfully ran CLI piece call integration tests for ${API_URL}/${SPACE}/${CALLABLE_PIECE_ID}."
}

# Retry semantics for caller-supplied invocation ids (verb contract WS-D/D3).
# Every scenario ends with the SAME assertion — exactly one message recorded —
# because that is the property an agent depends on: a retry it cannot avoid
# must never double-apply the mutation.
run_piece_call_retry() {
  setup_space

  echo "Testing invocation-id retry semantics..."

  RETRY_PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS "$SCRIPT_DIR/pattern/fuse-exec.tsx")
  echo "Created retry-scenario piece: $RETRY_PIECE_ID"

  # --- 1. A failure before dispatch leaves nothing behind. ------------------
  # An unreachable API cannot dispatch, so the mutation provably never
  # happened and no invocation id was ever announced to retry with. The
  # caller's correct move is a fresh id, and that must yield exactly one.
  set +e
  cf piece call --api-url="http://127.0.0.1:1" --identity="$IDENTITY" --space="$SPACE" \
    --piece "$RETRY_PIECE_ID" --invocation "never-dispatched" \
    recordMessage --message "pre-dispatch" > /dev/null 2>&1
  PRE_DISPATCH_STATUS=$?
  set -e
  if [ "$PRE_DISPATCH_STATUS" -eq 0 ]; then
    error "A call to an unreachable API should fail, not report success"
  fi
  assert_message_count "$RETRY_PIECE_ID" 0 \
    "A pre-dispatch failure must not record a message"

  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_ID" --invocation "$(new_invocation_id)" \
    recordMessage --message "pre-dispatch" > /dev/null
  assert_message_count "$RETRY_PIECE_ID" 1 \
    "A fresh-id retry after a pre-dispatch failure should record exactly one message"

  # --- 2. Dispatched, then the caller died before acknowledgment. ----------
  # The riskiest window: the event is on its way and the caller cannot know
  # whether it committed. The kill is triggered by the CLI's own dispatch
  # announcement, so this lands in the window deterministically rather than
  # by racing a clock. Either outcome (committed or not) must leave exactly
  # one message once the same id is retried.
  RETRY_PIECE_2=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS "$SCRIPT_DIR/pattern/fuse-exec.tsx")
  INVOCATION_2=$(new_invocation_id)
  ANNOUNCE_FIFO=$(mktemp -u)
  mkfifo "$ANNOUNCE_FIFO"
  set +e
  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_2" --invocation "$INVOCATION_2" \
    recordMessage --message "dispatched-then-killed" > /dev/null 2> "$ANNOUNCE_FIFO" &
  CALL_PID=$!
  set -e
  # Blocking read on the pipe — no poll, no deadline. If the process exits
  # without announcing, the writer closes and the read ends at EOF.
  ANNOUNCED=""
  while IFS= read -r line; do
    case "$line" in
      *"invocation: $INVOCATION_2"*)
        ANNOUNCED="yes"
        break
        ;;
    esac
  done < "$ANNOUNCE_FIFO"
  kill_process_tree "$CALL_PID"
  rm -f "$ANNOUNCE_FIFO"
  if [ -z "$ANNOUNCED" ]; then
    error "cf piece call should announce its invocation id at dispatch"
  fi

  # Whether the killed call got its commit in is genuinely racy, and both
  # outcomes are correct — but they exercise different machinery, so record
  # which one happened instead of letting a weak pass look like a strong one.
  # If it committed, the retry MUST collide; if it did not, the retry must
  # apply cleanly. Asserting only "exactly one" would also pass with
  # --invocation ignored entirely, whenever the first commit failed to land.
  COMMITTED_BEFORE_KILL=$(message_count "$RETRY_PIECE_2")
  set +e
  RETRY_2=$(cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_2" --invocation "$INVOCATION_2" \
    recordMessage --message "dispatched-then-killed" 2>/dev/null)
  RETRY_2_STATUS=$?
  set -e
  if [ "$RETRY_2_STATUS" -ne 0 ]; then
    error "Retrying a killed-after-dispatch call should exit 0, got $RETRY_2_STATUS"
  fi
  echo "killed-after-dispatch: committed before kill = $COMMITTED_BEFORE_KILL"
  if server_execution_on; then
    # ON: no receipt PRECONDITION exists (events.md §4 subsumption — the
    # SERVING side writes the receipt itself, the ruled result carriage,
    # 2026-08-29), so there is no `deduplicated` key to assert either
    # way; the dedupe-horizon skip's witness is the message count below —
    # with the committed-before-kill value recorded above, "exactly one"
    # is the strong assert in BOTH sub-cases (a retry that ignored
    # --invocation would append a second message; an uncommitted first
    # attempt retried cleanly leaves one).
    if echo "$RETRY_2" | jq -e '.deduplicated == true' > /dev/null; then
      error "No receipt precondition exists under server execution, so the retry cannot claim receipt-level dedup, got: $RETRY_2"
    fi
  elif [ "$COMMITTED_BEFORE_KILL" = "1" ]; then
    echo "$RETRY_2" | jq -e '.deduplicated == true' > /dev/null ||
      error "The killed call had committed, so its retry must deduplicate, got: $RETRY_2"
  elif echo "$RETRY_2" | jq -e '.deduplicated == true' > /dev/null; then
    # An `x && error` here would abort under set -e on the expected path,
    # where jq exits non-zero; an if-condition is exempt.
    error "The killed call never committed, so its retry must not deduplicate, got: $RETRY_2"
  fi
  assert_message_count "$RETRY_PIECE_2" 1 \
    "Retrying a killed-after-dispatch call with the same id should leave exactly one message"

  # --- 3. The commit succeeded but the response was lost. ------------------
  # The retry collides on the handling's receipt, settles as success (exit 0)
  # rather than as an error, and says so with deduplicated.
  RETRY_PIECE_3=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS "$SCRIPT_DIR/pattern/fuse-exec.tsx")
  INVOCATION_3=$(new_invocation_id)
  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_3" --invocation "$INVOCATION_3" \
    recordMessage --message "lost-response" > /dev/null

  set +e
  REPLAY=$(cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_3" --invocation "$INVOCATION_3" \
    recordMessage --message "lost-response" 2>/dev/null)
  REPLAY_STATUS=$?
  set -e
  if [ "$REPLAY_STATUS" -ne 0 ]; then
    error "A same-id retry should exit 0, got status $REPLAY_STATUS"
  fi
  if server_execution_on; then
    # ON: receipt-level dedup REPORTING does not exist (the receipt is
    # written by the SERVING side, without the create-only precondition —
    # the ruled result carriage, 2026-08-29); the behavioral witness is
    # the count assert below plus the id echo here.
    if echo "$REPLAY" | jq -e '.deduplicated == true' > /dev/null; then
      error "No receipt precondition exists under server execution, so the replay cannot claim receipt-level dedup, got: $REPLAY"
    fi
  else
    echo "$REPLAY" | jq -e '.deduplicated == true' > /dev/null ||
      error "A same-id retry should report deduplicated, got: $REPLAY"
  fi
  echo "$REPLAY" | jq -e --arg id "$INVOCATION_3" '.invocation == $id' > /dev/null ||
    error "A same-id retry should echo the caller's invocation id, got: $REPLAY"
  assert_message_count "$RETRY_PIECE_3" 1 \
    "A same-id retry after a successful commit should leave exactly one message"

  # --- 4. A fresh process retrying the same id reads the ORIGINAL back. ----
  # Sending a different payload under an id that already settled must not
  # overwrite the original: the id identifies the invocation, so the second
  # call reports the first one's outcome rather than applying its own.
  RETRY_PIECE_4=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS "$SCRIPT_DIR/pattern/fuse-exec.tsx")
  INVOCATION_4=$(new_invocation_id)
  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_4" --invocation "$INVOCATION_4" \
    recordMessage --message "original-payload" > /dev/null
  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_4" --invocation "$INVOCATION_4" \
    recordMessage --message "second-payload" > /dev/null
  assert_message_count "$RETRY_PIECE_4" 1 \
    "Reusing a settled id with a different payload should leave exactly one message"
  LAST=$(cf cell get $SPACE_ARGS --piece "$RETRY_PIECE_4" lastMessage)
  if [ "$LAST" != '"original-payload"' ]; then
    error "The settled invocation's outcome should stand, got lastMessage: $LAST"
  fi

  # --- 5. A payload the verb cannot accept is refused, id intact. ----------
  # The schema rejection happens before dispatch, so the id is never spent.
  # That is the whole point: an agent that typos a field and retries under
  # the same idempotency key must get its corrected call executed, not
  # deduplicated against a handling that ran with no event.
  RETRY_PIECE_5=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS "$SCRIPT_DIR/pattern/fuse-exec.tsx")
  INVOCATION_5=$(new_invocation_id)
  set +e
  BAD_PAYLOAD=$(cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_5" --invocation "$INVOCATION_5" \
    recordMessage --json '{"mesage":"typo"}' 2>&1)
  BAD_STATUS=$?
  set -e
  if [ "$BAD_STATUS" -eq 0 ]; then
    error "A payload failing the verb's schema should fail, got: $BAD_PAYLOAD"
  fi
  case "$BAD_PAYLOAD" in
    *'Invalid input for "recordMessage"'*) ;;
    *) error "A schema rejection should name the verb, got: $BAD_PAYLOAD" ;;
  esac
  assert_message_count "$RETRY_PIECE_5" 0 \
    "A refused payload must not record a message"

  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_5" --invocation "$INVOCATION_5" \
    recordMessage --message "corrected" > /dev/null
  assert_message_count "$RETRY_PIECE_5" 1 \
    "A refused call never spent its id, so the corrected retry should record one"
  LAST_5=$(cf cell get $SPACE_ARGS --piece "$RETRY_PIECE_5" lastMessage)
  if [ "$LAST_5" != '"corrected"' ]; then
    error "The corrected retry's payload should stand, got lastMessage: $LAST_5"
  fi

  # --- 6. An absent payload the verb cannot run without is refused, id intact.
  # The mirror of scenario 5 for the second-most-likely agent mistake:
  # forgetting the payload rather than misspelling a field. `recordNote`'s
  # event schema sits behind a top-level local $ref, and the CLI reads the
  # definition's fields through it, so an explicit `invoke` carrying none is
  # refused by name — `note` is required and nothing supplies it.
  # What this scenario pins is not which door refuses but what the refusal
  # costs: nothing dispatches, so the invocation id is never spent and the
  # corrected same-id retry below still applies. A dispatch here would run
  # the handler with no event and burn the id, leaving the retry
  # deduplicated against an outcome the caller never wanted.
  RETRY_PIECE_6=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS "$SCRIPT_DIR/pattern/fuse-exec.tsx")
  INVOCATION_6=$(new_invocation_id)
  set +e
  ABSENT_OUT=$(cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_6" --invocation "$INVOCATION_6" \
    recordNote invoke 2>&1)
  ABSENT_STATUS=$?
  set -e
  if [ "$ABSENT_STATUS" -eq 0 ]; then
    error "An absent payload against a required-fields verb should fail, got: $ABSENT_OUT"
  fi
  case "$ABSENT_OUT" in
    *'Missing required flag --note'*) ;;
    *) error "An absent-payload refusal should name the missing field, got: $ABSENT_OUT" ;;
  esac
  assert_message_count "$RETRY_PIECE_6" 0 \
    "A refused absent-payload call must not record a message"

  cf piece call $SPACE_ARGS --piece "$RETRY_PIECE_6" --invocation "$INVOCATION_6" \
    recordNote --json '{"note":"corrected"}' > /dev/null
  assert_message_count "$RETRY_PIECE_6" 1 \
    "The refused call never spent its id, so the corrected retry should record one"
  LAST_6=$(cf cell get $SPACE_ARGS --piece "$RETRY_PIECE_6" lastMessage)
  if [ "$LAST_6" != '"corrected"' ]; then
    error "The corrected retry's payload should stand, got lastMessage: $LAST_6"
  fi

  echo "Successfully ran CLI piece call retry integration tests for ${API_URL}."
}

# The three-topic end-to-end fixture (verb contract D4, integration half):
# the graph from the live session, run against an isolated toolshed. An
# umbrella topic and two children are created through verbs that DECLARE
# results (the C1 authoring surface); every settled call's Invocation JSON
# must carry the result read back off the handling's receipt (C4's
# plainResultReceipts + D2). Results flow schema-free (the C3 deferral):
# the value path is the whole proof, and nothing here reads a result schema
# from the durable store. The retry of a deliberately dropped response must
# read the ORIGINAL result (the assertion D3 could not make with void
# verbs). The live-board half of D4 stays open, gated on the write-storm
# machinery (plan: Risks).
run_three_topic_fixture() {
  setup_space

  echo "Testing the three-topic end-to-end fixture (declared verb results)..."

  # Result readback is the point of this fixture, so the plain-return
  # projection is on for every call. The handler executes in the CLI's own
  # runtime, which reads the flag from the environment; the registry accepts
  # exactly "true"/"false" (EXPERIMENTAL_OPTIONS.md).
  export EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=true

  # Per-command wall-clock baseline (the plan's session-mode decision reads
  # these numbers). Reuses the harness's own timing wrapper; per-phase
  # --verbose timings (#5233) are not on this branch, so wall-clock around
  # each command is the honest measure.
  local saved_timings="${CF_CLI_INTEGRATION_TIMINGS:-}"
  local saved_timings_file="${CF_CLI_INTEGRATION_TIMINGS_FILE:-}"
  D4_TIMINGS=$(mktemp)
  export CF_CLI_INTEGRATION_TIMINGS=1
  export CF_CLI_INTEGRATION_TIMINGS_FILE="$D4_TIMINGS"

  TOPIC_PIECE_ID=$(cf piece new $SPACE_ARGS "$SCRIPT_DIR/pattern/topic-graph.tsx")
  echo "Created topic-graph piece: $TOPIC_PIECE_ID"

  # --- 1. Create the umbrella; its declared result is the child reference. --
  INV_UMBRELLA=$(new_invocation_id)
  UMBRELLA_PAYLOAD='{"title":"Umbrella","body":"Tracks the D4 fixture family.","agentName":"fable-d4"}'
  UMBRELLA_JSON=$(cf piece call $SPACE_ARGS --piece "$TOPIC_PIECE_ID" \
    --invocation "$INV_UMBRELLA" createTopic --json "$UMBRELLA_PAYLOAD" 2>/dev/null)
  echo "$UMBRELLA_JSON" | jq -e --arg id "$INV_UMBRELLA" \
    '.invocation == $id and .status == "settled"' > /dev/null ||
    error "The umbrella create should settle under the caller's id, got: $UMBRELLA_JSON"
  UMBRELLA_ID=$(echo "$UMBRELLA_JSON" | jq -re '.result.topic.id') ||
    error "The umbrella create's Invocation JSON should carry its declared result, got: $UMBRELLA_JSON"
  UMBRELLA_PATH=$(echo "$UMBRELLA_JSON" | jq -re '.result.topic.path')
  # The returned reference addresses the canonical child directly — no list
  # scan, no correlation by index.
  UMBRELLA_ENTRY=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" "$UMBRELLA_PATH")
  echo "$UMBRELLA_ENTRY" | jq -e --arg id "$UMBRELLA_ID" \
    '.id == $id and .title == "Umbrella" and
     .body == "Tracks the D4 fixture family." and .createdBy == "fable-d4"' > /dev/null ||
    error "The umbrella's returned reference should open the canonical child, got: $UMBRELLA_ENTRY"

  # --- 2. Child A references the umbrella BY ITS RETURNED ID. ---------------
  # The umbrella id below came off the result readback, so the reference
  # graph is built from returned references, never from prior knowledge.
  INV_CHILD_A=$(new_invocation_id)
  CHILD_A_PAYLOAD=$(jq -cn --arg u "$UMBRELLA_ID" \
    '{title: "Child A", body: ("Refines " + $u + "."), agentName: "fable-d4",
      references: [$u]}')
  CHILD_A_JSON=$(cf piece call $SPACE_ARGS --piece "$TOPIC_PIECE_ID" \
    --invocation "$INV_CHILD_A" createTopic --json "$CHILD_A_PAYLOAD" 2>/dev/null)
  CHILD_A_ID=$(echo "$CHILD_A_JSON" | jq -re '.result.topic.id') ||
    error "Child A's Invocation JSON should carry its declared result, got: $CHILD_A_JSON"
  CHILD_A_PATH=$(echo "$CHILD_A_JSON" | jq -re '.result.topic.path')

  # --- 3. Child B's response is deliberately dropped. -----------------------
  # The commit-then-lost-response window is entered deterministically, not by
  # racing a clock: the call runs with the CLI's test-only phase
  # announcements on (CF_TEST_ANNOUNCE_INVOCATION_PHASES — stderr lines of
  # the form `invocation: <id> phase: <phase>`, emitted only under that env
  # var), and a blocking pipe read waits for `phase: committed`, which the
  # CLI prints only once the handling's durable commit is acknowledged and
  # before the response is consumed. Only then is the process killed, so
  # commit-before-kill is a property of the mechanism, not of the schedule.
  INV_CHILD_B=$(new_invocation_id)
  CHILD_B_PAYLOAD=$(jq -cn --arg u "$UMBRELLA_ID" \
    '{title: "Child B", body: ("Extends " + $u + "."), agentName: "fable-d4",
      references: [$u]}')
  ANNOUNCE_FIFO=$(mktemp -u)
  mkfifo "$ANNOUNCE_FIFO"
  set +e
  # The killed dispatch's timing line (written only if its wrapper survives
  # the kill) goes to a separate file so the baseline's command count is
  # exact rather than ±1 on the kill race.
  CF_CLI_INTEGRATION_TIMINGS_FILE="$D4_TIMINGS.killed" \
  CF_TEST_ANNOUNCE_INVOCATION_PHASES=1 \
    cf piece call $SPACE_ARGS --piece "$TOPIC_PIECE_ID" --invocation "$INV_CHILD_B" \
    createTopic --json "$CHILD_B_PAYLOAD" > /dev/null 2> "$ANNOUNCE_FIFO" &
  CALL_PID=$!
  set -e
  COMMIT_ANNOUNCED=""
  while IFS= read -r line; do
    case "$line" in
      *"invocation: $INV_CHILD_B phase: committed"*)
        COMMIT_ANNOUNCED="yes"
        break
        ;;
    esac
  done < "$ANNOUNCE_FIFO"
  kill_process_tree "$CALL_PID"
  rm -f "$ANNOUNCE_FIFO"
  if [ -z "$COMMIT_ANNOUNCED" ]; then
    error "The dropped call must reach its committed phase before the kill; the phase announcement never arrived"
  fi

  # The kill landed only after the durable commit, so the create MUST be
  # visible — a hard assertion, not a recorded race branch. If the kill ever
  # lands pre-commit, the scenario fails here.
  TOPICS_AFTER_KILL=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" topics 2>/dev/null | jq 'length')
  if [ "$TOPICS_AFTER_KILL" != "3" ]; then
    error "The dropped create committed before the kill, so three topics must exist, got: $TOPICS_AFTER_KILL"
  fi

  set +e
  CHILD_B_JSON=$(cf piece call $SPACE_ARGS --piece "$TOPIC_PIECE_ID" \
    --invocation "$INV_CHILD_B" createTopic --json "$CHILD_B_PAYLOAD" 2>/dev/null)
  CHILD_B_STATUS=$?
  set -e
  if [ "$CHILD_B_STATUS" -ne 0 ]; then
    error "Retrying the dropped create under the same id should exit 0, got $CHILD_B_STATUS"
  fi
  # The commit provably preceded the kill, so the retry MUST settle as the
  # ORIGINAL handling — every run. The mechanism is arm-specific: OFF, the
  # retry collides on the create-only receipt and says so (`deduplicated`);
  # ON, no receipt precondition exists (events.md §4's subsumption) — the
  # duplicate is skipped at the dedupe horizon, and the retry's readback
  # resolves the SAME cause-derived receipt the SERVING side wrote for the
  # original handling (the ruled result carriage, 2026-08-29). The
  # original-result readback below is the witness in both arms.
  if server_execution_on; then
    if echo "$CHILD_B_JSON" | jq -e '.deduplicated == true' > /dev/null; then
      error "No receipt precondition exists under server execution, so the retry cannot claim receipt-level dedup, got: $CHILD_B_JSON"
    fi
  else
    echo "$CHILD_B_JSON" | jq -e '.deduplicated == true' > /dev/null ||
      error "The dropped create had committed, so its retry must deduplicate, got: $CHILD_B_JSON"
  fi
  # The retry's Invocation JSON carries the settled handling's result — the
  # readback the caller acts on after losing a response.
  CHILD_B_ID=$(echo "$CHILD_B_JSON" | jq -re '.result.topic.id') ||
    error "The dropped create's retry should read the result back, got: $CHILD_B_JSON"
  CHILD_B_PATH=$(echo "$CHILD_B_JSON" | jq -re '.result.topic.path')

  # --- 4. The settled id replayed with a DIFFERENT payload. -----------------
  # The assertion D3 left open (its verbs were void): the collision on the
  # create-only receipt must hand back the ORIGINAL handling's result — not
  # silence, and not anything derived from the imposter payload.
  IMPOSTER_PAYLOAD='{"title":"Child B imposter","body":"Must not exist.","agentName":"impostor"}'
  set +e
  REPLAY_JSON=$(cf piece call $SPACE_ARGS --piece "$TOPIC_PIECE_ID" \
    --invocation "$INV_CHILD_B" createTopic --json "$IMPOSTER_PAYLOAD" 2>/dev/null)
  REPLAY_STATUS=$?
  set -e
  if [ "$REPLAY_STATUS" -ne 0 ]; then
    error "A same-id replay should exit 0, got $REPLAY_STATUS"
  fi
  # Same arm split as step 3: the `deduplicated` key is the OFF arm's
  # receipt-precondition witness. The D3 semantic itself — the replay hands
  # back the ORIGINAL result, nothing derived from the imposter payload —
  # is the assert_json_eq below, and it holds in BOTH arms (ON: the
  # readback address derives from the invocation id, so the replay reads
  # the original handling's serving-side receipt).
  if server_execution_on; then
    if echo "$REPLAY_JSON" | jq -e '.deduplicated == true' > /dev/null; then
      error "No receipt precondition exists under server execution, so the replay cannot claim receipt-level dedup, got: $REPLAY_JSON"
    fi
  else
    echo "$REPLAY_JSON" | jq -e '.deduplicated == true' > /dev/null ||
      error "A same-id replay should deduplicate, got: $REPLAY_JSON"
  fi
  assert_json_eq \
    "$(echo "$REPLAY_JSON" | jq '.result')" \
    "$(echo "$CHILD_B_JSON" | jq '.result')" \
    "The replay must read the ORIGINAL result back, got: $REPLAY_JSON (original: $CHILD_B_JSON)"

  # --- 5. Revise the umbrella to reference both children. -------------------
  INV_REVISE=$(new_invocation_id)
  REVISE_PAYLOAD=$(jq -cn --arg u "$UMBRELLA_ID" --arg a "$CHILD_A_ID" --arg b "$CHILD_B_ID" \
    '{id: $u, body: ("Umbrella over " + $a + " and " + $b + "."),
      agentName: "fable-d4-editor", references: [$a, $b]}')
  REVISE_JSON=$(cf piece call $SPACE_ARGS --piece "$TOPIC_PIECE_ID" \
    --invocation "$INV_REVISE" reviseBody --json "$REVISE_PAYLOAD" 2>/dev/null)
  echo "$REVISE_JSON" | jq -e --arg id "$UMBRELLA_ID" --arg path "$UMBRELLA_PATH" \
    '.status == "settled" and .result.topic.id == $id and .result.topic.path == $path' > /dev/null ||
    error "reviseBody should return the umbrella's own reference, got: $REVISE_JSON"

  # --- 6. Exactly three topics; references, reciprocals, attribution. -------
  # One step so the derived views (topicCount, referencedBy) recompute from
  # the committed writes: acknowledgment is transaction-local (D2), so the
  # calls above deliberately never waited for derived recomputation.
  cf piece step $SPACE_ARGS --piece "$TOPIC_PIECE_ID"

  COUNT=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" topicCount)
  if [ "$COUNT" != "3" ]; then
    error "Exactly three topics should exist, got topicCount: $COUNT"
  fi
  TOPICS_LEN=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" topics | jq 'length')
  if [ "$TOPICS_LEN" != "3" ]; then
    error "Exactly three topics should exist, got topics length: $TOPICS_LEN"
  fi

  # Each returned reference opens its canonical child: revised body and both
  # attributions on the umbrella; create-time state and the umbrella edge on
  # each child. Child B must be the dropped create's payload — the imposter
  # payload must not have applied.
  UMBRELLA_FINAL=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" "$UMBRELLA_PATH")
  echo "$UMBRELLA_FINAL" | jq -e \
    --arg id "$UMBRELLA_ID" --arg a "$CHILD_A_ID" --arg b "$CHILD_B_ID" \
    '.id == $id and .createdBy == "fable-d4" and .bodyUpdatedBy == "fable-d4-editor" and
     .body == ("Umbrella over " + $a + " and " + $b + ".") and
     .references == [$a, $b]' > /dev/null ||
    error "The revised umbrella should carry both child references and revision attribution, got: $UMBRELLA_FINAL"
  CHILD_A_FINAL=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" "$CHILD_A_PATH")
  echo "$CHILD_A_FINAL" | jq -e --arg id "$CHILD_A_ID" --arg u "$UMBRELLA_ID" \
    '.id == $id and .title == "Child A" and .createdBy == "fable-d4" and
     .bodyUpdatedBy == "" and .references == [$u]' > /dev/null ||
    error "Child A's returned reference should open the canonical child, got: $CHILD_A_FINAL"
  CHILD_B_FINAL=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" "$CHILD_B_PATH")
  echo "$CHILD_B_FINAL" | jq -e --arg id "$CHILD_B_ID" --arg u "$UMBRELLA_ID" \
    '.id == $id and .title == "Child B" and .createdBy == "fable-d4" and
     .references == [$u]' > /dev/null ||
    error "Child B's returned reference should open the dropped create's canonical child, got: $CHILD_B_FINAL"

  # The reciprocal derived references: children point up at the umbrella, the
  # revised umbrella points down at both children, derived — never persisted.
  RECIPROCAL=$(cf cell get $SPACE_ARGS --piece "$TOPIC_PIECE_ID" referencedBy)
  echo "$RECIPROCAL" | jq -e \
    --arg u "$UMBRELLA_ID" --arg a "$CHILD_A_ID" --arg b "$CHILD_B_ID" \
    '.[$u] == [$a, $b] and .[$a] == [$u] and .[$b] == [$u]' > /dev/null ||
    error "Reciprocal derived references should link umbrella and children both ways, got: $RECIPROCAL"

  # --- Baseline the plan's session-mode decision reads. ---------------------
  echo "[d4-baseline] payload bytes:" \
    "umbrella=$(printf %s "$UMBRELLA_PAYLOAD" | wc -c | tr -d ' ')" \
    "child-a=$(printf %s "$CHILD_A_PAYLOAD" | wc -c | tr -d ' ')" \
    "child-b=$(printf %s "$CHILD_B_PAYLOAD" | wc -c | tr -d ' ')" \
    "revise=$(printf %s "$REVISE_PAYLOAD" | wc -c | tr -d ' ')"
  echo "[d4-baseline] cf commands (excluding the killed dispatch): $(wc -l < "$D4_TIMINGS" | tr -d ' ')"
  sed 's/^/[d4-baseline] /' "$D4_TIMINGS"
  rm -f "$D4_TIMINGS" "$D4_TIMINGS.killed"

  if [ -n "$saved_timings" ]; then
    export CF_CLI_INTEGRATION_TIMINGS="$saved_timings"
  else
    unset CF_CLI_INTEGRATION_TIMINGS
  fi
  if [ -n "$saved_timings_file" ]; then
    export CF_CLI_INTEGRATION_TIMINGS_FILE="$saved_timings_file"
  else
    unset CF_CLI_INTEGRATION_TIMINGS_FILE
  fi
  unset EXPERIMENTAL_PLAIN_RESULT_RECEIPTS

  echo "Successfully ran the three-topic end-to-end fixture for ${API_URL}/${SPACE}/${TOPIC_PIECE_ID}."
}

# The verb-result walkthrough. Delegates to the standalone script rather than
# restating its assertions here: that script is what
# docs/common/verbs/over-the-cli.md tells a reader to run, so the documented
# artifact is the tested one and the two cannot drift. It deploys its own
# fixture and takes its own space.
#
# It is also the regression test for the `--show-links` link walk: its
# address-and-call step annotates a returned piece that owns a verb, which is
# the shape that used to exhaust the stack.
run_verbs_walkthrough() {
  echo "Running the verb-result walkthrough..."
  API_URL="$API_URL" bash "$SCRIPT_DIR/verbs-over-the-cli.sh" ||
    error "The verb-result walkthrough failed."
  echo "Successfully ran the verb-result walkthrough for ${API_URL}."
}

# The gap harness beside the walkthrough: what does NOT work yet, asserted so
# it fails the day a capability arrives — its own header says what and why.
# Running it here is what makes that announcement automatic: a gap script
# nobody runs announces nothing. Same delegation rationale as above; it
# deploys its own fixture and takes its own space.
run_verb_session_gaps() {
  echo "Running the verb-session gap harness..."
  API_URL="$API_URL" bash "$SCRIPT_DIR/verb-session-gaps.sh" ||
    error "The verb-session gap harness failed."
  echo "Successfully ran the verb-session gap harness for ${API_URL}."
}

# The completion chain against a live fabric. Same delegation rationale as the
# two above; it deploys its own fixture and takes its own space.
#
# It is the only thing that drives a completion provider against real state,
# and it reaches every provider that reads any — the fabric, the local stores,
# or the environment. Its own header draws the boundary exactly:
# the unit tests cover the pure half, and a provider that reaches a fabric and
# returns the WRONG set looks exactly like one that returned nothing, because
# completion swallows every error on purpose. It also carries `gap` assertions
# for slots that deliberately answer nothing today, which fail the day one
# starts answering.
run_completion_walkthrough() {
  echo "Running the completion walkthrough..."
  API_URL="$API_URL" bash "$SCRIPT_DIR/completion-over-the-cli.sh" ||
    error "The completion walkthrough failed."
  echo "Successfully ran the completion walkthrough for ${API_URL}."
}

# The Topics content-safety drill: export a space's authored content, clobber a
# topic the way a bad migration would, restore it, and prove the restore
# byte-exact. docs/history/plans/topics-migration-rehearsal.md makes it part of every
# clean rehearsal pass, and a restore mechanism nobody exercises is not a
# mechanism — so it runs here rather than only by hand.
#
# Same delegation rationale as the two above: it deploys its own board into its
# own fresh space. Unlike them it exercises the REAL topics pattern on purpose,
# because its subject is content safety for that pattern; a topics change that
# breaks export or restore SHOULD break this.
#
# It reads the serving toolshed's store, since a snapshot is `sqlite3 VACUUM
# INTO` on the store file rather than an API call. Which store that is, the
# drill establishes for itself — the store its own deploy writes into — so
# nothing is passed here beyond the address.
run_topics_restore_drill() {
  echo "Running the topics restore drill..."
  API_URL="$API_URL" bash "$SCRIPT_DIR/topics-restore-drill.sh" ||
    error "The topics restore drill failed."
  echo "Successfully ran the topics restore drill for ${API_URL}."
}

# The bulk-survey drill touches no store at all: the survey is API-only, so
# unlike the topics restore drill it reads nothing off disk.
run_bulk_survey_drill() {
  echo "Running the bulk-survey drill..."
  API_URL="$API_URL" bash "$SCRIPT_DIR/bulk-survey-drill.sh" ||
    error "The bulk-survey drill failed."
  echo "Successfully ran the bulk-survey drill for ${API_URL}."
}

# The interactive shell against a real fabric, on a real terminal. Same
# delegation rationale as the walkthroughs above; it deploys its own fixture
# and takes its own space.
#
# It is the only thing anywhere that runs `cf sh`. The shell's unit suite
# drives every module with nothing behind it — no server, no piece, and no
# terminal — so what no case there can see is the composition: whether a place
# the fabric holds is the one a `cd` adopted, and whether the reference a
# listing printed is the one the next line takes. It needs a pseudo-terminal
# because the shell refuses to start without one, and python3 is what allocates
# it, which this suite already depends on for its own timing helper.
run_shuttle_walkthrough() {
  echo "Running the shuttle walkthrough..."
  API_URL="$API_URL" bash "$SCRIPT_DIR/shuttle-over-a-terminal.sh" ||
    error "The shuttle walkthrough failed."
  echo "Successfully ran the shuttle walkthrough for ${API_URL}."
}

run_wish() {
  setup_space

  echo "Testing cf wish (blessed headless read)..."

  # A fresh identity has no profile yet: `cf wish '#profile'` must resolve
  # through the wish builtin's headless path, surface the zero-profile WishError,
  # print it to stderr and exit non-zero.
  WISH_ERR_FILE=$(mktemp)
  set +e
  WISH_OUT=$(cf wish '#profile' --api-url="$API_URL" --identity="$IDENTITY" 2>"$WISH_ERR_FILE")
  WISH_CODE=$?
  set -e
  if [ "$WISH_CODE" == "0" ]; then
    error "cf wish '#profile' with no profile should exit non-zero, got 0 (stdout: $WISH_OUT)"
  fi
  grep -q "No profile exists yet" "$WISH_ERR_FILE" ||
    error "cf wish '#profile' with no profile should mention the missing profile on stderr"

  # --allow-empty turns the same empty read into 'null' on stdout with exit 0.
  WISH_EMPTY=$(cf wish '#profile' --allow-empty --api-url="$API_URL" --identity="$IDENTITY")
  if [ "$WISH_EMPTY" != "null" ]; then
    error "cf wish '#profile' --allow-empty should print 'null', got: $WISH_EMPTY"
  fi

  echo "Successfully ran CLI wish integration tests for ${API_URL}."
}

run_piece_data_files() {
  setup_space

  local data_pattern="$SCRIPT_DIR/pattern/data-reader.tsx"
  local data_file="$SCRIPT_DIR/pattern/data/cities.json"
  local data_dir="$WORK_DIR/datafiles"
  mkdir -p "$data_dir"

  # Deploy with the data file attached. The pattern reads it while it runs, so
  # a successful read is what puts the bytes in the result cell below.
  DATA_PIECE_ID=$(cf piece new $SPACE_ARGS \
    --root "$SCRIPT_DIR/pattern" \
    --datafile "$data_file" \
    "$data_pattern")
  echo "Created data-file piece: $DATA_PIECE_ID"

  CITIES=$(cf cell get $SPACE_ARGS --piece $DATA_PIECE_ID cities)
  assert_json_eq "$CITIES" '["Oslo", "Lima"]' \
    "Pattern should read the attached data file, got: $CITIES"

  # The bytes reaching the runtime must be the authored bytes, not a reserialized
  # form. The fixture's spacing is deliberately not what a formatter would
  # produce, so a re-serialization anywhere in the path shows up here.
  RAW=$(cf cell get $SPACE_ARGS --piece $DATA_PIECE_ID raw)
  EXPECTED_RAW=$(jq -Rs . < "$data_file")
  assert_json_eq "$RAW" "$EXPECTED_RAW" \
    "Attached data file should reach the pattern verbatim, got: $RAW"

  # The data file comes back with the source package.
  cf piece getsrc $SPACE_ARGS --piece $DATA_PIECE_ID "$data_dir"
  if [ ! -f "$data_dir/data/cities.json" ]; then
    error "Data file was not retrieved with the source from $DATA_PIECE_ID"
  fi
  if ! diff -u "$data_file" "$data_dir/data/cities.json" > /dev/null; then
    error "Retrieved data file does not match the deployed bytes"
  fi

  # Redeploy from the recovered checkout, which `getsrc` laid out with the same
  # relative paths the piece was built from. A data-only edit is a complete new
  # source revision, so the pattern must read the new bytes — that is what shows
  # the runtime is not serving a stale copy.
  printf '{"cities":["Oslo","Lima","Accra"]}\n' > "$data_dir/data/cities.json"
  cf piece setsrc $SPACE_ARGS --piece $DATA_PIECE_ID \
    --root "$data_dir" \
    --datafile "$data_dir/data/cities.json" \
    "$data_dir/data-reader.tsx"
  cf piece step $SPACE_ARGS --piece $DATA_PIECE_ID

  UPDATED=$(cf cell get $SPACE_ARGS --piece $DATA_PIECE_ID cities)
  assert_json_eq "$UPDATED" '["Oslo", "Lima", "Accra"]' \
    "Pattern should read the updated data file, got: $UPDATED"

  # A data file the source does not read by name cannot be worked out from a
  # recovered checkout: it is written to disk like any other file, with nothing
  # recording that it was data. `getsrc` has to say so, or the next `setsrc`
  # drops it from the revision without a word.
  local extra_dir="$WORK_DIR/datafiles-extra"
  mkdir -p "$extra_dir"
  printf 'not read by the pattern\n' > "$SCRIPT_DIR/pattern/data/notes.txt"
  EXTRA_PIECE_ID=$(cf piece new $SPACE_ARGS \
    --root "$SCRIPT_DIR/pattern" \
    --datafile "$SCRIPT_DIR/pattern/data/notes.txt" \
    "$data_pattern")
  cf piece getsrc $SPACE_ARGS --piece $EXTRA_PIECE_ID "$extra_dir" \
    >"$WORK_DIR/getsrc-extra.out"
  rm -f "$SCRIPT_DIR/pattern/data/notes.txt"
  if [ ! -f "$extra_dir/data/notes.txt" ]; then
    error "An unread data file should still come back with the source."
  fi
  # The pattern reads cities.json by name, so that one is re-derived and must
  # not be listed; notes.txt is the one a later setsrc cannot recover.
  if ! grep -q -- "--datafile ./data/notes.txt" "$WORK_DIR/getsrc-extra.out"; then
    error "getsrc did not name the data file its source cannot re-derive."
  fi
  if grep -q -- "--datafile ./data/cities.json" "$WORK_DIR/getsrc-extra.out"; then
    error "getsrc named a data file the recovered source reads by name."
  fi

  echo "Successfully ran CLI data-file integration tests for ${API_URL}."
}

# Each step records as its own test, named "integration.sh <step>"; the begin
# markers close the previous step's record and the exit trap closes the last
# one, so a failing step is recorded with the failure.
#
# `all` runs every step, and every step also runs under one of the sections CI
# dispatches: piece-values, piece-call, and piece-links. Both hold in
# packages/cli/test/integration-sections.test.ts, which reads this table and
# the cli-integration-test matrix in .github/workflows/deno.yml.
#
# Two kinds of arm live here. A **step arm** runs exactly one step, and
# every step has one, so any step can be run and scheduled on its own. A
# **group arm** runs several, for a person running the script by hand and
# for the continuous-integration legs. Where a group arm and a step arm
# would share a name, the step arm takes an `-only` suffix.
case "$SECTION" in
  all)
    cf_test_step_begin piece-values
    run_piece_values
    cf_test_step_begin piece-data-files
    run_piece_data_files
    cf_test_step_begin piece-links
    run_piece_links
    cf_test_step_begin piece-call
    run_piece_call
    cf_test_step_begin piece-call-retry
    run_piece_call_retry
    cf_test_step_begin three-topic-fixture
    run_three_topic_fixture
    cf_test_step_begin verbs-walkthrough
    run_verbs_walkthrough
    cf_test_step_begin verb-session-gaps
    run_verb_session_gaps
    cf_test_step_begin completion-walkthrough
    run_completion_walkthrough
    cf_test_step_begin topics-restore-drill
    run_topics_restore_drill
    cf_test_step_begin bulk-survey-drill
    run_bulk_survey_drill
    cf_test_step_begin shuttle-walkthrough
    run_shuttle_walkthrough
    cf_test_step_begin wish
    run_wish
    ;;
  piece-basics)
    cf_test_step_begin piece-values
    run_piece_values
    cf_test_step_begin piece-links
    run_piece_links
    ;;
  piece-values)
    cf_test_step_begin piece-values
    run_piece_values
    cf_test_step_begin piece-data-files
    run_piece_data_files
    ;;
  piece-values-only)
    cf_test_step_begin piece-values
    run_piece_values
    ;;
  piece-data-files)
    cf_test_step_begin piece-data-files
    run_piece_data_files
    ;;
  piece-links)
    cf_test_step_begin piece-links
    run_piece_links
    cf_test_step_begin wish
    run_wish
    ;;
  piece-links-only)
    cf_test_step_begin piece-links
    run_piece_links
    ;;
  piece-call)
    cf_test_step_begin piece-call
    run_piece_call
    cf_test_step_begin piece-call-retry
    run_piece_call_retry
    cf_test_step_begin three-topic-fixture
    run_three_topic_fixture
    cf_test_step_begin verbs-walkthrough
    run_verbs_walkthrough
    cf_test_step_begin verb-session-gaps
    run_verb_session_gaps
    cf_test_step_begin completion-walkthrough
    run_completion_walkthrough
    cf_test_step_begin topics-restore-drill
    run_topics_restore_drill
    cf_test_step_begin bulk-survey-drill
    run_bulk_survey_drill
    cf_test_step_begin shuttle-walkthrough
    run_shuttle_walkthrough
    ;;
  piece-call-only)
    cf_test_step_begin piece-call
    run_piece_call
    ;;
  piece-call-retry)
    cf_test_step_begin piece-call-retry
    run_piece_call_retry
    ;;
  three-topic)
    cf_test_step_begin three-topic-fixture
    run_three_topic_fixture
    ;;
  wish)
    cf_test_step_begin wish
    run_wish
    ;;
  verbs)
    cf_test_step_begin verbs-walkthrough
    run_verbs_walkthrough
    ;;
  verb-gaps)
    cf_test_step_begin verb-session-gaps
    run_verb_session_gaps
    ;;
  completion)
    cf_test_step_begin completion-walkthrough
    run_completion_walkthrough
    ;;
  topics-drill)
    cf_test_step_begin topics-restore-drill
    run_topics_restore_drill
    ;;
  bulk-survey-drill)
    cf_test_step_begin bulk-survey-drill
    run_bulk_survey_drill
    ;;
  shuttle)
    cf_test_step_begin shuttle-walkthrough
    run_shuttle_walkthrough
    ;;
  *)
    error "Unknown CLI integration section: $SECTION"
    ;;
esac
