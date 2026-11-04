import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  ARRAY_SUBSCHEMA_KEYS,
  DEFS_KEYS,
  RECORD_SUBSCHEMA_KEYS,
  SINGLE_SUBSCHEMA_KEYS,
  UNUSED_RECORD_SUBSCHEMA_KEYS,
  UNUSED_SINGLE_SUBSCHEMA_KEYS,
} from "@commonfabric/data-model-schema/schema-walk";
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

  it("leaves out the type of a type array that includes `unknown`", () => {
    // `unknown` admits every value, and the route validates the model's answer
    // against the normalized schema, so keeping a concrete type beside it
    // would refuse an answer the runtime accepts.

    assertEquals(
      normalizeSchemaForProvider({ type: ["unknown", "string"] }),
      {},
    );
    assertEquals(
      normalizeSchemaForProvider({ type: ["unknown", "undefined"] }),
      {},
    );
    const validate = new Ajv({ allErrors: true, strict: false }).compile(
      normalizeSchemaForProvider({
        type: "object",
        properties: { value: { type: ["unknown", "string"] } },
        required: ["value"],
      }) as Record<string, unknown>,
    );
    assertEquals(validate({ value: 42 }), true);
  });

  it("normalizes the schemas under every keyword that holds them", () => {
    // The central registry's keywords, and the spellings before 2019 that a
    // validator still reads.

    const unknownType = { type: "unknown" };
    for (
      const key of [
        ...SINGLE_SUBSCHEMA_KEYS,
        ...UNUSED_SINGLE_SUBSCHEMA_KEYS,
        "additionalItems",
      ]
    ) {
      assertEquals(
        normalizeSchemaForProvider({ [key]: unknownType }),
        { [key]: {} },
        key,
      );
    }
    for (const key of [...ARRAY_SUBSCHEMA_KEYS, "items"]) {
      assertEquals(
        normalizeSchemaForProvider({
          [key]: [unknownType, { type: "string" }],
        }),
        { [key]: [{}, { type: "string" }] },
        key,
      );
    }
    for (
      const key of [
        ...RECORD_SUBSCHEMA_KEYS,
        ...UNUSED_RECORD_SUBSCHEMA_KEYS,
        ...DEFS_KEYS,
        "definitions",
        "dependencies",
      ]
    ) {
      assertEquals(
        normalizeSchemaForProvider({ [key]: { a: unknownType } }),
        { [key]: { a: {} } },
        key,
      );
    }
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
