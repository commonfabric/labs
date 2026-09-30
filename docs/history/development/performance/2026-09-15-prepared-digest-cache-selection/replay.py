"""Replay the fixed-baseline cache comparison in fresh isolated worktrees.

Usage: python3 replay.py --repo /path/to/labs --output /fresh/output --prepare-only
Omit --prepare-only to run all five rounds, GC probes, and the profiled pair.
Requires git, Python 3, and Deno 2.9.4 on PATH. Output must not already exist.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--prepare-only", action="store_true")
args = parser.parse_args()
source = Path(__file__).resolve().parent
metadata = json.loads((source / "data.json").read_text())
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
for name, expected in metadata["patchSha256"].items():
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
        raise ValueError(f"Patch hash mismatch: {name}")
checkouts = {}
for arm in ["baseline", "epoch", "parts", "lru"]:
    checkout = output / arm
    subprocess.run(["git", "-C", str(args.repo.resolve()), "worktree", "add",
                    "--detach", str(checkout), metadata["base"]], check=True)
    for patch in ["shared.patch", f"{arm}.patch"]:
        subprocess.run(["git", "apply", str(source / patch)], cwd=checkout,
                       check=True)
    checkouts[arm] = checkout
if args.prepare_only:
    raise SystemExit(0)


def run(arm, name, command, cwd=None, environment=None):
    prefix = output / name
    env = {**os.environ, "DIGEST_BENCH_OUT": str(prefix),
           "DIGEST_BENCH_PROFILE": "0", **(environment or {})}
    with prefix.with_suffix(".stdout").open("w") as stdout, \
            prefix.with_suffix(".log").open("w") as stderr:
        subprocess.run(command, cwd=cwd or checkouts[arm], env=env,
                       stdout=stdout, stderr=stderr, check=True)
    print(name, "complete", flush=True)


for experiment, script in [("arm-b", "prepared-digest-arm-b.ts"),
                           ("repeated", "prepared-digest-repeated.ts")]:
    for round_index, order in enumerate(metadata["orders"]):
        for arm in order:
            run(arm, f"{experiment}-{arm}-{round_index}",
                ["deno", "run", "--no-check", "--no-lock", "-A", f"scripts/{script}"])
for round_index, order in enumerate(metadata["orders"]):
    for arm in order:
        run(arm, f"unit-{arm}-{round_index}",
            ["deno", "bench", "--no-check", "--no-lock", "-A", "--json",
             "test/cfc-digest-commit.bench.ts"], checkouts[arm] / "packages/runner")
for arm in checkouts:
    run(arm, f"gc-{arm}", ["deno", "run", "--no-check", "--no-lock",
                           "--v8-flags=--expose-gc", "-A",
                           "scripts/prepared-digest-gc-probe.ts"])
for arm in ["parts", "lru"]:
    run(arm, f"retention-{arm}", ["deno", "run", "--no-check", "--no-lock",
                                  "--v8-flags=--expose-gc", "-A",
                                  "scripts/prepared-digest-retention.ts"])
run("parts", "activity-probe", ["deno", "run", "--no-check", "--no-lock", "-A",
                                  "scripts/prepared-digest-repeat-probe.ts"])
for arm in ["epoch", "baseline"]:
    run(arm, f"profile-{arm}", ["deno", "run", "--no-check", "--no-lock", "-A",
                                "scripts/prepared-digest-arm-b.ts"],
        environment={"DIGEST_BENCH_PROFILE": "1"})
