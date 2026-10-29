/**
 * The `delegate_task` model-facing contract, including bounded pattern
 * references selected from prior search results.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { delegateTaskTool } from "../src/tools/delegate-task.ts";

const objectProperties = (
  schema: JSONSchema,
): Readonly<Record<string, JSONSchema>> => {
  if (
    !isObjectOrArray(schema) ||
    schema.type !== "object" || schema.properties === undefined
  ) {
    throw new Error("expected an object schema with properties");
  }
  return schema.properties;
};

describe("delegate-task", () => {
  it("caps `patternRefs` at eight entries", () => {
    const patternRefs = objectProperties(
      delegateTaskTool.descriptor.inputSchema,
    ).patternRefs;

    expect(patternRefs).toBeDefined();
    expect(
      isObjectOrArray(patternRefs) ? patternRefs.maxItems : undefined,
    ).toBe(8);
  });

  it("caps each `patternRefs` note at 500 characters", () => {
    const patternRefs = objectProperties(
      delegateTaskTool.descriptor.inputSchema,
    ).patternRefs;
    if (
      !isObjectOrArray(patternRefs) ||
      !isObjectOrArray(patternRefs.items)
    ) {
      throw new Error("expected `patternRefs` item schema");
    }
    const note = objectProperties(patternRefs.items).note;

    expect(note).toBeDefined();
    expect(
      isObjectOrArray(note) ? note.maxLength : undefined,
    ).toBe(500);
  });
});
