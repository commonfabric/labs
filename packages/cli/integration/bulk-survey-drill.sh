#!/usr/bin/env bash
# The bulk-operations drill: deploy a board whose members are created
# through its own verb, survey it, assert the plan — repair it: a fixer run
# dry with every plan row recording its precondition and fixer, applied from
# that plan, resumed as all-landed writing nothing, and a field-dropping
# fixer refused by name — and retarget it: the stamped plan applied to
# completion, a run killed midway and finished by re-invocation, an edited
# source refused with every unattempted piece named, a piece moved elsewhere
# stopping the run, and the after-survey diffed against the plan it verifies
# — and reverse it: the completed retarget rolled back from its own plan with
# every row restored, a reversal killed midway and finished by re-invocation,
# a row whose prior source is not retained refused by name and accepted by
# name, and one piece returned on its own through `cf piece restore`.
# Stages 1 through 4 of docs/plans/piece-bulk-operations.md, which finishes
# each stage with a CI drill so "does the migration tooling still work?"
# stays a CI result.
#
# It deploys pattern/bulk-board.tsx (members from pattern/bulk-member.tsx, a
# separate module so member and board identities differ, the way topic.tsx
# sits beside the topics board's main.tsx) and retargets them onto
# pattern/bulk-member-v2.tsx — the checked-in fixture pair the design calls
# for, a trimmed prior generation and a current one, so the drill reds when
# bulk operations break rather than when a real pattern changes. The fixtures
# belong to this drill alone.
#
# Every step names the property it asserts. A fresh space per run, no prior
# state, no store access — the survey is API-only.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/bulk-survey-drill.sh
#
# CI runs it through integration.sh's `bulk-survey-drill` section, which the
# test topology's `cli-core` suite makes a unit of. The `piece-call` section
# runs it too, among the other steps a person running that group by hand gets.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
BOARD_FIXTURE="$SCRIPT_DIR/pattern/bulk-board.tsx"
MEMBER_FIXTURE="$SCRIPT_DIR/pattern/bulk-member.tsx"
RETARGET_FIXTURE="$SCRIPT_DIR/pattern/bulk-member-v2.tsx"

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

# The board-sized bar the plan's stage-1 criterion sets; 113 matches the
# motivating Topics board.
MEMBERS_TOTAL=113

WORK="$(mktemp -d)"
SPACE="${SPACE:-$(mktemp -u bulkXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

step "1. Deploy the board and file three members through its verb"
BOARD=$($CF piece new --quiet "$BOARD_FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi
FILED=0
for title in alpha beta gamma; do
  if $CF piece call -q --piece "$BOARD" $ARGS addMember "{\"title\":\"$title\"}" \
    >/dev/null 2>&1; then
    FILED=$((FILED + 1))
  else
    bad "addMember $title failed"
  fi
done
check "3" "$FILED" "filed alpha, beta, gamma"

step "2. One call seeds the rest of the board-sized set"
SEED_EXTRA=$((MEMBERS_TOTAL - 3))
SEEDED=$($CF piece call -q --piece "$BOARD" $ARGS seedMembers \
  "{\"count\":$SEED_EXTRA}" 2>/dev/null | jq -r '.result.filed // empty')
check "$SEED_EXTRA" "$SEEDED" "one call filed the remaining $SEED_EXTRA"

step "3. Survey the collection, stamping a retarget"
PLAN="$WORK/plan.jsonl"
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  --retarget "items=$RETARGET_FIXTURE@drill" --main-export Member \
  --out "$PLAN" 2>"$WORK/survey.err"; then
  ok "survey exited 0 (complete)"
else
  bad "survey exited nonzero"
  sed 's/^/  | /' "$WORK/survey.err"
  exit 1
fi

step "4. The header accounts for the selection"
HEADER_FACTS=$(head -1 "$PLAN" | jq -r \
  '[.kind, (.v|tostring), .selector, (.enumerated.collection|tostring),
    (.enumerated.registry|tostring),
    (.enumerated.registeredOutside|tostring),
    ((has("problems") or has("outside"))|tostring)] | @tsv')
check "$(printf 'piece-plan\t1\tcollection\t%s\t1\t0\tfalse' \
  "$MEMBERS_TOTAL")" "$HEADER_FACTS" \
  "header: board-sized collection, the board alone registered, nothing outside"

step "5. Rows are members in order, then the holder"
MEMBER_PHASES=$(tail -n +2 "$PLAN" | jq -rs \
  "map(.phase) | .[0:$MEMBERS_TOTAL] | unique | join(\",\")")
check "items" "$MEMBER_PHASES" "every member row leads, phased items"
LAST_PHASE=$(tail -n +2 "$PLAN" | jq -rs 'map(.phase) | last')
check "holder" "$LAST_PHASE" "the holder row comes last"
DISTINCT_PIECES=$(tail -n +2 "$PLAN" | jq -rs 'map(.piece) | unique | length')
check "$((MEMBERS_TOTAL + 1))" "$DISTINCT_PIECES" \
  "one distinct piece per member, plus the holder"

step "6. Members share one identity; the holder has its own"
MEMBER_IDENTITIES=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "items") | .expect.patternIdentity) | unique | length')
check "1" "$MEMBER_IDENTITIES" "one identity across the members"
CROSS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(.expect.patternIdentity) | unique | length')
check "2" "$CROSS" "the holder's identity is not the members'"
RETAINED=$(tail -n +2 "$PLAN" | jq -rs \
  'map(.expect.retained) | unique | join(",")')
check "true" "$RETAINED" "every row's source is retained"

step "7. The retarget stamp pins the target identity, on member rows only"
STAMPS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "items") | .op)
   | [(map(.kind) | unique | join(",")), (map(.rev) | unique | join(",")),
      (map(.symbol) | unique | join(",")),
      (map(.patternIdentity) | unique | length | tostring)] | @tsv')
