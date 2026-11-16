import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createBuilder } from "../../src/builder/factory.ts";

describe("factory", () => {
  describe("createBuilder()", () => {
    describe("`toSchema`", () => {
      it("throws, naming the transformer that should have replaced the call", () => {
        // The transformer replaces every call to `toSchema()` with the schema
        // it states, so reaching the runtime binding means the module was not
        // compiled through it.

        const { toSchema, schema } = createBuilder().commonfabric;

        expect(() => toSchema<{ count: number }>()).toThrow(
          "toSchema() must be transformed at compile time",
        );
        expect(schema({ type: "number" })).toEqual({ type: "number" });
      });
    });
  });
});
