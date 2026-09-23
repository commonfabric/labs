#!/usr/bin/env bash
# The shuttle walkthrough: open `cf sh` on a real space, on a real terminal,
# and read back what it drew.
#
# Shuttle's unit suite drives every module with nothing behind it — no server,
# no piece, and no terminal. `packages/cli/test/shuttle-terminal.serial.test.ts`
# says so of itself: "A handler that the runtime never runs, and a `setRaw` that
# the driver never honours, would both pass here." What no case there can see is
# the composition: whether a `cd` that a stub accepted lands on a cell the
# fabric holds, whether the reference a listing printed is the one the next line
# takes, and whether what a read serves is what storage holds. Each of those is
# a property of the seams together and of no module, so this is where they are
# asserted.
#
# The terminal is a real one. `cf sh` refuses to start unless both standard
# streams are terminals, because it reads keys in raw mode and draws lines back
# with escape sequences, so this drives it through a pseudo-terminal:
# `shuttle-terminal.py` holds the master, types the lines, and takes the
# drawing apart into one record per line — the line, what the shell wrote above
# the next prompt, and the prompt it then drew. Its own header says how the
# drawing is read apart and why no wait here is a poll.
#
# The prompt is half of every assertion below, because after a `cd` the prompt
# is the whole of what the verb did: a `cd` that was refused and a `cd` that
# moved differ in where the next line is typed, and nothing else.
#
# The writing verbs are read back twice, and neither reading covers what the
# other does. A `set` that printed its receipt and wrote nothing would satisfy
# any assertion made against the transcript, and so would a `call` that settled
# without running the handler — so the session's writes are read again from
# outside once it has ended, through the same `cf cell get` step 2 takes its
# stored reading with.
#
# That second reading is taken at the end, so what it establishes is the state
# at the end rather than that each write landed: a cell written more than once
# carries only its last value, and a value another line would have produced
# anyway reads the same as one this line produced. So each check says which
# write it speaks for, and a write the final reading cannot speak for rests on
# the shell's own read on the line after it — which catches a receipt with no
# write behind it, but cannot see whether the write committed.
#
# It deploys pattern/shuttle-place.tsx and nothing else. That fixture belongs
# to this walkthrough alone, so a change to a pattern the product actually
# ships can never break a demonstration of what a shell can reach.
#
# No gap is open here, and the two steps that would carry one read a refusal's
# words back instead: a value opening with `-` is told about the bare `--` that
# writes it (step 19), and a write onto a whole piece is refused in the sentence
# `set`'s own page carries (step 20). Both are wording a prompt can act on, so
# both are pinned. The counter and the summary line stay as
# `verb-session-gaps.sh` and `completion-over-the-cli.sh` carry theirs, for
# whatever the next reading of this shell turns up.
#
# Documented in packages/cli/README.md's "Interactive shell" section, which
# explains the shell this exercises. Keep the two in step: the doc is the
# explanation, this is the proof, and each names the other.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/shuttle-over-a-terminal.sh
#
# CI runs it through integration.sh's `piece-call` section (the
# cli-integration matrix in .github/workflows/deno.yml); the `shuttle` section
# is the standalone selector for running just this script by hand.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/shuttle-place.tsx"
DRIVER="$SCRIPT_DIR/shuttle-terminal.py"

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
contains() {
  case "$2" in
    *"$1"*) ok "$3" ;;
    *) bad "$3 (nothing matching [$1] in [$2])" ;;
  esac
}
lacks() {
  case "$2" in
    *"$1"*) bad "$3 (found [$1] in [$2])" ;;
    *) ok "$3" ;;
  esac
}

SPACE="${SPACE:-$(mktemp -u shuttleXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"

# The host's server-execution posture, which one step below turns on: with the
# serving loop running, the server may recompute a piece nobody asked to run,
# and a value read cold would then be warm through no doing of the shell's.
#
# It answers with three words and not two, because the third is a different
# fact. A host that says nothing is not a host that says it does not execute,
# and the step that reads this makes no claim at all on `unreadable` — where
# folding the two together would let a quiet server decide which assertions the
# walkthrough makes, and report as though it had established something it never
# asked about.
#
# For the same reason the request carries no deadline of its own, where the
# walkthroughs beside this one bound theirs. `docs/development/waiting-in-tests.md`
# names the shape under "Browser-hosted unit tests have a harness backstop": a
# bound at a call site caps what that call can observe, and here what it would
# cap is a verdict — a health endpoint answering a second after the bound would
# be read as a server that does not execute. By the time this runs the same host
# has answered two deploys, a write and a whole session, so a request that never
# comes back is a server that stopped, and the bound around the suite is what
# says so.
POSTURE=""
read_posture() {
  case "${EXPERIMENTAL_SERVER_EXECUTION:-}" in
    true) POSTURE="on"; return ;;
    false) POSTURE="off"; return ;;
  esac
  local stats status
  stats=$(curl -fsS "$API_URL/api/health/stats" 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    POSTURE="unreadable: the health endpoint exited $status"
  elif ! printf '%s' "$stats" | jq -e 'type == "object"' >/dev/null 2>&1; then
    POSTURE="unreadable: the health endpoint answered no JSON object"
  elif printf '%s' "$stats" | jq -e '.servingLoop != null' >/dev/null 2>&1; then
    POSTURE="on"
  else
    POSTURE="off"
  fi
}

echo "API_URL=$API_URL"
echo "SPACE=$SPACE"
START=$(date +%s)

