import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: void types", () => {
  it("formats a resolved void type as opaque", async () => {
    const code = `
      type X = void;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result).toEqual({ asCell: ["opaque"] });
  });

  it("formats Stream<void> as an opaque stream", async () => {
    const code = `
      interface X {
        trigger: Stream<void>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const trigger = result.properties?.trigger as Record<string, unknown>;
    expect(trigger).toEqual({ asCell: ["stream", "opaque"] });
  });

  it("formats void interface properties as opaque", async () => {
    const code = `
      interface X {
        input: void;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const input = result.properties?.input as Record<string, unknown>;
    expect(input).toEqual({ asCell: ["opaque"] });
  });
});
