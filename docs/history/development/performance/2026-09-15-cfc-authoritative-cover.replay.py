"""Replay the recorded arm-B comparison in an isolated checkout.

Set CHECKOUT to a checkout containing this report and OUT to a new output
folder. The baseline commit must be available in CHECKOUT's Git history.
Produces five alternating unprofiled pairs and one separate CPU-profile pair.
"""

import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

BASE = "dd23b59eea6623e37a490c427d57e86d0c0e0373"
checkout = Path(os.environ["CHECKOUT"]).resolve()
out = Path(os.environ["OUT"]).resolve()
subprocess.run(["git", "-C", str(checkout), "rev-parse", "--git-dir"], check=True,
               capture_output=True)
if subprocess.run(["git", "-C", str(checkout), "cat-file", "-e", f"{BASE}^{{commit}}"],
                  capture_output=True).returncode:
    raise SystemExit("Baseline history is missing. Run: " + shlex.join(
        ["git", "-C", str(checkout), "fetch", "origin", BASE]))
out.mkdir(parents=True, exist_ok=False)
artifacts = checkout / "docs/history/development/performance"
harness = artifacts / "2026-09-15-cfc-wildcard-source-index.harness.patch"
optimization = artifacts / "2026-09-15-cfc-authoritative-cover.patch"
modules = ["prepare.ts", "consumed-label-index.ts"]
fixture = "packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx"
flags = ["test", fixture, "--cfc-shell-posture", "--verbose", "--stats-threshold",
         "0", "--no-idempotency-check"]
with tempfile.TemporaryDirectory(prefix="cfc-authoritative-cover-") as directory:
    bench = Path(directory) / "checkout"
    subprocess.run(["git", "-C", str(checkout), "worktree", "add", "--detach",
                    str(bench), BASE], check=True)
    try:
        subprocess.run(["git", "apply", str(harness)], cwd=bench, check=True)
        source = bench / "packages/runner/src/cfc"
        before = {name: (source / name).read_text(encoding="utf-8")
                  for name in modules}
        subprocess.run(["git", "apply", str(optimization)], cwd=bench, check=True)
        after = {name: (source / name).read_text(encoding="utf-8")
                 for name in modules}
        for pair in range(6):
            arms = ["before", "after"] if pair % 2 == 0 else ["after", "before"]
            for arm in arms:
                for name, content in (before if arm == "before" else after).items():
                    (source / name).write_text(content, encoding="utf-8")
                label = f"ladder-{pair}-{arm}"
                env = dict(os.environ)
                if pair == 5:
                    env.update(CF_PROF_OUT=str(out / label), CF_PROF_CPU="1",
                               CF_PROF_INTERVAL_US="500")
                    command = ["deno", "run", "--no-lock", "-A",
                               "skills/perf-investigation/scripts/profile-cf.ts", *flags]
                else:
                    command = ["deno", "task", "cf", *flags]
                started = time.monotonic()
                with (out / f"{label}.log").open("w", encoding="utf-8") as log:
                    result = subprocess.run(command, cwd=bench, env=env,
                                            stdout=log, stderr=subprocess.STDOUT)
                row = {"label": label, "status": result.returncode,
                       "seconds": time.monotonic() - started}
                with (out / "runs.jsonl").open("a", encoding="utf-8") as log:
                    log.write(json.dumps(row) + "\n")
                print(json.dumps(row), flush=True)
                result.check_returncode()
    finally:
        subprocess.run(["git", "-C", str(checkout), "worktree", "remove", "--force",
                        str(bench)], check=True)
