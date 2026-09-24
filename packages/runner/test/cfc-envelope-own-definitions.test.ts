import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-envelope-own-definitions",
);
const space = signer.did();

// The shape a confidential envelope merge leaves: a public reference whose
// definition lives in ANOTHER document root is kept bound to that root's
// definition map as `cid:<root>#/$defs/<name>`, and the registered root is an
// ordinary schema that carries a body beside its `$defs`. The merged envelope
// itself keeps its own `$defs` and is stored inline.
const FOREIGN_ROOT = {
  type: "object",
  properties: { stances: { type: "array", items: { $ref: "#/$defs/Stance" } } },
  $defs: {
    Stance: {
      type: "object",
      properties: { rating: { $ref: "#/$defs/Rating" } },
    },
    Rating: { enum: ["great", "ok", "no"] },
  },
} as const satisfies JSONSchema;
const FOREIGN_HASH = internSchemaAsTaggedHashString(FOREIGN_ROOT);

const ENVELOPE = {
  type: "object",
  properties: {
    secret: { $ref: "#/$defs/Classified" },
    stance: { $ref: `cid:${FOREIGN_HASH}#/$defs/Stance` },
  },
  required: ["secret"],
  $defs: {
    Classified: {
      type: "string",
      ifc: { confidentiality: ["own-definitions-secret"] },
    },
  },
} as const satisfies JSONSchema;

describe("an inline envelope that carries its own definitions and a reference", () => {
  it("is read back as stored, so a later write to the document commits", async () => {
    registerSchemaDocument(FOREIGN_HASH, FOREIGN_ROOT);
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const first = runtime.edit();
      const cell = runtime.getCell(space, "own-definitions", ENVELOPE, first);
      cell.set({ secret: "one", stance: { rating: "ok" } });
      first.prepareCfc();
      expect((await first.commit()).error).toBeUndefined();
      await storageManager.synced();

      const read = runtime.edit();
      const loaded = loadStoredCfcEnvelope(read, {
        space,
        id: cell.getAsNormalizedFullLink().id,
      });
      read.abort();
      expect(loaded.status === "unreadable" ? loaded.reason : undefined)
        .toBeUndefined();
      expect(loaded.status).toBe("loaded");
      // As stored: its own definitions stay in its own map, and the reference
      // into the other root keeps naming that root.
      const schema = loaded.status === "loaded" ? loaded.schema : undefined;
      expect(schema).toMatchObject({
        properties: {
          secret: { $ref: "#/$defs/Classified" },
          stance: { $ref: `cid:${FOREIGN_HASH}#/$defs/Stance` },
        },
        $defs: { Classified: ENVELOPE.$defs.Classified },
      });

      const second = runtime.edit();
      runtime.getCell(space, "own-definitions", ENVELOPE, second)
        .set({ secret: "two", stance: { rating: "great" } });
      second.prepareCfc();
      expect((await second.commit()).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
