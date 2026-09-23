#!/usr/bin/env bash
# The completion chain against a live fabric: deploy a piece, then assert what
# a Tab offers at each slot of space -> piece -> verb -> verb fields -> cell
# path -> result shape.
#
# Every provider that reads state is exercised here: the four that reach a
# fabric (pieces, callables, cell paths, link endpoints), the one that reads
# local memory-v2 stores (--space, and the `space` positionals sharing it), the
# one that reads the environment (--api-url), and the pattern-file glob.
#
# What is NOT exercised entry by entry is the rest of the provider table: a
# dozen slots that hand the shell a constant `files` or `dirs` directive and
# nothing else — --datafile, `view <file>`, `exec <mountedFile>`,
# `id did <keypath>`, the space-management directories, and the two entries
# item 16 of the plan records as belonging to commands that declare no options
# at all. They read no state, so a fabric cannot change what they answer, and
# they are asserted one by one — kind and glob — in
# packages/cli/test/completion-providers.serial.test.ts, which is where a
# constant belongs. Nothing here re-checks them, and `deno task
# check-completion-slots` is what catches a slot with no entry at all.
#
# The exception is an option name that means two things on two commands —
# --from, --to, --root, --scope. There the answer turns on which command was
# typed rather than on the name, so both sides of each are asserted below,
# through the real command line rather than through a resolved slot.
#
# The unit tests under packages/cli/test/completion-*.test.ts cover the pure
# half — line resolution, candidate shaping, and the degrade-to-empty path —
# and by construction cannot see a provider that reaches a fabric and comes
# back with the wrong set. Completion swallows every error on purpose, so a
# provider that throws and a provider that has nothing to say are one
# experience at the prompt: silence. This script is what tells them apart.
#
# Two rules follow from that silence, and both are held to below. A slot is
# judged only after the equivalent `cf` command has been run against the same
# target, so an empty candidate list is read as a defect rather than as an
# unreachable fabric. And a candidate is judged by whether the command accepts
# it, not by whether something came back.
#
# It drives `cf completion complete` directly, which is the one command the
# installed shell function calls. The shell functions themselves are a separate
# surface and are not exercised here.
#
# A step may assert a GAP rather than a capability, the way
# `verb-session-gaps.sh` does: such a step fails loudly the day its gap closes,
# so a slot that starts answering announces itself instead of aging into a
# stale plan. How many are open is tallied as they run and printed on the last
# line, so no prose here can fall out of step with the assertions below.
#
# Documented in docs/plans/cli-completion-coverage.md, whose item 18 this is.
#
# It deploys pattern/completion-target.tsx and nothing else. That fixture
# belongs to this walkthrough alone, so a change to a pattern the product ships
# can never break a demonstration of what a Tab offers.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/completion-over-the-cli.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/completion-target.tsx"

# Prefer a built binary when the harness supplies one; fall back to source.
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
# Run the completion command, keeping its exit status apart from its output.
#
# A provider that answers nothing and a CLI that could not run both print
# nothing, so a probe reading output alone reports a dead instrument as
# evidence: with a `cf` that only exits nonzero, every gap below still read as
# "gap still open". The status is what tells the two apart, and it is kept in a
# variable rather than returned because the callers below read the output
# through command substitution, which would run this in a subshell and lose it.
PROBE_OUT=""
PROBE_STATUS=0
probe() {
  PROBE_OUT=$($CF completion complete --shell bash --line "$1" \
    --point "${#1}" 2>/dev/null)
  PROBE_STATUS=$?
}

# The same discipline for the auxiliary commands this script branches on.
#
# `probe` keeps the completion command honest; every OTHER command whose empty
# output decides a branch needs it too, or the branch reads a broken CLI as a
# fact about the fabric. That is the same defect twice in one file, so it is
# the shape that is fixed rather than the instance.
RUN_OUT=""
RUN_STATUS=0
run() {
  RUN_OUT=$("$@" 2>/dev/null)
  RUN_STATUS=$?
}

