#!/usr/bin/env bash
# The gap harness for the verb session: what is true today, including what does
# not work yet. Its companion `verb-session-demo.sh` shows the session as it is
# meant to read; this one is the thing that keeps that honest.
#
# A step may assert a GAP rather than a capability. Such a step fails loudly
# the day its gap closes, so this script is how we find out that a capability
# arrived rather than discovering it months later in a stale document. How
# many are open is tallied as they run and printed on the last line, so no
# prose here can fall out of step with the assertions below.
#
# Documented in docs/common/verbs/session-walkthrough.md.
#
# It deploys pattern/tracker.tsx and nothing else. That fixture belongs to this
# session alone, so a change to a pattern the product ships can never break a
# demonstration of what driving one through `cf` looks like.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/verb-session-gaps.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/tracker.tsx"

if [ -n "${CF_BINARY:-}" ]; then
  CF="$CF_BINARY"
else
  CF="deno task --quiet --cwd $REPO_ROOT cf"
fi

PASS=0
FAIL=0
GAPS=0
step() { printf '\n== %s\n' "$1"; }
ok() { printf '  PASS %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() {
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected [$1], got [$2])"; fi
}
# A gap we expect to be there. When it closes this fails loudly, which is how
# the script tells us the capability arrived rather than quietly passing.
gap() {
  if [ "$1" = "0" ]; then
    bad "GAP CLOSED — $2 now works; update this script and the walkthrough"
  else
    ok "gap still open: $2"
    GAPS=$((GAPS + 1))
  fi
}

if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
if [ -z "${SPACE:-}" ]; then
  # Opening a space never creates it, so the run makes its own; `cf space
  # create` prints the new space's DID.
  SPACE=$($CF space create --quiet --api-url="$API_URL" --identity="$CF_IDENTITY")
  case "$SPACE" in
    did:key:*) ;;
    *) echo "cf space create printed no DID: $SPACE" >&2; exit 1 ;;
  esac
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"

# The host's server-execution posture (same probe as integration.sh): the
# `deduplicated` key is the OFF arm's receipt-precondition witness and is
# asserted per arm below. Deadlines as in integration.sh: an
# accepted-then-silent server must not hold the suite with no output.
server_execution_on() {
  case "${EXPERIMENTAL_SERVER_EXECUTION:-}" in
    true) return 0 ;;
    false) return 1 ;;
  esac
  curl --connect-timeout 5 --max-time 15 -fsS "$API_URL/api/health/stats" \
    2>/dev/null | jq -e '.servingLoop != null' > /dev/null 2>&1
}
# An id alone does not name an invocation — the session it was chosen within is
# the other half, and `--invocation` is refused without one.
if [ -z "${CF_INVOCATION_SESSION:-}" ]; then
  CF_INVOCATION_SESSION=$($CF invocation-session new 2>/dev/null)
fi
export CF_INVOCATION_SESSION
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

START=$(date +%s)

