import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cfc-runtime-options");

describe("CFC runtime options", () => {
  it("defaults CFC enforcement to enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    expect(runtime.cfcEnforcementMode).toBe("enforce-strict");

    await runtime.dispose();
    await storageManager.close();
  });

  it("respects an explicit CFC enforcement override", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The assertion below reads this value back off the runtime.
      cfcEnforcementMode: "disabled",
    });

    expect(runtime.cfcEnforcementMode).toBe("disabled");

    await runtime.dispose();
    await storageManager.close();
  });

  it("defaults compiledPatterns off and leaves the transaction's plan labels off", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    try {
      expect(runtime.experimental.compiledPatterns).toBe(false);
      expect(tx.getCfcState().planLabels).toBe(false);
    } finally {
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("turns the transaction's plan labels on with compiledPatterns", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { compiledPatterns: true },
    });
    const tx = runtime.edit();
    try {
      expect(tx.getCfcState().planLabels).toBe(true);
    } finally {
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
