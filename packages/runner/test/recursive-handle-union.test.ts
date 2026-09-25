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
        return queryValue({ node: null } as FabricValue, schema);
      }

      /** Runs a query-shaped traversal of `value` under `schema`. */
      function queryValue(value: FabricValue, schema: JSONSchema) {
        return queryTraversal(value, schema).result;
      }

      /**
       * Runs a query-shaped traversal of `value` under `schema`, and reports
       * its result and how many schemas it traversed.
       */
      function queryTraversal(value: FabricValue, schema: JSONSchema) {
        const id = "of:branch-cycle-query" as URI;
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
        const result = traverser.traverse({
          address: { space: "did:null:null", id, type: TYPE, path: ["value"] },
          value,
        });
        return { result, traversals: traverser.traverseWithSchemaCalls };
      }

      it("selects what the unrolled union selects", () => {
        const expected = queryNullNode(unrolledSchema);
        expect(expected).toEqual({ ok: { node: null } });
        expect(queryNullNode(recursiveSchema)).toEqual(expected);
      });

      describe("with a branch that comes back and adds properties", () => {
        // `R` is `A` or `R` together with `B`, and `A` and `B` each select one
        // property of `{ a, b }`. The branch that comes back to `R` matches
        // only once `R` has, and then adds `b`: unrolled once, the union
        // selects both properties, and so must `R`.

        const A = {
          type: "object",
          properties: { a: { type: "number" } },
          additionalProperties: false,
        } as const satisfies JSONSchema;
        const B = {
          type: "object",
          properties: { b: { type: "number" } },
          additionalProperties: false,
        } as const satisfies JSONSchema;
        const value = { a: 1, b: 2 } as FabricValue;

        it("selects what the union unrolled once selects", () => {
          const expected = queryValue(value, {
            anyOf: [A, { allOf: [A, B] }],
          });
          expect(expected).toEqual({ ok: { a: 1, b: 2 } });
          expect(
            queryValue(value, {
              $ref: "#/$defs/R",
              $defs: {
                R: { anyOf: [A, { allOf: [{ $ref: "#/$defs/R" }, B] }] },
              },
            }),
          ).toEqual(expected);
        });

        it("selects what the union unrolled once selects through handles", () => {
          const expected = queryValue(value, {
            anyOf: [A, { allOf: [{ ...A, asCell: ["cell"] }, B] }],
            asCell: ["cell"],
          });
          expect(expected).toEqual({ ok: { a: 1, b: 2 } });
          expect(
            queryValue(value, {
              $ref: "#/$defs/R",
              asCell: ["cell"],
              $defs: {
                R: {
                  anyOf: [A, {
                    allOf: [{ $ref: "#/$defs/R", asCell: ["cell"] }, B],
                  }],
                },
              },
            }),
          ).toEqual(expected);
        });

        it("selects what a branch adds once the traversal it comes back to matches", () => {
          // `R` is `A` or `Y`, and `Y` is `R` together with `B` or `Y`
          // together with `C`. `Y` matches only once `R` has, and its branch
          // that comes back to `Y` only once `Y` has, adding `c`: unrolled
          // until it stops returning to itself, the union selects all three
          // properties, and so must `R`.

          const C = {
            type: "object",
            properties: { c: { type: "number" } },
            additionalProperties: false,
          } as const satisfies JSONSchema;
          const value = { a: 1, b: 2, c: 3 } as FabricValue;

          const expected = queryValue(value, {
            anyOf: [A, {
              anyOf: [
                { allOf: [A, B] },
                { allOf: [{ anyOf: [{ allOf: [A, B] }] }, C] },
              ],
            }],
          });
          expect(expected).toEqual({ ok: { a: 1, b: 2, c: 3 } });
          expect(
            queryValue(value, {
              $ref: "#/$defs/R",
              $defs: {
                R: { anyOf: [A, { $ref: "#/$defs/Y" }] },
                Y: {
                  anyOf: [
                    { allOf: [{ $ref: "#/$defs/R" }, B] },
                    { allOf: [{ $ref: "#/$defs/Y" }, C] },
                  ],
                },
              },
            }),
          ).toEqual(expected);
        });

        it("keeps the first selection of a `oneOf` that the second would reject", () => {
          // `S` is `A` or `S`. Taken as no match, the branch that comes back
          // leaves `A` the one match; taken as that match, it makes two, which
          // a `oneOf` rejects, and taking the rejection makes one again. With
          // no fixed point to reach, the first selection stands.

          expect(
            queryValue({ a: 1 } as FabricValue, {
              $ref: "#/$defs/S",
              $defs: { S: { oneOf: [A, { $ref: "#/$defs/S" }] } },
            }),
          ).toEqual({ ok: { a: 1 } });
        });
      });

      describe("with branches that come back and project a property differently", () => {
        // `A` and `B` each select a different part of `x`, and a merge keeps
        // the later matching branch's projection of `x`. Among branches that
        // come back to one another, the rounds' own merges decide which that
        // is: unrolling the union need not settle it.

        const select = (
          properties: Record<string, JSONSchema>,
        ): JSONSchema => ({
          type: "object",
          properties,
          additionalProperties: false,
        });
        const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
        const A = select({ x: select({ a: { type: "number" } }) });
        const B = select({ x: select({ b: { type: "number" } }) });
        const value = { x: { a: 1, b: 2 } } as FabricValue;

        /**
         * `node` with each reference into `$defs` expanded to its definition,
         * `depth` references deep, and `false` below that.
         */
        function unrolled(
          node: unknown,
          $defs: Record<string, unknown>,
          depth: number,
        ): unknown {
          if (Array.isArray(node)) {
            return node.map((item) => unrolled(item, $defs, depth));
          }
          if (typeof node !== "object" || node === null) return node;
          const { $ref } = node as { $ref?: unknown };
          if (typeof $ref === "string") {
            return depth === 0 ? false : unrolled(
              $defs[$ref.slice("#/$defs/".length)],
              $defs,
              depth - 1,
            );
          }
          return Object.fromEntries(
            Object.entries(node).map((
              [key, item],
            ) => [key, unrolled(item, $defs, depth)]),
          );
        }

        /** The union `R` in `$defs`, unrolled `depth` references deep. */
        function unrolledR(
          $defs: Record<string, unknown>,
          depth: number,
        ): JSONSchema {
          return unrolled(ref("R"), $defs, depth) as JSONSchema;
        }

        it("keeps `B`'s projection where the unrolled union alternates between `A`'s and `B`'s with its depth", () => {
          // `R` is `A` or `S`, and `S` is `B` or `R`: unrolled to an odd
          // depth, `R` keeps `A`'s projection of `x`, and to an even one
          // `B`'s.

          const $defs = {
            R: { anyOf: [A, ref("S")] },
            S: { anyOf: [B, ref("R")] },
          };

          expect(queryValue(value, unrolledR($defs, 3))).toEqual({
            ok: { x: { a: 1 } },
          });
          expect(queryValue(value, unrolledR($defs, 4))).toEqual({
            ok: { x: { b: 2 } },
          });
          expect(queryValue(value, { ...ref("R"), $defs } as JSONSchema))
            .toEqual({ ok: { x: { b: 2 } } });
        });

        it("keeps `B`'s projection where the unrolled union keeps `A`'s at every depth", () => {
          // `R` is `A` or `S`, `S` is `T` or `R`, and `T` is `R` or `B`.
          // Unrolled, `R` keeps `A`'s projection of `x`. The first round takes
          // `R` within `S` as no match, so `S` projects `x` as `T` does,
          // through `B`, and `R` merges `S` last.

          const $defs = {
            R: { anyOf: [A, ref("S")] },
            S: { anyOf: [ref("T"), ref("R")] },
            T: { anyOf: [ref("R"), B] },
          };

          for (const depth of [3, 4, 5, 6]) {
            expect(queryValue(value, unrolledR($defs, depth))).toEqual({
              ok: { x: { a: 1 } },
            });
          }
          expect(queryValue(value, { ...ref("R"), $defs } as JSONSchema))
            .toEqual({ ok: { x: { b: 2 } } });
        });
      });

      describe("with definitions that come back to one another", () => {
        // Each definition is `null` or a handle naming another, so every
        // branch comes back to a traversal in progress at the position and
        // none settles until the first definition does. Running each
        // definition to its own fixed point within every round of the one
        // naming it would multiply the traversals with each definition.

        /** `count` definitions, the `i`th naming those `steps` after it. */
        function definitions(
          count: number,
          steps: readonly number[],
        ): JSONSchema {
          const handle = (i: number) => ({
            $ref: `#/$defs/R${i % count}`,
            asCell: ["cell" as const],
          });
          return {
            ...handle(0),
            $defs: Object.fromEntries(
              Array.from({ length: count }, (_, i) => [`R${i}`, {
                anyOf: [
                  { type: "null" as const },
                  ...steps.map((step) => handle(i + step)),
                ],
              }]),
            ),
          };
        }

        const shapes = [
          ["itself and the next", [0, 1]],
          ["the next two", [1, 2]],
        ] as const;
        for (const [named, steps] of shapes) {
          it(`traverses at most twice the schemas for twice the definitions, each naming ${named}`, () => {
            const few = queryTraversal(null, definitions(8, steps));
            const many = queryTraversal(null, definitions(16, steps));

            expect(few.result).toEqual({ ok: null });
            expect(many.result).toEqual({ ok: null });
            expect(many.traversals).toBeLessThanOrEqual(2 * few.traversals);
          });
        }
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
