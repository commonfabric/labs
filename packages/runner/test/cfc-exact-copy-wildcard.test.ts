import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-exact-copy-wildcard");

describe("CFC exactCopyOf array wildcard", () => {
  // Regression guard for exactCopyOf under array wildcards (audit W2.15).
  //
  // walkIfcSchema emits "*" for array items, but the write-value reconstruction
  // matches path segments literally, so a wildcard exactCopyOf claim never
  // matched a concrete write and deepEqual(undefined, undefined) passed
  // vacuously — the claim was accepted (and its label copied) with no
  // verification. A wildcard exactCopyOf must fail closed.

  it("rejects an exactCopyOf claim on an array-item (wildcard) path", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-exact-copy-wildcard",
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string", ifc: { confidentiality: ["secret"] } },
            },
            copies: {
              type: "array",
              items: { type: "string", ifc: { exactCopyOf: ["items", "*"] } },
            },
          },
          required: ["items", "copies"],
        } as const satisfies JSONSchema,
        tx,
      );
      cell.set({ items: ["a"], copies: ["a"] });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("exactCopyOf");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