step "1. Arrive by name, not by fid"
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
BOARD=$($CF piece new --quiet --slug board "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi
SLUG_NAME=$($CF cell get --quiet --piece board $ARGS '$NAME' 2>/dev/null | tr -d '"')
check "Work tracker" "$SLUG_NAME" "the slug resolves everywhere --piece is taken"
# The arrival name is discoverable as well as resolvable: the slug index
# lists what the deploy's --slug wrote — the same wiring the demo's act 1
# rides, which a separate set-slug here would quietly stop covering: a
# regression in the deploy's slug path would pass this harness while act 1's
# listing came up empty. set-slug keeps its own coverage in integration.sh.
$CF piece slugs $ARGS --json 2>/dev/null |
  jq -e '[.[].slug] | index("board")' >/dev/null 2>&1 &&
  ok "the slug index lists the arrival name" ||
  bad "the slug index does not list 'board'"

step "2. Ask what it is, and what it can do"
VERBS=$($CF piece verbs --piece board $ARGS --json 2>/dev/null)
echo "$VERBS" | jq -r '.verbs[]? | "    " + .name + "  (" + .kind + ")"' 2>/dev/null
echo "$VERBS" | jq -e '[.verbs[]?.name] | index("addItem")' >/dev/null 2>&1 &&
  ok "addItem is listed" || bad "addItem missing from the listing"
# The other half of a discovery surface, and the half that has no natural
# witness: what it does NOT name. The board's `items` and `$NAME` are data, and
# a listing that offers them hands a client operations that do not exist.
check "addItem" "$(echo "$VERBS" | jq -r '[.verbs[]?.name] | sort | join(",")')" \
  "the listing names the verb and nothing else"
# The man page beside the listing. Its needles are read out of the FIXTURE for
# the reason step 3 states: rewording a doc comment moves the probe with it.
# The purpose needle is the FIRST line of the interface's own comment — the
# one prose level that compiles only at a schema root, which is exactly what
# this page exists to serve. The awk walks back from the declaration to the
# nearest `/**` opener, clearing on any line that is not part of a JSDoc
# block, so the probe survives the comment growing or shrinking — a fixed
# window would fail the harness the day the comment gained a line — and an
# interface that LOST its comment still reads as having none rather than
# inheriting an earlier block's.
DESCRIBE=$($CF piece describe --piece board $ARGS 2>/dev/null)
echo "$DESCRIBE" | grep -q '^NAME    Work tracker$' &&
  ok "the page opens with the piece's display name" ||
  bad "no NAME header on the describe page"
BOARD_DOC=$(awk '
  /^\/\*\*/ { doc = $0; next }
  /^interface BoardOutput \{/ { print doc; exit }
  !/^ \*/ { doc = "" }
' "$FIXTURE" | sed -e 's/^\/\*\* *//' -e 's/ *\*\/ *$//')
if [ -z "$BOARD_DOC" ]; then
  bad "no JSDoc on BoardOutput itself in the fixture — the purpose probe has no needle"
else
  echo "$DESCRIBE" | grep -qF "$BOARD_DOC" &&
    ok "the Output interface's own JSDoc is the page's purpose" ||
    bad "the page carries no purpose paragraph: [$BOARD_DOC]"
fi
ITEMS_DOC=$(sed -n '/^interface BoardOutput {/,/^}/p' "$FIXTURE" |
  grep -B 1 'items:' | sed -n 's/.*\/\*\* *\(.*[^ ]\) *\*\/.*/\1/p' | head -1)
if [ -z "$ITEMS_DOC" ]; then
  bad "no JSDoc on BoardOutput.items in the fixture — the state probe has no needle"
else
  echo "$DESCRIBE" | grep -qF "$ITEMS_DOC" &&
    ok "a state field's JSDoc reaches its STATE row" ||
    bad "the STATE row carries no prose: [$ITEMS_DOC]"
fi
# The machine spelling of the same page, shaped: a purpose, a state array,
# and the verb rows the listing itself serves.
$CF piece describe --piece board $ARGS --json 2>/dev/null |
  jq -e '(.purpose | type == "string") and (.state | type == "array")
    and ([.verbs[]?.name] | index("addItem"))' >/dev/null 2>&1 &&
  ok "the same page is served as JSON" ||
  bad "describe --json is missing purpose, state, or the verb rows"

step "3. Ask what a verb wants — flags and prose, both derived"
HELP=$($CF piece call --piece board $ARGS addItem --help 2>/dev/null)
echo "$HELP" | grep -q -- "--title" &&
  ok "the flag is derived from the event schema" ||
  bad "no --title flag in the generated help"
# The author's prose, at both levels it is written on. Each needle is read out
# of the FIXTURE rather than hard-coded, so rewording a doc comment moves the
# probe with it — a hard-coded string would turn a reworded comment into a
# failure and an unchanged one into a check that passes without reading
# anything.
FIELD_DOC=$(sed -n '/interface AddItemEvent {/,/^}/p' "$FIXTURE" |
  sed -n 's/.*\/\*\* *\(.*[^ ]\) *\*\/.*/\1/p' | head -1)
if [ -z "$FIELD_DOC" ]; then
  bad "no JSDoc on AddItemEvent's field in the fixture — the probe has no needle"
else
  echo "$HELP" | grep -qiF "$FIELD_DOC" &&
    ok "an event field's JSDoc reaches its flag description" ||
    bad "the flag carries no description: [$FIELD_DOC]"
fi
# The third parameter level: a RESULT field's comment, beside its line in the
# Output section. Its needle travels the other route again — the description
# is a ref-site sibling on the declared result's property — and reaches the
# text page with no resolution at all.
RESULT_DOC=$(sed -n '/interface AddItemResult {/,/^}/p' "$FIXTURE" |
  sed -n 's/.*\/\*\* *\(.*[^ ]\) *\*\/.*/\1/p' | head -1)
if [ -z "$RESULT_DOC" ]; then
  bad "no JSDoc on AddItemResult's field in the fixture — the probe has no needle"
else
  echo "$HELP" | grep -qiF "$RESULT_DOC" &&
    ok "a result field's JSDoc reaches its Output line" ||
    bad "the Output line carries no description: [$RESULT_DOC]"
fi
# The verb's own comment, on the line above its `Stream` property. Its needle
# comes from BoardOutput rather than from the event interface, because the two
# travel by different routes — this one is a sibling of the property's `$ref`,
# the one above lives inside the `$defs` target it names — and a probe that
# could not tell them apart would report one arriving as both.
VERB_DOC=$(sed -n '/interface BoardOutput {/,/^}/p' "$FIXTURE" |
  grep -B 1 'addItem:' | sed -n 's/.*\/\*\* *\(.*[^ ]\) *\*\/.*/\1/p' | head -1)
if [ -z "$VERB_DOC" ]; then
  bad "no JSDoc on BoardOutput.addItem in the fixture — the probe has no needle"
else
  echo "$HELP" | grep -qiF "$VERB_DOC" &&
    ok "the verb's own JSDoc reaches its help page" ||
    bad "the help page has no summary line: [$VERB_DOC]"
  # And the same words on the discovery surface, where a client reads them.
  echo "$VERBS" | jq -e --arg d "$VERB_DOC" \
    '[.verbs[]? | select(.name=="addItem") | .description] | index($d)' \
    >/dev/null 2>&1 &&
    ok "the verb's own JSDoc reaches its listing row" ||
    bad "the listing row carries no description: [$VERB_DOC]"
  # And beneath the row a person scans: the text table prints the same
  # sentence under the verb's grid line.
  $CF piece verbs --piece board $ARGS 2>/dev/null | grep -qF "$VERB_DOC" &&
    ok "the same words ride beneath the text table's row" ||
    bad "the text listing shows names only: [$VERB_DOC]"
fi
# The third prose level — an event INTERFACE's own comment — is not probed
# here, and deliberately. It never compiles, so the honest assertion is that it
# is absent from the page; but `AddItemEvent`'s comment and `addItem`'s are the
# same sentence in this fixture, and the verb's does arrive. A containment probe
# would read one level's success as the other's and report a gap closed that is
# wide open. It is recorded in the walkthrough's table instead, against #5559.

step "4. A create hands back the piece, and the address chains"
R=$($CF piece call --quiet --show-links --piece board $ARGS \
  addItem '{"title":"Login rewrite"}' 2>/dev/null)
check "Login rewrite" "$(echo "$R" | jq -r '.result.item["$NAME"] // empty')" \
  "the result carries the created item"
EPIC=$(echo "$R" | jq -r '.links["/item"] // empty')
if [ -n "$EPIC" ]; then ok "the result names its document: $EPIC"; else
  bad "no link for /item"
fi
# The receiver axis: call the verb ON the thing you were just handed, once in
# each spelling — --piece, and the address standing positional the way the
# demo teaches, with every flag ahead of it. The children count below proves
# the writes landed; each call's exit code is checked too, because the
# readback runs after the write commits — a readback failure leaves the count
# intact, and only the exit code shows it.
$CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"Session cookies"}' >/dev/null 2>&1 ||
  bad "addChild (Session cookies) exited nonzero"
$CF piece call --quiet $ARGS "$EPIC" \
  addChild '{"title":"CSRF tokens"}' >/dev/null 2>&1 ||
  bad "addChild (CSRF tokens, positional address) exited nonzero"
KIDS=$($CF cell get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "2" "$(echo "$KIDS" | jq -r 'length')" \
  "both children landed under the address the create returned"
# Step 2's assertion one level down: an address alone discovers a surface, and
# the surface it discovers is the item's own rather than the board's. Three
# places say so in prose — the demo narrates it, and the walkthrough claims it
# twice — and none of them could go stale without this failing first.
ITEM_VERBS=$($CF piece verbs --piece "$EPIC" $ARGS --json 2>/dev/null)
check "addChild,archive,blockOn,finish,recordNote" \
  "$(echo "$ITEM_VERBS" | jq -r '[.verbs[]?.name] | sort | join(",")')" \
  "an item lists its own verbs, and not the board's"

step "5. Read addresses instead of contents"
ADDR=$($CF cell get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "true" "$(echo "$ADDR" | jq -c '[.[] | has("$link") and (.title|length>0)] | all')" \
  "a marker beside a projection returns the address AND the fields"
KID=$(echo "$ADDR" | jq -r '.[] | select(.title=="Session cookies") | .["$link"]')
# The very same read, run a second time. A (source cell, schema) pair is
# reusable: it answers with what it answered before, which is what a caller
# reaching for one projection twice depends on. Asserted by equality against
# the first read rather than against a shape, because the property is that
# nothing about the answer moved. The check above is what gives it force —
# were the first read already empty, two empty reads would agree and this
# would pass saying nothing.
AGAIN=$($CF cell get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "$ADDR" "$AGAIN" "the same read, run again, answers the same"

step "6. Two routes hand back an address, and either one addresses the piece"
# MEASURED, and not what you would guess: the address a call hands back
# (--show-links) and the address a read projects ($link) are DIFFERENT entity
# ids for the same piece — one resolves the link chain, the other renders the
# link as stored. That is the read model working rather than a defect: an
# address is many-to-one over cells, so a holder of one cannot tell a canonical
# id from an alias and is never asked to. The property is stated in
# docs/plans/shaped-reads-and-verb-results.md; #5632 asks whether the two ids
# should agree and item 11 of docs/plans/verbs-implementation.md rules that
# they are aliases. So their difference is asserted nowhere here: no day exists
# on which it "closes", and a gap that can never fire is a gap that reports
# nothing. What a caller does depend on is asserted instead — either address,
# fed back to --piece, reads the same piece.
MADE=$($CF piece call --quiet --show-links --piece board $ARGS \
  addItem '{"title":"Rate limiting"}' 2>/dev/null |
  jq -r '.links["/item"] // empty')
VIA_READ=$($CF cell get --quiet --piece board items $ARGS --step \
  --schema '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null | jq -r '.[] | select(.title=="Rate limiting") | .["$link"]')
if [ -z "$MADE" ] || [ -z "$VIA_READ" ]; then
  bad "one of the two routes produced no address (call=$MADE read=$VIA_READ)"
else
  # Both must work as --piece. That is the property a caller depends on.
  M_T=$($CF cell get --quiet --piece "$MADE" title $ARGS 2>/dev/null | tr -d '"')
  R_T=$($CF cell get --quiet --piece "$VIA_READ" title $ARGS 2>/dev/null | tr -d '"')
  check "Rate limiting" "$M_T" "the address the call returned addresses the piece"
  check "Rate limiting" "$R_T" "the address the read returned addresses the piece too"
  # The same address, standing bare in the first position with the path
  # embedded — the spelling the demo teaches from act 4 on. An address begins
  # with `/` and a relative path never does, so nothing marks it but itself.
  P_T=$($CF cell get --quiet "$VIA_READ/title" $ARGS 2>/dev/null | tr -d '"')
  check "Rate limiting" "$P_T" "the address stands positional, carrying its path"
fi

step "7. A verb returns what only the pattern could compute"
N=$($CF piece call --quiet --piece "$EPIC" $ARGS \
  recordNote '{"body":"blocked on the cookie spec"}' 2>/dev/null)
check "1" "$(echo "$N" | jq -r '.result.noteCount // empty')" \
  "recordNote returns the count after the append"
AT=$(echo "$N" | jq -r '.result.note.at // 0')
[ "$AT" -gt 0 ] && ok "and a timestamp the caller never supplied ($AT)" ||
  bad "no pattern-stamped time on the note"
# Both recovery routes are asserted against the LIVE piece, not against what
# the envelope reports. A receipt is a frozen snapshot of the outcome its
# handling committed, and a replay is defined to hand that same snapshot back —
# so an envelope shows the original count and body whether or not a second
# append actually landed. Only reading the item's own `notes` afterwards can
# tell those apart, which makes the live length the discriminator for both.
notes_len() { $CF cell get --quiet --piece "$EPIC" $ARGS notes 2>/dev/null | jq 'length'; }
LIVE0=$(notes_len)
RCPT=$(echo "$N" | jq -r '.receipt // empty')
if [ -z "$RCPT" ]; then
  bad "the settled envelope named no receipt to read back"
else
  RB=$($CF cell get --quiet --piece "$RCPT" $ARGS --select note,noteCount 2>/dev/null)
  check "blocked on the cookie spec" "$(echo "$RB" | jq -r '.note.body // empty')" \
    "the receipt address holds the outcome that handling committed"
  check "1" "$(echo "$RB" | jq -r '.noteCount // empty')" \
    "and reading it hands that outcome back without calling anything again"
  check "$LIVE0" "$(notes_len)" \
    "and the piece is untouched by the read — no note was appended"
fi

# The other route: no address kept, so the id is the handle. The replay carries
# a DIFFERENT payload on purpose, so a returned body of the FIRST text is
# evidence the second call's event never became an outcome.
R1=$($CF piece call --quiet --piece "$EPIC" $ARGS --invocation note-retry \
  recordNote '{"body":"first attempt"}' 2>/dev/null)
LIVE1=$(notes_len)
R2=$($CF piece call --quiet --piece "$EPIC" $ARGS --invocation note-retry \
  recordNote '{"body":"a different body entirely"}' 2>/dev/null)
check "first attempt" "$(echo "$R2" | jq -r '.result.note.body // empty')" \
  "replaying a settled id hands back the original result, not the new payload"
check "$(echo "$R1" | jq -r '.receipt // empty')" "$(echo "$R2" | jq -r '.receipt // empty')" \
  "and names the same receipt the first call did"
if server_execution_on; then
  # ON: no receipt precondition exists (events.md §4 subsumption) — the
  # replay is skipped at the dedupe horizon and the two checks above (the
  # ORIGINAL result and the SAME receipt address, read back from the
  # serving-side receipt — the ruled result carriage, 2026-08-29) are the
  # witness; the OFF-arm mechanism key must not be fabricated.
  check "false" "$(echo "$R2" | jq -r '.deduplicated // false')" \
    "and does not claim receipt-level dedup under server execution"
else
  check "true" "$(echo "$R2" | jq -r '.deduplicated // false')" \
    "and says so itself, rather than leaving a caller to infer it"
fi
check "$LIVE1" "$(notes_len)" \
  "and the piece is unchanged — the replay committed no second note"

step "8. Finishing reports what the caller could not know"
# Exit code checked for the same reason as step 4's creates.
$CF piece call --quiet --piece "$KID" $ARGS \
  addChild '{"title":"Rotate signing key"}' >/dev/null 2>&1 ||
  bad "addChild (Rotate signing key) exited nonzero"
# Unshaped: a PROJECTED read of this path fails once `finish` has run, while
# the same path unshaped resolves fine. Counting is all this step needs.
DIRECT=$($CF cell get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
F=$($CF piece call --quiet --piece "$EPIC" $ARGS \
  finish '{"body":"shipping behind a flag"}' 2>/dev/null)
OPEN=$(echo "$F" | jq -r '.result.openBelow // empty')
# Captured rather than hard-coded: the property is that it counted deeper than
# one level, which holds however many items earlier steps created.
if [ -n "$OPEN" ] && [ -n "$DIRECT" ] && [ "$OPEN" -gt "$DIRECT" ]; then
  ok "openBelow ($OPEN) exceeds the $DIRECT direct children — it recursed"
else
  bad "openBelow did not walk past the direct children (open=$OPEN direct=$DIRECT)"
fi

step "9. A value-less verb settles with the empty witness"
V=$($CF piece call --quiet --piece "$KID" $ARGS archive '{}' 2>/dev/null)
check "settled" "$(echo "$V" | jq -r '.status')" "archive settled"
check "{}" "$(echo "$V" | jq -c '.result // {}')" "its result is the empty witness"

step "10. A reference argument dispatches — the envelope, the address as emitted, and the object a read renders it in"
# blockOn declares `on: Writable<ItemOutput>` — a reference. #5880 landed the
# ENVELOPE spelling: a link envelope in that position passes the gate and the
# edge that comes back is the target, not a copy. The round-trip spelling
# docs/plans/references-as-arguments.md held out for — the address exactly as
# a read emits it — landed with the dispatch gate reading the declared
# contract (docs/history/plans/verb-input-contract.md), and the same contract is what
# refuses the two payloads that could only ever be mistakes at a reference
# position. Every spelling is asserted apart, so none can hide behind
# another.
OTHER=$($CF cell get --quiet --piece board items $ARGS \
  --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
  jq -r '.[0]["$link"] // empty')
if [ -z "$OTHER" ] || [ -z "${KID:-}" ]; then
  bad "no address to probe blockOn with (item=$OTHER target=${KID:-})"
else
  # The envelope: assembled from the very address the read above emitted, so
  # the target is one the session was handed.
  SIGIL="{\"on\":{\"/\":{\"link@1\":{\"id\":\"${OTHER#/}\"}}}}"
  BLOCKED=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn "$SIGIL" 2>/dev/null)
  check "1" "$(echo "$BLOCKED" | jq -r '.result.blockedOnCount // empty')" \
    "a link envelope names an existing item, and the edge lands"
  # And the edge is the target rather than a copy: the address under
  # blockedOn is the address the envelope named.
  EDGE=$($CF cell get --quiet --piece "$KID" blockedOn $ARGS \
    --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
    jq -r '.[0]["$link"] // empty')
  check "$OTHER" "$EDGE" "the edge reads back as the address that was named"
  # The emitted spelling: the same address, fed back exactly as printed.
  BLOCKED2=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn "{\"on\":\"$OTHER\"}" 2>/dev/null)
  check "2" "$(echo "$BLOCKED2" | jq -r '.result.blockedOnCount // empty')" \
    "the address a read emits, fed back as written, dispatches"
  EDGE2=$($CF cell get --quiet --piece "$KID" blockedOn $ARGS \
    --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
    jq -r '.[1]["$link"] // empty')
  check "$OTHER" "$EDGE2" "and its edge is the target, not a copy"
  # The rendered spelling: the same address inside the `{"$link": …}` object
  # a marked read prints it in, fed back as that object.
  BLOCKED3=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn "{\"on\":{\"\$link\":\"$OTHER\"}}" 2>/dev/null)
  check "3" "$(echo "$BLOCKED3" | jq -r '.result.blockedOnCount // empty')" \
    "the \$link object a marked read renders, fed back as printed, dispatches"
  EDGE3=$($CF cell get --quiet --piece "$KID" blockedOn $ARGS \
    --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
    jq -r '.[2]["$link"] // empty')
  check "$OTHER" "$EDGE3" "and its edge is the target, not a copy"
  # The same object with the contents the read projected beside the address,
  # which is what a `--select @,title` row looks like. The address is what the
  # position takes; the title beside it is not the target's, so a stored copy
  # would read differently from the edge.
  BLOCKED4=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn "{\"on\":{\"\$link\":\"$OTHER\",\"title\":\"a projected copy\"}}" 2>/dev/null)
  check "4" "$(echo "$BLOCKED4" | jq -r '.result.blockedOnCount // empty')" \
    "the \$link object with projected contents beside it dispatches as the address"
  EDGE4=$($CF cell get --quiet --piece "$KID" blockedOn $ARGS \
    --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
    jq -r '.[3]["$link"] // empty')
  check "$OTHER" "$EDGE4" "and its edge is the target, not the copy beside the address"
  # The refusals guarding the same position, each matched against its
  # SPECIFIC message: a renamed verb or a server hiccup also exits nonzero,
  # and a probe that reads any failure as the refusal is a probe that cannot
  # fail.
  NOT_ERR=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn '{"on":"not-an-address"}' 2>&1 >/dev/null)
  NOT_RC=$?
  if [ "$NOT_RC" != "0" ] && printf '%s' "$NOT_ERR" | grep -q "is not an address"; then
    ok "a string that is no address is refused naming the reference position"
  else
    bad "the not-an-address refusal did not fire (rc=$NOT_RC): $NOT_ERR"
  fi
  COPY_ERR=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn '{"on":{"title":"a copy"}}' 2>&1 >/dev/null)
  COPY_RC=$?
  if [ "$COPY_RC" != "0" ] && printf '%s' "$COPY_ERR" | grep -q "detached document"; then
    ok "an inline copy is refused as a detached document"
  else
    bad "the detached-copy refusal did not fire (rc=$COPY_RC): $COPY_ERR"
  fi
fi

step "11. a verb returning a child piece renders the circle as an address"
# The returned item carries `parent`, which points back at its container. The
# readback bounds the result with the verb's own declared result and renders
# the position where the declared type re-enters itself as an address, so the
# whole outcome is JSON and the write it reports stays legible.
BEFORE=$($CF cell get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
CALLED=$($CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"Cycle probe"}' 2>/dev/null)
RC=$?
check "0" "$RC" "addChild readback on a doubly-linked tree"
BACKREF=$(printf '%s' "$CALLED" | jq -r '.result.item.parent["$link"] // ""')
check "/of:" "${BACKREF:0:4}" \
  "the position that closes the circle returns an address"
AFTER=$($CF cell get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
check "$((BEFORE + 1))" "$AFTER" "the write the result describes landed"

step "12. the registry does not list what a handler created"
# The claim the agent's entry is built on: `cf piece ls` reads the piece
# registry, and nothing registers a piece on the author's behalf. The board was
# registered when it was deployed; the item its `addItem` handler created was
# not, because the handler never sent it to `addPiece`. Both facts have to hold
# at once for the document to be right — an unlisted piece that also could not
# be read would mean something else entirely.
LS=$($CF piece ls $ARGS --json 2>/dev/null)
check "Work tracker" \
  "$(echo "$LS" | jq -r '[.[]? | select(.name == "Work tracker") | .name] | join(",")')" \
  "the deployed board is registered, so the listing does find it"
check "" \
  "$(echo "$LS" | jq -r '[.[]? | select(.name == "Login rewrite") | .name] | join(",")')" \
  "the item the board's handler created is absent from the registry"
# Absence from the listing is not absence of the piece: the same item answers
# on its own address. That is what makes an empty `ls` uninformative rather
# than conclusive, and it is the inference the document exists to block.
check "Login rewrite" \
  "$($CF cell get --quiet --piece "$EPIC" title $ARGS 2>/dev/null | jq -r '. // empty')" \
  "the unlisted item still reads through the address the create returned"

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
