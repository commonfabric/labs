import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// Benchmark: the module-record loader (compile + evaluate) for a representative
// multi-file pattern — compartment construction plus per-module importNow. This
// is the runtime's only module-load path.

const signer = await Identity.fromPassphrase("bench operator");

function makeEngine(): { engine: Engine; dispose: () => Promise<void> } {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const engine = runtime.harness as Engine;
  return {
    engine,
    dispose: async () => {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "import { double } from './util.ts';",
        "const dbl = lift((x:number)=>double(x));",
        "export default pattern<{ value: number }>(({ value }) => {",
        "  return { result: dbl(value) };",
        "});",
      ].join("\n"),
    },
  ],
};

// Warm the engine once (compiler + runtime init) so the bench measures
// steady-state compile+evaluate, not first-call initialization.
const esm = makeEngine();
await esm.engine.initialize();

Deno.bench("ESM: compileAndEvaluateModules", { group: "loader" }, async () => {
  await esm.engine.compileAndEvaluateModules(program);
});

globalThis.addEventListener("unload", () => {
  void esm.dispose();
});
