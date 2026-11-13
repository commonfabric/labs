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

  it("reports a type error at the line its author wrote", async () => {
    // Each program in the batch carries its own `/<id>` prefix, so the
    // erroring program goes second to check the lookup reaches past the
    // first.

    const checked = await engine.typeCheckBatch([
      programNamed("/one.tsx", "export default 1;"),
      programNamed(
        "/two.tsx",
        "const wrong: number = 'text';\nexport default wrong;",
      ),
    ]);

    // The batch reports this error from its type check and again from its
    // emit, so the distinct messages are what this reads.
    expect([
      ...new Set(checked.diagnostics.map((diagnostic) => diagnostic.message)),
    ]).toEqual(["1: Type 'string' is not assignable to type 'number'."]);
  });

  it("reports a transformer's diagnostic only where it transforms", async () => {
    // A result schema declaring a reserved key `unknown` draws a transformer
    // error, and no type error.

    const program = programNamed(
      "/main.tsx",
      [
        "/// <cts-enable />",
        'import { pattern, UI } from "commonfabric";',
        "type Out = { [UI]: unknown; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [UI]: <span>{s.label}</span>, label: s.label }),",
        ");",
      ].join("\n"),
    );

    const transformed = await engine.typeCheckBatch([program]);
    const checked = await engine.typeCheckBatch([program], {
      transform: false,
    });

    expect(transformed.diagnostics.map((diagnostic) => diagnostic.message))
      .toEqual([expect.stringMatching(/^4: pattern\(\) output field `\$UI`/)]);
    expect(checked.diagnostics).toEqual([]);
  });

  it("reports a compiled body the module verifier refuses, and only where it transforms", async () => {
    // A module-scope `let` draws the transformer's own diagnostic too, so the
    // verifier's is picked out by its wording.

    const program = programNamed(
      "/main.ts",
      "let n = 0;\nexport const bump = () => ++n;\n",
    );
    const verifierSays = (
      checked: Awaited<ReturnType<Engine["typeCheckBatch"]>>,
    ) =>
      checked.diagnostics.filter((diagnostic) =>
        diagnostic.message.endsWith(
          "Top-level mutable bindings are not allowed in SES mode",
        )
      );

    const transformed = await engine.typeCheckBatch([program]);
    const checked = await engine.typeCheckBatch([program], {
      transform: false,
    });

    expect(verifierSays(transformed)).toEqual([{
      file: expect.stringMatching(/^\/[^/]+\/main\.ts$/),
      message: expect.stringMatching(/^\/[^/]+\/main\.ts:\d+:\d+: Top-level/),
    }]);
    expect(checked.diagnostics).toEqual([]);
  });

  it("charges nothing for a batch with no programs in it", async () => {
    const checked = await engine.typeCheckBatch([]);

    expect(checked.patternCount).toBe(0);
    expect(checked.durations.size).toBe(0);
  });
});
