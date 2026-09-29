import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";

const signer = await Identity.fromPassphrase("write-policy-any-of");

function policy(writer: string, action: string) {
  return {
    writeAuthorizedBy: {
      __ctWriterIdentityOf: {
        file: "/main.tsx",
        path: [writer],
        moduleIdentity: "test-module",
      },
    },
    uiContract: {
      helper: "UiAction" as const,
      action,
      trustedPattern: "ReviewedSurface",
      requiredEventIntegrity: ["ReviewedSurface"],
    },
  };
}

const schema: JSONSchemaObj = {
  type: "string",
  ifc: { writePolicyAnyOf: [policy("send", "Send"), policy("edit", "Edit")] },
};

describe("cfc-write-policy-any-of", () => {
  function fixture() {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    return {
      async write(
        writer: string,
        action?: string,
        candidate: JSONSchema = schema,
        initialization?: "setup" | "default" | "seed",
        value: string | undefined = writer,
        recordedValue: string | undefined = value,
      ) {
        const tx = runtime.edit();
        setCfcTrustSnapshot(tx, {
          id: "test-trust",
          actingPrincipal: signer.did(),
        });
        setCfcImplementationIdentity(tx, {
          kind: "verified",
          moduleIdentity: "test-module",
          sourceFile: "/main.tsx",
          bindingPath: [writer],
        });
        const cell = runtime.getCell(
          signer.did(),
          "protected-value",
          candidate,
          tx,
        );
        cell.set(value);
        const target = cell.getAsNormalizedFullLink();
        if (initialization === "setup") {
          tx.recordCfcWritePolicyInput({
            kind: "structural-provenance",
            claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
            target: { ...target, id: "of:setup-result" },
            sources: [target],
          }, runtimeWritePolicyAuthorization);
        } else if (initialization === "default" || initialization === "seed") {
          tx.recordCfcWritePolicyInput({
            kind: "initialization",
            mode: initialization,
            target,
            value: recordedValue,
          }, runtimeWritePolicyAuthorization);
        }
        if (action !== undefined) {
          tx.recordCfcWritePolicyInput({
            kind: "trusted-event",
            target: cell.getAsNormalizedFullLink(),
            eventId: "test-event",
            provenance: {
              origin: "dom",
              trusted: true,
              ui: {
                pattern: "ReviewedSurface",
                eventIntegrity: ["ReviewedSurface"],
                uiContractDataset: { uiAction: action },
              },
            },
          });
        }
        tx.prepareCfc();
        return await tx.commit();
      },
      async dispose() {
        await runtime.dispose();
        await storageManager.close();
      },
    };
  }

  it("allows alternating writers with their own reviewed actions", async () => {
    const f = fixture();
    try {
      expect((await f.write("send", "Send")).error).toBeUndefined();
      expect((await f.write("edit", "Edit")).error).toBeUndefined();
      expect((await f.write("send", "Send")).error).toBeUndefined();
    } finally {
      await f.dispose();
    }
  });

  for (
    const [writer, action] of [["rogue", "Send"], ["send", "Edit"], [
      "edit",
      "Send",
    ], ["send", undefined]]
  ) {
    it(`rejects writer ${writer} with action ${action ?? "missing"}`, async () => {
      const f = fixture();
      try {
        expect((await f.write(writer, action)).error?.message).toContain(
          "writePolicyAnyOf failed",
        );
      } finally {
        await f.dispose();
      }
    });
  }

  it("enforces the stored policy on a write through a plain schema", async () => {
    const f = fixture();
    try {
      expect((await f.write("send", "Send")).error).toBeUndefined();
      expect(
        (await f.write("rogue", "Send", { type: "string" })).error?.message,
      ).toContain("writePolicyAnyOf failed");
    } finally {
      await f.dispose();
    }
  });

  it("does not waive a reviewed action for a pattern setup source", async () => {
    const f = fixture();
    try {
      expect(
        (await f.write("rogue", undefined, schema, "setup")).error?.message,
      ).toContain("writePolicyAnyOf failed");
    } finally {
      await f.dispose();
    }
  });

  it("admits an exact runtime seed and enforces later writes", async () => {
    const f = fixture();
    try {
      expect(
        (await f.write("rogue", undefined, schema, "seed", "initial")).error,
      ).toBeUndefined();
      expect(
        (await f.write("rogue", undefined, schema, "seed", "replacement")).error
          ?.message,
      ).toContain("writePolicyAnyOf failed");
      expect((await f.write("send", "Send")).error).toBeUndefined();
    } finally {
      await f.dispose();
    }
  });

  it("refuses a seed whose final value differs from its initialization evidence", async () => {
    const f = fixture();
    try {
      expect(
        (await f.write(
          "rogue",
          undefined,
          schema,
          "seed",
          "changed",
          "initial",
        )).error?.message,
      ).toContain("writePolicyAnyOf failed");
    } finally {
      await f.dispose();
    }
  });

  it("allows explicitly authenticated authorship without weakening reviewed writers", async () => {
    const f = fixture();
    const authenticated: JSONSchemaObj = {
      type: "string",
      ifc: {
        addIntegrity: [{
          kind: "authored-by",
          subject: { __ctCurrentPrincipal: true },
        }],
        writePolicyAnyOf: [{
          writeAuthorizedBy: policy("send", "Send").writeAuthorizedBy,
          authenticatedAction: true,
        }],
      },
    };
    try {
      expect((await f.write("send", undefined, authenticated)).error)
        .toBeUndefined();
      expect((await f.write("rogue", undefined, authenticated)).error?.message)
        .toContain("writePolicyAnyOf failed");
    } finally {
      await f.dispose();
    }
  });

  it("rejects widening a stored alternative set", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(schema, {
        type: "string",
        ifc: {
          writePolicyAnyOf: [
            ...schema.ifc!.writePolicyAnyOf!,
            policy("rogue", "Send"),
          ],
        },
      })
    ).toThrow("writePolicyAnyOf must remain stable");
  });

  it("rejects changing one writer's action", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(schema, {
        type: "string",
        ifc: {
          writePolicyAnyOf: [policy("send", "Edit"), policy("edit", "Edit")],
        },
      })
    ).toThrow("writePolicyAnyOf must remain stable");
  });
});
