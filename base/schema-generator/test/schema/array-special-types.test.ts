import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Array special types", () => {
  const transformer = new SchemaGenerator();

  it("should use items: true for any[] arrays", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type AnyArray = any[];",
      "AnyArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(true);
  });

  it("should use items: true for Array<any>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type AnyArray = Array<any>;",
      "AnyArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(true);
  });

  it("should use items: false for never[] arrays", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type NeverArray = never[];",
      "NeverArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(false);
  });

  it("should use items: false for Array<never>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type NeverArray = Array<never>;",
      "NeverArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toBe(false);
  });

  it("should use items: { type: 'unknown' } for unknown[] arrays", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type UnknownArray = unknown[];",
      "UnknownArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toEqual({ type: "unknown" });
  });

  it("should use items: { type: 'unknown' } for Array<unknown>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type UnknownArray = Array<unknown>;",
      "UnknownArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toEqual({ type: "unknown" });
  });

  it("should generate normal schemas for regular array types", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "type StringArray = string[];",
      "StringArray",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );
    expect(schema.type).toBe("array");
    expect(schema.items).toEqual({ type: "string" });
  });
});