step "1. Deploy the fixture under two slugs"
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
FIRST=$($CF piece new --quiet --slug first "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
SECOND=$($CF piece new --quiet --slug second "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$FIRST" ] && [ -n "$SECOND" ]; then
  ok "deployed $FIRST and $SECOND"
else
  bad "deploy failed"
  exit 1
fi

step "2. Write one item from outside, before any shell exists"
# The write goes to the arguments cell, which changes what storage holds
# without running the pattern. Doing it here rather than from inside a session
# is what makes the reads below say something: the shell connects afterwards,
# so what it serves is what it found, with no push to have raced.
if echo '["bread"]' | $CF cell set --quiet --input --cell first items $ARGS \
  >/dev/null 2>&1; then
  ok "wrote items to the arguments cell of first"
else
  bad "the external write failed"
fi
# What storage holds for the computed member, read here because here is the
# only place it can be read: reaching in warms, and a warm run commits what it
# computed, so once a session has stood on this piece nothing can read what
# storage held before it. Step 11 compares this with what the shell serves.
STORED=$($CF cell get --quiet --cell first summary $ARGS 2>/dev/null)

step "3. Drive a session over a pseudo-terminal"
# `edit` opens `$EDITOR` on the value and writes back what was saved, so the
# person is the one part of that round trip a script has to stand in for.
# Everything else stays real: this is a program `edit` runs, over a file it
# made, on a value the fabric served, and what it saves goes back through the
# same write `set` uses. Standing in for the person is not standing in for the
# system — no seam below `openEditor` is replaced, which is what would make
# this a stub rather than a walkthrough.
#
# It takes and leaves the alternate screen as a full-screen editor does, which
# is the half of the round trip the shell has to undo for itself.
#
# It has no state and takes no turn: what it saves is decided by what it was
# given, so each of the three lines below reaches it with a different value and
# gets a different one of `edit`'s three endings. That is what lets one editor
# drive all three from a script the driver types in one go. The note has a case
# of its own for the `e` typed at a view, where what is being shown is that the
# editor ran at all: leaving the value alone takes the ending that changes
# nothing, so a step about the view costs the steps after it nothing.
EDITOR_SCRIPT=$(mktemp)
cat >"$EDITOR_SCRIPT" <<'EDITS'
#!/usr/bin/env bash
# The screen a full-screen editor takes. A terminal keeps no stack of alternate
# screens, so an editor that takes one and leaves it puts the shell back on its
# primary screen — the transcript — whatever the shell thought it was holding,
# and the shell has to take its own screen again before it draws.
#
# What this buys and what it does not. It puts the real sequence through the
# real suspension, so the round trip is exercised rather than described. It
# does not assert the shell came back to its own screen: which screen a byte
# landed on is not something a transcript of the bytes can say, and a shell
# that drew its frame over the transcript would write exactly these records.
# That assertion is `shuttle-terminal.serial.test.ts`'s, where the escape
# sequences are what is read.
printf '\033[?1049h'
trap 'printf "\033[?1049l"' EXIT
case "$(cat "$1")" in
  '"garble me"') printf 'not json at all' >"$1" ;;
  '"edited in the editor"') : ;;
  '"written once and never again"') : ;;
  *) printf '"edited in the editor"' >"$1" ;;
esac
EDITS
chmod +x "$EDITOR_SCRIPT"

SCRIPT=$(mktemp)
TRANSCRIPT=$(mktemp)
cat >"$SCRIPT" <<'LINES'
where
ls
cd slugs
ls
cd nosuchslug
cd first
ls
get label
get items
get summary
cd nosuchkey
cd settings
ls
cd ..
cd /
cd /slugs/first
pwd
get
more
help
get --help
set label '"a written place"'
get label
set label -- -Infinity
get label
set label -5
set . '{"label":"x"}'
set '' '"x"'
get label
verbs
call . addItem '{"text":"milk"}'
get items
call %2 '{}'
get items
call %1 '{"text":"jam"}'
get items
get summary
call . --help
edit label
get label
edit label
set label '"garble me"'
edit label
get label
link /slugs/first/label /slugs/second/label
link /slugs/first#argument/label /slugs/second/label
set label '"pointed at"'
set settings/note '"written once and never again"'
link /slugs/first/label /slugs/second#argument/label
edit
watch settings/depth
@frame q
watches
set settings/depth 3
@said watch first/settings/depth @space: changed
where
unwatch %1
watches
watch .#argument/label
cd /pieces
ls
cd %1
pwd
cd /slugs/first
ls settings
cd %1
pwd
cd /slugs/first/settings
get .#argument/items
get /slugs/first#argument/items
get /slugs/first/items#argument
cd .#argument
ls .#argument
get ..#argument/items
cd ../..
cd /slugs/first
watch settings/note
@drawn written once and never again
@frame /written\r
@drawn / written  1 of 1
@frame :pwd\r
@drawn position  //
@frame e
@drawn Nothing changed
@frame q
watches
unwatch %1
xpwd
xcd ../elsewhere
xpwd
LINES
# Read before the session so the claim step 32 makes about the seed is a
# claim about this directory and not about whatever the shell reported.
STARTED_IN=$(pwd)
EDITOR="$EDITOR_SCRIPT" python3 "$DRIVER" "$SCRIPT" "$TRANSCRIPT" -- \
  $CF sh $ARGS >/dev/null
DRIVE_STATUS=$?
check "0" "$DRIVE_STATUS" "the session ran and ended on ctrl-d with a zero status"
if [ "$DRIVE_STATUS" -ne 0 ]; then
  echo "  the shell did not complete the session; nothing below can be read"
  exit 1
fi

