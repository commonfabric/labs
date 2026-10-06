// AnyOf schema support tests: union types, array anyOf, and type coercion.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isCell } from "../src/cell.ts";
import { areLinksSame, parseLink } from "../src/link-utils.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema - AnyOf Support", () => {
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

  describe("AnyOf Support", () => {
    it("should select the correct candidate for primitive types (number)", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "should select the correct candidate for primitive types (number) 1",
        undefined,
        tx,
      );
      c.set({ value: 42 });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBe(42);
    });

    it("should select the correct candidate for primitive types (string)", () => {
      const c = runtime.getCell<{ value: string }>(
        space,
        "should select the correct candidate for primitive types (string) 1",
        undefined,
        tx,
      );
      c.set({ value: "hello" });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBe("hello");
    });

    it("should merge object candidates in anyOf", () => {
      const c = runtime.getCell<{ item: { a: number; b: string } }>(
        space,
        "should merge object candidates in anyOf 1",
        undefined,
        tx,
      );
      c.set({ item: { a: 100, b: "merged" } });
      const schema = {
        type: "object",
        properties: {
          item: {
            anyOf: [
              {
                type: "object",
                properties: { a: { type: "number" } },
                required: ["a"],
                additionalProperties: true,
              },
              {
                type: "object",
                properties: { b: { type: "string" } },
                required: ["b"],
                additionalProperties: true,
              },
            ],
          },
        },
        required: ["item"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect((result.item as { a: number }).a).toBe(100);
      expect((result.item as { b: string }).b).toBe("merged");
    });

    it("should return undefined if no anyOf candidate matches for primitive types", () => {
      const c = runtime.getCell<{ value: boolean }>(
        space,
        "should return undefined if no anyOf candidate matches 1",
        undefined,
        tx,
      );
      c.set({ value: true });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should return undefined when value is an object but no anyOf candidate is an object", () => {
      const c = runtime.getCell<{ value: { a: number } }>(
        space,
        "should return undefined when value is an object 1",
        undefined,
        tx,
      );
      c.set({ value: { a: 1 } });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should handle anyOf in array items", () => {
      const c = runtime.getCell<{ arr: any[] }>(
        space,
        "should handle anyOf in array items 1",
        undefined,
        tx,
      );
      c.set({ arr: [42, space, true] });
      const schema = {
        type: "object",
        properties: {
          arr: {
            type: "array",
            items: {
              anyOf: [{ type: "number" }, { type: "string" }],
            },
          },
        },
        required: ["arr"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      // Undefined, since the boolean item makes the array invalid,
      // which then means the object's arr is invalid.
      expect(cell.get()).toBeUndefined();

      c.set({ arr: [42, space] });
      const result = cell.get();
      expect(result.arr[0]).toBe(42);
      expect(result.arr[1]).toBe(space);
      expect(result.arr[2]).toBeUndefined();
    });

    it("should select the correct candidate when mixing object and array candidates", () => {
      // Case 1: When the value is an object, the object candidate should be used.
      const cObject = runtime.getCell<{ mixed: { foo: string } }>(
        space,
        "should select the correct candidate when mixing 1",
        undefined,
        tx,
      );
      cObject.set({ mixed: { foo: "bar" } });
      const schemaObject = {
        type: "object",
        properties: {
          mixed: {
            anyOf: [
              {
                type: "object",
                properties: { foo: { type: "string" } },
                required: ["foo"],
              },
              // Array candidate; this should be ignored for object inputs.
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        required: ["mixed"],
      } as const satisfies JSONSchema;

      const cellObject = cObject.asSchema(schemaObject);
      const resultObject = cellObject.get();
      // Since the input is an object, the object candidate is selected.
      // TS doesn't infer `foo as string` when mixing objects and arrays, so have to cast.
      expect((resultObject.mixed as { foo: string }).foo).toBe("bar");

      // Case 2: When the value is an array, the array candidate should be used.
      const cArray = runtime.getCell<{ mixed: string[] }>(
        space,
        "should select the correct candidate when mixing 2",
        undefined,
        tx,
      );
      cArray.set({ mixed: ["bar", "baz"] });
      const schemaArray = {
        type: "object",
        properties: {
          mixed: {
            anyOf: [
              // Object candidate; this should be ignored for array inputs.
              { type: "object", properties: { foo: { type: "string" } } },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
      } as const satisfies JSONSchema;

      const cellArray = cArray.asSchema(schemaArray);
      const resultArray = cellArray.get();
      // Verify that the array candidate is chosen and returns the intended array.
      expect(resultArray).toEqualIgnoringSymbols({
        mixed: ["bar", "baz"],
      });
      expect(Array.isArray(resultArray.mixed)).toBe(true);
      expect(resultArray.mixed).toEqualIgnoringSymbols(["bar", "baz"]);
    });

    describe("AnyOf with type: unknown", () => {
      it("object schema before unknown: property value is fully preserved", () => {
        const c = runtime.getCell<{ item: { name: string } }>(
          space,
          "anyOf object-then-unknown preserves property 1",
          undefined,
          tx,
        );
        c.set({ item: { name: "Alice" } });
        const schema = {
          type: "object",
          properties: {
            item: {
              anyOf: [
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
                { type: "unknown" },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asSchema(schema);
        const result = cell.get();
        // Both branches match, so the merge combines them; the object
        // branch is what carries the properties.
        expect((result.item as { name: string }).name).toBe("Alice");
      });

      it("unknown before object schema: property value is fully preserved", () => {
        const c = runtime.getCell<{ item: { name: string } }>(
          space,
          "anyOf unknown-then-object returns undefined 1",
          undefined,
          tx,
        );
        c.set({ item: { name: "Alice" } });
        const schema = {
          type: "object",
          properties: {
            item: {
              anyOf: [
                { type: "unknown" },
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asSchema(schema);
        const result = cell.get();
        // Branch order does not matter to the merge: the object branch is
        // still what carries the properties.
        expect((result.item as { name: string }).name).toBe("Alice");
      });

      it("keeps the identity of the position every branch describes", () => {
        // The merge combines the branches' properties. It must also carry the
        // back-to-cell annotation they share, or the merged value stops
        // naming where it was read from: `equals()` refuses it, and writing it
        // back stores an inline copy where a link belongs.
        const target = runtime.getCell<{ name: string; rank: number }>(
          space,
          "anyOf merge keeps identity target",
          undefined,
          tx,
        );
        target.set({ name: "Alice", rank: 1 });

        const holderSchema = {
          type: "object",
          properties: {
            item: {
              anyOf: [
                { type: "object", properties: { name: { type: "string" } } },
                { type: "unknown" },
              ],
            },
          },
        } as const satisfies JSONSchema;
        const holder = runtime.getCell(
          space,
          "anyOf merge keeps identity holder",
          holderSchema as JSONSchema,
          tx,
        );
        holder.set({ item: target } as never);

        const item = (holder.get() as { item: unknown }).item;
        expect(areLinksSame(item, target, undefined, true, tx, runtime))
          .toBe(true);

        const sink = runtime.getCell(
          space,
          "anyOf merge keeps identity sink",
          holderSchema as JSONSchema,
          tx,
        );
        sink.set({ item } as never);
        const stored = (sink.getRaw() as { item?: unknown })?.item;
        // A link, not an inline copy of the target's properties...
        expect(parseLink(stored, sink.getAsNormalizedFullLink()))
          .not.toBeUndefined();
        // ...and one that resolves to the target. The link addresses the slot
        // it was read from rather than the target directly, which is what an
        // object property has always stored.
        expect(areLinksSame(stored, target, undefined, true, tx, runtime))
          .toBe(true);
      });
    });

    describe("Array anyOf Support", () => {
      it("should handle multiple array type options in anyOf", () => {
        const c = runtime.getCell<{ data: number[] }>(
          space,
          "should handle multiple array type options 1",
          undefined,
          tx,
        );
        c.set({ data: [1, 2, 3] });
        const schema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "number" } },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asSchema(schema);
        const result = cell.get();
        expect(result.data).toEqualIgnoringSymbols([1, 2, 3]);
      });

      it("should handle nested anyOf in array items", () => {
        const c = runtime.getCell<{
          data: Array<{ type: string; value: string | number }>;
        }>(
          space,
          "should handle nested anyOf in array items 1",
          undefined,
          tx,
        );
        c.set({
          data: [
            { type: "text", value: "hello" },
            { type: "number", value: 42 },
          ],
        });
        const schema = {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                type: "object",
                required: ["type", "value"],
                anyOf: [
                  {
                    properties: {
                      type: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                  {
                    properties: {
                      type: { type: "string" },
                      value: { type: "number" },
                    },
                  },
                ],
              },
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asSchema(schema);
        const result = cell.get();
        expect(result.data).toEqualIgnoringSymbols([
          { type: "text", value: "hello" },
          { type: "number", value: 42 },
        ]);
      });

      it("should return empty array when no array options match", () => {
        const c = runtime.getCell<{ data: { key: string } }>(
          space,
          "should return empty array when no array options match 1",
          undefined,
          tx,
        );
        c.set({ data: { key: "value" } });
        const schema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "string" } },
                { type: "array", items: { type: "number" } },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asSchema(schema);
        const result = cell.get();
        expect(result.data).toBeUndefined();
      });

      it("array element set as cell returned as non-cell", () => {
        const numberArrayCell = runtime.getCell<number[]>(
          space,
          "array of numbers",
          undefined,
          tx,
        );
        numberArrayCell.set([1, 2]);

        const arrayOfArrayCell = runtime.getCell<number[][]>(
          space,
          "array of arrays of numbers",
          undefined,
          tx,
        );
        arrayOfArrayCell.set([numberArrayCell, [3, 4]]);

        const arrayOfArraySchema = {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "number",
            },
          },
        } as const satisfies JSONSchema;

        const cell = arrayOfArrayCell.asSchema(arrayOfArraySchema);

        const result = cell.get();
        expect(Array.isArray(result)).toBeTruthy();
        expect(isCell(result)).toBeFalsy();
        const item = result[0];
        expect(Array.isArray(item)).toBeTruthy();
        expect(isCell(item)).toBeFalsy();
        expect(item[0]).toEqual(1);
      });

      it("should work for the vdom schema with $ref", () => {
        const plain = runtime.getCell<{
          type: string;
          name: string;
          props: { style: { color: string } };
          children: any[];
        }>(
          space,
          "should work for the vdom schema with $ref 1",
          undefined,
          tx,
        );
        plain.setRaw({
          type: "vnode",
          name: "div",
          props: { style: { color: "red" } },
          children: [
            { type: "text", value: "single" },
            [
              { type: "text", value: "hello" },
              { type: "text", value: "world" },
            ],
            "or just text",
          ],
        });

        const innerTextCell = runtime.getCell<{ type: string; value: string }>(
          space,
          "should work for the vdom schema with $ref 4",
          undefined,
          tx,
        );
        innerTextCell.setRaw({ type: "text", value: "world" });

        const childrenArrayCell = runtime.getCell<any[]>(
          space,
          "should work for the vdom schema with $ref 5",
          undefined,
          tx,
        );
        childrenArrayCell.setRaw([
          { type: "text", value: "hello" },
          innerTextCell.getAsLink(),
        ]);

        const withLinks = runtime.getCell<{
          type: string;
          name: string;
          props: {
            style: any;
          };
          children: any[];
        }>(
          space,
          "should work for the vdom schema with $ref 3",
          undefined,
          tx,
        );
        withLinks.setRawUntyped({
          type: "vnode",
          name: "div",
          props: {
            style: { color: "red" },
          },
          children: [
            { type: "text", value: "single" },
            childrenArrayCell.getAsLink(),
            "or just text",
          ],
        });

        const vdomSchema = {
          $ref: "#/$defs/VDom",
          $defs: {
            VDom: {
              type: "object",
              properties: {
                type: { type: "string" },
                name: { type: "string" },
                value: { type: "string" },
                props: {
                  type: "object",
                  additionalProperties: { asCell: ["cell"] },
                },
                children: {
                  type: "array",
                  items: {
                    anyOf: [
                      { $ref: "#/$defs/VDom", asCell: ["cell"] },
                      { type: "string", asCell: ["cell"] },
                      { type: "number", asCell: ["cell"] },
                      { type: "boolean", asCell: ["cell"] },
                      {
                        type: "array",
                        items: { $ref: "#/$defs/VDom", asCell: ["cell"] },
                      },
                    ],
                  },
                  asCell: ["cell"],
                },
              },
              required: ["type"],
            },
          },
        } as const satisfies JSONSchema;

        for (const doc of [plain, withLinks]) {
          const cell = doc.asSchema(vdomSchema);
          const result = cell.get();
          expect(result.type).toBe("vnode");
          expect(result.name).toBe("div");
          expect(isCell(result.props)).toBe(false);
          expect(isCell(result.props?.style)).toBe(true);
          expect(result.props!.style.get().color).toBe("red");
          expect(isCell(result.children)).toBe(true);
          const children = result.children!.get();
          expect(children.length).toBe(3);
          expect(isCell(children[0])).toBe(true);
          expect((children[0] as Cell<any>).get().value).toBe("single");
          expect(isCell(children[1])).toBe(false);
          expect(Array.isArray(children[1])).toBe(true);
          const child1 = children[1] as unknown as Cell<any>[];
          expect(isCell(child1[0])).toBe(true);
          expect(child1[0].get().value).toBe("hello");
          expect(
            isCell(child1[1]),
          ).toBe(true);
          expect(child1[1].get().value).toBe("world");
          expect(isCell(children[2])).toBe(true);
          expect((children[2] as Cell<any>).get()).toBe("or just text");
        }
      });
    });
  });
});
