import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { InMemoryProgram } from "@commonfabric/js-compiler/program";
import { Runtime, runtimePresets } from "../../src/index.ts";
import { Engine } from "../../src/harness/engine.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

describe("Engine.resolve()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({
      as: await Identity.fromPassphrase("engine resolve"),
    });
    runtime = new Runtime(
      runtimePresets.unitTest({
        apiUrl: new URL("http://localhost/"),
        storageManager,
      }),
    );
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const program = () =>
    new InMemoryProgram("/main.tsx", {
      "/main.tsx": [
        "import { pattern } from 'commonfabric';",
        "import { label } from './label.ts';",
        "export default pattern(() => ({ label }));",
      ].join("\n"),
      "/label.ts": "export const label = 'label';",
    });

  it("resolves the import closure without loading the TypeScript environment types", async () => {
    using environmentTypes = stub(
      Engine,
      "getEnvironmentTypes",
      () => Promise.reject(new Error("environment types loaded")),
    );

    const resolved = await runtime.harness.resolve(program());

    expect(resolved.files.map((file) => file.name).sort()).toEqual([
      "/label.ts",
      "/main.tsx",
    ]);
    expect(environmentTypes.calls).toHaveLength(0);
  });

  it("leaves loading the environment types to the compile that follows it", async () => {
    using environmentTypes = stub(
      Engine,
      "getEnvironmentTypes",
      Engine.getEnvironmentTypes,
    );

    const resolved = await runtime.harness.resolve(program());
    expect(environmentTypes.calls).toHaveLength(0);
    await runtime.patternManager.compilePattern(resolved);

    expect(environmentTypes.calls.length).toBeGreaterThan(0);
  });
});
