import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("pattern-node-patternref");
const space = signer.did();

const NESTED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "const inc = lift(({ x }: { x: number }) => x + 1);",
        "const Inner = pattern<{ n: number }>(({ n }) => ({",
        "  out: inc({ x: n }),",
        "}));",
        "export default pattern<{ v: number }>(({ v }) => ({",
        "  child: Inner({ n: v }),",
        "}));",
      ].join("\n"),
    },
  ],
};

const SCOPED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "const inc = lift(({ x }: { x: number }) => x + 1);",
        "const Inner = pattern<{ n: number }>(({ n }) => ({",
        "  out: inc({ x: n }),",
        "}));",
        "export default pattern<{ v: number }>(({ v }) => ({",
        "  child: Inner.asScope('user')({ n: v }),",
        "}));",
      ].join("\n"),
    },
  ],
};

describe("nested pattern factory instantiation", () => {
  it("materializes a nested pattern factory", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const parent = await runtime.patternManager.compilePattern(
        NESTED_PROGRAM,
      );
      const result = runtime.run(
        undefined,
        parent as never,
        { v: 5 } as never,
        runtime.getCell(space, "nested-patternref") as never,
      );
      await runtime.idle();
      assertEquals(
        JSON.parse(JSON.stringify(await result.pull())),
        { child: { out: 6 } },
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("preserves a derived pattern's declared scope", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const parent = await runtime.patternManager.compilePattern(
        SCOPED_PROGRAM,
      );
      const result = runtime.run(
        undefined,
        parent as never,
        { v: 5 } as never,
        runtime.getCell(space, "scoped-patternref") as never,
      );
      await runtime.idle();
      assertEquals(
        JSON.parse(JSON.stringify(await result.pull())),
        { child: { out: 6 } },
      );
      const childLink = (result as never as {
        key: (key: string) => {
          resolveAsCell: () => {
            getAsNormalizedFullLink: () => { scope: string };
          };
        };
      }).key("child").resolveAsCell().getAsNormalizedFullLink();
      assertEquals(childLink.scope, "user");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