# A gap we expect to be there, named by the line that probes it. When it closes
# this fails loudly, which is how the script tells us the slot started
# answering rather than quietly passing — and when the command itself fails,
# that is a third outcome rather than a gap.
gap() {
  probe "$1"
  if [ "$PROBE_STATUS" -ne 0 ]; then
    bad "completion exited $PROBE_STATUS probing $2 — no gap can be read from that"
  elif [ -n "$(printf '%s\n' "$PROBE_OUT" | grep -v '^:cf:')" ]; then
    bad "GAP CLOSED — $2 now completes; update this script and the plan"
  else
    ok "gap still open: $2"
    GAPS=$((GAPS + 1))
  fi
}
# "1" when the command exits zero, "0" when it does not. What a slot offers is
# judged against what the command accepts, so the command is run rather than
# reasoned about.
succeeds() {
  if "$@" >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
}

SPACE="${SPACE:-$(mktemp -u compXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"
# The same three, written the way a caller types them on the line being
# completed. Every provider resolves its fabric from the half-typed line first,
# so a probe that carried them only in the environment would prove nothing
# about the precedence the providers actually apply.
CONN_ARGS="--api-url $API_URL --identity $CF_IDENTITY"
LINE_ARGS="$CONN_ARGS --space $SPACE"
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

# A handler call needs a session its invocation ids are chosen within.
export CF_INVOCATION_SESSION=$($CF invocation-session new 2>/dev/null)

# What the shell would be offered for a line whose cursor sits at its end.
# Directives (`:cf:…` lines) are dropped; `directives_at` is what reads those.
complete_at() {
  $CF completion complete --shell bash --line "$1" --point "${#1}" 2>/dev/null |
    grep -v '^:cf:'
}
# The same, sorted and joined, so a candidate set compares as one string.
candidates_at() {
  complete_at "$1" | LC_ALL=C sort | paste -sd, -
}
directives_at() {
  $CF completion complete --shell bash --line "$1" --point "${#1}" 2>/dev/null |
    grep '^:cf:' | paste -sd, -
}
# zsh pairs each candidate with the annotation the shell renders beside it,
# which is the only spelling that shows what a candidate is annotated WITH.
# A colon inside a value is escaped in that format — every piece id carries
# one — so the key is escaped the same way before it is matched.
annotation_at() {
  local key="${2//:/\\:}:"
  local line
  while IFS= read -r line; do
    case "$line" in
      "$key"*) printf '%s\n' "${line#"$key"}" ;;
    esac
  done < <($CF completion complete --shell zsh --line "$1" \
    --point "${#1}" 2>/dev/null)
}

START=$(date +%s)

step "1. The completion command answers, and the fixture deploys"
# Every probe below reads an empty candidate list as a fact about a slot, and
# that reading holds only while the command itself runs. A static completion
# needs no fabric and no identity, so nothing but a broken CLI can empty it —
# which makes this the one place the instrument is checked rather than assumed.
probe "cf piece "
check "0" "$PROBE_STATUS" "cf completion complete exits zero"
check "1" "$(printf '%s\n' "$PROBE_OUT" | grep -c '^verbs$')" \
  "and a static slot answers, so an empty one below is about the slot"

# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
BOARD=$($CF piece new --quiet --slug board "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi
# The child is what a path crossing a link boundary crosses into, and what the
# shadowed-name step calls. --show-links names the document behind /item, which
# is the address form --piece takes back in.
ADDED=$($CF piece call --quiet --show-links --piece board $ARGS \
  --invocation add-1 \
  addItem '{"title":"First item"}' 2>/dev/null)
ITEM=$(echo "$ADDED" | jq -r '.links["/item"] // empty')
ITEM_ID=${ITEM#/of:}
if [ -n "$ITEM" ]; then ok "added a child item: $ITEM"; else
  bad "addItem returned no address for the item it created"
  exit 1
fi
# The space DID, read off a stored link rather than assumed: a space NAME
# derives its DID one way, so nothing on the line carries it. The canonical
# reference's space-qualified spelling needs it.
SPACE_DID=$($CF cell get --quiet --piece board $ARGS items 2>/dev/null |
  jq -r '.[0].record["/"]["link@1"].space // empty')
if [ -n "$SPACE_DID" ]; then ok "the space resolves to $SPACE_DID"; else
  bad "no space DID on the child's stored link"
fi

step "2. The piece slot offers values the same command can then read"
# The chain's second link. A value that completes but which the dispatcher
# cannot reach would be worse than no candidate: it teaches a caller a target
# that does not exist. Every one offered is read back here rather than assumed.
PIECE_SLOT=$(complete_at "cf piece call $LINE_ARGS --piece ")
check "board,$BOARD" "$(candidates_at "cf piece call $LINE_ARGS --piece ")" \
  "the piece slot offers the deployed board by slug and by id"
READABLE=0
UNREADABLE=0
while IFS= read -r target; do
  [ -z "$target" ] && continue
  if [ "$(succeeds $CF cell get --quiet --piece "$target" $ARGS '$NAME')" \
    = "1" ]
  then
    READABLE=$((READABLE + 1))
  else
    UNREADABLE=$((UNREADABLE + 1))
  fi
done <<EOF
$PIECE_SLOT
EOF
check "0" "$UNREADABLE" "every completed --piece value reads back ($READABLE checked)"
# The annotation column is what makes an opaque id legible, and what keeps a
# slug from being read as one.
check "Completion fixture" \
  "$(annotation_at "cf piece call $LINE_ARGS --piece " "$BOARD")" \
  "the id is annotated with the piece's name"
check "slug for Completion fixture" \
  "$(annotation_at "cf piece call $LINE_ARGS --piece " board)" \
  "and the slug says what it is and what it points at"

step "3. The slug reaches its own positional too"
check "board" "$(candidates_at "cf piece set-slug $LINE_ARGS ")" \
  "piece set-slug completes the slugs it can re-point"
# A slug's source is a cell, not a piece: the name a collection gets is the
# path inside the board that holds it, so the source slot spans a piece and
# the keys under it, the way a link endpoint does.
check ":cf:nospace" "$(directives_at "cf piece set-slug $LINE_ARGS name ")" \
  "its source holds the cursor for the separator a path continues with"
check "1" "$(complete_at "cf piece set-slug $LINE_ARGS name ${BOARD%??????????}" |
  grep -c "^$BOARD\$")" "the source offers a piece before the separator"
check "1" "$(complete_at "cf piece set-slug $LINE_ARGS name $BOARD/rev" |
  grep -c "^$BOARD/revision\$")" "and that piece's keys after it"

step "4. Both spellings of an option complete the same values"
# `--piece=<TAB>` and `--piece <TAB>` are one slot. The inline spelling is the
# one `tokenizeLine` exists to serve, and its candidates carry the `--piece=`
# back so the shell replaces the whole token.
check "board,$BOARD" "$(candidates_at "cf piece call $LINE_ARGS --piece ")" \
  "the spaced spelling completes"
check "--piece=board,--piece=$BOARD" \
  "$(candidates_at "cf piece call $LINE_ARGS --piece=")" \
  "the inline spelling completes the same values, prefix attached"
# The directive half of the same slot reaches the shell either way.
check ":cf:files *.key" "$(directives_at "cf piece call $LINE_ARGS --identity ")" \
  "the spaced --identity spelling emits its files directive"
check ":cf:files *.key" "$(directives_at "cf piece call $LINE_ARGS --identity=")" \
  "and so does the inline one"

step "5. Every documented way to name a target reaches the same slots"
CANONICAL="/of:$BOARD"
QUALIFIED="/@$SPACE_DID/of:$BOARD"
VERBS="addItem,legacyAdd,noteAll,renameItem,sweep"
check "Completion fixture" \
  "$($CF cell get --quiet --piece "$CANONICAL" $ARGS '$NAME' 2>/dev/null | tr -d '"')" \
  "the canonical reference is a --piece value the command accepts"
