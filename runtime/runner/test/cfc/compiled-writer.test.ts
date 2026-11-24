import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { CompiledPlan } from "../../src/cfc/compiled-plans.ts";
import { compiledWriterOf } from "../../src/cfc/compiled-writer.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

/** A plan of three bodies, of which the first two have `Body.code`. */
const plan = {
  outputs: [],
  bodies: [
    { code: { module: "sha256:module", binding: ["record"] }, writes: [] },
    { code: { module: "sha256:module", binding: [] }, writes: [] },
    { writes: [] },
  ],
  cones: [],
  templates: [],
  collections: [],
  stateCells: [],
} as unknown as CompiledPlan;

describe("compiledWriterOf()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: string;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled writer");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    pattern = runtime.compiledPlans.register(
      plan,
      "code",
      runtimeWritePolicyAuthorization,
    );
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  it("returns the module identity and the binding path that the registered plan holds for the body", () => {
    expect(compiledWriterOf(tx, { kind: "compiled", pattern, body: 0 }))
      .toEqual({ moduleIdentity: "sha256:module", bindingPath: ["record"] });
  });

  it("returns `undefined` for a pattern the runtime did not register", () => {
    // A stamp that names an identity of the caller's own choosing. The
    // identity of a registered pattern is the hash of its plan and its value
    // code, so another plan has another identity.

    expect(
      compiledWriterOf(tx, { kind: "compiled", pattern: "forged", body: 0 }),
    ).toBeUndefined();
  });

  it("returns `undefined` for a body that has no `Body.code`", () => {
    expect(compiledWriterOf(tx, { kind: "compiled", pattern, body: 2 }))
      .toBeUndefined();
  });

  it("returns `undefined` for a body whose `Body.code` has an empty binding path", () => {
    expect(compiledWriterOf(tx, { kind: "compiled", pattern, body: 1 }))
      .toBeUndefined();
  });

  it("returns `undefined` for a body the plan does not have", () => {
    expect(compiledWriterOf(tx, { kind: "compiled", pattern, body: 7 }))
      .toBeUndefined();
  });

  it("returns `undefined` for an identity that names no body", () => {
    expect(compiledWriterOf(tx, { kind: "compiled", pattern }))
      .toBeUndefined();
  });
});
