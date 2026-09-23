/**
 * A union whose handle branch names the union itself — the schema the
 * generator emits for `type Recursive = Cell<Recursive> | null` — taken through
 * each walk that evaluates a union branch by branch. Every such walk comes back
 * to the union without having descended into anything: the traversal checks a
 * value held inline against the handle branch's content schema at the same
 * position, and the schema-only walks resolve the branch's reference straight
 * back to the union. The traversal cases hold the recursive union to the same
 * union unrolled one level, which never returns to itself and so reads the way
 * the recursive one has to.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  schemaAcceptsType,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const TYPE = "application/json" as const;

/** What the generator emits for `interface Root { node: Recursive }`. */
const recursiveSchema = {
  type: "object",
  properties: { node: { $ref: "#/$defs/Recursive" } },
  required: ["node"],
  $defs: {
    Recursive: {
      anyOf: [{ type: "null" }, {
        $ref: "#/$defs/Recursive",
        asCell: ["cell"],
      }],
    },
  },
} as const satisfies JSONSchema;

/** The union at `node` in `recursiveSchema`, as a schema of its own. */
const nodeSchema = {
  $ref: "#/$defs/Recursive",
  $defs: recursiveSchema.$defs,
} as const satisfies JSONSchema;

/**
 * `recursiveSchema` unrolled one level: the handle branch's content admits
 * only `null`.
 */
const unrolledSchema = {
  type: "object",
  properties: { node: { $ref: "#/$defs/Recursive" } },
  required: ["node"],
  $defs: {
    Recursive: {
      anyOf: [{ type: "null" }, {
        $ref: "#/$defs/Content",
        asCell: ["cell"],
      }],
    },
    Content: { anyOf: [{ type: "null" }] },
  },
} as const satisfies JSONSchema;

/**
 * A read's result with a cell handle replaced by the path it names and the
 * value stored there. The stored value is read raw, because reading a handle
 * under the recursive union yields another handle at the same path.
 */
function projectRead(value: unknown): unknown {
  if (!isCell(value)) return value;
  return {
    handle: value.getAsNormalizedFullLink().path,
    raw: value.getRaw(),
  };
}