check "$VERBS" "$(candidates_at "cf piece call $LINE_ARGS --piece $CANONICAL ")" \
  "and the verb slot behind it offers the same verbs"

check "Completion fixture" \
  "$($CF cell get --quiet --piece "$QUALIFIED" $ARGS '$NAME' 2>/dev/null | tr -d '"')" \
  "its space-qualified spelling is accepted too"
check "$VERBS" "$(candidates_at "cf piece call $LINE_ARGS --piece $QUALIFIED ")" \
  "and completes the same"
# The embedded space is enough on its own: the DID is in the reference, so a
# line that names no --space still resolves one.
check "$VERBS" "$(candidates_at \
  "cf piece call --api-url $API_URL --identity $CF_IDENTITY --piece $QUALIFIED ")" \
  "and supplies the space when the line names none"

check "Completion fixture" \
  "$($CF cell get --quiet $ARGS "$CANONICAL" '$NAME' 2>/dev/null | tr -d '"')" \
  "a positional canonical address is a target the command accepts"
check "$VERBS" "$(candidates_at "cf piece call $LINE_ARGS $CANONICAL ")" \
  "and the callable after it completes, index shifted the way the command shifts it"

check "1" \
  "$(succeeds $CF cell get --quiet --piece "$CANONICAL#argument" $ARGS)" \
  "the #argument suffix is a --piece value the command accepts"
ARGUMENT_KEYS=$(candidates_at "cf cell get $LINE_ARGS --piece $CANONICAL#argument ")
check "$ARGUMENT_KEYS" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece board --input ")" \
  "and completes the arguments cell, the same keys --input does"
check "1" "$(printf '%s' "$ARGUMENT_KEYS" | grep -c 'settings')" \
  "which is a key the arguments cell actually holds"

# The suffix rides the bare slug the same way, because the slug names the
# piece the reference names.
check "1" "$(succeeds $CF cell get --quiet --piece "board#argument" $ARGS)" \
  "the suffix on a bare slug is a --piece value the command accepts too"
check "$ARGUMENT_KEYS" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece board#argument ")" \
  "and completes the same arguments-cell keys behind it"

# A path embedded in the reference is where the walk starts, the way
# `mergePiecePath` puts it in front of the positional path.
check "density,theme" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece $CANONICAL/settings ")" \
  "an embedded path is what the cell-path slot completes below"

step "6. The verb slot"
check "addItem,legacyAdd,noteAll,renameItem,sweep" \
  "$(candidates_at "cf piece call $LINE_ARGS --piece board ")" \
  "every callable the piece exposes is offered"
# The default listing holds back the deprecated row and says how many it held.
check "addItem,noteAll,renameItem,sweep" \
  "$($CF piece verbs --piece board $ARGS --json 2>/dev/null |
    jq -r '[.verbs[] | select(.deprecated != true and .tier != "wrapper") |
      .name] | sort | join(",")')" \
  "the verbs listing shows four of them"
# Both surfaces are offered the deprecated verb, and completion says so: it is
# callable, so hiding it would put a working name out of reach, and offering it
# unmarked is the two surfaces disagreeing silently.
check "[deprecated] handler" \
  "$(annotation_at "cf piece call $LINE_ARGS --piece board " legacyAdd)" \
  "the verb the listing held back is offered marked"
check "1" "$(succeeds $CF piece call --quiet --piece board $ARGS \
  --invocation legacy-1 legacyAdd '{"title":"Legacy item"}')" \
  "and it is callable, which is why it is offered at all"
# The annotation column carries what the author said the verb is FOR, which is
# the sentence its help page opens with.
ADD_PROSE=$($CF piece verbs --piece board $ARGS --json 2>/dev/null |
  jq -r '.verbs[] | select(.name == "addItem") | .description')
check "Add one item to the board, and report the new total." "$ADD_PROSE" \
  "the listing carries addItem's prose"
check "$ADD_PROSE" \
  "$(annotation_at "cf piece call $LINE_ARGS --piece board " addItem)" \
  "and the candidate is annotated with the same sentence"