check "$(printf 'retarget\tdrill\tMember\t1')" "$STAMPS" \
  "member rows carry one retarget target, rev 'drill', export Member"
TARGET_DIFFERS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "items"))
   | map((.op.patternIdentity != null) and
       (.op.patternIdentity != .expect.patternIdentity))
   | unique | join(",")')
check "true" "$TARGET_DIFFERS" \
  "every member row is stamped, and with a different reference"
HOLDER_OP=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "holder") | has("op")) | join(",")')
check "false" "$HOLDER_OP" "the holder row carries no op"

step "8. The single-piece pin agrees with the holder row"
PIN_FACTS=$($CF piece inspect --pattern-identity --json \
  --piece "$BOARD" $ARGS 2>/dev/null |
  jq -r '[.patternIdentity, .symbol, (.retained|tostring)] | @tsv')
HOLDER_FACTS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "holder") | .expect)
   | first | [.patternIdentity, .symbol, (.retained|tostring)] | @tsv')
if [ -z "$PIN_FACTS" ] || [ -z "$HOLDER_FACTS" ]; then
  bad "pin extraction came back empty"
fi
check "$HOLDER_FACTS" "$PIN_FACTS" \
  "inspect's source pin matches the survey's holder row, symbol included"

step "9. A change shows on the next survey (live read)"
$CF piece call -q --piece "$BOARD" $ARGS addMember '{"title":"delta"}' \
  >/dev/null 2>&1 || bad "addMember delta failed"
AFTER=$($CF piece survey -q --piece "$BOARD" --path items $ARGS \
  2>/dev/null | head -1 | jq -r '.enumerated.collection')
check "$((MEMBERS_TOTAL + 1))" "$AFTER" \
  "the after-survey counts the member added since"

step "10. A repair runs dry, applies from its plan, and resumes as landed"
cat > "$WORK/fix-titles.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => ({
  ...document,
  ...(typeof document.title === "string"
    ? { title: (document.title as string).toUpperCase() }
    : {}),
});
FIXER
if $CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --out "$WORK/repair.jsonl" \
  2>"$WORK/repair-dry.err"; then
  ok "dry repair exited 0"
else
  bad "dry repair exited nonzero"
  sed 's/^/  | /' "$WORK/repair-dry.err"
fi
DRY_OPS=$(tail -n +2 "$WORK/repair.jsonl" | jq -rs \
  'map(.op.fixer) | unique | join(",")')
check "$WORK/fix-titles.ts" "$DRY_OPS" \
  "every plan row records the fixer it was evaluated for"
# The reviewed plan pins the fixer implementation: an edited module is a
# different closure identity, and the apply refuses it by name.
cp "$WORK/fix-titles.ts" "$WORK/fix-titles.reviewed.ts"
printf '\n// edited after review\n' >> "$WORK/fix-titles.ts"
if $CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply \
  >/dev/null 2>"$WORK/repair-pin.err"; then
  bad "an edited fixer ran under the reviewed plan"
else
  ok "an edited fixer exited nonzero under the reviewed plan"
fi
if grep -q "different fixer implementation" "$WORK/repair-pin.err"; then
  ok "the refusal names the implementation pin"
else
  bad "the refusal does not name the implementation pin"
  sed 's/^/  | /' "$WORK/repair-pin.err"
fi
mv "$WORK/fix-titles.reviewed.ts" "$WORK/fix-titles.ts"
APPLY_FACTS=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply --json \
  2>"$WORK/repair-apply.err" | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
MEMBERS_NOW=$((MEMBERS_TOTAL + 1))
check "$(printf '%s\ttrue\trepaired' "$MEMBERS_NOW")" "$APPLY_FACTS" \
  "the plan-driven apply repaired every member row"
RESUME=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply --json \
  2>/dev/null | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
check "$(printf '0\ttrue\tconforms')" "$RESUME" \
  "re-running the completed plan writes nothing and reads all-landed"
cat > "$WORK/drop-everything.ts" <<'FIXER'
export default () => ({});
FIXER
if $CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/drop-everything.ts" \
  >/dev/null 2>"$WORK/repair-refuse.err"; then
  bad "a field-dropping fixer was accepted"
else
  ok "a field-dropping fixer exited nonzero"
fi
if grep -q "incomplete document" "$WORK/repair-refuse.err"; then
  ok "the refusal names the incomplete document"
else
  bad "the refusal does not name the incomplete document"
  sed 's/^/  | /' "$WORK/repair-refuse.err"
fi

step "11. A run stopped midway completes by re-invocation"
# A fixer that appends a mark, but whose answer for the third-planned piece
# breaks the schema: rows before it land, the run stops there with the
# remainder named, and re-invoking skips what landed — the property the
# design says rots silently unless a drill holds it.
cat > "$WORK/mark-titles.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => {
  const title = String(document.title ?? "");
  if (title === "GAMMA") return { ...document, title: 7 as never };
  return {
    ...document,
    ...(title !== "" && !title.endsWith("!")
      ? { title: `${title}!` }
      : {}),
  };
};
FIXER
RUN1=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/mark-titles.ts" --apply --json 2>/dev/null |
  sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.rows | map(.verdict) | .[0:3] | join(",")),
    ((.rows | map(.verdict) | map(select(. == "unattempted")) | length > 0)
      | tostring)] | @tsv')
check "$(printf '2\trepaired,repaired,failed\ttrue')" "$RUN1" \
  "the run landed two rows, stopped at the third, and named the rest"
RUN2=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/mark-titles.ts" --apply --json 2>/dev/null |
  sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.rows | map(.verdict) | .[0:3] | join(","))] | @tsv')
check "$(printf '0\tconforms,conforms,failed')" "$RUN2" \
  "re-invoking skips the landed rows and writes nothing for them"
