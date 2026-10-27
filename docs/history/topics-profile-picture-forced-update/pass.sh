#!/bin/bash
# One rehearsal pass of the kept-activity rollout against the served clone:
# topics first (gated, forced only where the profile-picture narrowing is the
# whole refusal), then the board (gated the same way, expected unforced), then
# the judgment. Stops at the first failure, and before every step confirms the
# server process still holds its port.
#
#   tools/pass.sh <pass dir name>
#
# Run with the clone already served on loopback at offset 2.
set -euo pipefail

R=$HOME/clones/topics-kept-activity-2026-10-26
LABS=$HOME/coding/B-cf-repos/labs-topics-index
DID=did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk
BOARD=of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34
CLONE=$R/clone
DB=$CLONE/engine-v3/engine-v3/$DID.sqlite
P=$R/${1:?pass dir name}
mkdir -p "$P"

export API_URL=http://localhost:8002 SPACE=$DID SCAN_API_URL=http://localhost:8002 SCAN_SPACE=$DID
export CF_IDENTITY=${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}
export PIN_ROOT=$LABS
# The server runs this checkout; the CLI's commit can differ only in pattern
# files, which the CLI compiles from disk.
export CF_SKIP_VERSION_CHECK=1
cd "$LABS"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$P/pass.log"; }
SERVER_PID=$(lsof -nP -iTCP:8002 -sTCP:LISTEN -t | head -1)
[ -n "$SERVER_PID" ] || { log "no server on 8002"; exit 1; }
lsof -nP -iTCP:8002 -sTCP:LISTEN | grep -q '127.0.0.1:8002' ||
  { log "server is not bound to loopback"; exit 1; }
grep -aq 'SERVING A REHEARSAL CLONE' packages/toolshed/local-dev-toolshed.log ||
  { log "no rehearsal banner"; exit 1; }
alive() { kill -0 "$SERVER_PID" 2>/dev/null || { log "server $SERVER_PID is gone"; exit 1; }; }
cf() { deno task cf "$@"; }

log "pass $1 at $(git rev-parse --short HEAD), server $SERVER_PID"
date -u '+%Y-%m-%d %H:%M:%S' > "$P/started"

alive; log "baseline verify"
cf space verify "$CLONE" > "$P/verify-baseline.log" 2>&1
grep -q 'nothing moved' "$P/verify-baseline.log" || { log "baseline not pristine"; exit 1; }

log "variant: the candidate with the author's picture typed unknown"
rm -rf "$P/variant" && mkdir -p "$P/variant/system"
cp -R packages/patterns/topics packages/patterns/collection-naming "$P/variant/"
cp packages/patterns/system/profile-look.ts "$P/variant/system/"
python3 -I - "$P/variant/topics/topic.tsx" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
for old, new in [
    ("  picture?: FabricBytes;\n", "  picture?: unknown;\n"),
    ("bytes={comment.author?.picture}", "bytes={comment.author?.picture as FabricBytes | undefined}"),
]:
    assert s.count(old) == 1, old
    s = s.replace(old, new)
open(p, "w").write(s)
EOF

# Stage A: the topics.
alive; log "survey topics"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --root packages/patterns --retarget topics=packages/patterns/topics/topic.tsx \
  --out "$P/topics-plan.jsonl" > "$P/survey-topics.log" 2>&1
alive; log "gate topics"
deno run --quiet --config deno.jsonc -A "$R/tools/gate.ts" \
  "$P/topics-plan.jsonl" "$P/topics-gated.jsonl" "$P/topics-gate.jsonl" \
  "$LABS/packages/patterns" "$LABS/packages/patterns/topics/topic.tsx" \
  "$P/variant" "$P/variant/topics/topic.tsx" | tee -a "$P/pass.log"
alive; log "apply topics"
cf piece retarget -q -a "$API_URL" -s "$DID" --plan "$P/topics-gated.jsonl" \
  --group-size 25 --apply --out "$P/topics-applied.json" > "$P/apply-topics.log" 2>&1
alive; log "diff topics"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --diff "$P/topics-gated.jsonl" > "$P/diff-topics.log" 2>&1

# Stage B: the board, whose topics now publish the candidate's contract.
alive; log "survey board"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --root packages/patterns --retarget holder=packages/patterns/topics/main.tsx \
  --out "$P/board-plan.jsonl" > "$P/survey-board.log" 2>&1
alive; log "gate board"
deno run --quiet --config deno.jsonc -A "$R/tools/gate.ts" \
  "$P/board-plan.jsonl" "$P/board-gated.jsonl" "$P/board-gate.jsonl" \
  "$LABS/packages/patterns" "$LABS/packages/patterns/topics/main.tsx" \
  "$P/variant" "$P/variant/topics/main.tsx" | tee -a "$P/pass.log"
alive; log "apply board"
cf piece retarget -q -a "$API_URL" -s "$DID" --plan "$P/board-gated.jsonl" \
  --apply --out "$P/board-applied.json" > "$P/apply-board.log" 2>&1
alive; log "diff board"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --diff "$P/board-gated.jsonl" > "$P/diff-board.log" 2>&1

# Judgment.
alive; log "kept scan by board number"
deno run --quiet --config deno.jsonc -A "$R/tools/kept-scan.ts" \
  "$P/kept-scan.jsonl" 1 1400 > /dev/null 2>&1
alive; log "verify --expect-migration"
cf space verify "$CLONE" --expect-migration > "$P/verify-after.log" 2>&1 ||
  { log "verify --expect-migration failed"; exit 1; }
log "churn"
cf inspect churn "$DB" --bucket 60 --since "$(cat "$P/started")" \
  --until "$(date -u '+%Y-%m-%d %H:%M:%S')" > "$P/churn.log" 2>&1 || true
log "fingerprint after"
cf space fingerprint "$DB" --json > "$P/fp-after.json" 2> "$P/fp-after.log"
log "authored-content check"
deno run --quiet --config deno.jsonc -A "$R/tools/authored-check.ts" \
  "$CLONE/pristine/$DID.sqlite" "$DB" "$P/board-plan.jsonl" \
  "$P/authored-check.jsonl" | tee -a "$P/pass.log"
log "done"
