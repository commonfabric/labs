#!/bin/bash
# One rehearsal pass of the combined Topics rollout (#9256 with the mention
# pivot fix) against the served clone:
#
# 1. the board first, gated (forced only where the profile picture's
#    narrowing is the whole refusal), then stepped once so the new pivot
#    stores its rows, and checked offline to hold them at space scope;
# 2. the topics in batches: each batch rebinds every topic's `boardCrossrefs`
#    to the board's `crossrefs`, then gates its rows, then applies them;
# 3. the judgment.
#
# Stops at the first failure, and before every step confirms the server
# process still holds its port.
#
#   tools/pass.sh <pass dir name> [batch size]
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
BATCH=${2:-200}
[[ "$BATCH" =~ ^[1-9][0-9]*$ ]] || { echo "batch size must be a positive integer" >&2; exit 2; }
# A pass directory is one run's record; reusing one would mix two runs.
[ -e "$P" ] && { echo "$P already exists; name a new pass" >&2; exit 1; }
mkdir -p "$P"

export API_URL=http://localhost:8002 SPACE=$DID SCAN_API_URL=http://localhost:8002 SCAN_SPACE=$DID
export CF_IDENTITY=${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}
export PIN_ROOT=$LABS
# The server runs this checkout; the CLI's commit can differ only in pattern
# files, which the CLI compiles from disk.
export CF_SKIP_VERSION_CHECK=1
cd "$LABS"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$P/pass.log"; }
SERVER_PID=$(lsof -nP -iTCP:8002 -sTCP:LISTEN -t | head -1 || true)
[ -n "$SERVER_PID" ] || { log "no server on 8002"; exit 1; }
lsof -nP -iTCP:8002 -sTCP:LISTEN | grep -q '127.0.0.1:8002' ||
  { log "server is not bound to loopback"; exit 1; }
grep -aq 'SERVING A REHEARSAL CLONE' packages/toolshed/local-dev-toolshed.log ||
  { log "no rehearsal banner"; exit 1; }
alive() { kill -0 "$SERVER_PID" 2>/dev/null || { log "server $SERVER_PID is gone"; exit 1; }; }
cf() { deno task cf "$@"; }
run() { deno run --quiet --config deno.jsonc -A "$@"; }

log "pass $1 at $(git rev-parse --short HEAD), server $SERVER_PID, batches of $BATCH"
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

# Stage 1: the board, so the pivot exists at space scope before any topic is
# bound to it.
alive; log "survey board"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --root packages/patterns --retarget holder=packages/patterns/topics/main.tsx \
  --out "$P/board-plan.jsonl" > "$P/survey-board.log" 2>&1
alive; log "gate board"
run "$R/tools/gate.ts" \
  "$P/board-plan.jsonl" "$P/board-gated.jsonl" "$P/board-gate.jsonl" \
  "$LABS/packages/patterns" "$LABS/packages/patterns/topics/main.tsx" \
  "$P/variant" "$P/variant/topics/main.tsx" | tee -a "$P/pass.log"
alive; log "apply board"
cf piece retarget -q -a "$API_URL" -s "$DID" --plan "$P/board-gated.jsonl" \
  --apply --out "$P/board-applied.json" > "$P/apply-board.log" 2>&1
alive; log "step board"
cf piece step -a "$API_URL" -s "$DID" --piece "$BOARD" > "$P/step-board.log" 2>&1
alive; log "pivot check"
run "$R/tools/pivot-check.ts" "$DB" "$BOARD" "$P/pivot-rows.json" | tee -a "$P/pass.log"

# Stage 2: the topics, a batch at a time: rebind, then gate, then apply.
alive; log "survey topics"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --root packages/patterns --retarget topics=packages/patterns/topics/topic.tsx \
  --out "$P/topics-plan.jsonl" > "$P/survey-topics.log" 2>&1
python3 -I - "$P" "$BATCH" <<'EOF'
import json, sys
p, size = sys.argv[1], int(sys.argv[2])
rows = [json.loads(l) for l in open(f"{p}/topics-plan.jsonl")]
header, body = rows[0], [r for r in rows[1:] if r.get("op")]
for i in range(0, len(body), size):
    n = i // size + 1
    with open(f"{p}/batch-{n:02d}-plan.jsonl", "w") as f:
        f.write("\n".join(json.dumps(r) for r in [header] + body[i:i + size]) + "\n")
    with open(f"{p}/batch-{n:02d}-ids.txt", "w") as f:
        f.write("".join(f"of:{r['piece']}\n" for r in body[i:i + size]))
