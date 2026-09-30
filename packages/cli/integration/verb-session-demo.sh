#!/usr/bin/env bash
# The verb session as it is meant to read: a work tracker driven entirely
# through `cf`, with no tooling written for it.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact. Its companion `verb-session-gaps.sh` asserts
# the same surface as pass/fail and is what keeps this one honest.
#
# docs/common/verbs/session-walkthrough.md is the prose half: why the fixture
# declares the verbs it does, and which shape of the surface each act is here
# to show. An act added here without a row there is an act nobody can place.
#
# Every command in the transcript is one array of words, printed and then run.
# There is no second, prettier spelling of it anywhere in this file: `run` and
# `broken` display `"$@"` and execute `"$@"`, so a line that reads well and a
# line that ran cannot drift apart. What a reader sees is what they can retype,
# given the environment variables the header names.
#
# Every act carries a claim, and the script checks all three kinds: an
# unmarked act says the command works, a REFUSED one says the surface turns
# this down, and a BROKEN one says a named defect is still there. Two further
# helpers, `pending` and `broken`, are defined and unused today — they are how
# an unbuilt or defective capability stays deliberately visible rather than
# being quietly omitted. Each carries its full contract at its definition
# below; a reader who never sees one fire does not need them here.
#
#   API_URL=http://localhost:8000 packages/cli/integration/verb-session-demo.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Run from the repository root so the fixture path a reader sees is the one
# they would type.
cd "$REPO_ROOT" || exit 1
FIXTURE=packages/cli/integration/pattern/tracker.tsx

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
# An invocation session scopes the ids act 7 replays under. It belongs in the
# environment rather than on a command line: it is what keeps an outcome's
# address out of a stranger's reach, and keeping it out of argv keeps it out of
# shell history and the default process listing. That is a reduction in casual
# exposure, not secret storage — `ps -E` prints the environment too.
if [ -z "${CF_INVOCATION_SESSION:-}" ]; then
  CF_INVOCATION_SESSION=$(cf invocation-session new 2>/dev/null)
fi
export CF_INVOCATION_SESSION
if [ -z "${SPACE:-}" ]; then
  # Opening a space never creates it, so the demo makes its own before the
  # first act; `cf space create` prints the new space's DID.
  SPACE=$(cf space create --quiet)
  case "$SPACE" in
    did:key:*) ;;
    *) echo "cf space create printed no DID: $SPACE" >&2; exit 1 ;;
  esac
fi

B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; Y=$'\033[33m'; N=$'\033[0m'
R=$'\033[31m'
# Every act makes a claim: an unmarked one says the command works, a BROKEN one
# says a named defect is still there, a REFUSED one says the surface turns this
# down. All three are counted, so a transcript that got any of them wrong cannot
# exit 0 and read as a clean session.
UNEXPECTED=0
CLOSED=0
UNREFUSED=0
# stderr is read back rather than shown as it arrives, so a failure can be
# printed under the act it belongs to. mktemp rather than a name built from the
# pid: this runs in a shared directory, and a predictable path is one an
# unrelated process can have already made a symlink at.
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
act() { printf '\n%s━━ %s %s\n' "$B" "$1" "$N"; }
say() { printf '%s   %s%s\n' "$D" "$1" "$N"; }

# Render argv the way a person would have typed it, quoting only the words that
# need it. Display only — the same array is what runs.
shown() {
  local line="" word
  for word in "$@"; do
    case $word in
      *[[:space:]\'\"]*) line="$line '$word'" ;;
      *) line="$line $word" ;;
    esac
  done
  printf '%s' "${line# }"
}

# Print a command and run it. Its output is shown and also kept in $OUT, so an
# act that needs an address takes it out of the run the reader just watched.
# stderr is held back rather than dropped: on success it carries only cf's
# next-step hints, which are addressed to a person at a prompt rather than to a
# transcript, but a failure here is the demo being wrong about the surface —
# the thing this script exists to stop — and has to be as visible as the
# transcript it would otherwise sit inside quietly.
run() {
  printf '\n%s   $ %s%s\n' "$C" "$(shown "$@")" "$N"
  OUT=$("$@" 2>"$ERR")
  local rc=$?
  printf '%s\n' "$OUT" | sed 's/^/     /'
  if [ "$rc" != "0" ]; then
    printf '%s     UNEXPECTED FAILURE (exit %s) — this act is not marked BROKEN%s\n' \
      "$R" "$rc" "$N"
    sed 's/^/       /' "$ERR"
    UNEXPECTED=$((UNEXPECTED + 1))
  fi
}

