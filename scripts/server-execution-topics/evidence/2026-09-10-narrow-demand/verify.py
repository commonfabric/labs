"""Verify the bundled capture bytes, optionally extracting them for replay."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--extract", type=Path, help="New directory for verified artifacts")
args = parser.parse_args()
root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
bundle = json.loads((root / manifest["artifactBundle"]).read_text(encoding="utf-8"))
if bundle["encoding"] != "utf-8":
    raise ValueError("Unsupported bundle encoding")
if set(bundle["files"]) != {entry["path"] for entry in manifest["artifactFiles"]}:
    raise ValueError("Bundle paths differ from the artifact manifest")
verified = {}
for entry in manifest["artifactFiles"]:
    path = PurePosixPath(entry["path"])
    if (
        path.is_absolute()
        or ".." in path.parts
        or "\\" in entry["path"]
        or ":" in entry["path"]
    ):
        raise ValueError(f"Artifact path leaves the extraction directory: {path}")
    data = bundle["files"][entry["path"]].encode("utf-8")
    actual = hashlib.sha256(data).hexdigest()
    if actual != entry["sha256"]:
        raise ValueError(f"SHA-256 mismatch for {path}: {actual}")
    verified[path] = data

if args.extract is not None:
    if not args.extract.is_absolute():
        raise ValueError("Extraction destination must be an absolute path")
    checkout = next(
        (parent for parent in root.parents if (parent / ".git").exists()), None
    )
    destination_root = args.extract.resolve()
    if checkout is not None and destination_root.is_relative_to(checkout):
        raise ValueError("Extraction destination must be outside the checkout")
    args.extract.mkdir(parents=True, exist_ok=False)
    for path, data in verified.items():
        destination = args.extract / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)

print(f"Verified {len(verified)} artifacts against their recorded SHA-256 hashes.")
