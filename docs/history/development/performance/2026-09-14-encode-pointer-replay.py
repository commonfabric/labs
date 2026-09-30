#!/usr/bin/env python3
"""Replay the 2026-09-14 adjacent-pair encoder measurement on two checkouts.

The baseline checkout must contain the same v2-path.bench.ts as the fixed
checkout. This driver writes only its requested output and a temporary script;
the benchmark sources are only read. The embedded script retains the capture's warmup,
batch counts, ordering, and timing boundaries, with runtime import locations.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


DRIVER = """
const registered = [];
Object.defineProperty(Deno, "bench", {
  value: (bench) => registered.push(bench),
});
await import(Deno.args[0]);
const baselineCount = registered.length;
await import(Deno.args[1]);
if (baselineCount !== 5 || registered.length !== 10) {
  throw new Error("Expected five benchmark cases per checkout");
}
const results = [];
for (let caseIndex = 0; caseIndex < baselineCount; caseIndex++) {
  const arms = [registered[caseIndex], registered[caseIndex + baselineCount]];
  if (arms[0].name !== arms[1].name) {
    throw new Error("Benchmark case names differ between checkouts");
  }
  let started = 0;
  let elapsed = 0;
  const context = {
    start() { started = performance.now(); },
    end() { elapsed += performance.now() - started; },
  };
  for (let warm = 0; warm < 500; warm++) {
    for (const arm of arms) arm.fn(context);
  }
  const pairs = [];
  for (let pair = 0; pair < 20; pair++) {
    const sample = [0, 0];
    for (const side of pair % 2 === 0 ? [0, 1] : [1, 0]) {
      elapsed = 0;
      for (let batch = 0; batch < 25; batch++) arms[side].fn(context);
      sample[side] = elapsed / 25;
    }
    pairs.push(sample);
  }
  results.push({ name: arms[0].name, pairs });
}
console.log(JSON.stringify(results));
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path, help="Baseline checkout root")
    parser.add_argument("fixed", type=Path, help="Fixed checkout root")
    parser.add_argument("output", type=Path, help="Output JSON file")
    args = parser.parse_args()
    roots = [args.baseline.resolve(), args.fixed.resolve()]
    benches = [root / "packages/memory/test/v2-path.bench.ts" for root in roots]
    if not all(bench.is_file() for bench in benches):
        parser.error("Both checkouts must contain v2-path.bench.ts")
    if benches[0].read_bytes() != benches[1].read_bytes():
        parser.error("Both checkouts must contain identical benchmark bodies")
    if roots[0] == roots[1]:
        parser.error("Baseline and fixed must be separate checkouts")
    runs = []
    with tempfile.TemporaryDirectory(prefix="encode-pointer-replay-") as temp:
        driver = Path(temp) / "paired.mjs"
        driver.write_text(DRIVER)
        command = [
            "deno", "run", "--no-lock", "-A", "--config",
            str(roots[1] / "deno.jsonc"), str(driver),
            *(bench.as_uri() for bench in benches),
        ]
        for index in range(5):
            meta = dict(run=index + 1, loadBefore=os.getloadavg(), started=time.time())
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            meta.update(
                loadAfter=os.getloadavg(), finished=time.time(),
                results=json.loads(result.stdout),
            )
            runs.append(meta)
    args.output.write_text(json.dumps(runs, indent=2) + "\n")


if __name__ == "__main__":
    main()
