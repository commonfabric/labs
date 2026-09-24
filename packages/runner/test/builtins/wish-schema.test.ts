import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { wishStateSchemaForResult } from "../../src/builtins/wish-schema.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

const stateProperties = (schema: JSONSchema | undefined) => {
  if (typeof schema !== "object") throw new Error("Expected wish state schema");
  return schema.properties!;
};

describe("wish state schema", () => {
  it("preserves shaped handle capabilities and follow caps", () => {
    const handle = {
      type: "object",
      properties: { name: { type: "string" } },
      asCell: [{ kind: "readonly", scope: "user" }, "cell"],
    } as const;
    const properties = stateProperties(wishStateSchemaForResult(handle));
    expect(properties.candidates).toEqual({ type: "array", items: handle });
    expect(properties.result).toEqual({
      anyOf: [{ type: "undefined" }, handle],
    });
  });

  it("keeps a false requested schema rejecting every defined candidate", () => {
    const properties = stateProperties(wishStateSchemaForResult(false));
    expect(properties.candidates).toEqual({ type: "array", items: false });
    expect(properties.result).toEqual({
      anyOf: [{ type: "undefined" }, false],
    });
  });

  it("moves state scope to the container without losing referenced definitions", () => {
    const definition = {
      type: "object",
      properties: { name: { type: "string" } },
    } as const;
    const schema = wishStateSchemaForResult({
      $ref: "#/$defs/Resource",
      $defs: { Resource: definition },
      scope: "user",
      asCell: ["cell"],
    });
    expect(schema).toMatchObject({
      scope: "user",
      $defs: { Resource: definition },
    });
    expect(stateProperties(schema).candidates).toEqual({
      type: "array",
      items: { $ref: "#/$defs/Resource", asCell: ["cell"] },
    });
  });

  it("keeps a requested schema's sparse default apart from one holding `undefined`", () => {
    const requested = (defaultValue: unknown[]) =>
      ({ type: "array", default: defaultValue }) as unknown as JSONSchema;
    const sparse = wishStateSchemaForResult(requested(new Array(1)));
    const dense = wishStateSchemaForResult(requested([undefined]));

    expect(sparse).not.toBe(dense);
    const [, resultSchema] = (stateProperties(sparse).result as {
      anyOf: { default: unknown[] }[];
    }).anyOf;
    expect(resultSchema.default.length).toBe(1);
    expect(Object.hasOwn(resultSchema.default, 0)).toBe(false);
  });
});