print(f"{len(body)} topics in {(len(body) + size - 1) // size} batches")
EOF
for plan in "$P"/batch-*-plan.jsonl; do
  b=${plan%-plan.jsonl}
  alive; log "$(basename "$b"): rebind"
  run "$R/tools/rebind.ts" "$BOARD" "$b-ids.txt" "$P/rebind.jsonl" | tee -a "$P/pass.log"
  alive; log "$(basename "$b"): gate"
  run "$R/tools/gate.ts" \
    "$plan" "$b-gated.jsonl" "$b-gate.jsonl" \
    "$LABS/packages/patterns" "$LABS/packages/patterns/topics/topic.tsx" \
    "$P/variant" "$P/variant/topics/topic.tsx" | tee -a "$P/pass.log"
  alive; log "$(basename "$b"): apply"
  cf piece retarget -q -a "$API_URL" -s "$DID" --plan "$b-gated.jsonl" \
    --group-size 25 --apply --out "$b-applied.json" > "$b-apply.log" 2>&1
done
python3 -I - "$P" <<'EOF'
import glob, json, sys
p = sys.argv[1]
plans = sorted(glob.glob(f"{p}/batch-*-gated.jsonl"))
rows = [json.loads(l) for l in open(plans[0])][:1]
for plan in plans:
    rows += [json.loads(l) for l in open(plan)][1:]
with open(f"{p}/topics-gated.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in rows) + "\n")
gates = [json.loads(l) for plan in plans for l in open(plan.replace("-gated.jsonl", "-gate.jsonl"))]
with open(f"{p}/topics-gate.jsonl", "w") as f:
    f.write("".join(json.dumps(g) + "\n" for g in gates))
EOF
alive; log "diff topics"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --diff "$P/topics-gated.jsonl" > "$P/diff-topics.log" 2>&1
alive; log "diff board"
cf piece survey -q -a "$API_URL" -s "$DID" --piece "$BOARD" --path topics \
  --diff "$P/board-gated.jsonl" > "$P/diff-board.log" 2>&1

# Judgment.
# Every board number from 1 to the board's topic count names a topic, so a
# row that cannot be read fails the pass as surely as a wrong one.
TOPICS=$(python3 -I -c 'import json, sys; print(json.loads(open(sys.argv[1]).readline())["enumerated"]["collection"])' "$P/topics-plan.jsonl")
alive; log "kept scan by board number, 1 to $TOPICS"
run "$R/tools/kept-scan.ts" "$P/kept-scan.jsonl" 1 "$TOPICS" > "$P/kept-scan.log" 2>&1 ||
  { log "kept scan failed (kept-scan.log)"; exit 1; }
python3 -I - "$P/kept-scan.jsonl" <<'EOF2' | tee -a "$P/pass.log"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
errors = [r["n"] for r in rows if "error" in r]
wrong = [r["n"] for r in rows if "error" not in r and not r["right"]]
print(json.dumps({"numbers": len(rows), "errors": errors[:20], "wrong": wrong[:20]}))
sys.exit(1 if errors or wrong or not rows else 0)
EOF2
alive; log "backlink check"
run "$R/tools/backlink-check.ts" "$BOARD" "$P/pivot-rows.json" "$P/rebind.jsonl" \
  "$P/backlink-check.jsonl" | tee -a "$P/pass.log"
alive; log "verify --expect-migration"
cf space verify "$CLONE" --expect-migration > "$P/verify-after.log" 2>&1 ||
  { log "verify --expect-migration failed"; exit 1; }
log "churn"
cf inspect churn "$DB" --bucket 60 --since "$(cat "$P/started")" \
  --until "$(date -u '+%Y-%m-%d %H:%M:%S')" > "$P/churn.log" 2>&1 || true
log "authored-content check"
run "$R/tools/authored-check.ts" \
  "$CLONE/pristine/$DID.sqlite" "$DB" "$P/board-plan.jsonl" \
  "$P/authored-check.jsonl" | tee -a "$P/pass.log"
log "done"
