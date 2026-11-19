import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "../src/builder/types.ts";
import { fillHostFacts } from "../src/runner-utils.ts";

/** An argument schema whose `loomId` is filled from the fact `loom.id`. */
const PLACED: JSONSchema = {
  type: "object",
  properties: {
    loomId: { type: "string", hostFact: "loom.id" },
    title: { type: "string" },
  },
};

describe("fillHostFacts()", () => {
  it("fills a marked property from its fact", () => {
    expect(fillHostFacts({}, PLACED, { "loom.id": "loom-1" })).toEqual({
      loomId: "loom-1",
    });
  });

  it("keeps a value the argument already holds for a marked property", () => {
    const argument = { loomId: "chosen" };

    expect(fillHostFacts(argument, PLACED, { "loom.id": "loom-1" })).toBe(
      argument,
    );
  });

  it("leaves a marked property unset when its fact is missing", () => {
    const argument = { title: "Notes" };

    expect(fillHostFacts(argument, PLACED, { "loom.slot": 3 })).toBe(argument);
    expect(fillHostFacts(argument, PLACED, undefined)).toBe(argument);
  });

  it("fills no property the schema does not mark", () => {
    expect(
      fillHostFacts({}, PLACED, { "loom.id": "loom-1", title: "Injected" }),
    ).toEqual({ loomId: "loom-1" });
  });

  it("fills a property marked behind a `$ref`", () => {
    const schema: JSONSchema = {
      $ref: "#/$defs/Input",
      $defs: {
        Input: {
          type: "object",
          properties: { loomId: { $ref: "#/$defs/LoomId" } },
        },
        LoomId: { type: "string", hostFact: "loom.id" },
      },
    };

    expect(fillHostFacts({}, schema, { "loom.id": "loom-1" })).toEqual({
      loomId: "loom-1",
    });
  });

  it("fills only top-level properties", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        placement: {
          type: "object",
          properties: { loomId: { type: "string", hostFact: "loom.id" } },
        },
      },
    };

    expect(fillHostFacts({}, schema, { "loom.id": "loom-1" })).toEqual({});
  });
});
