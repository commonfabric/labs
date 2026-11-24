/**
 * Pins fixed-length tuple emission (mapping spec §4, quirk §16.1): tuples
 * emit { type: "array", items: <merged element union> } via the
 * numeric-index fallback (type-utils.ts getArrayElementInfo). Positional
 * structure and arity are LOST — no prefixItems, no minItems/maxItems —
 * so [number, number, number] is indistinguishable from number[], and an
 * optional element leaks "undefined" into the items type array.
 *
 * NOTE this lossiness is load-bearing today: UnionFormatter's empty-array
 * pruning safety argument (union-formatter.ts ~:280-285) explicitly relies
 * on tuple schemas having no length bounds. If prefixItems emission is ever
 * added, gate that pruning first — then update these pins.
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

describe("fixed-length tuple emission", () => {
  it("merges heterogeneous element types into a type array (positions lost)", async () => {
    expect(await generate(`type Pair = [string, number];`, "Pair")).toEqual({
      type: "array",
      items: { type: ["number", "string"] },
    });
  });

  it("makes a homogeneous tuple indistinguishable from a plain array (arity lost)", async () => {
    const tuple = await generate(
      `type Vec3 = [number, number, number];`,
      "Vec3",
    );
    const array = await generate(`type Nums = number[];`, "Nums");
    expect(tuple).toEqual({ type: "array", items: { type: "number" } });
    expect(tuple).toEqual(array);
  });

  it("merges object elements into anyOf items", async () => {
    expect(
      await generate(`type Entry = [string, { x: number }];`, "Entry"),
    ).toEqual({
      type: "array",
      items: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: { x: { type: "number" } },
            required: ["x"],
          },
        ],
      },
    });
  });

  it("merges literal tuples into a positionless enum", async () => {
    // The items are the union of the element types, listed in the order the
    // tuple lists its elements.
    expect(await generate(`type Lit = ["a", 1];`, "Lit")).toEqual({
      type: "array",
      items: { enum: ["a", 1] },
    });
  });

  it("leaks undefined into items for optional tuple elements", async () => {
    expect(await generate(`type Opt = [string, number?];`, "Opt")).toEqual({
      type: "array",
      items: { type: ["number", "string", "undefined"] },
    });
  });

  it("treats rest-element tuples the same as fixed ones", async () => {
    expect(
      await generate(`type Rest = [string, ...number[]];`, "Rest"),
    ).toEqual({
      type: "array",
      items: { type: ["number", "string"] },
    });
  });

  it("never emits positional or length keywords", async () => {
    const schema = await generate(
      `type Pair = [string, number];`,
      "Pair",
    ) as Record<string, unknown>;
    expect(schema.prefixItems).toBeUndefined();
    expect(schema.minItems).toBeUndefined();
    expect(schema.maxItems).toBeUndefined();
  });
});
