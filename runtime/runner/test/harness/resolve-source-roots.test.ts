import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { InMemoryProgram } from "@commonfabric/js-compiler/program";
import { Runtime, runtimePresets } from "../../src/index.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

describe("resolve-source-roots", () => {
  it("retains explicitly attached tests and their import closure", async () => {
    const identity = await Identity.fromPassphrase("root source test");
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime(
      runtimePresets.unitTest({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      }),
    );
    try {
      const program = await runtime.harness.resolve(
        new InMemoryProgram("/main.ts", {
          "/main.ts": "export default 1;",
          "/main.test.ts":
            "import {expected} from './fixture.ts'; export default expected;",
          "/fixture.ts": "export const expected = 1;",
        }),
        { sourceRoots: ["/main.test.ts"] },
      );
      expect(program.sourceRoots).toEqual(["/main.test.ts"]);
      expect(program.files.map((file) => file.name).sort()).toEqual([
        "/fixture.ts",
        "/main.test.ts",
        "/main.ts",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});