step "7. Past the callable name, cf's own flags are not offered"
# `cf piece call` is stopEarly(), so the first positional ends option parsing and
# every later word belongs to the callable's schema-derived parser. A flag the
# command refuses there is a candidate that teaches a caller something false.
check "0" "$(succeeds $CF piece call --quiet --piece board $ARGS addItem \
  --invocation late)" "the command refuses a cf flag after the callable name"
check "" "$(complete_at "cf piece call $LINE_ARGS --piece board addItem --")" \
  "and nothing is offered there"
# Before the callable name the same flag is accepted and offered.
check "1" "$(complete_at "cf piece call $LINE_ARGS --piece board --" |
  grep -c '^--invocation$')" \
  "--invocation is still offered before the callable name"

step "8. The verb's own fields do not complete yet"
# The position where a caller has least to go on: these names are the pattern
# author's vocabulary, not the CLI's. `shapeVerbFlagCandidates` derives them
# from the listing's `inputSchema` — the same enumeration the help page below
# renders, so a flag the parser accepts cannot be named by one and not the
# other. Only the wiring is left: the fields stand directly after the verb
# name, which is the `tail` positional no provider dispatches on yet.
check "pinned,title" "$($CF piece verbs --piece board $ARGS --json 2>/dev/null |
  jq -r '.verbs[] | select(.name == "addItem") | .inputSchema.properties |
    keys | sort | join(",")')" \
  "addItem declares the fields its flags are named for"
HELP=$($CF piece call --piece board $ARGS addItem --help 2>/dev/null)
check "1" "$(printf '%s\n' "$HELP" | grep -c -- '^  --title <string>')" \
  "and its help page names the flag each one is written as"
check "1" "$(printf '%s\n' "$HELP" | grep -c -- '^  --pinned | --no-pinned')" \
  "including both spellings of a boolean field"
check "1" "$(succeeds $CF piece call --quiet --piece board $ARGS \
  --invocation flags-1 \
  addItem --title 'Flagged item')" "and the parser accepts them as flags"
gap "cf piece call $LINE_ARGS --piece board addItem --" \
  "a verb's fields inside the section the verb opens"

step "9. A cell path completes one segment at a time"
check ":cf:nospace" "$(directives_at "cf cell get $LINE_ARGS --piece board ")" \
  "the cursor is held for the next separator"
check "1" "$(complete_at "cf cell get $LINE_ARGS --piece board " |
  grep -c '^settings$')" "a root key is offered"
check "settings/density,settings/theme" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece board settings/")" \
  "a nested object offers its keys, each carrying the path already typed"
check "cozy" "$($CF cell get --quiet --piece board $ARGS settings/density \
  2>/dev/null | tr -d '"')" "and the completed path is one cf cell get reads"

step "10. A cell path follows a \$link boundary rather than stopping at it"
# `items/0` is a link to another document. The path walk reads through it, so
# the child's own keys are what the slot offers.
check "1" "$(complete_at "cf cell get $LINE_ARGS --piece board items/0/" |
  grep -c '^items/0/label$')" \
  "the keys past the boundary are the child's own"
check "First item" "$($CF cell get --quiet --piece board $ARGS items/0/label \
  2>/dev/null | tr -d '"')" \
  "and the path crossing the boundary is one cf cell get reads"
# The same slot also offers names cf cell get refuses: a callable is not a value,
# and reading one is redirected to cf piece call.
check "0" "$(succeeds $CF cell get --quiet --piece board $ARGS addItem)" \
  "reading a callable's name is refused"
check "1" "$(complete_at "cf cell get $LINE_ARGS --piece board " |
  grep -c '^addItem$')" \
  "and the cell-path slot offers it anyway"

step "11. Result field paths complete in the projection's own grammar"
# --step because the board carries a computed value and a projection reads
# through the whole result: the same reason the verb walkthrough steps before
# it projects.
check "dark" "$($CF cell get --quiet --piece board $ARGS --step \
  --select settings.theme 2>/dev/null | jq -r '.settings.theme')" \
  "a --select field path is a projection the command reads"
