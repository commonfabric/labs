import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";

/** A program whose entry holds `body`, under a name of its own. */
function programNamed(name: string, body: string): RuntimeProgram {
  return { main: name, files: [{ name, contents: body }] };
}

describe("Engine.typeCheckBatch()", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("charges every program in the batch against its own main", async () => {
    const programs = [
      programNamed("/one.tsx", "export default 1;"),
      programNamed("/two.tsx", "export default 2;"),
    ];

    const checked = await engine.typeCheckBatch(programs);

    expect(checked.patternCount).toBe(2);
    expect(checked.diagnostics).toEqual([]);
    expect([...checked.durations.keys()].toSorted())
      .toEqual(["/one.tsx", "/two.tsx"]);
    // Which program each figure belongs to is the whole of what this
    // pins. The figures themselves are read off `performance.now()`,
    // which this package's preload replaces with a fake clock that only
    // advances when a timer fires, so every one of them is zero here and
    // a floor under any of them would assert the clock rather than the
    // code. What is left to hold is that each is a number: a mapping
    // that found no program yields `undefined`, which fails this.
    for (const ms of checked.durations.values()) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("charges a program for the local imports it brought with it", async () => {
    // Two programs may name one path and still hold different bytes under
    // it, so a file belongs to the program that resolved it rather than to
    // the batch. What one program spends on `/local.ts` is therefore its
    // own, and it is charged against that program's main rather than
    // appearing under a key of its own.
    const withLocal: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "import { one } from './local.ts';\nexport default one;\n",
        },
        { name: "/local.ts", contents: "export const one = 1;\n" },
      ],
    };
    const alone = programNamed("/alone.tsx", "export default 2;");

    const checked = await engine.typeCheckBatch([withLocal, alone]);

    expect(checked.diagnostics).toEqual([]);
    expect([...checked.durations.keys()].toSorted())
      .toEqual(["/alone.tsx", "/main.tsx"]);
    expect(checked.fileCount).toBeGreaterThanOrEqual(3);
  });

  it("charges nothing for a batch with no programs in it", async () => {
    const checked = await engine.typeCheckBatch([]);

    expect(checked.patternCount).toBe(0);
    expect(checked.durations.size).toBe(0);
  });
});
