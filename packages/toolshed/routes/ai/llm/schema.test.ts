import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Ajv } from "ajv";
import { normalizeSchemaForProvider } from "./schema.ts";

describe("normalizeSchemaForProvider", () => {
  it("strips undefined branches from anyOf", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        properties: {
          injectionDetected: {
            anyOf: [{ type: "undefined" }, { type: "boolean" }],
          },
        },
      }),
      {
        type: "object",
        properties: {
          injectionDetected: { type: "boolean" },
        },
      },
    );
  });

  it("preserves sibling annotations when collapsing anyOf", () => {
    assertEquals(
      normalizeSchemaForProvider({
        description: "Optional boolean flag",
        anyOf: [{ type: "undefined" }, { type: "boolean" }],
      }),
      {
        description: "Optional boolean flag",
        type: "boolean",
      },
    );
  });

  it("drops properties that only allow undefined", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        properties: {
          keep: { type: "string" },
          drop: { type: "undefined" },
        },
        required: ["keep", "drop"],
      }),
      {
        type: "object",
        properties: {
          keep: { type: "string" },
        },
        required: ["keep"],
      },
    );
  });

  it("strips undefined from type arrays", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: ["undefined", "string", "number"],
      }),
      {
        type: ["string", "number"],
      },
    );
  });

  it("maps a top-level `false` schema to an empty-object schema", () => {
    assertEquals(normalizeSchemaForProvider(false), {});
  });

  it("drops the type of an `unknown` position and keeps its other keywords", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        properties: {
          title: { type: "string" },
          data: { type: "unknown", description: "Anything" },
        },
        required: ["title", "data"],
      }),
      {
        type: "object",
        properties: {
          title: { type: "string" },
          data: { description: "Anything" },
        },
        required: ["title", "data"],
      },
    );
  });

  it("keeps the other types of a type array that includes `unknown`", () => {
    assertEquals(
      normalizeSchemaForProvider({ type: ["unknown", "string"] }),
      { type: "string" },
    );
    assertEquals(
      normalizeSchemaForProvider({ type: ["unknown", "string", "number"] }),
      { type: ["string", "number"] },
    );
    assertEquals(
      normalizeSchemaForProvider({ type: ["unknown", "undefined"] }),
      {},
    );
  });

  it("normalizes the schemas inside every keyword that holds schemas", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        additionalProperties: { type: "unknown" },
        patternProperties: { "^x-": { type: "unknown" } },
        propertyNames: { type: ["unknown", "string"] },
        $defs: { Anything: { type: "unknown" } },
        dependentSchemas: { a: { type: "unknown" } },
        allOf: [{ type: "unknown" }],
        oneOf: [{ type: "undefined" }, { type: "unknown" }],
        not: { type: "unknown" },
        if: { type: "unknown" },
        then: { type: "unknown" },
        else: { type: "unknown" },
      }),
      {
        type: "object",
        additionalProperties: {},
        patternProperties: { "^x-": {} },
        propertyNames: { type: "string" },
        $defs: { Anything: {} },
        dependentSchemas: { a: {} },
        allOf: [{}],
        oneOf: [{}],
        not: {},
        if: {},
        then: {},
        else: {},
      },
    );
    assertEquals(
      normalizeSchemaForProvider({
        type: "array",
        items: { type: "unknown" },
        prefixItems: [{ type: "unknown" }],
        contains: { type: "unknown" },
      }),
      { type: "array", items: {}, prefixItems: [{}], contains: {} },
    );
  });

  it("returns `const`, `enum`, `default`, and `examples` values as written", () => {
    // These keywords hold data. A value there that looks like a schema is
    // still the value a result must match or start from.

    const schema = {
      type: "object",
      properties: {
        payload: { const: { type: "unknown", payload: 1 } },
        kind: { enum: [{ type: "unknown" }, { type: "undefined" }] },
        start: {
          type: "object",
          default: { type: "undefined", properties: { a: 1 } },
          examples: [{ type: "unknown", required: ["a"] }],
        },
      },
    };
    assertEquals(normalizeSchemaForProvider(schema), schema);

    const normalized = normalizeSchemaForProvider({
      const: { type: "unknown", payload: 1 },
    }) as Record<string, unknown>;
    const validate = new Ajv({ allErrors: true, strict: false }).compile(
      normalized,
    );
    assertEquals(validate({ type: "unknown", payload: 1 }), true);
    assertEquals(validate({ payload: 1 }), false);
  });

  it("returns a schema Ajv compiles for the `unknown` and `undefined` types the runtime adds", () => {
    // The generateObject route compiles the normalized schema with these
    // options before it calls the model.

    for (
      const schema of [
        { type: "unknown" },
        { type: ["unknown", "string"] },
        { type: ["string", "undefined"] },
        {
          type: "object",
          properties: {
            data: { type: "unknown" },
            items: { type: "array", items: { type: "unknown" } },
            maybe: { anyOf: [{ type: "undefined" }, { type: "unknown" }] },
          },
        },
      ]
    ) {
      const ajv = new Ajv({ allErrors: true, strict: false });
      ajv.compile(
        normalizeSchemaForProvider(schema) as Record<string, unknown>,
      );
    }
  });

  it("preserves nested `additionalProperties: false`", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      }),
      {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    );
  });
});
