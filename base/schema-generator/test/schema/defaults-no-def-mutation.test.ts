import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Default<T,V> does not mutate shared definitions", () => {
  it("two props using same named type with different defaults", async () => {
    const code = `
      interface Default<T, V> {}
      interface Address { city: string }
      interface X {
        a: Default<Address, { city: "NY" }>;
        b: Default<Address, { city: "SF" }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = new SchemaGenerator();
    const s = asObjectSchema(gen.generateSchema(type, checker));

    const a = s.properties?.a as any;
    const b = s.properties?.b as any;
    expect(a.default?.city).toBe("NY");
    expect(b.default?.city).toBe("SF");

    // If a definition for Address exists, it should not carry a default
    const defs = (s as any).$defs as Record<string, unknown> | undefined;
    const address = defs?.["Address"] as any | undefined;
    if (address) {
      expect(address.default).toBeUndefined();
    }
  });
});
