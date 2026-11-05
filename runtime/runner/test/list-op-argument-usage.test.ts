import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Pattern } from "../src/builder/types.ts";
import { inferListOpArgumentUsage } from "../src/builtins/list-op-argument-usage.ts";

describe("list-op-argument-usage", () => {
  // The shape the transformer emits for `list.map((entry) => …)` with
  // captures: `element` and `params` named, no `index`, no `array`, and no
  // `additionalProperties` keyword, which the schema dialect reads as closed
  // to unnamed keys.
  const closedWithoutKeyword = {
    type: "object",
    properties: {
      element: { type: "object", properties: { text: { type: "string" } } },
      params: {
        type: "object",
        properties: { messages: { type: "array", items: {} } },
      },
    },
    required: ["element", "params"],
  } as const;

  it("reports only the named arguments for a schema without additionalProperties", () => {
    const usage = inferListOpArgumentUsage(
      { argumentSchema: closedWithoutKeyword } as unknown as Pattern,
    );
    expect(usage).toEqual({
      usesElement: true,
      usesIndex: false,
      usesArray: false,
      usesParams: true,
    });
  });

  it("reports an argument named by the schema as used", () => {
    const usage = inferListOpArgumentUsage(
      {
        argumentSchema: {
          type: "object",
          properties: {
            element: { type: "string" },
            index: { type: "number" },
            array: { type: "array", items: { type: "string" } },
          },
        },
      } as unknown as Pattern,
    );
    expect(usage).toEqual({
      usesElement: true,
      usesIndex: true,
      usesArray: true,
      usesParams: false,
    });
  });

  it("reports an argument whose schema is false as unused", () => {
    const usage = inferListOpArgumentUsage(
      {
        argumentSchema: {
          type: "object",
          properties: { element: { type: "string" }, index: false },
          additionalProperties: false,
        },
      } as unknown as Pattern,
    );
    expect(usage.usesElement).toBe(true);
    expect(usage.usesIndex).toBe(false);
    expect(usage.usesArray).toBe(false);
  });

  it("reports every argument as used when the pattern declares no schema", () => {
    const usage = inferListOpArgumentUsage(
      { argumentSchema: undefined } as unknown as Pattern,
    );
    expect(usage).toEqual({
      usesElement: true,
      usesIndex: true,
      usesArray: true,
      usesParams: true,
    });
  });
});
