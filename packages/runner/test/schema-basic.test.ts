// Basic schema type tests: primitive types, references, schema references,
// and key navigation.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isCell } from "../src/cell.ts";
import { type JSONSchema, type JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

Deno.test("getSchemaScopeCap precedence: asCell entry before top-level scope", () => {
  // The read follow-cap (link-resolution/traverse) and the write target scope
  // (data-updating) both derive from ContextualFlowControl.getSchemaScopeCap,
  // so they can never disagree about which scoped instance a slot addresses.
  // This pins the single precedence: outermost asCell entry scope first (the
  // immediate cell/slot), then the top-level `scope` (the value when there is
  // no wrapper).

  const cap = (schema: JSONSchema) =>
    ContextualFlowControl.getSchemaScopeCap(schema);
  assertSchemaScope(
    cap({ type: "string", asCell: [{ kind: "cell", scope: "session" }] }),
    "session",
  );
  assertSchemaScope(cap({ type: "string", scope: "user" }), "user");
  // When both are present, the immediate (asCell) cell scope wins.
  assertSchemaScope(
    cap({
      type: "object",
      scope: "user",
      asCell: [{ kind: "cell", scope: "session" }],
    }),
    "session",
  );
  assertSchemaScope(cap({ type: "string" }), undefined);
  assertSchemaScope(cap({ type: "string", scope: "any" }), "any");
});

function assertSchemaScope(actual: unknown, expected: unknown) {
  expect(actual).toBe(expected);
}

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema - Basic Types and References", () => {
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

  describe("Basic Types", () => {
    it("should handle primitive types", () => {
      const c = runtime.getCell<{
        str: string;
        num: number;
        bool: boolean;
      }>(
        space,
        "should handle primitive types 1",
        undefined,
        tx,
      );
      c.set({
        str: "hello",
        num: 42,
        bool: true,
      });

      const schema = {
        type: "object",
        properties: {
          str: { type: "string" },
          num: { type: "number" },
          bool: { type: "boolean" },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.str).toBe("hello");
      expect(value.num).toBe(42);
      expect(value.bool).toBe(true);
    });

    it("should handle nested objects", () => {
      const c = runtime.getCell<{
        user: {
          name: string;
          settings: {
            theme: string;
          };
        };
      }>(
        space,
        "should handle nested objects 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          name: "John",
          settings: {
            theme: "dark",
          },
        },
      });

      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                asCell: ["cell"],
              },
            },
            required: ["name", "settings"],
          },
        },
        required: ["user"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);
    });

    it("should handle arrays", () => {
      const c = runtime.getCell<{
        items: number[];
      }>(
        space,
        "should handle arrays 1",
        undefined,
        tx,
      );
      c.set({
        items: [1, 2, 3],
      });

      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.items).toEqualIgnoringSymbols([1, 2, 3]);
    });
  });

  describe("References", () => {
    it("should return a Cell for reference properties", () => {
      const c = runtime.getCell<{
        id: number;
        metadata: {
          createdAt: string;
          type: string;
        };
      }>(
        space,
        "should return a Cell for reference properties 1",
        undefined,
        tx,
      );
      c.set({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      });

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          metadata: {
            type: "object",
            asCell: ["cell"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.id).toBe(1);
      expect(isCell(value.metadata)).toBe(true);

      // The metadata cell should behave like a normal cell
      const metadataValue = value.metadata?.get();
      expect(metadataValue?.createdAt).toBe("2025-01-06");
      expect(metadataValue?.type).toBe("user");
    });

    it("Should support a reference at the root", () => {
      const c = runtime.getCell<{
        id: number;
        nested: { id: number };
      }>(
        space,
        "Should support a reference at the root 1",
        undefined,
        tx,
      );
      c.set({
        id: 1,
        nested: { id: 2 },
      });

      const schema = {
        asCell: ["cell"],
        $ref: "#/$defs/Node",
        $defs: {
          "Node": {
            type: "object",
            properties: {
              id: { type: "number" },
              nested: { $ref: "#/$defs/Node", asCell: ["cell"] },
            },
            required: ["id"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().id).toBe(1);
      expect(isCell(value.get().nested)).toBe(true);
      expect(value.get().nested!.get().id).toBe(2);
    });
  });

  describe("Schema References", () => {
    it("should handle self-references with $ref: '#/$defs/Node'", () => {
      const c = runtime.getCell<{
        name: string;
        children: Array<{ name: string; children: any[] }>;
      }>(
        space,
        "should handle self-references with $ref 1",
        undefined,
        tx,
      );
      c.set({
        name: "root",
        children: [
          { name: "child1", children: [] },
          { name: "child2", children: [] },
        ],
      });

      const schema = {
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: {
                type: "array",
                items: { $ref: "#/$defs/Node" },
              },
            },
            required: ["name", "children"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
    });

    it("should handle circular references in objects", () => {
      const c = runtime.getCell<{
        name: string;
        parent: any;
        children: Array<{ name: string; parent: any; children: any[] }>;
      }>(
        space,
        "should handle circular references in objects 1",
        undefined,
        tx,
      );
      c.set({
        name: "root",
        parent: null,
        children: [
          { name: "child1", parent: null, children: [] },
          { name: "child2", parent: null, children: [] },
        ],
      });

      // Set up circular references using cell links
      c.key("parent").setRaw(c.getAsLink());
      c.key("children").key(0).key("parent").resolveAsCell().setRaw(
        c.getAsLink(),
      );
      c.key("children").key(1).key("parent").resolveAsCell().setRaw(
        c.getAsLink(),
      );

      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          Root: {
            type: "object",
            properties: {
              name: { type: "string" },
              parent: { $ref: "#/$defs/Root" },
              children: {
                type: "array",
                items: { $ref: "#/$defs/Root" },
              },
            },
            required: ["name", "parent", "children"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get() as {
        name: string;
        parent: any;
        children: Array<{ name: string; parent: any; children: any[] }>;
      };

      // Verify the structure is maintained
      expect(value.name).toBe("root");
      expect(value.parent.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[0].parent.name).toBe("root");
      expect(value.children[1].name).toBe("child2");
      expect(value.children[1].parent.name).toBe("root");
    });

    it("should handle nested circular references", () => {
      const c = runtime.getCell<{
        name: string;
        nested: {
          name: string;
          items: Array<{ name: string; value: any }>;
        };
      }>(
        space,
        "should handle nested circular references 1",
        undefined,
        tx,
      );
      c.set({
        name: "root",
        nested: {
          name: "nested",
          items: [
            { name: "item1", value: null },
            { name: "item2", value: null },
          ],
        },
      });

      // Set up circular references using cell links
      c.key("nested").key("items").key(0).key("value").resolveAsCell().setRaw(
        c.getAsLink(),
      );
      c.key("nested").key("items").key(1).key("value").resolveAsCell().setRaw(
        c.key("nested").getAsLink(),
      );

      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          "Root": {
            type: "object",
            properties: {
              name: { type: "string" },
              nested: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        value: { $ref: "#/$defs/Root" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get() as {
        name: string;
        nested: {
          name: string;
          items: Array<{ name: string; value: any }>;
        };
      };

      // Verify the structure is maintained
      expect(value.name).toBe("root");
      expect(value.nested.name).toBe("nested");
      expect(value.nested.items[0].name).toBe("item1");
      expect(value.nested.items[0].value.name).toBe("root");
      expect(value.nested.items[1].name).toBe("item2");
      expect(value.nested.items[1].value.name).toBe("nested");
    });

    it("should handle circular references with anyOf", () => {
      const c = runtime.getCell<{
        type: string;
        name: string;
        children: Array<{
          type: string;
          name: string;
          children?: any[];
          value?: any;
        }>;
      }>(
        space,
        "should handle circular references with anyOf 1",
        undefined,
        tx,
      );
      c.set({
        type: "node",
        name: "root",
        children: [
          { type: "node", name: "child1", children: [] },
          { type: "leaf", name: "child2", value: null },
        ],
      });

      // Set up circular references using cell links
      c.key("children").key(1).key("value").resolveAsCell().setRaw(
        c.getAsLink(),
      );

      // TODO(@ubik2) -- Temporarily disambiguating the anyOf clause, with
      // "required" property since I'm not yet merging properties when we
      // match multiples.
      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          "Root": {
            type: "object",
            properties: {
              type: { type: "string" },
              name: { type: "string" },
              children: {
                type: "array",
                items: {
                  anyOf: [
                    { $ref: "#/$defs/Root" },
                    {
                      type: "object",
                      properties: {
                        type: { type: "string" },
                        name: { type: "string" },
                        value: { $ref: "#/$defs/Root" },
                      },
                      required: ["value"],
                    },
                  ],
                },
              },
            },
            required: ["children"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get() as {
        type: string;
        name: string;
        children: Array<{
          type: string;
          name: string;
          children?: any[];
          value?: any;
        }>;
      };

      // Verify the structure is maintained
      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
      expect(value.children[1].value.name).toBe("root");
    });

    it("Should support named $ref links", () => {
      const schema = {
        "$defs": {
          "LinkedNode": {
            type: "object",
            properties: {
              value: { type: "number" },
              next: { $ref: "#/$defs/LinkedNode" },
            },
            required: ["value"],
          },
        },
        $ref: "#/$defs/LinkedNode",
        asCell: ["cell"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell(
        space,
        "Should support $defs references",
        schema,
        tx,
      );
      const cell = c.asSchema(schema);
      cell.set({ value: 1, next: { value: 2, next: { value: 3 } } });

      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().value).toBe(1);
      expect(value.get().next!.value).toBe(2);
      expect(value.get().next!.next!.value).toBe(3);
    });
  });

  describe("Key Navigation", () => {
    it("should preserve schema when using key()", () => {
      const c = runtime.getCell<{
        user: {
          profile: {
            name: string;
            metadata: { id: number };
          };
        };
      }>(
        space,
        "should preserve schema when using key 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          profile: {
            name: "John",
            metadata: { id: 123 },
          },
        },
      });

      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  metadata: {
                    type: "object",
                    asCell: ["cell"],
                  },
                },
                required: ["name", "metadata"],
              },
            },
            required: ["profile"],
          },
        },
        required: ["user"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const userCell = cell.key("user");
      const profileCell = userCell.key("profile");
      const value = profileCell.get();

      // Runtime checks
      expect(value.name).toBe("John");
      expect(isCell(value.metadata)).toBe(true);

      // TypeScript type checks - these will fail to compile if types are 'any'
      type IsAny<T> = 0 extends (1 & T) ? true : false;

      // Check that userCell is NOT any
      type UserCellIsAny = IsAny<typeof userCell>;
      const _assertUserCellNotAny: UserCellIsAny extends false ? true : never =
        true;

      // Check that profileCell is NOT any
      type ProfileCellIsAny = IsAny<typeof profileCell>;
      const _assertProfileCellNotAny: ProfileCellIsAny extends false ? true
        : never = true;

      // Check that value is NOT any
      type ValueIsAny = IsAny<typeof value>;
      const _assertValueNotAny: ValueIsAny extends false ? true : never = true;
    });

    it("should preserve types through key() with explicit Cell types", () => {
      // Create a cell with explicit nested Cell type (not using Schema<>)
      const cell = runtime.getCell<
        { value: string; current: Cell<{ label: string }> }
      >(
        space,
        "should preserve types through key 1",
        {
          type: "object",
          properties: {
            current: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
              asCell: ["cell"],
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );

      // Navigate using .key()
      const currentCell = cell.key("current");
      const currentValue = currentCell.get();
      const labelCell = currentValue.key("label");
      const labelValue = labelCell.get();

      // Type checks - verify types are NOT any
      type IsAny<T> = 0 extends (1 & T) ? true : false;

      type CurrentCellIsAny = IsAny<typeof currentValue>;
      const _assertCurrentCellNotAny: CurrentCellIsAny extends false ? true
        : never = true;

      type LabelCellIsAny = IsAny<typeof labelValue>;
      const _assertLabelCellNotAny: LabelCellIsAny extends false ? true
        : never = true;

      // Verify that currentCell is Cell<Cell<{ label: string }>> (nested Cell, not unwrapped)
      type CurrentCellUnwrapped = typeof currentCell extends Cell<infer U> ? U
        : never;
      type CurrentIsCell = CurrentCellUnwrapped extends Cell<any> ? true
        : false;
      const _assertCurrentIsNestedCell: CurrentIsCell extends true ? true
        : never = true;
    });

    it("should allow cell.get().get() for nested Cell<string> values", () => {
      const inner = runtime.getCell<string>(
        space,
        "nested-cell-inner-string",
        { type: "string" } as const satisfies JSONSchema,
        tx,
      );
      inner.set("hello nested cell");

      const outer = runtime.getCell<{ current: Cell<string> }>(
        space,
        "nested-cell-outer-string",
        {
          type: "object",
          properties: {
            current: {
              type: "string",
              asCell: ["cell"],
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );
      outer.set({ current: inner });

      const currentCell = outer.key("current");
      const nestedStringCell = currentCell.get();

      expect(isCell(nestedStringCell)).toBe(true);
      expect(nestedStringCell.get()).toBe("hello nested cell");
    });

    it('should honor explicit asCell: ["cell", "cell"] schema markers', () => {
      const inner = runtime.getCell<string>(
        space,
        "double-ascell-inner-string",
        { type: "string" } as const satisfies JSONSchema,
        tx,
      );
      inner.set("hello double asCell");

      const outer = runtime.getCell<{ current: Cell<Cell<string>> }>(
        space,
        "double-ascell-outer-string",
        {
          type: "object",
          properties: {
            current: {
              type: "string",
              asCell: ["cell", "cell"],
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );
      outer.set({ current: inner });

      const currentCell = outer.key("current");
      const outerNestedCell = currentCell.get();
      const innerStringCell = outerNestedCell.get();

      expect(isCell(outerNestedCell)).toBe(true);
      expect(isCell(innerStringCell)).toBe(true);
      expect(innerStringCell.get()).toBe("hello double asCell");
    });

    it("keeps the asCell entry scope on the schema, not stamped on the link", () => {
      const outer = runtime.getCell<{ current: Cell<string> }>(
        space,
        "scoped-ascell-object-entry",
        {
          type: "object",
          properties: {
            current: {
              type: "string",
              asCell: [{ kind: "cell", scope: "user" }],
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );

      // key() must not stamp the asCell entry scope onto the container link: an
      // asCell field is a reference whose link lives in the container at the
      // container's own scope; the entry scope is a follow cap on the target
      // (carried by the stored link). Stamping it here reads the wrong scoped
      // instance of the container (see CT-1623).
      const currentCell = outer.key("current");
      expect(currentCell.getAsNormalizedFullLink().scope).toBe("space");
      const schema = currentCell.getAsNormalizedFullLink().schema as any;
      expect(schema?.asCell?.[0]?.scope ?? schema?.scope).toBe("user");
    });

    it("should preserve nested asCell wrappers through anyOf branches", () => {
      const inner = runtime.getCell<string>(
        space,
        "double-ascell-anyof-inner-string",
        { type: "string" } as const satisfies JSONSchema,
        tx,
      );
      inner.set("hello anyOf nested cell");

      const outer = runtime.getCell<any>(
        space,
        "double-ascell-anyof-outer-string",
        {
          type: "object",
          properties: {
            current: {
              anyOf: [
                { type: "string" },
                { type: "string", asCell: ["cell", "cell"] },
              ],
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );
      outer.set({ current: inner });

      const currentCell = outer.key("current");
      const outerNestedCell = currentCell.get();
      const innerStringCell = outerNestedCell.get();

      expect(isCell(outerNestedCell)).toBe(true);
      expect(isCell(innerStringCell)).toBe(true);
      expect(innerStringCell.get()).toBe("hello anyOf nested cell");
    });

    it("keeps an `allOf`'s constraint on a handle minted from its bare `asCell` branch", () => {
      // Under `allOf` every branch is a constraint the handle must keep, so the
      // handle carries the compound rather than the link's own schema: once the
      // target stops satisfying the other branch, a read through the handle
      // refuses.
      const target = runtime.getCell<{ x?: number; y: number }>(
        space,
        "allof-handle-target",
        {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        } as const satisfies JSONSchema,
        tx,
      );
      target.set({ x: 1, y: 2 });
      const holder = runtime.getCell<any>(
        space,
        "allof-handle-holder",
        {
          type: "object",
          properties: {
            p: {
              allOf: [
                { asCell: ["cell"] },
                {
                  type: "object",
                  properties: { x: { type: "number" } },
                  required: ["x"],
                },
              ],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.setRaw({ p: target.getAsLink({ includeSchema: true }) });
      const handle = holder.get().p;
      expect(isCell(handle)).toBe(true);
      expect(handle.get().x).toBe(1);
      target.set({ y: 2 });
      expect(handle.get()).toBeUndefined();
    });

    it("keeps the compound on a handle where a shaped `asCell` branch sits beside a bare one", () => {
      // A merge cannot see which branch minted the handle it holds. With a
      // shaped `asCell` branch in the union, the handle may carry that branch's
      // shape alone, so it keeps the compound and a read through it projects
      // every branch — not the first branch's `id` by itself.
      const holder = runtime.getCell<any>(
        space,
        "shaped-beside-bare",
        {
          type: "object",
          properties: {
            h: {
              anyOf: [
                {
                  type: "object",
                  properties: { id: { type: "number" } },
                  asCell: ["cell"],
                },
                { asCell: ["cell"] },
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              ],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.set({ h: { id: 1, name: "one", hidden: true } });
      const handle = holder.get().h;
      expect(isCell(handle)).toBe(true);
      expect(handle.get()).toEqual({ id: 1, name: "one", hidden: true });
      expect(handle.schema).toEqual({
        anyOf: [
          { type: "object", properties: { id: { type: "number" } } },
          {},
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        ],
      });
    });

    it("keeps the compound on a handle where a shaped `asCell` branch sits inside a nested `anyOf` beside a bare one", () => {
      // The shaped branch mints a typed handle from one level down, and the
      // merge can no more see that it did than it can for a direct branch.
      // The merge strips the markers of the compound's own branches; a marker
      // one combinator down stays, and the handle's schema says so.
      const holder = runtime.getCell<any>(
        space,
        "shaped-nested-anyof-beside-bare",
        {
          type: "object",
          properties: {
            h: {
              anyOf: [
                {
                  anyOf: [{
                    type: "object",
                    properties: { id: { type: "number" } },
                    asCell: ["cell"],
                  }],
                },
                { asCell: ["cell"] },
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              ],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.set({ h: { id: 1, name: "one", hidden: true } });
      const handle = holder.get().h;
      expect(isCell(handle)).toBe(true);
      expect(handle.get()).toEqual({ id: 1, name: "one", hidden: true });
      expect(handle.schema).toEqual({
        anyOf: [
          {
            anyOf: [{
              ...{ type: "object", properties: { id: { type: "number" } } },
              asCell: ["cell"],
            }],
          },
          {},
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        ],
      });
    });

    it("keeps the compound on a handle where a shaped `asCell` branch sits inside a nested `allOf` beside a bare one", () => {
      // The shaped branch mints a typed handle from one level down, and the
      // merge can no more see that it did than it can for a direct branch.
      const holder = runtime.getCell<any>(
        space,
        "shaped-nested-allof-beside-bare",
        {
          type: "object",
          properties: {
            h: {
              anyOf: [
                {
                  allOf: [{
                    type: "object",
                    properties: { id: { type: "number" } },
                    asCell: ["cell"],
                  }],
                },
                { asCell: ["cell"] },
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              ],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.set({ h: { id: 1, name: "one", hidden: true } });
      const handle = holder.get().h;
      expect(isCell(handle)).toBe(true);
      expect(handle.get()).toEqual({ id: 1, name: "one", hidden: true });
      expect(handle.schema).toEqual({
        anyOf: [
          {
            allOf: [{
              ...{ type: "object", properties: { id: { type: "number" } } },
              asCell: ["cell"],
            }],
          },
          {},
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        ],
      });
    });

    it("keeps the compound on a handle where the shape sits beside a nested `anyOf` holding a bare `asCell` branch", () => {
      // Traversal merges the keywords beside a combinator into its branches
      // before minting, so a bare `asCell` arm under a `type` and `properties`
      // mints a handle carrying that shape, exactly as the direct spelling
      // does; the two spellings read the same.
      const holder = runtime.getCell<any>(
        space,
        "shaped-enclosing-nested-bare",
        {
          type: "object",
          properties: {
            h: {
              anyOf: [
                {
                  type: "object",
                  properties: { id: { type: "number" } },
                  anyOf: [{ asCell: ["cell"] }],
                },
                { asCell: ["cell"] },
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              ],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.set({ h: { id: 1, name: "one", hidden: true } });
      const handle = holder.get().h;
      expect(isCell(handle)).toBe(true);
      expect(handle.get()).toEqual({ id: 1, name: "one", hidden: true });
      expect(handle.schema).toEqual({
        anyOf: [
          {
            ...{ type: "object", properties: { id: { type: "number" } } },
            anyOf: [{ asCell: ["cell"] }],
          },
          {},
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        ],
      });
    });

    it("keeps the link's schema on a handle minted from an `allOf` of a bare `asCell` branch and a true one", () => {
      // An `allOf` whose other branches constrain nothing is its bare `asCell`
      // branch, and admits a handle over anything just as an `anyOf` does.
      const target = runtime.getCell<{ x: number; y: number }>(
        space,
        "allof-true-handle-target",
        {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        } as const satisfies JSONSchema,
        tx,
      );
      target.set({ x: 1, y: 2 });
      const holder = runtime.getCell<any>(
        space,
        "allof-true-handle-holder",
        {
          type: "object",
          properties: { p: { allOf: [{ asCell: ["cell"] }, {}] } },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.setRaw({ p: target.getAsLink({ includeSchema: true }) });
      const handle = holder.get().p;
      expect(isCell(handle)).toBe(true);
      const schema = handle.schema as JSONSchemaObj;
      expect(schema.allOf).toBeUndefined();
      expect(schema.properties?.y).toEqual({ type: "number" });
    });

    it("keeps the link's schema on a handle minted from an `anyOf`'s bare `asCell` branch", () => {
      // A bare `asCell` branch of an `anyOf` admits a handle over anything, so
      // the handle keeps the schema it adopted from the link — the target's
      // own, naming `y` — rather than the union, which never mentions `y`.
      const target = runtime.getCell<{ x: number; y: number }>(
        space,
        "anyof-handle-target",
        {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        } as const satisfies JSONSchema,
        tx,
      );
      target.set({ x: 1, y: 2 });
      const holder = runtime.getCell<any>(
        space,
        "anyof-handle-holder",
        {
          type: "object",
          properties: {
            p: {
              anyOf: [
                { asCell: ["cell"] },
                {
                  type: "object",
                  properties: { x: { type: "number" } },
                  required: ["x"],
                },
              ],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      holder.setRaw({ p: target.getAsLink({ includeSchema: true }) });
      const handle = holder.get().p;
      expect(isCell(handle)).toBe(true);
      const schema = handle.schema as JSONSchemaObj;
      expect(schema.anyOf).toBeUndefined();
      expect(schema.properties?.y).toEqual({ type: "number" });
      expect(handle.get()).toEqual({ x: 1, y: 2 });
    });

    it('should create nested default cells for asCell: ["cell", "cell"]', () => {
      const outer = runtime.getCell<any>(
        space,
        "double-ascell-default-outer-string",
        {
          type: "object",
          properties: {
            current: {
              type: "string",
              default: "hello nested default",
              asCell: ["cell", "cell"],
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );

      const currentCell = outer.key("current");
      const outerNestedCell = currentCell.get();
      const innerStringCell = outerNestedCell.get();

      expect(isCell(outerNestedCell)).toBe(true);
      expect(isCell(innerStringCell)).toBe(true);
      expect(innerStringCell.get()).toBe("hello nested default");
    });

    it("should apply nullable defaults before choosing anyOf asCell branches", () => {
      const outer = runtime.getCell<any>(
        space,
        "nullable-anyof-default-cell",
        {
          type: "object",
          properties: {
            current: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                  },
                  required: ["name"],
                  asCell: ["cell"],
                },
                { type: "null" },
              ],
              default: null,
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );

      expect(outer.key("current").get()).toBe(null);
    });
  });
});
