"""Capture a controlled demand-grace probe from an unchanged checkout."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import sys

repo, output = [Path(arg).resolve() for arg in sys.argv[1:]]
output.mkdir()
helper = "tools/server-execution-topics/demand-grace-probe.ts"
command = ["deno", "run", "--frozen", "-A", helper]
def git(*args):
    return subprocess.check_output(["git", *args], cwd=repo)
def digest(data):
    return hashlib.sha256(data).hexdigest()
def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
head = git("rev-parse", "HEAD").decode().strip()
status = git("status", "--porcelain=v1", "--untracked-files=all")
patch = git("diff", "--binary", "HEAD")
probe = (repo / helper).read_bytes()
(output / "candidate.patch").write_bytes(patch)
(output / "probe.ts.txt").write_bytes(probe)
manifest = {
    "head": head, "command": command, "cwd": str(repo),
    "sourceSha256": digest(probe), "patchSha256": digest(patch),
    "controllerSha256": digest(Path(__file__).read_bytes()),
    "runtime": subprocess.check_output(["zsh", "-lc", "deno --version"], cwd=repo, text=True),
    "fixture": "Three plain durable roots; synthetic demand notifications and one admitted system input; fresh emulated store",
    "cache": "Fresh process/runtime/store; no prior pattern compilation",
    "posture": "Serving runtime ON, asserted by probe; no browser/client/baked shell in this mechanism rig",
    "kind": "Controlled scheduling mechanism; no latency claim",
    "startedAt": now(), "loadBefore": os.getloadavg(), "sourceChecks": [],
}
def save():
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
def guard(phase):
    current = git("status", "--porcelain=v1", "--untracked-files=all")
    assert git("rev-parse", "HEAD").decode().strip() == head
    assert current == status
    assert git("diff", "--binary", "HEAD") == patch
    assert (repo / helper).read_bytes() == probe
    manifest["sourceChecks"].append({"phase": phase, "status": current.decode()})
    save()
guard("before")
with (output / "stdout.log").open("wb") as stdout, (output / "stderr.log").open("wb") as stderr:
    result = subprocess.run(command, cwd=repo, stdout=stdout, stderr=stderr)
manifest.update(exitCode=result.returncode, endedAt=now(), loadAfter=os.getloadavg())
guard("after")
manifest["files"] = {file.name: digest(file.read_bytes()) for file in output.iterdir() if file.is_file() and file.name != "manifest.json"}
save()
print(json.dumps({"output": str(output), "exitCode": result.returncode}))
result.check_returncode()
