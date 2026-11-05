/**
 * Pins TS enum-member handling (mapping spec §4/§16.2). Enum members are scalar
 * literal types, not reusable named definitions: keeping them inline prevents
 * their short member names from colliding with members of another enum or with
 * an unrelated named type in $defs. Whole enum declarations remain hoisted and
 * are covered separately by enum-schema-rows.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

async function generate(code: string, typeName: string) {
  const generator = new SchemaGenerator();
  const { type, checker, typeNode } = await getTypeFromCode(code, typeName);
  return generator.generateSchema(type, checker, typeNode);
}

describe("TS enum member schemas", () => {
  it("keeps a single enum-member type inline", async () => {
    const schema = await generate(
      `enum Mode { On = "on", Off = "off" }
       interface S { m: Mode.On; }`,
      "S",
    );
    expect(schema).toEqual({
      type: "object",
      properties: { m: { type: "string", enum: ["on"] } },
      required: ["m"],
    });
  });

  it("keeps same-named members of different enums distinct", async () => {
    const schema = await generate(
      `enum AlphaMode { On = "alpha-on", Off = "alpha-off" }
       enum BetaMode { On = "beta-on", Off = "beta-off" }
       interface State { a: AlphaMode.On; b: BetaMode.On; }`,
      "State",
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        a: { type: "string", enum: ["alpha-on"] },
        b: { type: "string", enum: ["beta-on"] },
      },
      required: ["a", "b"],
    });
  });

  it("does not collide with a same-named interface", async () => {
    const schema = await generate(
      `enum E { Config = "e-config" }
       interface Config { url: string; }
       interface App { mode: E.Config; settings: Config; }`,
      "App",
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["e-config"] },
        settings: { $ref: "#/$defs/Config" },
      },
      required: ["mode", "settings"],
      $defs: {
        Config: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    });
  });
});
