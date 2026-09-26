#!/usr/bin/env bash
# The verb-result walkthrough: deploy a pattern, introspect its verbs, call
# them, and read what they return.
#
# Documented in docs/common/verbs/over-the-cli.md, which explains the model
# this exercises. Keep the two in step: the doc is the explanation, this is the
# proof, and each names the other.
#
# It deploys pattern/verb-results.tsx and nothing else. That fixture belongs to
# this walkthrough alone, so a change to a pattern the product actually ships
# can never break a demonstration of how the CLI verb surface works.
#
# Every step names the property it asserts, so a failure says which one broke
# rather than just exiting nonzero. A fresh space per run, no prior state.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/verbs-over-the-cli.sh
#
# Against a host that needs a particular key:
#   API_URL=https://<host> CF_IDENTITY=~/.config/commonfabric/identity.key \
#     packages/cli/integration/verbs-over-the-cli.sh
#
# CI runs it through integration.sh's `verbs` section, which the test
# topology's `cli-core` suite makes a unit of. The `piece-call` section runs it
# too, among the other steps a person running that group by hand gets.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/verb-results.tsx"

# Prefer a built binary when the harness supplies one; fall back to source.
if [ -n "${CF_BINARY:-}" ]; then
  CF="$CF_BINARY"
else
  CF="deno task --quiet --cwd $REPO_ROOT cf"
fi

PASS=0
FAIL=0
step() { printf '\n== %s\n' "$1"; }
ok() { printf '  PASS %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() {
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected [$1], got [$2])"; fi
}

SPACE="${SPACE:-$(mktemp -u verbsXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"

# The host's server-execution posture (same probe as integration.sh): a few
# steps assert arm-specific mechanics — the OFF arm's receipt-precondition
# `deduplicated` key, the client-env plainResultReceipts authority, and what
# a same-id retry of a THROWN handling does — and each says which truth it
# is asserting. Deadlines as in integration.sh: an accepted-then-silent
# server must not hold the walkthrough with no output.
server_execution_on() {
  case "${EXPERIMENTAL_SERVER_EXECUTION:-}" in
    true) return 0 ;;
    false) return 1 ;;
  esac
  curl --connect-timeout 5 --max-time 15 -fsS "$API_URL/api/health/stats" \
    2>/dev/null | jq -e '.servingLoop != null' > /dev/null 2>&1
}
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

# One session for the whole walkthrough, the way an agent run carries one: an
# invocation id names an outcome within the session it was chosen in, so the
# replay in step 7 has to be made from the session its original call was.
export CF_INVOCATION_SESSION=$($CF invocation-session new)

# A plain-JSON result rides the plainResultReceipts option, on by default.
# Set it explicitly anyway so the walkthrough asserts the same thing whatever a
# host's environment carries; step 8 sets it false to show the difference
# against a result carrying a piece, which survives either way.
export EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=true

START=$(date +%s)

