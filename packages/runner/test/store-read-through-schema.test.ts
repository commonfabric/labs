import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { parseExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { Identity } from "@commonfabric/identity";
import type { EntityDocument } from "@commonfabric/memory/v2";

import { decomposeSchema } from "../src/schema-decompose.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { URI } from "../src/storage/interface.ts";

const schema = {
  type: "object",
  properties: { leaf: { $ref: "#/$defs/Leaf" } },
  $defs: {
    Leaf: { type: "object", properties: { text: { type: "string" } } },
  },
} as const;

/** The tagged hash a `cid:` reference names. */
const rootHash = (ref: string): string =>
  parseExternalSchemaRef(ref)!.taggedHash;

describe("store read-through schema metadata", () => {
  for (const contentAddressed of [false, true]) {
    it(`loads and refreshes metadata dependencies for ${contentAddressed ? "content-addressed" : "ordinary"} documents`, async () => {
      const signer = await Identity.fromPassphrase("metadata read through");
      const manager = StorageManager.emulate({ as: signer });
      const decomposed = decomposeSchema(schema);
      const value = { leaf: { text: "present" } };
      const id = (contentAddressed
        ? `cid:${taggedHashStringOf(value)}`
        : "of:metadata-carrier") as URI;
      const carrier = { value, schema: { $ref: decomposed.rootRef } };
      const docs = new Map<string, EntityDocument>([
        [id, carrier],
        ...[...decomposed.documents].map(([hash, document]) =>
          [`cid:${hash}`, { value: document }] as [string, EntityDocument]
        ),
      ]);
      const reads: string[] = [];
      let seq = 1;
      try {
        manager.installStoreReadThrough(signer.did(), ({ id, scopeKey }) => {
          reads.push(id);
          const doc = docs.get(id);
          return {
            branch: "",
            id,
            scope: "space",
            scopeKey,
            ...(doc === undefined
              ? { seq: 0, deleted: true as const }
              : { seq, doc }),
          };
        });
        const replica = manager.open(signer.did()).replica;
        expect(replica.getDocument(id)).toEqual(carrier);
        expect(reads).toHaveLength(1 + decomposed.documents.size);
        for (const [hash, document] of decomposed.documents) {
          expect(replica.getDocument(`cid:${hash}` as URI)?.value)
            .toEqual(document);
        }

        const updated = decomposeSchema({ ...schema, description: "updated" });
        const updatedCarrier = { value, schema: { $ref: updated.rootRef } };
        docs.set(id, updatedCarrier);
        for (const [hash, document] of updated.documents) {
          docs.set(`cid:${hash}`, { value: document });
        }
        seq++;
        reads.length = 0;
        expect(manager.integrateStoreWrites(signer.did(), [{
          id,
          scopeKey: "space",
        }])).toBe(1);
        expect(replica.getDocument(id)).toEqual(updatedCarrier);
        expect(reads).toContain(updated.rootRef);
      } finally {
        await manager.close();
      }
    });
  }

  for (const absence of ["nothing", "deleted"] as const) {
    it(`quarantines a read document whose schema document the store ${absence === "nothing" ? "holds nothing under" : "reports deleted"}, until the store supplies it`, async () => {
      // The read-through cannot supply the referenced document, so the frame
      // cannot carry the closure, and the validator keeps the referrer out
      // rather than apply it against a hole. Once the store holds the
      // closure, the same carrier integrates: the absent document was the
      // one cause.
      const signer = await Identity.fromPassphrase(
        `${absence} dependency read through`,
      );
      const manager = StorageManager.emulate({ as: signer });
      const decomposed = decomposeSchema(schema);
      const id = `of:${absence}-dependency-carrier` as URI;
      const carrier = {
        value: { leaf: { text: "present" } },
        schema: { $ref: decomposed.rootRef },
      };
      const closure = new Map<string, EntityDocument>(
        [...decomposed.documents].map(([hash, document]) =>
          [`cid:${hash}`, { value: document }] as [string, EntityDocument]
        ),
      );
      let supplied = false;
      const reads: string[] = [];
      try {
        manager.installStoreReadThrough(
          signer.did(),
          ({ id: read, scopeKey }) => {
            reads.push(read);
            const address = {
              branch: "",
              id: read,
              scope: "space" as const,
              scopeKey,
            };
            if (read === id) return { ...address, seq: 1, doc: carrier };
            const document = supplied ? closure.get(read) : undefined;
            if (document !== undefined) {
              return { ...address, seq: 1, doc: document };
            }
            return absence === "nothing"
              ? undefined
              : { ...address, seq: 0, deleted: true as const };
          },
        );
        const replica = manager.open(signer.did()).replica;
        expect(replica.getDocument(id)).toBeUndefined();
        expect(reads).toContain(decomposed.rootRef);
        expect(replica.getDocument(decomposed.rootRef as URI)).toBeUndefined();

        // A quarantined document leaves no record behind, so the next read
        // asks the store again, and the store now holds the closure.
        supplied = true;
        expect(replica.getDocument(id)).toEqual(carrier);
        expect(replica.getDocument(decomposed.rootRef as URI)?.value)
          .toEqual(decomposed.documents.get(rootHash(decomposed.rootRef)));
      } finally {
        await manager.close();
      }
    });
  }

  it("quarantines malformed metadata on an initial read", async () => {
    const signer = await Identity.fromPassphrase(
      "malformed metadata read through",
    );
    const manager = StorageManager.emulate({ as: signer });
    const { rootRef } = decomposeSchema(schema);
    try {
      manager.installStoreReadThrough(signer.did(), ({ id, scopeKey }) => ({
        branch: "",
        id,
        scope: "space",
        scopeKey,
        seq: 1,
        doc: { value: "invalid", schema: { $ref: rootRef, type: "object" } },
      }));
      const replica = manager.open(signer.did()).replica;
      expect(replica.getDocument("of:malformed-carrier" as URI))
        .toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it("keeps a malformed refresh from blocking valid sibling documents", async () => {
    const signer = await Identity.fromPassphrase("mixed metadata read through");
    const manager = StorageManager.emulate({ as: signer });
    const invalidId = "of:malformed-carrier" as URI;
    const validId = "of:valid-carrier" as URI;
    const original = { value: "original" };
    const { rootRef } = decomposeSchema(schema);
    const docs = new Map<string, EntityDocument>([
      [invalidId, original],
      [validId, original],
    ]);
    let seq = 1;
    try {
      manager.installStoreReadThrough(signer.did(), ({ id, scopeKey }) => ({
        branch: "",
        id,
        scope: "space",
        scopeKey,
        seq,
        doc: docs.get(id)!,
      }));
      const replica = manager.open(signer.did()).replica;
      expect(replica.getDocument(invalidId)).toEqual(original);
      expect(replica.getDocument(validId)).toEqual(original);
      docs.set(invalidId, {
        value: "invalid",
        schema: { $ref: rootRef, type: "object" },
      });
      const updated = { value: "updated" };
      docs.set(validId, updated);
      seq++;
      expect(manager.integrateStoreWrites(signer.did(), [
        { id: invalidId, scopeKey: "space" },
        { id: validId, scopeKey: "space" },
      ])).toBe(2);
      expect(replica.getDocument(invalidId)).toEqual(original);
      expect(replica.getDocument(validId)).toEqual(updated);
    } finally {
      await manager.close();
    }
  });
});
