import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { JSONSchema } from "../src/builder/types.ts";

describe("ContextualFlowControl.lubSchema combinator descent", () => {
  // Regression guard for joinSchema combinator descent (audit 1.6 / W2.16).
  //
  // lubSchema (confidentiality tainting) descended into properties/items/$ref
  // but not anyOf/oneOf/allOf or prefixItems, so branch-local confidentiality
  // was silently dropped — an under-tainting fail-open in the core algebra. The
  // LUB must union the confidentiality of every branch a value could match.

  const atomsOf = (schema: JSONSchema) =>
    (ContextualFlowControl.lubSchema(schema) ?? []).map((a) => a).sort();

  it("unions confidentiality across anyOf branches", () => {
    expect(atomsOf({
      anyOf: [
        { type: "string", ifc: { confidentiality: ["a"] } },
        { type: "number", ifc: { confidentiality: ["b"] } },
      ],
    } as JSONSchema)).toEqual(["a", "b"]);
  });

  it("unions confidentiality across oneOf and allOf branches", () => {
    expect(atomsOf({
      oneOf: [{ type: "string", ifc: { confidentiality: ["x"] } }],
      allOf: [{ type: "object", ifc: { confidentiality: ["y"] } }],
    } as JSONSchema)).toEqual(["x", "y"]);
  });

  it("descends into prefixItems (tuple) branches", () => {
    expect(atomsOf({
      type: "array",
      prefixItems: [
        { type: "string", ifc: { confidentiality: ["t0"] } },
        { type: "number", ifc: { confidentiality: ["t1"] } },
      ],
    } as JSONSchema)).toEqual(["t0", "t1"]);
  });

  describe("more than one of additionalProperties, items and $ref", () => {
    // joinSchema used to chain additionalProperties / items / $ref with `else
    // if`, so a schema carrying more than one of them joined only the first —
    // the same under-tainting class as the combinator gap above.

    it("unions additionalProperties and items together", () => {
      expect(atomsOf({
        type: "object",
        additionalProperties: {
          type: "string",
          ifc: { confidentiality: ["ap"] },
        },
        items: { type: "number", ifc: { confidentiality: ["it"] } },
      } as JSONSchema)).toEqual(["ap", "it"]);
    });

    it("follows $ref alongside items", () => {
      expect(atomsOf({
        type: "array",
        items: { type: "string", ifc: { confidentiality: ["el"] } },
        $ref: "#/$defs/R",
        $defs: {
          R: { type: "array", ifc: { confidentiality: ["ref"] } },
        },
      } as JSONSchema)).toEqual(["el", "ref"]);
    });
  });

  it("unions confidentiality under not (conservative over-taint)", () => {
    // A plain `not` over-taints conservatively.

    expect(atomsOf({
      type: "string",
      not: { ifc: { confidentiality: ["n"] } },
    } as JSONSchema)).toEqual(["n"]);
  });

  it("reaches atoms under a double negation (not-of-not matches)", () => {
    // A nested `not` (not-of-not) re-selects values that DO match the inner
    // subschema — descending `not` is needed for soundness, not just
    // conservatism.

    expect(atomsOf({
      not: { not: { type: "string", ifc: { confidentiality: ["nn"] } } },
    } as JSONSchema)).toEqual(["nn"]);
  });

  it("resolves a ref under a subschema's own `$defs` against the root's map", () => {
    // `#/$defs/V` names the root's definition wherever it sits; the nested
    // map is inert below the root's, so the ref re-enters `V` and the cycle
    // guard stops the descent with the root's atoms.
    const shared = { $ref: "#/$defs/V" } as const;
    expect(atomsOf({
      type: "object",
      properties: { entry: shared },
      $defs: {
        V: {
          type: "object",
          ifc: { confidentiality: ["a"] },
          properties: {
            nested: {
              type: "object",
              $defs: { V: { type: "string", ifc: { confidentiality: ["b"] } } },
              properties: { value: shared },
            },
          },
        },
      },
    })).toEqual(["a"]);
  });

  describe("with definitions that name one another", () => {
    // Each definition carries an atom and names every other, so the walk
    // reaches each one along every order of the others. Joining a schema
    // afresh along each route resolves factorially often in the number of
    // definitions; a resolution count past the bound below fails the case at
    // once.

    /** `count` definitions, each labeled with its index and naming the rest. */
    const definitions = (count: number): JSONSchema => ({
      $ref: "#/$defs/R0",
      $defs: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`R${i}`, {
          ifc: { confidentiality: [`r${i}`] },
          anyOf: [
            { type: "null" },
            ...Array.from({ length: count }, (_, j) => j)
              .filter((j) => j !== i)
              .map((j) => ({ $ref: `#/$defs/R${j}`, asCell: ["cell"] })),
          ],
        }]),
      ),
    } as JSONSchema);

    it("resolves each reference at most once", () => {
      const count = 8;
      const resolve = ContextualFlowControl.resolveSchemaRefsOrThrow;
      let resolutions = 0;
      using _counted = stub(
        ContextualFlowControl,
        "resolveSchemaRefsOrThrow",
        (...args: Parameters<typeof resolve>) => {
          if (++resolutions > 10_000) throw new Error("resolved without end");
          return resolve.apply(ContextualFlowControl, args);
        },
      );

      expect(atomsOf(definitions(count))).toHaveLength(count);
      expect(resolutions).toBeLessThanOrEqual(count * (count - 1) + 1);
    });

    it("unions the confidentiality of every definition", () => {
      expect(atomsOf(definitions(4))).toEqual(["r0", "r1", "r2", "r3"]);
    });
  });
});