step "1. Deploy the fixture"
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
BOARD=$($CF piece new --quiet "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi

step "2. Ask what it can do"
VERBS=$($CF piece verbs --piece "$BOARD" $ARGS --json 2>/dev/null)
echo "$VERBS" | jq -r '.verbs[]? | "    " + .name' 2>/dev/null | head -10
echo "$VERBS" | jq -e '[.verbs[]?.name] | index("createNote")' >/dev/null 2>&1 &&
  ok "createNote is listed" || bad "createNote missing from the verb listing"
# A declared result rides the listing, so a caller learns the shape of what it
# will get back WITHOUT calling — the half of verb discovery that makes a call
# something you can prepare for rather than discover by trying.
check "note" "$(echo "$VERBS" | jq -r '.verbs[] |
  select(.name == "createNote") | .outputSchema.properties | keys | join(",")' \
  2>/dev/null)" "createNote advertises the result it declared"
check "label,revision" "$(echo "$VERBS" | jq -r '.verbs[] |
  select(.name == "setLabel") | .outputSchema.properties | keys | join(",")' \
  2>/dev/null)" "setLabel advertises every field of its declared result"
# The value-less shape says so by carrying no result at all, rather than an
# empty one a caller would have to interpret.
check "false" "$(echo "$VERBS" | jq -r '.verbs[] |
  select(.name == "touch") | has("outputSchema")' 2>/dev/null)" \
  "a value-less verb advertises no result"

# The same declaration reaches the page a caller reads before calling ONE verb,
# where the listing answers for the whole piece. It names where the value
# arrives — the Invocation JSON's result — because that is what a handler's
# caller collects rather than stdout.
HELP=$($CF piece call --piece "$BOARD" $ARGS createNote --help 2>/dev/null)
check "1" "$(printf '%s\n' "$HELP" | grep -c '^Output:')" \
  "createNote's help page carries an Output section"
check "1" "$(printf '%s\n' "$HELP" | grep -c '^    note ')" \
  "createNote's help page enumerates the result field it declared"
# And a value-less verb's page carries no Output section at all, the same
# distinction the listing draws.
VOID_HELP=$($CF piece call --piece "$BOARD" $ARGS touch --help 2>/dev/null)
check "0" "$(printf '%s\n' "$VOID_HELP" | grep -c '^Output:')" \
  "a value-less verb's help page carries no Output section"

step "3. A create hands back the piece it created"
R=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation create-1 \
  createNote '{"title":"First note","body":"written at create"}' 2>/dev/null)
check "settled" "$(echo "$R" | jq -r '.status')" "createNote settled"
check "First note" "$(echo "$R" | jq -r '.result.note["$NAME"] // empty')" \
  "the result carries the created note piece"
check "written at create" "$(echo "$R" | jq -r '.result.note.body // empty')" \
  "the returned piece carries the body it was created with"

step "4. A verb returns what it wrote, including what only it could compute"
L=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation label-1 \
  setLabel '{"label":"  Field notes  "}' 2>/dev/null)
check "Field notes" "$(echo "$L" | jq -r '.result.label // empty')" \
  "setLabel returns the label AS PERSISTED, trimmed by the pattern"
check "1" "$(echo "$L" | jq -r '.result.revision // empty')" \
  "and the revision it produced, which the caller could not compute"

step "5. Address the piece you were handed, and call it"
# --show-links annotates the Invocation JSON with the document behind each
# path, which is what turns a returned piece from a value into an address.
LINKED=$($CF piece call --quiet --show-links --piece "$BOARD" $ARGS \
  --invocation create-linked \
  createNote '{"title":"Addressable note","body":"first line"}' 2>/dev/null)
# The entry is one canonical reference string and is used verbatim, of: scheme
# included — --piece takes that form, so an emitted address composes into the
# next command unchanged.
NOTE_ID=$(echo "$LINKED" | jq -r '.links["/note"] // empty')
if [ -n "$NOTE_ID" ]; then ok "the result names the note's document: $NOTE_ID"; else
  bad "no link for /note in the annotated result"
fi
A=$($CF piece call --quiet --piece "$NOTE_ID" $ARGS --invocation append-1 \
  append '{"text":"second line"}' 2>/dev/null)
check "first line
second line" "$(echo "$A" | jq -r '.result.body // empty')" \
  "calling a verb ON the returned piece works, and returns what it wrote"

step "6. Read an address instead of what is behind it"
# A read follows a link onward unless the selection says where to stop, so a
# created note arrives as a copy of its contents with no address in it. A
# "$link" marker at a position asks for that position's address instead.
ADDR=$($CF cell get --quiet --piece "$BOARD" $ARGS notes \
  --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null)
check "true" "$(echo "$ADDR" | jq -c '[.[] | has("$link")] | all')" \
  "every element carries an address"
check "false" "$(echo "$ADDR" | jq -c '[.[] | has("title")] | any')" \
  "and none of them carries the note's contents"
check "true" "$(echo "$ADDR" | jq -c \
  '[.[] | .["$link"] | type == "string" and startswith("/of:")] | all')" \
  "the address is one canonical reference string — no inlined schema"