# What the shell said in answer to the Nth line, and the prompt it then drew.
#
# Each takes the line it expects as well as its number, because an edit to the
# script above shifts every number after it and a walkthrough that silently
# asserted against the neighbouring line would be worse than one that stopped.
# A disagreement comes back as a sentence no assertion can match, so the check
# that asked for it fails and says which record it wanted — the count cannot be
# raised from here, every caller reading these through a command substitution
# that runs them in a subshell of its own.
misread() {
  printf '<<transcript step %s is [%s], not [%s]>>\n' "$1" "$2" "$3"
}
said() {
  local at="$1" want="$2" got
  got=$(jq -r ".[$at].line // \"\"" "$TRANSCRIPT")
  if [ "$got" != "$want" ]; then misread "$at" "$got" "$want"; return; fi
  jq -r ".[$at].said" "$TRANSCRIPT"
}
prompt() {
  local at="$1" want="$2" got
  got=$(jq -r ".[$at].line // \"\"" "$TRANSCRIPT")
  if [ "$got" != "$want" ]; then misread "$at" "$got" "$want"; return; fi
  jq -r ".[$at].prompt" "$TRANSCRIPT"
}

step "4. The shell opens on the space root"
check "shuttle / @space> " "$(jq -r '.[0].prompt' "$TRANSCRIPT")" \
  "the first prompt stands at the space root"

step "5. where names the connection the flags asked for"
WHERE=$(said 1 "where")
contains "api       $API_URL" "$WHERE" "where names the host it connected to"
contains "space     $SPACE" "$WHERE" "where names the space it connected to"
contains "identity  $CF_IDENTITY" "$WHERE" "where names the identity it opened"
contains "external  file://" "$WHERE" \
  "where names the external working location beside the fabric place"

step "6. ls at the root lists the facets, and cd takes one of them"
check "%1 slugs
%2 pieces" "$(said 2 "ls")" "the root lists exactly the two facets"
check "shuttle /slugs/ @space> " "$(prompt 3 "cd slugs")" \
  "cd into the slug facet moves the prompt onto it"

step "7. The slug index names both deployed slugs"
SLUGS=$(said 4 "ls")
contains "%1 first" "$SLUGS" "the listing numbers the first slug"
contains "%2 second" "$SLUGS" "the listing numbers the second slug"

step "8. A slug the index does not record is refused, and nothing moves"
REFUSED_SLUG=$(said 5 "cd nosuchslug")
contains "nosuchslug\` reaches no piece" "$REFUSED_SLUG" \
  "cd names the slug it could not reach"
check "shuttle /slugs/ @space> " "$(prompt 5 "cd nosuchslug")" \
  "a refused cd leaves the prompt where it stood"

step "9. A slug the index does record lands on the piece it names"
check "shuttle first @space> " "$(prompt 6 "cd first")" \
  "the prompt carries the name the index confirmed"
# The two handlers list as callables off the schema their stored links carry;
# nothing is stored at either position.
check "%1 \$NAME
%2 \$UI
%3 addItem <callable>
%4 clearItems <callable>
%5 items
%6 label
%7 settings
%8 summary" "$(said 7 "ls")" "the piece lists every key the fixture declares"

step "10. get reads a stored value, and reads it as storage holds it"
check '"a place"' "$(said 8 "get label")" "get reads a stored scalar"
check '[
  "bread"
]' "$(said 9 "get items")" "get serves the item the external write left"

step "11. Reaching into a piece warms it, so a computed value reads live"
# Decision 10 of docs/plans/shuttle/README.md rules that reaching in warms, so
# that every read the shell serves is live. `summary` is computed from `items`,
# and the write in step 2 changed `items` without running the pattern: storage
# therefore holds what the deploy left, and a shell standing on the piece
# serves what the pattern computes from what is there now. Both readings are
# asserted, because either alone is equally consistent with the other value
# never having existed — a warm reading with no stale one beside it says only
# that the fixture computes something.
#
# The claim is only readable with the serving loop off. With it on, the server
# may run the piece for reasons of its own, and a warm `summary` would then say
# nothing about whether the shell warmed anything — and with the posture
# unreadable, neither does anything else, so the step says that rather than
# picking the arm that happens to pass.
WARM=$(said 10 "get summary")
read_posture
case "$POSTURE" in
  on)
    ok "skipped: the server executes, so a warm value would not be the shell's doing"
    ;;
  off)
    check '""' "$STORED" \
      "storage holds what the deploy left, the write having run nothing"
    check '"bread"' "$WARM" \
      "the shell serves what the pattern computes from the written item"
    ;;
  *)
    bad "the server-execution posture is $POSTURE, so this step can read nothing"
    ;;
esac

step "12. A path the cell does not hold is refused, with the keys that are"
# The review this walkthrough answers found `cd` adopting a key that was not
# there, and every later line failing with the runtime's own words one command
# further on. Both halves are asserted: the refusal is shuttle's and names what
# would have worked, and the place is where it was.
REFUSED_KEY=$(said 11 "cd nosuchkey")
contains "nosuchkey\` reaches no cell" "$REFUSED_KEY" \
  "cd refuses a key the cell does not hold"
contains "whose keys are \`\$NAME\`" "$REFUSED_KEY" \
  "the refusal names the keys that would have worked"
check "shuttle first @space> " "$(prompt 11 "cd nosuchkey")" \
  "a refused cd leaves the place where it stood"

step "13. cd walks into a nested value and back out of it"
check "shuttle first/settings @space> " "$(prompt 12 "cd settings")" \
  "cd stands two segments inside the piece"
