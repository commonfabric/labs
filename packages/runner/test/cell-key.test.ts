import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cell key");
const space = signer.did();

/** The schema a keyed cell's own link carries, before any link is resolved. */
function linkSchemaOf(cell: Cell<unknown>): JSONSchema | undefined {
  return cell.getAsNormalizedFullLink().schema;
}

describe("Cell", () => {
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
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A cell under `schema`, holding `value`. */
  function cellHolding(
    cause: string,
    schema: JSONSchema,
    value: FabricValue,
  ): Cell<unknown> {
    const cell = runtime.getCell<unknown>(space, cause, schema, tx);
    cell.setRaw(value);
    return cell;
  }

  describe("instance members", () => {
    describe("key()", () => {
      describe("where the parent schema refuses the position", () => {
        it("keeps `false` for a property the parent declares `false`", () => {
          const cell = cellHolding(
            "declared false property",
            { type: "object", properties: { x: false } },
            { x: 5 },
          );

          expect(linkSchemaOf(cell.key("x"))).toBe(false);
          expect(cell.key("x").get()).toBeUndefined();
        });

        it("keeps `false` for an element under `items: false`", () => {
          const cell = cellHolding(
            "items false",
            { type: "array", items: false },
            [5],
          );

          expect(linkSchemaOf(cell.key(0))).toBe(false);
          expect(cell.key(0).get()).toBeUndefined();
        });

        it("keeps `false` for an undeclared key under `additionalProperties: false`", () => {
          const cell = cellHolding(
            "closed object",
            {
              type: "object",
              properties: { a: { type: "number" } },
              additionalProperties: false,
            },
            { a: 1, b: 2 },
          );

          expect(linkSchemaOf(cell.key("b"))).toBe(false);
          expect(cell.key("b").get()).toBeUndefined();
          expect(cell.key("a").get()).toBe(1);
        });

        it("keeps `false` below a `false` parent", () => {
          const cell = cellHolding(
            "false parent",
            { type: "object" },
            { x: 5 },
          ).asSchema(false);

          expect(linkSchemaOf(cell.key("x"))).toBe(false);
          expect(cell.key("x").get()).toBeUndefined();
        });

        it("keeps `false` below a `{ not: true }` parent", () => {
          const cell = cellHolding(
            "not-true parent",
            { not: true },
            { x: 5 },
          );

          expect(linkSchemaOf(cell.key("x"))).toBe(false);
          expect(cell.key("x").get()).toBeUndefined();
        });

        it("keeps `false` on every key past the first refused one", () => {
          const cell = cellHolding(
            "nested under false",
            { type: "object", properties: { x: false } },
            { x: { y: 5 } },
          );

          expect(linkSchemaOf(cell.key("x", "y"))).toBe(false);
          expect(cell.key("x", "y").get()).toBeUndefined();
        });

        it("keeps `false` for a key under a conjunction declaring no type, which a read of the parent keeps", () => {
          // Narrowing does not read a child out of an `allOf`, so the keyed
          // cell selects nothing, while a read of the parent evaluates the
          // conjunction whole and reaches the property.

          const cell = cellHolding(
            "typeless conjunction",
            {
              allOf: [{
                type: "object",
                properties: { x: { type: "number" } },
              }],
            },
            { x: 5 },
          );

          expect(cell.get()).toEqual({ x: 5 });
          expect(linkSchemaOf(cell.key("x"))).toBe(false);
          expect(cell.key("x").get()).toBeUndefined();
        });

        it("keeps `false` for a path below a scalar", () => {
          const cell = cellHolding(
            "below a scalar",
            { type: "object", properties: { n: { type: "number" } } },
            { n: { inner: 5 } },
          );

          expect(linkSchemaOf(cell.key("n", "inner"))).toBe(false);
          expect(cell.key("n", "inner").get()).toBeUndefined();
        });
      });

      describe("for `length`", () => {
        it("returns no schema, and reads the length, on an array", () => {
          const cell = cellHolding(
            "array length",
            { type: "array", items: { type: "number" } },
            [1, 2, 3],
          );

          expect(linkSchemaOf(cell.key("length"))).toBeUndefined();
          expect(cell.key("length").get()).toBe(3);
        });

        it("returns no schema on a string", () => {
          const cell = cellHolding(
            "string length",
            { type: "object", properties: { s: { type: "string" } } },
            { s: "abcd" },
          );

          expect(linkSchemaOf(cell.key("s", "length"))).toBeUndefined();
        });

        it("returns no schema on a union that admits an array", () => {
          const cell = cellHolding(
            "union length",
            { anyOf: [{ type: "array" }, { type: "null" }] },
            [1, 2],
          );

          expect(linkSchemaOf(cell.key("length"))).toBeUndefined();
          expect(cell.key("length").get()).toBe(2);
        });

        it("returns no schema on a conjunction whose parts admit only an array", () => {
          const cell = cellHolding(
            "conjunction length",
            { allOf: [{ type: "array" }, { minItems: 1 }] },
            [1, 2],
          );

          expect(linkSchemaOf(cell.key("length"))).toBeUndefined();
          expect(cell.key("length").get()).toBe(2);
        });

        it("keeps `false` on a conjunction of an array and a string", () => {
          const cell = cellHolding(
            "unsatisfiable conjunction length",
            { allOf: [{ type: "array" }, { type: "string" }] },
            [1, 2],
          );

          expect(linkSchemaOf(cell.key("length"))).toBe(false);
          expect(cell.key("length").get()).toBeUndefined();
        });

        it("keeps `false` on a closed object that declares no type", () => {
          const cell = cellHolding(
            "typeless closed object length",
            {
              properties: { a: { type: "number" } },
              additionalProperties: false,
            },
            { length: 7 },
          );

          expect(linkSchemaOf(cell.key("length"))).toBe(false);
          expect(cell.key("length").get()).toBeUndefined();
        });

        it("keeps `false` on a union of a string and a closed object", () => {
          const cell = cellHolding(
            "string or closed object length",
            {
              anyOf: [
                { type: "string" },
                { type: "object", additionalProperties: false },
              ],
            },
            { length: 7 },
          );

          expect(linkSchemaOf(cell.key("length"))).toBe(false);
          expect(cell.key("length").get()).toBeUndefined();
        });

        it("keeps `false` on a closed object", () => {
          const cell = cellHolding(
            "closed object length",
            { type: "object", additionalProperties: false },
            { length: 7 },
          );

          expect(linkSchemaOf(cell.key("length"))).toBe(false);
          expect(cell.key("length").get()).toBeUndefined();
        });

        it("keeps `false` on a number", () => {
          const cell = cellHolding(
            "number length",
            { type: "object", properties: { n: { type: "number" } } },
            { n: 5 },
          );

          expect(linkSchemaOf(cell.key("n", "length"))).toBe(false);
        });

        it("keeps `false` below a `false` parent", () => {
          const cell = cellHolding(
            "false parent length",
            { type: "array" },
            [1, 2, 3],
          ).asSchema(false);

          expect(linkSchemaOf(cell.key("length"))).toBe(false);
          expect(cell.key("length").get()).toBeUndefined();
        });
      });

      describe("for a child schema that selects nothing", () => {
        // A stored link at `x` carries a schema of its own. A keyed cell with
        // no schema adopts it when the link is followed, so `false` and
        // `{ not: true }` agree only when `false` survives the narrowing.

        /** A holder whose `x` links to a typed cell, read under `childSchema`. */
        function holderReadingChildrenAs(childSchema: JSONSchema) {
          const target = runtime.getCell<unknown>(
            space,
            `link target under ${JSON.stringify(childSchema)}`,
            { type: "object", properties: { a: { type: "number" } } },
            tx,
          );
          target.set({ a: 1 });
          const holder = runtime.getCell<unknown>(
            space,
            `holder under ${JSON.stringify(childSchema)}`,
            undefined,
            tx,
          );
          holder.setRaw({ x: target.getAsLink({ includeSchema: true }), v: 5 });
          return holder.asSchema({
            type: "object",
            properties: { x: childSchema, v: childSchema },
          });
        }

        // A lazy view reaches the keyed cell's schema through `schema-view.ts`
        // rather than the eager traversal, so the agreement is checked in both.
        for (const lazy of [false, true]) {
          describe(lazy ? "in a lazy view" : "in an eager read", () => {
            beforeEach(() => {
              if (lazy) tx.markLazyMaterialize(true);
            });

            for (const childSchema of [false, { not: true }] as JSONSchema[]) {
              describe(`as ${JSON.stringify(childSchema)}`, () => {
                it("reads nothing through a stored link", () => {
                  const holder = holderReadingChildrenAs(childSchema);

                  expect(holder.key("x").get()).toBeUndefined();
                });

                it("reads nothing at a plain value", () => {
                  const holder = holderReadingChildrenAs(childSchema);

                  expect(holder.key("v").get()).toBeUndefined();
                });
              });
            }
          });
        }
      });
    });
  });
});
