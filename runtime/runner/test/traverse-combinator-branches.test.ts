/**
 * How `SchemaObjectTraverser` treats the individual branches of `anyOf`,
 * `oneOf` and `allOf`: a `false` branch, a branch that merges to a boolean,
 * and a branch whose external `$ref` names a boolean schema document. An
 * interned `anyOf` takes a precomputed path and any other schema takes an
 * inline one, so the `anyOf` cases are stated for both.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  canBranchMatch,
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const SPACE = "did:null:null" as MemorySpace;

/** Traverses `value`, stored at the root of a document, against `schema`. */
function traverse(value: FabricValue, schema: JSONSchema) {
  const traverser = new SchemaObjectTraverser(
    new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(new Map())),
    ),
    { path: ["value"], schema },
    createDefaultTraversalContext({
      principal: "did:test:alice",
      sessionId: "session-1",
    }),
  );
  return traverser.traverseWithSchema({
    address: {
      space: SPACE,
      id: "of:combinator-doc" as URI,
      type: "application/json",
      path: ["value"],
    },
    value,
  }, schema);
}

describe("traverse-combinator-branches", () => {
  let releaseLease: () => void;
  let falseRef: JSONSchema;
  let trueRef: JSONSchema;

  beforeEach(() => {
    // The lease scopes the two registrations to the case: releasing the last
    // lease clears the registry.
    releaseLease = acquireSchemaRegistryLease();
    const refTo = (schema: boolean): JSONSchema => {
      const { taggedHashString } = internSchema(schema, true);
      registerSchemaDocument(taggedHashString, schema);
      return { $ref: `cid:${taggedHashString}` };
    };
    falseRef = refTo(false);
    trueRef = refTo(true);
  });

  afterEach(() => releaseLease());

  describe("anyOf", () => {
    for (
      const [form, prepare] of [
        ["a fresh schema", (schema: JSONSchema) => schema],
        ["an interned schema", (schema: JSONSchema) => internSchema(schema)],
      ] as const
    ) {
      describe(form, () => {
        it("skips a `false` branch and matches by the others", () => {
          const schema = () => prepare({ anyOf: [false, { type: "number" }] });
          expect(traverse(5, schema())).toEqual({ ok: 5 });
          expect(traverse("x", schema()).error).toBeDefined();
        });

        it("matches any value through a `true` branch", () => {
          expect(traverse("x", prepare({ anyOf: [{ type: "number" }, true] })))
            .toEqual({ ok: "x" });
          expect(traverse("x", prepare({ anyOf: [{ type: "number" }] })).error)
            .toBeDefined();
        });

        it("matches nothing through a branch whose external `$ref` names `false`", () => {
          const schema = () =>
            prepare({ anyOf: [falseRef, { type: "string" }] });
          expect(traverse(5, schema()).error).toBeDefined();
          expect(traverse("x", schema())).toEqual({ ok: "x" });
        });

        it("matches any value through a branch whose external `$ref` names `true`", () => {
          expect(traverse(5, prepare({ anyOf: [trueRef, { type: "string" }] })))
            .toEqual({ ok: 5 });
        });
      });
    }
  });

  describe("oneOf", () => {
    it("skips a `false` branch and matches by the others", () => {
      const schema = (): JSONSchema => ({ oneOf: [false, { type: "number" }] });
      expect(traverse(5, schema())).toEqual({ ok: 5 });
      expect(traverse("x", schema()).error).toBeDefined();
    });
  });

  describe("allOf", () => {
    it("fails on a `false` branch whatever the other branches accept", () => {
      expect(traverse(5, { allOf: [{ type: "number" }, false] }).error)
        .toBeDefined();
      expect(traverse(5, { allOf: [{ type: "number" }] })).toEqual({ ok: 5 });
    });
  });

  describe("canBranchMatch()", () => {
    it("returns the boolean an external `$ref` names", () => {
      expect(canBranchMatch(falseRef, 1)).toBe(false);
      expect(canBranchMatch(trueRef, 1)).toBe(true);
    });
  });
});
