import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { cfcSchemaEntries } from "../src/cfc/schema-label-view.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

describe("CFC stream payload contracts", () => {
  const schema: JSONSchema = {
    type: "object",
    asCell: ["stream"],
    properties: {
      identity: {
        type: "string",
        ifc: { requiredIntegrity: ["verified-identity"] },
      },
    },
    ifc: { writeAuthorizedBy: ["stream-owner"] },
  };

  it("separates stored stream slot policies from future payload policies", () => {
    for (const asCell of [["stream"], ["cell", "stream"]] as const) {
      const stream = { ...schema, asCell };
      const entries = cfcSchemaEntries({
        type: "object",
        properties: { action: { $ref: "#/$defs/Action" } },
        $defs: { Action: stream },
      });
      expect(entries.map((entry) => entry.path)).toEqual([["action"]]);
      expect(entries[0].schema).toMatchObject({
        ifc: { writeAuthorizedBy: ["stream-owner"] },
      });
    }
    const { asCell: _asCell, ...eventSchema } = schema;
    expect(cfcSchemaEntries(eventSchema).map((entry) => entry.path)).toEqual([
      [],
      ["identity"],
    ]);
    const rootFloor = {
      ...schema,
      ifc: { requiredIntegrity: ["verified-event"] },
    };
    expect(cfcSchemaEntries(rootFloor)[0].schema).toMatchObject({
      ifc: { requiredIntegrity: ["verified-event"] },
    });
    const { asCell: _rootAsCell, ...rootPayload } = rootFloor;
    expect(cfcSchemaEntries(rootPayload)[0].schema).toMatchObject({
      ifc: { requiredIntegrity: ["verified-event"] },
    });
  });

  it("forwards a stream without asserting a future event and protects replacement", async () => {
    const signer = await Identity.fromPassphrase("stream-payload-contract");
    const storageManager = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
    });
    try {
      const setup = runtime.edit();
      const stream = runtime.getCell(signer.did(), "stream", undefined, setup);
      stream.set({ $stream: true });
      const replacement = runtime.getCell(
        signer.did(),
        "other-stream",
        undefined,
        setup,
      );
      replacement.set({ $stream: true });
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit()).error).toBeUndefined();

      const forward = runtime.edit();
      setCfcImplementationIdentity(forward, {
        kind: "builtin",
        builtinId: "stream-owner",
      });
      const slot = runtime.getCell(signer.did(), "stream-slot", {
        type: "object",
        properties: { action: schema },
      }, forward);
      slot.set({ action: stream.withTx(forward) });
      runtime.prepareTxForCommit(forward);
      expect((await forward.commit()).error).toBeUndefined();

      const replace = runtime.edit();
      slot.withTx(replace).set({ action: replacement.withTx(replace) });
      runtime.prepareTxForCommit(replace);
      expect((await replace.commit()).error?.message).toContain(
        "writeAuthorizedBy",
      );
      await runtime.storageManager.synced();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
