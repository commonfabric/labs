import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Engine verified implementation index", () => {
  // The engine's content-addressed implementation index — the single resolution
  // backing for serialized `$implRef`s (identity E5 deleted the legacy
  // string-keyed `implementationRef` index; this is what remains).

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

  function getExecutableRegistry() {
    return engine.accessForTestingOnly.executableRegistry;
  }

  it("admits registered implementations by { identity, symbol }", () => {
    const fn = () => "value";
    const executableRegistry = getExecutableRegistry();

    executableRegistry.registerVerifiedImplementation("modA", "handler", fn);

    expect(engine.getVerifiedImplementation("modA", "handler")).toBe(fn);
    expect(engine.getVerifiedImplementation("modA", "other")).toBeUndefined();
    expect(engine.getVerifiedImplementation("modB", "handler")).toBeUndefined();
  });

  it("re-registration of the same entry ref points the index at the fresh function", () => {
    // Two evaluations of the same module identity register behaviorally
    // interchangeable functions (SES forbids module-scope mutable state); the
    // index resolves to the latest.
    const first = () => "first";
    const second = () => "second";
    const executableRegistry = getExecutableRegistry();

    executableRegistry.registerVerifiedImplementation("modA", "handler", first);
    executableRegistry.registerVerifiedImplementation(
      "modA",
      "handler",
      second,
    );

    expect(engine.getVerifiedImplementation("modA", "handler")).toBe(second);
  });
});
