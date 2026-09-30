import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { ensureExternalSchemaClosure } from "../src/schema-ifc.ts";
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

    it("keeps protected closure failures out of observer-visible logs", () => {
      const { ref } = uniqueExternal("closure-unit-silent");
      const tx = txReading(() => ({ error: { name: "NotFoundError" } }));
      const warn = stub(console, "warn", () => {});
      try {
        expect(
          ensureExternalSchemaClosure(tx, space, ref, { silentFailures: true }),
        ).toBe(false);
        expect(warn.calls).toHaveLength(0);
        expect(ensureExternalSchemaClosure(tx, space, ref)).toBe(false);
        expect(warn.calls).toHaveLength(1);
      } finally {
        warn.restore();
      }
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
});
