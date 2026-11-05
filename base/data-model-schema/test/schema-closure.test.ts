import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import {
  type SchemaClosureMiss,
  type SchemaClosureSource,
  verifySchemaDocument,
  walkSchemaDocumentClosure,
} from "../src/schema-closure.ts";
import { internSchemaAsTaggedHashString } from "../src/schema-intern.ts";

/** A schema document as a store holds it, keyed by the hash its id names. */
const documentOf = (schema: JSONSchema): [string, JSONSchema] => [
  internSchemaAsTaggedHashString(schema),
  schema,
];

/** `root` references `middle`, which references `leaf`. */
const [leafHash, leaf] = documentOf({ type: "string", title: "leaf" });
const [middleHash, middle] = documentOf({
  type: "object",
  properties: { leaf: { $ref: `cid:${leafHash}` } },
});
const [rootHash, root] = documentOf({
  type: "object",
  properties: { middle: { $ref: `cid:${middleHash}` } },
});

/** A loader over an in-memory store of stored values. */
const storeOf = (
  entries: Iterable<[string, unknown]>,
): (hash: string) => SchemaClosureSource | undefined => {
  const store = new Map(entries);
  return (hash) =>
    store.has(hash) ? { kind: "stored", value: store.get(hash) } : undefined;
};

describe("schema-closure", () => {
  describe("verifySchemaDocument()", () => {
    it("returns the interned schema for a value that is the document its hash names", () => {
      // A plain lookalike of the document, not the interned schema itself:
      // what a store hands back, which the verifier has to freeze and intern.
      const verified = verifySchemaDocument(leafHash, structuredClone(leaf));
      expect(verified).toEqual(leaf);
      expect(Object.isFrozen(verified)).toBe(true);
    });

    it("returns `undefined` for a value that hashes to another document", () => {
      expect(verifySchemaDocument(leafHash, middle)).toBeUndefined();
    });

    it("returns `undefined` for a value that is not schema-shaped", () => {
      expect(verifySchemaDocument(leafHash, "export const x = 1;"))
        .toBeUndefined();
      expect(verifySchemaDocument(leafHash, [leaf])).toBeUndefined();
    });
  });

  describe("walkSchemaDocumentClosure()", () => {
    it("verifies the transitive closure behind a root", () => {
      const result = walkSchemaDocumentClosure({
        roots: [rootHash],
        load: storeOf([[rootHash, root], [middleHash, middle], [
          leafHash,
          leaf,
        ]]),
      });
      expect([...result.verified].toSorted()).toEqual(
        [rootHash, middleHash, leafHash].toSorted(),
      );
      expect(result.missing.size).toBe(0);
    });

    it("loads each hash once when two roots share a document", () => {
      const loads: string[] = [];
      const store = storeOf([[middleHash, middle], [leafHash, leaf]]);
      walkSchemaDocumentClosure({
        roots: [middleHash, leafHash],
        load: (hash) => {
          loads.push(hash);
          return store(hash);
        },
      });
      expect(loads.toSorted()).toEqual([leafHash, middleHash].toSorted());
    });

    it("loads and reports a repeated root only once", () => {
      const loads: string[] = [];
      const verified: string[] = [];
      const store = storeOf([[middleHash, middle], [leafHash, leaf]]);
      const result = walkSchemaDocumentClosure({
        roots: [middleHash, middleHash],
        load: (hash) => {
          loads.push(hash);
          return store(hash);
        },
        onVerified: (hash) => verified.push(hash),
      });
      expect(loads).toEqual([middleHash, leafHash]);
      expect(verified).toEqual([middleHash, leafHash]);
      expect([...result.verified]).toEqual([middleHash, leafHash]);
      expect(result.missing.size).toBe(0);
    });

    it("reports a hash the loader holds nothing under as absent, once, and walks on", () => {
      const misses: [string, SchemaClosureMiss][] = [];
      const result = walkSchemaDocumentClosure({
        roots: [rootHash, leafHash],
        load: storeOf([[rootHash, root], [leafHash, leaf]]),
        onMissing: (hash, miss) => misses.push([hash, miss]),
      });
      expect(misses).toEqual([[middleHash, "absent"]]);
      expect([...result.missing]).toEqual([[middleHash, "absent"]]);
      expect([...result.verified].toSorted()).toEqual(
        [rootHash, leafHash].toSorted(),
      );
    });

    it("reports a stored value that is not the document its hash names as a mismatch, and follows nothing from it", () => {
      const misses: [string, SchemaClosureMiss][] = [];
      const result = walkSchemaDocumentClosure({
        roots: [rootHash],
        // A forged `middle` that still references `leaf`: the reference is
        // not followed, so `leaf` is neither verified nor missing.
        load: storeOf([[rootHash, root], [middleHash, {
          type: "object",
          title: "forged",
          properties: { leaf: { $ref: `cid:${leafHash}` } },
        }], [leafHash, leaf]]),
        onMissing: (hash, miss) => misses.push([hash, miss]),
      });
      expect(misses).toEqual([[middleHash, "mismatch"]]);
      expect([...result.verified]).toEqual([rootHash]);
      expect(result.missing.has(leafHash)).toBe(false);
    });

    it("reports a stored value that is not schema-shaped as a mismatch", () => {
      const result = walkSchemaDocumentClosure({
        roots: [leafHash],
        load: storeOf([[leafHash, "export const notASchema = true;"]]),
      });
      expect([...result.missing]).toEqual([[leafHash, "mismatch"]]);
    });

    it("follows a verified source without re-verifying it", () => {
      const result = walkSchemaDocumentClosure({
        roots: [middleHash],
        load: (hash) =>
          hash === middleHash
            // Under the wrong hash on purpose: a verified source is taken
            // at the caller's word.
            ? { kind: "verified", schema: middle }
            : hash === leafHash
            ? { kind: "stored", value: leaf }
            : undefined,
      });
      expect([...result.verified].toSorted()).toEqual(
        [middleHash, leafHash].toSorted(),
      );
    });

    it("neither verifies nor follows a settled source", () => {
      const loads: string[] = [];
      const result = walkSchemaDocumentClosure({
        roots: [middleHash],
        load: (hash) => {
          loads.push(hash);
          return { kind: "settled" };
        },
      });
      expect(loads).toEqual([middleHash]);
      expect(result.verified.size).toBe(0);
      expect(result.missing.size).toBe(0);
    });

    it("calls `onVerified` with the interned schema before following its references", () => {
      const order: string[] = [];
      const store = storeOf([[middleHash, middle], [leafHash, leaf]]);
      walkSchemaDocumentClosure({
        roots: [middleHash],
        load: (hash) => {
          order.push(`load ${hash}`);
          return store(hash);
        },
        onVerified: (hash, schema) => {
          order.push(`verified ${hash}`);
          expect(Object.isFrozen(schema)).toBe(true);
        },
      });
      expect(order).toEqual([
        `load ${middleHash}`,
        `verified ${middleHash}`,
        `load ${leafHash}`,
        `verified ${leafHash}`,
      ]);
    });

    it("walks a hash a callback hands it through `follow`", () => {
      const result = walkSchemaDocumentClosure({
        roots: [leafHash],
        load: (hash, walk) => {
          if (hash === leafHash) walk.follow(middleHash);
          return hash === leafHash
            ? { kind: "stored", value: leaf }
            : hash === middleHash
            ? { kind: "stored", value: middle }
            : undefined;
        },
      });
      expect([...result.verified].toSorted()).toEqual(
        [leafHash, middleHash].toSorted(),
      );
    });

    it("ends the walk with the error a callback throws", () => {
      expect(() =>
        walkSchemaDocumentClosure({
          roots: [rootHash],
          load: storeOf([[rootHash, root]]),
          onMissing: (hash) => {
            throw new Error(`missing ${hash}`);
          },
        })
      ).toThrow(`missing ${middleHash}`);
    });
  });
});
