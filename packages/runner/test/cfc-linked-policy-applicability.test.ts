import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-linked-policy-applicability");
const stamp = { type: "https://commonfabric.org/cfc/atom/LlmDerived" };
const schema = {
  type: "object",
  properties: {
    messages: { type: "array", items: { $ref: "#/$defs/Message" } },
  },
  $defs: {
    Message: {
      anyOf: [
        { $ref: "#/$defs/Sent" },
        { $ref: "#/$defs/Imported" },
      ],
    },
    Sent: {
      type: "object",
      properties: {
        origin: { type: "string", enum: ["sent"] },
        body: { type: "string" },
      },
      required: ["origin", "body"],
      ifc: { writeAuthorizedBy: ["trusted-sender"], addIntegrity: [stamp] },
    },
    Imported: {
      type: "object",
      properties: {
        origin: { type: "string", enum: ["imported"] },
        body: { type: "string" },
      },
      required: ["origin", "body"],
    },
  },
} as const satisfies JSONSchema;

describe("linked policy applicability", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  for (const typed of [false, true]) {
    it(`checks only the matching stored branch through a ${typed ? "typed" : "schema-less"} receiver`, async () => {
      const seed = runtime.edit();
      setCfcImplementationIdentity(seed, {
        kind: "builtin",
        builtinId: "trusted-sender",
      });
      runtime.getCell(signer.did(), "chat", schema, seed).set({
        messages: [{ origin: "sent", body: "genuine" }],
      });
      expect((await seed.commit()).error).toBeUndefined();
      const before = runtime.getCell(signer.did(), "chat", schema)
        .key("messages").key(0).resolveAsCell();
      const firstAddress = before.getAsNormalizedFullLink();
      expect(
        cfcLabelViewForCell(before)?.entries.flatMap((entry) =>
          entry.label.integrity ?? []
        ),
      ).toContainEqual(stamp);

      const append = runtime.edit();
      runtime.getCell(signer.did(), "chat", typed ? schema : undefined, append)
        .key("messages").push({ origin: "imported", body: "claim" });
      expect((await append.commit()).error).toBeUndefined();

      const messages = runtime.getCell(signer.did(), "chat", schema)
        .key("messages");
      expect(messages.key("length").get()).toBe(2);
      const first = messages.key(0).resolveAsCell();
      expect(first.getAsNormalizedFullLink().id).toBe(firstAddress.id);
      expect(first.get()).toEqual({ origin: "sent", body: "genuine" });
      expect(
        cfcLabelViewForCell(first)?.entries.flatMap((entry) =>
          entry.label.integrity ?? []
        ),
      ).toContainEqual(stamp);
      const imported = messages.key(1).resolveAsCell();
      expect(imported.get()).toEqual({ origin: "imported", body: "claim" });
      expect(
        cfcLabelViewForCell(imported)?.entries.flatMap((entry) =>
          entry.label.integrity ?? []
        ) ?? [],
      ).not.toContainEqual(stamp);

      const impostor = runtime.edit();
      runtime.getCell(
        signer.did(),
        "chat",
        typed ? schema : undefined,
        impostor,
      )
        .key("messages").push({ origin: "sent", body: "forged" });
      expect((await impostor.commit()).error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
      expect(messages.key("length").get()).toBe(2);
      expect(first.get()).toEqual({ origin: "sent", body: "genuine" });
    });
  }

  for (const typed of [false, true]) {
    it(`keeps independent writers and local definitions on acquired reference branches${typed ? " with a typed receiver" : ""}`, async () => {
      const scopedSchema = {
        ...schema,
        $defs: {
          ...schema.$defs,
          SentOrigin: schema.$defs.Sent.properties.origin,
          ImportedOrigin: schema.$defs.Imported.properties.origin,
          Sent: {
            ...schema.$defs.Sent,
            properties: {
              ...schema.$defs.Sent.properties,
              origin: { $ref: "#/$defs/SentOrigin" },
            },
          },
          Imported: {
            ...schema.$defs.Imported,
            properties: {
              ...schema.$defs.Imported.properties,
              origin: { $ref: "#/$defs/ImportedOrigin" },
            },
            ifc: { writeAuthorizedBy: ["trusted-importer"] },
          },
        },
      } as const satisfies JSONSchema;
      const seed = runtime.edit();
      setCfcImplementationIdentity(seed, {
        kind: "builtin",
        builtinId: "trusted-sender",
      });
      runtime.getCell(signer.did(), "chat", scopedSchema, seed).set({
        messages: [{ origin: "sent", body: "genuine" }],
      });
      expect((await seed.commit()).error).toBeUndefined();

      const create = runtime.edit();
      const imported = runtime.getCell(
        signer.did(),
        "imported",
        undefined,
        create,
      );
      imported.set({ origin: "imported", body: "claim" });
      const forged = runtime.getCell(signer.did(), "forged", undefined, create);
      forged.set({ origin: "sent", body: "forged" });
      expect((await create.commit()).error).toBeUndefined();

      const append = runtime.edit();
      setCfcImplementationIdentity(append, {
        kind: "builtin",
        builtinId: "trusted-importer",
      });
      runtime.getCell(
        signer.did(),
        "chat",
        typed ? scopedSchema : undefined,
        append,
      ).key("messages")
        .push(imported.withTx(append));
      expect((await append.commit()).error).toBeUndefined();
      const messages = runtime.getCell(signer.did(), "chat", scopedSchema)
        .key("messages");
      expect(messages.key(1).resolveAsCell().getAsNormalizedFullLink().id).toBe(
        imported.getAsNormalizedFullLink().id,
      );

      const impostor = runtime.edit();
      setCfcImplementationIdentity(impostor, {
        kind: "builtin",
        builtinId: "trusted-importer",
      });
      runtime.getCell(
        signer.did(),
        "chat",
        typed ? scopedSchema : undefined,
        impostor,
      ).key("messages")
        .push(forged.withTx(impostor));
      expect((await impostor.commit()).error?.message).toContain(
        "writeAuthorizedBy failed",
      );
      expect(messages.key("length").get()).toBe(2);
      expect(messages.key(0).get()).toEqual({
        origin: "sent",
        body: "genuine",
      });
    });
  }
});
