import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { subscriptionSchemaGivesShape } from "@/backends/runtime-processor.ts";

describe("subscriptionSchemaGivesShape", () => {
  it("gives no shape for a missing schema, `true`, or an empty object", () => {
    expect(subscriptionSchemaGivesShape(undefined)).toBe(false);
    expect(subscriptionSchemaGivesShape(true)).toBe(false);
    expect(subscriptionSchemaGivesShape({})).toBe(false);
  });

  it("gives no shape for a schema of annotations and the runtime's own keywords alone", () => {
    expect(subscriptionSchemaGivesShape({ description: "an origin" })).toBe(
      false,
    );
    expect(subscriptionSchemaGivesShape({ title: "t", default: 1 })).toBe(
      false,
    );
    expect(subscriptionSchemaGivesShape({ asCell: ["cell"] })).toBe(false);
    expect(subscriptionSchemaGivesShape({ tags: ["profile"] })).toBe(false);
    expect(subscriptionSchemaGivesShape({ tier: "wrapper" })).toBe(false);
    expect(
      subscriptionSchemaGivesShape({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      }),
    ).toBe(false);
  });

  it("gives a shape for a schema that constrains its value", () => {
    expect(subscriptionSchemaGivesShape({ type: "object" })).toBe(true);
    expect(
      subscriptionSchemaGivesShape({ type: "object", properties: {} }),
    ).toBe(true);
    expect(subscriptionSchemaGivesShape(false)).toBe(true);
  });
});
