/**
 * Pins the CURRENT behavior of the `widenLiterals` generation option
 * (mapping spec §8/§14; quirk §16.3). The flag is consulted by
 * PrimitiveFormatter (single literals) and by the anyOf merge pass
 * (mergeIdenticalSchemas), but NOT by the all-literal-union branch
 * (union-formatter.ts ~:176-214), which runs first. The resulting boundary
 * is incoherent and pinned here so any deliberate fix flips these
 * expectations consciously:
 *   - a pure literal union does NOT widen ("a" | "b" stays an enum), but
 *   - the same literal members DO widen when a non-literal member joins
 *     the union (mixed-union case), and
 *   - inside one object, a single-literal property widens while a
 *     literal-union sibling does not.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

const WIDEN = { widenLiterals: true };

async function generate(
  code: string,
  typeName: string,
  options?: { widenLiterals?: boolean },
) {
  const generator = new SchemaGenerator();
  const { type, checker, typeNode } = await getTypeFromCode(code, typeName);
  return generator.generateSchema(type, checker, typeNode, options);
}

describe("widenLiterals option", () => {
  it("widens a single literal to its base type", async () => {
    const schema = await generate(`type S = "a";`, "S", WIDEN);
    expect(schema).toEqual({ type: "string" });
  });

  it("does NOT widen an all-literal union (known quirk, spec §16.3)", async () => {
    // The all-literal branch runs before the flag is consulted, so the
    // enum survives even with widenLiterals: true.
    const schema = await generate(`type T = "a" | "b";`, "T", WIDEN);
    expect(schema).toEqual({ enum: ["a", "b"] });
  });

  it("does NOT widen an all-literal numeric union (known quirk)", async () => {
    const schema = await generate(`type N = 1 | 2 | 3;`, "N", WIDEN);
    expect(schema).toEqual({ enum: [1, 2, 3] });
  });

  it("DOES widen literal members of a mixed union (quirk boundary)", async () => {
    // Same declared literals as the enum case above, but the object member
    // pushes the union onto the anyOf path where PrimitiveFormatter widens
    // each literal member and the merge pass dedupes them.
    const schema = await generate(
      `type M = "a" | "b" | { x: number };`,
      "M",
      WIDEN,
    );
    expect(schema).toEqual({
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      ],
    });
  });

  it("widens single-literal properties but not literal-union siblings", async () => {
    const schema = await generate(
      `interface O { mode: "auto" | "manual"; n: 1; }`,
      "O",
      WIDEN,
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        mode: { enum: ["auto", "manual"] }, // NOT widened (quirk)
        n: { type: "number" }, // widened
      },
      required: ["mode", "n"],
    });
  });

  it("keeps a cell apart from a plain value of its type", async () => {
    // The merge pass merges only members identical but for literal values,
    // so a member's `asCell` keeps it apart.
    const schema = await generate(
      `interface O { v: Cell<string> | string | number }`,
      "O",
      WIDEN,
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        v: {
          anyOf: [
            { type: ["number", "string"] },
            { type: "string", asCell: ["cell"] },
          ],
        },
      },
      required: ["v"],
    });
  });

  it("keeps the metadata members share when it merges them", async () => {
    const schema = await generate(
      `type U = { x: Cell<1 | 2> } | { x: Cell<3 | 4> };`,
      "U",
      WIDEN,
    );
    expect(schema).toEqual({
      type: "object",
      properties: { x: { type: "number", asCell: ["cell"] } },
      required: ["x"],
    });
  });

  it("without the flag, literal unions and single literals keep enums", async () => {
    expect(await generate(`type T = "a" | "b";`, "T")).toEqual({
      enum: ["a", "b"],
    });
    expect(await generate(`type S = "a";`, "S")).toEqual({
      type: "string",
      enum: ["a"],
    });
  });

  it("collapses true | false to boolean regardless of the flag", async () => {
    expect(await generate(`type B = true | false;`, "B", WIDEN)).toEqual({
      type: "boolean",
    });
    expect(await generate(`type B = true | false;`, "B")).toEqual({
      type: "boolean",
    });
  });

  it("preserves null when collapsing nullable boolean literals", async () => {
    const expected = {
      anyOf: [{ type: "boolean" }, { type: "null" }],
    };
    expect(await generate(`type B = boolean | null;`, "B", WIDEN)).toEqual(
      expected,
    );
    expect(await generate(`type B = boolean | null;`, "B")).toEqual(expected);
  });
});