# Both spellings of a position, plus the bare suffix naming the read's own
# address. The list splits on `,` and a path on `.` — not the `/` a cell path
# walks — so a candidate carries back everything already typed.
check "1" "$(complete_at "cf cell get $LINE_ARGS --piece board --select " |
  grep -cx '@')" "a bare @ names the read source's own address"
check "settings.density,settings.density@,settings.theme,settings.theme@" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece board --select settings.")" \
  "a nested position offers its value and its address spellings"
check "revision,settings,revision,settings@" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece board --select revision,set")" \
  "a second element carries the first one back with it"
# An array is projected element-wise, so a segment below one names a field of
# each element. An index there is refused by the command.
check "1" "$(complete_at "cf cell get $LINE_ARGS --piece board --select items." |
  grep -cx 'items.label')" "a position below an array offers the element's fields"
check "0" "$(succeeds $CF cell get --quiet --piece board $ARGS --step \
  --select items.0.label)" "and an index in that position is refused"
# `--schema` reads the same field list, and reads two other things that are
# recognized by their first character.
check "1" "$(complete_at "cf cell get $LINE_ARGS --piece board --schema set" |
  grep -cx 'settings')" "--schema completes the same field list"
check "" "$(complete_at "cf cell get $LINE_ARGS --piece board --schema @")" \
  "and offers no field path where the word names a schema file"
# The projection is relative to the path the line already names, the same way
# the read is.
check "@,density,density@,theme,theme@" \
  "$(candidates_at "cf cell get $LINE_ARGS --piece board settings --select ")" \
  "a path positional moves the projection's own root with it"
check "dark" "$($CF cell get --quiet --piece board $ARGS settings \
  --select theme \
  2>/dev/null | jq -r '.theme')" "and the command reads it from there too"
# A verb's result is a different vocabulary and is not this one; `cf piece call`'s
# projection stays empty until the verb before it can be read. Written past
# the marker, which is the one position the grammar accepts it in — before the
# verb it is refused rather than completed.
check "" "$(complete_at "cf piece call $LINE_ARGS --piece board addItem -- --select ")" \
  "a call's projection is not completed from the piece's root"

step "12. A name on two cells completes against the one the dispatcher reaches"
# The child is handed a callable named `record` in its arguments AND declares
# one on its result. The listing states that the result shadows the input; a
# candidate set that offered both, or the wrong one, would name a call that
# does something else.
check "record" "$(candidates_at "cf piece call $LINE_ARGS --piece $ITEM_ID ")" \
  "the shadowed name is offered exactly once"
BOARD_REVISION=$($CF cell get --quiet --piece board $ARGS revision 2>/dev/null)
check "1" "$($CF piece call --quiet --piece "$ITEM_ID" $ARGS \
  --invocation rec-1 \
  record '{"text":"first"}' 2>/dev/null | jq -r '.result.recorded')" \
  "calling it reaches the result cell's callable"
check "$BOARD_REVISION" "$($CF cell get --quiet --piece board $ARGS revision \
  2>/dev/null)" \
  "and not the one the arguments cell carries, which writes elsewhere"

step "13. The slots that read something other than the fabric"
# Two providers answer from the environment rather than from a server, so a
# probe of them proves nothing about reachability and everything about the
# vocabulary — which is the half that can silently go missing.
check "1" "$(complete_at "cf piece ls $CONN_ARGS --api-url http" |
  grep -c '^http')" "--api-url offers a URL to connect to"
check ":cf:files *.tsx" "$(directives_at "cf piece new $LINE_ARGS --test ")" \
  "a pattern-file slot hands the shell the glob it filters by"