describe("recursive handle union", () => {
  describe("SchemaObjectTraverser", () => {
    describe("read through a cell", () => {
      let storageManager: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;
      let tx: IExtendedStorageTransaction;

      beforeEach(() => {
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        tx = runtime.edit();
      });

      afterEach(async () => {
        await tx.commit();
        await runtime?.dispose();
        await storageManager?.close();
      });

      /** Constructs a root cell under `schema` whose `node` holds `null`. */
      function rootWithNullNode(name: string, schema: JSONSchema) {
        const root = runtime.getCell(space, name, undefined, tx)
          .asSchema(schema);
        root.key("node").set(null);
        return root;
      }

      /**
       * Constructs a root cell under `recursiveSchema` whose `node` names a
       * cell holding `null`, through `hops` cells typed as the union that each
       * name the next.
       */
      function rootWithLinkedNode(name: string, hops: number) {
        let target = runtime.getCell(space, `${name}-0`, nodeSchema, tx);
        target.set(null);
        for (let hop = 1; hop < hops; hop++) {
          const next = runtime.getCell(space, `${name}-${hop}`, nodeSchema, tx);
          next.set(target);
          target = next;
        }
        const root = runtime.getCell(space, name, undefined, tx)
          .asSchema(recursiveSchema);
        root.key("node").set(target);
        return root;
      }

      it("reads an inline `null` at the position as the unrolled union does", () => {
        const recursive = rootWithNullNode("recursive", recursiveSchema);
        const unrolled = rootWithNullNode("unrolled", unrolledSchema);

        const expected = projectRead(unrolled.key("node").get());
        expect(expected).toEqual({ handle: ["node"], raw: null });
        expect(projectRead(recursive.key("node").get())).toEqual(expected);
      });

      it("reads the object holding the position as the unrolled union does", () => {
        const recursive = rootWithNullNode("recursive", recursiveSchema);
        const unrolled = rootWithNullNode("unrolled", unrolledSchema);

        const expected = projectRead(
          (unrolled.get() as { node: unknown }).node,
        );
        expect(expected).toEqual({ handle: ["node"], raw: null });
        expect(projectRead((recursive.get() as { node: unknown }).node))
          .toEqual(expected);
      });

      it("reads the `null` at the end of two handles", () => {
        const root = rootWithLinkedNode("chain", 2);

        expect(root.key("node").resolveAsCell().get()).toBeNull();
      });

      describe("materialized lazily", () => {
        it("reads the `null` a handle names", () => {
          const root = rootWithLinkedNode("link", 1);
          tx.markLazyMaterialize();

          expect(root.key("node").resolveAsCell().get()).toBeNull();
        });

        it("reads the `null` at the end of two handles", () => {
          const root = rootWithLinkedNode("chain", 2);
          tx.markLazyMaterialize();

          expect(root.key("node").resolveAsCell().get()).toBeNull();
        });
      });
    });

    describe("walked by a query", () => {
      /** Runs a query-shaped traversal of `{ node: null }` under `schema`. */
      function queryNullNode(schema: JSONSchema) {
        const id = "of:branch-cycle-query" as URI;
        const value = { node: null } as FabricValue;
        const store = new Map<string, Revision<State>>([[`${id}/${TYPE}`, {
          the: TYPE,
          of: id as Entity,
          is: { value },
          since: 1,
        }]]);
        const tx = new ExtendedStorageTransaction(
          new ManagedStorageTransaction(new StoreObjectManager(store)),
        );
        const traverser = new SchemaObjectTraverser<FabricValue>(
          tx,
          { path: ["value"], schema },
          createDefaultTraversalContext({
            principal: "did:test:alice",
            sessionId: "session-1",
          }),
        );
        return traverser.traverse({
          address: { space: "did:null:null", id, type: TYPE, path: ["value"] },
          value,
        });
      }

      it("selects what the unrolled union selects", () => {
        const expected = queryNullNode(unrolledSchema);
        expect(expected).toEqual({ ok: { node: null } });
        expect(queryNullNode(recursiveSchema)).toEqual(expected);
      });

      it("selects through a handle first reached inside a cycle as through that handle alone", () => {
        // `Handle` matches only through `Union`. The first branch of `node`
        // reaches `Handle` inside `Union`'s own traversal, where `Union` counts
        // as no match and so does `Handle`, and then fails on `string`. The
        // second branch is `Handle` again, which has to be traversed afresh
        // rather than answered with that result.
        const $defs = {
          Union: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Handle" }] },
          Handle: { anyOf: [{ $ref: "#/$defs/Union", asCell: ["cell"] }] },
        } as const;
        const handleAlone = {
          type: "object",
          properties: { node: { $ref: "#/$defs/Handle", asCell: ["cell"] } },
          $defs,
        } as const satisfies JSONSchema;
        const handleAfterCycle = {
          type: "object",
          properties: {
            node: {
              anyOf: [
                {
                  allOf: [{ $ref: "#/$defs/Union", asCell: ["cell"] }, {
                    type: "string",
                  }],
                },
                { $ref: "#/$defs/Handle", asCell: ["cell"] },
              ],
            },
          },
          $defs,
        } as const satisfies JSONSchema;

        const expected = queryNullNode(handleAlone);
        expect(expected).toEqual({ ok: { node: null } });
        expect(queryNullNode(handleAfterCycle)).toEqual(expected);
      });
    });
  });

  describe("schemaAcceptsType()", () => {
    it("returns `true` for `null` and `false` for a string through an `anyOf`", () => {
      expect(schemaAcceptsType(nodeSchema, "null")).toBe(true);
      expect(schemaAcceptsType(nodeSchema, "string")).toBe(false);
    });

    it("returns `true` for `null` and `false` for a string through a `oneOf`", () => {
      const schema = {
        $ref: "#/$defs/Recursive",
        $defs: {
          Recursive: {
            oneOf: [{ type: "null" }, {
              $ref: "#/$defs/Recursive",
              asCell: ["cell"],
            }],
          },
        },
      } as const satisfies JSONSchema;

      expect(schemaAcceptsType(schema, "null")).toBe(true);
      expect(schemaAcceptsType(schema, "string")).toBe(false);
    });

    it("returns `true` for `null` and `false` for a string through an `allOf`", () => {
      const schema = {
        $ref: "#/$defs/Recursive",
        $defs: {
          Recursive: {
            allOf: [{ type: "null" }, { $ref: "#/$defs/Recursive" }],
          },
        },
      } as const satisfies JSONSchema;

      expect(schemaAcceptsType(schema, "null")).toBe(true);
      expect(schemaAcceptsType(schema, "string")).toBe(false);
    });
  });
});
