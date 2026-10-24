import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  ensureExternalSchemaClosure,
  schemaHasIfc,
} from "../src/schema-ifc.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const space = "did:key:zSchemaIfcClosureUnit" as MemorySpace;

// Each test decomposes a schema of its own, keyed by a property name unique
// to the test: the schema-document registry is realm-global, so a hash
// another test already registered would short-circuit the read arm under
// test.
const uniqueExternal = (tag: string) => {
  const decomposed = decomposeSchema(
    {
      type: "object",
      properties: { [tag]: { type: "string" } },
    } as unknown as JSONSchemaObj,
  );
  return {
    ref: { $ref: decomposed.rootRef } as JSONSchema,
    documents: decomposed.documents,
  };
};

const txReading = (
  read: () => unknown,
): IExtendedStorageTransaction => ({
  read,
} as unknown as IExtendedStorageTransaction);

describe("schema-ifc", () => {
  describe("ensureExternalSchemaClosure", () => {
    it("reports a closure with no external refs complete without reading", () => {
      const tx = txReading(() => {
        throw new Error("no read expected");
      });
      expect(
        ensureExternalSchemaClosure(tx, space, {
          type: "object",
          properties: { name: { type: "string" } },
        }),
      ).toBe(true);
    });

    it("reports an unreadable closure document as a broken declaration", () => {
      const { ref } = uniqueExternal("closure-unit-not-found");
      const tx = txReading(() => ({ error: { name: "NotFoundError" } }));

      expect(ensureExternalSchemaClosure(tx, space, ref)).toBe(false);
    });

    it("reports a document that is not a schema document incomplete", () => {
      const { ref } = uniqueExternal("closure-unit-not-a-doc");
      const tx = txReading(() => ({ ok: { value: "not a schema document" } }));

      expect(ensureExternalSchemaClosure(tx, space, ref)).toBe(false);
    });

    it("reports a document whose value is undefined incomplete", () => {
      // The hasher assigns `undefined` a hash, but the registry cannot
      // represent a registered `undefined`; registering it would report
      // the closure complete while the ref stays unresolvable.
      const { ref } = uniqueExternal("closure-unit-undefined-value");
      const tx = txReading(() => ({ ok: { value: { value: undefined } } }));

      expect(ensureExternalSchemaClosure(tx, space, ref)).toBe(false);
    });

    it("registers nothing for a forged document and reports it incomplete", () => {
      const { ref } = uniqueExternal("closure-unit-forged");
      // A document whose content does not hash to its id: the register step
      // throws and the loader neither registers nor recurses into it.
      const tx = txReading(() => ({
        ok: { value: { value: { type: "number" } } },
      }));

      expect(ensureExternalSchemaClosure(tx, space, ref)).toBe(false);
    });

    it("completes over documents the transaction serves", () => {
      const { ref, documents } = uniqueExternal("closure-unit-served");
      const byId = new Map(
        [...documents].map(([hash, doc]) => [`cid:${hash}`, doc]),
      );
      // Stored closure documents read back as `{ value: <document> }`, the
      // shape a path-[] write leaves behind.
      const tx = {
        read: (address: { id: string }) => ({
          ok: { value: { value: byId.get(address.id) } },
        }),
      } as unknown as IExtendedStorageTransaction;

      expect(ensureExternalSchemaClosure(tx, space, ref)).toBe(true);
    });
  });

  describe("schemaHasIfc()", () => {
    // A link's stored schema as each document holding the link carries it:
    // a deep-frozen object of the document's own, here a reference to a
    // registered schema document beside a keyword of the link's own.
    const storedLinkSchemas = (tag: string, labeled: boolean) => {
      const decomposed = decomposeSchema(
        {
          type: "object",
          properties: {
            [tag]: {
              type: "string",
              ...(labeled && { ifc: { confidentiality: ["secret"] } }),
            },
            plain: { type: "object", properties: { name: { type: "string" } } },
          },
        } as unknown as JSONSchemaObj,
      );
      for (const [hash, document] of decomposed.documents) {
        registerSchemaDocument(hash, document);
      }
      return () =>
        deepFreeze({
          $ref: decomposed.rootRef,
          description: `stored link schema ${tag}`,
        }) as JSONSchema;
    };

    it("returns `true` for each of several equal schemas whose reference reaches a label, hashing only each schema's own root", () => {
      const release = acquireSchemaRegistryLease();
      try {
        const stored = storedLinkSchemas("has-ifc-labeled", true);
        expect(schemaHasIfc(stored())).toBe(true);
        const hashedBefore = getContainersHashedForTestingOnly();
        for (let document = 0; document < 10; document++) {
          expect(schemaHasIfc(stored())).toBe(true);
        }
        // Resolving the reference for each schema builds, and hashes, the
        // referenced document merged with the schema's own keywords.
        expect(getContainersHashedForTestingOnly() - hashedBefore).toBe(10);
      } finally {
        release();
      }
    });

    it("returns `false` for each of several equal schemas whose reference reaches no label", () => {
      const release = acquireSchemaRegistryLease();
      try {
        const stored = storedLinkSchemas("has-ifc-unlabeled", false);
        for (let document = 0; document < 3; document++) {
          expect(schemaHasIfc(stored())).toBe(false);
        }
      } finally {
        release();
      }
    });

    it("returns `false` for a schema equal to one it judged labeled, once the registry holding the label's document has cleared", () => {
      const release = acquireSchemaRegistryLease();
      const stored = storedLinkSchemas("has-ifc-cleared", true);
      expect(schemaHasIfc(stored())).toBe(true);
      release();
      expect(schemaHasIfc(stored())).toBe(false);
    });

    it("returns the verdict of a schema that is not deep-frozen without freezing it", () => {
      const labeled = {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      } as JSONSchema;
      expect(schemaHasIfc(labeled)).toBe(true);
      expect(Object.isFrozen(labeled)).toBe(false);
    });
  });
});
