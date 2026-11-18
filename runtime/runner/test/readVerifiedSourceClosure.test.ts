/**
 * Nothing in this file loads the compiler stack before the case that needs it
 * unloaded, and the load is memoized for the life of the process, so the case
 * checks that state first and loads the stack itself afterwards.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { CacheableModule } from "../src/harness/types.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import {
  compilerStackLoaded,
  ensureCompilerStack,
} from "../src/harness/deferred-compiler-stack.ts";
import {
  readVerifiedSourceClosure,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase("read verified source closure");
const space = signer.did() as MemorySpace;

describe("readVerifiedSourceClosure()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("returns `undefined` for a closure that needs the parser until the parser is loaded", async () => {
    // A compiled document written without `sourceImports` attests no import
    // list, so verifying its source means parsing it. The identity is hashed
    // from the import list the source declares, which is none, rather than
    // from a parse, and the record surface is supplied for the same reason.
    const source = "export const revision = 'legacy';\n";
    const module: CacheableModule = {
      identity: computeModuleHashes({
        main: "/legacy.ts",
        files: [{ name: "/legacy.ts", contents: source }],
      }, { declarations: new Map([["/legacy.ts", { imports: [] }]]) })
        .get("/legacy.ts")!,
      filename: "/legacy.ts",
      source,
      js: "export const revision = 'legacy';",
      imports: [],
      exportNames: ["revision"],
      starTargetSpecs: [],
      importSpecs: [],
    };
    const runtimeVersion = await runtime.patternManager
      .compileCacheRuntimeVersion({ patternCoverage: false });
    expect(runtimeVersion).toBeDefined();
    expect(
      (await runtime.editWithRetry((tx) => {
        writeSourceDocs(runtime, space, [module], module.identity, tx);
        writeCompiledDocs(runtime, space, [module], module.identity, {
          runtimeVersion: runtimeVersion!,
        }, tx);
      })).error,
    ).toBeUndefined();

    const read = () => {
      const tx = runtime.edit();
      try {
        return readVerifiedSourceClosure(runtime, space, module.identity, tx);
      } finally {
        tx.abort();
      }
    };

    expect(compilerStackLoaded()).toBe(false);
    expect(read()).toBeUndefined();

    await ensureCompilerStack();
    expect(read()?.get(module.identity)?.code).toBe(source);
  });
});
