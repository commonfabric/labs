import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Arrays and optional properties", () => {
  it("marks optional array property as not required", async () => {
    const code = `
      interface X { ids?: number[]; }
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result.type).toBe("object");
    const ids = result.properties?.ids as Record<string, unknown>;
    expect(ids.type).toBe("array");
    const req = result.required ?? [];
    expect(req.includes("ids")).toBe(false);
  });

  it("supports Array<T> and T[] equally", async () => {
    const code = `
      interface A { items: Array<string>; }
      interface B { items: string[]; }
    `;
    const a = await getTypeFromCode(code, "A");
    const b = await getTypeFromCode(code, "B");
    const gen = new SchemaGenerator();
    const sa = asObjectSchema(
      gen.generateSchema(a.type, a.checker, a.typeNode),
    );
    const sb = asObjectSchema(
      gen.generateSchema(b.type, b.checker, b.typeNode),
    );
    const saItems = sa.properties?.items as any;
    expect(saItems?.type).toBe("array");
    expect(saItems?.items?.type).toBe("string");
    const sbItems = sb.properties?.items as any;
    expect(sbItems?.type).toBe("array");
    expect(sbItems?.items?.type).toBe("string");
  });
});
