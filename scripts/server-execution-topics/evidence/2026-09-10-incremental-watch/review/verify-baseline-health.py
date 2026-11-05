"""Capture baseline ON health from a fresh checkout and a new output directory.

The checkout must contain the recorded helper commit in its Git object store.
Every source check covers the entire checkout; only the two captured helper
files may be untracked after preparation. The baseline production source stays
at BASE throughout the build and workload.
"""

from pathlib import Path
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

BASE = "27f10d2d4f02f125c0492e5d6288acb3f0da148b"
HELPERS = "f6bc2af1e36b5a3d817be75c1d3632bc964e3e37"
checkout = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir()
manifest = {
    "checkout": str(checkout),
    "head": BASE,
    "helperCommit": HELPERS,
    "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "sourceChecks": [],
    "commands": [],
    "helpers": {},
    "status": "preparing",
}


def save():
    # Exact process paths stay with the local capture. The shareable manifest
    # uses named roots that a replay supplies, including command arguments.
    captured = json.dumps(manifest, indent=2) + "\n"
    provenance = output / "capture-provenance.json"
    provenance.write_bytes(captured.encode("utf-8"))
    def portable(value):
        if isinstance(value, str):
            for root, name in sorted(
                [(str(checkout), "${CHECKOUT}"), (str(output), "${OUTPUT}")],
                key=lambda pair: len(pair[0]), reverse=True,
            ):
                value = value.replace(root, name)
            return value
        if isinstance(value, list):
            return [portable(item) for item in value]
        if isinstance(value, dict):
            return {key: portable(item) for key, item in value.items()}
        return value

    document = portable(manifest)
    document["pathRoots"] = {
        "CHECKOUT": "baseline checkout passed as the first argument",
        "OUTPUT": "capture directory passed as the second argument",
    }
    document["externalProvenance"] = {
        "file": provenance.name,
        "sha256": hashlib.sha256(captured.encode("utf-8")).hexdigest(),
    }
    (output / "manifest.json").write_bytes(
        (json.dumps(document, indent=2) + "\n").encode("utf-8")
    )


def verify_source(phase, expected):
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=checkout, text=True
    ).strip()
    status = subprocess.check_output(
        ["git", "status", "--porcelain=v1", "--untracked-files=all",
         "--ignore-submodules=none"], cwd=checkout, text=True
    )
    manifest["sourceChecks"].append({"phase": phase, "head": head, "status": status})
    save()
    if head != BASE or set(status.splitlines()) != expected:
        raise RuntimeError("Baseline source check failed: " + phase)
    for name, digest in manifest["helpers"].items():
        if hashlib.sha256((checkout / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError("Captured helper changed: " + name)


def run(command, label, env):
    row = {"command": command, "cwd": str(checkout), "label": label}
    manifest["commands"].append(row)
    save()
    with (output / (label + ".log")).open("wb") as log:
        result = subprocess.run(command, cwd=checkout, env=env, stdout=log,
                                stderr=subprocess.STDOUT)
    row["exitCode"] = result.returncode
    save()
    result.check_returncode()


try:
    verify_source("before-helper-copy", set())
    allowed = set()
    for basename in ["run-arm.ts", "seed-check.ts"]:
        name = "tools/server-execution-topics/" + basename
        data = subprocess.check_output(["git", "show", HELPERS + ":" + name],
                                       cwd=checkout)
        destination = checkout / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise RuntimeError("Refusing to replace " + name)
        destination.write_bytes(data)
        (output / basename).write_bytes(data)
        manifest["helpers"][name] = hashlib.sha256(data).hexdigest()
        allowed.add("?? " + name)
    verify_source("before-build", allowed)
    env = os.environ.copy()
    env["EXPERIMENTAL_SERVER_EXECUTION"] = "true"
    env["COMMIT_SHA"] = BASE
    manifest["flags"] = {key: value for key, value in env.items()
                         if key.startswith("EXPERIMENTAL_") or key == "COMMIT_SHA"}
    run(["deno", "--version"], "runtime", env)
    run(["deno", "task", "build-binaries", "toolshed"], "build", env)
    verify_source("after-build", allowed)
    binary = checkout / ".ci-cache/binaries/toolshed-baked-opposite"
    binary.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=binary.parent, delete=False) as file:
        temporary = Path(file.name)
    try:
        shutil.copyfile(checkout / "dist/toolshed", temporary)
        temporary.chmod(0o755)
        os.replace(temporary, binary)
    finally:
        temporary.unlink(missing_ok=True)
    manifest["binarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
    tests = ["topic-board-fixture", "topic-board-child-contract",
             "topic-create-onscreen", "sx2-events", "lunch-poll-vote",
             "cfc-group-chat-chained-event-gate-multi-runtime"]
    run(["deno", "run", "-A", "tools/server-execution-topics/run-arm.ts",
         "opposite", str(output / "arm"), "correctness", "test", "--no-check",
         "-A", *["packages/patterns/integration/" + name + ".test.ts"
                 for name in tests]], "integration", env)
    verify_source("after-workload", allowed)
    manifest["status"] = "passed"
except BaseException as error:
    manifest["status"] = "failed"
    manifest["error"] = str(error)
    raise
finally:
    manifest["endedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
