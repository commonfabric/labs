#!/usr/bin/env bash
# Bulk piece operations as something to watch — the whole built surface of
# docs/plans/piece-bulk-operations.md, live rather than asserted: a board of
# 113 members surveyed in one process, the plan it emits, the retarget stamp,
# the containment refusal, a repair (a fixer run dry, applied from its own
# plan, and resumed as landed), the retarget that plan carries applied over
# grouped sessions, the after-survey diffed against the plan it verifies, and
# the reversal derived from that same plan and applied — down to one piece
# returned to one revision of its own log.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact. Its companion `bulk-survey-drill.sh` asserts
# the same surface as pass/fail in CI and is what keeps this one honest.
#
# Every command that runs is one array of words, printed and then run. There
# is no second, prettier spelling of it anywhere in this file: `run` displays
# `"$@"` and executes `"$@"`, and every act re-parses its own displayed line
# and compares the words against the argv that ran, so a line a reader
# retypes is the line that executed — checked, not asserted. Unlike the
# verb-session demo this one carries no `broken` helper: nothing in the
# running surface is defective, and that helper arrives when an act needs its
# claim.
#
#   API_URL=http://localhost:8000 packages/cli/integration/bulk-ops-demo.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Run from the repository root so the fixture path a reader sees is the one
# they would type.
cd "$REPO_ROOT" || exit 1
BOARD_FIXTURE=packages/cli/integration/pattern/bulk-board.tsx
MEMBER_FIXTURE=packages/cli/integration/pattern/bulk-member.tsx
RETARGET_FIXTURE=packages/cli/integration/pattern/bulk-member-v2.tsx

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
WORK="$(mktemp -d)"

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
  if [ "$rc" != "0" ]; then
    printf '%s     UNEXPECTED FAILURE (exit %s)%s\n' "$R" "$rc" "$N"
    sed 's/^/       /' "$ERR"
    UNEXPECTED=$((UNEXPECTED + 1))
  fi
}