cat > "$WORK/mark-titles-v2.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => {
  const title = String(document.title ?? "");
  return {
    ...document,
    ...(title !== "" && !title.endsWith("!")
      ? { title: `${title}!` }
      : {}),
  };
};
FIXER
RUN3=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/mark-titles-v2.ts" --apply --json 2>/dev/null |
  sed 's/^fvj1://' | jq -r '[(.applied|tostring), (.complete|tostring)]
    | @tsv')
check "$(printf '%s\ttrue' "$((MEMBERS_NOW - 2))")" "$RUN3" \
  "the amended fixer completes the remainder by re-invocation"

step "12. A retarget plan over the whole board, from the fixture pair"
# The source is a copy, so a later step can edit it and prove the apply
# refuses a source that no longer produces the reference the plan recorded.
NEXT_SOURCE="$WORK/member-next.tsx"
cp "$RETARGET_FIXTURE" "$NEXT_SOURCE"
RETARGET_PLAN="$WORK/retarget.jsonl"
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  --retarget "items=$NEXT_SOURCE" --main-export Member \
  --out "$RETARGET_PLAN" 2>"$WORK/retarget-survey.err"; then
  ok "the survey stamped the retarget onto every member row"
else
  bad "the retarget survey exited nonzero"
  sed 's/^/  | /' "$WORK/retarget-survey.err"
  exit 1
fi
PLAN_OPS=$(tail -n +2 "$RETARGET_PLAN" | jq -rs \
  'map(select(has("op"))) | length')
check "$MEMBERS_NOW" "$PLAN_OPS" "one retarget row per member, the holder none"

step "13. The dry run classifies every row and writes nothing"
DRY=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>"$WORK/retarget-dry.err" | sed 's/^fvj1://' |
  jq -r '[(.applied|tostring), (.complete|tostring),
    (.rows | map(.verdict) | unique | join(",")),
    (.rows | length | tostring)] | @tsv')
check "$(printf '0\ttrue\toutstanding\t%s' "$MEMBERS_NOW")" "$DRY" \
  "every row reads outstanding against its own reference pair"

step "14. An edited source is refused, and the stop names the remainder"
# The reviewed plan pins the identity the source produced when it was
# reviewed. An edited source is a different identity, so the apply refuses
# the first row rather than landing something the plan's reader never saw.
printf '\n// edited after the plan was reviewed\n' >> "$NEXT_SOURCE"
if $CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply \
  --out "$WORK/stop.json" 2>"$WORK/retarget-stop.err"; then
  bad "an edited source ran under the reviewed plan"
else
  ok "an edited source exited nonzero under the reviewed plan"
fi
STOP_FACTS=$(sed 's/^fvj1://' "$WORK/stop.json" | jq -r '[(.applied|tostring),
  (.complete|tostring), (.rows[0].verdict),
  (.rows | map(select(.verdict == "unattempted") | .piece) | unique | length
    | tostring)] | @tsv')
check "$(printf '0\tfalse\trefused\t%s' "$((MEMBERS_NOW - 1))")" "$STOP_FACTS" \
  "the first row was refused, and every other piece is named unattempted"
if grep -q "resolves to" "$WORK/retarget-stop.err"; then
  ok "the refusal names the identity the source resolves to now"
else
  bad "the refusal does not name the resolved identity"
  sed 's/^/  | /' "$WORK/retarget-stop.err"
fi
cp "$RETARGET_FIXTURE" "$NEXT_SOURCE"

step "14b. A move whose prior source is not retained needs naming first"
# The gate on the forward run, and the moment it matters: a piece whose
# prior source is not retained cannot be returned once it moves, so the
# acceptance is asked while it is still a decision rather than at the
# reversal, which is past the point of no return. Every source this drill
# deploys is retained, so the row's recorded fact is rewritten to exercise
# the refusal — derived from the live survey as every other plan here is.
#
# One row, so the board the steps below need is not rewritten wholesale:
# the gate is a property of the plan's rows, not of how many there are.
GATE_PIECE=$(tail -n +2 "$RETARGET_PLAN" |
  jq -r 'select(has("op")) | .piece' | head -1)
OTHER_PIECE=$(tail -n +2 "$RETARGET_PLAN" |
  jq -r 'select(has("op")) | .piece' | sed -n 2p)
GATE_PLAN="$WORK/forward-unretained.jsonl"
{
  head -1 "$RETARGET_PLAN"
  tail -n +2 "$RETARGET_PLAN" |
    jq -c --arg piece "$GATE_PIECE" \
      'select(.piece == $piece) | .expect.retained = false'
} > "$GATE_PLAN"
check "2" "$(grep -c . "$GATE_PLAN")" "a one-row plan, its prior source \
recorded unretained"
if $CF piece retarget -q $ARGS --plan "$GATE_PLAN" \
  >/dev/null 2>"$WORK/forward-dry.err"; then
  ok "a dry run reports over an unretained row, asking for no acceptance"
else
  bad "a dry run over an unretained row was refused"
  sed 's/^/  | /' "$WORK/forward-dry.err"
fi
if $CF piece retarget -q $ARGS --plan "$GATE_PLAN" --apply \
  >/dev/null 2>"$WORK/forward-apply.err"; then
  bad "a live move over an unretained row started without acceptance"
else
  ok "a live move over an unretained row exited nonzero"
fi
if grep -q "not retained for $GATE_PIECE" "$WORK/forward-apply.err"; then
  ok "the refusal names the piece and what could not be reversed"
else
  bad "the refusal does not name the piece"
  sed 's/^/  | /' "$WORK/forward-apply.err"
fi
if $CF piece retarget -q $ARGS --plan "$GATE_PLAN" --apply \
  --accept-unretained "$OTHER_PIECE" \
  >/dev/null 2>"$WORK/forward-idle.err"; then
  bad "an acceptance covering no unretained row was taken"
