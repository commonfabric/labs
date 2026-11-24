import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { checkInertStance } from "../../src/cfc/custody-seal.ts";

/** A closed object of `properties`, `required` as given. */
const closed = (
  properties: Record<string, unknown>,
  required?: unknown,
) => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required === undefined ? {} : { required }),
});

const BOUNDED = { type: "number", minimum: 0, maximum: 10 };

describe("checkInertStance()", () => {
  // Each refusal names its reason and the path it was found at, as the
  // confirmation dialog reports it.

  const refusal = (reason: string, at: string) =>
    `Custody seal requires an instruction-inert stance: ${reason} at \`${at}\``;

  describe("`const`", () => {
    it("does not throw for the constant", () => {
      expect(() => checkInertStance({ const: "yes" }, "yes")).not.toThrow();
    });

    it("throws for any other value", () => {
      expect(() => checkInertStance({ const: "yes" }, "no")).toThrow(
        refusal("the value is not the constant", "/"),
      );
    });

    it("throws for a constant that is not a primitive", () => {
      expect(() => checkInertStance({ const: { a: 1 } }, { a: 1 })).toThrow(
        refusal("`const` is not a primitive", "/"),
      );
    });
  });

  describe("`enum`", () => {
    it("throws for an enumeration that is empty, not a list, or not of primitives", () => {
      for (const values of [[], "a", [["a"]], [Infinity]]) {
        expect(() => checkInertStance({ enum: values }, "a")).toThrow(
          refusal("`enum` is not a list of primitives", "/"),
        );
      }
    });
  });

  describe("`boolean` and `null`", () => {
    it("does not throw for a value of the type", () => {
      expect(() => checkInertStance({ type: "boolean" }, false)).not.toThrow();
      expect(() => checkInertStance({ type: "null" }, null)).not.toThrow();
    });

    it("throws for a value of another type", () => {
      expect(() => checkInertStance({ type: "boolean" }, "true")).toThrow(
        refusal("the value is not a boolean", "/"),
      );
      expect(() => checkInertStance({ type: "null" }, false)).toThrow(
        refusal("the value is not `null`", "/"),
      );
    });
  });

  describe("`number`", () => {
    it("does not throw for a number inside its bounds, fractional or not", () => {
      expect(() => checkInertStance(BOUNDED, 2.5)).not.toThrow();
    });

    it("throws for a number outside its bounds", () => {
      expect(() => checkInertStance(BOUNDED, 11)).toThrow(
        refusal("the value is outside the number's bounds", "/"),
      );
    });

    it("throws for a schema missing a finite bound, whether or not a value uses it", () => {
      for (
        const schema of [
          { type: "number", minimum: 0 },
          { type: "integer", minimum: 0, maximum: Infinity },
        ]
      ) {
        expect(() => checkInertStance(schema, 1)).toThrow(
          refusal("a number needs a finite `minimum` and `maximum`", "/"),
        );
        expect(() => checkInertStance(closed({ n: schema }), {})).toThrow(
          refusal("a number needs a finite `minimum` and `maximum`", "/n"),
        );
      }
    });
  });

  describe("`object`", () => {
    it("does not throw for a value leaving out a property it need not hold", () => {
      expect(() => checkInertStance(closed({ n: BOUNDED }, []), {})).not
        .toThrow();
    });

    it("throws for an object that declares no `properties`", () => {
      expect(() =>
        checkInertStance({ type: "object", additionalProperties: false }, {})
      ).toThrow(refusal("an object needs `properties`", "/"));
    });

    it("throws for `required` naming an undeclared key, or not a list of keys", () => {
      for (const required of [["missing"], "n", [1]]) {
        expect(() =>
          checkInertStance(closed({ n: BOUNDED }, required), { n: 1 })
        ).toThrow(
          refusal("`required` names a key the object does not declare", "/"),
        );
      }
    });

    it("throws for a value that is not an object", () => {
      for (const value of [[], "text", null]) {
        expect(() => checkInertStance(closed({ n: BOUNDED }), value)).toThrow(
          refusal("the value is not an object", "/"),
        );
      }
    });

    it("throws for a value missing a required property", () => {
      expect(() => checkInertStance(closed({ n: BOUNDED }, ["n"]), {}))
        .toThrow(refusal("`n` is missing", "/"));
    });
  });

  it("throws for a schema nested deeper than eight levels", () => {
    let schema: unknown = { type: "boolean" };
    for (let depth = 0; depth < 8; depth++) schema = closed({ a: schema });
    expect(() => checkInertStance(schema, {})).not.toThrow();
    expect(() => checkInertStance(closed({ a: schema }), {})).toThrow(
      refusal("the schema is too deep", "/a/a/a/a/a/a/a/a/a"),
    );
  });
});
