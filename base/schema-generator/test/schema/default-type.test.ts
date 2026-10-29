import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Default<T,V>", () => {
  it("applies default when Default has one type argument", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface X {
        text: Default<"">;
        count: Default<0>;
        enabled: Default<false>;
        missing: Default<null>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(result.required).toEqual(["text", "count", "enabled", "missing"]);

    const text = result.properties?.text as any;
    expect(text.enum).toEqual([""]);
    expect(text.default).toBe("");

    const count = result.properties?.count as any;
    expect(count.enum).toEqual([0]);
    expect(count.default).toBe(0);

    const enabled = result.properties?.enabled as any;
    expect(enabled.enum).toEqual([false]);
    expect(enabled.default).toBe(false);

    const missing = result.properties?.missing as any;
    expect(missing.type).toBe("null");
    expect(missing.default).toBe(null);
  });

  it("rejects one-argument Default<undefined>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type T = Default<undefined>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default<undefined> is unsupported",
    );
  });

  it("rejects one-argument Default with aliased undefined", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type U = undefined;
      type T = Default<U>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default<undefined> is unsupported",
    );
  });

  it("applies default for primitive value", async () => {
    const code = `
      interface Default<T, V> {}
      type T = Default<number, 5>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("number");
    expect(result.default).toBe(5);
  });

  it("applies default for array values and keeps items shape", async () => {
    const code = `
      interface Default<T, V> {}
      type T = Default<string[], ["a", "b"]>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("array");
    const items = result.items as any;
    expect(items?.type).toBe("string");
    expect(Array.isArray(result.default)).toBe(true);
    expect(result.default).toEqual(["a", "b"]);
  });
});