else
  ok "an acceptance covering no unretained row exited nonzero"
fi
if grep -q "nothing accepts as unrollbackable for $OTHER_PIECE" \
  "$WORK/forward-idle.err"; then
  ok "the refusal names the acceptance that covers nothing"
else
  bad "the refusal does not name the idle acceptance"
  sed 's/^/  | /' "$WORK/forward-idle.err"
fi
ACCEPTED_FORWARD=$($CF piece retarget -q $ARGS --plan "$GATE_PLAN" \
  --apply --accept-unretained "$GATE_PIECE" --json \
  2>"$WORK/forward-accepted.err" | sed 's/^fvj1://' |
  jq -r '[(.complete|tostring), (.applied|tostring)] | @tsv')
check "$(printf 'true\t1')" "$ACCEPTED_FORWARD" \
  "the accepted move runs, and its row lands"
if grep -q "accepted as unrollbackable: $GATE_PIECE" \
  "$WORK/forward-accepted.err"; then
  ok "the accepted piece is named on the run that moved it"
else
  bad "the accepted piece is not named"
  sed 's/^/  | /' "$WORK/forward-accepted.err"
fi
# Put that one piece back on the prior generation, so the steps below meet
# the board they expect: every member outstanding against the plan.
$CF piece setsrc -q --piece "$GATE_PIECE" --main-export Member \
  "$MEMBER_FIXTURE" $ARGS >/dev/null 2>"$WORK/forward-reset.err" ||
  bad "returning the accepted piece to the prior generation failed"

step "15. A run killed midway is completed by re-invoking the same command"
# The report streams a row at a time to stdout, so the drill reads rows as
# they land and kills the run on the sixth — inside the second group, past
# one group boundary. Nothing is waited on but the rows themselves.
#
# The interruption is proved rather than assumed, because a run that finished
# on its own would satisfy every assertion about the second invocation while
# exercising none of what this step exists for. Two independent proofs, both
# required: the first invocation's exit status must be a signal death, and a
# read-only pass between the two invocations must find real work on both
# sides of the cut.
mkfifo "$WORK/progress"
$CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply --group-size 5 \
  >"$WORK/progress" 2>"$WORK/retarget-killed.err" &
KILLED_PID=$!
# The read end stays open past the loop, on its own descriptor: closing it at
# the break would deliver a broken pipe and end the run before the signal
# does, which is a different interruption from the one this step claims.
exec 3<"$WORK/progress"
WATCHED=0
while IFS= read -r _row <&3; do
  WATCHED=$((WATCHED + 1))
  [ "$WATCHED" -ge 6 ] && break
done
if [ "$WATCHED" -ge 6 ]; then
  ok "watched $WATCHED rows land"
else
  bad "the run ended before six rows landed (saw $WATCHED)"
  sed 's/^/  | /' "$WORK/retarget-killed.err"
fi
if kill "$KILLED_PID" 2>/dev/null; then
  ok "signalled the run partway through its second group"
else
  bad "the run was already gone when the drill signalled it, so nothing was \
interrupted and this step proves nothing"
fi
wait "$KILLED_PID"
KILLED_STATUS=$?
exec 3<&-
# 128 plus the signal number: 143 for the SIGTERM sent above, 137 if it
# escalated. Any other status is a run that reached its own exit — the race
# this step must go red on rather than pass through.
if [ "$KILLED_STATUS" = "143" ] || [ "$KILLED_STATUS" = "137" ]; then
  ok "the first invocation died on the signal (exit $KILLED_STATUS)"
else
  bad "the first invocation exited $KILLED_STATUS rather than on the signal: \
it ran to its own end before the drill could stop it"
fi
# What the cut left behind, read without writing: rows on both sides of it.
# Zero on either side is a run that was never stopped midway, whatever the
# exit status said.
MIDWAY=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>"$WORK/retarget-midway.err" | sed 's/^fvj1://' |
  jq -r '[(.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "outstanding")) | length | tostring)]
    | @tsv')
MIDWAY_LANDED=$(printf '%s' "$MIDWAY" | cut -f1)
MIDWAY_OUTSTANDING=$(printf '%s' "$MIDWAY" | cut -f2)
if [ "${MIDWAY_LANDED:-0}" -ge "$WATCHED" ] &&
  [ "${MIDWAY_OUTSTANDING:-0}" -gt 0 ]; then
  ok "the cut left $MIDWAY_LANDED landed and $MIDWAY_OUTSTANDING outstanding"
else
  bad "the cut left $MIDWAY_LANDED landed and $MIDWAY_OUTSTANDING \
outstanding, of $WATCHED rows watched: the run was not stopped midway"
fi
check "$MEMBERS_NOW" \
  "$((${MIDWAY_LANDED:-0} + ${MIDWAY_OUTSTANDING:-0}))" \
  "between the invocations every row is landed or outstanding, nothing else"
RESUME=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply --json \
  2>"$WORK/retarget-resume.err" | sed 's/^fvj1://' |
  jq -r '[(.complete|tostring),
    (.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "applied")) | length | tostring)] | @tsv')
RESUME_COMPLETE=$(printf '%s' "$RESUME" | cut -f1)
RESUME_LANDED=$(printf '%s' "$RESUME" | cut -f2)
RESUME_APPLIED=$(printf '%s' "$RESUME" | cut -f3)
check "true" "$RESUME_COMPLETE" "the re-invocation completed the run"
check "$MIDWAY_LANDED" "$RESUME_LANDED" \
  "the rows the killed run landed were read as landed, not rewritten"
check "$MIDWAY_OUTSTANDING" "$RESUME_APPLIED" \
  "the re-invocation wrote the remainder, and only the remainder"
check "$MEMBERS_NOW" "$((${RESUME_LANDED:-0} + ${RESUME_APPLIED:-0}))" \
  "every member row is accounted for across the two invocations"