# A marker beside a projection asks for both, because both were asked for.
BOTH=$($CF cell get --quiet --piece "$BOARD" $ARGS notes --schema \
  '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "true" "$(echo "$BOTH" | jq -c \
  '[.[] | has("$link") and (.title | length > 0)] | all')" \
  "a marker beside a projection returns the address AND the fields"
# The point of an address: act on the child, rather than read a copy of it.
FIRST=$(echo "$BOTH" | jq -r \
  '.[] | select(.title == "First note") | .["$link"]')
if [ -n "$FIRST" ]; then ok "the read names the first note: $FIRST"; else
  bad "no address for the first note in the projected read"
fi
B=$($CF piece call --quiet --piece "$FIRST" $ARGS --invocation append-read \
  append '{"text":"appended through the read"}' 2>/dev/null)
check "written at create
appended through the read" "$(echo "$B" | jq -r '.result.body // empty')" \
  "the address a read returned is one a caller can call"
# A field list spells the same marker with a trailing @, so one read asks for
# an address at one position and projects at another. The list is element-wise
# across an array, so the marked collection answers with one address per note.
# noteCount is computed, so --step brings it up to date the way step 7 does.
AT=$($CF cell get --quiet --piece "$BOARD" $ARGS --step \
  --select 'notes@,noteCount' 2>/dev/null)
check "true" "$(echo "$AT" | jq -c \
  '(.notes | length > 0) and ([.notes[] | has("$link")] | all)')" \
  "a trailing @ on an array returns an address per element"
check "true" "$(echo "$AT" | jq -c '.noteCount >= 1')" \
  "and a sibling path projects beside it in the one result"
# The bare suffix names the position the read is already at.
ROOT=$($CF cell get --quiet --piece "$BOARD" $ARGS --select '@' 2>/dev/null)
check "true" "$(echo "$ROOT" | jq -c 'has("$link")')" \
  "a bare @ returns the read source's own address"

step "7. A replayed invocation id returns the ORIGINAL result — in its session"
# Captured rather than hard-coded: the property is that the replay changes
# nothing, which stays true however many notes earlier steps created.
BEFORE=$($CF cell get --quiet --piece "$BOARD" $ARGS noteCount --step \
  2>/dev/null)
D=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation create-1 \
  createNote '{"title":"IMPOSTER"}' 2>/dev/null)
check "First note" "$(echo "$D" | jq -r '.result.note["$NAME"] // empty')" \
  "the replay returns the first result, not the imposter's"
if server_execution_on; then
  # ON: no receipt precondition exists (events.md §4 subsumption) — the
  # replay is skipped at the dedupe horizon and reads the ORIGINAL result
  # back from the serving-side receipt (the ruled result carriage,
  # 2026-08-29); the two checks around this one are the witness. The
  # OFF-arm mechanism key must NOT be fabricated.
  check "false" "$(echo "$D" | jq -r '.deduplicated // false')" \
    "the replay does not claim receipt-level dedup under server execution"
else
  check "true" "$(echo "$D" | jq -r '.deduplicated // false')" \
    "the call reports itself deduplicated"
fi
check "$BEFORE" "$($CF cell get --quiet --piece "$BOARD" $ARGS noteCount --step 2>/dev/null)" \
  "the replay created no note (count unchanged at $BEFORE)"

# The same word, from another caller. `create-1` is this session's name for
# its first create, and nothing stops a second agent picking it: that agent is
# calling for itself, and must get its own call rather than a report that
# someone else's had settled.
OTHER=$(CF_INVOCATION_SESSION=$($CF invocation-session new) $CF piece call \
  --quiet --piece "$BOARD" \
  $ARGS --invocation create-1 \
  createNote '{"title":"Another agent"}' 2>/dev/null)
check "Another agent" "$(echo "$OTHER" | jq -r '.result.note["$NAME"] // empty')" \
  "the same id in ANOTHER session executes and returns its own result"
