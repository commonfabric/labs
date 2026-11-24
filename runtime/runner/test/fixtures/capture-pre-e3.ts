// One-off capture script for the stored pattern-value fixture.
// Run: deno run -A test/fixtures/capture-pre-e3.ts (from runtime/runner)
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../../src/runtime.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";

const signer = await Identity.fromPassphrase("pre-e3-pattern-value-canary");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ items: { v: number }[] }>(({ items }) => {",
        "  return { vs: items.map((item) => item.v) };",
        "});",
      ].join("\n"),
    },
  ],
};

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const compiled = await runtime.patternManager.compilePattern(PROGRAM);
await runtime.idle();

// JSON.stringify fires Pattern.toJSON(), which delegates to the same
// serialization a pattern value undergoes when written to a cell (the
// runtime's artifact walk, reading `toEncodableForm`).
const serialized = JSON.parse(JSON.stringify(compiled));

const fixtureUrl = new URL(
  "./pre-e3-serialized-pattern.json",
  import.meta.url,
);

const fixture = {
  comment:
    "Stored pattern-VALUE fixture: refsOnly is the current writer's boundary output ($patternRef + schemas, no graph). Earlier vintages (preE3 bare graph, E3 dual-write) were dropped with the legacy read path (identity E5, data-wipe decision). Refresh by re-running test/fixtures/capture-pre-e3.ts.",
  program: PROGRAM,
  serialized: { refsOnly: serialized },
};

await Deno.writeTextFile(
  fixtureUrl,
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log("captured refsOnly keys:", Object.keys(serialized));

await runtime.dispose();
await storageManager.close();
