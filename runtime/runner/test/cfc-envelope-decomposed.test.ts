import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import {
  decomposeEnvelopeRoot,
  decomposeToSameRoot,
} from "../src/cfc/prepare.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-envelope-decomposed");
const space = signer.did();

// A declared schema whose `$defs` member gives the decomposition something
// to split: version-2 envelopes store the root and the definition as
// separate content-addressed documents. The inline `note` member declares
// the same confidentiality, so rewriting the whole record puts the atoms it
// read back onto a path that accepts them.
const DECLARED_SCHEMA = {
  type: "object",
  properties: {
    secret: { $ref: "#/$defs/Classified" },
    note: {
      type: "string",
      ifc: { confidentiality: ["decomposed-secret"] },
    },
  },
  required: ["secret"],
  $defs: {
    Classified: {
      type: "string",
      ifc: { confidentiality: ["decomposed-secret"] },
    },
  },
} as const satisfies JSONSchema;

const makeRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    // The stored-form assertions below read the decomposed spelling: the
    // root and its `$defs` member as separate content-addressed documents.
    cfcDecomposedEnvelopes: true,
  });

/**
 * One declared-schema write to `name`; resolves with the staged `cid:`
 * document ids and the stored metadata the commit left behind.
 */
const declaredWrite = async (
  runtime: Runtime,
  name: string,
): Promise<{ cidWrites: string[]; stored: CfcMetadata | undefined }> => {
  const tx = runtime.edit();
  const cell = runtime.getCell(space, name, DECLARED_SCHEMA, tx);
  cell.set({ secret: "classified", note: "detail" });
  tx.prepareCfc();
  const cidWrites = [...tx.getWriteDetails?.(space) ?? []]
    .map((detail) => detail.address.id)
    .filter((id) => id.startsWith("cid:"));
  expect((await tx.commit().settled).ok).toBeDefined();
  const targetId = cell.getAsNormalizedFullLink().id;
  const stored = (runtime.storageManager.open(space).replica as unknown as {
    getDocument(id: string): { cfc?: CfcMetadata } | undefined;
  }).getDocument(targetId);
  return { cidWrites, stored: stored?.cfc };
};

describe("CFC decomposed envelopes", () => {
  it("persists an envelope whose root and definition are separate documents", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const { cidWrites, stored } = await declaredWrite(
        runtime,
        "decomposed-target",
      );
      expect(stored?.version).toBe(1);
      expect(stored?.labelMap.entries.length).toBeGreaterThan(0);
      // The root rides the transaction, and so does the `$defs` member the
      // decomposition split out — at least two distinct documents.
      expect(cidWrites).toContain(`cid:${stored!.schemaHash}`);
      expect(new Set(cidWrites).size).toBeGreaterThanOrEqual(2);

      // The stored ROOT is the decomposed spelling: its definition arrives
      // by reference, not inline.
      const rootDoc = (runtime.storageManager.open(space)
        .replica as unknown as {
          getDocument(id: string): { value?: unknown } | undefined;
        }).getDocument(`cid:${stored!.schemaHash}`);
      expect(JSON.stringify(rootDoc?.value)).toContain('"cid:');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-derives the same decomposed envelope from the recomposed stored form (SC-11 skip)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const first = await declaredWrite(runtime, "decomposed-idempotent");
      expect(first.stored?.version).toBe(1);
      await storageManager.synced();

      // The same declared write again: the stored envelope loads through
      // recomposition, the merge covers the candidate, and the re-derived
      // metadata is canonically identical — nothing rewrites.
      const tx = runtime.edit();
      const cell = runtime.getCell(
        space,
        "decomposed-idempotent",
        DECLARED_SCHEMA,
        tx,
      );
      cell.set({ secret: "classified", note: "updated" });
      tx.prepareCfc();
      const cidWrites = [...tx.getWriteDetails?.(space) ?? []]
        .map((detail) => detail.address.id)
        .filter((id) => id.startsWith("cid:"));
      expect((await tx.commit().settled).ok).toBeDefined();
      expect(cidWrites).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("elides the confirmed closure on a second document sharing the schema", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const first = await declaredWrite(runtime, "decomposed-elide-a");
      expect(first.cidWrites.length).toBeGreaterThanOrEqual(2);
      await storageManager.synced();

      const second = await declaredWrite(runtime, "decomposed-elide-b");
      expect(second.stored?.schemaHash).toBe(first.stored?.schemaHash);
      expect(second.cidWrites).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("falls back to the inline form on every undecomposable spelling", () => {
    // Boolean and non-object schemas cannot decompose.
    expect(decomposeEnvelopeRoot(true as unknown as JSONSchema))
      .toBeUndefined();
    // The deprecated `definitions` keyword refuses decomposition.
    expect(decomposeEnvelopeRoot({
      type: "object",
      definitions: { Legacy: { type: "string" } },
    } as JSONSchema)).toBeUndefined();
    // A root that reduces to a cyclic `$defs` member decomposes to a
    // FRAGMENT reference, which a bare document hash cannot carry.
    expect(decomposeEnvelopeRoot({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    } as JSONSchema)).toBeUndefined();
  });

  it("treats undecomposable spellings as unequal roots and fails loudly otherwise", () => {
    expect(decomposeToSameRoot(true as unknown as JSONSchema, {}))
      .toBe(false);
    expect(decomposeToSameRoot(
      {
        type: "object",
        definitions: { Legacy: { type: "string" } },
      } as JSONSchema,
      { type: "object" } as JSONSchema,
    )).toBe(false);
    // A non-decomposition error is not a refusal: it propagates.
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile schema");
      },
    }) as JSONSchema;
    expect(() => decomposeToSameRoot(hostile, {})).toThrow("hostile schema");
    expect(() => decomposeEnvelopeRoot(hostile)).toThrow("hostile schema");
  });

  it("delegates the flag through the transaction wrapper", () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const tx = runtime.edit();
      const wrapper = new TransactionWrapper(
        tx as unknown as ConstructorParameters<typeof TransactionWrapper>[0],
        {},
      );
      wrapper.setCfcDecomposedEnvelopes(false);
      expect(tx.getCfcState().decomposedEnvelopes).toBe(false);
      wrapper.setCfcDecomposedEnvelopes(true);
      expect(tx.getCfcState().decomposedEnvelopes).toBe(true);
      tx.abort();
    } finally {
      runtime.dispose();
      storageManager.close();
    }
  });

  it("keeps the version-1 inline form with the flag off", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "inline-target", DECLARED_SCHEMA, tx);
      cell.set({ secret: "classified", note: "detail" });
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      const targetId = cell.getAsNormalizedFullLink().id;
      const stored = (runtime.storageManager.open(space).replica as unknown as {
        getDocument(id: string): { cfc?: CfcMetadata } | undefined;
      }).getDocument(targetId);
      expect(stored?.cfc?.version).toBe(1);
      const envDoc = (runtime.storageManager.open(space).replica as unknown as {
        getDocument(id: string): { value?: unknown } | undefined;
      }).getDocument(`cid:${stored!.cfc!.schemaHash}`);
      expect(JSON.stringify(envDoc?.value)).not.toContain('"cid:');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