check "false" "$(echo "$OTHER" | jq -r '.deduplicated // false')" \
  "and does not report itself deduplicated"
check "$((BEFORE + 1))" \
  "$($CF cell get --quiet --piece "$BOARD" $ARGS noteCount --step \
    2>/dev/null)" \
  "and created its note, so the write really happened"

step "8. A piece result survives the option being off; a plain record does not"
P=$(EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false $CF piece call --quiet \
  --piece "$BOARD" $ARGS --invocation create-flagoff \
  createNote '{"title":"Flag-off note"}' 2>/dev/null)
check "Flag-off note" "$(echo "$P" | jq -r '.result.note["$NAME"] // empty')" \
  "the piece result arrives with plainResultReceipts OFF"
Q=$(EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false $CF piece call --quiet \
  --piece "$BOARD" $ARGS --invocation label-flagoff \
  setLabel '{"label":"Written anyway"}' 2>/dev/null)
if server_execution_on; then
  # ON: the deployed client ADOPTS the server's plainResultReceipts
  # (runtime-presets.ts, authority "server" — "a client on the other value
  # reads back a receipt shaped by a rule it does not share"), and the
  # SERVING side wrote the receipt under the server's posture — so the
  # client env cannot turn the plain record off; it arrives regardless.
  check "Written anyway" "$(echo "$Q" | jq -r '.result.label // "null"')" \
    "the plain record arrives despite the client env: the posture authority is the server's"
else
  check "null" "$(echo "$Q" | jq -r '.result // "null"')" \
    "the plain record is absent with the option OFF"
fi
check "Written anyway" \
  "$($CF cell get --quiet --piece "$BOARD" $ARGS label --input 2>/dev/null | jq -r '.')" \
  "but the write landed regardless — an absent result is not a failed mutation"

step "9. A value-less verb settles with no result"
V=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation touch-1 \
  touch '{}' 2>/dev/null)
check "settled" "$(echo "$V" | jq -r '.status')" "the value-less verb settled"
check "{}" "$(echo "$V" | jq -c '.result // {}')" "its result is the empty witness"

step "10. A thrown call and its invocation id"
$CF piece call --quiet --piece "$BOARD" $ARGS --invocation reuse-1 \
  createNote '{"title":""}' >/dev/null 2>&1
rc=$?
check "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)" "an empty title exits nonzero"
COUNT_AFTER_THROW=$($CF cell get --quiet --piece "$BOARD" $ARGS noteCount --step 2>/dev/null)
C=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation reuse-1 \
  createNote '{"title":"Corrected"}' 2>/dev/null)
if server_execution_on; then
  # ON: the throw happened SERVER-side and "the error IS the consequence"
  # (events.md §5) — the errored handling durably CONSUMED the id, so a
  # same-id retry never re-executes. Its mechanical shape is a race the
  # spec allows either way: admission refuses the duplicate while the
  # errored entry is still above the horizon, or admits it and the
  # processing skip passes it (settled, no result — no receipt exists
  # for an errored handling). Both agree on the semantic asserted here:
  # nothing runs, nothing is created. The caller's correct move after an
  # error is a FRESH id — asserted below. This is a real OFF→ON contract
  # delta, recorded in the flip register (verification-coverage.md FLIP
  # block).
  check "" "$(echo "$C" | jq -r '.result.note["$NAME"] // empty')" \
    "the same-id retry does not execute: the errored handling consumed the id"
  check "$COUNT_AFTER_THROW" \
    "$($CF cell get --quiet --piece "$BOARD" $ARGS noteCount --step 2>/dev/null)" \
    "no note was created by the same-id retry"
  FRESH=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation reuse-1-fresh \
    createNote '{"title":"Corrected"}' 2>/dev/null)
  check "Corrected" "$(echo "$FRESH" | jq -r '.result.note["$NAME"] // empty')" \
    "a FRESH id executes the corrected call"
