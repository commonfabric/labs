// Pins the TS-enum rows of docs/specs/schema-generator/ts_to_json_schema_mapping.md
// (§4):
//
//   - enum declarations hoist under the enum name with NO `type` key
//     (all-literal union path): numeric -> { enum: [0,1,2] },
//     string -> { enum: ["on","off"] }, with $ref at non-root occurrences;
//   - root enum occurrences stay inline.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getTypeFromCode } from "./utils.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";

async function gen(code: string, typeName: string) {
  const { type, checker, typeNode } = await getTypeFromCode(code, typeName);
  return new SchemaGenerator().generateSchema(type, checker, typeNode);
}

describe("TS enum schema mapping", () => {
  it("hoists a numeric enum under the enum name with no `type` key", async () => {
    const schema = await gen(
      `enum Color { Red, Green, Blue }\ninterface Wrap { c: Color; }`,
      "Wrap",
    ) as Record<string, unknown>;
    expect(schema.$defs).toEqual({ Color: { enum: [0, 1, 2] } });
    expect((schema.properties as Record<string, unknown>).c).toEqual({
      $ref: "#/$defs/Color",
    });
  });

  it("hoists a string enum under the enum name with no `type` key", async () => {
    const schema = await gen(
      `enum Mode { On = "on", Off = "off" }\ninterface Wrap { m: Mode; }`,
      "Wrap",
    ) as Record<string, unknown>;
    expect(schema.$defs).toEqual({ Mode: { enum: ["on", "off"] } });
  });

  it("emits a root enum inline (no $defs at the root occurrence)", async () => {
    const schema = await gen(
      `enum Color { Red, Green, Blue }\ntype T = Color;`,
      "T",
    ) as Record<string, unknown>;
    expect(schema).toEqual({ enum: [0, 1, 2] });
  });
});
