#!/usr/bin/env bash
# Reading and writing a piece's cells as something to watch — the half of the
# CLI a caller reaches for before any verb: a shaped read, the two cells one
# piece has and the flag that chooses between them, the `#argument` suffix
# that spells the same choice on the target, the write that runs nothing, the
# step that recomputes, and the wish that answers with an address it had to
# write a cell to find.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact.
#
# Every command that runs is one array of words, printed and then run. There
# is no second, prettier spelling of it anywhere in this file: `run` displays
# `"$@"` and executes `"$@"`, and every act re-parses its own displayed line
# and compares the words against the argv that ran, so a line a reader
# retypes is the line that executed — checked, not asserted. `run_stdin`
# renders the `echo … |` half from the same payload it pipes, so the two
# cannot disagree either.
#
#   API_URL=http://localhost:8000 packages/cli/integration/read-write-demo.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Run from the repository root so the fixture path a reader sees is the one
# they would type.
cd "$REPO_ROOT" || exit 1
FIXTURE=packages/cli/integration/pattern/thermostat.tsx

# `cf` is this checkout's CLI as a shell function. That is what lets a command
# be a plain array of words rather than a string assembled twice.
if [ -n "${CF_BINARY:-}" ]; then
  cf() { "$CF_BINARY" "$@"; }
else
  cf() { deno task --quiet --cwd "$REPO_ROOT" cf "$@"; }
fi

# The connection lives in the environment cf documents, so it stays off every
# command line. The space cannot: cf has no environment variable for it, so
# `-s` is on each command, exactly as a reader would have to type it.
export CF_API_URL="${CF_API_URL:-${API_URL:-http://localhost:8000}}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  cf id new >"$CF_IDENTITY" 2>/dev/null
fi
export CF_IDENTITY

B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; N=$'\033[0m'
R=$'\033[31m'
# Every act makes a claim: an unmarked one says the command works, a REFUSED
# one says the surface turns this down. Both are counted, so a transcript that
# got either wrong cannot exit 0 and read as a clean session.
UNEXPECTED=0
UNREFUSED=0
MISRENDERED=0
# stderr is read back rather than shown as it arrives, so a failure can be
# printed under the act it belongs to. mktemp rather than a name built from
# the pid: this runs in a shared directory, and a predictable path is one an
# unrelated process can have already made a symlink at.
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
act() { printf '\n%s━━ %s %s\n' "$B" "$1" "$N"; }
say() { printf '%s   %s%s\n' "$D" "$1" "$N"; }