# Same, for a command that fails today: stderr is kept, because the error is
# what the act exists to show. cf's two progress lines are dropped so it stands
# alone.
#
# The BROKEN claim is checked, against the defect's own signature rather than
# against the exit status — #5633 answers 0 and hands back nulls, so a status
# check would call this act healthy today. `$2` is a jq test over stdout that
# holds only while the defect does, and it is the same discriminator
# verb-session-gaps.sh matches on, so the two cannot disagree about whether the
# gap is open. An act asserting a defect that has been fixed is wrong in the
# same way as one hiding a defect that has not.
#
# A future act that breaks by failing outright wants its signature written
# against the exit status, and wants the branch for that written then rather
# than guessed at now.
broken() {
  local why=$1 signature=$2
  shift 2
  printf '\n%s   $ %s%s\n' "$Y" "$(shown "$@")" "$N"
  printf '%s     BROKEN — %s%s\n' "$Y" "$why" "$N"
  local out
  out=$("$@" 2>"$ERR")
  [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/       /'
  grep -v '^invocation:\|^session:' "$ERR" | sed 's/^/       /'
  if ! printf '%s' "$out" | jq -e "$signature" >/dev/null 2>&1; then
    printf '%s     GAP CLOSED — the defect this act names no longer answers to%s\n' \
      "$R" "$N"
    printf '%s     its own signature%s\n' "$R" "$N"
    CLOSED=$((CLOSED + 1))
  fi
}

# Same, for a command that is SUPPOSED to fail: a refusal is a capability, so
# the error is the act's payoff and a nonzero exit is the success condition.
# The inverse of `run`, and checked the same way — an act claiming a refusal
# that the surface no longer makes is as wrong as an act claiming a success it
# does not get, and reports itself rather than printing a result under a line
# that says it was turned down.
refused() {
  local why=$1 signature=$2
  shift 2
  printf '\n%s   $ %s%s\n' "$C" "$(shown "$@")" "$N"
  printf '%s     REFUSED — %s%s\n' "$D" "$why" "$N"
  # Version context adds nothing to an expected refusal, so this act skips
  # the version check. An unexpected failure in `run` keeps that context.
  CF_SKIP_VERSION_CHECK=1 "$@" >/dev/null 2>"$ERR"
  local rc=$?
  grep -v '^invocation:\|^session:\|^TIP:\|^(Use --quiet\|^NEXT STEPS:\|^  *→' \
    "$ERR" | grep -v '^$' | sed 's/^/       /'
  # The claim is matched against the refusal's own message, not the exit
  # status alone: a parser slip or a server hiccup also exits nonzero, and an
  # act that cannot tell those apart keeps its claim through failures that
  # have nothing to do with it — the same discriminator rule
  # verb-session-gaps.sh applies to its gap probe.
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

# Show what a command will do once the capability it needs is built.
pending() {
  printf '\n%s   $ %s%s\n' "$Y" "$1" "$N"
  printf '%s     PENDING — %s%s\n' "$Y" "$2" "$N"
  printf '%s     will print:%s\n' "$D" "$N"
  printf '%s\n' "$3" | sed 's/^/       /'
}

printf '%s\n' "${B}A work tracker, driven entirely through cf${N}"
say "Three words carry the session. A pattern is TypeScript declaring state"
say "and verbs. Deploying one makes a piece — a running instance. Both live in"
say "a space, the shared durable place every command below names with -s."
say ""
say "space $SPACE · nothing here was written for this pattern"
say "CF_API_URL=$CF_API_URL, CF_IDENTITY and CF_INVOCATION_SESSION are exported;"
say "everything else you see"
say "is the whole command."

act "1 · Arrive by name"
say "A slug is a name in the space: the board is 'board' from here on, and the"
say "fid this command prints is never typed again."
run cf piece new "$FIXTURE" -s "$SPACE" --slug board
say "The name is discoverable, not folklore: the space lists its slugs, so a"
say "session in a space someone else populated starts from this same command."
run cf piece slugs -s "$SPACE"

act "2 · Ask what it is, and what it can do"
say "One command is the piece's man page: name, purpose, state, inputs, and"
say "verbs. Every sentence on it is a doc comment from tracker.tsx, compiled"
say "with the pattern and read back from it — nothing is authored for cf."
run cf piece describe -s "$SPACE" --piece board
say "And the callable rows again as a table, the shape a client matches"
say "against. Both are derived from the deployed pattern, not from a manifest."
run cf piece verbs -s "$SPACE" --piece board
say "In the table, ON names the cell a verb lives on. MARKS flags wrapper or"
say "deprecated rows — hidden by default and listed under --all, so the column"
say "is blank on a board that declares none. The listings all take --json for"
say "tooling; reads and calls already answer in JSON."

act "3 · Ask what a verb wants"
say "Flags, types, required-ness and result all come from the author's TypeScript."
run cf piece call -s "$SPACE" --piece board addItem --help

act "4 · Create, and act on what you were handed"
say "The create returns the piece it made. Its address is the next command's target."
say ""
say "--select names the shape of the answer, and this is its first use, so:"
say "a comma-separated list of fields, a dot to walk into one, and a trailing"
say "@ meaning 'the address of this position, not the contents behind it'."
say "So item@ says hand back where the new item lives rather than a copy of"
say "it — and an address is what the rest of the session is built on."
say ""
say "It is written past the -- and not before the verb, because a result has"
say "to be named before it can be shaped. The verb opens its own section and"
say "-- closes it: the verb's fields stand between them, the read options"
say "after. Reading the line left to right is reading it in the order the"
say "words become knowable."
run cf piece call -s "$SPACE" --piece board addItem --title "Login rewrite" -- --select item@
say "The @ renders under the key \$link, which is the spelling every address"
say "in this transcript arrives in. Capturing one in your own shell is a single"
say "jq hop — and the quotes around \$link are load-bearing, since jq reads a"
say "bare \$link as one of its own variables:"
say ""
say "    jq -r '.result.item.\"\$link\"'"
say ""
say "That is the exact expression the next line of this script runs against the"
say "output you just saw — not a second call."
# The address the reader can see in the output above, carried whole. Taken
# from that run, not from a second one: `run` leaves the output it displayed
# in $OUT. It is one reference string, used exactly as printed: `get` and
# `call` take it as their first positional — an address begins with `/` and a
# relative path never does, so nothing marks it but itself — and `verbs`
# takes it on --piece. Nothing here strips the scheme: the bare hash is a
# different spelling that resolves by defaulting to `of:`, not the same
# address — the scheme is part of the identity.
EPIC=$(printf '%s' "$OUT" | jq -r '.result.item."$link"')
say "That address is the whole of what later commands need, exactly as printed."
say "Ask it the same question act 2 asked the board, before assuming anything"
say "about what it can do."
run cf piece verbs -s "$SPACE" --piece "$EPIC"
say "Every verb an item has, and not the board's one: the listing is derived"
say "from the piece in front of you, so an address is enough to discover a"
say "surface you were never told about."
say "The address serves the man page too — the item's own purpose, its state"
say "fields' prose, and a summary line per verb, all from the item's author."
run cf piece describe -s "$SPACE" --piece "$EPIC"
say "On get and call the address needs no flag at all: it begins with '/' and"
say "a path never does, so it stands bare in the first position."
run cf piece call -s "$SPACE" "$EPIC" addChild --title "Session cookies"
say "The item it hands back can be reached from inside itself: its parent holds"
say "it, and it holds its parent. The position where the author's own type"
say "re-enters answers with an address, so the whole result is still one value."
# The verb opens the callable's section and `--` closes it: --title is a field
# of addChild's and stands before the marker, and the read options follow it.
run cf piece call -s "$SPACE" "$EPIC" addChild --title "CSRF tokens" -- --select item.title
say "And a caller who names one field is given one field, circle or no circle."
say "item.title is the dotted form: it walks into item and keeps title. Note it"
say "prunes rather than flattens — the answer is still shaped like the result,"
say "with everything the caller did not ask for gone."

act "5 · Read addresses instead of contents"
say "The same two spellings, now on a read of a collection. An unshaped read"
say "follows every link and copies what it finds; @ on its own names the"
say "position being read rather than its contents, and applies to each element"
say "when it crosses an array — so this asks for every child's address, with"
say "its title beside it."
run cf cell get -s "$SPACE" "$EPIC" children --select @,title

act "6 · Ask the same question twice"
say "The same command as act 5, deliberately — because the first thing anyone"
say "watching a live system says is 'show me that again'."
run cf cell get -s "$SPACE" "$EPIC" children --select @,title
say "The same answer. A projection is a question you may ask twice, which is"
say "what makes any of the reads above safe to put in a script — as here: the"
say "child the next acts drive is taken from the answer just shown."
# From the run the reader watched, not from a hidden second read: acts 8 and 9
# drive the first child, act 12 relates it to the second, and both addresses
# sit in $OUT under the titles they were filed with.
KID=$(printf '%s' "$OUT" | jq -r '.[] | select(.title=="Session cookies")."$link"')
CSRF=$(printf '%s' "$OUT" | jq -r '.[] | select(.title=="CSRF tokens")."$link"')

act "7 · A verb returns what only the pattern could compute"
say "The note's timestamp is the pattern's; the caller never supplied one."
run cf piece call -s "$SPACE" "$EPIC" recordNote --body "blocked on the cookie spec"
# The receipt out of the run just shown, not a second call. Every invocation
# envelope carries one, and it is an address like any other.
RECEIPT=$(printf '%s' "$OUT" | jq -r '.receipt')
say "Act 6 asked a read twice. A call cannot be asked twice — it would run the"
say "handler again — but it does not need to be: the outcome is durable at an"
say "address, and every envelope above has carried it as 'receipt'."
run cf cell get -s "$SPACE" "$RECEIPT" --select note,noteCount
say "The same outcome, without calling anything again. Note what this does"
say "NOT prove on its own: a receipt is a frozen snapshot of what its handling"
say "committed, so it reports that outcome whether or not anything else has"
say "happened since. The board is the only place that can settle it, and this"
say "act reads it at the end."
say ""
say "That route needs the address. The other one is for when you never got it"
say "— a dropped connection, a response nobody saw. Name the call with an"
say "--invocation id and the id itself becomes the handle."
run cf piece call -s "$SPACE" --invocation note-retry "$EPIC" recordNote --body "first attempt"
say "Replaying that id hands back the original. The payload below is"
say "deliberately different text, and it does not take:"
run cf piece call -s "$SPACE" --invocation note-retry "$EPIC" recordNote --body "a different body entirely"
say "Same body, same receipt — and deduplicated: true, a field the first call"
say "did not carry. The same caution applies: a replay is DEFINED to hand the"
say "original snapshot back, so the envelope would look like this whether or"
say "not a second note actually landed. An id"
say "is only half the handle: it is scoped to an invocation session, so one"
say "agent's note-retry is not another's, which is why the session is exported"
say "above rather than typed here."
say "So read the board, which is where a second note would show up. Two"
say "entries, from the two calls that committed — and the replay's text is"
say "not among them:"
run cf cell get -s "$SPACE" "$EPIC" notes --select body
say "That is the proof, and it is the only one that holds: the envelopes"
say "above could not have told you."
say "The caveat that keeps this honest: the replay DOES run the handler body"
say "again, and then loses the race for the receipt. Nothing commits twice,"
say "but a verb that sends mail or spends a model call has already done it."

act "8 · Finishing reports what the caller could not know"
say "openBelow walks the whole subtree — a caller would need N reads to learn it."
say "A grandchild is filed first, under the child act 6 handed back, so there"
say "is a subtree to walk."
run cf piece call -s "$SPACE" "$KID" addChild --title "Rotate signing key" -- --select item.title
run cf piece call -s "$SPACE" "$EPIC" finish --body "shipping behind a flag"

act "9 · A verb that declares no result"
say "archive is Stream<void>: nothing to supply, nothing handed back. The call"
say "is the verb's name alone, and the invocation settles carrying no result"
say "at all."
run cf piece call -s "$SPACE" "$KID" archive
say "What it changed is a read away, on the one field the caller never sets —"
say "and the address may carry the path, so one word names the piece and the"
say "field in it."
run cf cell get -s "$SPACE" "$KID/status"

act "10 · Step back and read the board"
say "Every change so far was seen one call at a time. One read from the name"
say "the session started with shows the tree they add up to."
run cf cell get -s "$SPACE" --piece board items --select title,status,children@
say "Act 8 paid one verb call for depth — openBelow walked the subtree. Breadth"
say "is a read: a filter decides membership before projection, so status picks"
say "the elements and only title comes back."
run cf cell get -s "$SPACE" "$EPIC" children --select title --filter '.status == "open"'
# The two halves of that question do not combine, and the refusal's own message
# carries the reason, so nothing restates it here.
refused "an address suffix under a filter" \
  "cannot be combined with an \`@\` suffix" \
  cf cell get -s "$SPACE" "$EPIC" children \
  --select @,title --filter '.status == "open"'

act "11 · Ask for something that is not there"
say "Every act so far named something the pattern declares. Getting it wrong is"
say "the other half of a surface knowing its own vocabulary."
# The payload carries `title` as well as the typo, so what is being refused is
# the undeclared field and nothing else. A payload of the typo alone is refused
# for missing a required property instead — the same exit code for a different
# reason, and an act that cannot tell those apart would read the same before and
# after this capability arrived.
refused "a field the verb does not declare" \
  "is not a field this verb declares" \
  cf piece call -s "$SPACE" --piece board addItem \
  '{"title":"Ship it","titel":"typo"}'
refused "a keyword the projection reader does not recognize" \
  "is not a projection schema keyword" \
  cf cell get -s "$SPACE" "$EPIC" children \
  --schema '{"type":"array","items":{"type":"object","propertes":{"title":true}}}'
say "One shape of answer from both ends: what was wrong, the position it sat at,"
say "what that position accepts, and the nearest thing you probably meant. The"
say "call was turned down before an invocation was spent."

act "12 · Relate two items"
say "The tracker is a graph, not just a tree: an item can wait on any other."
say "The spelling this session taught throughout — the address as printed —"
say "stands where the verb declares a reference, and the edge that lands is"
say "the target itself rather than a copy."
run cf piece call -s "$SPACE" "$KID" blockOn --on "$CSRF" -- --select blocked@,on@,blockedOnCount
say "The two payloads that could only ever be mistakes at a reference"
say "position are refused naming it: a string that is no address, and an"
say "inline copy — which would store a detached document inside this item"
say "and report success."
refused "a string that is not an address, where a reference is declared" \
  "is not an address" \
  cf piece call -s "$SPACE" "$KID" blockOn --on "not-an-address"
refused "an inline copy at a reference position" \
  "detached document" \
  cf piece call -s "$SPACE" "$KID" blockOn '{"on":{"title":"a copy"}}'

act "13 · One item, two paths, one address"
say "This is what addresses are for: the same item under a parent AND as a"
say "blocker, and a caller can tell it is one item rather than two copies."
run cf cell get -s "$SPACE" "$EPIC" children --select @,title,blockedOn@
say "One address, two positions: the same string sits in the row that holds"
say "the item and in the blockedOn of the item that waits on it."

printf '\n%s━━ %s %s\n' "$B" "What just happened" "$N"
say "No tool was written for this tracker. Every flag, type, listing, man"
say "page and result field above was derived from the pattern's own"
say "TypeScript by cf."
say ""
say "One name was typed: 'board'. Everything under it was addressed by the"
say "address a call handed back, standing bare where a flag used to be — which"
say "is the composition the verb surface exists for. On those lines the flags"
say "that remain name the space and shape the answer; the slug keeps --piece,"
say "and a verb's own flags stay the verb's."
say ""
say "Acts 12 and 13 are the graph half: the printed address stands as a verb"
say "argument where the pattern declares a reference, and one address read"
say "back from two positions is what proves the board holds an edge rather"
say "than a copy."

if [ "$UNEXPECTED" != "0" ]; then
  printf '\n%s━━ %d act(s) failed that this demo says work%s\n' \
    "$R" "$UNEXPECTED" "$N"
  say "Every act above that is not marked BROKEN is a claim about the surface."
  say "One of them did not hold, so this transcript does not describe cf."
fi

if [ "$UNREFUSED" != "0" ]; then
  printf '\n%s━━ %d act(s) marked REFUSED did not get their refusal%s\n' \
    "$R" "$UNREFUSED" "$N"
  say "A refusal this demo shows as a capability is no longer being made as"
  say "claimed: the call was accepted, or it failed for some other reason —"
  say "either way the act's claim about the surface did not hold."
fi

if [ "$CLOSED" != "0" ]; then
  printf '\n%s━━ %d act(s) marked BROKEN no longer match their signature%s\n' \
    "$R" "$CLOSED" "$N"
  say "Either the capability arrived, or the signature needs rewriting. Both"
  say "want this demo and verb-session-gaps.sh changed together — they match on"
  say "the same evidence so that neither can go stale alone."
fi

[ "$UNEXPECTED" = "0" ] && [ "$CLOSED" = "0" ] && [ "$UNREFUSED" = "0" ]
