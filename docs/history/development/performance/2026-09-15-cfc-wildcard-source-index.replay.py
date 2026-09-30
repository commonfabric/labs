"""Replay paired wildcard-index measurements against the recorded baseline.

Set CHECKOUT to the Labs checkout containing this change and the recorded
baseline commit's history. A shallow checkout must fetch that commit first;
the history check prints the exact command if it is missing. Prints JSONL to
stdout; all generated baseline modules are isolated in a temporary directory.
"""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile

TS_SOURCE = r"""import { PathPrefixIndex as BeforePrefix } from "./before-path-prefix-index.ts";
import { ConsumedLabelIndex as BeforeOverlap } from "./legacy-consumed.ts";
import { PathPrefixIndex as AfterPrefix } from "CHECKOUT/packages/runner/src/cfc/path-prefix-index.ts";
import { ConsumedLabelIndex as AfterOverlap } from "CHECKOUT/packages/runner/src/cfc/consumed-label-index.ts";
import { PATH_INDEX_GRID, pathIndexCorpus } from "CHECKOUT/packages/runner/test/cfc/path-index-corpus.ts";
const count = 8192;
for (const {size, fraction} of PATH_INDEX_GRID) {
  const {sources, queries: all} = pathIndexCorpus(size, fraction);
  const queries = Array.from({length: count}, (_, i) => all[(i * 7919) % all.length]);
  const beforePrefix = new BeforePrefix();
  const afterPrefix = new AfterPrefix();
  for (const path of sources) {beforePrefix.add(path); afterPrefix.add(path);}
  const entries = sources.map(path => ({path, label:{}}));
  const beforeOverlap = new BeforeOverlap(entries);
  const afterOverlap = new AfterOverlap(entries);
  for (const kind of ["prefix", "overlap"]) {
    const run = (arm: string) => {
      let result=0;
      const repeats = arm === "after" || fraction === 0 ? 16 : 1;
      const start=performance.now();
      if (kind==="prefix") {
        const index = arm==="before"?beforePrefix:afterPrefix;
        for (let repeat=0;repeat<repeats;repeat++) for (const path of queries) result += Number(index.hasPrefixOf(path));
      } else {
        const index = arm==="before"?beforeOverlap:afterOverlap;
        for (let repeat=0;repeat<repeats;repeat++) for (const path of queries) result += index.overlapping(path).length;
      }
      return {us:(performance.now()-start)*1000/count/repeats, result:result/repeats, queryCount:count*repeats};
    };
    for(let i=0;i<10;i++) {run("before");run("after");}
    for(let pair=0;pair<7;pair++) {
      const results:Record<string,ReturnType<typeof run>>={};
      for(const arm of pair%2===0?["before","after"]:["after","before"]) results[arm]=run(arm);
      if(results.before.result!==results.after.result) throw new Error("Unequal results");
      console.log(JSON.stringify({size,fraction,kind,pair,...results}));
    }
  }
}
"""

BASE = "53baf62fdaf9dae6824bc9c5a0da812a64b95d6c"
checkout = Path(os.environ["CHECKOUT"]).resolve()
baseline = subprocess.run(
    ["git", "cat-file", "-e", f"{BASE}^{{commit}}"],
    cwd=checkout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
if baseline.returncode != 0:
    fetch = shlex.join(["git", "-C", str(checkout), "fetch", "origin", BASE])
    raise SystemExit(
        f"CHECKOUT must contain baseline commit {BASE}. "
        f"Fetch its history before replaying:\n{fetch}"
    )

with tempfile.TemporaryDirectory(prefix="cfc-wildcard-replay-") as directory:
    scratch = Path(directory)
    for name in ["path-prefix-index.ts", "consumed-label-index.ts"]:
        source = subprocess.check_output(
            ["git", "show", f"{BASE}:packages/runner/src/cfc/{name}"],
            cwd=checkout, text=True, encoding="utf-8",
        )
        if name == "consumed-label-index.ts":
            for dependency in ["canonical.ts", "types.ts"]:
                source = source.replace(
                    f'"./{dependency}"',
                    f'"{(checkout / "packages/runner/src/cfc" / dependency).as_uri()}"',
                )
            source = source.replace('"./path-prefix-index.ts"',
                                    '"./before-path-prefix-index.ts"')
            target = "legacy-consumed.ts"
        else:
            target = "before-path-prefix-index.ts"
        (scratch / target).write_text(source, encoding="utf-8")
    script = TS_SOURCE.replace("CHECKOUT", checkout.as_uri())
    (scratch / "paired-grid.ts").write_text(script, encoding="utf-8")
    subprocess.run(
        ["deno", "run", "--no-lock", "-A", "--config",
         str(checkout / "deno.jsonc"), str(scratch / "paired-grid.ts")],
        cwd=checkout, check=True,
    )