# `run`, with the held-back stderr hints shown after the output. The survey
# addresses its tally and its validator findings to a person as hints, and
# for the survey acts those hints are part of what this demo exists to show —
# hiding them would demonstrate a quieter command than the one that ran.
run_loud() {
  run "$@"
  # The connection preamble and the interactive tip are dropped: the tally
  # and the write confirmation are the hints this transcript is showing.
  grep -v \
    '^invocation:\|^session:\|^(Use --quiet\|^Experimental flag\|^$' \
    "$ERR" | sed "s/^/     ${D}·${N} /"
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

printf '%s\n' "${B}A board-sized survey, watched end to end${N}"
say "A board holds a collection of member pieces it created through its own"
say "verb — which is exactly why the piece registry does not know them. The"
say "survey reads the collection the registry cannot see, one cheap identity"
say "read per member, and emits a plan: the artifact every later bulk stage"
say "consumes (docs/plans/piece-bulk-operations.md)."
say ""
say "space $SPACE · CF_API_URL=$CF_API_URL · CF_IDENTITY exported;"
say "everything else you see is the whole command."

act "1 · A board, and members filed through its verb"
say "The board arrives with a name, so no fid is ever typed again."
run cf piece new "$BOARD_FIXTURE" -s "$SPACE" --slug board
say "Three members through the verb, one by one —"
run cf piece call -q -s "$SPACE" --piece board addMember '{"title":"alpha"}'
run cf piece call -q -s "$SPACE" --piece board addMember '{"title":"beta"}'
run cf piece call -q -s "$SPACE" --piece board addMember '{"title":"gamma"}'

act "2 · Board-sized in one call"
say "113 matches the motivating Topics board. The remaining 110 arrive as one"
say "dispatch, because a demo should spend its time surveying, not seeding."
run cf piece call -q -s "$SPACE" --piece board seedMembers '{"count":110}'

act "3 · The survey"
say "One process, the whole collection: a plan row per member, the holder"
say "last, and a tally answering 'do these pieces all agree?' without reading"
say "every row."
run_loud cf piece survey -s "$SPACE" --piece board --path items --out "$WORK/plan.jsonl"
say "The plan is line-oriented JSON: a header that accounts for the"
say "selection, then one row per piece. The header —"
run sh -c "head -1 '$WORK/plan.jsonl' | jq -c '{selector, enumerated}'"
say "— and the first member row and the holder row. Every row records the"
say "identity the piece runs today and whether that source is still retained:"
say "the rollback question, answered before any write is planned."
run sh -c "sed -n 2p '$WORK/plan.jsonl' | jq ."
run sh -c "tail -1 '$WORK/plan.jsonl' | jq ."
run sh -c "wc -l < '$WORK/plan.jsonl'"

act "4 · One piece's pin, without running it"
say "The same identity fact the survey reads per member, as a single lookup:"
say "no piece started, no input or result pulled."
run cf piece inspect -s "$SPACE" --piece board --pattern-identity

act "5 · A survey that carries the operation"
say "The plan can carry the work as well as the record: a retarget stamped"
say "onto every row whose phase matches, pinned to the identity the on-disk"
say "source produces — not to a path that could drift before the apply."
run_loud cf piece survey -s "$SPACE" --piece board --path items \
  --retarget "items=$RETARGET_FIXTURE@v2" --main-export Member \
  --out "$WORK/retarget.jsonl"
say "One member row now: expect is where the piece stands, op is where this"
say "plan will take it."
run sh -c "sed -n 2p '$WORK/retarget.jsonl' | jq '{piece, expect, op}'"

act "6 · The survey is a live read"
say "File one more member, survey again: the count moves. No cache to"
say "invalidate, nothing to refresh."
run cf piece call -q -s "$SPACE" --piece board addMember '{"title":"delta"}'
run_loud cf piece survey -s "$SPACE" --piece board --path items --out "$WORK/after.jsonl"
run sh -c "head -1 '$WORK/after.jsonl' | jq -c .enumerated"

act "7 · A repair: the fixer is the work, the spine is the tooling"
say "Stage 2, live. A fixer is a TypeScript module default-exporting a pure"
say "transform from a piece's stored document to the document it should"
say "hold. The tooling owns selection, ordering, the write, the stop, and"
say "resume; the fixer owns only what the change is."
cat > "$WORK/fix-titles.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => ({
  ...document,
  ...(typeof document.title === "string"
    ? { title: (document.title as string).toUpperCase() }
    : {}),
});
FIXER
run cat "$WORK/fix-titles.ts"
say "Dry by default: the exact per-piece diff, and no write at all. Every"
say "plan row records the document hash its verdict was computed from — the"
say "repair row's precondition — and the fixer it was evaluated for."
run_loud cf piece repair -s "$SPACE" --piece board --path items \
  --fixer "$WORK/fix-titles.ts" --out "$WORK/repair.jsonl"
run sh -c "sed -n 2p '$WORK/repair.jsonl' | jq '{piece, hash: .expect.documentHash, op}'"
say "The plan drives the apply: its rows, in its order, each row checked"
say "against its recorded hash in the same transaction that writes it."
run_loud cf piece repair -s "$SPACE" --piece board --path items \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply \
  --out "$WORK/applied.jsonl"
say "Resume is the same command again: a repaired document is one the fixer"
say "no longer changes, so a completed plan re-runs as landed and writes"
say "nothing."
run_loud cf piece repair -s "$SPACE" --piece board --path items \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply \
  --out "$WORK/applied.jsonl"

act "8 · The retarget: the plan carried, then applied"
say "Stage 3, live. The plan is the whole input — it names the pieces, the"
say "reference each must still be on, and the source each moves to — so the"
say "command carries no selection of its own. Dry by default: every row"
say "classified against its own reference pair, and no write at all."
run_loud cf piece retarget -s "$SPACE" --plan "$WORK/retarget.jsonl" \
  --out "$WORK/dry.json"
run sh -c "sed 's/^fvj1://' '$WORK/dry.json' | jq -c '{applied, complete, verdicts: (.rows | map(.verdict) | unique)}'"
say "--apply writes. Sessions are grouped rather than opened per piece or"
say "held open for the whole run: the warm-up amortizes across a group while"
say "the pieces live at once stay bounded by it, and a group boundary is a"
say "resume point."
run_loud cf piece retarget -s "$SPACE" --plan "$WORK/retarget.jsonl" \
  --group-size 25 --apply --out "$WORK/applied.json"
