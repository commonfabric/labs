import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Complex defaults", () => {
  it("array defaults with items shape", async () => {
    const code = `
      interface Default<T,V> {}
      interface TodoItem { title: string; done: boolean; }
      interface WithArrayDefaults {
        emptyItems: Default<TodoItem[], []>;
        prefilledItems: Default<string[], ["item1", "item2"]>;
        matrix: Default<number[][], [[1,2],[3,4]]>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "WithArrayDefaults");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    // Validate root schema required fields
    expect(s.required).toEqual(["emptyItems", "prefilledItems", "matrix"]);

    const empty = s.properties?.emptyItems as any;
    expect(empty.type).toBe("array");
    const emptyItems = empty.items as any;
    if (emptyItems.$ref) {
      expect(emptyItems.$ref).toBe("#/$defs/TodoItem");
      const def = (s as any).$defs?.TodoItem as any;
      expect(def.type).toBe("object");
      expect(def.properties?.title?.type).toBe("string");
      expect(def.properties?.done?.type).toBe("boolean");
      expect(def.required).toEqual(["title", "done"]);
    } else {
      expect(emptyItems.type).toBe("object");
      expect(emptyItems.required).toEqual(["title", "done"]);
    }
    expect(Array.isArray(empty.default)).toBe(true);

    const pre = s.properties?.prefilledItems as any;
    expect(pre.type).toBe("array");
    expect(pre.items?.type).toBe("string");
    expect(pre.default).toEqual(["item1", "item2"]);

    const mat = s.properties?.matrix as any;
    expect(mat.type).toBe("array");
    expect(mat.items?.type).toBe("array");
    expect(mat.items?.items?.type).toBe("number");
    expect(mat.default).toEqual([[1, 2], [3, 4]]);
  });

  it("object defaults with nested objects", async () => {
    const code = `
      interface Default<T,V> {}
      interface WithObjectDefaults {
        config: Default<{ theme: string; count: number }, { theme: "dark"; count: 10 }>;
        user: Default<{ name: string; settings: { notifications: boolean; email: string } }, { name: "Anonymous"; settings: { notifications: true; email: "user@example.com" } }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "WithObjectDefaults");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    // Validate root schema required fields
    expect(s.required).toEqual(["config", "user"]);

    const config = s.properties?.config as any;
    expect(config.type).toBe("object");
    expect(config.properties?.theme?.type).toBe("string");
    expect(config.properties?.count?.type).toBe("number");
    expect(config.required).toEqual(["theme", "count"]);
    expect(config.default).toEqual({ theme: "dark", count: 10 });

    const user = s.properties?.user as any;
    expect(user.type).toBe("object");
    expect(user.properties?.name?.type).toBe("string");
    expect(user.properties?.settings?.type).toBe("object");
    expect(user.required).toEqual(["name", "settings"]);
    expect(user.properties?.settings?.required).toEqual([
      "notifications",
      "email",
    ]);
    expect(user.default).toEqual({
      name: "Anonymous",
      settings: { notifications: true, email: "user@example.com" },
    });
  });

  it("null/undefined defaults in Default<...>", async () => {
    const code = `
      interface Default<T,V> {}
      interface WithNullDefaults {
        nullable: Default<string | null, null>;
        undefinable: Default<string | undefined, undefined>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "WithNullDefaults");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    // Validate root schema required fields
    // undefinable has Default<T | undefined, V> so undefined makes it optional
    expect(s.required).toEqual(["nullable"]);

    const n = s.properties?.nullable as any;
    expect(n.default).toBe(null);
    // Should use anyOf for union types (not oneOf)
    expect(n.anyOf).toBeDefined();
    expect(n.anyOf).toEqual(expect.arrayContaining([
      { type: "null" },
      { type: "string" },
    ]));
    expect(n.anyOf).toHaveLength(2);
    expect(n.oneOf).toBeUndefined();

    const u = s.properties?.undefinable as any;
    // Typically no default field for undefined
    expect(u.default).toBeUndefined();
    // For undefined unions, the undefined is kept
    expect(u.type).toEqual(["string", "undefined"]);
    expect(u.anyOf).toBeUndefined();
  });

  it("boolean schema defaults (any/never with Default)", async () => {
    const code = `
      interface Default<T,V> {}
      interface WithBooleanSchemas {
        anyWithDefault: Default<any, "defaultValue">;
        neverWithDefault: Default<never, "fallbackValue">;
      }
    `;
    const { type, checker } = await getTypeFromCode(
      code,
      "WithBooleanSchemas",
    );
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    // Validate root schema required fields
    expect(s.required).toEqual(["anyWithDefault", "neverWithDefault"]);

    const anyProp = s.properties?.anyWithDefault as any;
    // any becomes boolean schema true, with default should be { default: "defaultValue" }
    expect(anyProp.default).toBe("defaultValue");
    expect(anyProp.not).toBeUndefined();
    expect(anyProp.allOf).toBeUndefined();

    const neverProp = s.properties?.neverWithDefault as any;
    // never becomes boolean schema false, with default should be { not: true, default: "fallbackValue" }
    expect(neverProp.default).toBe("fallbackValue");
    expect(neverProp.not).toBe(true);
    expect(neverProp.allOf).toBeUndefined();
  });
});
