import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type { GenerationContext } from "../src/interface.ts";
import { unionFoldedFrom } from "../src/schema-origins.ts";

/** A context holding nothing but the origins the helper reads and writes. */
function contextWithOrigins(): GenerationContext {
  return { schemaOrigins: new WeakMap() } as unknown as GenerationContext;
}

/** A fallback schema recorded as the intersection of `parts`. */
function fallbackOf(
  context: GenerationContext,
  parts: MutableJSONSchema[],
): MutableJSONSchemaObj {
  const schema: MutableJSONSchemaObj = {
    type: "object",
    additionalProperties: true,
  };
  context.schemaOrigins!.set(schema, {
    kind: "intersection",
    parts: () => parts,
  });
  return schema;
}

describe("schema-origins", () => {
  describe("unionFoldedFrom()", () => {
    it("records the union on a schema of its own when a fold drops an arm with an origin", () => {
      const context = contextWithOrigins();
      const first = fallbackOf(context, [{ type: "string" }]);
      const second = fallbackOf(context, [{ type: "number" }]);

      const result = unionFoldedFrom(first, [first, second], 1, context);

      expect(result).toEqual(first);
      expect(result).not.toBe(first);
      const origin = context.schemaOrigins!.get(result as MutableJSONSchemaObj);
      expect(origin?.kind).toBe("union");
      expect(origin?.kind === "union" && origin.parts()).toEqual([
        first,
        second,
      ]);
    });

    it("returns the folded schema itself when every arm survived", () => {
      const context = contextWithOrigins();
      const first = fallbackOf(context, [{ type: "string" }]);
      const folded: MutableJSONSchema = { anyOf: [first, { type: "null" }] };

      expect(
        unionFoldedFrom(folded, [first, { type: "null" }], 2, context),
      ).toBe(folded);
    });

    it("returns the folded schema itself when no arm carries an origin", () => {
      const context = contextWithOrigins();
      const folded: MutableJSONSchema = { type: "string" };

      expect(
        unionFoldedFrom(
          folded,
          [{ type: "string" }, { type: "string" }],
          1,
          context,
        ),
      ).toBe(folded);
    });

    it("returns the folded schema itself when the only arm dropped accepts nothing", () => {
      // An arm accepting nothing is no arm of the union, so dropping it folds
      // nothing, and the survivor stays the constituent it is rather than one
      // arm of a recorded union.
      const context = contextWithOrigins();
      const survivor = fallbackOf(context, [{ type: "string" }]);

      expect(unionFoldedFrom(survivor, [false, survivor], 1, context)).toBe(
        survivor,
      );
    });

    it("leaves an arm accepting nothing out of the union it records", () => {
      const context = contextWithOrigins();
      const first = fallbackOf(context, [{ type: "string" }]);
      const second = fallbackOf(context, [{ type: "number" }]);

      const result = unionFoldedFrom(
        first,
        [first, false, second],
        1,
        context,
      );

      const origin = context.schemaOrigins!.get(result as MutableJSONSchemaObj);
      expect(origin?.kind === "union" && origin.parts()).toEqual([
        first,
        second,
      ]);
    });

    it("returns the folded schema itself when the context records no origins", () => {
      const folded: MutableJSONSchema = { type: "string" };

      expect(
        unionFoldedFrom(
          folded,
          [folded, { type: "string" }],
          1,
          {} as unknown as GenerationContext,
        ),
      ).toBe(folded);
    });
  });
});