step "16. Re-running the completed plan writes nothing"
SETTLED=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply --json \
  2>/dev/null | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
check "$(printf '0\ttrue\tlanded')" "$SETTLED" \
  "a settled plan re-runs as all-landed and writes nothing"

step "17. A piece on neither of its row's references stops the run by name"
FIRST_MEMBER=$(tail -n +2 "$RETARGET_PLAN" |
  jq -r 'select(has("op")) | .piece' | head -1)
SECOND_MEMBER=$(tail -n +2 "$RETARGET_PLAN" |
  jq -r 'select(has("op")) | .piece' | sed -n 2p)
# MemberAlias is the same module under a second symbol, so this piece now
# carries the target row's identity and not its symbol: a check comparing the
# identity alone would call it landed. The source is the plan's own
# $NEXT_SOURCE and not the fixture it was copied from — a closure's identity
# covers its entry filename, so the two are different identities, and moving
# the piece to the fixture would leave it on a third reference rather than on
# the target identity under another symbol.
if $CF piece setsrc -q --piece "$FIRST_MEMBER" --main-export MemberAlias \
  "$NEXT_SOURCE" $ARGS >/dev/null 2>"$WORK/alias.err"; then
  ok "moved a member to the target identity under another symbol"
else
  bad "moving a member to the alias export failed"
  sed 's/^/  | /' "$WORK/alias.err"
fi
if $CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply \
  --out "$WORK/moved.json" 2>"$WORK/moved.err"; then
  bad "a piece on neither reference did not stop the run"
else
  ok "a piece on neither reference exited nonzero"
fi
MOVED_FACTS=$(sed 's/^fvj1://' "$WORK/moved.json" | jq -r '[(.applied|tostring),
  (.complete|tostring),
  (.rows | map(select(.verdict == "moved-elsewhere") | .piece) | join(",")),
  (.rows | map(select(.verdict == "landed")) | length | tostring)] | @tsv')
check "$(printf '0\tfalse\t%s\t%s' "$FIRST_MEMBER" "$((MEMBERS_NOW - 1))")" \
  "$MOVED_FACTS" \
  "the moved piece is named, and nothing was written for any row"
if grep -q "$FIRST_MEMBER" "$WORK/moved.err"; then
  ok "the stop names the piece rather than counting it"
else
  bad "the stop does not name the moved piece"
  sed 's/^/  | /' "$WORK/moved.err"
fi

step "18. The after-survey tells the three outcomes apart"
# One member back on the prior generation, so the diff has an outstanding row
# to distinguish from the one that moved somewhere the plan never named.
$CF piece setsrc -q --piece "$SECOND_MEMBER" --main-export Member \
  "$MEMBER_FIXTURE" $ARGS >/dev/null 2>"$WORK/revert.err" ||
  bad "moving a member back to the prior generation failed"
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  --diff "$RETARGET_PLAN" --json >"$WORK/diff.json" 2>"$WORK/diff.err"; then
  bad "the diff exited 0 with rows outstanding and moved elsewhere"
else
  ok "the diff exited nonzero with rows outstanding and moved elsewhere"
fi
DIFF_FACTS=$(jq -r '[(.counts.landed|tostring), (.counts.outstanding|tostring),
  (.counts["moved-elsewhere"]|tostring), (.counts.unchanged|tostring),
  (.unplanned | length | tostring)] | @tsv' "$WORK/diff.json")
check "$(printf '%s\t1\t1\t1\t0' "$((MEMBERS_NOW - 2))")" "$DIFF_FACTS" \
  "moved as planned, still outstanding, and moved to something unplanned"

step "19. A registered in-scope orphan makes the survey refuse"
ORPHAN=$($CF piece new --quiet --main-export Member \
  "$MEMBER_FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$ORPHAN" ]; then ok "registered orphan $ORPHAN"; else
  bad "orphan deploy failed"
fi
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  >/dev/null 2>"$WORK/incomplete.err"; then
  bad "survey exited 0 despite a registered in-scope orphan"
else
  ok "survey exited nonzero with an orphan registered"
fi
if grep -q "registered outside the selection" "$WORK/incomplete.err"; then
  ok "the refusal names the orphan's standing"
else
  bad "the refusal does not name the orphan"
fi

step "20. A list survey claims no containment"
LIST_FACTS=$($CF piece survey -q --list "$BOARD" $ARGS 2>/dev/null |
  head -1 | jq -r '[.selector, (.enumerated.collection|tostring),
    (.enumerated.registeredOutside|tostring)] | @tsv')
check "$(printf 'list\t1\t0')" "$LIST_FACTS" \
  "list of one row, complete despite the orphan"

step "21. The rollback derives from the retarget's own plan, no second artifact"
# The board stands where steps 17 and 18 left it: one member moved to the
# target identity under another symbol, one member put back on the prior
# generation, and every other member on the target. A rollback derived from
# the retarget plan therefore reads all three standings at once — which is
# also the whole of "preconditions are checked the same way": the moved piece
# stops the reversal, and the piece already back is landed.
if $CF piece rollback -q $ARGS --plan "$RETARGET_PLAN" --json \
  >"$WORK/rollback-dry.json" 2>"$WORK/rollback-dry.err"; then
  bad "a piece on neither reference did not stop the reversal"
else
  ok "the dry rollback exited nonzero with a piece on neither reference"
fi
ROLLBACK_DRY=$(sed 's/^fvj1://' "$WORK/rollback-dry.json" |
  jq -r '[(.applied|tostring), (.complete|tostring), (.rows | length | tostring),
    (.rows | map(select(.verdict == "moved-elsewhere") | .piece) | join(",")),
    (.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "outstanding")) | length | tostring)]
    | @tsv')
