import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchemaGenerationDiagnostic } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

const DEFAULT = `interface Default<T, V extends T = T> {}`;
const DEEP_DEFAULT = `interface DeepDefault<V> {}`;
const DEFAULT_MARKER = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
`;

/**
 * The schema `code`'s interface `R` generates, with the messages of the
 * diagnostics generating it reports.
 */
async function generate(
  code: string,
  options: { widenLiterals?: boolean } = {},
): Promise<{ schema: unknown; messages: string[] }> {
  const { type, checker, typeNode } = await getTypeFromCode(code, "R");
  const diagnostics: SchemaGenerationDiagnostic[] = [];
  const schema = new SchemaGenerator().generateSchema(type, checker, typeNode, {
    ...options,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { schema, messages: diagnostics.map(({ message }) => message) };
}

/** The schema of the property `x` of `code`'s interface `R`. */
async function propertyX(
  code: string,
  options: { widenLiterals?: boolean } = {},
): Promise<unknown> {
  const { schema } = await generate(code, options);
  return asObjectSchema(schema).properties?.x;
}

describe("union-formatter", () => {
  describe("member order", () => {
    it("returns the members of an indexed access in the order the property declares them", async () => {
      const x = await propertyX(`
        interface Row { k: "b" | "a" }
        interface R { x: Row["k"] }
      `);

      expect(x).toEqual({ enum: ["b", "a"] });
    });

    it("returns the members of the element of an alias of `Array<T>` in the order the alias declares them", async () => {
      const x = await propertyX(`
        type Letters = Array<"b" | "a">;
        interface R { x: Letters }
      `);

      expect(x).toEqual({ type: "array", items: { enum: ["b", "a"] } });
    });

    it("returns the members of an indexed access with a numeric key in value order", async () => {
      const x = await propertyX(`
        interface Row { 0: "b" | "a" }
        interface R { x: Row[0] }
      `);

      expect(x).toEqual({ enum: ["a", "b"] });
    });

    it("returns the members of an indexed access on a type with type arguments in value order", async () => {
      const x = await propertyX(`
        type Box<T> = { k: "b" | "a" };
        interface R { x: Box<string>["k"] }
      `);

      expect(x).toEqual({ enum: ["a", "b"] });
    });

    it("returns the members of a property a generic interface declares in value order", async () => {
      const x = await propertyX(`
        interface Box<T = string> { k: "b" | "a" }
        interface R { x: Box["k"] }
      `);

      expect(x).toEqual({ enum: ["a", "b"] });
    });

    it("returns the members of a property declared without a type annotation in value order", async () => {
      const x = await propertyX(`
        class Row { k = Math.random() ? "b" as const : "a" as const }
        interface R { x: Row["k"] }
      `);

      expect(x).toEqual({ enum: ["a", "b"] });
    });
  });

  describe("members with no JSON form", () => {
    it("throws for a Map member", async () => {
      await expect(propertyX(`interface R { x: Map<string, number> | null }`))
        .rejects.toThrow("Map cannot be used in pattern inputs/outputs");
    });

    it("throws for a Set member", async () => {
      await expect(propertyX(`interface R { x: Set<string> | string }`))
        .rejects.toThrow("Set cannot be used in pattern inputs/outputs");
    });
  });

  describe("unions with a Default member", () => {
    it("throws for a circular alias named Default", async () => {
      await expect(propertyX(`
        type Default = Loop;
        type Loop = Default;
        interface R { x: Default }
      `)).rejects.toThrow("Circular type alias detected: Default");
    });

    it("throws for a Default with no type arguments", async () => {
      await expect(propertyX(`
        type Default = string;
        interface R { x: Default | number }
      `)).rejects.toThrow("Default<T,V> requires 1 or 2 type arguments");
    });

    it("throws for a Default with three type arguments", async () => {
      await expect(propertyX(`
        ${DEFAULT}
        interface R { x: string | Default<string, "a", "b"> }
      `)).rejects.toThrow("Default<T,V> requires 1 or 2 type arguments");
    });

    it("returns `false` where every member and the default accept nothing", async () => {
      // A well-known symbol reads as `false`, and `never` is assignable to
      // every member, so the union holds no alternative.
      const { schema, messages } = await generate(`
        ${DEFAULT}
        interface R {
          x:
            | typeof Symbol.iterator
            | typeof Symbol.asyncIterator
            | Default<never>;
        }
      `);

      expect((schema as { properties: unknown }).properties).toEqual({
        x: false,
      });
      expect(messages).toEqual([
        expect.stringContaining("Cannot extract a value for Default<>"),
      ]);
    });

    it("returns `null` as the default an alias of `null` names", async () => {
      const x = await propertyX(`
        ${DEFAULT}
        type Nothing = null;
        interface R { x: string | null | Default<string | null, Nothing> }
      `);

      expect(x).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
        default: null,
      });
    });

    it("reports a default whose computed key names no literal", async () => {
      const { schema, messages } = await generate(`
        ${DEFAULT}
        declare const key: string;
        interface R { x: Record<string, number> | Default<{ [key]: 1 }> }
      `);

      expect(JSON.stringify(schema)).not.toContain('"default"');
      expect(messages).toEqual([
        expect.stringContaining("Cannot extract a value for Default<>"),
      ]);
    });

    it("returns the default whose computed key names a literal", async () => {
      const { schema, messages } = await generate(`
        ${DEFAULT}
        const key = "a";
        interface R { x: Record<string, number> | Default<{ [key]: 1 }> }
      `);

      expect(JSON.stringify(schema)).toContain('"default":{"a":1}');
      expect(messages).toEqual([]);
    });
  });

  describe("expanded Default unions", () => {
    it("returns the members without a default where every member carries the brand", async () => {
      const x = await propertyX(`
        ${DEFAULT_MARKER}
        interface R { x: ("a" | "b") & DefaultMarker<"a"> }
      `);

      expect(x).toEqual({ type: "string", enum: ["a", "b"] });
    });
  });

  describe("unions with a DeepDefault member", () => {
    it("throws for a DeepDefault with two type arguments", async () => {
      await expect(propertyX(`
        ${DEEP_DEFAULT}
        interface R { x: { a: number } | DeepDefault<{ a: 1 }, { a: 2 }> }
      `)).rejects.toThrow("DeepDefault<V> requires exactly 1 type argument");
    });

    it("throws for a key of the VNode the schema refers to outside `$defs`", async () => {
      // `VNode` stands for `commonfabric`'s own, which is read as a reference
      // to a schema outside `$defs`, whose properties are not read.
      await expect(propertyX(`
        ${DEEP_DEFAULT}
        type VNode = {
          type: "vnode";
          name: string;
          props: Record<string, object>;
          children: VNode[];
        };
        interface R { x: VNode | DeepDefault<{ name: "div" }> }
      `)).rejects.toThrow(
        'DeepDefault key "name" cannot be found on the target object type, `https://commonfabric.org/schemas/vnode.json`, which is a schema outside `$defs`.',
      );
    });

    it("throws for a key the target object type does not declare", async () => {
      await expect(propertyX(`
        ${DEEP_DEFAULT}
        interface Box { a: number }
        interface R { x: Box | DeepDefault<{ b: 1 }> }
      `)).rejects.toThrow(
        'DeepDefault key "b" does not exist on the target object type.',
      );
    });

    it("throws for a key nested in a property that declares no properties", async () => {
      await expect(propertyX(`
        ${DEEP_DEFAULT}
        interface R { x: { a: number } | DeepDefault<{ a: { b: 1 } }> }
      `)).rejects.toThrow(
        'DeepDefault key "a.b" does not exist on the target object type, which declares no properties.',
      );
    });

    it("returns the defaults on a target a local reference describes", async () => {
      const x = await propertyX(`
        ${DEEP_DEFAULT}
        interface Box { a: number }
        interface R { x: Box | DeepDefault<{ a: 1 }> }
      `);

      expect(x).toEqual({
        $ref: "#/$defs/Box",
        default: { a: 1 },
        properties: { a: { default: 1 } },
      });
    });

    it("returns the defaults beside a recursive alias that reaches itself", async () => {
      const x = await propertyX(`
        ${DEEP_DEFAULT}
        type Chain = Cell<Chain> | null;
        interface Box { a: number }
        interface R { x: Box | Chain | DeepDefault<{ a: 1 }> }
      `);

      expect(x).toEqual({
        anyOf: [{ $ref: "#/$defs/Box" }, { $ref: "#/$defs/Chain" }],
        default: { a: 1 },
        properties: { a: { default: 1 } },
      });
    });

    it("returns the defaults where two members reach the same object", async () => {
      const x = await propertyX(`
        ${DEEP_DEFAULT}
        type MaybeBox = Box | null;
        interface Box { a: number }
        interface R { x: Box | MaybeBox | DeepDefault<{ a: 1 }> }
      `);

      expect(x).toEqual({
        anyOf: [{ $ref: "#/$defs/Box" }, { $ref: "#/$defs/MaybeBox" }],
        default: { a: 1 },
        properties: { a: { default: 1 } },
      });
    });

    it("returns the defaults where two members declare equal objects", async () => {
      const x = await propertyX(`
        ${DEEP_DEFAULT}
        type MaybeObj = { a: number } | null;
        interface R { x: { a: number } | MaybeObj | DeepDefault<{ a: 1 }> }
      `);

      expect(x).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "number" } },
            required: ["a"],
          },
          { $ref: "#/$defs/MaybeObj" },
        ],
        default: { a: 1 },
        properties: { a: { default: 1 } },
      });
    });

    it("returns the defaults on an alias of a nullable object", async () => {
      const x = await propertyX(`
        ${DEEP_DEFAULT}
        type MaybeBox = Box | null;
        interface Box { a: number }
        interface R { x: MaybeBox | DeepDefault<{ a: 1 }> }
      `);

      expect(x).toEqual({
        $ref: "#/$defs/MaybeBox",
        default: { a: 1 },
        properties: { a: { default: 1 } },
      });
    });

    it("throws where two members reach objects declaring the key differently", async () => {
      await expect(propertyX(`
        ${DEEP_DEFAULT}
        interface Box { a: number }
        interface Crate { a: string }
        interface R { x: Box | Crate | DeepDefault<{ a: 1 }> }
      `)).rejects.toThrow(
        `DeepDefault key "a" has no one target object type, as the union's members describe objects that declare different properties.`,
      );
    });
  });

  describe("widened literals", () => {
    it("returns a property every member leaves unconstrained as `true`", async () => {
      const x = await propertyX(
        `interface R { x: { a: any; k: 1 } | { a: any; k: 2 } }`,
        { widenLiterals: true },
      );

      expect(x).toEqual({
        type: "object",
        properties: { a: true, k: { type: "number" } },
        required: ["a", "k"],
      });
    });

    it("returns arrays of literal unions as an array of their base type", async () => {
      const x = await propertyX(
        `interface R { x: { xs: ("a" | "b")[] } | { xs: ("c" | "d")[] } }`,
        { widenLiterals: true },
      );

      expect(x).toEqual({
        type: "object",
        properties: { xs: { type: "array", items: { type: "string" } } },
        required: ["xs"],
      });
    });

    it("keeps arrays of literal unions apart without widening", async () => {
      const x = await propertyX(
        `interface R { x: { xs: ("a" | "b")[] } | { xs: ("c" | "d")[] } }`,
      );

      expect(x).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { xs: { type: "array", items: { enum: ["a", "b"] } } },
            required: ["xs"],
          },
          {
            type: "object",
            properties: { xs: { type: "array", items: { enum: ["c", "d"] } } },
            required: ["xs"],
          },
        ],
      });
    });
  });
});