check "%1 depth
%2 note" "$(said 13 "ls")" "the nested object lists its own keys"
check "shuttle first @space> " "$(prompt 14 "cd ..")" \
  "cd .. climbs back to the piece root"

step "14. A rooted reference opening with a facet walks from the root"
# The other half of the review's finding: `/slugs/first` read as a piece
# slugged `slugs` would have been a trap one level down from the spelling the
# root teaches. It reaches the same piece the relative spelling did, and `pwd`
# names the handle the deploy printed.
#
# The `cd /` in front of it is what makes the claim about the reference rather
# than about where the line before it left off: with the shell already standing
# at the piece, a `/slugs/first` that was refused would leave the prompt
# reading exactly what a `/slugs/first` that landed leaves it reading, and the
# check could not tell the two apart. So the shell is sent to the root first,
# and both halves are read — that the line said nothing, and that the prompt
# moved.
check "shuttle / @space> " "$(prompt 15 "cd /")" \
  "the shell is standing at the root before the rooted reference is read"
check "" "$(said 16 "cd /slugs/first")" \
  "a rooted facet reference is not refused"
check "shuttle first @space> " "$(prompt 16 "cd /slugs/first")" \
  "a rooted facet reference reaches the piece the slug names"
contains "$FIRST" "$(said 17 "pwd")" "pwd names the handle the deploy printed"
contains "position  //" "$(said 17 "pwd")" \
  "pwd writes the complete form, the space after a doubled separator"

step "15. get at a piece stands in for its picture of itself, and more writes the rest"
WHOLE=$(said 18 "get")
contains '"$UI": "<elided' "$WHOLE" "the UI node is stood in for"
# `children` is the key every vnode carries and the first one the tree would
# write, so it is the part of the node that reaches the page rather than a part
# a bound would have cut off anyway.
lacks '"children"' "$WHOLE" "no part of the vnode tree reaches the screen"
# The piece is larger than a screen, so what a page bounds is read here rather
# than assumed: the first page says it was cut, and `more` writes what it cut
# under the same reading. `label` is the member that lands on the continuation,
# which is what makes the pair an assertion about the bound rather than about
# the value — a `get` that had written the whole piece would put it on the
# first page, and a `more` with nothing held back would say so.
contains "more continues" "$WHOLE" "the first page says the rendering was cut"
contains '"label": "a place"' "$(said 19 "more")" \
  "more writes the part of the piece the page bound held back"

step "16. The shell has help, and a verb's --help is a page rather than a path"
HELP=$(said 20 "help")
contains "cd <ref>" "$HELP" "help lists the verb that moves"
contains "get [<ref>]" "$HELP" "help lists the verb that reads"
GET_HELP=$(said 21 "get --help")
contains "Usage: get [<ref>]" "$GET_HELP" "--help writes the verb's page"
lacks "names no facet" "$GET_HELP" "--help is not read as a path"

# Every step from here writes. `AFTER` takes a reading from outside the way
# step 2 took its stored one — over a connection this session never had, so a
# write that reached only the running piece and never committed fails there. It
# reads each cell once, at the end, so which write a reading is evidence for is
# a question per cell: step 29 names that write beside each of its checks, and
# the writes it cannot speak for rest on the shell's own read on the line after
# each.
AFTER() { $CF cell get --quiet --cell "$1" "$2" $ARGS 2>/dev/null; }

step "17. A set lands, and the fabric holds it after the session has gone"
check "Wrote \`label\` on \`$FIRST\`." "$(said 22 "set label '\"a written place\"'")" \
  "set receipts the path it wrote and the piece it wrote on"
check '"a written place"' "$(said 23 "get label")" \
  "the shell serves the value it just wrote"
# `label` is written five times below, so a reading of it at the end says the
# last write landed and nothing about the four before it. This one goes to a
# path nothing else in the session touches, which is what lets step 29 speak
# about a particular write rather than about whichever write reached a cell
# last.
check "Wrote \`settings/note\` on \`$FIRST\`." \
  "$(said 48 "set settings/note '\"written once and never again\"'")" \
  "a set reaches a path below the piece root, and receipts that path"

step "18. A value JSON cannot carry is refused, and the cell keeps what it had"
# `set` reads its value as JSON and a bare word as the string it spells, so the
# values it turns down are the ones that open the way JSON opens a value and
# then do not parse. `-Infinity` is one of them, and it is the same value
# `edit` refuses on the way out for the same reason: JSON has no spelling that
# writes it back. The refusal carries the parser's own words, and the reading
# after it is the half that matters — a refusal that had written anything
# would be worse than one that had not been made.
REFUSED_VALUE=$(said 24 "set label -- -Infinity")
contains "\`-Infinity\` is not JSON" "$REFUSED_VALUE" \
  "set names the value it would not write"
contains "is read as JSON; anything else is the string it spells" \
  "$REFUSED_VALUE" "the refusal says which values are read as JSON"
check '"a written place"' "$(said 25 "get label")" \
  "the refused write left the cell holding what it held"

step "19. A value opening with a dash is refused, and the refusal names the escape"
# The grammar is ruled and both halves of it are read back here: a token
# opening with `-` is an option wherever one may be written, so `-5` is refused
# as an option nobody declared, and the bare `--` the line above spells its
# value after is what writes one as an operand. A negative number has no
# spelling that does not open with `-`, so the escape is the whole of what the
# refusal owes the person, and the parser's own sentence — which points at
# `-h` — cannot know to offer it.
DASH_VALUE=$(said 26 "set label -5")
contains 'Unknown option "-5"' "$DASH_VALUE" \
  "a token opening with a dash is read as an option, which is the ruled grammar"
