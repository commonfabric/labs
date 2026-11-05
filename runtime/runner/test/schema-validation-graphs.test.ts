/**
 * Validates shared graphs without repeating completed proofs or reusing a
 * proof under another contract. Cyclic proofs remain indeterminate.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  validateAgainstSchemaForSanitization,
  validateSchemaValue,
} from "../src/cfc/schema-sanitization.ts";

describe("schema validation over shared graphs", () => {
  it("validates a shared recursive graph with work proportional to its nodes", () => {
    let reads = 0;
    let value: Record<string, unknown> = { count: 1 };
    for (let depth = 0; depth < 14; depth++) {
      value = new Proxy({ left: value, right: value, count: 1 }, {
        get(target, key, receiver) {
          if (key === "left" || key === "right" || key === "count") {
            if (++reads > 2_000) {
              throw new Error("Validation expanded a shared graph.");
            }
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }
    const schema: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            left: { $ref: "#/$defs/Node" },
            right: { $ref: "#/$defs/Node" },
            count: { type: "number" },
          },
          required: ["count"],
        },
      },
    };

    expect(validateSchemaValue(schema, value)).toBeUndefined();
    expect(reads).toBeLessThan(200);
  });

  it("checks each schema when the same value appears under different contracts", () => {
    const child = { count: 1 };
    const schema: JSONSchema = {
      type: "object",
      properties: {
        left: { properties: { count: { type: "number" } } },
        right: { properties: { count: { type: "string" } } },
      },
    };
    expect(validateSchemaValue(schema, { left: child, right: child }))
      .toContain("right: count: value does not match type string");
  });

  it("resolves identical reference text on both sides against the document root", () => {
    const ref: JSONSchema = { $ref: "#/$defs/Entry" };
    const branch: JSONSchema = { properties: { child: ref } };
    expect(validateSchemaValue({
      properties: { left: branch, right: branch },
      $defs: { Entry: { properties: { count: { type: "number" } } } },
    }, { left: { child: { count: 1 } }, right: { child: { count: "1" } } }))
      .toContain("right: child: count: value does not match type number");
  });

  it("preserves a later mismatch after shared values have passed validation", () => {
    const child = { count: 1 };
    const item: JSONSchema = { properties: { count: { type: "number" } } };
    expect(
      validateSchemaValue({ items: item }, [child, child, { count: "bad" }]),
    )
      .toContain("2: count: value does not match type number");
  });

  it("revalidates mutable values on each call", () => {
    const schema: JSONSchema = { properties: { count: { type: "number" } } };
    const value: { count: unknown } = { count: 1 };
    expect(validateSchemaValue(schema, value)).toBeUndefined();
    value.count = "bad";
    expect(validateSchemaValue(schema, value)).toContain("count:");
  });

  it("keeps proofs under different optional-undefined policies separate", () => {
    const child: JSONSchema = {
      properties: { count: { type: "number" } },
    };
    const schema: JSONSchema = { oneOf: [child, { allOf: [child] }] };
    // The first branch excuses an optional undefined; allOf uses strict
    // presence so constraints split across its branches remain enforceable.
    expect(validateSchemaValue(schema, { count: undefined }, schema, {
      optionalUndefinedIsAbsent: true,
    })).toBeUndefined();
    expect(validateSchemaValue(schema, { count: undefined }))
      .toContain("exactly one oneOf");
  });

  it("does not reuse a root property exemption when validating a nested value", () => {
    const shared: JSONSchema = {
      properties: { count: { type: "number" } },
      additionalProperties: false,
    };
    const value: Record<string, unknown> = { count: 1 };
    value.child = value;
    const schema: JSONSchema = {
      allOf: [shared, {
        properties: { child: shared },
        additionalProperties: true,
      }],
      additionalProperties: true,
    };

    expect(validateAgainstSchemaForSanitization(
      schema,
      value,
      schema,
      new Set(["child"]),
    )).toBe("child: additional property child");
  });

  it("does not treat a cyclic proof as a completed success", () => {
    const value: Record<string, unknown> = {};
    value.next = value;
    const schema: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    };
    expect(validateSchemaValue(schema, value)).toContain("recursive schema");
  });
});