say "Every row carries what it cost. A run whose cost per piece is unknown"
say "cannot be improved, and this is the number a decision to run siblings"
say "concurrently would be made on."
run sh -c "sed 's/^fvj1://' '$WORK/applied.json' | jq -c '.rows[0:3] | map({piece, verdict, elapsedMs})'"
say "Re-invoking is the resume: a piece already on its row's target reads as"
say "landed and is not rewritten, so the same command finishes a run that"
say "stopped partway."
run_loud cf piece retarget -s "$SPACE" --plan "$WORK/retarget.jsonl" --apply \
  --out "$WORK/resumed.json"
run sh -c "sed 's/^fvj1://' '$WORK/resumed.json' | jq -c '{applied, complete, verdicts: (.rows | map(.verdict) | unique)}'"

act "9 · The verification is a second survey, never the apply's exit code"
say "An apply that exits zero is not a verdict. The verdict is a survey"
say "taken afterwards and held against the plan the run was made from, and"
say "the two stay separate invocations on purpose."
run_loud cf piece survey -s "$SPACE" --piece board --path items \
  --diff "$WORK/retarget.jsonl"
say "Three outcomes for a planned piece, and the third is what an upgrade"
say "that half-converged looks like. The member filed after the plan was"
say "taken is none of them: it is named as held by the space and not by the"
say "plan, rather than counted as though the plan had asked for it."

act "10 · The refusal the survey exists to make"
say "Deploy a member directly, so the registry knows a piece the board's"
say "collection does not hold. A silent subset is the failure bulk operations"
say "die of, so the survey stops and names it rather than emitting a plan"
say "that quietly misses a piece."
run cf piece new -q --main-export Member "$MEMBER_FIXTURE" -s "$SPACE"
refused "a registered in-scope piece the collection lacks stops the survey" \
  "registered outside the selection" \
  cf piece survey -s "$SPACE" --piece board --path items
say "The plan the later stages consume is therefore complete by construction:"
say "an incomplete survey refuses to produce one, and a serialized plan"
say "carries the incompleteness so no write stage can consume it either."

act "11 · A list survey claims only what it read"
say "Naming pieces directly skips the containment check — and says so: the"
say "header records the selector, so a reader of the plan knows no"
say "containment claim was made. The orphan is still out there; this survey"
say "just never claimed otherwise."
run_loud cf piece survey -s "$SPACE" --list board --out "$WORK/list.jsonl"
run sh -c "head -1 '$WORK/list.jsonl' | jq -c '{selector, enumerated}'"

act "12 · The reversal, derived from the plan that did the move"
say "Stage 4, live. A rollback needs no second artifact: it is derived from"
say "the retarget plan itself, in the other direction. Each row's"
say "precondition is the reference that retarget produced, and its operation"
say "restores the retained revision carrying the reference the row recorded."
say "Dry by default, like everything else here."
run_loud cf piece rollback -s "$SPACE" --plan "$WORK/retarget.jsonl" \
  --out "$WORK/rollback-dry.json"
run sh -c "sed 's/^fvj1://' '$WORK/rollback-dry.json' | jq -c '{applied, complete, rows: (.rows | length), verdicts: (.rows | map(.verdict) | unique)}'"
say "--apply restores. Same engine as the retarget — same preconditions,"
say "same grouped sessions, same stop that names its remainder — so a piece"
say "something else moved stops the reversal instead of being overwritten,"
say "and a piece already back reads as landed."
run_loud cf piece rollback -s "$SPACE" --plan "$WORK/retarget.jsonl" \
  --group-size 25 --apply --out "$WORK/rolled-back.json"
run sh -c "sed 's/^fvj1://' '$WORK/rolled-back.json' | jq -c '{applied, complete, verdicts: (.rows | map(.verdict) | unique)}'"
say "Re-invoking is the resume here too: every piece is already back, so the"
say "same command reads all-landed and writes nothing."
run_loud cf piece rollback -s "$SPACE" --plan "$WORK/retarget.jsonl" --apply \
  --out "$WORK/rollback-settled.json"
