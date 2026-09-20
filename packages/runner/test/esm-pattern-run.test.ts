import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getPatternProgram } from "../src/builder/pattern-metadata.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern run via the ESM module loader", () => {
  // End-to-end: a real reactive pattern compiles AND runs through the ESM
  // module-record loader path (compileToRecordGraph + evaluateRecordGraph),
  // producing correct reactive output — not just loading.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles and runs a multi-file pattern through the ESM loader", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/util.ts",
          contents: "export const double = (x:number)=>x*2;",
        },
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

    const compiled = await runtime.patternManager.compilePattern(program);
    // The exported pattern is hardened (transitively frozen) at the module
    // boundary, yet its rehydration program still associates afterward: the
    // association lives in a `WeakMap` side-table, and a write to one does not
    // mutate the frozen object.
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(getPatternProgram(compiled)?.main).toEqual("/main.tsx");

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "esm pattern run",
      undefined,
      tx,
    );
    const result = runtime.run(tx, compiled, { value: 3 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 6 });
  });

  it("runs a pattern through a named re-export barrel (`export { x } from`)", async () => {
    // A barrel that re-exports a sibling's binding compiles to a `var ... =
    // require(...)` preamble plus a live getter. The re-export must both verify
    // AND resolve the live binding correctly end-to-end.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/sibling.ts",
          contents: "export const factor = (x:number)=>x*3;",
        },
        {
          name: "/barrel.ts",
          contents: "export { factor } from './sibling.ts';",
        },
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "import { factor } from './barrel.ts';",
            "const tripled = lift((x:number)=>factor(x));",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  return { result: tripled(value) };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    expect(Object.isFrozen(compiled)).toBe(true);

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "esm re-export barrel run",
      undefined,
      tx,
    );
    const result = runtime.run(tx, compiled, { value: 5 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 15 });
  });

  it("composes a frozen sub-pattern imported from another module", async () => {
    // The sub-pattern is exported from /sub.tsx (and hardened at the module
    // boundary), then imported and instantiated INSIDE the parent pattern. This
    // drives a frozen exported pattern through instantiatePatternNode — the path
    // where harden-safety matters (binding/parent-noting must operate on mutable
    // copies, never the frozen original).
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/sub.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const inc = lift((x:number)=>x+1);",
            "export const sub = pattern<{ n: number }>(({ n }) => {",
            "  return { out: inc(n) };",
            "});",
          ].join("\n"),
        },
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "import { sub } from './sub.tsx';",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  const child = sub({ n: value });",
            "  return { result: child.out };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    expect(Object.isFrozen(compiled)).toBe(true);

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "esm composed pattern run",
      undefined,
      tx,
    );
    const result = runtime.run(tx, compiled, { value: 4 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 5 });
  });
});
