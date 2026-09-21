import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  validateSchemaDefinition,
  validateStructuredResultValue,
} from "@commonfabric/runner/cfc";
import {
  getHarnessSubagentProfileConfig,
  HARNESS_SUBAGENT_PROFILES,
} from "../src/contracts/subagent.ts";
import {
  parseSubagentReturnSchema,
  validateAndSanitizeSubagentReturn,
} from "../src/subagent-return.ts";

describe("parseSubagentReturnSchema()", () => {
  it("throws for malformed constraints in nested schema positions", () => {
    const malformed = { required: "private-property-name" };
    const schemas = [
      malformed,
      { properties: { result: malformed } },
      { properties: { required: ["status"] } },
      { items: malformed },
      { allOf: [malformed] },
      { prefixItems: [malformed] },
      { $defs: { result: malformed } },
      { definitions: { result: malformed } },
      { dependentSchemas: { result: malformed } },
      { unevaluatedProperties: malformed },
      { unevaluatedItems: malformed },
      { properties: [] },
      { items: [] },
      { enum: [] },
      { type: "private-unsupported-type" },
      { format: 42 },
      { $ref: 42 },
      { $ref: "" },
      { $ref: "#/$defs/Missing" },
      { $defs: { status: { type: "string" } }, $ref: "#/$defs/status/type" },
    ];
    for (const schema of schemas) {
      expect(() => parseSubagentReturnSchema(schema)).toThrow(
        "delegate_task returnSchema has an invalid schema definition",
      );
    }
  });

  it("preserves booleans, annotations, named properties and recursive definitions", () => {
    const schemas = [
      false,
      true,
      { type: "string", format: "hostname" },
      { type: "string", format: "private-format-annotation" },
      { properties: { required: { type: "string" }, properties: false } },
      { type: "string", default: { required: 42 }, "x-example": { type: 42 } },
      {
        $defs: {
          node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/node" } },
          },
        },
        $ref: "#/$defs/node",
      },
      {
        definitions: { status: { enum: ["ready", "waiting"] } },
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      { type: "string", asCell: ["opaque"], scope: "space" },
    ];
    for (const schema of schemas) {
      expect(parseSubagentReturnSchema(schema)?.schema).toEqual(schema);
      expect(parseSubagentReturnSchema(JSON.stringify(schema))?.schema).toEqual(
        schema,
      );
    }
  });

  it("keeps migration format validation strict", () => {
    expect(validateSchemaDefinition({ type: "string", format: "hostname" }))
      .toBeDefined();
    expect(validateSchemaDefinition({ type: "string", format: "email" }))
      .toBeUndefined();
  });

  it("accepts every declared subagent profile return contract", () => {
    for (const profile of HARNESS_SUBAGENT_PROFILES) {
      const schema = getHarnessSubagentProfileConfig(profile).returnSchema;
      expect(parseSubagentReturnSchema(schema)?.schema).toEqual(schema);
    }
  });

  it("keeps referenced free text sealed after preflight", () => {
    const schema = {
      $defs: { text: { type: "string" } },
      type: "object",
      properties: { summary: { $ref: "#/$defs/text" } },
      required: ["summary"],
      additionalProperties: false,
    } as const;
    expect(parseSubagentReturnSchema(schema)?.schema).toEqual(schema);
    const result = validateAndSanitizeSubagentReturn({
      schema,
      childRunId: "preflight-child",
      value: { summary: "Untrusted child text" },
    });
    expect(result.linkedStringCount).toBe(1);
    expect(result.value).toEqual({
      summary: { "@link": "opaque:preflight-child#/summary" },
    });
  });

  it("preserves validation of required, typed, enumerated and undeclared values through references", () => {
    const schema = {
      $defs: {
        status: { type: "string", enum: ["ready", "waiting"] },
      },
      type: "object",
      properties: {
        status: { $ref: "#/$defs/status" },
        count: { type: "integer" },
      },
      required: ["status", "count"],
      additionalProperties: false,
    } as const;
    expect(parseSubagentReturnSchema(schema)?.schema).toEqual(schema);
    expect(() =>
      validateStructuredResultValue({
        schema,
        value: { status: "ready", count: 1 },
      })
    ).not.toThrow();
    for (
      const value of [
        { status: "ready" },
        { status: "ready", count: "one" },
        { status: "other", count: 1 },
        { status: "ready", count: 1, extra: true },
      ]
    ) {
      expect(() => validateStructuredResultValue({ schema, value })).toThrow();
    }
  });
});
