import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";

import { hashStringOf } from "@commonfabric/data-model";
import { hashSchema } from "@/hashSchema.ts";

describe("hashSchema()", () => {
  it("returns a string", () => {
    const result = hashSchema({ type: "number" });
    expect(typeof result).toBe("string");
  });

  it("agrees with `hashStringOf()` on primitives", () => {
    for (const v of [false, true, undefined]) {
      const result1 = hashSchema(v);
      const result2 = hashStringOf(v);
      expect(result1).toBe(result2);
    }
  });

  it("agrees with `hashStringOf()` on plain objects", () => {
    const result1 = hashSchema({ type: "number", title: "Yes!" });
    const result2 = hashStringOf({ type: "number", title: "Yes!" });
    expect(result1).toBe(result2);
  });

  it("is deterministic (same input produces same result)", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const a = hashSchema(schema);
    const b = hashSchema(schema);
    expect(a).toBe(b);
  });

  it("produces different results for different schemas", () => {
    const a = hashSchema({ type: "number" });
    const b = hashSchema({ type: "string" });
    expect(a).not.toEqual(b);
  });

  it("is key-order independent", () => {
    const a = hashSchema({ type: "object", title: "A" } as JSONSchema);
    const b = hashSchema({ title: "A", type: "object" } as JSONSchema);
    expect(a).toBe(b);
  });

  it("returns base64url strings (no algorithm prefix)", () => {
    const result = hashSchema({ type: "number" });
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