else
  check "Corrected" "$(echo "$C" | jq -r '.result.note["$NAME"] // empty')" \
    "the SAME id then executes, because the refusal never consumed it"
fi

step "11. Reading a verb redirects to cf piece call"
OUT=$($CF cell get --piece "$BOARD" $ARGS createNote 2>&1)
rc=$?
check "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)" "a verb read exits nonzero"
echo "$OUT" | grep -qi "cf piece call" &&
  ok "the refusal names cf piece call" ||
  bad "the refusal does not name the right command"

step "12. --verbose times the phases on stderr; stdout stays JSON"
ERR=$(mktemp)
OUT=$($CF piece call --quiet --verbose --piece "$BOARD" $ARGS \
  --invocation timed-1 createNote '{"title":"Timed note"}' 2>"$ERR")
echo "$OUT" | jq -e '.status' >/dev/null 2>&1 &&
  ok "stdout is still Invocation JSON" || bad "stdout was polluted"
grep -qE "[0-9]+ *ms" "$ERR" && ok "per-phase timings on stderr" ||
  bad "no timings on stderr"
sed 's/^/    /' "$ERR" | grep timing | head -5

step "13. An invocation id without a session is refused"
# The id is the replay handle, and a session minted for this one request
# would put that id on a different outcome next time — so the call cannot be
# honored as it was asked, and the refusal says how to ask again.
NO_SESSION=$(env -u CF_INVOCATION_SESSION $CF piece call --quiet \
  --piece "$BOARD" $ARGS \
  --invocation lonely-1 createNote '{"title":"No session"}' 2>&1)
rc=$?
check "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)" "the call exits nonzero"
echo "$NO_SESSION" | grep -q -- "CF_INVOCATION_SESSION" &&
  ok "the refusal names CF_INVOCATION_SESSION" ||
  bad "the refusal does not name CF_INVOCATION_SESSION"
echo "$NO_SESSION" | grep -q "invocation-session new" &&
  ok "and the command that mints one" ||
  bad "the refusal does not say how to mint a session"

step "14. A detached call returns an address that reads back the outcome"
# --no-wait exits at "committed": the handler ran and its write is durable;
# only the readback is skipped. The envelope still carries the receipt, so a
# detached call is a handle rather than a dead end — collecting the outcome
# later is an ordinary read of that address, verbatim: the envelope publishes
# it as one canonical reference string, of: prefix included, and the verb's
# body does not run a second time.
NW=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation detached-1 \
  --no-wait setLabel '{"label":"Detached label"}' 2>/dev/null)
check "committed" "$(echo "$NW" | jq -r '.status')" \
  "--no-wait returns at committed"
RECEIPT_ID=$(echo "$NW" | jq -r '.receipt // empty')
check "/of:" "${RECEIPT_ID:0:4}" \
  "the envelope names the receipt, scheme included"
if [ -n "$RECEIPT_ID" ]; then
  COLLECTED=$($CF cell get --quiet --piece "$RECEIPT_ID" $ARGS 2>/dev/null)
  check "Detached label" "$(echo "$COLLECTED" | jq -r '.label // empty')" \
    "the address reads back the outcome the detached call filed"
else
  bad "no receipt address to collect from"
fi
# And in settled mode the same address reads back exactly what the call
# reported: the receipt names the result, not a copy that can drift from it.
S=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation settled-rcpt-1 \
  setLabel '{"label":"Settled label"}' 2>/dev/null)
S_ID=$(echo "$S" | jq -r '.receipt // empty')
if [ -n "$S_ID" ]; then
  S_READ=$($CF cell get --quiet --piece "$S_ID" $ARGS 2>/dev/null)
  check "$(echo "$S" | jq -cS '.result')" "$(echo "$S_READ" | jq -cS '.')" \
    "a settled call's receipt reads back exactly its result"
else
  bad "no receipt address on the settled envelope"
fi

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed — %ds wall clock\n' "$PASS" "$FAIL" "$ELAPSED"
[ "$FAIL" -eq 0 ]
