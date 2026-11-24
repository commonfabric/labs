import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { generateHandlerSchema } from "../src/schema.ts";

describe("generateHandlerSchema()", () => {
  it("returns undefined given neither schema", () => {
    expect(generateHandlerSchema()).toBe(undefined);
  });

  it("admits any state given only an event schema", () => {
    expect(generateHandlerSchema({ type: "number" })).toEqual({
      type: "object",
      properties: { $event: { type: "number" }, $ctx: true },
      required: ["$ctx"],
    });
  });

  it("admits any event given only a state schema", () => {
    expect(generateHandlerSchema(undefined, { type: "string" })).toEqual({
      type: "object",
      properties: { $event: true, $ctx: { type: "string" } },
      required: ["$ctx"],
    });
  });

  it("hoists both schemas' definitions to the root", () => {
    expect(
      generateHandlerSchema(
        { $ref: "#/$defs/E", $defs: { E: { type: "number" } } },
        { $ref: "#/$defs/S", $defs: { S: { type: "string" } } },
      ),
    ).toEqual({
      type: "object",
      properties: {
        $event: { $ref: "#/$defs/E" },
        $ctx: { $ref: "#/$defs/S" },
      },
      required: ["$ctx"],
      $defs: { E: { type: "number" }, S: { type: "string" } },
    });
  });
});
