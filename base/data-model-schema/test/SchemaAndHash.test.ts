/**
 * A schema paired with its hash, held so the two cannot drift apart.
 *
 * The pairing is trustworthy only if neither half can change after the hash
 * was computed, so the constructor refuses a schema that is not already
 * deep-frozen, and the instance is itself frozen with non-writable accessors.
 *
 * A schema may legitimately be absent, or be one of the boolean schemas, and
 * absence is where the two readers differ on purpose: one throws and the other
 * returns `undefined`, so a caller states up front which it is prepared for
 * rather than discovering it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { SchemaAndHash } from "@/SchemaAndHash.ts";
import { toDeepFrozenSchema } from "@/schema-copy.ts";

// Two distinct non-empty byte arrays so tests can observe variance.
const HASH_A = new FabricHash(
  new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  "fid1",
);
const HASH_B = new FabricHash(
  new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]),
  "fid1",
);

describe("SchemaAndHash", () => {
  describe("constructor()", () => {
    it("throws if the schema is not deep-frozen", () => {
      expect(() => new SchemaAndHash({ type: "number" }, HASH_A)).toThrow(
        "schema must be deep-frozen",
      );
    });

    it("keeps the deep-frozen schema and hash it was given", () => {
      const schema = toDeepFrozenSchema({ type: "number" });
      const sah = new SchemaAndHash(schema, HASH_A);
      expect(sah.schema).toBe(schema);
      expect(sah.hash).toBe(HASH_A);
    });

    it("throws given a non-deep-frozen schema", () => {
      expect(() => new SchemaAndHash({ type: "number" }, HASH_A)).toThrow(
        /deep-frozen/,
      );
    });

    it("keeps either boolean schema", () => {
      const sahTrue = new SchemaAndHash(true, HASH_A);
      expect(sahTrue.schema).toBe(true);

      const sahFalse = new SchemaAndHash(false, HASH_A);
      expect(sahFalse.schema).toBe(false);
    });

    it("reports `.schemaOrUndefined` as `undefined` when constructed with `undefined`", () => {
      const sah = new SchemaAndHash(undefined, HASH_A);
      expect(sah.schemaOrUndefined).toBe(undefined);
    });

    it("produces a frozen instance", () => {
      const sah = new SchemaAndHash(true, HASH_A);
      expect(Object.isFrozen(sah)).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".schema", () => {
      it("is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(() => {
          (sah as unknown as Record<string, unknown>).schema = false;
        }).toThrow();
      });

      it("is the schema that the instance was constructed with", () => {
        const schema1 = true;
        const schema2 = toDeepFrozenSchema({ type: "number", title: "yes!" });
        const sah1 = new SchemaAndHash(schema1, HASH_A);
        const sah2 = new SchemaAndHash(schema2, HASH_A);
        expect(sah1.schema).toBe(schema1);
        expect(sah2.schema).toBe(schema2);
      });

      it("throws when `schema === undefined`", () => {
        const sah = new SchemaAndHash(undefined, HASH_A);
        expect(() => sah.schema).toThrow(/undefined/);
      });
    });

    describe(".schemaOrUndefined", () => {
      it("is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(() => {
          (sah as unknown as Record<string, unknown>).schemaOrUndefined = false;
        }).toThrow();
      });

      it("is the schema that the instance was constructed with", () => {
        const schema1 = false;
        const schema2 = toDeepFrozenSchema({ type: "string", title: "yes!" });
        const sah1 = new SchemaAndHash(schema1, HASH_A);
        const sah2 = new SchemaAndHash(schema2, HASH_A);
        expect(sah1.schemaOrUndefined).toBe(schema1);
        expect(sah2.schemaOrUndefined).toBe(schema2);
      });

      it("returns `undefined` when `schema === undefined`", () => {
        const sah = new SchemaAndHash(undefined, HASH_A);
        expect(sah.schemaOrUndefined).toBe(undefined);
      });
    });

    describe(".hash", () => {
      it("is not writable", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(() => {
          (sah as unknown as Record<string, unknown>).hash = "tampered";
        }).toThrow();
      });

      it("is the hash that the instance was constructed with", () => {
        const sah1 = new SchemaAndHash(true, HASH_A);
        const sah2 = new SchemaAndHash(false, HASH_B);
        expect(sah1.hash).toBe(HASH_A);
        expect(sah2.hash).toBe(HASH_B);
      });
    });

    describe(".taggedHashString", () => {
      it("returns a string", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(typeof sah.taggedHashString).toBe("string");
      });

      it("matches `hash.taggedHashString`", () => {
        const sah = new SchemaAndHash(true, HASH_A);
        expect(sah.taggedHashString).toBe(sah.hash.taggedHashString);
      });

      it("produces different results for different hashes", () => {
        const sahA = new SchemaAndHash(true, HASH_A);
        const sahB = new SchemaAndHash(true, HASH_B);
        expect(sahA.taggedHashString).not.toBe(sahB.taggedHashString);
      });
    });
  });
});
