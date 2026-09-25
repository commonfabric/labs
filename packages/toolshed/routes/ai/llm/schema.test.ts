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

  it("drops a type array that includes `unknown`", () => {
    assertEquals(
      normalizeSchemaForProvider({ type: ["unknown", "string"] }),
      {},
    );
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
