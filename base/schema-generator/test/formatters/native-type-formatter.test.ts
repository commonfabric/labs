import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

/** The property schemas of `code`'s interface `R`. */
async function propertiesOf(code: string): Promise<unknown> {
  const { type, checker } = await getTypeFromCode(code, "R");
  return asObjectSchema(new SchemaGenerator().generateSchema(type, checker))
    .properties;
}

describe("native-type-formatter", () => {
  it("returns `true` for the library's `ArrayBufferLike` union", async () => {
    // The union has no symbol of its own; each of its members is a native
    // type the library declares.
    expect(
      await propertiesOf(`
        interface R { a: ArrayBufferLike; b: ArrayBufferLike | null }
      `),
    ).toEqual({ a: true, b: true });
  });

  it("returns the structure of a union the author names for a library type", async () => {
    expect(
      await propertiesOf(`
        export {};
        type ArrayBufferLike = { a: string } | { b: number };
        export interface R { x: ArrayBufferLike }
      `),
    ).toEqual({
      x: {
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
          {
            type: "object",
            properties: { b: { type: "number" } },
            required: ["b"],
          },
        ],
      },
    });
  });

  it("returns the native schema for a generic library type", async () => {
    expect(
      await propertiesOf(`interface R { x: Uint8Array<ArrayBufferLike> }`),
    ).toEqual({ x: { type: "object" } });
  });
});