# `--space` completes from local memory-v2 stores rather than from the server,
# so what it can offer depends on what is on disk — which is item 8's
# positional discovery rather than a defect here.
#
# Two things that follow, and the second is what a bare `if -n` gets wrong.
# Whether a store was found is read from `cf inspect spaces`' exit status as
# well as its output, since a command that failed and a machine with no store
# print the same nothing. And the provider is probed in BOTH branches: with a
# store it must offer the DID, and without one it must come back empty AND
# successful, which is the case a skipped probe could not tell from a broken
# CLI.
run $CF inspect spaces
check "0" "$RUN_STATUS" "cf inspect spaces runs, so its output can be read"
DISCOVERED=$(printf '%s\n' "$RUN_OUT" | grep -oE '^did:key:[A-Za-z0-9]+' |
  head -1)
if [ -n "$DISCOVERED" ]; then
  ok "a local space db is discoverable: $DISCOVERED"
  probe "cf piece ls $CONN_ARGS --space ${DISCOVERED%??????????}"
  check "0" "$PROBE_STATUS" "the --space slot runs"
  check "1" "$(printf '%s\n' "$PROBE_OUT" | grep -c "^$DISCOVERED\$")" \
    "and offers a DID discovered on disk"
else
  ok "no local space db is discoverable here"
  probe "cf piece ls $CONN_ARGS --space "
  check "0" "$PROBE_STATUS" "the --space slot runs"
  check "" "$(printf '%s\n' "$PROBE_OUT" | grep -v '^:cf:')" \
    "and offers nothing, which is all there is on disk to offer"
fi

step "14. Both halves of a link endpoint"
# `piece link` takes `pieceId/path/to/field` twice. Before the `/` the
# candidates are piece ids and after it they are that piece's cell keys, so one
# slot spans two vocabularies and both are read from the fabric.
check ":cf:nospace" "$(directives_at "cf piece link $LINE_ARGS ")" \
  "the endpoint holds the cursor for the separator it continues with"
check "1" "$(complete_at "cf piece link $LINE_ARGS ${BOARD%??????????}" |
  grep -c "^$BOARD\$")" "the source offers a piece id before the separator"
check "1" "$(complete_at "cf piece link $LINE_ARGS $BOARD/rev" |
  grep -c "^$BOARD/revision\$")" "and that piece's keys after it"
check "1" "$(complete_at "cf piece link $LINE_ARGS $BOARD/revision ${BOARD%??????????}" |
  grep -c "^$BOARD\$")" "the target completes the same way"
# The id half offers what the listing holds — registered pieces — while the key
# half reads whichever id was typed. So the child, which the listing does not
# name, still completes its own keys once its address is pasted in.
check "1" "$(complete_at "cf piece link $CONN_ARGS //$SPACE_DID/of:$BOARD@space/settings/den" |
  grep -Fc "//$SPACE_DID/of:$BOARD@space/settings/density")" \
  "a full reference retains its space, scope, and parent path while completing keys"
check "1" "$(complete_at "cf piece link $LINE_ARGS $BOARD/revision $ITEM_ID/rec" |
  grep -c "^$ITEM_ID/recorded\$")" \
  "and a pasted child address completes its keys, which the listing cannot name"
# And the pair the two slots completed is one the command accepts, which is the
# bar every other slot here is held to. Last, because it writes: a link makes
# the target mirror the source, so nothing above may depend on either value.
check "1" "$(succeeds $CF piece link --quiet $LINE_ARGS \
  "$BOARD/revision" "$ITEM_ID/recorded")" \
  "a pair of completed endpoints is a link the command writes"
