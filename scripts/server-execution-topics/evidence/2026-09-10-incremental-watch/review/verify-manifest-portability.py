"""Exercise the controller's manifest writer without building or starting a server.

Pass the controller path. Extracting its save function avoids the CLI's
checkout/build side effects; assertions cover output files, not source text.
"""

from pathlib import Path
import ast
import hashlib
import json
import sys
import tempfile
from unittest.mock import patch

source = Path(sys.argv[1]).read_text(encoding="utf-8")
parsed = ast.parse(source)
save = next(node for node in parsed.body
            if isinstance(node, ast.FunctionDef) and node.name == "save")
module = ast.Module(body=[save], type_ignores=[])
for label in ["plain", 'spaces and "quotes"', "nonascii-é"]:
    with tempfile.TemporaryDirectory(prefix="manifest-control-") as directory:
        root = Path(directory)
        checkout = root / (label + "-checkout")
        output = root / (label + "-capture")
        output.mkdir()
        manifest = {
            "checkout": str(checkout),
            "commands": [{
                "command": ["deno", "run", str(checkout / "run.ts"),
                            str(output / "arm")],
                "cwd": str(checkout), "exitCode": 0,
            }],
            "sourceChecks": [{"status": "", "head": "source-head"}],
            "status": "passed",
        }
        namespace = {"output": output, "checkout": checkout,
                     "manifest": manifest, "json": json, "hashlib": hashlib}
        exec(compile(module, "controller-save", "exec"), namespace)
        for status in ["passed", "failed"]:
            manifest["status"] = status
            manifest["error"] = "failed at " + str(output / "arm")
            # Model Windows text newline translation on every host. The
            # published hash must cover the exact provenance bytes on disk.
            write_text = Path.write_text
            def crlf_text(path, text, *args, **kwargs):
                return write_text(path, text.replace("\n", "\r\n"), *args, **kwargs)
            with patch.object(Path, "write_text", crlf_text):
                namespace["save"]()
            portable = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            assert portable["checkout"] == "${CHECKOUT}"
            command = portable["commands"][0]
            assert command["cwd"] == "${CHECKOUT}"
            assert command["command"][-2:] == ["${CHECKOUT}/run.ts", "${OUTPUT}/arm"]
            assert portable["error"] == "failed at ${OUTPUT}/arm"
            assert portable["status"] == status
            assert portable["sourceChecks"] == manifest["sourceChecks"]
            provenance = output / portable["externalProvenance"]["file"]
            assert json.loads(provenance.read_text(encoding="utf-8")) == manifest
            assert hashlib.sha256(provenance.read_bytes()).hexdigest() == portable["externalProvenance"]["sha256"]
            assert str(checkout) not in json.dumps(portable, ensure_ascii=False)
            assert str(output) not in json.dumps(portable, ensure_ascii=False)
            print(ascii(label), status, "portable paths and exact hashed provenance passed")