check "$(printf '0\tfalse\t%s\t%s\t1\t%s' "$MEMBERS_NOW" "$FIRST_MEMBER" \
  "$((MEMBERS_NOW - 2))")" "$ROLLBACK_DRY" \
  "one rollback row per retarget row: the moved piece named, the piece \
already back landed, the rest outstanding"
if grep -q "$FIRST_MEMBER" "$WORK/rollback-dry.err"; then
  ok "the stop names the moved piece rather than counting it"
else
  bad "the stop does not name the moved piece"
  sed 's/^/  | /' "$WORK/rollback-dry.err"
fi

step "22. A rollback killed midway is completed by re-invoking the same command"
# Put BOTH moved members back on the target, so the board is a completed
# retarget again and the reversal below has every row to restore: step 17 left
# one on the target identity under another symbol, and step 18 left the other
# on the prior generation. A row that is already back before the reversal
# starts is a row the reversal never has to restore, and step 23's "a
# completed retarget is fully reversed" would then be a claim about the rest
# of the board rather than about all of it. The plan's own source again, for
# the reason step 17 gives.
#
# Each re-stage is proved rather than assumed: one that silently did not
# happen would leave the reversal blocked and every assertion below about the
# cut vacuous.
restage_to_target() {
  $CF piece setsrc -q --piece "$1" --main-export Member \
    "$NEXT_SOURCE" $ARGS >/dev/null 2>"$WORK/rollback-restage.err" ||
    bad "moving $2 back to the target failed"
  local now target
  now=$($CF piece inspect --pattern-identity --json --piece "$1" $ARGS \
    2>/dev/null | jq -r '[.patternIdentity, .symbol] | @tsv')
  target=$(tail -n +2 "$RETARGET_PLAN" | jq -rs --arg p "$1" \
    'map(select(.piece == $p)) | first | [.op.patternIdentity, .op.symbol]
     | @tsv')
  check "$target" "$now" \
    "$2 is back on its row's target reference, both halves"
}
restage_to_target "$FIRST_MEMBER" "the aliased member"
restage_to_target "$SECOND_MEMBER" "the member left on the prior generation"
# Every row outstanding, none landed: the reversal below therefore restores
# the whole board and not the part of it that happened to be forward. This
# reds if any row was already back before the rollback started.
STAGED=$($CF piece rollback -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>"$WORK/rollback-staged.err" | sed 's/^fvj1://' |
  jq -r '[(.rows | length | tostring), (.complete|tostring),
    (.rows | map(.verdict) | unique | join(","))] | @tsv')
check "$(printf '%s\ttrue\toutstanding' "$MEMBERS_NOW")" "$STAGED" \
  "the retarget is complete again: every row has a restore ahead of it"
# The same idiom step 15 uses, and for the same reason: an interrupted run is
# what rots silently, and a run that finished on its own would satisfy every
# assertion about the second invocation while exercising none of what this
# step exists for. Both proofs are required — a signal death, and real work
# on both sides of the cut.
mkfifo "$WORK/rollback-progress"
$CF piece rollback -q $ARGS --plan "$RETARGET_PLAN" --apply --group-size 5 \
  >"$WORK/rollback-progress" 2>"$WORK/rollback-killed.err" &
ROLLBACK_PID=$!
exec 4<"$WORK/rollback-progress"
ROLLBACK_WATCHED=0
while IFS= read -r _row <&4; do
  ROLLBACK_WATCHED=$((ROLLBACK_WATCHED + 1))
  [ "$ROLLBACK_WATCHED" -ge 6 ] && break
done
if [ "$ROLLBACK_WATCHED" -ge 6 ]; then
  ok "watched $ROLLBACK_WATCHED rollback rows land"
else
  bad "the reversal ended before six rows landed (saw $ROLLBACK_WATCHED)"
  sed 's/^/  | /' "$WORK/rollback-killed.err"
fi
if kill "$ROLLBACK_PID" 2>/dev/null; then
  ok "signalled the reversal partway through its second group"
else
  bad "the reversal was already gone when the drill signalled it, so nothing \
was interrupted and this step proves nothing"
fi
wait "$ROLLBACK_PID"
ROLLBACK_STATUS=$?
exec 4<&-
if [ "$ROLLBACK_STATUS" = "143" ] || [ "$ROLLBACK_STATUS" = "137" ]; then
  ok "the first reversal died on the signal (exit $ROLLBACK_STATUS)"
else
  bad "the first reversal exited $ROLLBACK_STATUS rather than on the signal: \
it ran to its own end before the drill could stop it"
fi
ROLLBACK_MIDWAY=$($CF piece rollback -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>"$WORK/rollback-midway.err" | sed 's/^fvj1://' |
  jq -r '[(.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "outstanding")) | length | tostring)]
    | @tsv')
ROLLBACK_LANDED=$(printf '%s' "$ROLLBACK_MIDWAY" | cut -f1)
ROLLBACK_OUTSTANDING=$(printf '%s' "$ROLLBACK_MIDWAY" | cut -f2)
if [ "${ROLLBACK_LANDED:-0}" -ge "$ROLLBACK_WATCHED" ] &&
  [ "${ROLLBACK_OUTSTANDING:-0}" -gt 0 ]; then
  ok "the cut left $ROLLBACK_LANDED restored and $ROLLBACK_OUTSTANDING \
outstanding"
else
  bad "the cut left $ROLLBACK_LANDED restored and $ROLLBACK_OUTSTANDING \
outstanding, of $ROLLBACK_WATCHED rows watched: the reversal was not stopped \
midway"
fi
check "$MEMBERS_NOW" \
  "$((${ROLLBACK_LANDED:-0} + ${ROLLBACK_OUTSTANDING:-0}))" \
  "between the invocations every row is landed or outstanding, nothing else"
ROLLBACK_RESUME=$($CF piece rollback -q $ARGS --plan "$RETARGET_PLAN" --apply \
  --json 2>"$WORK/rollback-resume.err" | sed 's/^fvj1://' |
  jq -r '[(.complete|tostring),
    (.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "applied")) | length | tostring)] | @tsv')