run sh -c "sed 's/^fvj1://' '$WORK/rollback-settled.json' | jq -c '{applied, complete, verdicts: (.rows | map(.verdict) | unique)}'"

act "13 · One piece, one revision"
say "Under the bulk reversal is a single-piece command, useful on its own: a"
say "piece keeps an append-only log of the source states it has accepted, and"
say "this returns it to one of them. Without --revision the run lists what"
say "the piece could be returned to — the id, when it was accepted, the"
say "reference it carries, whether its source is still there to load, and"
say "whether the piece runs it now."
MEMBER=$(sed -n 2p "$WORK/retarget.jsonl" | jq -r .piece)
run cf piece restore -s "$SPACE" --piece "$MEMBER"
say "Naming one is the preflight for that revision alone; --apply writes it."
say "The same listing as JSON, so the act picks its revision out of a run the"
say "reader watched rather than one hidden from the transcript."
run cf piece restore -s "$SPACE" --piece "$MEMBER" --json
FORWARD=$(printf '%s' "$OUT" |
  jq -r '.revisions | map(select(.current == false)) | last | .revisionId')
run cf piece restore -s "$SPACE" --piece "$MEMBER" --revision "$FORWARD"
run_loud cf piece restore -s "$SPACE" --piece "$MEMBER" --revision "$FORWARD" \
  --apply

act "14 · A piece that could not be brought back"
say "Everything above rests on the prior source still being in the space. A"
say "piece whose prior source is not retained has no revision to restore, so"
say "no reversal exists for it — and the plan records that per row, before"
say "anything moves."
say "The plan below records it for one row; every other row is untouched."
jq -c --arg piece "$MEMBER" \
  'if .piece == $piece then .expect.retained = false else . end' \
  "$WORK/retarget.jsonl" > "$WORK/unretained.jsonl"
say "The forward move is where that matters, so that is where it is asked."
say "Accepting 'this cannot be rolled back' after the move is asking past"
say "the point of no return, so the live run refuses to start."
refused "a live move over a row nothing could reverse must be named first" \
  "not retained for" \
  cf piece retarget -s "$SPACE" --plan "$WORK/unretained.jsonl" --apply
say "A dry run is not gated — it moves nothing, and reporting where such a"
say "piece stands is how an operator finds out there is something to decide."
run_loud cf piece retarget -s "$SPACE" --plan "$WORK/unretained.jsonl" \
  --out "$WORK/gated-dry.json"
say "The reversal refuses the same row for the same reason: a rollback that"
say "quietly covers fewer pieces than the move it reverses is the failure"
say "this whole design exists to prevent."
refused "a row whose prior source is not retained has no reversal" \
  "not retained for" \
  cf piece rollback -s "$SPACE" --plan "$WORK/unretained.jsonl"
say "One rule, one spelling, at both moments — and the way past is per"
say "piece, by name, at either. One flag over every row would turn many"
say "decisions into one, which is a different risk from the same decision"
say "taken many times."
run_loud cf piece rollback -s "$SPACE" --plan "$WORK/unretained.jsonl" \
  --accept-unretained "$MEMBER" --out "$WORK/accepted.json"
run sh -c "sed 's/^fvj1://' '$WORK/accepted.json' | jq -c '{rows: (.rows | length)}'"
say "One row fewer than the plan carries: the accepted piece is left out, and"
say "named on the way past so it cannot be inferred only from its absence."

printf '\n%s━━ The shape of it %s\n' "$B" "$N"
say "One process surveyed a board-sized collection and emitted the plan the"
say "later stages consume; the same command carried a retarget when asked;"
say "a second process applied that plan over grouped sessions and reported"
say "what each piece cost; a third took the survey that says whether it"
say "worked; and a fourth reversed the whole move from that same plan,"
say "restoring each piece to the revision it was on. And the two refusals"
say "shown are the ones this design exists to make: no plan that silently"
say "misses a piece, and no reversal that silently covers fewer of them."

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