# Render one word the way a person would have typed it: bare when every
# character is shell-inert, single-quoted otherwise, and an embedded single
# quote spelled '\'' — close, escaped quote, reopen — the one spelling a
# POSIX shell reparses to the original word.
q_word() {
  case $1 in
    *\'*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    ''|*[![:alnum:]./=@:,_+-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Render argv the way a person would have typed it. Display only — the same
# array is what runs — and `retypable` holds the two to each other.
shown() {
  local line="" word
  for word in "$@"; do
    line="$line $(q_word "$word")"
  done
  printf '%s' "${line# }"
}

# The transcript's central invariant, checked on every act: the displayed
# line, re-parsed by the shell, is the argv that ran. The re-parse is an
# eval into an array — safe here because the line is this script's own
# rendering of its own argv, and quoting keeps every expansion inert — and
# a mismatch counts against the transcript like any other broken claim.
retypable() {
  local line=$1
  shift
  local -a reparsed=()
  eval "reparsed=($line)" 2>/dev/null
  if [ "$(printf '%s\037' "${reparsed[@]}")" != "$(printf '%s\037' "$@")" ]; then
    printf '%s     MISRENDERED — retyping the line above would not run this act%s\n' \
      "$R" "$N"
    MISRENDERED=$((MISRENDERED + 1))
  fi
}

# The held-back stderr, minus the connection preamble and the interactive
# tip. What survives is cf's own next-step advice, and for the write acts
# that advice is part of what this demo exists to show.
hints() {
  grep -v \
    '^invocation:\|^session:\|^(Use --quiet\|^Experimental flag\|^NEXT STEPS:\|^  *→\|^$' \
    "$ERR" | sed "s/^/     ${D}·${N} /"
}

report_failure() {
  printf '%s     UNEXPECTED FAILURE (exit %s)%s\n' "$R" "$1" "$N"
  sed 's/^/       /' "$ERR"
  UNEXPECTED=$((UNEXPECTED + 1))
}

# Print a command and run it. Its output is shown and also kept in $OUT, so an
# act that needs an address takes it out of the run the reader just watched.
# stderr is held back rather than dropped: on success it carries only cf's
# next-step hints, but a failure here is the demo being wrong about the
# surface and has to be as visible as the transcript it would otherwise sit
# inside quietly.
run() {
  local line
  line=$(shown "$@")
  printf '\n%s   $ %s%s\n' "$C" "$line" "$N"
  retypable "$line" "$@"
  OUT=$("$@" 2>"$ERR")
  local rc=$?
  printf '%s\n' "$OUT" | sed 's/^/     /'
  [ "$rc" = "0" ] || report_failure "$rc"
}

# `run`, with the held-back hints shown after the output.
run_loud() {
  run "$@"
  hints
}

# `run`, for a command that reads its value from stdin. The displayed `echo`
# half is rendered from the same payload the pipe carries, so the line a
# reader retypes carries the value that was written. Always loud: every write
# here answers with cf's own advice about what a write does not do, and that
# advice is the act.
run_stdin() {
  local payload=$1
  shift
  local line
  line=$(shown "$@")
  printf '\n%s   $ echo %s | %s%s\n' "$C" "$(q_word "$payload")" "$line" "$N"
  retypable "$line" "$@"
  OUT=$(printf '%s\n' "$payload" | "$@" 2>"$ERR")
  local rc=$?
  printf '%s\n' "$OUT" | sed 's/^/     /'
  hints
  [ "$rc" = "0" ] || report_failure "$rc"
}

# `run`, for a command that is SUPPOSED to fail: a refusal is a capability, so
# the error is the act's payoff and a nonzero exit is the success condition.
# The claim is matched against the refusal's own message, not the exit status
# alone: a parser slip or a server hiccup also exits nonzero, and an act that
# cannot tell those apart keeps its claim through failures that have nothing
# to do with it.
refused() {
  local why=$1 signature=$2
  shift 2
  local line
  line=$(shown "$@")
  printf '\n%s   $ %s%s\n' "$C" "$line" "$N"
  retypable "$line" "$@"
  printf '%s     REFUSED — %s%s\n' "$D" "$why" "$N"
  CF_SKIP_VERSION_CHECK=1 "$@" >/dev/null 2>"$ERR"
  local rc=$?
  grep -v '^invocation:\|^session:\|^TIP:\|^(Use --quiet\|^NEXT STEPS:\|^  *→\|^Experimental flag' \
    "$ERR" | grep -v '^$' | sed 's/^/       /'
  if [ "$rc" = "0" ]; then
    printf '%s     NOT REFUSED — this act says the surface turns this down,%s\n' \
      "$R" "$N"
    printf '%s     and it was accepted%s\n' "$R" "$N"
    UNREFUSED=$((UNREFUSED + 1))
  elif ! grep -q "$signature" "$ERR"; then
    printf '%s     REFUSED FOR ANOTHER REASON — the failure above is not the%s\n' \
      "$R" "$N"
    printf '%s     refusal this act claims%s\n' "$R" "$N"
    UNREFUSED=$((UNREFUSED + 1))
  fi
}

# A space named in $SPACE is used as it stands; otherwise the identity creates
# one, since opening a space never creates it. `cf space create` prints the
# new space's DID. It runs before the first act, so its stderr is held back
# like every act's, and shown only when the create fails: a server that is
# down fails here, and what cf said is then the whole transcript.
if [ -z "${SPACE:-}" ]; then
  SPACE=$(cf space create --quiet 2>"$ERR")
  CREATE_STATUS=$?
  if [ "$CREATE_STATUS" -ne 0 ] || [ -z "$SPACE" ]; then
    printf '%scf space create against %s exited %s and printed no space, so no act ran:%s\n' \
      "$R" "$CF_API_URL" "$CREATE_STATUS" "$N" >&2
    sed 's/^/  /' "$ERR" >&2
    exit 1
  fi
fi

printf '%s\n' "${B}Reading and writing a piece, watched end to end${N}"
say "A piece answers two questions a caller asks constantly: what does it"
say "hold, and how do I change it. The reads are queries — you name the shape"
say "you want. The writes are the surprising half: a write addresses a cell,"
say "and addressing a cell is not running a program."
say ""
say "space $SPACE · CF_API_URL=$CF_API_URL · CF_IDENTITY exported;"
say "everything else you see is the whole command."

act "1 · A piece to read and write"
say "A thermostat: a target a caller writes, the zones it watches, and two"
say "figures derived from both. The slug names it, so no fid is ever typed."
run cf piece new "$FIXTURE" -s "$SPACE" --slug thermostat

act "2 · Two cells behind one piece"
say "The piece's own page splits what it holds by who writes it. INPUTS are"
say "what a caller supplied; STATE is what the pattern produced from them —"
say "and targetFahrenheit and belowTarget appear only under STATE, because"
say "nothing supplied them."
run cf piece describe -s "$SPACE" --piece thermostat
say "Those are two cells, not two views of one. A read goes to the result"
say "cell; --input sends it to the arguments cell instead, which holds only"
say "what the pattern declared as input — here, links to target and zones."
run cf cell get -s "$SPACE" --piece thermostat --input
say "So a derived field has no position in the arguments cell at all, and"
say "asking for one there names the keys that are:"
refused "a derived field lives on the result cell, not on the arguments cell" \
  "Available keys: target, zones" \
  cf cell get -s "$SPACE" --piece thermostat targetFahrenheit --input

act "3 · A read is a query: name the shape you want"
say "Unshaped, a read carries everything the result cell holds — including"
say "the verb handle, which is a link and not data anyone asked for."
run cf cell get -s "$SPACE" --piece thermostat
say "--select names fields and keeps nothing else."
run cf cell get -s "$SPACE" --piece thermostat --select target,targetFahrenheit,belowTarget
say "--filter decides membership in an array, with a jq-inspired predicate."
run cf cell get -s "$SPACE" --piece thermostat zones --filter '.celsius < 20'
say "--schema is the same projection written as JSON Schema — the spelling a"
say "program generates rather than types."
run cf cell get -s "$SPACE" --piece thermostat zones \
  --schema '{"type":"array","items":{"type":"object","properties":{"name":true}}}'

act "4 · A write lands on the result cell unless you say otherwise"
say "cf cell set reads its value from stdin and addresses the RESULT cell by"
say "default — the pattern's output, not its input. --input is what sends it"
say "to the arguments cell, which is the flag's own wording: 'instead of"
say "result cell'."
run_stdin '25' cf cell set -s "$SPACE" --piece thermostat target
say "The target moved. The two figures derived from it did not."
run cf cell get -s "$SPACE" --piece thermostat --select target,targetFahrenheit,belowTarget
say "68F is 20C and 2 is the count against 20 — both answers to the target"
say "that was there before this write. Nothing recomputed them, because a"
say "write is a write: it commits a value to a cell and runs no program."

act "5 · cf piece step is the recomputation"
say "A derived value moves when something observes the piece, and a CLI"
say "process that writes and exits never does. cf piece step is the command"
say "whose whole job is to be that observer: start the piece, let the graph"
say "settle, sync what it wrote, stop."
run cf piece step -s "$SPACE" --piece thermostat
say "Same read as before the step, and now both figures answer to 25."
run cf cell get -s "$SPACE" --piece thermostat --select target,targetFahrenheit,belowTarget

act "6 · Writing a derived field, and what the next step does to it"
say "Nothing stops a write landing on a derived field: it is a position in"
say "the result cell like any other, and the write is accepted."
run_stdin '100' cf cell set -s "$SPACE" --piece thermostat targetFahrenheit
run cf cell get -s "$SPACE" --piece thermostat --select targetFahrenheit
say "It reads back exactly as written — and survives only until something"
say "recomputes it. The pattern owns that position, so the next step puts"
say "the derived answer back."
run cf piece step -s "$SPACE" --piece thermostat
run cf cell get -s "$SPACE" --piece thermostat --select targetFahrenheit

act "7 · The arguments cell, by flag and by suffix"
say "--input sends the same write to the arguments cell."
run_stdin '15' cf cell set -s "$SPACE" --piece thermostat target --input
run cf cell get -s "$SPACE" --piece thermostat target --input
say "The other spelling of that choice rides the address. Ask the piece for"
say "its own — @ alone answers with the address of what is being read —"
run cf cell get -s "$SPACE" --piece thermostat --select @
ADDRESS=$(printf '%s' "$OUT" | jq -r '."$link"')
say "— and a trailing #argument on that address selects the same cell --input"
say "does, on both the read and the write."
run cf cell get -s "$SPACE" "$ADDRESS#argument" target
run_stdin '30' cf cell set -s "$SPACE" "$ADDRESS#argument" target
run cf cell get -s "$SPACE" --piece thermostat target --input
say "A slug and a bare id designate the piece a reference designates, so the"
say "selection written after one means what it means after the other. Here the"
say "slug reads back the cell the address just wrote to:"
run cf cell get -s "$SPACE" --piece 'thermostat#argument' target
say "And a command that takes no --input takes no #argument either, so a"
say "call cannot quietly be aimed at the arguments cell:"
refused "a command without --input has no arguments cell to select" \
  'does not take' \
  cf piece call -s "$SPACE" "$ADDRESS#argument" setTarget '{"celsius":21}'

act "8 · A verb writes, and leaves the derived fields behind just the same"
say "A verb is how a pattern changes its own state: the handler runs inside"
say "the piece, and what it returns is computed there. Watch what it hands"
say "back —"
run cf piece call -s "$SPACE" --piece thermostat setTarget --celsius 10
say "— and then read the piece. The target is the verb's; the derived fields"
say "still answer to the target the last step saw. Settlement is the"
say "handler's commit, not the recomputation that commit sets off, so a call"
say "is no more of an observer than a set is."
run cf cell get -s "$SPACE" --piece thermostat --select target,targetFahrenheit,belowTarget
say "One step, and the whole piece agrees with itself again."
run cf piece step -s "$SPACE" --piece thermostat
run cf cell get -s "$SPACE" --piece thermostat --select target,targetFahrenheit,belowTarget

act "9 · A query instead of an address, and the read that writes"
say "Every read so far named its target. cf wish names a query and lets the"
say "space answer with what matches — here the registry of pieces, projected"
say "to addresses rather than contents."
run cf wish -s "$SPACE" '#pieceRegistry' --select @
FOUND=$(printf '%s' "$OUT" | jq -r '.[0]."$link"')
say "That address is an ordinary one: it goes into a read unedited."
run cf cell get -s "$SPACE" "$FOUND" --select target,belowTarget
say "Resolving a wish is not free the way a get is. It runs a one-node"
say "pattern to hold the query and commits it, so the resolution is a WRITE"
say "against the space — the one command here that reads like a query and"
say "is not effect-free."

printf '\n%s━━ The shape of it %s\n' "$B" "$N"
say "A piece has two cells and one flag that chooses between them, spelled"
say "again as a suffix on a reference, a bare id or a slug. A read shapes"
say "its own answer and changes nothing. A write commits a value and runs"
say "nothing — not a set, and not a verb call either — so a derived field"
say "keeps answering to the state it was last computed from until cf piece"
say "step observes the piece."
say "And the one read here that is not free is the one that never named an"
say "address: a wish resolves by writing."
say ""
say "docs/common/workflows/reading-and-writing.md is the tour written from"
say "this session, and check-verb-session-sync holds it to these commands."

if [ "$UNEXPECTED" != "0" ]; then
  printf '\n%s━━ %d act(s) failed that this demo says work%s\n' \
    "$R" "$UNEXPECTED" "$N"
  say "Every act above that is not marked REFUSED is a claim about the"
  say "surface. One of them did not hold, so this transcript does not"
  say "describe cf."
fi

if [ "$UNREFUSED" != "0" ]; then
  printf '\n%s━━ %d act(s) marked REFUSED did not get their refusal%s\n' \
    "$R" "$UNREFUSED" "$N"
  say "A refusal this demo shows as a capability is no longer being made as"
  say "claimed: the call was accepted, or it failed for some other reason —"
  say "either way the act's claim about the surface did not hold."
fi

if [ "$MISRENDERED" != "0" ]; then
  printf '\n%s━━ %d displayed line(s) would not run their act if retyped%s\n' \
    "$R" "$MISRENDERED" "$N"
  say "The transcript's one invariant is that a shown line re-parses to the"
  say "argv that ran. One did not, so this transcript is not retypable."
fi

[ "$UNEXPECTED" = "0" ] && [ "$UNREFUSED" = "0" ] && [ "$MISRENDERED" = "0" ]