RESUME_COMPLETE=$(printf '%s' "$ROLLBACK_RESUME" | cut -f1)
RESUME_LANDED=$(printf '%s' "$ROLLBACK_RESUME" | cut -f2)
RESUME_APPLIED=$(printf '%s' "$ROLLBACK_RESUME" | cut -f3)
check "true" "$RESUME_COMPLETE" "the re-invocation completed the reversal"
check "$ROLLBACK_LANDED" "$RESUME_LANDED" \
  "the rows the killed reversal restored were read as landed, not rewritten"
check "$ROLLBACK_OUTSTANDING" "$RESUME_APPLIED" \
  "the re-invocation restored the remainder, and only the remainder"
check "$MEMBERS_NOW" "$((${RESUME_LANDED:-0} + ${RESUME_APPLIED:-0}))" \
  "every member row is accounted for across the two invocations"

step "23. The reversal put the board back where the plan found it"
# The retarget plan's own precondition, checked against the space: every row
# reads outstanding again, which is the same reading the plan got before the
# retarget ran. A completed retarget is fully reversed — every row of it,
# step 22 having proved that none was already back before the reversal began.
REVERSED=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>/dev/null | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
check "$(printf '0\ttrue\toutstanding')" "$REVERSED" \
  "every member is back on the reference its retarget row recorded"
