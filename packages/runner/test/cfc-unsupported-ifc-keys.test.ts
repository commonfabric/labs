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

  describe("a label list declared as anything but a list", () => {
    // The specification types these keys as lists (§4.2.1, §8.8). Declared as
    // anything else, each reader skips the value, so the path would carry no
    // label, no floor, or no ceiling; a malformed declaration fails instead
    // (§8.10.3).

    /** Commits a write to a path whose schema declares `ifc`. */
    const commitWriteUnder = async (ifc: Record<string, unknown>) => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        trustSnapshotProvider: () => ({
          id: "trust-snapshot-label-lists",
          actingPrincipal: signer.did(),
        }),
      });
      try {
        const tx = runtime.edit();
        const schema = {
          type: "object",
          properties: { value: { type: "string", ifc } },
          required: ["value"],
        } as unknown as JSONSchema;
        runtime.getCell(signer.did(), "cfc-label-list", schema, tx).set({
          value: "written",
        });
        return await tx.commit().settled;
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    for (
      const key of [
        "confidentiality",
        "integrity",
        "addIntegrity",
        "requiredIntegrity",
        "maxConfidentiality",
      ]
    ) {
      it(`rejects a write to a path declaring ifc.${key} as an object`, async () => {
        const result = await commitWriteUnder({ [key]: {} });
        expect(result.error?.message).toContain(`malformed ${key} at /value`);
      });
    }

    it("rejects a write to a path whose UI contract declares its event integrity as an object", async () => {
      const result = await commitWriteUnder({
        uiContract: {
          helper: "UiAction",
          action: "save",
          requiredEventIntegrity: {},
        },
      });
      expect(result.error?.message).toContain(
        "malformed uiContract.requiredEventIntegrity at /value",
      );
    });

    it("admits a write to a path declaring ifc.confidentiality as a list", async () => {
      const result = await commitWriteUnder({ confidentiality: ["secret"] });
      expect(result.error).toBeUndefined();
    });
  });
});
