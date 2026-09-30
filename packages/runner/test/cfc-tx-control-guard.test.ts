import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  CFC_ENFORCEMENT_MODES,
  type CfcEnforcementMode,
} from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-tx-control-guard");

describe("CFC transaction control guard", () => {
  // Regression guard for the transaction control surface (audit S3).
  //
  // setCfcEnforcementMode / prepareCfc are on the public
  // IExtendedStorageTransaction, so code holding a transaction can reach
  // them. prepareCfc was fixed to always verify (S2); the remaining
  // weakening lever is setCfcEnforcementMode lowering an enforcing transaction
  // back to disabled/observe. The mode must not be lowerable below the highest
  // enforcing level set on a tx.

  it("refuses to weaken an enforcing transaction's mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Pinned: the steps below read the mode back as "enforce-explicit", then
      // raise it to "enforce-strict" and read that back too.
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      expect(tx.getCfcState().enforcementMode).toBe("enforce-explicit");

      // Downgrades to weaker modes must throw.
      expect(() => tx.setCfcEnforcementMode("disabled")).toThrow();
      expect(() => tx.setCfcEnforcementMode("observe")).toThrow();

      // Mode is unchanged after the rejected downgrades.
      expect(tx.getCfcState().enforcementMode).toBe("enforce-explicit");

      // Raising strictness is still allowed.
      expect(() => tx.setCfcEnforcementMode("enforce-strict")).not.toThrow();
      expect(tx.getCfcState().enforcementMode).toBe("enforce-strict");

      // ...and cannot then be lowered back to a weaker enforcing level.
      expect(() => tx.setCfcEnforcementMode("enforce-explicit")).toThrow();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a mode that is not on the ladder", async () => {
    // A name the strictness ranking cannot rank passes the floor comparison
    // whatever the floor is, so the anti-downgrade pin would not hold against
    // it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
    });
    try {
      const tx = runtime.edit();
      const offLadder = "enforce-strictly" as CfcEnforcementMode;
      expect(() => tx.setCfcEnforcementMode(offLadder)).toThrow(
        CFC_ENFORCEMENT_MODES.join(", "),
      );
      expect(tx.getCfcState().enforcementMode).toBe("enforce-strict");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows juggling non-enforcing modes before any enforcement", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Pinned: the steps below start from a non-enforcing mode and assert that
      // moving between "observe" and "disabled" is accepted until the first
      // enforcing mode sets the floor.
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      // disabled <-> observe impose no floor (neither enforces).
      expect(() => tx.setCfcEnforcementMode("observe")).not.toThrow();
      expect(() => tx.setCfcEnforcementMode("disabled")).not.toThrow();
      expect(() => tx.setCfcEnforcementMode("enforce-explicit")).not.toThrow();
      // Now the floor is set.
      expect(() => tx.setCfcEnforcementMode("observe")).toThrow();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("still rejects a violation after a blocked downgrade attempt", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The steps below ask the transaction to weaken to "disabled" and
      // expect the guard to refuse, then commit a violation and expect a
      // rejection. Both need the transaction to start from an enforcing rung.
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-tx-control-guard",
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
        "cfc-tx-control-guard",
        schema,
        tx,
      );
      cell.set({ savedTitle: "not user authorized" });

      // Attacker tries to disable enforcement, then commit the violation.
      expect(() => tx.setCfcEnforcementMode("disabled")).toThrow();
      tx.prepareCfc();
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
