import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { exposedResultCell } from "../../src/builtins/scope-policy.ts";
import { Runtime } from "../../src/runtime.ts";

describe("exposedResultCell()", () => {
  it("retains a session selection scope when the selected value belongs to the space", async () => {
    const signer = await Identity.fromPassphrase("exposed result scope");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    try {
      const selected = runtime.getCell<{ name: string }>(
        signer.did(),
        "selected",
        undefined,
        tx,
      );
      selected.set({ name: "shared item" });
      const selection = runtime.getCell<{ name: string }>(
        signer.did(),
        "selection",
        undefined,
        tx,
        "session",
      );
      selection.setRawUntyped(selected.getAsLink());
      const result = runtime.getCell<{ name: string }>(
        signer.did(),
        "result",
        undefined,
        tx,
      );
      result.setRawUntyped(selection.getAsLink());

      const exposed = exposedResultCell(runtime, tx, result);

      expect(selected.getAsNormalizedFullLink().scope).toBe("space");
      expect(result.getAsNormalizedFullLink().scope).toBe("space");
      expect(exposed.getAsNormalizedFullLink().scope).toBe("session");
      expect(exposed.getAsNormalizedFullLink().id).toBe(
        result.getAsNormalizedFullLink().id,
      );
      expect(exposed.get()).toEqual({ name: "shared item" });
    } finally {
      tx.abort();
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