contains 'a bare `--` writes every token after it as an operand' "$DASH_VALUE" \
  'the refusal names the `--` that writes the value'

step "20. A write onto a whole piece is refused, in the words the page uses"
# The safety property first, because it is the one that matters and it holds: a
# line naming the piece rather than a path inside it writes nothing, shuttle
# refusing it and `refuseRootWrite` behind that for the paths only resolution
# can judge.
ROOT_WRITE=$(said 27 "set . '{\"label\":\"x\"}'")
# Read after both of this step's lines rather than between them, so it says
# neither of them wrote. Two things stop the first: the refusal below, and the
# pattern's own schema, which turns down a result cell missing members the
# fixture declares. Removing either leaves the other, which is what a safety
# check should be able to say.
check '"a written place"' "$(said 29 "get label")" \
  "the refused root write left the piece as it was"
# And what it says is the sentence `set --help` carries, word for word, which
# is the whole of what a person reads whether they take the page first or the
# refusal after: the address to embed a path in and the positional to pass one
# as are `cf`'s command line, and a shuttle line has neither — the path IS the
# operand the person wrote.
check 'A write onto a whole piece is refused. `link` is what writes a reference.' \
  "$ROOT_WRITE" "the root-write refusal is the sentence the verb's page carries"
# The empty operand is a line of its own, and it is refused in the name of the
# verb that wrote it. `movePlace` (`lib/shuttle/place.ts`) is the operand
# reading every verb aims through, so a sentence of its own about `cd` would
# reach a person who wrote no `cd`.
EMPTY_OPERAND=$(said 28 "set '' '\"x\"'")
check '`set` was given an empty operand, which names no place.' \
  "$EMPTY_OPERAND" "the empty operand a set line writes is refused in set's name"

