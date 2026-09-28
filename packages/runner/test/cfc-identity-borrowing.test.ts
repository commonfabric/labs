import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-identity-borrowing");

describe("CFC write-policy identity borrowing", () => {
  // Regression guard for the write-policy identity fallback (audit S13).
  //
  // writeAuthorizedBy is verified against the implementation identity captured
  // when the write-policy input was recorded. The pre-fix code fell back to the
  // transaction's *current* identity (state.implementationIdentity) for inputs
  // recorded before any identity was set, so an unattributed write into a
  // protected field could borrow a trusted identity set later in the same
  // transaction and pass verification. Unattributed writes must fail closed.

  it("does not attribute an unattributed write to a later-set identity", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-identity-borrowing",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          counter: {
            type: "number",
            ifc: {
              // Builtin write-authority claim: only the named builtin may write.
              writeAuthorizedBy: ["trustedIncrement"],
            },
          },
        },
        required: ["counter"],
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-identity-borrowing",
        schema,
        tx,
      );

      // The write is recorded now, while no implementation identity is active —
      // so this write is unattributed.
      cell.set({ counter: 1 });

      // Later in the same transaction a trusted builtin identity becomes active
      // (e.g. an unrelated builtin runs). The earlier unattributed write must
      // NOT borrow it to satisfy writeAuthorizedBy.
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "trustedIncrement",
      });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
  for (const firstAttributed of [false, true]) {
    it(`uses the first deepest input when its identity is ${firstAttributed ? "attributed" : "absent"}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        const trusted = {
          kind: "builtin",
          builtinId: "trustedIncrement",
        } as const;
        const field = {
          type: "number",
          ifc: { writeAuthorizedBy: ["trustedIncrement"] },
        } as const;
        const schema = {
          type: "object",
          properties: { counter: field },
        } as const;
        const cell = runtime.getCell(
          signer.did(),
          "deepest-identity",
          schema,
          tx,
        );
        setCfcImplementationIdentity(tx, trusted);
        cell.set({ counter: 1 });
        setCfcImplementationIdentity(tx, firstAttributed ? trusted : undefined);
        const target = { ...cell.getAsNormalizedFullLink(), path: ["counter"] };
        tx.recordCfcWritePolicyInput({ kind: "schema", target, schema: field });
        setCfcImplementationIdentity(
          tx,
          firstAttributed
            ? { kind: "builtin", builtinId: "untrusted" }
            : trusted,
        );
        tx.recordCfcWritePolicyInput({ kind: "schema", target, schema: field });
        tx.prepareCfc();
        const result = await tx.commit();
        expect(isCfcEnforcementRejection(result.error)).toBe(!firstAttributed);
        if (firstAttributed) expect(result.error).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }
});
