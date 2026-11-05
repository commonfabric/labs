#!/usr/bin/env python3
"""Replay paired string-key benchmarks using an isolated baseline worktree.

Accepts baseline and fixed checkouts plus an output JSON path. The baseline's
HEAD supplies unchanged dependencies; the recorded patch supplies candidate
modules, and the fixed checkout supplies the utility and its benchmark. Source checkouts are read-only. A
registered temporary worktree is removed after the run. Requires Git and Deno.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

DRIVER = """
import os from 'node:os';
const registered=[];
Object.defineProperty(Deno,'bench',{value:b=>registered.push(b)});
const groups=[
 ['utils/test/string-tuple-key',5,500,25,true],
 ['runner/test/cfc-consumed-source-dedup',10,20,3,true],
 ['runner/test/scheduler-invalid-causes',6,100,10,false],
];
const results={base:"CHECKOUT",version:Deno.version,cpu:os.cpus()[0].model,loadBefore:os.loadavg(),started:new Date().toISOString(),cases:[]};
for(const [path,count,warmup,batches,bracketed] of groups){
 const offset=registered.length;
 for(const suffix of ['', '.final'])await import(new URL(`packages/${path}${suffix}.bench.ts`,Deno.args[0]+'/').href);
 if(registered.length!==offset+2*count)throw Error('unexpected case count');
 for(let index=0;index<count;index++){
  const arms=[registered[offset+index],registered[offset+count+index]];
  if(arms[0].name!==arms[1].name)throw Error('case mismatch');
  let started=0,elapsed=0;
  const timer={start(){started=performance.now()},end(){elapsed+=performance.now()-started}};
  const run=side=>{if(bracketed)arms[side].fn(timer);else {const begin=performance.now();arms[side].fn();elapsed+=performance.now()-begin;}};
  for(let warm=0;warm<warmup;warm++)for(const side of [0,1])run(side);
  const pairs=[];
  for(let pair=0;pair<20;pair++){
   const sample=[0,0];for(const side of pair%2?[1,0]:[0,1]){elapsed=0;for(let batch=0;batch<batches;batch++)run(side);sample[side]=elapsed/batches;}pairs.push(sample);
  }
  results.cases.push({path,name:arms[0].name,warmup,batches,bracketed,pairs});
 }
}
results.loadAfter=os.loadavg();results.finished=new Date().toISOString();console.log(JSON.stringify(results));
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("fixed", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    baseline, fixed = args.baseline.resolve(), args.fixed.resolve()
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=baseline, text=True,
    ).strip()
    evidence = json.loads(Path(__file__).with_name(
        "2026-09-14-string-tuple-keys.results.json",
    ).read_text())
    if commit != evidence["base"]:
        parser.error(f"Baseline HEAD must be {evidence['base']}")
    with tempfile.TemporaryDirectory(prefix="string-tuple-replay-") as temp:
        base = Path(temp) / "baseline"
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(base), commit],
            cwd=baseline, check=True,
        )
        try:
            utility = "packages/utils/src/string-tuple-key.ts"
            if hashlib.sha256((fixed / utility).read_bytes()).hexdigest() != evidence["sources"][utility]["sha256"]:
                raise ValueError("Utility source differs from the captured implementation")
            shutil.copyfile(fixed / utility, base / utility)
            (base / "packages/utils/src/string-tuple-key.json-baseline.ts").write_text(
                "export const stringTupleKey = (parts: readonly string[]): string => "
                "JSON.stringify(parts);\n"
            )
            config = base / "packages/utils/deno.jsonc"
            config.write_text(config.read_text().replace(
                '    "./staged-map":',
                '    "./string-tuple-key": "./src/string-tuple-key.ts",\n'
                '    "./staged-map":',
            ))
            benchmark = "packages/utils/test/string-tuple-key.bench.ts"
            if hashlib.sha256((fixed / benchmark).read_bytes()).hexdigest() != evidence["sources"][benchmark]["sha256"]:
                raise ValueError("Utility benchmark differs from the captured workload")
            (base / benchmark).write_text((fixed / benchmark).read_text().replace(
                "../src/string-tuple-key.ts", "../src/string-tuple-key.json-baseline.ts",
            ))
            shutil.copyfile(
                fixed / benchmark,
                base / "packages/utils/test/string-tuple-key.final.bench.ts",
            )
            subprocess.run(
                ["git", "apply", "--include=packages/runner/src/cfc/prepare.ts",
                 "--include=packages/runner/src/scheduler/invalidation.ts"],
                input=evidence["patch"], text=True, cwd=base, check=True,
            )
            for source, name in [
                ("cfc/prepare", "cfc-consumed-source-dedup"),
                ("scheduler/invalidation", "scheduler-invalid-causes"),
            ]:
                source_path = f"packages/runner/src/{source}.ts"
                shutil.copyfile(
                    base / source_path,
                    base / f"packages/runner/src/{source}.key-final.ts",
                )
                bench = base / f"packages/runner/test/{name}.bench.ts"
                if bench.read_bytes() != (fixed / bench.relative_to(base)).read_bytes():
                    raise ValueError(f"Benchmark bodies differ: {name}")
                bench.with_name(f"{name}.final.bench.ts").write_text(
                    bench.read_text().replace(
                        f"../src/{source}.ts", f"../src/{source}.key-final.ts",
                    )
                )
            subprocess.run(
                ["git", "restore", "packages/runner/src/cfc/prepare.ts",
                 "packages/runner/src/scheduler/invalidation.ts"],
                cwd=base, check=True,
            )
            driver = Path(temp) / "paired.mjs"
            driver.write_text(DRIVER)
            runs = []
            for _ in range(5):
                result = subprocess.run(
                    ["deno", "run", "--no-lock", "-A", "--config",
                     str(base / "deno.jsonc"), str(driver), base.as_uri()],
                    capture_output=True, text=True, check=True,
                )
                runs.append(json.loads(result.stdout))
            args.output.write_text(json.dumps({"base": commit, "runs": runs}, indent=2) + "\n")
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(base)],
                cwd=baseline, check=True,
            )


if __name__ == "__main__":
    main()