SETTLED_ROLLBACK=$($CF piece rollback -q $ARGS --plan "$RETARGET_PLAN" \
  --apply --json 2>/dev/null | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
check "$(printf '0\ttrue\tlanded')" "$SETTLED_ROLLBACK" \
  "a settled reversal re-runs as all-landed and writes nothing"

step "24. A row whose prior source is not retained is refused by name"
# Every source this drill deploys is retained, so an unretained row cannot be
# produced by deploying one. The row's `retained` field is the recorded fact
# the derivation honors, and the honest way to exercise the refusal is a plan
# that records it — derived from the live survey as every other plan here is,
# with one row's recorded fact rewritten.
UNRETAINED_PLAN="$WORK/unretained.jsonl"
jq -c --arg piece "$SECOND_MEMBER" \
  'if .piece == $piece then .expect.retained = false else . end' \
  "$RETARGET_PLAN" > "$UNRETAINED_PLAN"
UNRETAINED_ROWS=$(tail -n +2 "$UNRETAINED_PLAN" |
  jq -rs 'map(select(.expect.retained == false)) | length')
check "1" "$UNRETAINED_ROWS" "the plan records one unretained prior source"
if $CF piece rollback -q $ARGS --plan "$UNRETAINED_PLAN" \
  >/dev/null 2>"$WORK/rollback-unretained.err"; then
  bad "a row with no retained prior source did not stop the derivation"
else
  ok "an unretained prior source exited nonzero"
fi
if grep -q "not retained for $SECOND_MEMBER" "$WORK/rollback-unretained.err"
then
  ok "the refusal names the piece and the reason"
else
  bad "the refusal does not name the piece and the reason"
  sed 's/^/  | /' "$WORK/rollback-unretained.err"
fi
# Accepting is per piece. Naming a piece whose prior source IS retained
# accepts nothing, and is refused rather than ignored: an operator who
# believes they dropped a piece must not be dropping none.
if $CF piece rollback -q $ARGS --plan "$UNRETAINED_PLAN" \
  --accept-unretained "$FIRST_MEMBER" \
  >/dev/null 2>"$WORK/rollback-idle-accept.err"; then
  bad "an acceptance covering no unretained row was taken"
else
  ok "an acceptance covering no unretained row exited nonzero"
fi
if grep -q "nothing accepts as unrollbackable for $FIRST_MEMBER" \
  "$WORK/rollback-idle-accept.err"; then
  ok "the refusal names the acceptance that covers nothing"
else
  bad "the refusal does not name the idle acceptance"
  sed 's/^/  | /' "$WORK/rollback-idle-accept.err"
fi
# What acceptance actually does is leave one piece behind while the rest are
# returned, and only a run that writes can show it. Step 23 left the whole
# board reversed, so the rows are re-staged first: without this the assertion
# below would be about a derived row count and nothing else.
if $CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply >/dev/null \
  2>"$WORK/accepted-restage.err"; then
  ok "re-staged the board so the acceptance has something to leave behind"
else
  bad "re-staging the board before the accepted reversal failed"
  sed 's/^/  | /' "$WORK/accepted-restage.err"
fi
# Both halves of the reference, the way the apply engine compares one: two
# patterns a module exports share an identity and differ only in symbol, so
# an identity-only check would call the MemberAlias state of step 17 a match.
TARGET_REFERENCE=$(tail -n +2 "$RETARGET_PLAN" | jq -rs \
  'map(select(has("op"))) | first | [.op.patternIdentity, .op.symbol] | @tsv')
PRIOR_REFERENCE=$(tail -n +2 "$RETARGET_PLAN" | jq -rs \
  'map(select(has("op"))) | first
   | [.expect.patternIdentity, .expect.symbol] | @tsv')
ACCEPTED=$($CF piece rollback -q $ARGS --plan "$UNRETAINED_PLAN" \
  --accept-unretained "$SECOND_MEMBER" --apply --json \
  2>"$WORK/rollback-accepted.err" | sed 's/^fvj1://' |
  jq -r '[(.rows | length | tostring), (.applied|tostring), (.complete|tostring),
    (.rows | map(.verdict) | unique | join(","))] | @tsv')
check "$(printf '%s\t%s\ttrue\tapplied' "$((MEMBERS_NOW - 1))" \
  "$((MEMBERS_NOW - 1))")" "$ACCEPTED" \
  "every row but the accepted one was reversed, and all of them wrote"
# The point of the acceptance, asserted by reference rather than by a count:
# the accepted piece stayed where the move left it.
ACCEPTED_NOW=$($CF piece inspect --pattern-identity --json \
  --piece "$SECOND_MEMBER" $ARGS 2>/dev/null |
  jq -r '[.patternIdentity, .symbol] | @tsv')
check "$TARGET_REFERENCE" "$ACCEPTED_NOW" \
  "the accepted piece was left on the exact target reference, not restored"
OTHER_NOW=$($CF piece inspect --pattern-identity --json \
  --piece "$FIRST_MEMBER" $ARGS 2>/dev/null |
  jq -r '[.patternIdentity, .symbol] | @tsv')
check "$PRIOR_REFERENCE" "$OTHER_NOW" \
  "every other piece returned to the exact reference its row recorded"
if grep -q "accepted as unrollbackable: $SECOND_MEMBER" \
  "$WORK/rollback-accepted.err"; then
  ok "the accepted piece is named on the run that carried it"
else
  bad "the accepted piece is not named"
  sed 's/^/  | /' "$WORK/rollback-accepted.err"
fi
# Return the one piece the acceptance left behind, so the steps below meet a
# fully reversed board again.
$CF piece setsrc -q --piece "$SECOND_MEMBER" --main-export Member \
  "$MEMBER_FIXTURE" $ARGS >/dev/null 2>"$WORK/accepted-reset.err" ||
  bad "returning the accepted piece after the reversal failed"

step "25. cf piece restore returns one piece to a revision of its own log"
# The single-piece seam the bulk rollback is built on, useful on its own.
RESTORE_TARGET="$FIRST_MEMBER"
REVISIONS=$($CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  2>"$WORK/restore-list.err")
REVISION_COUNT=$(printf '%s\n' "$REVISIONS" | grep -c .)
if [ "${REVISION_COUNT:-0}" -ge 2 ]; then
  ok "the listing shows $REVISION_COUNT revisions this piece could return to"
else
  bad "the listing shows $REVISION_COUNT revisions, expected at least 2"
  sed 's/^/  | /' "$WORK/restore-list.err"
fi
# "current" is a fact about the reference, not about position: every
# revision on the reference the piece runs reads current, which is what makes
# restoring any of them a no-op. The newest one always does.
LAST_CURRENT=$(printf '%s\n' "$REVISIONS" | tail -1 | grep -c ' current$' ||
  true)
check "1" "$LAST_CURRENT" "the newest revision reads as one the piece runs"
RETAINED_LINES=$(printf '%s\n' "$REVISIONS" | grep -c ' not-retained' || true)
check "0" "$RETAINED_LINES" "every revision's source is still there to load"
# The oldest revision is the generation the piece was created on, which the
# rollback above already returned it to — so a revision it is NOT on is the
# one the retarget recorded.
TARGET_REVISION=$($CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  --json 2>/dev/null |
  jq -r '.revisions | map(select(.current == false)) | last | .revisionId')
if [ -n "$TARGET_REVISION" ] && [ "$TARGET_REVISION" != "null" ]; then
  ok "picked a revision the piece is not on: $TARGET_REVISION"
else
  bad "no non-current revision to restore"
fi
BEFORE_RESTORE=$($CF piece inspect --pattern-identity --json \
  --piece "$RESTORE_TARGET" $ARGS 2>/dev/null | jq -r '.patternIdentity')
if $CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  --revision "$TARGET_REVISION" >/dev/null 2>"$WORK/restore-dry.err"; then
  ok "the dry restore exited 0"
else
  bad "the dry restore exited nonzero"
  sed 's/^/  | /' "$WORK/restore-dry.err"
fi
DRY_IDENTITY=$($CF piece inspect --pattern-identity --json \
  --piece "$RESTORE_TARGET" $ARGS 2>/dev/null | jq -r '.patternIdentity')
check "$BEFORE_RESTORE" "$DRY_IDENTITY" "the dry restore wrote nothing"
if $CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  --revision "$TARGET_REVISION" --apply >/dev/null \
  2>"$WORK/restore-apply.err"; then
  ok "the restore exited 0"
else
  bad "the restore exited nonzero"
  sed 's/^/  | /' "$WORK/restore-apply.err"
fi
AFTER_RESTORE=$($CF piece restore -q --piece "$RESTORE_TARGET" $ARGS --json \
  2>/dev/null |
  jq -r --arg id "$TARGET_REVISION" \
    '.revisions | map(select(.revisionId == $id)) | first | .current
     | tostring')
check "true" "$AFTER_RESTORE" "the piece now runs the revision it was given"
# Through the real serializer: the named revision has to survive --json as
# itself. It is also an entry of the listing, and a serializer that reports a
# second reference to one object as a circular one would render it as that
# string here rather than as the revision.
SELECTED_JSON=$($CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  --revision "$TARGET_REVISION" --json 2>/dev/null |
  jq -r '.selected.revisionId // "missing"')
check "$TARGET_REVISION" "$SELECTED_JSON" \
  "--json carries the named revision itself, not a reference to it"
RESUMED_RESTORE=$($CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  --revision "$TARGET_REVISION" --apply --json 2>/dev/null |
  jq -r '.restored | tostring')
check "false" "$RESUMED_RESTORE" \
  "restoring the revision it already runs writes nothing and does not fail"
if $CF piece restore -q --piece "$RESTORE_TARGET" $ARGS \
  --revision not-a-revision --apply >/dev/null 2>"$WORK/restore-bogus.err"
then
  bad "a revision the log does not hold was accepted"
else
  ok "a revision the log does not hold exited nonzero"
fi
if grep -q "$TARGET_REVISION" "$WORK/restore-bogus.err"; then
  ok "the refusal names the revisions the log does hold"
else
  bad "the refusal does not name what is available"
  sed 's/^/  | /' "$WORK/restore-bogus.err"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
