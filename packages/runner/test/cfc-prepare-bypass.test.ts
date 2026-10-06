import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-prepare-bypass-tests");

describe("CFC prepareCfc verification bypass", () => {
  // Regression guard for the prepareCfc verification-bypass (audit S2).
  //
  // The hole: prepareCfc(input) skipped prepareBoundaryCommit whenever an input
  // was supplied, and the commit-time digest recheck only confirms the input
  // matches real activity — not that policy verification ran. Untrusted code
  // holding the transaction could reconstruct the genuine prepared-digest input
  // from the public read/write getters, hand it to prepareCfc, and commit a
  // policy-violating transaction cleanly.
  //
  // The fix removes the input parameter entirely so verification always runs.
  // This test pins the behavioral contract: a relevant, policy-violating
  // transaction can never reach a committed state through prepareCfc.

  it("rejects a writeAuthorizedBy violation even when prepareCfc is driven directly", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-prepare-bypass",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-prepare-bypass",
        schema,
        tx,
      );
      // Unauthorized write into a writeAuthorizedBy-protected field.
      cell.set({ savedTitle: "not user authorized" });

      // Even if a caller reconstructs the genuine prepared-digest input from the
      // public transaction surfaces, there is no way to feed it to prepareCfc:
      // the parameter was removed (audit S2) so verification always runs. Pin
      // that prepareCfc accepts no argument and still rejects the violation.
      const attackerInput = (tx as ExtendedStorageTransaction)
        .accessForTestingOnly.buildPreparedDigestInput();
      expect(attackerInput).toBeDefined();
      // deno-lint-ignore no-explicit-any
      expect(() => (tx as any).prepareCfc(attackerInput)).not.toThrow();

      // Verification must have run and invalidated the transaction regardless of
      // the ignored extra argument.
      expect(tx.getCfcState().prepare.status).toBe("invalidated");

      const result = await tx.commit().settled;
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