step "21. verbs lists what the piece can be asked to do, and numbers each row"
check "%1 addItem <handler on result> <Appends one line to \`items\`.>
%2 clearItems <handler on result> <Empties \`items\`, which is the opposite of what \`addItem\` does.>" \
  "$(said 30 "verbs")" "verbs numbers both callables with what each is"

step "22. call runs the callable, and what it did is there afterwards"
# The receipt is the seam's Invocation JSON, so what is asserted of it is that
# the call settled rather than that it was accepted — a call the fabric took
# and never ran would say the second and not the first. What the handler did
# is a separate reading, and this is the only one that takes it: step 23 empties
# `items` and refills it, so the array step 29 reads ends at `["jam"]` whether
# or not this call's `milk` ever committed.
CALLED=$(said 31 "call . addItem '{\"text\":\"milk\"}'")
contains '"status": "settled"' "$CALLED" "the call settled"
# Appended rather than written: `items` already holds what step 2 wrote from
# outside, so a call that had replaced the array would be caught here as well
# as one that had done nothing.
check '[
  "bread",
  "milk"
]' "$(said 32 "get items")" "the item the call appended is there, after the one that was"

step "23. call %n invokes the row the listing numbered, and not another"
# Two callables with opposite effects is what makes this an assertion. With one
# row, `call %1` passes whether the handle named that row or was thrown away;
# with two, each number is only right if it reached its own row — a `%2` that
# had run `addItem` would leave two items, and a `%1` that had run `clearItems`
# would leave none.
contains '"status": "settled"' "$(said 33 "call %2 '{}'")" \
  "the callable handle off verbs settles a call"
check "[]" "$(said 34 "get items")" \
  "%2 ran clearItems, which emptied what %1 had filled"
check '[
  "jam"
]' "$(said 36 "get items")" "%1 ran addItem, which appended to what %2 emptied"
check '"jam"' "$(said 37 "get summary")" \
  "the computed member follows what the calls did"
# A callable's page is not reached by writing an option where its name goes,
# and the refusal points at the verb that does list them.
contains "\`verbs\` lists what this piece can be asked to do" \
  "$(said 38 "call . --help")" "an option in the name position names verbs"

step "24. edit writes back what the editor saved, stopping three ways after the editor and one before it"
check "Wrote \`label\` on \`$FIRST\`." "$(said 39 "edit label")" \
  "edit writes back what came out of the editor"
check '"edited in the editor"' "$(said 40 "get label")" \
  "the cell holds what was saved rather than what was opened"
check "Nothing changed, so nothing was written." "$(said 41 "edit label")" \
  "text that came back unchanged is nothing to write"
# Text that will not parse is the one ending that leaves work on disk, and the
# file it names is the only copy of it. So the refusal names a file, and the
# file is there — which is a claim about the filesystem rather than about the
# sentence, and the only one of the three that a transcript alone cannot make.
UNPARSED=$(said 43 "edit label")
contains "What the editor saved is not JSON" "$UNPARSED" \
  "edit refuses text that will not parse"
KEPT=$(printf '%s' "$UNPARSED" | sed -n 's/.*the text is in `\([^`]*\)`.*/\1/p')
if [ -n "$KEPT" ] && [ -f "$KEPT" ]; then
  ok "the file the refusal names is still on disk, holding the unwritten text"
  rm -f "$KEPT"
else
  bad "the refusal named no file that is there (named [$KEPT])"
fi
check '"garble me"' "$(said 44 "get label")" \
  "the refused edit left the cell holding what it held"
# The stop that comes before the editor rather than after it. The operand
# names the whole piece — here by naming nothing, shuttle standing on one —
# and no write onto a whole piece can land, so the line is turned down while
# there is nothing typed to lose. The editor never runs: had it run, this
# fixture would have saved `"edited in the editor"` over the piece and the
# line would have come back as a receipt or as the seam's refusal, neither of
# which is this sentence. Every line before it that moves leaves shuttle
# standing on the piece, which is what makes its absent operand name one.
check 'A write onto a whole piece is refused. `link` is what writes a reference.' \
  "$(said 50 "edit")" "edit turns down a whole piece in the sentence set gives it"

step "25. link writes a reference, so the second cell reads the first"
check "Wrote a reference at \`/slugs/second/label\` naming \`/slugs/first/label\`." \
  "$(said 45 "link /slugs/first/label /slugs/second/label")" \
  "link receipts both ends, in the order it was given them"
# There are two endpoints, so the claim about both is made of two readings.
# Each refusal quotes the operand it was written on, which is also what says
# the refusal is about the endpoint the line spelled rather than about
# whichever of the two happens to be resolved first.
contains "\`/slugs/first#argument/label\` selects a piece's arguments cell" \
  "$(said 46 "link /slugs/first#argument/label /slugs/second/label")" \
  "the source endpoint does not take the arguments member"
contains "\`/slugs/second#argument/label\` selects a piece's arguments cell" \
  "$(said 49 "link /slugs/first/label /slugs/second#argument/label")" \
  "the target endpoint does not take the arguments member"

step "26. watch arms a subscription, opens a view over it, and outlives it"
# The half no unit case can reach. Every sink in the unit suite is stood in
# for, so what is asserted there is what shuttle does with a settle it was
# handed; here the subscription is taken over the connection this session
# holds, on a cell the fabric resolved, and the line it writes is one a real
# runtime settled.
#
# The view is asserted by the driver rather than by a check: it waits for the
# shell to take the alternate screen before it types `q`, so a `watch` that
# opened no view leaves a wait that never comes back, and the session's own
# backstop reports it with everything drawn so far. Nothing below could stand in for
# that — with no view, the `q` would have been typed as a line and refused,
# and the records after it would read as they do here.
check "%1 first/settings/depth @space" "$(said 51 "watch settings/depth")" \
  "watch numbers what it armed, so unwatch needs no listing first"
check "%1 first/settings/depth @space" "$(said 52 "watches")" \
  "the view closing left the watch armed"
# The line the settle wrote, which the driver waited for by name before it
# typed anything else. That is what puts it in the transcript; which record it
# landed in is not something to assert, since a settled change arrives when the
# runtime is quiet rather than when the line that caused it answered, and the
# prompt that ends a record can fall either side of that.
WATCHED=$(jq -r '[.[].said] | join("\n")' "$TRANSCRIPT")
contains "watch first/settings/depth @space: changed" "$WATCHED" \
  "a settled change wrote one line naming the cell that changed"
# The other half of "a change is what is reported", and the half only a real
# runtime can show: the subscription fires once on registration with what the
# cell already holds, and a watch that reported that would have written a line
# the moment it was armed. Counted rather than looked for, because the line a
# baseline would write is the line a change writes — one write was made here,
# so one line is what the whole transcript may hold.
WROTE=$(printf '%s' "$WATCHED" |
  grep -c "watch first/settings/depth @space: changed")
check "1" "$WROTE" "the reading the subscription opened with wrote no line"
contains "watches   first/settings/depth @space" "$(said 54 "where")" \
  "the ambient record names what this run is watching"
check "Disarmed the watch on \`first/settings/depth @space\`." \
  "$(said 55 "unwatch %1")" "unwatch disarms the watch the row was minted for"
check "<no watches are armed>" "$(said 56 "watches")" \
  "nothing is armed once the one watch is disarmed"
# The arm this shell does not serve, asserted where the unit suite cannot see
# it: a subscription on a piece's arguments cell reports the link stored at the
# member rather than the value behind it, and a write through that link settles
# nothing it can see. That was measured against a live runtime rather than
# reasoned about, and until `packages/piece` offers a resolved cell for an
# arguments path the spelling is refused rather than served silently.
contains "does not serve a piece's arguments cell" \
  "$(said 57 "watch .#argument/label")" \
  "watch turns down the arguments cell rather than watching it silently"

step "27. The pieces facet numbers rows cd takes, and shows what each piece is called"
# The composition no unit case reaches, because each half of it is stubbed out
# where the other is under test: a listing mints a row, `%n` expands to what
# that row printed, and `cd` moves onto the piece the row named. The spelling
# is the piece's own id, which carries no `of:` scheme — so what is asserted
# here is that the facet and the mover read one spelling between them.
check "shuttle /pieces/ @space> " "$(prompt 58 "cd /pieces")" \
  "cd into the piece facet moves the prompt onto it"
LISTED=$(said 59 "ls")
contains "$FIRST" "$LISTED" "the facet lists the first deployed piece"
contains "$SECOND" "$LISTED" "the facet lists the second deployed piece"
# The fixture names itself, so a facet that showed no name would show none
# here either. What the row is called is beside the handle rather than in
# place of it, the handle being what the next line hands back.
contains "<Shuttle place>" "$LISTED" "a listed piece shows the name it carries"
# The row `%1` named, read off the listing rather than assumed: whichever
# piece the registry lists first is the one the next line has to land on, and
# reading it here is what makes the check about the two agreeing.
ROW=$(printf '%s' "$LISTED" | sed -n '1s/^ *%1 \([^ ]*\).*/\1/p')
if [ -z "$ROW" ]; then
  bad "the listing's first row printed no operand for the next line to reach"
else
  check "" "$(said 60 "cd %1")" "cd %1 is not refused on the row ls printed"
  check "shuttle $ROW @space> " "$(prompt 60 "cd %1")" \
    "cd %1 lands on the piece the first row named"
  contains "$ROW" "$(said 61 "pwd")" "pwd names the piece the row named"
fi

step "28. ls reads a child without standing on it, and its numbers bind"
# The other composition no unit case reaches, and the one `ls <target>` is
# for: the listing is read at a place the shell is not standing at, and the
# `%n` it hands out has to name a row of *that* place. Numbered against where
# the shell stands, `%1` here would walk to `depth` under the piece root,
# which is no key there — so the prompt after `cd %1` is the whole assertion.
#
# The prompt is read three times for three different claims: that `ls
# settings` left the shell on the piece, which is what reading a child without
# standing on it means; that `cd %1` then stood two segments in; and that the
# segment it stood on is the row the listing printed rather than a key this
# script guessed.
check "shuttle first @space> " "$(prompt 62 "cd /slugs/first")" \
  "the shell is standing on the piece before the child is listed"
NESTED=$(said 63 "ls settings")
contains "depth" "$NESTED" "the listing names a key of the target"
lacks "label" "$NESTED" \
  "the listing is the target's rather than the place's"
check "shuttle first @space> " "$(prompt 63 "ls settings")" \
  "listing a child leaves the shell standing where it was"
# The row `%1` named, read off the listing rather than assumed, as step 27
# reads its own: what is asserted is that the listing and the mover agree,
# which a hard-coded key would turn into a claim about the fixture.
NESTED_ROW=$(printf '%s' "$NESTED" | sed -n '1s/^ *%1 \([^ ]*\).*/\1/p')
if [ -z "$NESTED_ROW" ]; then
  bad "the listing of the child printed no operand for the next line to reach"
else
  check "shuttle first/settings/$NESTED_ROW @space> " "$(prompt 64 "cd %1")" \
    "cd %1 lands on the row the listing of the child numbered"
  contains "settings/$NESTED_ROW" "$(said 65 "pwd")" \
    "pwd names the path the row stands at"
fi

step "29. What the fabric holds, read from outside the session that wrote it"
# The half no transcript can make: every reading is taken over a connection
# this session never had, after the shell has gone, so a write that reached
# only the running piece and never committed fails here and nowhere above.
#
# What a reading taken at the end establishes is the state at the end, which
# is a narrower thing than every write having landed. A cell written more than
# once carries only its last value, and a value some other line would have
# produced anyway reads the same as one this line produced. So each check
# below says which write it speaks for, and the writes it cannot speak for are
# named rather than left to look covered: those rest on the shell's own read
# on the line after each, which catches a receipt with no write behind it but
# cannot see whether the write committed.
#
# `label` is written five times, so this reading is of the fifth.
check '"pointed at"' "$(AFTER first label)" \
  "the last set of the five that wrote this cell is what the fabric holds"
# Written on one line and never touched again, so this reading is of that line
# and of no other — the one set here established end to end.
check '"written once and never again"' "$(AFTER first settings/note)" \
  "the set that went to its own path landed, and committed there"
# `["jam"]` is reachable only if the last two calls both ran: without the
# `clearItems` the array would still carry `bread` and `milk`, and without the
# `addItem` after it the array would be empty. The first call is not
# established here — an `items` that never received `milk` ends at `["jam"]`
# too — and the reading in step 22 is what speaks for that one.
check '["jam"]' "$(AFTER first items | tr -d ' \n')" \
  "both calls whose absence would change the final array committed"
check '"jam"' "$(AFTER first summary)" \
  "the computed member was committed as the warm run left it"
# The one reading that tells a reference from a copy. `second` was never
# written by name after the link, and `first/label` was — so a `second` holding
# the new value read it through the reference, and a `link` that had copied
# would hold the value `first` had when the link was made.
check '"pointed at"' "$(AFTER second label)" \
  "the linked cell reads the value written at the cell it names"

step "30. The arguments member reads one cell on a head and on a piece segment, and no place stands in it"
# The unit suite pins where each spelling points and which cell it selects;
# what it cannot see is that the read the seam makes is of that cell. So one
# arguments cell is read twice back to back, through the member on the head
# and through the member on a piece segment, and the two must agree. Written
# after a path segment instead, `items#argument` is one result key. The
# fixture's result holds no key by that name, so the read fails naming it, and
# the keys the failure lists are the result's: `addItem`, `clearItems`,
# `settings` and `summary` are outputs the pattern's arguments do not take.
# The rooted walk in front of them stands two segments inside the piece, which
# is what makes the head's reading from the arguments cell's root a claim.
check "shuttle first/settings @space> " \
  "$(prompt 66 "cd /slugs/first/settings")" \
  "a rooted walk stands two segments inside the piece"
FROM_HEAD=$(said 67 "get .#argument/items")
FROM_SEGMENT=$(said 68 "get /slugs/first#argument/items")
contains "[" "$FROM_HEAD" "the member on the head reads the arguments cell's items"
check "$FROM_HEAD" "$FROM_SEGMENT" \
  "the member on the head and on the piece segment read one cell from its root"
check 'Cannot access path "items#argument" - property "items#argument" not found. Available keys: addItem, clearItems, items, label, settings, summary' \
  "$(said 69 "get /slugs/first/items#argument")" \
  "a path ending in #argument names a result key, and the read of the result names that key among the result's own"
contains "A place is result-rooted, so \`cd\` selects no \`#argument\` member" \
  "$(said 70 "cd .#argument")" "cd refuses the member on its head"
check "shuttle first/settings @space> " "$(prompt 70 "cd .#argument")" \
  "the refused cd leaves the place where it stood"
contains "\`#argument\` selects one of a piece's two cells" \
  "$(said 71 "ls .#argument")" "ls refuses the member on its head"
contains "climbs and selects the \`#argument\` member in one head" \
  "$(said 72 "get ..#argument/items")" \
  "a head that climbs and selects the member in one is refused"
# The route, not the address: the rooted walk left a trail through `slugs/`,
# so two climbs from `first/settings` land on the facet rather than the root.
check "shuttle /slugs/ @space> " "$(prompt 73 "cd ../..")" \
  "two climbs walk the route back out of the piece to the facet it came through"

step "31. A line typed at a view runs where a typed line runs, and the editor takes the screen from one"
# The half no unit case can reach, for the keys a view answers to. Every key
# in the unit suite arrives decoded and every frame comes back as lines, so
# what is asserted there is what the lens does with a key it was handed; here
# the keys are bytes a real terminal decoded, the frame is on a real alternate
# screen, and the editor `e` reaches is a program that takes that screen while
# the frame is holding it.
#
# One record carries all of it. A frame holds back what is written above the
# prompt until it gives the screen up (`announce`, `terminal.ts`), so the three
# lines below are written while the view is up and reach the transcript in the
# order they happened, inside the record of the line that opened the view.
#
# What the record says, in order: the watch was armed and numbered before the
# view opened; `:pwd` ran against the place the shell stands at, which is where
# a typed line runs and not where the view is pointed; and `e` opened the
# watched cell in the editor, which saved it unchanged.
#
# Each of the two lines is waited for by what it drew in the view before the
# next key is typed. The keys of a `@frame` are typed in one go, so without
# that wait the `q` is read while the line before it is still in flight — and a
# view with a line in flight takes no second one, so the `e` would ask for
# nothing and the `q` would close the view out from under the answer.
#
# The first wait is for the value itself, and it is not decoration: a view
# opens before the cell it watches has settled — the frame is drawn as soon as
# the lens is handed over, and the first reading arrives on the subscription,
# one quiet runtime later. A search typed into that window finds `<nothing has
# settled yet>`, draws `no match`, and waits out the session. Typing at a view
# is the one place in this script where the keys can outrun what they are
# about, because every line elsewhere is answered before the next is typed.
#
# The `/written` after it is waited for by what the search drew, which is
# the one of the three the transcript cannot carry: where a search stands is
# drawn on the alternate screen, and `@drawn` is what reads there. `1 of 1` is
# the whole assertion — the pattern was found, once, in the rendering of a cell
# holding `"written once and never again"` — and a search that found nothing
# would draw `no match` and wait out the session instead.
#
# It also holds the two after it to their own subject. A `/` that left the view
# in a state where a key is text would have taken the `:`, the `e` and the `q`
# into a search line, and the view would never have closed.
FRAMED=$(said 75 "watch settings/note")
# Read by position rather than by presence, because the order is half of what
# is being shown: the listing was written before the view took the screen and
# the other two while it held it, so the record heads with the one and ends
# with the last of the others.
check "%1 first/settings/note @space" "$(printf '%s\n' "$FRAMED" | head -1)" \
  "the watch was armed and numbered before the view took the screen"
contains "position  //" "$FRAMED" \
  "a line typed at the view reached the transcript the view held back"
contains "/$FIRST@space" "$FRAMED" \
  "the line ran against the place the shell stands at, not where the view points"
check "Nothing changed, so nothing was written." \
  "$(printf '%s\n' "$FRAMED" | tail -1)" \
  "e opened the watched cell in the editor while the view held the screen"
check "%1 first/settings/note @space" "$(said 76 "watches")" \
  "the view closing left the watch armed, as it does when nothing was typed at it"
check "Disarmed the watch on \`first/settings/note @space\`." \
  "$(said 77 "unwatch %1")" "unwatch disarms the watch the view was opened onto"

step "32. The external working location starts at the process's own directory, and xcd moves it"
# The half no unit test reaches: the location is seeded from `Deno.cwd()` at
# startup, so what proves the seeding is a shell started from a real directory
# rather than one handed a location by a case.
#
# The expected address is built from the directory this harness was standing
# in, not matched against a shape. A shape would pass for any `file:` seed at
# all — a fixed path, or the home directory — which is every way the seeding
# could regress while still writing something that looks right.
EXPECT_SEED=$(python3 -c \
  'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri() + "/")' \
  "$STARTED_IN")
check "$EXPECT_SEED" "$(said 78 "xpwd")" \
  "xpwd writes the directory the shell was started from, whole"
EXPECT_MOVED=$(python3 -c \
  'import pathlib, sys; print((pathlib.Path(sys.argv[1]).parent / "elsewhere").as_uri() + "/")' \
  "$STARTED_IN")
check "$EXPECT_MOVED" "$(said 79 "xcd ../elsewhere")" \
  "xcd writes where it landed, the walk taken against that directory"
check "$EXPECT_MOVED" "$(said 80 "xpwd")" \
  "xpwd afterwards writes what the move wrote, the two being one spelling"

# What step 11 does not reach: a piece that changes under a shell already
# standing on it. Step 11 reads storage before the session and the shell's own
# answer during it, which is what tells a warm read from a stored one; what it
# cannot ask is whether a read taken after an external write mid-session serves
# the new value, because the driver types a script of lines and has nowhere to
# run a command between two of them. It reads a settled prompt already, so that
# is a small addition to it, and the check belongs here once it is made.

rm -f "$SCRIPT" "$TRANSCRIPT" "$EDITOR_SCRIPT"
ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
