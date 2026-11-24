"""Summarizes one rehearsal pass directory written by tools/pass.sh.

    python3 -I tools/judge.py <pass dir> [pristine fingerprint json]

Reports the gate's decisions, the applies (a topics stage applied in batches is
read from its `batch-*-applied.json` reports), the diffs, the kept scan, and the
verify. A pass that wrote `fp-after.json` also gets every entity whose hash
changed between the pristine fingerprint and the pass's, by kind, with the
changed free-cells written out for `field-diff.ts`; `pass.sh` does not write one,
since a full fingerprint costs as long as the verify. That breakdown is not the
authored-content check: a Topic's argument fingerprints as an owned-cell, so a
clobbered Topic input would not appear among the free-cells.
`authored-check.ts` compares the Topics' arguments and records directly, and is
the check a pass is judged by.
"""

import collections
import glob
import json
import os
import sys

P = sys.argv[1]
BEFORE = sys.argv[2] if len(sys.argv) > 2 else None


def jsonl(path):
    return [json.loads(line) for line in open(path) if line.strip()]


def fvj(path):
    return json.loads(open(path).read().removeprefix("fvj1:"))


for stage in ("topics", "board"):
    gate = jsonl(f"{P}/{stage}-gate.jsonl")
    print(stage, "gate", dict(collections.Counter(g["gate"] for g in gate)))
    messages = collections.Counter(
        g.get("message", "").split(": input link at ")[-1].split(":")[0].split(".")[-1]
        for g in gate if g["gate"] == "forced"
    )
    print("  forced on", dict(messages))
    reports = [fvj(path) for path in sorted(glob.glob(f"{P}/batch-*-applied.json"))] \
        if stage == "topics" and not os.path.exists(f"{P}/topics-applied.json") \
        else [fvj(f"{P}/{stage}-applied.json")]
    rows = [row for report in reports for row in report["rows"]]
    print("  applied", sum(report["applied"] for report in reports),
          "complete", bool(reports) and all(report["complete"] for report in reports),
          "reports", len(reports),
          dict(collections.Counter(r.get("verdict") for r in rows)))
    ms = sorted(r.get("elapsedMs", 0) for r in rows)
    if ms:
        print("  row ms median", ms[len(ms) // 2], "p90", ms[int(len(ms) * 0.9)], "max", ms[-1])
    print("  diff:", open(f"{P}/diff-{stage}.log").read().strip().splitlines()[-1:])

scan = jsonl(f"{P}/kept-scan.jsonl")
found = [r for r in scan if "error" not in r]
print("kept scan: numbers", len(scan), "found", len(found),
      dict(collections.Counter((r["version"], r["right"]) for r in found)))
for r in found:
    if not r["right"]:
        print("  wrong", json.dumps(r))
errors = collections.Counter(r["error"][:80] for r in scan if "error" in r)
print("  errors", dict(errors.most_common(3)))

print("verify:", " | ".join(
    line.strip() for line in open(f"{P}/verify-after.log")
    if line.strip() and not line.startswith("\x1b")
))


if BEFORE is None or not os.path.exists(f"{P}/fp-after.json"):
    print("fingerprint: not compared (authored content: authored-check.ts)")
    sys.exit(0)


def hashes(path):
    data = json.load(open(path))
    return {(e["id"], e["scope"]): (e["kind"], e["hash"]) for e in data["perEntity"]}


before, after = hashes(BEFORE), hashes(f"{P}/fp-after.json")
changed = collections.Counter(
    after[key][0] for key in after
    if key in before and before[key][1] != after[key][1]
)
print("fingerprint changes by kind (authored content: authored-check.ts)", dict(changed),
      "| added", len(after.keys() - before.keys()),
      "| removed", len(before.keys() - after.keys()))
free = [key for key in after
        if key in before and before[key][1] != after[key][1] and after[key][0] == "free-cell"]
with open(f"{P}/changed-free-cells.txt", "w") as f:
    f.write("".join(f"{key[0]}\t{key[1]}\n" for key in free))
print("  changed free-cells written:", len(free),
      "(non-space scopes:", sum(1 for key in free if key[1] != "space"), ")")
