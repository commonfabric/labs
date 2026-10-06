import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-unsupported-ifc-keys");

describe("CFC unsupported ifc claims fail closed", () => {
  // Regression guard for unimplemented ifc.* claims (audit S10).
  //
  // Several ifc keys are defined by the spec but unimplemented in the runner.
  // They were silently ignored (and dropped by schema-merge), so an author
  // declaring them got no enforcement and no error — a fail-open trap. A write
  // to a path declaring an unsupported claim must fail closed, the same way
  // collection already does (projection is implemented — see
  // cfc-projection.test.ts).

  const unsupportedClaims: Array<[string, unknown]> = [
    ["opaque", true],
    ["passThrough", true],
    ["recomposeProjections", [{ scope: "x" }]],
    ["combinedFrom", ["/a", "/b"]],
    ["combinationType", "join"],
    ["transformation", { kind: "trusted" }],
    ["addedIntegrity", [{ type: "https://example.com/x" }]],
  ];

  for (const [claimKey, claimValue] of unsupportedClaims) {
    it(`rejects a write to a path declaring ifc.${claimKey}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        trustSnapshotProvider: () => ({
          id: `trust-snapshot-unsupported-${claimKey}`,
          actingPrincipal: signer.did(),
        }),
      });
      try {
        const tx = runtime.edit();
        const schema = {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { [claimKey]: claimValue },
            },
          },
          required: ["value"],
        } as unknown as JSONSchema;
        const cell = runtime.getCell(
          signer.did(),
          `cfc-unsupported-${claimKey}`,
          schema,
          tx,
        );
        cell.set({ value: "written" });

        const digest = tx.prepareCfc();
        expect(digest).toBe("");
        const result = await tx.commit().settled;
        expect(result.error?.message).toContain(
          `unsupported trust-sensitive claim ${claimKey}`,
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }
});