step "15. The operator surface completes from the same store"
# `cf inspect` reads space DBs directly, so it wants the store step 13 looked
# for. Both positionals are probed either way, on the same terms that step
# holds to: what the listing exits with decides whether its output can be read
# at all, and where there is nothing to list the slot must still run and come
# back empty.
if [ -n "$DISCOVERED" ]; then
  check "1" "$(complete_at "cf inspect entities ${DISCOVERED:0:20}" |
    grep -c "^$DISCOVERED\$")" "the space positional completes from it"
  # The same prefix under --remote: the command would resolve it through the
  # remote's listing and open the snapshot it fetches, so the local DID it
  # completes to above is one that read rejects. The pair is what shows the
  # silence is a decision rather than an empty disk.
  check "" "$(complete_at \
    "cf inspect entities --remote=http://remote.invalid ${DISCOVERED:0:20}")" \
    "and offers nothing once --remote moves the space off this disk"
  run $CF inspect entities "$DISCOVERED" --json
  check "0" "$RUN_STATUS" "cf inspect entities runs against it"
  ENTITY=$(printf '%s\n' "$RUN_OUT" | jq -r '.[0].id // empty' 2>/dev/null)
  if [ -n "$ENTITY" ]; then
    check "1" "$(complete_at "cf inspect piece $DISCOVERED ${ENTITY:0:12}" |
      grep -c "^$ENTITY\$")" \
      "and the entity positional completes what inspect entities lists"
  else
    probe "cf inspect piece $DISCOVERED "
    check "0" "$PROBE_STATUS" "the entity slot runs against a space holding none"
    check "" "$(printf '%s\n' "$PROBE_OUT" | grep -v '^:cf:')" \
      "and offers nothing, which is all that space holds"
  fi
else
  probe "cf inspect entities "
  check "0" "$PROBE_STATUS" "the space positional still runs with no store"
  check "" "$(printf '%s\n' "$PROBE_OUT" | grep -v '^:cf:')" \
    "and offers nothing, which is all there is on disk to offer"
  # The entity positional too, so this branch asserts as much as the one above
  # and a machine with no store cannot pass by checking less.
  probe "cf inspect piece did:key:zNoSuchSpace "
  check "0" "$PROBE_STATUS" "the entity positional runs against no store either"
fi
# `inspect pull` names a space on the REMOTE, resolved through the remote's own
# listing, so a locally discovered DID is a candidate it rejects. Asserted in
# both branches above's terms: whatever the store holds, this slot is empty.
check "" "$(directives_at "cf inspect pull ")$(complete_at "cf inspect pull ")" \
  "the remote-only space positional offers nothing local"
# `--remote` is global on `inspect` and says the same thing about every one of
# its slots. Asserted with no store too, so the branch above cannot be the only
# place this is checked.
check "" "$(complete_at "cf inspect summary --remote=http://remote.invalid ")" \
  "a --remote space positional offers nothing local"
check "" "$(complete_at \
  "cf inspect piece --remote=http://remote.invalid did:key:zNoSuchSpace ")" \
  "and neither does the entity beside it"

step "16. wish and the enumerated remainder"
# These are the CLI's own vocabulary rather than a pattern's, which is what
# puts them below the slots above. Each set is in the command's own help.
check "1" "$(complete_at "cf wish #profileN" | grep -cx '#profileName')" \
  "a wish target completes"
check "profile" "$(complete_at "cf wish '#profile' --scope p" | paste -sd, -)" \
  "and a wish scope completes its named values"
check "ascii,dot" "$(candidates_at "cf piece map --format ")" \
  "an enumerated option completes exactly what its help lists"
check "1" "$(complete_at "cf inspect entities x --kind ow" |
  grep -cx 'owned-cell')" "and so does the other one"
# An option name means one thing per command, and the provider says where it
# applies: a file on one, a sequence number on the other.
check ":cf:files" "$(directives_at "cf space clone x --from ")" \
  "--from offers a snapshot file where it names one"
check "" "$(directives_at "cf inspect diff x y --from ")$(complete_at \
  "cf inspect diff x y --from ")" \
  "and nothing where it names a sequence number"
check ":cf:dirs" "$(directives_at "cf space clone x --to ")" \
  "--to offers a clone directory where it names one"
check "" "$(directives_at "cf inspect diff x y --to ")$(complete_at \
  "cf inspect diff x y --to ")" \
  "and nothing where it names a sequence number"
check ":cf:dirs" "$(directives_at "cf piece new --root ")" \
  "--root offers a source directory where it names one"
check "" "$(directives_at "cf inspect graph --root ")" \
  "and hands the shell no directory where it names an entity"

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
