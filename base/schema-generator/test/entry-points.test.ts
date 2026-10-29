import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

describe("SchemaGenerator entry points", () => {
  it("generates a schema for a simple object type", async () => {
    const generator = new SchemaGenerator();
    const { type, checker } = await getTypeFromCode(
      "interface MyObject { name: string; age: number; }",
      "MyObject",
    );
    const schema = asObjectSchema(generator.generateSchema(type, checker));
    expect(schema.type).toBe("object");
    expect(schema.properties?.name).toEqual({ type: "string" });
    expect(schema.properties?.age).toEqual({ type: "number" });
  });
});
